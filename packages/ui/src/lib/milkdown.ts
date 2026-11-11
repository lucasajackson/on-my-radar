/**
 * The WYSIWYG Markdown editor's engine: Milkdown (commonmark + gfm + history +
 * listener), and nothing else. docs/AGENT_REPO.md §V2.4 has the measurement
 * that chose it — the one property that matters is that a prompt comes out
 * meaning what it meant going in, and `milkdown.test.ts` holds it to that.
 *
 * **Only ever imported dynamically** (`components/markdown-editor.tsx`), so the
 * ~130 KB gzip it costs is a chunk nobody reading a prompt downloads. Importing
 * it statically from anything on the read path would silently put it back in
 * the main bundle; the build output is where that shows.
 */
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import {
  commonmark,
  createCodeBlockCommand,
  imageSchema,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  updateCodeBlockLanguageCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import {
  addColAfterCommand,
  addRowAfterCommand,
  deleteSelectedCellsCommand,
  gfm,
  insertTableCommand,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm';
import { history, redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, $view, callCommand } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

/**
 * The house style the serializer writes, so a no-op save rewrites as little as
 * possible (§V2.4 measured this taking one prompt from 159 rewritten lines to 47
 * and another from 104 to 3).
 */
export const STRINGIFY_OPTIONS = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '-',
  fence: '`',
  fences: true,
  listItemIndent: 'one',
  incrementListMarker: true,
} as const;

export type BlockKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'code' | 'other';

export type EditorAction =
  | { kind: 'block'; to: 'paragraph' | 'h1' | 'h2' | 'h3' }
  | { kind: 'bold' }
  | { kind: 'italic' }
  | { kind: 'code' }
  | { kind: 'strike' }
  | { kind: 'link'; href: string }
  | { kind: 'bullet' }
  | { kind: 'ordered' }
  | { kind: 'task' }
  | { kind: 'quote' }
  | { kind: 'codeBlock' }
  | { kind: 'language'; language: string }
  | { kind: 'table' }
  | { kind: 'addRow' }
  | { kind: 'addCol' }
  | { kind: 'deleteCells' }
  | { kind: 'rule' }
  | { kind: 'undo' }
  | { kind: 'redo' };

/** What the toolbar reflects: where the cursor is and what is applied there. */
export interface EditorStatus {
  block: BlockKind;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: boolean;
  inTable: boolean;
  /** The code block's language, when the cursor is in one. */
  language: string | null;
}

export interface EditorHandle {
  /** The document as Markdown, in the house style. */
  markdown: () => string;
  /** True once a transaction has made the document differ from what it opened with. */
  changed: () => boolean;
  /** What opening and serializing, untouched, would write — to tell normalising from editing. */
  initialMarkdown: string;
  run: (action: EditorAction) => void;
  status: () => EditorStatus;
  focus: () => void;
  /**
   * Underline the text ADRs amend, from where the server says it is in the charter's plain text.
   * Decorations only: nothing enters the document or its Markdown. Returns false (and draws
   * nothing) when the document is not the text those places were measured on, which is the case
   * while there are edits the server has not seen.
   */
  setAnchors: (map: AnchorDraw | null) => boolean;
  /** Let the document be typed in (true) or hold it still while something is written (false). */
  setEditable: (editable: boolean) => void;
  destroy: () => Promise<void>;
}

/**
 * Marked spans in the projection's text: the text an ADR amends (with the labels of its ADRs), and
 * the passages linked to a boundary or contract (with the ids of the links on it).
 */
export interface AnchorDraw {
  text: string;
  spans: ReadonlyArray<{
    start: number;
    end: number;
    labels: readonly string[];
    link?: { ids: readonly string[]; kind: 'boundary' | 'contract' };
  }>;
}

/**
 * An image in a prompt is never fetched while editing: an agent can write a
 * prompt, and `![](https://…/?who-opened-this)` would otherwise report the
 * moment its owner opened the editor. The read view never renders images
 * either (`lib/markdown.ts`). The node survives a round trip untouched.
 */
const inertImage = $view(imageSchema.node, () => (node: ProseNode) => {
  const dom = document.createElement('span');
  dom.className = 'md-image';
  const alt = typeof node.attrs['alt'] === 'string' ? node.attrs['alt'] : '';
  dom.textContent = alt ? `[image: ${alt}]` : '[image]';
  dom.contentEditable = 'false';
  return { dom };
});

/* ------------------------------ amendment marks ------------------------------ */

const anchorKey = new PluginKey<DecorationSet>('charter-anchors');

/**
 * Holds the underline decorations. They are mapped through every transaction, so they follow the
 * words as they are typed around; a transaction that carries a new set (`setAnchors`) replaces them.
 */
const anchorMarks = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: anchorKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => {
          const next = tr.getMeta(anchorKey) as DecorationSet | undefined;
          return next ?? set.map(tr.mapping, tr.doc);
        },
      },
      props: { decorations: (state) => anchorKey.getState(state) ?? DecorationSet.empty },
    }),
);

export interface DocBlock {
  text: string;
  /** The document position before and after each character of `text`. */
  before: number[];
  after: number[];
}

/**
 * The document's text blocks as the server's projection reads them: each textblock outside code,
 * its text with whitespace runs collapsed to one space and the ends trimmed. A leaf with no text of
 * its own (a `<br>`) is one space, as `doc.textBetween(from, to, '\n\n', ' ')` reads it.
 */
export function docBlocks(doc: ProseNode): DocBlock[] {
  const blocks: DocBlock[] = [];
  doc.descendants((node, nodePos) => {
    if (!node.isTextblock) return true;
    if (node.type.name !== 'code_block') {
      const raw: Array<{ char: string; before: number; after: number }> = [];
      node.descendants((child, pos) => {
        const start = nodePos + 1 + pos;
        if (child.isText) {
          const value = child.text ?? '';
          for (let i = 0; i < value.length; i += 1)
            raw.push({ char: value.charAt(i), before: start + i, after: start + i + 1 });
        } else if (child.isLeaf)
          raw.push({ char: ' ', before: start, after: start + child.nodeSize });
        return true;
      });
      const text: string[] = [];
      const before: number[] = [];
      const after: number[] = [];
      for (const { char, before: b, after: a } of raw) {
        if (/\s/.test(char)) {
          if (text.length === 0 || text[text.length - 1] === ' ') continue;
          text.push(' ');
        } else text.push(char);
        before.push(b);
        after.push(a);
      }
      if (text[text.length - 1] === ' ') {
        text.pop();
        before.pop();
        after.pop();
      }
      if (text.length > 0) blocks.push({ text: text.join(''), before, after });
    }
    return false;
  });
  return blocks;
}

function statusOf(state: EditorState): EditorStatus {
  const { $from, from, to, empty } = state.selection;
  const parent = $from.parent;
  let block: BlockKind = 'other';
  if (parent.type.name === 'paragraph') block = 'paragraph';
  else if (parent.type.name === 'code_block') block = 'code';
  else if (parent.type.name === 'heading') {
    const level = Number(parent.attrs['level']);
    block = level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  }
  const has = (name: string): boolean => {
    const type = state.schema.marks[name];
    if (!type) return false;
    if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
    return state.doc.rangeHasMark(from, to, type);
  };
  let inTable = false;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') inTable = true;
  }
  const language =
    parent.type.name === 'code_block' && typeof parent.attrs['language'] === 'string'
      ? parent.attrs['language']
      : null;
  return {
    block,
    bold: has('strong'),
    italic: has('emphasis'),
    code: has('inlineCode'),
    link: has('link'),
    inTable,
    language,
  };
}

/**
 * Toggle a task list on the list items the selection touches: wrap in a bullet
 * list first when there is none, then flip `checked` between null (a plain
 * item) and false (an open task). gfm's list item carries the attribute; there
 * is no stock command for it.
 */
function toggleTask(editor: Editor): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const inList = (): boolean => {
      const { $from } = view.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1)
        if ($from.node(depth).type.name === 'list_item') return true;
      return false;
    };
    if (!inList()) callCommand(wrapInBulletListCommand.key)(ctx);
    const { state } = view;
    const { from, to } = state.selection;
    const items: Array<{ pos: number; node: ProseNode }> = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'list_item') items.push({ pos, node });
    });
    if (items.length === 0) return;
    const allTasks = items.every(({ node }) => node.attrs['checked'] != null);
    const tr = state.tr;
    for (const { pos, node } of items) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: allTasks ? null : false });
    }
    view.dispatch(tr);
  });
}

/**
 * Mount an editor on `root` with `value`. `onUpdate` fires after every
 * transaction that changes the document or moves the selection, so a toolbar
 * can re-read `status()` and a save bar `changed()`.
 */
export async function createEditor(
  root: HTMLElement,
  value: string,
  onUpdate: () => void,
): Promise<EditorHandle> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, value);
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, ...STRINGIFY_OPTIONS }));
      ctx
        .get(listenerCtx)
        .updated(() => onUpdate())
        .selectionUpdated(() => onUpdate());
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(inertImage)
    .use(anchorMarks)
    .create();

  const serialize = (doc: ProseNode): string => editor.action((ctx) => ctx.get(serializerCtx)(doc));
  const view = () => editor.action((ctx) => ctx.get(editorViewCtx));
  const initialDoc = view().state.doc;
  const initialMarkdown = serialize(initialDoc);

  const run = (action: EditorAction): void => {
    if (action.kind === 'task') {
      toggleTask(editor);
      return;
    }
    editor.action((ctx) => {
      const call = callCommand;
      switch (action.kind) {
        case 'block':
          if (action.to === 'paragraph') call(turnIntoTextCommand.key)(ctx);
          else call(wrapInHeadingCommand.key, Number(action.to.slice(1)))(ctx);
          break;
        case 'bold':
          call(toggleStrongCommand.key)(ctx);
          break;
        case 'italic':
          call(toggleEmphasisCommand.key)(ctx);
          break;
        case 'code':
          call(toggleInlineCodeCommand.key)(ctx);
          break;
        case 'strike':
          call(toggleStrikethroughCommand.key)(ctx);
          break;
        case 'link':
          call(toggleLinkCommand.key, { href: action.href })(ctx);
          break;
        case 'bullet':
          call(wrapInBulletListCommand.key)(ctx);
          break;
        case 'ordered':
          call(wrapInOrderedListCommand.key)(ctx);
          break;
        case 'quote':
          call(wrapInBlockquoteCommand.key)(ctx);
          break;
        case 'codeBlock':
          call(createCodeBlockCommand.key)(ctx);
          break;
        case 'language': {
          const state = ctx.get(editorViewCtx).state;
          const { $from } = state.selection;
          if ($from.parent.type.name !== 'code_block') break;
          call(updateCodeBlockLanguageCommand.key, {
            pos: $from.before(),
            language: action.language,
          })(ctx);
          break;
        }
        case 'table':
          call(insertTableCommand.key, { row: 3, col: 3 })(ctx);
          break;
        case 'addRow':
          call(addRowAfterCommand.key)(ctx);
          break;
        case 'addCol':
          call(addColAfterCommand.key)(ctx);
          break;
        case 'deleteCells':
          call(deleteSelectedCellsCommand.key)(ctx);
          break;
        case 'rule':
          call(insertHrCommand.key)(ctx);
          break;
        case 'undo':
          call(undoCommand.key)(ctx);
          break;
        case 'redo':
          call(redoCommand.key)(ctx);
          break;
      }
    });
  };

  return {
    markdown: () => serialize(view().state.doc),
    changed: () => !view().state.doc.eq(initialDoc),
    initialMarkdown,
    run,
    status: () => statusOf(view().state),
    focus: () => view().focus(),
    setEditable: (editable) => view().setProps({ editable: () => editable }),
    setAnchors: (map) => {
      const v = view();
      const clear = () => v.dispatch(v.state.tr.setMeta(anchorKey, DecorationSet.empty));
      if (!map || map.spans.length === 0) {
        clear();
        return map !== null;
      }
      const blocks = docBlocks(v.state.doc);
      if (blocks.map((b) => b.text).join('\n\n') !== map.text) {
        clear();
        return false;
      }
      const starts: number[] = [];
      let at = 0;
      for (const block of blocks) {
        starts.push(at);
        at += block.text.length + 2;
      }
      const marks: Decoration[] = [];
      for (const span of map.spans) {
        if (span.end <= span.start) continue;
        if (span.link) {
          // A link may run across paragraphs: each block it covers gets its own stretch.
          blocks.forEach((block, k) => {
            const offset = starts[k] ?? 0;
            const a = Math.max(span.start, offset);
            const z = Math.min(span.end, offset + block.text.length);
            if (z <= a) return;
            const from = block.before[a - offset];
            const to = block.after[z - offset - 1];
            if (from === undefined || to === undefined) return;
            marks.push(
              Decoration.inline(from, to, {
                class: `charter-link is-${span.link?.kind ?? 'boundary'}`,
                'data-links': span.link?.ids.join(' ') ?? '',
              }),
            );
          });
          continue;
        }
        let k = starts.length - 1;
        while (k > 0 && (starts[k] ?? 0) > span.start) k -= 1;
        const block = blocks[k];
        const offset = starts[k] ?? 0;
        if (!block || span.end - offset > block.text.length) continue;
        const from = block.before[span.start - offset];
        const to = block.after[span.end - offset - 1];
        if (from === undefined || to === undefined) continue;
        marks.push(Decoration.inline(from, to, { class: 'charter-anchor' }));
        marks.push(
          Decoration.widget(
            to,
            () => {
              const label = document.createElement('sup');
              label.className = 'charter-anchor-ref';
              label.contentEditable = 'false';
              label.textContent = span.labels.join(' ');
              return label;
            },
            { side: -1, ignoreSelection: true },
          ),
        );
      }
      v.dispatch(v.state.tr.setMeta(anchorKey, DecorationSet.create(v.state.doc, marks)));
      return true;
    },
    destroy: async () => {
      await editor.destroy();
    },
  };
}

/**
 * Parse and serialize once, untouched: what the editor would write for
 * `markdown` if somebody opened it and saved. The fidelity test's unit.
 */
export async function roundTrip(markdown: string): Promise<string> {
  const root = document.createElement('div');
  document.body.append(root);
  const handle = await createEditor(root, markdown, () => undefined);
  const out = handle.markdown();
  await handle.destroy();
  root.remove();
  return out;
}

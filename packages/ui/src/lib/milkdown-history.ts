/**
 * A charter version, read-only (plan e715ea20, U3): Milkdown with nothing to type into, drawn the
 * way the editor draws it, plus the marks a history view needs and the editor does not: the words
 * a comparison inserted (green) and struck (red), and the passage a deep link flashes.
 *
 * Marks are decorations over the document and are placed by the server's text offsets (the
 * projection, `docBlocks` here being the same text as seen by the editor). Nothing enters the
 * document. **Only ever imported dynamically**, like `milkdown.ts`.
 */
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { docBlocks, type AnchorDraw, type DocBlock } from './milkdown';
import type { Change } from './charter-history';

export interface ViewerMarks {
  /** Amendments to underline (a version read on its own). */
  amend?: AnchorDraw | null;
  /** The changes of a comparison, drawn on the newer document. */
  changes?: readonly Change[];
  /** The change that is current: its marks are stronger. */
  current?: number;
  /** A passage to flash (a deep link), as offsets into the projection. */
  flash?: { start: number; end: number } | null;
}

export interface ViewerHandle {
  /** The document's text as the projection reads it: what offsets index. */
  text: () => string;
  setMarks: (marks: ViewerMarks) => void;
  /** Bring the `index`th change, or the flashed passage, to the middle of the window. */
  scrollTo: (target: { change: number } | { flash: true }) => boolean;
  destroy: () => Promise<void>;
}

const marksKey = new PluginKey<DecorationSet>('charter-history-marks');

const marksPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: marksKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => (tr.getMeta(marksKey) as DecorationSet | undefined) ?? set,
      },
      props: { decorations: (state) => marksKey.getState(state) ?? DecorationSet.empty },
    }),
);

interface Placed {
  blocks: DocBlock[];
  starts: number[];
  text: string;
}

function place(blocks: DocBlock[]): Placed {
  const starts: number[] = [];
  let at = 0;
  for (const block of blocks) {
    starts.push(at);
    at += block.text.length + 2;
  }
  return { blocks, starts, text: blocks.map((b) => b.text).join('\n\n') };
}

/** The document ranges a projection range covers: one per block it touches. */
function pieces(placed: Placed, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (end <= start) return out;
  // The first block that ends after `start`, by bisection: a charter has thousands.
  let lo = 0;
  let hi = placed.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const block = placed.blocks[mid];
    if ((placed.starts[mid] ?? 0) + (block?.text.length ?? 0) <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < placed.blocks.length; k += 1) {
    const block = placed.blocks[k];
    const base = placed.starts[k] ?? 0;
    if (!block || base >= end) break;
    const from = Math.max(start, base) - base;
    const to = Math.min(end, base + block.text.length) - base;
    if (to <= from) continue;
    const a = block.before[from];
    const b = block.after[to - 1];
    if (a !== undefined && b !== undefined) out.push([a, b]);
  }
  return out;
}

/** The document position of a projection offset: inside a block, or the nearest block edge. */
function positionAt(placed: Placed, offset: number): number | null {
  if (placed.blocks.length === 0) return null;
  let lo = 0;
  let hi = placed.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((placed.starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  const block = placed.blocks[lo];
  const base = placed.starts[lo] ?? 0;
  if (!block) return null;
  const inside = offset - base;
  if (inside <= 0) return block.before[0] ?? null;
  if (inside >= block.text.length) return block.after[block.text.length - 1] ?? null;
  return block.before[inside] ?? null;
}

const MAX_STRUCK = 400;

function struckNode(change: Change, current: boolean): HTMLElement {
  const del = document.createElement('del');
  del.className = `diff-del${current ? ' is-current' : ''}`;
  del.dataset['change'] = String(change.index);
  del.contentEditable = 'false';
  const text = (change.struck ?? '').replaceAll('\n\n', ' ¶ ');
  del.textContent = text.length > MAX_STRUCK ? `${text.slice(0, MAX_STRUCK)}…` : text;
  return del;
}

export async function createViewer(root: HTMLElement, markdown: string): Promise<ViewerHandle> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, (options) => ({ ...options, editable: () => false }));
    })
    .use(commonmark)
    .use(gfm)
    .use(marksPlugin)
    .create();
  const view = () => editor.action((ctx) => ctx.get(editorViewCtx));
  // The document never changes under a viewer: its blocks are read once.
  const placed = place(docBlocks(view().state.doc));

  return {
    text: () => placed.text,
    setMarks: (marks) => {
      const v = view();
      const found: Decoration[] = [];
      for (const span of marks.amend?.spans ?? []) {
        for (const [from, to] of pieces(placed, span.start, span.end)) {
          found.push(Decoration.inline(from, to, { class: 'charter-anchor' }));
        }
        const end = pieces(placed, span.start, span.end).at(-1)?.[1];
        if (end !== undefined)
          found.push(
            Decoration.widget(
              end,
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
      for (const change of marks.changes ?? []) {
        const current = change.index === marks.current;
        if (change.struck !== null) {
          // Where the newer text has no words to place it by (all its prose was taken away and,
          // say, only a code block is left), the struck words sit at the start: they stay in the
          // document and the reader's Previous and Next still have somewhere to go.
          const at = positionAt(placed, change.at) ?? 0;
          found.push(
            Decoration.widget(at, () => struckNode(change, current), {
              side: -1,
              ignoreSelection: true,
              key: `del-${change.index}-${current ? 'now' : 'idle'}`,
            }),
          );
        }
        if (change.inserted)
          for (const [from, to] of pieces(placed, change.inserted.start, change.inserted.end))
            found.push(
              Decoration.inline(from, to, {
                class: `diff-ins${current ? ' is-current' : ''}`,
                'data-change': String(change.index),
              }),
            );
      }
      if (marks.flash)
        for (const [from, to] of pieces(placed, marks.flash.start, marks.flash.end))
          found.push(Decoration.inline(from, to, { class: 'charter-flash' }));
      v.dispatch(v.state.tr.setMeta(marksKey, DecorationSet.create(v.state.doc, found)));
    },
    scrollTo: (target) => {
      const selector = 'change' in target ? `[data-change="${target.change}"]` : '.charter-flash';
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) return false;
      // A long way is a jump, not a scroll the reader has to sit through.
      const far =
        Math.abs(node.getBoundingClientRect().top - window.innerHeight / 2) > window.innerHeight;
      node.scrollIntoView({
        block: 'center',
        behavior:
          far || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      return true;
    },
    destroy: async () => {
      await editor.destroy();
    },
  };
}

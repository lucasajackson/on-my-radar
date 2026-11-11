/**
 * The charter as a reader sees it: the plain text anchors are matched against.
 *
 *     markdown ──(micromark + GFM, the parser family Milkdown uses)──▶ mdast
 *              ──▶ { text, blocks, code, sourceRange }
 *
 * What survives into `text` is every character a reader can select: paragraph,
 * heading and table-cell text, link text, and the text of inline code. What does
 * not is everything that is markup rather than words — emphasis marks, escapes
 * (`A\*` and `A*` are the same text), link targets, table padding, soft line
 * wraps — and fenced or indented code blocks, which are not prose. Whitespace
 * runs collapse to one space. Blocks (a paragraph, a heading, a table cell) are
 * joined by `"\n\n"` and nothing else in `text` is a newline, so a quote that
 * crosses blocks says so.
 *
 * Because `text` is the same whether a word is bold, italic, code, in a padded
 * cell or behind a soft wrap, an edit that changes only formatting cannot move
 * an anchor. Only changing the words does.
 *
 * Reading a selection out of ProseMirror: use `doc.textBetween(from, to, '\n\n', ' ')`.
 * The `' '` matters. Milkdown's `<br>` is a leaf node with no text of its own, so
 * without it "left<br>right" reads "leftright"; with it, "left right", as here.
 *
 * Pure: the server and the web app share this file.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import type { Nodes, PhrasingContent, Root } from 'mdast';

/** What a block is in the source; list items and quotes are containers, their paragraphs are the blocks. */
export type TextBlockKind = 'paragraph' | 'heading' | 'cell';

export interface TextBlock {
  /** Offsets into `text`, end exclusive; the separator after a block is not part of it. */
  readonly start: number;
  readonly end: number;
  readonly kind: TextBlockKind;
  /** The headings above this block, outermost first; a heading's own path ends with itself. */
  readonly headingPath: readonly string[];
}

export interface TextProjection {
  readonly text: string;
  readonly blocks: readonly TextBlock[];
  /** Ranges of `text` that are inline code, sorted. They are selectable, but a replacement cannot cut one open. */
  readonly code: ReadonlyArray<readonly [number, number]>;
  /** The span of the markdown source that holds `text[start,end)`, escapes and markup inside it included. */
  sourceRange(start: number, end: number): [number, number];
}

export const BLOCK_SEPARATOR = '\n\n';

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const BREAK_TAG = /^<br\s*\/?>$/i;

/** Collapses whitespace the way `text` does, keeping a block separator where the input has a blank line. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, (run) => (run.split('\n').length > 2 ? BLOCK_SEPARATOR : ' ')).trim();
}

/** One block being read: its collapsed characters and, for each, the source span it came from. */
class BlockBuffer {
  chars: string[] = [];
  from: number[] = [];
  to: number[] = [];
  code: Array<[number, number]> = [];

  add(char: string, from: number, to: number): void {
    if (/\s/.test(char)) {
      if (this.chars.length === 0 || this.chars[this.chars.length - 1] === ' ') return;
      char = ' ';
    }
    this.chars.push(char);
    this.from.push(from);
    this.to.push(to);
  }

  /** Code is not collapsed against its neighbours' spaces, only its own edges are. */
  addCode(value: string, from: number, to: number): void {
    const start = this.chars.length;
    for (let i = 0; i < value.length; i++) this.add(value.charAt(i), from, to);
    if (this.chars.length > start) this.code.push([start, this.chars.length]);
  }
}

/** Aligns a text node's decoded value with its source, so each value character knows where it was written. */
function alignText(
  source: string,
  value: string,
  a: number,
  b: number,
): Array<[number, number]> | null {
  const spans: Array<[number, number]> = [];
  let v = 0;
  for (let p = a; p < b;) {
    let length = 1;
    let decoded = source.charAt(p);
    if (decoded === '\\' && p + 1 < b && PUNCTUATION.test(source.charAt(p + 1))) {
      length = 2;
      decoded = source.charAt(p + 1);
    } else if (decoded === '&') {
      ENTITY.lastIndex = p;
      const hit = ENTITY.exec(source);
      if (hit && p + hit[0].length <= b) {
        length = hit[0].length;
        decoded = decodeString(hit[0]);
      }
    }
    if (decoded.length > 0 && value.startsWith(decoded, v)) {
      for (let i = 0; i < decoded.length; i++) spans.push([p, p + length]);
      v += decoded.length;
    }
    p += length;
  }
  return v === value.length ? spans : null;
}

/** Block nodes the projection reads through, to the paragraphs, headings and cells inside them. */
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'table',
  'tableRow',
  'footnoteDefinition',
]);
/** Block nodes whose phrasing is the projection's text. */
const TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'tableCell']);

/** A block of the source that the projection leaves out: it is not prose, so no anchor can be in it. */
export interface UnreadBlock {
  /** The mdast type: `code` (fenced with backticks or tildes, or indented), `html`, `definition`, … */
  readonly type: string;
  /** The lines of the source it covers, 1-based and inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** A code block's text, without its fences or indentation. */
  readonly value?: string;
}

/**
 * The blocks `projectMarkdown` does not read, found by the same walk: whatever is neither one of
 * its containers nor one of its text blocks. A page that draws the charter uses this to show them
 * as what they are (code as code) and to keep them out of the text it matches anchors against.
 */
export function unreadBlocks(markdown: string): UnreadBlock[] {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const out: UnreadBlock[] = [];
  const walk = (node: Nodes): void => {
    if (TEXT_BLOCK_TYPES.has(node.type)) return;
    if (CONTAINER_TYPES.has(node.type)) {
      for (const child of (node as { children: Nodes[] }).children) walk(child);
      return;
    }
    const at = node.position;
    if (!at) return;
    out.push({
      type: node.type,
      startLine: at.start.line,
      endLine: at.end.line,
      ...(node.type === 'code' ? { value: node.value } : {}),
    });
  };
  walk(tree);
  return out;
}

export function projectMarkdown(markdown: string): TextProjection {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  let text = '';
  const srcFrom: number[] = [];
  const srcTo: number[] = [];
  const blocks: TextBlock[] = [];
  const code: Array<[number, number]> = [];
  const path: Array<{ depth: number; title: string }> = [];

  const phrasing = (node: PhrasingContent, into: BlockBuffer): void => {
    const a = node.position?.start.offset ?? 0;
    const b = node.position?.end.offset ?? 0;
    switch (node.type) {
      case 'text': {
        // Usually the source is the value; escapes, entities and stripped indentation make it differ.
        const same = markdown.slice(a, b) === node.value;
        const spans = same ? null : alignText(markdown, node.value, a, b);
        for (let i = 0; i < node.value.length; i++) {
          const span: readonly [number, number] = same
            ? [a + i, a + i + 1]
            : (spans?.[i] ?? [a, b]);
          into.add(node.value.charAt(i), span[0], span[1]);
        }
        return;
      }
      case 'inlineCode':
        into.addCode(node.value, a, b);
        return;
      case 'break':
        into.add(' ', a, b);
        return;
      case 'html':
        if (BREAK_TAG.test(node.value)) into.add(' ', a, b);
        return;
      case 'emphasis':
      case 'strong':
      case 'delete':
      case 'link':
      case 'linkReference':
        for (const child of node.children) phrasing(child, into);
        return;
      default:
        return;
    }
  };

  const block = (
    children: readonly PhrasingContent[],
    kind: TextBlockKind,
    title?: { depth: number },
  ): void => {
    const into = new BlockBuffer();
    for (const child of children) phrasing(child, into);
    while (into.chars[into.chars.length - 1] === ' ') {
      into.chars.pop();
      into.from.pop();
      into.to.pop();
    }
    if (into.chars.length === 0) return;
    into.code = into.code.filter(([from]) => from < into.chars.length);
    const body = into.chars.join('');
    if (title) {
      while (path.length > 0 && (path[path.length - 1] as { depth: number }).depth >= title.depth)
        path.pop();
      path.push({ depth: title.depth, title: body });
    }
    if (text.length > 0) {
      text += BLOCK_SEPARATOR;
      for (let i = 0; i < BLOCK_SEPARATOR.length; i++) {
        srcFrom.push(srcTo[srcTo.length - 1] as number);
        srcTo.push(srcTo[srcTo.length - 1] as number);
      }
    }
    const start = text.length;
    text += body;
    for (let i = 0; i < into.chars.length; i++) {
      srcFrom.push(into.from[i] as number);
      srcTo.push(into.to[i] as number);
    }
    for (const [from, to] of into.code)
      code.push([start + from, start + Math.min(to, into.chars.length)]);
    blocks.push({ start, end: text.length, kind, headingPath: path.map((h) => h.title) });
  };

  // The walk below and `unreadBlocks` read the same node types (CONTAINER_TYPES, TEXT_BLOCK_TYPES).
  const container = (node: Nodes): void => {
    switch (node.type) {
      case 'paragraph':
        block(node.children, 'paragraph');
        return;
      case 'heading':
        block(node.children, 'heading', { depth: node.depth });
        return;
      case 'tableCell':
        block(node.children, 'cell');
        return;
      case 'root':
      case 'blockquote':
      case 'list':
      case 'listItem':
      case 'table':
      case 'tableRow':
      case 'footnoteDefinition':
        for (const child of node.children) container(child);
        return;
      default:
        return;
    }
  };
  container(tree);

  const fromArr = Int32Array.from(srcFrom);
  const toArr = Int32Array.from(srcTo);
  return {
    text,
    blocks,
    code,
    sourceRange(start, end) {
      if (start < 0 || end > text.length || end <= start)
        throw new RangeError(
          `projection range [${start}, ${end}) is outside the text (${text.length})`,
        );
      return [fromArr[start] as number, toArr[end - 1] as number];
    },
  };
}

/** The block holding offset `at` of the projection's text, or null for a separator or out of range. */
export function blockAt(projection: TextProjection, at: number): TextBlock | null {
  const { blocks } = projection;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid] as TextBlock;
    if (at < b.start) hi = mid - 1;
    else if (at >= b.end) lo = mid + 1;
    else return b;
  }
  return null;
}

/**
 * Where a charter passage is on the page, and what a selection of the page says.
 *
 * The server keeps a link as a place in the charter's plain-text projection (`start`, `end`). The
 * page is drawn from markdown to HTML, or by Milkdown, so those places have to be found again in
 * the DOM without writing anything into it: `domStream` reads the page the way the projection
 * reads the markdown (text outside fenced code, whitespace collapsed, a blank line between
 * blocks), remembering for each character the DOM point it came from. A range is then two points.
 *
 * The same reading gives a selection's words (`selectionWords`), so what is sent to the server to
 * link or re-anchor is the text a reader sees, across paragraphs if need be.
 */
import { BLOCK_SEPARATOR } from '@onmyradar/contract';

type Point = readonly [Node, number];

/**
 * Elements whose words are not charter text: code blocks, the blocks the projection leaves out
 * (`.md-raw`, see `unreadBlocks`), labels drawn by us, an image's stand-in.
 */
const SKIP = 'pre, .md-raw, .amend-ref, .charter-anchor-ref, .md-image';
/** Elements the projection separates with a blank line. */
const BLOCK = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote';
/** The accepted replacement shown in place of struck text; `data-was` is how many characters it stands for. */
const REPLACEMENT = 'ins.amend-with';
/** One character of the charter's own words that the page does not show. It matches any character. */
const STANDS_FOR = '\uFFFC';

export interface DomStream {
  text: string;
  /** The DOM point before character `i`, and the one after it. */
  before: (i: number) => Point;
  after: (i: number) => Point;
}

/**
 * The text of `root` as the projection reads it. With `within`, only the words inside that range.
 * An accepted amendment's replacement (As amended) stands for the text it replaced, which is what
 * the charter holds, so a place inside it maps to the replacement's edges.
 */
export function domStream(root: Node, within?: Range): DomStream {
  const chars: string[] = [];
  const before: Point[] = [];
  const after: Point[] = [];
  let block: Element | null | undefined;
  let gap: { from: Point; to: Point } | null = null;
  let broken = false;

  const blockOf = (node: Node): Element | null =>
    (node instanceof Element ? node : node.parentElement)?.closest(BLOCK) ?? null;
  /** Characters arrive here; a space or a break is only written once something follows it. */
  const push = (char: string, from: Point, to: Point, owner: Element | null) => {
    if (chars.length > 0 && owner !== block) broken = true;
    block = owner;
    if (chars.length > 0 && broken) {
      const last = after[after.length - 1] as Point;
      for (const c of BLOCK_SEPARATOR) {
        chars.push(c);
        before.push(last);
        after.push(from);
      }
    } else if (gap && chars.length > 0) {
      chars.push(' ');
      before.push(gap.from);
      after.push(gap.to);
    }
    broken = false;
    gap = null;
    chars.push(char);
    before.push(from);
    after.push(to);
  };
  const space = (from: Point, to: Point, owner: Element | null) => {
    if (chars.length === 0) return;
    if (owner !== block) {
      broken = true;
      block = owner;
      return;
    }
    gap ??= { from, to };
  };
  const text = (node: Text) => {
    const value = node.data;
    let from = 0;
    let to = value.length;
    if (within) {
      if (!within.intersectsNode(node)) return;
      if (node === within.startContainer) from = within.startOffset;
      if (node === within.endContainer) to = within.endOffset;
    }
    const owner = blockOf(node);
    for (let k = from; k < to; k += 1) {
      const char = value.charAt(k);
      if (/\s/.test(char)) space([node, k], [node, k + 1], owner);
      else push(char, [node, k], [node, k + 1], owner);
    }
  };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      text(node);
      return;
    }
    if (!(node instanceof Element) || node.matches(SKIP)) return;
    if (within && !within.intersectsNode(node)) return;
    if (node.tagName === 'BR') {
      const at = node.parentNode;
      const k = at ? Array.prototype.indexOf.call(at.childNodes, node) : 0;
      if (at) space([at, k], [at, k + 1], blockOf(node));
      return;
    }
    if (node.matches(REPLACEMENT) && node.parentNode) {
      const was = Number(node.getAttribute('data-was'));
      const k = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      const from: Point = [node.parentNode, k];
      const to: Point = [node.parentNode, k + 1];
      const owner = blockOf(node);
      for (let n = 0; n < was; n += 1) push(STANDS_FOR, from, to, owner);
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  return {
    text: chars.join(''),
    before: (i) => before[i] as Point,
    after: (i) => after[i] as Point,
  };
}

/** A range over characters `[start, end)` of the stream. */
function rangeOver(stream: DomStream, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(...stream.before(start));
  range.setEnd(...stream.after(end - 1));
  return range;
}

/** How many characters must agree after a difference before the two readings are taken as realigned. */
const RESYNC_RUN = 12;
/** The most characters either reading may carry that the other lacks, at one place. */
const RESYNC_SKIP = 96;
/** The most characters the page may add inside one linked passage at one place (a task marker, say). */
const MAX_ADDED = 16;
/** The most places the readings may differ without being realigned before the rest is left unplaced. */
const RESYNC_FAILURES = 200;

const agrees = (projected: string, at: number, stream: string, from: number, run: number) => {
  if (at + run > projected.length || from + run > stream.length) return false;
  for (let k = 0; k < run; k += 1) {
    const seen = stream.charAt(from + k);
    if (seen !== projected.charAt(at + k) && seen !== STANDS_FOR) return false;
  }
  return true;
};

/**
 * For each character of the projection, the index of the same character in the page's stream, or
 * -1 where the page does not show it. The two read the same words in the same order; they differ
 * where the page draws a construct the projection leaves out or the reverse (a task list's
 * `[x]`, a marker), so they are walked together and, at a difference, realigned on the nearest
 * place where the next run of characters (or the rest of the block, if that is shorter) agrees.
 * The place of a character is its place in the order, never found by searching for its words, so a
 * passage that recurs cannot land on its twin. One pass: the work is the length of the text, plus
 * a bounded look-ahead at each difference.
 */
export function alignStream(projected: string, stream: string): Int32Array {
  const map = new Int32Array(projected.length).fill(-1);
  let i = 0;
  let j = 0;
  let failures = 0;
  while (i < projected.length && j < stream.length) {
    const seen = stream.charAt(j);
    if (seen === projected.charAt(i) || seen === STANDS_FOR) {
      map[i] = j;
      i += 1;
      j += 1;
      continue;
    }
    const blockEnd = projected.indexOf(BLOCK_SEPARATOR, i);
    const left = (blockEnd < 0 ? projected.length : blockEnd) - i;
    const run = Math.min(RESYNC_RUN, Math.max(left, 1), stream.length - j);
    let moved = false;
    for (let d = 1; d <= RESYNC_SKIP && !moved; d += 1) {
      // The page has `d` characters the projection lacks, or the projection has `d` the page lacks.
      if (agrees(projected, i, stream, j + d, run)) {
        j += d;
        moved = true;
      } else if (agrees(projected, i + d, stream, j, run)) {
        i += d;
        moved = true;
      }
    }
    if (moved) continue;
    // No way back to agreement here: this character is not shown, and the walk goes on.
    failures += 1;
    if (failures > RESYNC_FAILURES) break;
    i += 1;
  }
  return map;
}

export interface PlacedLink {
  id: string;
  /** Offsets into `text`, end exclusive. */
  start: number;
  end: number;
}

/**
 * The DOM range of each link. `text` is the charter's projection, which the offsets were measured
 * on. Where the page reads exactly as the projection does, the offsets are used as they are; where
 * it differs (a construct the page draws differently), the two are aligned in order (`alignStream`)
 * and the offsets carried across. A link that cannot be placed that way, or whose words differ on
 * the page, is left out (it still lists in the sidebar): never drawn on the wrong words.
 */
export function placeLinks(
  root: HTMLElement,
  text: string,
  links: readonly PlacedLink[],
): Map<string, Range> {
  const stream = domStream(root);
  const same = stream.text === text;
  const map = same ? null : alignStream(text, stream.text);
  const placed = new Map<string, Range>();
  for (const link of links) {
    if (link.end <= link.start) continue;
    let at = link.start;
    let to = link.end;
    if (map) {
      // Every character of the passage must be on the page, in order; what the page adds between
      // them (a marker) is inside the range. Otherwise it is not drawn: a wrong place is worse than none.
      at = map[link.start] ?? -1;
      to = (map[link.end - 1] ?? -2) + 1;
      if (at < 0 || to <= at) continue;
      let whole = true;
      for (let k = link.start; k < link.end && whole; k += 1) {
        const here = map[k] ?? -1;
        const before = k > link.start ? (map[k - 1] ?? -1) : here;
        whole = here >= 0 && here - before <= MAX_ADDED + 1;
      }
      if (!whole) continue;
    }
    placed.set(link.id, rangeOver(stream, at, to));
  }
  return placed;
}

export interface LinkHit {
  ids: string[];
  /** The line of the passage the point is on. */
  rect: DOMRect;
}

/** The links whose words are under a point, and the line of the first. */
export function linksAt(ranges: ReadonlyMap<string, Range>, x: number, y: number): LinkHit | null {
  const ids: string[] = [];
  let rect: DOMRect | null = null;
  for (const [id, range] of ranges) {
    for (const box of Array.from(range.getClientRects())) {
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        ids.push(id);
        rect ??= box;
        break;
      }
    }
  }
  return rect && ids.length > 0 ? { ids, rect } : null;
}

/* ------------------------------ what a selection says ------------------------------ */

/** The words either side of a selection sent with it, to tell it from a twin. */
const CONTEXT = 64;

export interface WordsSelected {
  quote: string;
  /** Why this selection cannot be linked or re-anchored, in words for the reader. */
  refusal?: string;
  /** The words' range: widened to hold a line of inline code the selection cut open. */
  range: Range;
}

export const IN_CODE = "Code can't be anchored. Select the sentence around it.";
export const REPLACED =
  'An ADR has replaced this text in the amended view. Show the charter as written to link it.';

/**
 * What the reader selected, as the server reads it. A selection that starts or ends inside a line
 * of inline code is widened to hold all of it (the server refuses one that cuts code open); one
 * that is only code, or only a fenced block, says so.
 */
export function selectionWords(scope: HTMLElement, selection: Selection): WordsSelected | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!scope.contains(range.commonAncestorContainer)) return null;
  const boxOf = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest('pre, code') ?? null;
  const first = boxOf(range.startContainer);
  const last = boxOf(range.endContainer);
  if (first && first === last)
    return { quote: selection.toString().trim(), refusal: IN_CODE, range };
  if (first?.tagName === 'CODE' && scope.contains(first)) range.setStartBefore(first);
  if (last?.tagName === 'CODE' && scope.contains(last)) range.setEndAfter(last);
  const quote = domStream(scope, range).text.trim();
  if (quote.length === 0) return { quote: '', refusal: IN_CODE, range };
  const replaced = [...scope.querySelectorAll(REPLACEMENT)].some((el) => range.intersectsNode(el));
  return { quote, ...(replaced ? { refusal: REPLACED } : {}), range };
}

/**
 * Up to 64 characters of the page before and after a range, across blocks, so a passage that the
 * charter holds twice can be told apart. Read when the selection is acted on, not as it is dragged:
 * it walks the page either side of it.
 */
export function wordsAround(
  scope: HTMLElement,
  range: Range,
): { prefix?: string; suffix?: string } {
  const start = document.createRange();
  start.setStart(scope, 0);
  start.setEnd(range.startContainer, range.startOffset);
  const end = document.createRange();
  end.setStart(range.endContainer, range.endOffset);
  end.setEnd(scope, scope.childNodes.length);
  const prefix = domStream(scope, start).text.slice(-CONTEXT);
  const suffix = domStream(scope, end).text.slice(0, CONTEXT);
  return { ...(prefix.trim() ? { prefix } : {}), ...(suffix.trim() ? { suffix } : {}) };
}

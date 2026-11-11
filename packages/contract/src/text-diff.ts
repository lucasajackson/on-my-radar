/**
 * A text diff that is a pure function of its two inputs: blocks first, then
 * words inside the blocks that changed.
 *
 * It answers one question for the anchor resolver — which characters of the old
 * text are, unchanged and unbroken, still in the new text, and where — so it
 * returns the *equal runs* and nothing else. There is deliberately no timeout:
 * a timeout makes the answer depend on how fast the CPU is, and an anchor must
 * not orphan on a slow machine. The bound is instead one budget of edits for
 * the whole diff, shared by every changed stretch; once it is spent the rest is
 * treated as wholly replaced, which is still deterministic (and `exact` says
 * so).
 *
 * Pure and dependency-free.
 */

/** A stretch that is character for character the same in both texts. */
export interface EqualRun {
  readonly oldStart: number;
  readonly newStart: number;
  readonly length: number;
}

export interface TextDiff {
  /** Sorted, non-empty, non-adjacent (a run that continues the previous is merged into it). */
  readonly runs: readonly EqualRun[];
  /** False when an edit cap was hit and some changed stretch was treated as wholly replaced. */
  readonly exact: boolean;
}

/** Edits (blocks and words together) one diff may explore before the rest is treated as replaced. */
export const DIFF_EDIT_BUDGET = 2000;

const BLOCK_SEPARATOR = '\n\n';

/**
 * Equal diagonals of the shortest edit script between two integer sequences, or
 * null when it needs more edits than the budget has left. The budget is spent
 * by what was explored, so a failure leaves none.
 */
function myers(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  budget: { left: number },
): Array<[number, number, number]> | null {
  const n = a.length;
  const m = b.length;
  const dMax = Math.min(budget.left, n + m);
  const off = dMax + 1;
  const v = new Int32Array(2 * dMax + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= dMax && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x === n && y === m) found = d;
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) {
    budget.left = 0;
    return null;
  }
  budget.left -= found;
  const snakes: Array<[number, number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const k = x - y;
    const base = d - 1;
    const down =
      k === -d || (k !== d && (prev[base + k - 1] as number) < (prev[base + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[base + prevK] as number;
    const prevY = prevX - prevK;
    const midX = down ? prevX : prevX + 1;
    if (x > midX) snakes.push([midX, midX - k, x - midX]);
    x = prevX;
    y = prevY;
  }
  if (x > 0) snakes.push([0, 0, x]);
  return snakes.reverse();
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** Scripts written without spaces: every character is its own word, or an edit anywhere would replace the sentence. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * What the character at `at` is: 1 for a word character (a letter, number or mark in any script, or `_`),
 * 2 for whitespace, 0 for anything else, which is a word of its own (punctuation of any script, CJK ideographs).
 * `width` is its length in UTF-16 units.
 */
function charAt(s: string, at: number): { kind: 0 | 1 | 2; width: number } {
  const code = s.codePointAt(at) as number;
  const width = code > 0xffff ? 2 : 1;
  if (code < 128) {
    const kind =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      code === 95 ||
      (code >= 97 && code <= 122)
        ? 1
        : code <= 32
          ? 2
          : 0;
    return { kind, width };
  }
  const ch = String.fromCodePoint(code);
  if (UNSPACED.test(ch)) return { kind: 0, width };
  if (WORD_CHAR.test(ch)) return { kind: 1, width };
  return { kind: /\s/.test(ch) ? 2 : 0, width };
}

/**
 * Start offsets of the words of `s[from,to)`: a run of word characters, a run
 * of whitespace, or one other character. Matching whole words instead of
 * characters keeps an edit from sliding onto look-alike letters (an insertion
 * after "reasfal" starting with "l" must not claim the quote's last "l"), and
 * splitting on any script's punctuation keeps "Alpha—beta" two words.
 */
function wordStarts(s: string, from: number, to: number): number[] {
  const starts: number[] = [];
  for (let at = from; at < to;) {
    starts.push(at);
    const first = charAt(s, at);
    at += first.width;
    if (first.kind !== 0) {
      while (at < to) {
        const next = charAt(s, at);
        if (next.kind !== first.kind) break;
        at += next.width;
      }
    }
  }
  return starts;
}

/** Appends a run, merging it into the previous one when it continues it. */
function push(runs: EqualRun[], oldStart: number, newStart: number, length: number): void {
  if (length <= 0) return;
  const last = runs[runs.length - 1];
  if (last && last.oldStart + last.length === oldStart && last.newStart + last.length === newStart)
    runs[runs.length - 1] = {
      oldStart: last.oldStart,
      newStart: last.newStart,
      length: last.length + length,
    };
  else runs.push({ oldStart, newStart, length });
}

/** Lengths of the equal head and tail of two texts, never overlapping. */
function commonEnds(a: string, b: string): { head: number; tail: number } {
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < max - head &&
    a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)
  )
    tail++;
  return { head, tail };
}

/** True when `at` is the start of a block of `s`: the start of the text, or just after a separator. */
const atBlockStart = (s: string, at: number): boolean =>
  at <= 0 ||
  (at >= BLOCK_SEPARATOR.length && s.startsWith(BLOCK_SEPARATOR, at - BLOCK_SEPARATOR.length));

export function diffText(a: string, b: string): TextDiff {
  const runs: EqualRun[] = [];
  const budget = { left: DIFF_EDIT_BUDGET };
  let exact = true;
  const ends = commonEnds(a, b);
  // Equal ends are cut back to a block edge in both texts. A block that is whole on both sides can then be
  // matched as a block; cut mid-block, a shared letter or word would pull it apart.
  let head = ends.head;
  while (head > 0 && !(atBlockStart(a, head) && atBlockStart(b, head))) head--;
  let tail = ends.tail;
  while (tail > 0 && !(atBlockStart(a, a.length - tail) && atBlockStart(b, b.length - tail)))
    tail--;
  push(runs, 0, 0, head);
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;

  if (aEnd > head && bEnd > head) {
    // Blocks, compared without their separator, so a block is the same block wherever it falls.
    const blocks = new Map<string, number>();
    const tokens = (s: string, to: number) => {
      const starts: number[] = [];
      const stops: number[] = [];
      for (let at = head; ;) {
        starts.push(at);
        const next = s.indexOf(BLOCK_SEPARATOR, at);
        if (next < 0 || next >= to) {
          stops.push(to);
          break;
        }
        stops.push(next);
        at = next + BLOCK_SEPARATOR.length;
        if (at >= to) break;
      }
      const ids = starts.map((st, i) => {
        const key = s.slice(st, stops[i]);
        let id = blocks.get(key);
        if (id === undefined) {
          id = blocks.size;
          blocks.set(key, id);
        }
        return id;
      });
      // Does a separator follow this block inside the region?
      const sep = stops.map(
        (stop) => stop + BLOCK_SEPARATOR.length <= to && s.startsWith(BLOCK_SEPARATOR, stop),
      );
      return { starts, stops, sep, ids };
    };
    const at = tokens(a, aEnd);
    const bt = tokens(b, bEnd);
    const edge = (t: { starts: number[] }, i: number, end: number) => t.starts[i] ?? end;
    const lines = myers(at.ids, bt.ids, budget);
    if (!lines) exact = false;
    // Walk the gaps between matched block runs; a gap with text on both sides is diffed by word.
    let ai = 0;
    let bi = 0;
    const gap = (aTo: number, bTo: number) => {
      const aFrom = edge(at, ai, aEnd);
      const bFrom = edge(bt, bi, bEnd);
      const aStop = edge(at, aTo, aEnd);
      const bStop = edge(bt, bTo, bEnd);
      if (aStop > aFrom && bStop > bFrom) {
        const words = new Map<string, number>();
        const ids = (text: string, to: number, starts: number[]) =>
          starts.map((st, i) => {
            const key = text.slice(st, starts[i + 1] ?? to);
            let id = words.get(key);
            if (id === undefined) {
              id = words.size;
              words.set(key, id);
            }
            return id;
          });
        const aw = wordStarts(a, aFrom, aStop);
        const bw = wordStarts(b, bFrom, bStop);
        const found = myers(ids(a, aStop, aw), ids(b, bStop, bw), budget);
        if (!found) exact = false;
        for (const [x, y, len] of found ?? []) {
          const ax = aw[x] as number;
          const by = bw[y] as number;
          push(runs, ax, by, (aw[x + len] ?? aStop) - ax);
        }
      }
    };
    for (const [x, y, len] of lines ?? []) {
      gap(x, y);
      // The matched blocks, and the separator after them when both texts have one there.
      const last = [x + len - 1, y + len - 1] as const;
      const joined =
        at.sep[last[0]] === true && bt.sep[last[1]] === true ? BLOCK_SEPARATOR.length : 0;
      const aFrom = at.starts[x] as number;
      push(runs, aFrom, bt.starts[y] as number, (at.stops[last[0]] as number) + joined - aFrom);
      ai = x + len;
      bi = y + len;
    }
    gap(at.starts.length, bt.starts.length);
  }
  push(runs, aEnd, bEnd, tail);
  return { runs, exact };
}

/** The run containing `old` (when `side` is 'old') or `new` index, or undefined. */
function runAt(
  runs: readonly EqualRun[],
  index: number,
  side: 'old' | 'new',
): EqualRun | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid] as EqualRun;
    const start = side === 'old' ? run.oldStart : run.newStart;
    if (index < start) hi = mid - 1;
    else if (index >= start + run.length) lo = mid + 1;
    else return run;
  }
  return undefined;
}

/**
 * Where the old range [start,end) is in the new text, if every one of its
 * characters is in an equal run and nothing was inserted among them; else null.
 */
export function mapRange(diff: TextDiff, start: number, end: number): [number, number] | null {
  if (end <= start) return null;
  const run = runAt(diff.runs, start, 'old');
  if (!run || end > run.oldStart + run.length) return null;
  const shift = run.newStart - run.oldStart;
  return [start + shift, end + shift];
}

/**
 * True when the new range [start,end) is old text that nothing has touched:
 * the whole range lies in one equal run. A range that straddles runs, or has
 * any character that is not an unchanged one, is new text.
 */
export function isUntouched(diff: TextDiff, start: number, end: number): boolean {
  const run = runAt(diff.runs, start, 'new');
  return run !== undefined && end <= run.newStart + run.length;
}

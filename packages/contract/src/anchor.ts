/**
 * Anchors that live outside the text.
 *
 * An anchor is a quote plus up to {@link ANCHOR_CONTEXT} characters of context
 * on each side, matched against a {@link TextProjection} (rendered text:
 * whitespace collapsed, markup and fenced code gone). Nothing is written into
 * the document, so nothing can be damaged by an editor's escaping, by an agent
 * rewriting a section, or by typing; and because the projection ignores
 * formatting, only a change to the words can break an anchor.
 *
 * The rule throughout: a false orphan is recoverable (re-anchor, heal, undo), a
 * false keep silently attaches an ADR to the wrong words. When in doubt, orphan.
 *
 * When the text changes, each anchor is resolved in this order:
 *
 *  0. **Count the quote.** If the quote occurs fewer times in the new text than
 *     in the old (or so often in either that the count is capped, which counts
 *     as fewer), an edit removed a copy of it, and neither diff can prove
 *     which: a surviving twin may be the very stretch the ADR was written
 *     against. Every anchor on that quote orphans as `ambiguous`, unless its own
 *     range and its full context are proven untouched: both diffs map the
 *     quote and the {@link ANCHOR_CONTEXT} characters on each side identically,
 *     in one piece, so no edit fell inside them.
 *  1. **Map through the diff.** The old text is diffed against the new twice,
 *     once from the front and once from the back (the same diff of the reversed
 *     texts). The anchor survives, its position shifted, only if every
 *     character of its range is in an equal run and nothing was inserted among
 *     them. Where the two diffs place it differently, an edit could have
 *     removed either of two identical stretches (delete one of two identical
 *     paragraphs and the survivor could be either), nobody can say which, and
 *     the anchor orphans as `ambiguous`. Where only one diff places it, it
 *     survives unless the old text held an identical twin of it, which is the
 *     same doubt.
 *  2. **Rebind** otherwise, but only to an occurrence of the quote that is new
 *     text (touched by this edit under both diffs) and agrees with the stored
 *     prefix and suffix up to the block boundary they reach. That is a cut and
 *     paste: a quote that filled a paragraph has new neighbours once the
 *     paragraph moves, so the context is only trusted inside the block. Exactly
 *     one such occurrence rebinds. An occurrence that was already in the
 *     document and is untouched by this edit is never a candidate, however well
 *     its surroundings agree, which is what stops a twin.
 *  3. **Orphan** otherwise. An orphan keeps its last good selector, so undoing
 *     the edit heals it (rule 2 runs on orphans at every save).
 *
 * If the diff ran out of its edit budget (`exact` false) nothing is proven about
 * the text it gave up on: only an anchor both diffs map identically survives,
 * and none rebinds.
 *
 * Pure and deterministic: no clock, no locale, no timeout.
 */
import { BLOCK_SEPARATOR, normalizeText, type TextProjection } from './charter-text.js';
import { diffText, isUntouched, mapRange, type TextDiff } from './text-diff.js';

export const ANCHOR_CONTEXT = 64;

export interface AnchorSelector {
  readonly quote: string;
  /** Up to {@link ANCHOR_CONTEXT} characters of projection text before the quote. */
  readonly prefix: string;
  readonly suffix: string;
}

export type AnchorState = 'anchored' | 'orphaned' | 'dismissed';

export interface AnchorInput {
  readonly id: string;
  readonly state: AnchorState;
  /** The last selector that resolved. */
  readonly selector: AnchorSelector;
  /** Where the quote was in the old text; null for an orphan or an anchor with no cache yet. */
  readonly start: number | null;
  readonly end: number | null;
}

/**
 * - `kept`: mapped through the diff (position may have shifted).
 * - `moved`: the diff broke it, rebound to the one fitting occurrence.
 * - `healed`: was orphaned, rebound.
 * - `orphaned`: was anchored, now has no place in the text.
 * - `still-orphaned` / `dismissed`: unchanged.
 */
export type AnchorOutcome =
  'kept' | 'moved' | 'healed' | 'orphaned' | 'still-orphaned' | 'dismissed';

/**
 * Why an anchor has no place, when it has none:
 * - `text_changed`: its words are gone or changed.
 * - `ambiguous`: it could be either of two identical stretches, or its quote recurs too often to tell.
 * - `diff_not_exact`: the edit was too large to prove anything about this anchor.
 */
export type AnchorCause = 'text_changed' | 'ambiguous' | 'diff_not_exact';

export interface AnchorResolution {
  readonly id: string;
  readonly outcome: AnchorOutcome;
  readonly state: AnchorState;
  readonly start: number | null;
  readonly end: number | null;
  /** Refreshed from the new text when the anchor resolved; otherwise the input's, unchanged. */
  readonly selector: AnchorSelector;
  /** Set when `state` is `orphaned`. */
  readonly cause?: AnchorCause;
}

export interface AnchorResolutions {
  readonly anchors: readonly AnchorResolution[];
  /** False when the diff spent its edit budget and some changed stretch counted as replaced. */
  readonly exact: boolean;
}

/** Most occurrences of one quote considered; a quote that recurs more often than this cannot be told apart. */
export const MAX_QUOTE_MATCHES = 1000;

/** The selector for `text[start,end)`. */
export function selectorAt(text: string, start: number, end: number): AnchorSelector {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT),
  };
}

/**
 * The part of a context window that lies in the quote's own block, and whether
 * the window reached the block's edge: a newline (the projection's only newlines
 * are block separators, and a 64-character window may cut one in half) or the
 * end of the text. A window that reached neither says nothing about the edge.
 */
function inBlock(window: string, side: 'before' | 'after'): { text: string; edge: boolean } {
  const cut = side === 'before' ? window.lastIndexOf('\n') : window.indexOf('\n');
  if (cut < 0) return { text: window, edge: window.length < ANCHOR_CONTEXT };
  return { text: side === 'before' ? window.slice(cut + 1) : window.slice(0, cut), edge: true };
}

/**
 * Does a candidate's context agree with the stored one up to the block
 * boundary? Identical windows always do. Otherwise both must have reached the
 * boundary and agree on what lies inside it, so a quote that filled a paragraph
 * still agrees after the paragraph moves and its neighbours change.
 */
function agrees(window: string, stored: string, side: 'before' | 'after'): boolean {
  if (window === stored) return true;
  const a = inBlock(window, side);
  const b = inBlock(stored, side);
  return a.edge && b.edge && a.text === b.text;
}

/**
 * Where `pattern` occurs in `text` (overlapping occurrences included), at most
 * `limit` of them; `capped` when there were more. The cap bounds the work: each
 * occurrence costs at most the pattern's length.
 */
function occurrences(
  text: string,
  pattern: string,
  limit: number,
): { at: number[]; capped: boolean } {
  const at: number[] = [];
  if (pattern.length === 0) return { at, capped: false };
  for (let i = text.indexOf(pattern); i >= 0; i = text.indexOf(pattern, i + 1)) {
    if (at.length === limit) return { at, capped: true };
    at.push(i);
  }
  return { at, capped: false };
}

const contextOf = (text: string, at: number, end: number) => ({
  before: text.slice(Math.max(0, at - ANCHOR_CONTEXT), at),
  after: text.slice(end, end + ANCHOR_CONTEXT),
});

/** How many stretches of `text` the selector cannot tell apart (up to 2): the quote, with context agreeing up to the block edge. */
function twinsIn(text: string, selector: AnchorSelector): number {
  const found = occurrences(text, selector.quote, MAX_QUOTE_MATCHES);
  if (found.capped) return 2;
  let twins = 0;
  for (const at of found.at) {
    const { before, after } = contextOf(text, at, at + selector.quote.length);
    if (
      agrees(before, selector.prefix, 'before') &&
      agrees(after, selector.suffix, 'after') &&
      ++twins === 2
    )
      break;
  }
  return twins;
}

const reversed = (s: string): string => {
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) out += s.charAt(i);
  return out;
};

/** A diff of the old text against the new, from the front and from the back. */
interface Diffs {
  readonly forward: TextDiff;
  readonly backward: TextDiff | null;
  readonly exact: boolean;
  readonly oldLength: number;
  readonly newLength: number;
}

function diffBoth(before: string, after: string): Diffs {
  if (before === after) {
    const forward = { runs: [{ oldStart: 0, newStart: 0, length: after.length }], exact: true };
    return {
      forward,
      backward: null,
      exact: true,
      oldLength: before.length,
      newLength: after.length,
    };
  }
  const forward = diffText(before, after);
  const backward = diffText(reversed(before), reversed(after));
  return {
    forward,
    backward,
    exact: forward.exact && backward.exact,
    oldLength: before.length,
    newLength: after.length,
  };
}

/** Where the old range went according to the back-to-front diff, in the new text's own coordinates. */
function mapBackward(d: Diffs, start: number, end: number): [number, number] | null {
  if (!d.backward) return mapRange(d.forward, start, end);
  const mapped = mapRange(d.backward, d.oldLength - end, d.oldLength - start);
  return mapped && [d.newLength - mapped[1], d.newLength - mapped[0]];
}

/** True when the new range is old text that neither diff says was touched. */
function untouchedByEither(d: Diffs, start: number, end: number): boolean {
  if (isUntouched(d.forward, start, end)) return true;
  return d.backward !== null && isUntouched(d.backward, d.newLength - end, d.newLength - start);
}

/**
 * True when the old window [start - 64, end + 64) (clipped to the text) is one
 * unbroken stretch in both diffs, at the same place, and the text edges it
 * touched are still the text edges: no edit fell inside the quote or its context.
 */
function provenUntouched(d: Diffs, start: number, end: number): boolean {
  const from = Math.max(0, start - ANCHOR_CONTEXT);
  const to = Math.min(d.oldLength, end + ANCHOR_CONTEXT);
  const front = mapRange(d.forward, from, to);
  const back = mapBackward(d, from, to);
  if (!front || !back || front[0] !== back[0] || front[1] !== back[1]) return false;
  return (from > 0 || front[0] === 0) && (to < d.oldLength || front[1] === d.newLength);
}

/**
 * Whether `after` holds fewer copies of `quote` than `before`. Past the cap the
 * count says nothing (both would read 1,001 whether a copy was lost or not), so
 * a quote that recurs that often in either text counts as having lost one:
 * the anchor orphans as ambiguous unless its own context is proven untouched.
 */
function lostACopy(before: string, after: string, quote: string): boolean {
  const was = occurrences(before, quote, MAX_QUOTE_MATCHES);
  const now = occurrences(after, quote, MAX_QUOTE_MATCHES);
  // The only copy going is not a doubt about which one: it falls through to a plain `text_changed`.
  return was.capped || now.capped || (was.at.length > 1 && now.at.length < was.at.length);
}

type Rebound = { range: [number, number] } | { cause: AnchorCause };

/** The one place the selector's quote can go in `text` after an edit. */
function rebind(text: string, diffs: Diffs, selector: AnchorSelector): Rebound {
  const found = occurrences(text, selector.quote, MAX_QUOTE_MATCHES);
  if (found.capped) return { cause: 'ambiguous' };
  let fit: number | null = null;
  for (const at of found.at) {
    const end = at + selector.quote.length;
    const { before, after } = contextOf(text, at, end);
    if (
      !agrees(before, selector.prefix, 'before') ||
      !agrees(after, selector.suffix, 'after') ||
      untouchedByEither(diffs, at, end)
    )
      continue;
    if (fit !== null) return { cause: 'ambiguous' };
    fit = at;
  }
  return fit === null ? { cause: 'text_changed' } : { range: [fit, fit + selector.quote.length] };
}

/**
 * Re-resolves `anchors` (positions in `before`) against `after`. Results come
 * back in input order. `before` is whatever the caller cached for the head the
 * anchors were last resolved against; only its text is read.
 */
export function resolveAnchors(
  before: Pick<TextProjection, 'text'>,
  after: Pick<TextProjection, 'text'>,
  anchors: readonly AnchorInput[],
): AnchorResolutions {
  const diffs = diffBoth(before.text, after.text);
  const dropped = new Map<string, boolean>();
  const lostCopy = (quote: string): boolean => {
    let lost = dropped.get(quote);
    if (lost === undefined) {
      lost = lostACopy(before.text, after.text, quote);
      dropped.set(quote, lost);
    }
    return lost;
  };
  const resolved = anchors.map((anchor): AnchorResolution => {
    const { id, selector } = anchor;
    if (anchor.state === 'dismissed')
      return {
        id,
        outcome: 'dismissed',
        state: 'dismissed',
        start: anchor.start,
        end: anchor.end,
        selector,
      };
    const was = anchor.state;
    const placed = (range: [number, number], outcome: AnchorOutcome): AnchorResolution => ({
      id,
      outcome,
      state: 'anchored',
      start: range[0],
      end: range[1],
      selector: selectorAt(after.text, range[0], range[1]),
    });
    const orphan = (cause: AnchorCause): AnchorResolution => ({
      id,
      outcome: was === 'anchored' ? 'orphaned' : 'still-orphaned',
      state: 'orphaned',
      start: null,
      end: null,
      selector,
      cause,
    });

    if (
      was === 'anchored' &&
      anchor.start !== null &&
      anchor.end !== null &&
      before.text.slice(anchor.start, anchor.end) === selector.quote
    ) {
      const proven = (): boolean =>
        provenUntouched(diffs, anchor.start as number, anchor.end as number);
      if (lostCopy(selector.quote) && !proven()) return orphan('ambiguous');
      const front = mapRange(diffs.forward, anchor.start, anchor.end);
      const back = mapBackward(diffs, anchor.start, anchor.end);
      if (front && back) {
        if (front[0] === back[0] && front[1] === back[1]) return placed(front, 'kept');
        return orphan('ambiguous');
      }
      if (front || back) {
        if (!diffs.exact) return orphan('diff_not_exact');
        if (twinsIn(before.text, selector) >= 2) return orphan('ambiguous');
        return placed((front ?? back) as [number, number], 'kept');
      }
    }
    if (!diffs.exact) return orphan('diff_not_exact');
    const rebound = rebind(after.text, diffs, selector);
    if ('range' in rebound) return placed(rebound.range, was === 'anchored' ? 'moved' : 'healed');
    return orphan(rebound.cause);
  });
  return { anchors: resolved, exact: diffs.exact };
}

/** What a reader, web or agent sends to say which text they mean. Context is optional. */
export interface SelectionInput {
  readonly quote: string;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
  /** iOS 0.6.2: 0-based index among the `seen` matches the reader was shown. Counted on the projection. */
  readonly occurrence?: number | undefined;
  readonly seen?: number | undefined;
  /**
   * Ranges of the projection that `occurrence` and `seen` do not count (a client that counted
   * the matches it showed left inline code out, so the count has to leave it out as well). The
   * quote may still be chosen by context inside one; this only changes what the two numbers mean.
   */
  readonly ignore?: ReadonlyArray<readonly [number, number]> | undefined;
}

export type SelectionResult =
  | {
      readonly ok: true;
      readonly start: number;
      readonly end: number;
      readonly selector: AnchorSelector;
    }
  | { readonly ok: false; readonly code: 'quote_not_found' | 'quote_moved' | 'invalid_selection' }
  | {
      readonly ok: false;
      readonly code: 'quote_ambiguous';
      /** The first few matches, not all of them. */
      readonly matches: ReadonlyArray<{
        readonly start: number;
        readonly end: number;
        readonly context: string;
      }>;
    };

const collapse = (s: string): string =>
  s.replace(/\s+/g, (run) => (run.split('\n').length > 2 ? BLOCK_SEPARATOR : ' '));

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n))
    n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n++;
  return n;
}

const SHOWN_MATCHES = 20;

/**
 * Finds the text a reader selected. A unique quote is accepted as is. A quote
 * that recurs is settled by the context sent with it: the single occurrence
 * that agrees with it longest wins, a tie is `quote_ambiguous`.
 */
export function resolveSelection(
  projection: Pick<TextProjection, 'text'>,
  input: SelectionInput,
): SelectionResult {
  const { text } = projection;
  const { occurrence, seen } = input;
  const counted = (n: number | undefined): boolean =>
    n === undefined || (Number.isInteger(n) && n >= 0);
  if (!counted(occurrence) || !counted(seen) || (occurrence === undefined) !== (seen === undefined))
    return { ok: false, code: 'invalid_selection' };
  const quote = normalizeText(input.quote);
  if (quote.length === 0) return { ok: false, code: 'quote_not_found' };
  const found = occurrences(text, quote, MAX_QUOTE_MATCHES);
  let hits = found.at;
  const ambiguous = (): SelectionResult => ({
    ok: false,
    code: 'quote_ambiguous',
    matches: hits.slice(0, SHOWN_MATCHES).map((at) => ({
      start: at,
      end: at + quote.length,
      context: text.slice(Math.max(0, at - 30), at + quote.length + 30).replace(/\n\n/g, ' | '),
    })),
  });
  if (hits.length === 0) return { ok: false, code: 'quote_not_found' };
  if (occurrence !== undefined && seen !== undefined) {
    const length = quote.length;
    const shown = input.ignore
      ? hits.filter((at) => !input.ignore?.some(([from, to]) => at < to && at + length > from))
      : hits;
    // Every match inside ignored text: nothing was counted, so there is nothing to disagree with.
    const pool = shown.length > 0 ? shown : hits;
    if (found.capped || seen !== pool.length || occurrence >= pool.length)
      return { ok: false, code: 'quote_moved' };
    hits = [pool[occurrence] as number];
  }
  let chosen = hits[0] as number;
  if (hits.length > 1 || found.capped) {
    if (found.capped) return ambiguous();
    const prefix = collapse(input.prefix ?? '')
      .slice(-ANCHOR_CONTEXT)
      .trimEnd();
    const suffix = collapse(input.suffix ?? '')
      .slice(0, ANCHOR_CONTEXT)
      .trimStart();
    let best = -1;
    let top: number[] = [];
    for (const at of hits) {
      const { before, after } = contextOf(text, at, at + quote.length);
      const score =
        commonSuffix(prefix, before.trimEnd()) + commonPrefix(suffix, after.trimStart());
      if (score > best) {
        best = score;
        top = [at];
      } else if (score === best) top.push(at);
    }
    if (top.length > 1 || best === 0) return ambiguous();
    chosen = top[0] as number;
  }
  return {
    ok: true,
    start: chosen,
    end: chosen + quote.length,
    selector: selectorAt(text, chosen, chosen + quote.length),
  };
}

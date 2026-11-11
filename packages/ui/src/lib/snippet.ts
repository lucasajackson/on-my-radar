/**
 * The part of a blip that answers "why did this match".
 *
 * A search result used to be a whole `BlipCard`. On a corpus with essays in it
 * that means one result can be two screens: `/search?q=radar` returned 52 blips
 * and the first was a ~700-word piece that filled the viewport and kept going —
 * you could not see the second result without scrolling past all of the first.
 *
 * Worse than the length: a blip can match on a word 600 words in and show you an
 * opening paragraph containing none of your query, so the only way to find out
 * why it matched was to read the whole thing.
 *
 * So a result is an excerpt taken from **around the match**, with the matched
 * words marked. Both halves matter — an excerpt with nothing highlighted still
 * makes you hunt, and a highlight in the wrong part of the body is no better
 * than none.
 *
 * ## Why segments rather than HTML
 *
 * `highlight` returns text segments and a flag, never a string of markup. The
 * caller renders `<mark>` elements from them. A search query is user input and a
 * blip body is user content, so building a highlighted string would mean
 * escaping both and then injecting tags — the exact ordering `lib/markdown.ts`
 * exists to get right, re-implemented in a second place for a convenience.
 * There is nothing to escape if nothing is ever parsed.
 */
import { plainText } from './markdown';

/** How much of the body to show, and how much of it to spend before the match. */
const WINDOW = 260;
const LEAD_IN = 70;

export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * The words worth highlighting, out of a raw query.
 *
 * `SearchResultDto.text` is already the free text with the `field:value` tokens
 * lifted out by the server, so this only has to deal with what a person types
 * around them: quoted phrases, and a leading `-` for exclusion.
 *
 * Excluded terms are dropped rather than highlighted. Marking a word that is the
 * reason a blip did *not* match would be actively misleading, and `-` is the one
 * operator where the query and the result disagree on purpose.
 */
export function highlightTerms(freeText: string): string[] {
  const terms: string[] = [];
  // Quoted phrases first, so an inner space does not split them.
  const quoted = /"([^"]+)"/g;
  let rest = freeText;
  for (const match of freeText.matchAll(quoted)) {
    if (match[1]) terms.push(match[1].trim());
  }
  rest = rest.replace(quoted, ' ');
  for (const word of rest.split(/\s+/)) {
    const clean = word.replace(/^[-+]/, '').replace(/[.,;:!?)("']+$/g, '');
    // One-character terms match nearly everything and turn a snippet into
    // confetti, which is less readable than no highlighting at all.
    if (clean.length >= 2 && !word.startsWith('-')) terms.push(clean);
  }
  return [...new Set(terms.map((t) => t.toLowerCase()))];
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every place a term occurs, merged so overlapping terms do not produce nested
 * or duplicated marks.
 */
function occurrences(haystack: string, terms: string[]): Array<[number, number]> {
  if (terms.length === 0) return [];
  /*
    Longest alternative first.

    A JS alternation takes the FIRST branch that matches, not the longest — so
    `radar|radars` matches only `radar` in "radars" and leaves the `s` outside
    the mark, which renders as a highlight that stops mid-word. Sorting by length
    is the whole fix and there is a test for it.
  */
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(ordered.map(escapeForRegex).join('|'), 'gi');
  const spans: Array<[number, number]> = [];
  for (const found of haystack.matchAll(pattern)) {
    if (found[0].length === 0) continue;
    spans.push([found.index, found.index + found[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** Nudge an index to the nearest word boundary, so a snippet never starts mid-word. */
function snapStart(text: string, at: number): number {
  if (at <= 0) return 0;
  const space = text.indexOf(' ', at);
  return space === -1 || space > at + 20 ? at : space + 1;
}

function snapEnd(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const space = text.lastIndexOf(' ', at);
  return space === -1 || space < at - 20 ? at : space;
}

export interface Snippet {
  readonly segments: readonly Segment[];
  /** True when the excerpt does not start at the beginning of the body. */
  readonly clippedStart: boolean;
  /** True when there is more body after the excerpt. */
  readonly clippedEnd: boolean;
  /** How many times the query occurs in the whole body, not just in the window. */
  readonly matches: number;
}

/**
 * An excerpt around the first match, with the matched words marked.
 *
 * Falls back to the head of the body when nothing matches — which happens
 * legitimately: a blip can be in the results because of a `tag:` or `from:`
 * filter with no free text at all, or because Postgres stemmed a word into a
 * form the literal search here does not see. A snippet with no highlight is the
 * right answer there; refusing to draw one would leave the result blank.
 */
export function snippetFor(body: string, freeText: string, title?: string | null): Snippet {
  /*
    The title is dropped off the front when the body opens with it.

    A blip's title is derived from a real markdown heading, so on a titled blip
    the first line of the body *is* the title — and rendering both put the same
    words on screen twice, one above the other. That is the exact defect
    `createBlip` was corrected for when it derived a title from the first
    sentence; this is the same mistake at the other end of the pipe.

    Only when it is a genuine prefix. A body that merely mentions its own title
    later on is not the case being fixed here.
  */
  let text = plainText(body, Number.MAX_SAFE_INTEGER);
  const heading = title?.trim();
  if (heading && text.toLowerCase().startsWith(heading.toLowerCase())) {
    text = text.slice(heading.length).replace(/^[\s.:—–-]+/, '');
  }
  const terms = highlightTerms(freeText);
  const all = occurrences(text, terms);

  const firstAt = all[0]?.[0] ?? 0;
  const rawStart = Math.max(0, firstAt - LEAD_IN);
  const start = snapStart(text, rawStart);
  const end = snapEnd(text, Math.min(text.length, start + WINDOW));
  const window = text.slice(start, end);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [from, to] of all) {
    if (to <= start || from >= end) continue;
    const localFrom = Math.max(from - start, 0);
    const localTo = Math.min(to - start, window.length);
    if (localFrom > cursor) segments.push({ text: window.slice(cursor, localFrom), match: false });
    segments.push({ text: window.slice(localFrom, localTo), match: true });
    cursor = localTo;
  }
  if (cursor < window.length) segments.push({ text: window.slice(cursor), match: false });

  return {
    segments: segments.length > 0 ? segments : [{ text: window, match: false }],
    clippedStart: start > 0,
    clippedEnd: end < text.length,
    matches: all.length,
  };
}

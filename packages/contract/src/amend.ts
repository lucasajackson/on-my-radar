/**
 * Amendment markers: how an ADR is anchored to the text it amends.
 *
 *     :amend[quote]{adr=<uuid> with="replacement"}
 *
 * The marker lives in the page's markdown source and is written when the ADR is
 * proposed, so the anchor cannot drift before the decision. The quoted text is
 * never deleted: whether it shows struck, highlighted or plain is computed from
 * the ADR's lane at read time. A second ADR amending the exact same span stacks
 * a group after the first: `{adr=A …}{adr=B …}`.
 *
 * Pure and dependency-free, so the server, the SPA and any other client share
 * one parser. Markers inside code fences, code spans and link targets are not
 * markers, and text there can never be a quote.
 */

import { bodyWithoutTitleHeading, headingTitle } from './text.js';

export const AMEND_LIMITS = { quote: 400, with: 600, anchorsPerAdr: 10 } as const;

/** The charter document (one per Architecture radar) and what may point into it. */
export const CHARTER_LIMITS = {
  document: 400_000,
  anchorsPerRadar: 2_000,
  note: 500,
  editsPerCall: 50,
  /** The longest passage a link may tie to an element (an ADR's is `AMEND_LIMITS.quote`). */
  linkQuote: 4_000,
} as const;

export interface AmendLayer {
  readonly adr: string;
  readonly with: string;
}

export interface AmendMarker {
  /** Whole marker in the source, `:amend[` through the last `}`. */
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  /** Offset of the quote text, so a search hit can be compared with it. */
  readonly quoteStart: number;
  readonly layers: readonly AmendLayer[];
}

export type AmendView = 'written' | 'amended' | 'source';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LAYER = `\\{adr=(${UUID}) with="((?:[^"\\\\\\n]|\\\\.)*)"\\}`;
const SCAN = new RegExp(
  `(:amend\\[([^\\[\\]\\n\`|]*)\\]((?:${LAYER})+))|(\`[^\`\\n]*\`)|(\\]\\([^)\\s]*\\))`,
  'g',
);
const LAYERS = new RegExp(LAYER, 'g');

export const escapeWith = (text: string): string => text.replace(/[\\"|]/g, (c) => `\\${c}`);
const unescapeWith = (text: string): string => text.replace(/\\(.)/g, '$1');

/** What is wrong with a quote or replacement as typed, or null. */
export function quoteProblem(quote: string): string | null {
  if (!quote.trim()) return 'The quote is empty.';
  if (quote.length > AMEND_LIMITS.quote)
    return `A quote is at most ${AMEND_LIMITS.quote} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[[\]|`\u0000-\u001f]/.test(quote))
    return 'A quote is one line of plain text: no [ ] | ` or line breaks. Select less.';
  return null;
}

export function withProblem(replacement: string): string | null {
  if (replacement.length > AMEND_LIMITS.with)
    return `A replacement is at most ${AMEND_LIMITS.with} characters.`;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/.test(replacement) ? 'A replacement is one line.' : null;
}

export function serializeLayer(layer: AmendLayer): string {
  return `{adr=${layer.adr} with="${escapeWith(layer.with)}"}`;
}

/** Line ranges of fenced code, which neither holds markers nor can be quoted. */
function fenced(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open = -1;
  let at = 0;
  for (const line of source.split('\n')) {
    const end = at + line.length;
    if (/^\s*```/.test(line)) {
      if (open < 0) open = at;
      else {
        ranges.push([open, end]);
        open = -1;
      }
    }
    at = end + 1;
  }
  if (open >= 0) ranges.push([open, source.length]);
  return ranges;
}

/**
 * Markers in a page, plus a same-length copy of the source in which everything
 * that cannot be quoted is blanked: code and link targets as `\u0000`, marker
 * syntax and replacement text as `\u0001`. A marker's own quote stays visible.
 */
export function scanMarkers(source: string): { markers: AmendMarker[]; mask: string } {
  const blocked = fenced(source);
  const chars = source.split('');
  const blank = (from: number, to: number, ch: string) => {
    for (let i = from; i < to; i += 1) if (chars[i] !== '\n') chars[i] = ch;
  };
  for (const [from, to] of blocked) blank(from, to, '\u0000');
  const markers: AmendMarker[] = [];
  for (const m of source.matchAll(SCAN)) {
    const start = m.index;
    if (blocked.some(([from, to]) => start >= from && start < to)) continue;
    if (m[1] === undefined) {
      blank(start, start + m[0].length, '\u0000');
      continue;
    }
    const quote = m[2] ?? '';
    const quoteStart = start + 7;
    blank(start, quoteStart, '\u0001');
    blank(quoteStart + quote.length, start + m[0].length, '\u0001');
    markers.push({
      start,
      end: start + m[0].length,
      quote,
      quoteStart,
      layers: [...(m[3] ?? '').matchAll(LAYERS)].map((l) => ({
        adr: l[1] ?? '',
        with: unescapeWith(l[2] ?? ''),
      })),
    });
  }
  return { markers, mask: chars.join('') };
}

export const parseMarkers = (source: string): AmendMarker[] => scanMarkers(source).markers;

/** Rebuild a page with each marker replaced by `render(marker)`. */
export function replaceMarkers(source: string, render: (marker: AmendMarker) => string): string {
  let out = '';
  let at = 0;
  for (const marker of parseMarkers(source)) {
    out += source.slice(at, marker.start) + render(marker);
    at = marker.end;
  }
  return out + source.slice(at);
}

/** A page's markers as comparable text. Positions are left out: prose edits move them. */
export const markerKey = (source: string): string =>
  JSON.stringify(parseMarkers(source).map((m) => [m.quote, m.layers]));

/**
 * The lanes in which an ADR's marker locks the text it quotes: Proposed (open) and Accepted (in
 * force). A Rejected ADR never took effect and a Repealed one no longer does, so the text reads
 * as it was written and its marker is inert: it can be edited out like any other text. (A repeal
 * keeps nothing of the replacement; that lives only in the marker.)
 */
export const LIVE_ADR_LANES = ['proposed', 'accepted'] as const;

/**
 * A marker as a whole: its quote and every layer in order, serialised. Layers are never counted
 * apart from the marker that holds them, so merging two markers into one with two layers, or
 * splitting one into two, changes the form.
 */
const forms = (source: string) =>
  parseMarkers(source).map((m) => ({
    key: JSON.stringify([m.quote, m.layers.map((l) => [l.adr, l.with])]),
    adrs: [...new Set(m.layers.map((l) => l.adr))],
  }));

/** How many markers have each whole form: two identical markers are two, and the page keeps two. */
const tally = (source: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const { key } of forms(source)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

/**
 * The live ADRs (those in `live`; every ADR when it is left out) of a marker that `after` no longer
 * carries exactly as `before` has it, layers and all. A page edit may change anything around the
 * markers, never a marker that holds a live ADR. A marker of inert ADRs only may be edited out.
 */
export function brokenAnchors(before: string, after: string, live?: ReadonlySet<string>): string[] {
  const kept = tally(after);
  const seen = new Map<string, number>();
  const broken = new Set<string>();
  for (const { adrs, key } of forms(before)) {
    // The nth marker of a form in `before` needs an nth in `after`.
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n <= (kept.get(key) ?? 0)) continue;
    for (const adr of adrs) if (live ? live.has(adr) : true) broken.add(adr);
  }
  return [...broken];
}

/** Whether `after` carries a marker, in any form, that `before` did not: markers are written by `propose_adr` only. */
export function addsMarker(before: string, after: string): boolean {
  const had = tally(before);
  return [...tally(after)].some(([key, count]) => count > (had.get(key) ?? 0));
}

/**
 * A charter page as it is stored: `# title` first, then the text. A leading heading that already
 * is the title is not written twice. Shared so the form can check an edit against the anchors
 * before sending the same markdown the server will keep.
 */
export function charterPageMarkdown(title: string, body: string): string {
  const text = (headingTitle(body) === title ? bodyWithoutTitleHeading(body, title) : body).trim();
  return text ? `# ${title}\n\n${text}` : `# ${title}`;
}

export function markersOf(source: string, adr: string): AmendMarker[] {
  return parseMarkers(source).filter((m) => m.layers.some((l) => l.adr === adr));
}

/**
 * The text a reader gets for a marker. `inForce` says whether an ADR currently
 * amends the text (accepted); the last such layer wins, otherwise the original.
 */
export function resolveMarker(
  marker: AmendMarker,
  view: AmendView,
  inForce: (adr: string) => boolean,
): string {
  if (view !== 'amended') return marker.quote;
  const live = marker.layers.filter((l) => inForce(l.adr));
  return live.length > 0 ? (live[live.length - 1] as AmendLayer).with : marker.quote;
}

export const resolvePage = (
  source: string,
  view: AmendView,
  inForce: (adr: string) => boolean,
): string =>
  view === 'source' ? source : replaceMarkers(source, (m) => resolveMarker(m, view, inForce));

export interface QuoteMatch {
  readonly pageId: string;
  readonly at: number;
  /** Set when the quote is exactly an existing marker's quote: a second layer stacks. */
  readonly stack: AmendMarker | null;
}

export type QuoteRefusal =
  | { code: 'quote_not_found' | 'quote_moved'; message: string }
  | {
      code: 'quote_ambiguous';
      message: string;
      matches: Array<{ pageId: string; context: string }>;
    }
  | { code: 'quote_overlaps' | 'quote_in_amendment'; message: string; adr: string };

/** A short plain-text neighbourhood of a hit: markdown punctuation and table pipes dropped. */
const around = (text: string, at: number, length: number): string =>
  text
    .slice(Math.max(0, at - 30), at + length + 30)
    // eslint-disable-next-line no-control-regex
    .replace(/[\n\u0000\u0001|*_#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface QuoteContext {
  /** Which match the reader selected: 0-based among the quote's matches in that page as rendered. */
  readonly occurrence?: number | undefined;
  /** How many matches the reader saw, so a page that changed since is refused rather than guessed at. */
  readonly seen?: number | undefined;
}

/** Spans of `text` a reader never sees: link targets and the opening line of a fenced block. */
function unseen(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(/\]\([^)\s]*\)|^[ \t]*(?:```|~~~)[^\n]*$/gm))
    spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Find a quote exactly once. `pageId` narrows the search to one page. When the
 * phrase recurs there, `context` names the one the reader selected by its index
 * among the matches they saw; the count must still agree with the page, or the
 * text changed under them (`quote_moved`). Without it a recurring phrase is
 * `quote_ambiguous`.
 */
export function findQuote(
  pages: ReadonlyArray<{ id: string; markdown: string }>,
  quote: string,
  pageId?: string,
  context?: QuoteContext,
): QuoteMatch | QuoteRefusal {
  const problem = quoteProblem(quote);
  if (problem) return { code: 'quote_not_found', message: problem };
  const scoped = pageId ? pages.filter((p) => p.id === pageId) : pages;
  const hits: Array<QuoteMatch & { context: string; marker: AmendMarker | null; hidden: boolean }> =
    [];
  for (const page of scoped) {
    const { markers, mask } = scanMarkers(page.markdown);
    const skip = unseen(mask);
    for (let at = mask.indexOf(quote); at >= 0; at = mask.indexOf(quote, at + 1)) {
      const marker =
        markers.find(
          (m) => at < m.quoteStart + m.quote.length && at + quote.length > m.quoteStart,
        ) ?? null;
      const exact = marker && marker.quoteStart === at && marker.quote === quote ? marker : null;
      hits.push({
        pageId: page.id,
        at,
        stack: exact,
        marker,
        hidden: skip.some(([from, to]) => at >= from && at < to),
        context: around(mask, at, quote.length),
      });
    }
  }
  if (pageId && context?.occurrence !== undefined && context.seen !== undefined) {
    const shown = hits.filter((h) => !h.hidden);
    if (shown.length > 0) {
      if (shown.length !== context.seen || context.occurrence >= shown.length)
        return {
          code: 'quote_moved',
          message: 'The text changed since you selected it. Select it again.',
        };
      hits.splice(0, hits.length, ...shown.slice(context.occurrence, context.occurrence + 1));
    }
  }
  if (hits.length > 1)
    return {
      code: 'quote_ambiguous',
      message: `That quote appears ${hits.length} times. Select more text, or pass pageId.`,
      matches: hits.map(({ pageId: id, context: where }) => ({ pageId: id, context: where })),
    };
  const [hit] = hits;
  if (hit?.marker && !hit.stack) {
    const adr = (hit.marker.layers[hit.marker.layers.length - 1] as AmendLayer).adr;
    return {
      code: 'quote_overlaps',
      adr,
      message: `That text is already part of an amendment (${adr}). Select the whole amended span and supersede that ADR.`,
    };
  }
  if (hit) return { pageId: hit.pageId, at: hit.at, stack: hit.stack };
  for (const page of scoped)
    for (const marker of parseMarkers(page.markdown)) {
      const layer = marker.layers.find((l) => l.with.includes(quote));
      if (layer)
        return {
          code: 'quote_in_amendment',
          adr: layer.adr,
          message: `That text is replacement text from ${layer.adr}. Supersede that ADR to change it.`,
        };
    }
  return {
    code: 'quote_not_found',
    message: 'That text is not in the charter, exactly as quoted.',
  };
}

/** The page source with `layer` anchored at `match`. */
export function anchorQuote(
  source: string,
  quote: string,
  match: QuoteMatch,
  layer: AmendLayer,
): string {
  if (match.stack)
    return source.slice(0, match.stack.end) + serializeLayer(layer) + source.slice(match.stack.end);
  return `${source.slice(0, match.at)}:amend[${quote}]${serializeLayer(layer)}${source.slice(match.at + quote.length)}`;
}

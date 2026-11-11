/**
 * The charter document and its anchors, with no database: how a version's text is drawn for a
 * reader, and how today's pages and markers become one document and its anchors. Pure, so the
 * migration and the three views can be tested on Commander's real pages without a server.
 */
import { createHash } from 'node:crypto';
import {
  blockAt,
  parseMarkers,
  projectMarkdown,
  replaceMarkers,
  scanMarkers,
  selectorAt,
  serializeLayer,
  type AnchorSelector,
  type AmendLayer,
  type TextProjection,
} from '@onmyradar/contract';

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/* ------------------------------- projections ------------------------------- */

const CACHE_SIZE = 8;
const cache = new Map<string, TextProjection>();

/**
 * The projection of a text, kept by its hash: a save diffs the old text against the new, and the
 * old one is the head every previous save and read already projected. Projecting 94,000
 * characters is the expensive step (tens of milliseconds); looking it up is free.
 */
export function projectionOf(body: string, hash: string = sha256(body)): TextProjection {
  const hit = cache.get(hash);
  if (hit) {
    cache.delete(hash);
    cache.set(hash, hit);
    return hit;
  }
  const made = projectMarkdown(body);
  cache.set(hash, made);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return made;
}

/* ---------------------------------- views ---------------------------------- */

export interface RenderAnchor {
  readonly adr: string;
  readonly with: string;
  readonly start: number;
  readonly end: number;
}

/** A range of the projection that cuts an inline code span open (a span it holds whole is fine). */
export function cutsCode(projection: Pick<TextProjection, 'code'>, start: number, end: number) {
  return projection.code.some(
    ([from, to]) => start < to && end > from && !(start <= from && end >= to),
  );
}

interface Group {
  readonly start: number;
  readonly end: number;
  readonly layers: AmendLayer[];
}

/**
 * Anchors that share a span become one group (the layers stack in the order given); a group that
 * overlaps an earlier one, or cuts inline code open, is left out of the drawing.
 */
function groupAnchors(projection: TextProjection, anchors: readonly RenderAnchor[]): Group[] {
  const bySpan = new Map<string, Group>();
  for (const a of anchors) {
    const key = `${a.start}:${a.end}`;
    const group = bySpan.get(key) ?? { start: a.start, end: a.end, layers: [] };
    group.layers.push({ adr: a.adr, with: a.with });
    bySpan.set(key, group);
  }
  const groups = [...bySpan.values()].sort((x, y) => x.start - y.start || x.end - y.end);
  const kept: Group[] = [];
  for (const g of groups) {
    const last = kept[kept.length - 1];
    if (last && g.start < last.end) continue;
    if (cutsCode(projection, g.start, g.end)) continue;
    kept.push(g);
  }
  return kept;
}

/** A quote the old marker syntax can carry: one line, none of `[ ] | ``. */
// eslint-disable-next-line no-control-regex
const MARKER_SAFE = /^[^[\]|`\u0000-\u001f]+$/;
/** Pieces of the marker grammar; text carrying one is never drawn as a marker's quote. */
const GRAMMAR = /:amend|\{adr=/;

/**
 * The charter for a reader.
 *
 * - `written`: the stored text.
 * - `amended`: each span whose newest layer in force (`inForce`) replaces it is replaced.
 * - `source`: for clients that draw the strikes themselves (the current UI, iOS 0.6.2): the text
 *   with a `:amend[quote]{adr=… with="…"}` marker synthesized around each anchored span of a live
 *   (Proposed or Accepted) ADR whose source is a legal marker quote. Marker syntax typed into the
 *   text, whole or in pieces, is neutralised, so only anchors the server wrote can ever be drawn
 *   as amendments. Only live anchors compete for a span: a rejected one never hides another.
 */
export function renderCharter(
  body: string,
  anchors: readonly RenderAnchor[],
  view: 'written' | 'amended' | 'source',
  inForce: (adr: string) => boolean,
  projection: TextProjection = projectionOf(body),
  /** Whether an ADR is Proposed or Accepted. Anchors of any other ADR are not drawn and do not compete. */
  live: (adr: string) => boolean = () => true,
): string {
  if (view === 'written') return body;
  const edits: Array<{ from: number; to: number; text: string }> = [];
  if (view === 'source') {
    // The marker grammar is what the current UI and iOS 0.6.2 parse, so nothing the writer typed
    // may take part in it. Complete markers lose their `[`; so does every loose piece of the
    // grammar outside code (`:amend[`, `]{`, `{adr=`), or a bare `{adr=… with="…"}` beside a
    // genuine marker would join it as another layer. `\` before the bracket reads as the
    // bracket in markdown.
    const { markers, mask } = scanMarkers(body);
    const escapes = new Set<number>();
    for (const m of markers) escapes.add(m.start + 6);
    for (const f of mask.matchAll(/:amend(?=\[)|\](?=\{)/g)) escapes.add(f.index + f[0].length);
    for (const f of mask.matchAll(/\{(?=adr=)/g)) escapes.add(f.index);
    for (const at of escapes) edits.push({ from: at, to: at, text: '\\' });
  }
  const competing = anchors.filter((a) => (view === 'amended' ? inForce(a.adr) : live(a.adr)));
  for (const g of groupAnchors(projection, competing)) {
    const [from, to] = projection.sourceRange(g.start, g.end);
    if (view === 'amended') {
      const shown = g.layers.filter((l) => inForce(l.adr));
      const last = shown[shown.length - 1];
      if (!last) continue;
      const cell = blockAt(projection, g.start)?.kind === 'cell';
      edits.push({ from, to, text: cell ? last.with.replace(/\|/g, '\\|') : last.with });
    } else {
      const quote = body.slice(from, to);
      if (!MARKER_SAFE.test(quote) || GRAMMAR.test(quote)) continue;
      edits.push({ from, to, text: `:amend[${quote}]${g.layers.map(serializeLayer).join('')}` });
    }
  }
  let out = body;
  for (const e of edits.sort((x, y) => y.from - x.from || y.to - x.to))
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

/* -------------------------------- migration -------------------------------- */

export interface PagePlanInput {
  readonly id: string;
  readonly body: string;
}

export interface PlannedAnchor {
  readonly adr: string;
  readonly with: string;
  readonly selector: AnchorSelector;
  readonly start: number;
  readonly end: number;
  /** Which page the marker was on, for the report. */
  readonly pageId: string;
}

export type MigrationPlan =
  | { ok: true; body: string; anchors: PlannedAnchor[]; pages: number }
  | { ok: false; reason: string };

/**
 * Today's pages and markers as one document and its anchors.
 *
 * The pages are joined with a blank line, each with its markers reduced to their quote, so the
 * text is exactly what "as written" shows. Each marker layer becomes one anchor at the one place
 * in the projection whose source lies inside the marker's own quote; none, or more than one, and
 * the radar is refused (it is left untouched, and the report says why). `adrs` is the set of ids
 * of ADRs on the radar: a layer that names anything else is refused as well.
 */
export function planMigration(
  pages: readonly PagePlanInput[],
  adrs: ReadonlySet<string>,
  maxLength = 400_000,
): MigrationPlan {
  const spans: Array<{
    pageId: string;
    start: number;
    end: number;
    quote: string;
    layers: AmendLayer[];
  }> = [];
  const parts: string[] = [];
  let length = 0;
  for (const page of pages) {
    const base = length + (parts.length > 0 ? 2 : 0);
    let out = '';
    let at = 0;
    for (const m of parseMarkers(page.body)) {
      out += page.body.slice(at, m.start);
      spans.push({
        pageId: page.id,
        start: base + out.length,
        end: base + out.length + m.quote.length,
        quote: m.quote,
        layers: [...m.layers],
      });
      out += m.quote;
      at = m.end;
    }
    out += page.body.slice(at);
    // Same text a reader gets from replaceMarkers; kept as a cross-check of the loop above.
    if (out !== replaceMarkers(page.body, (m) => m.quote))
      return { ok: false, reason: `page ${page.id} could not be reduced to its written text` };
    parts.push(out);
    length = base + out.length;
  }
  const body = parts.join('\n\n');
  if (body.length > maxLength)
    return {
      ok: false,
      reason: `the charter is ${body.length} characters; a document holds ${maxLength}`,
    };
  const projection = projectMarkdown(body);
  const anchors: PlannedAnchor[] = [];
  for (const span of spans) {
    const named = span.layers.find((l) => !adrs.has(l.adr));
    if (named)
      return {
        ok: false,
        reason: `a marker names ${named.adr}, which is not an ADR of this radar`,
      };
    const words = projectMarkdown(span.quote).text;
    if (words.length === 0)
      return { ok: false, reason: `the marked text "${span.quote.slice(0, 40)}" has no words` };
    const fits: Array<[number, number]> = [];
    for (
      let i = projection.text.indexOf(words);
      i >= 0;
      i = projection.text.indexOf(words, i + 1)
    ) {
      const [from, to] = projection.sourceRange(i, i + words.length);
      if (from >= span.start && to <= span.end) fits.push([i, i + words.length]);
      if (fits.length > 1) break;
    }
    const [hit] = fits;
    if (fits.length !== 1 || !hit)
      return {
        ok: false,
        reason: `the marked text "${span.quote.slice(0, 40)}" is ${fits.length === 0 ? 'not found in' : 'found twice inside'} its own place in the projection`,
      };
    for (const layer of span.layers)
      anchors.push({
        adr: layer.adr,
        with: layer.with,
        selector: selectorAt(projection.text, hit[0], hit[1]),
        start: hit[0],
        end: hit[1],
        pageId: span.pageId,
      });
  }
  return { ok: true, body, anchors, pages: pages.length };
}

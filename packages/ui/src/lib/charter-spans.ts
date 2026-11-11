/**
 * Where the amendments sit in the charter's text, for drawing them in the editor.
 *
 * The reading view (`view=source`) says where each amendment is with a marker in the text it is
 * given. That is only a transport: the stored charter never holds one. Here the markers are
 * read, taken out, and each one's place is found again in the plain-text projection the server
 * anchors against (`projectMarkdown`), so the editor can underline it without writing anything
 * into the document.
 */
import { normalizeText, parseMarkers, projectMarkdown, replaceMarkers } from '@onmyradar/contract';

export interface AnchorSpan {
  /** Offsets into the projection's `text`, end exclusive. */
  start: number;
  end: number;
  /** The ADRs that amend this span, oldest layer first. */
  adrs: string[];
}

export interface AnchorMap {
  /** The charter as it is stored: the source with every marker taken out. */
  written: string;
  /** The projection's text; `spans` index into it. */
  text: string;
  spans: AnchorSpan[];
}

/** The most occurrences of one quote looked at; a quote that recurs more often is not drawn. */
const MAX_CANDIDATES = 1000;

export function anchorMap(source: string): AnchorMap {
  const markers = parseMarkers(source);
  const written = replaceMarkers(source, (m) => m.quote);
  const projection = projectMarkdown(written);
  const spans: AnchorSpan[] = [];
  let removed = 0;
  for (const marker of markers) {
    // Where the quote starts in `written`: the markup before it has been taken out.
    const at = marker.start - removed;
    removed += marker.end - marker.start - marker.quote.length;
    const quote = normalizeText(marker.quote);
    if (quote.length === 0) continue;
    // The occurrence whose place in the source is nearest where the marker stood.
    let best = -1;
    let gap = Number.POSITIVE_INFINITY;
    let seen = 0;
    for (
      let from = projection.text.indexOf(quote);
      from >= 0 && seen < MAX_CANDIDATES;
      from = projection.text.indexOf(quote, from + 1)
    ) {
      seen += 1;
      const near = Math.abs(projection.sourceRange(from, from + quote.length)[0] - at);
      if (near < gap) {
        gap = near;
        best = from;
      }
    }
    if (best >= 0)
      spans.push({
        start: best,
        end: best + quote.length,
        adrs: marker.layers.map((l) => l.adr),
      });
  }
  return { written, text: projection.text, spans };
}

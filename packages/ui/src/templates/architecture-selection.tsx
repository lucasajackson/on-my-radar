/**
 * Selecting text in the charter: what the selection is, and the toolbar that offers to act on it.
 *
 * Today's charter (stored markers) anchors an ADR on one run of plain text that the page's source
 * holds literally, so everything here is about finding that run, or saying in words why there is
 * not one. The toolbar carries the reason itself: it is never a second thing drawn over the text.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { findQuote } from '@onmyradar/contract';
import type { LinkSelection } from './architecture-link-selection';

export interface Selected {
  quote: string;
  pageId: string | null;
  /** Which match of the quote the reader selected, and how many the page shows (see `findQuote`). */
  occurrence?: number;
  seen?: number;
  /** Up to 64 characters of the paragraph before and after the quote, to tell it from a twin. */
  prefix?: string;
  suffix?: string;
  /** Why this selection cannot be amended, in words for the reader. */
  refusal?: string;
  /** Set when the selection ran into code and was narrowed to the prose beside it. */
  narrowed?: boolean;
  /** The text selected (the prose, when it ran into code), kept to show it while the panel is open. */
  range?: Range;
  /** The same selection as a link reads it (the words, across paragraphs); null where it holds none. */
  link?: LinkSelection;
  /** The selection's rectangle in the viewport. */
  x: number;
  y: number;
  bottom: number;
}

/**
 * A page's text as the reader sees it, for counting a quote's matches. Each run
 * of text is joined to the next by a U+FFFC, and ADR labels and code are left
 * out (their place is a U+FFFC too): the server blanks code, marker syntax and
 * link targets with characters no quote can hold (`scanMarkers`), so a quote
 * never matches across markup or inside code. Concatenating `textContent`
 * would join "the " and a bold "billing" into a match the server does not see.
 */
export const seenText = (from: Node | Range): string => {
  const box = document.createElement('div');
  box.append(from instanceof Range ? from.cloneContents() : from.cloneNode(true));
  const runs: string[] = [];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.parentElement?.closest('.amend-ref, code, pre')) runs.push(node.textContent ?? '');
  return runs.join('￼');
};

/** Elements whose text the server's plain-text projection separates with a blank line. */
const BLOCK_SELECTOR = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote';
const BREAK = '\u0001';

/**
 * The page's text inside `range`, with a blank line wherever it passes from one block to the
 * next, as the server's projection writes it (a cut through the middle of a block is not a break).
 */
function textIn(page: HTMLElement, range: Range): string {
  let out = '';
  let last: Element | null = null;
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const text = node.textContent ?? '';
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : text.length;
    const piece = text.slice(from, to);
    if (!piece) continue;
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (last && block !== last) out += BREAK;
    out += piece;
    last = block;
  }
  return out.replace(/\s+/g, ' ').replaceAll(` ${BREAK} `, '\n\n').replaceAll(BREAK, '\n\n');
}

/**
 * The words either side of a selection (up to 64 characters, across block boundaries, which the
 * text marks as the server does) so a quote that is in the charter twice can be told apart: the
 * same sentence under two different headings is two quotes. Read when the selection is acted on,
 * not as it is dragged: it walks the page either side of it.
 */
export function selectionContext(range: Range): Pick<Selected, 'prefix' | 'suffix'> {
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const page = start?.closest<HTMLElement>('[data-page-id]');
  if (!page) return {};
  const before = document.createRange();
  before.setStart(page, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(page, page.childNodes.length);
  const prefix = textIn(page, before).slice(-CONTEXT);
  const suffix = textIn(page, after).slice(0, CONTEXT);
  return { ...(prefix.trim() ? { prefix } : {}), ...(suffix.trim() ? { suffix } : {}) };
}
/** What the server compares: it reads up to this many characters either side. */
const CONTEXT = 64;

/** Which of the quote's matches in the rendered page this selection is, and how many there are. */
function occurrenceOf(
  page: HTMLElement,
  range: Range,
  quote: string,
): Pick<Selected, 'occurrence' | 'seen'> {
  const before = document.createRange();
  before.selectNodeContents(page);
  before.setEnd(range.startContainer, range.startOffset);
  const start = seenText(before).length;
  const whole = seenText(page);
  const starts: number[] = [];
  for (let at = whole.indexOf(quote); at >= 0; at = whole.indexOf(quote, at + 1)) starts.push(at);
  const occurrence = starts.findIndex((at) => at >= start);
  return starts.length === 0 || occurrence < 0 ? {} : { occurrence, seen: starts.length };
}

const CODE_REFUSAL = "Code can't be anchored. Select the sentence around it.";
const SPANS_REFUSAL =
  'That selection crosses formatting such as bold, a link or a line break. Select plain text within one run.';
const LITERAL_REFUSAL =
  'That text is not in the charter exactly as selected. Select plain text from the page.';

/** Whether more than one run of text (a text node) has characters inside the range. */
function spansRuns(page: HTMLElement, range: Range): boolean {
  let held = 0;
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : (node.textContent?.length ?? 0);
    if (to > from) held += 1;
  }
  return held > 1;
}

/**
 * The longest run of plain prose inside a selection that touches code: each text node outside
 * code, cut to the selection and trimmed. A selection of a sentence and the `identifier` in the
 * middle of it anchors on the sentence's longer half, which is what the reader meant to point at;
 * code itself cannot be anchored.
 */
function longestProse(page: HTMLElement, range: Range): { range: Range; text: string } | null {
  let best: { node: Text; from: number; to: number } | null = null;
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || node.parentElement?.closest('code, pre, .amend-ref'))
      continue;
    const text = node.textContent ?? '';
    let from = node === range.startContainer ? range.startOffset : 0;
    let to = node === range.endContainer ? range.endOffset : text.length;
    while (from < to && /\s/.test(text[from] ?? '')) from += 1;
    while (to > from && /\s/.test(text[to - 1] ?? '')) to -= 1;
    if (to > from && to - from > (best ? best.to - best.from : 0))
      best = { node: node as Text, from, to };
  }
  if (!best) return null;
  const run = document.createRange();
  run.setStart(best.node, best.from);
  run.setEnd(best.node, best.to);
  return { range: run, text: best.node.textContent.slice(best.from, best.to) };
}

/** The selection's rectangle, in the shape `Selected` carries it. */
export function selectionRect(): Pick<Selected, 'x' | 'y' | 'bottom'> | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const box = selection.getRangeAt(0).getBoundingClientRect();
  return { x: box.left, y: box.top, bottom: box.bottom };
}

/**
 * The selection, when it sits inside one charter page. A quote is amendable only
 * when it is one run of plain text that the page's source holds literally (as
 * `findQuote` reads it): anything else would be anchored where the reader did
 * not select, so it is refused here, in words, before anything is sent. A selection that
 * runs into code is narrowed to the prose beside the code; one that is only code is refused.
 */
export function pageSelection(
  root: HTMLElement | null,
  charter: ReadonlyArray<{ id: string; markdown: string }>,
): Selected | null {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const page = range.commonAncestorContainer.parentElement?.closest<HTMLElement>('[data-page-id]');
  const selected = selection.toString().trim();
  if (!page || !root.contains(page) || !selected) return null;
  const box = range.getBoundingClientRect();
  const pageId = page.dataset['pageId'] ?? null;
  const base = { pageId, x: box.left, y: box.top, bottom: box.bottom };
  let from = range;
  let quote = selected;
  let narrowed = false;
  if ([...page.querySelectorAll('code, pre')].some((el) => range.intersectsNode(el))) {
    const prose = longestProse(page, range);
    if (!prose) return { ...base, quote: selected, refusal: CODE_REFUSAL };
    from = prose.range;
    quote = prose.text;
    narrowed = true;
  } else if (spansRuns(page, range)) return { ...base, quote, refusal: SPANS_REFUSAL };
  const where = occurrenceOf(page, from, quote);
  const hit = findQuote(charter, quote, pageId ?? undefined, where);
  if ('code' in hit && (hit.code === 'quote_not_found' || hit.code === 'quote_moved'))
    return { ...base, quote, refusal: LITERAL_REFUSAL };
  return {
    ...base,
    quote,
    range: from.cloneRange(),
    ...where,
    ...(narrowed ? { narrowed } : {}),
  };
}

/** Space kept between the toolbar and the selection, and between it and the sticky chrome. */
const GAP = 8;

/**
 * The selection toolbar. From 1024px it floats at the selection (above it, or below when there is
 * no room above the sticky header and tab bar); below that it docks at the foot of the scroll
 * pane, which is directly above the phone's tab bar. When there is nothing to do with the
 * selection its action is disabled and the reason is a line inside the same box.
 */
export function SelectionBar({
  selected,
  written,
  onPropose,
  onShowWritten,
  extra,
  takeover,
}: {
  selected: Selected;
  /** The charter is showing As written, which is where an amendment is made. */
  written: boolean;
  onPropose: () => void;
  onShowWritten: () => void;
  /** More actions on the selection, after Propose ADR (linking it to the map). */
  extra?: ReactNode;
  /** Something that works on the selection in the bar's place (the link picker, re-anchoring). */
  takeover?: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const bar = node.current;
    if (!bar) return;
    const measure = () => {
      if (getComputedStyle(bar).position !== 'fixed') {
        setPlace(null);
        return;
      }
      const { height, width } = bar.getBoundingClientRect();
      // What is stuck to the top of the pane: the radar header, then the tab bar.
      const clear =
        (document.querySelector('.arch-bar')?.getBoundingClientRect().bottom ?? 0) + GAP;
      const above = selected.y - height - GAP;
      const top =
        above >= clear
          ? above
          : Math.min(selected.bottom + GAP, Math.max(clear, window.innerHeight - height - GAP));
      const left = Math.min(Math.max(GAP, selected.x), window.innerWidth - width - GAP);
      const next = { top: Math.round(top), left: Math.round(left) };
      setPlace((now) => (now?.top === next.top && now.left === next.left ? now : next));
    };
    measure();
    // The picker grows and shrinks as it is typed in; the bar stays against the selection.
    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watcher?.observe(bar);
    return () => watcher?.disconnect();
  }, [selected]);
  const reason = selected.link?.refusal ?? selected.refusal;
  return (
    <div
      ref={node}
      className="amend-bar"
      role="toolbar"
      aria-label="Selected text"
      data-placed={place ? '' : undefined}
      style={place ? { top: place.top, left: place.left } : undefined}
    >
      {/* Keep the selection alive through any press: the panel needs its text. */}
      <div
        className="amend-bar-box"
        onPointerDown={(event) => {
          // Not in the picker's own field, which has to take the focus.
          if (!(event.target instanceof Element && event.target.closest('input')))
            event.preventDefault();
        }}
      >
        {takeover ?? (
          <>
            <div className="amend-bar-actions">
              {written || selected.refusal ? (
                <button
                  type="button"
                  className="btn btn-accent"
                  disabled={Boolean(selected.refusal)}
                  aria-describedby={reason ? 'amend-reason' : undefined}
                  onClick={onPropose}
                >
                  Propose ADR
                </button>
              ) : (
                <button type="button" className="btn btn-accent" onClick={onShowWritten}>
                  Show as written to propose
                </button>
              )}
              {extra}
            </div>
            {reason ? (
              <p id="amend-reason" className="amend-bar-note">
                {reason}
              </p>
            ) : selected.narrowed ? (
              <p className="amend-bar-note">
                Anchored on the text beside the code:{' '}
                <q>
                  {selected.quote.length > 60 ? `${selected.quote.slice(0, 59)}…` : selected.quote}
                </q>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

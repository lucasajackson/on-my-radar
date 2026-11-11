/**
 * What the reader has selected in the charter, for the toolbar: the ADR reading (one run of plain
 * text, `pageSelection`) and the link reading (the words, across paragraphs, `selectionWords`)
 * of the same selection. They differ in what they allow, so each carries its own reason.
 *
 * Works on the reading view and on the editor. In the editor an ADR cannot be proposed (an
 * amendment is made on the saved, written text), but a passage can be linked or re-anchored.
 */
import { AMEND_LIMITS, BLOCK_SEPARATOR, CHARTER_LIMITS } from '@onmyradar/contract';
import { selectionWords, wordsAround } from '../lib/charter-links';
import { pageSelection, type Selected } from './architecture-selection';

const rectOf = (range: Range) => {
  const box = range.getBoundingClientRect();
  return { x: box.left, y: box.top, bottom: box.bottom };
};

/** The selection as a link reads it. */
export interface LinkSelection {
  quote: string;
  /** Why this selection cannot be linked, in words; the link actions are off when it is set. */
  refusal?: string;
  /** The words' range (widened to hold inline code the selection cut open). */
  range: Range;
  /** The element whose text the quote is, which the surrounding words are read from. */
  scope: HTMLElement;
}

export const ADR_SIZE = `An ADR changes one paragraph, ${AMEND_LIMITS.quote} characters at most. A link can cover more.`;
export const LINK_SIZE = `A link covers ${CHARTER_LIMITS.linkQuote.toLocaleString('en-US')} characters at most. Select less.`;
export const EDITING_ADR = 'Click Done to propose an ADR on the saved text.';

/** The surrounding words of a link selection, read when it is acted on. */
export const around = (link: LinkSelection) => wordsAround(link.scope, link.range);

/**
 * The selection inside the charter's editor, or inside the reading view, as the toolbar offers
 * actions on it. Null when there is none (or it is outside the charter).
 */
export function charterSelection(
  reading: HTMLElement | null,
  editor: HTMLElement | null,
  charter: ReadonlyArray<{ id: string; markdown: string }>,
): Selected | null {
  const selection = window.getSelection();
  if (!selection) return null;
  const scope = editor ?? reading?.querySelector<HTMLElement>('[data-page-id]') ?? null;
  if (!scope) return null;
  const words = selectionWords(scope, selection);
  const size = words && words.quote.length > CHARTER_LIMITS.linkQuote ? LINK_SIZE : words?.refusal;
  const link: LinkSelection | undefined = words
    ? { quote: words.quote, range: words.range, scope, ...(size ? { refusal: size } : {}) }
    : undefined;
  if (editor) {
    if (!link) return null;
    return { quote: link.quote, pageId: null, ...rectOf(link.range), refusal: EDITING_ADR, link };
  }
  // A selection across paragraphs has no single page ancestor for the ADR reading, but its words
  // can still be linked.
  const base =
    pageSelection(reading, charter) ??
    (link
      ? ({
          quote: link.quote,
          pageId: null,
          ...rectOf(link.range),
          refusal: ADR_SIZE,
        } satisfies Selected)
      : null);
  if (!base) return null;
  // One paragraph and 400 characters is what an ADR can hold; say so rather than "formatting".
  const tooBig =
    link !== undefined &&
    (link.quote.includes(BLOCK_SEPARATOR) || link.quote.length > AMEND_LIMITS.quote);
  return {
    ...base,
    ...(tooBig ? { refusal: ADR_SIZE } : {}),
    ...(link ? { link } : {}),
  };
}

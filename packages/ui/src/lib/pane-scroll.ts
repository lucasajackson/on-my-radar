/**
 * Scroll a radar's one scrolling pane (`.app-content`) to an element, and scroll nothing else.
 *
 * `scrollIntoView` scrolls every scrollable ancestor, and `overflow: hidden` is scrollable by
 * script: it moved the fixed app shell up by whatever its content overflowed by, which showed as a
 * black band under the app (4b1e03e1). Setting the pane's own scroll offset has no other effect.
 * The element's `scroll-margin-top` is honoured, so a sticky radar header does not cover it.
 */
function scroller(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

export function scrollPaneTo(
  el: Element,
  {
    block = 'start',
    behavior = 'smooth',
  }: { block?: 'start' | 'center'; behavior?: ScrollBehavior } = {},
): void {
  const pane = scroller(el);
  // A public page has no pane: the document scrolls, and scrolling the nearest ancestors is right.
  if (!pane) {
    el.scrollIntoView({ block, behavior });
    return;
  }
  const box = el.getBoundingClientRect();
  const frame = pane.getBoundingClientRect();
  const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const inside = box.top - frame.top;
  const top =
    pane.scrollTop +
    (block === 'center' ? inside - (pane.clientHeight - box.height) / 2 : inside - margin);
  if (typeof pane.scrollTo === 'function') pane.scrollTo({ top, behavior });
  else pane.scrollTop = top;
}

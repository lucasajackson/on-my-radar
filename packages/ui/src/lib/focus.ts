/**
 * Put focus somewhere sensible once it exists.
 *
 * After a move, a delete or a create, the element that should hold focus is
 * usually one the refetch has not rendered yet — a card remounted in another
 * lane, the next card up, a widget just added. Without this, focus stayed on a
 * node that had been removed, which a browser reports as the body: a keyboard
 * user starts again from the top of the page and a screen reader says nothing.
 *
 * Waits a frame at a time for the first selector that matches, up to about a
 * second, then gives up quietly rather than stealing focus late. With
 * `onlyIfLost`, it also gives up the moment focus is somewhere real — it is a
 * rescue for focus that fell to the body, never a way to take it from a field.
 */
export function focusWhenPresent(
  selectors: string[],
  options: {
    frames?: number;
    onlyIfLost?: boolean;
    preventScroll?: boolean;
    /** Where to look: a dialog the change happened in, rather than the page behind it. */
    within?: () => ParentNode | null;
  } = {},
): void {
  const { frames = 60, onlyIfLost = false, preventScroll = false, within } = options;
  const attempt = (left: number) => {
    // With `onlyIfLost`, a real focus is waited out, not acted on: the control
    // that had it is often about to be unmounted by the refetch (a card moving
    // lanes, a dialog closing), and focus is only lost a few frames later.
    if (onlyIfLost && !focusIsLost()) {
      if (left > 0) requestAnimationFrame(() => attempt(left - 1));
      return;
    }
    const root = within?.() ?? document;
    for (const selector of selectors) {
      /*
        The first match that can actually take focus. Behind an open dialog the
        page is inert, and a card open in the dialog has a twin on the page:
        the first match was the inert twin, `focus()` on it did nothing, and
        every retry picked it again — focus sat on the body for the whole
        window.
      */
      const element = [...root.querySelectorAll<HTMLElement>(selector)].find(
        (candidate) => !isInert(candidate),
      );
      if (element) {
        if (!element.hasAttribute('tabindex') && !isFocusable(element)) {
          element.setAttribute('tabindex', '-1');
        }
        // A heading is focused to say where you are, never to take you there:
        // scrolling to it pulled a page somebody had already scrolled back to
        // its top. A control is focused to be used, and may be scrolled to.
        element.focus({ preventScroll: preventScroll || /^H[1-6]$/.test(element.tagName) });
        // A rescue keeps watching for its whole window: a control can lose
        // focus twice in one change — disabled while saving, then remounted
        // by the refetch — and the second loss needs the same answer.
        if (!onlyIfLost) return;
        break;
      }
    }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1));
  };
  attempt(frames);
}

/** Focus is on nothing a person chose: the body, or an element no longer in the page. */
export function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/** Inside something inert — read from the property, which is what the modal sets. */
function isInert(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.inert) return true;
  }
  return false;
}

function isFocusable(element: HTMLElement): boolean {
  return element.matches('a[href], button, input, select, textarea, [tabindex]');
}

/**
 * For a change that re-renders from a refetch: wait for the old control to go
 * (up to three seconds), then focus its replacement. A control that survives
 * the refetch keeps its focus and nothing happens.
 */
export const AFTER_REFETCH = { frames: 180, onlyIfLost: true } as const;

/** A blip card's id, for a selector. Ids are uuids, so no escaping is needed. */
export const cardSelector = (blipId: string) => `[data-blip-id="${blipId}"]`;

/**
 * The card beside this one in its own list — its lane on a board — read from
 * the page *before* a change moves it. On a phone a board shows one lane, so a
 * card moved to another lane leaves the screen, and the card that takes its
 * place is where the person was working.
 */
export function neighbourCard(blipId: string): string | null {
  const card = document.querySelector(cardSelector(blipId));
  if (!card) return null;
  let list: Element | null = card.closest('.board-column');
  if (!list) {
    list = card.parentElement;
    while (list && list.querySelectorAll('[data-blip-id]').length < 2) list = list.parentElement;
  }
  if (!list) return null;
  const ids = [
    ...new Set(
      [...list.querySelectorAll('[data-blip-id]')].map((el) => el.getAttribute('data-blip-id')),
    ),
  ].filter((id): id is string => id !== null);
  const at = ids.indexOf(blipId);
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** The newest toast's action — an Undo — for when what moved has left the screen. */
export const LATEST_TOAST_ACTION = '.toast-host > :last-child .toast-undo';

/**
 * Where focus goes after a card changes lanes: the card itself if it is still
 * on screen, else the card that took its place, else the Undo that can bring
 * it back — and the page heading only if there is none of those.
 */
export function afterLaneMove(blipId: string, neighbour: string | null): string[] {
  return [
    `#state-${blipId}`,
    cardSelector(blipId),
    ...(neighbour ? [`#state-${neighbour}`, cardSelector(neighbour)] : []),
    LATEST_TOAST_ACTION,
    'main h1',
  ];
}

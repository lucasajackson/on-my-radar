import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/viewport';
import { isTopModal, isolateModal } from '../lib/modal-isolation';
import { useRegisterSidePanel } from '../lib/side-panel';

/**
 * A panel beside the thing it edits (Propose ADR, a boundary, a contract), not a dialog over it.
 *
 * It is mounted once, at one place in the React tree, and never again for as long as it is open:
 * the editor inside it, a save in flight and half-typed text all belong to that one mount. What
 * changes with the window is only where its DOM is. The panel renders into a host element
 * (`usePanelHost`), and the host is moved: into the slot the open tab leaves for it, a column of
 * the card, from 1024px; or onto the page as a full-height drawer (full screen on a phone) below
 * it. Moving a DOM node keeps what is in it, which a different parent in JSX never could.
 */
export interface PanelHostValue {
  host: HTMLElement;
  /** Below 1024px, or with no slot to sit in: a drawer over the page, with a dialog's behaviour. */
  sheet: boolean;
}
const PanelHostContext = createContext<PanelHostValue | null>(null);
export const PanelHostProvider = PanelHostContext.Provider;

/** What a tab needs to leave room for the panel: draw `slot` where it should go when `show`. */
export interface PanelSlot {
  /** A panel is open for the tab being shown. */
  open: boolean;
  /** The window is wide enough for it to sit in the card: draw the slot in the detail's place. */
  show: boolean;
  ref: (element: HTMLElement | null) => void;
}

export function usePanelHost() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'side-panel-host modal-scrim is-side';
    return element;
  });
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const inline = desktop && slot !== null;
  /** Move the host, keeping the focus where it was (moving a node drops it). */
  const moveTo = useCallback(
    (target: HTMLElement) => {
      if (host.parentNode === target) return;
      const active = document.activeElement;
      const had = active instanceof HTMLElement && host.contains(active);
      target.appendChild(host);
      if (had) active.focus({ preventScroll: true });
    },
    [host],
  );
  useLayoutEffect(() => {
    host.className = inline ? 'side-panel-host' : 'side-panel-host modal-scrim is-side';
    moveTo(inline ? slot : document.body);
  }, [host, inline, slot, moveTo]);
  // The slot is removed from the page before any effect runs, and the host with it: take the host
  // out first, as the slot's ref lets go of it.
  const slotRef = useCallback(
    (element: HTMLElement | null) => {
      if (element === null) moveTo(document.body);
      setSlot(element);
    },
    [moveTo],
  );
  useEffect(() => () => host.remove(), [host]);
  const value = useMemo(() => ({ host, sheet: !inline }), [host, inline]);
  return { value, desktop, setSlot: slotRef };
}

const CONTROLS =
  'button:not(:disabled), a[href], input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [contenteditable], [tabindex]:not([tabindex="-1"])';

export function SidePanel({
  title,
  badge,
  footer,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  /** A short status beside the title ("Stays Proposed until decided"). */
  badge?: ReactNode;
  /** The panel's actions, kept in view while the body scrolls. */
  footer: ReactNode;
  /**
   * A save is running: the fields cannot be focused or typed in until it ends, so nothing is
   * written after the request was made that the request does not carry.
   */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const context = useContext(PanelHostContext);
  if (!context) throw new Error('A SidePanel is drawn inside a panel host');
  const { host, sheet } = context;
  useRegisterSidePanel(!sheet);
  const node = useRef<HTMLElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    // Land on the first thing to fill in, without scrolling the page to reach it.
    node.current
      ?.querySelector<HTMLElement>(
        'input:not(:disabled), textarea:not(:disabled), [contenteditable]',
      )
      ?.focus({ preventScroll: true });
  }, []);
  // A drawer over the page is a dialog: the page behind it is out of reach, focus stays inside,
  // and the scrim closes it. In a column of the card it is none of that. A layout effect, so the
  // page is out of isolation before the host is moved back into it (focus cannot land in an inert
  // page).
  useLayoutEffect(() => {
    const panel = node.current;
    if (!sheet || !panel) return;
    const release = isolateModal(panel, 1);
    const onScrim = (event: MouseEvent) => {
      if (event.target === host) closing.current();
    };
    const onFocus = (event: FocusEvent) => {
      if (isTopModal(panel) && !panel.contains(event.target as Node))
        panel.querySelector<HTMLElement>(CONTROLS)?.focus();
    };
    host.addEventListener('mousedown', onScrim);
    document.addEventListener('focusin', onFocus);
    return () => {
      host.removeEventListener('mousedown', onScrim);
      document.removeEventListener('focusin', onFocus);
      release();
    };
  }, [sheet, host]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      closing.current();
      return;
    }
    if (event.key !== 'Tab' || !sheet || !node.current) return;
    const items = Array.from(node.current.querySelectorAll<HTMLElement>(CONTROLS)).filter(
      (element) => !element.closest('[inert]'),
    );
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <section
      ref={node}
      className={`side-panel ${sheet ? 'panel modal-panel is-side is-full max-w-lg' : ''}`}
      role={sheet ? 'dialog' : undefined}
      aria-modal={sheet ? 'true' : undefined}
      aria-label={title}
      tabIndex={sheet ? -1 : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="side-panel-head">
        <h3>{title}</h3>
        {badge}
        <button type="button" className="btn btn-ghost side-panel-close" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="side-panel-body">
        <div className="panel-stack" inert={busy}>
          {children}
        </div>
      </div>
      <footer className="side-panel-foot">{footer}</footer>
    </section>,
    host,
  );
}

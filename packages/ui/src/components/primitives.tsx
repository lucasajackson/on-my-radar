import { isolateModal, isTopModal } from '../lib/modal-isolation';
/** Shared UI atoms: the mark, glyphs, the bearing strip, modals, toasts, empties. */
import { createPortal } from 'react-dom';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Blocks,
  BookOpen,
  Brain,
  Camera,
  Code,
  Coffee,
  Compass,
  Cpu,
  Dog,
  Dumbbell,
  Film,
  FlaskConical,
  Flame,
  Gamepad2,
  Gift,
  Glasses,
  Hammer,
  Headphones,
  Heart,
  House,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  MessageCircle,
  Mic,
  Moon,
  Mountain,
  Music,
  Orbit,
  Palette,
  PenTool,
  Plane,
  Puzzle,
  Quote,
  Radar as RadarIcon,
  Rocket,
  Scroll,
  ShoppingBasket,
  Sparkles,
  Sun,
  Target,
  Telescope,
  Tent,
  Tv,
  Utensils,
  Waves,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  DEFAULT_RADAR_ACCENT,
  RADAR_ACCENTS,
  type RadarGlyph as GlyphName,
} from '@onmyradar/contract';
import { entry } from '../lib/registry';

/**
 * Glyph id → icon. A `Record<GlyphName, …>` on purpose: adding a glyph to the
 * contract without drawing it here is a type error rather than a radar that
 * silently falls back to the default mark.
 */
const GLYPHS: Record<GlyphName, LucideIcon> = {
  radar: RadarIcon,
  target: Target,
  compass: Compass,
  sparkles: Sparkles,
  flame: Flame,
  zap: Zap,
  orbit: Orbit,
  telescope: Telescope,

  lightbulb: Lightbulb,
  brain: Brain,
  book: BookOpen,
  quote: Quote,
  puzzle: Puzzle,
  scroll: Scroll,
  glasses: Glasses,
  message: MessageCircle,

  wrench: Wrench,
  hammer: Hammer,
  rocket: Rocket,
  code: Code,
  cpu: Cpu,
  blocks: Blocks,
  pen: PenTool,
  flask: FlaskConical,

  coffee: Coffee,
  heart: Heart,
  house: House,
  gift: Gift,
  dumbbell: Dumbbell,
  basket: ShoppingBasket,
  dog: Dog,
  utensils: Utensils,

  leaf: Leaf,
  mountain: Mountain,
  sun: Sun,
  moon: Moon,
  waves: Waves,
  tent: Tent,
  map: MapIcon,
  plane: Plane,

  camera: Camera,
  music: Music,
  film: Film,
  gamepad: Gamepad2,
  mic: Mic,
  palette: Palette,
  tv: Tv,
  headphones: Headphones,
};

export function RadarGlyph({
  glyph,
  className = 'h-4 w-4',
}: {
  glyph: string;
  className?: string;
}) {
  const Icon = entry(GLYPHS, glyph) ?? RadarIcon;
  return <Icon className={className} aria-hidden="true" />;
}

/**
 * The app mark. The sweep is the one piece of ambient motion in the product —
 * it appears here and in the empty state, and nowhere else.
 */
export function Mark({ size = 26, sweeping = true }: { size?: number; sweeping?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="shrink-0">
      <g fill="none" stroke="currentColor" strokeOpacity="0.35">
        <circle cx="32" cy="32" r="10" />
        <circle cx="32" cy="32" r="19" />
        <circle cx="32" cy="32" r="28" />
      </g>
      <g className={sweeping ? 'sweep' : undefined} style={{ transformOrigin: '32px 32px' }}>
        <path d="M32 32 L32 4 A28 28 0 0 1 56 18 Z" fill="currentColor" fillOpacity="0.22" />
      </g>
      <circle cx="44" cy="20" r="3.6" fill="currentColor" />
      <circle cx="23" cy="42" r="2.2" fill="currentColor" fillOpacity="0.7" />
    </svg>
  );
}

/**
 * The bearing strip — the signature element.
 *
 * One tick per blip, positioned horizontally by when it was captured across the
 * radar's whole lifetime and given height by how recent it is. It is a readout
 * of the radar's own activity: a radar captured in one burst looks nothing like
 * one filled steadily over months, and you can see which you are looking at
 * before reading a word.
 */
export function BearingStrip({ timestamps }: { timestamps: string[] }) {
  if (timestamps.length === 0) return <div className="bearing" aria-hidden="true" />;

  const times = timestamps.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? first;
  const span = last - first;
  // Below a few hours there is no shape to show — every tick would pile up at
  // the left edge and read as a rendering fault rather than as "captured in one
  // sitting". Order is still true, so spread them evenly instead.
  const evenly = span < 6 * 60 * 60 * 1000;

  /*
    Said out loud, on hover and to a screen reader.
    
    It is a genuine readout — one tick per blip, placed by when it was captured
    across the radar's whole lifetime — and nothing on screen said so, so it read
    as decoration. A `title` earns the 20px without spending another row on a
    caption, which on a surface whose complaint is 270px of chrome above the
    content would be a strange thing to pay.
  */
  const legend =
    `${timestamps.length} ${timestamps.length === 1 ? 'blip' : 'blips'} — one tick each, ` +
    `placed by when it was captured, between ${new Date(first).toLocaleDateString()} and ` +
    new Date(last).toLocaleDateString();

  return (
    <div className="bearing" role="img" aria-label={legend} title={legend}>
      {times.map((time, index) => {
        const fraction = evenly
          ? times.length === 1
            ? 0.5
            : index / (times.length - 1)
          : (time - first) / span;
        const position = fraction * 100;
        // Recent ticks stand taller, so the right-hand end reads as "now".
        const recency = fraction;
        return (
          <span
            key={`${time}-${index}`}
            className="bearing-tick"
            style={{ left: `${position}%`, height: `${6 + recency * 12}px` }}
          />
        );
      })}
    </div>
  );
}

/* --------------------------------- modal --------------------------------- */

/**
 * Every dialog in the product, and the one place the keyboard problem is solved.
 *
 * The scrim is sized to the **visual** viewport rather than `inset-0`, because on
 * iOS the keyboard shrinks only the visual one — a bottom sheet on `inset-0`
 * therefore parks itself under the keyboard, which is exactly how the compose
 * sheet became unreachable on a phone. See `lib/viewport.ts`.
 *
 * `fill` turns the sheet into a full screen on a phone, and `action` puts the
 * primary control in the header. Both exist for the same reason: iOS floats its
 * form accessory bar over the bottom of the visual viewport, so the bottom of a
 * dialog is not somewhere a button can be relied on to be tappable while
 * somebody is typing. The header always is.
 *
 * **Width, subtitle and footer are the primitive's decisions, not each dialog's.**
 * Three dialogs opened from three adjacent pixels of the radar header measured
 * ~650px, ~495px and 512px wide, with two header treatments and three different
 * footers between them. So `size` is a named scale rather than an
 * arbitrary Tailwind class, and `footer` renders one footer: rule-separated,
 * outside the scrolling body, actions right-aligned. A dialog that lays its own
 * buttons out inside `children` is how the fleet drifted the first time.
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'reader' | 'kanban';

const MODAL_WIDTHS: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  reader: 'max-w-4xl',
  kanban: 'max-w-6xl',
};

const ModalDepth = createContext(0);

export function Modal({
  title,
  description,
  onClose,
  children,
  size = 'md',
  action,
  footer,
  fill = false,
  anchor = 'center',
  side = false,
}: {
  title: string;
  description?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  /** A shared size; reader provides a full-screen mobile reading surface. */
  size?: ModalSize;
  /** A primary control for the header, clear of the keyboard and accessory bar. */
  action?: ReactNode;
  /**
   * The dialog's actions. Rendered outside the scroll area so they stay put
   * while the body scrolls, and right-aligned by the primitive so that "the
   * button you press on every visit" is in the same place in every dialog.
   */
  footer?: ReactNode;
  /** Fill the phone screen instead of sitting as a sheet at the bottom of it. */
  fill?: boolean;
  /**
   * `top` for a dialog whose height changes while it is open (rows added and
   * removed): centred, every row moved the whole dialog, header and all, out
   * from under the pointer. Anchored, it grows and shrinks downward only.
   */
  anchor?: 'center' | 'top';
  /**
   * A drawer at the right edge, full height — History beside the prompt it
   * belongs to, so the document stays in view. Full screen on a phone.
   */
  side?: boolean;
}) {
  const depth = useContext(ModalDepth) + 1;
  const panelRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  // Capture before commit: a child's autoFocus runs before this effect.
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previousFocus = restoreFocusRef.current;
    const releaseIsolation = isolateModal(panel, depth);
    const controls = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.closest('[hidden], [inert]') && getComputedStyle(element).display !== 'none',
      );
    const isTopmost = () => isTopModal(panel);
    const focusFirst = () => (controls()[0] ?? panel).focus();
    const onKey = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      // React's handlers on the portal run before this document listener. A
      // mention menu or completion list that consumed Escape or Tab has said so
      // with preventDefault; closing the dialog as well threw away the draft
      // that the Escape was only meant to dismiss a menu from.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTopmost() && !panel.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    // Prefer the first editable field; keep focus in place across parent renders.
    const field = panel.querySelector<HTMLElement>(
      size === 'kanban'
        ? 'input[id^="title-"]:not(:disabled), textarea[id^="body-"]:not(:disabled)'
        : 'input:not(:disabled):not([type=hidden]), textarea:not(:disabled)',
    );
    // A reading popup must not jump down to its comment composer on opening.
    // Its editor still focuses the real title/body field when opened for editing.
    if (isTopmost()) (field ?? controls()[0] ?? panel).focus({ preventScroll: size === 'kanban' });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      releaseIsolation();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [depth, size]);

  return createPortal(
    <ModalDepth.Provider value={depth}>
      <div
        className={`modal-scrim ${anchor === 'top' ? 'is-top' : ''} ${side ? 'is-side' : ''}`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          aria-describedby={description ? descriptionId : undefined}
          className={`panel modal-panel ${fill ? 'is-full' : ''} ${side ? 'is-side' : ''} ${size === 'reader' ? 'is-reader' : ''} ${size === 'kanban' ? 'is-kanban' : ''} ${MODAL_WIDTHS[size]}`}
          style={{ background: 'var(--ink-800)' }}
        >
          <div className="modal-head">
            <div className="min-w-0">
              <h2
                className={`font-semibold tracking-tight ${size === 'kanban' ? '' : 'text-[15px]'}`}
              >
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="note mt-0.5">
                  {description}
                </p>
              ) : null}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {action}
              <button className="btn-ghost btn -mr-2 p-1.5" onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="scroll-area modal-body">{children}</div>
          {footer ? <div className="modal-foot">{footer}</div> : null}
        </div>
      </div>
    </ModalDepth.Provider>,
    document.body,
  );
}

/* --------------------------------- sections ------------------------------ */

/**
 * One container treatment, used by every screen that has sections.
 *
 * `/settings` already got this right — a label outside a filled panel, the same
 * gap from label to panel and from panel to the next label. `/array/$topicId`
 * did not: Radars was a bordered row-list, Sharing was a filled panel and People
 * was a filled panel with different internal padding, and the gaps between the
 * three differed per section. Nothing established a rhythm, so the page read as
 * three components pasted together rather than as one screen.
 *
 * `bare` is for a child that is already its own container — `.radar-list` draws
 * its own border and rows, and wrapping it in a panel would be two frames around
 * one list. The label and the spacing stay identical either way, which is the
 * part that makes the rhythm.
 */
export function Section({
  title,
  action,
  bare = false,
  children,
}: {
  title: string;
  /** A control belonging to the section, right-aligned on the label row. */
  action?: ReactNode;
  /** Skip the panel: the child already draws its own frame. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="flex items-center gap-2">
        <span className="instrument">{title}</span>
        {action ? <span className="ml-auto">{action}</span> : null}
      </h2>
      {bare ? children : <div className="panel flex flex-col gap-3.5 p-4">{children}</div>}
    </section>
  );
}

/* ------------------------------ confirmation ----------------------------- */

/**
 * The one place the product asks "are you sure".
 *
 * It replaces three `window.prompt` / `window.confirm` calls that sat on the
 * three highest-stakes moments in the app — deleting a radar, deleting a topic,
 * and throwing a topic's cascade switch. Those are the moments most deserving of
 * a designed surface and they were the only ones with none: unstyled,
 * un-themeable, positioned differently in every browser, and on iOS rendered as
 * a system alert with no visible relationship to the app.
 *
 * The type-the-name pattern was always right; only the container was wrong. So
 * `phrase` keeps it, and the *consequence in words* — "this removes 33 blips" —
 * gets somewhere to live, which a `prompt` string never really had.
 *
 * `phrase` is compared after trimming and case-folding. The friction that makes
 * this work is having to look up and retype the name at all; punishing somebody
 * for a trailing space is not extra safety, it is a second attempt.
 */
export function ConfirmDialog({
  title,
  body,
  phrase,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  /** When set, the confirm button stays disabled until this is typed back. */
  phrase?: string;
  confirmLabel: string;
  /** Paints the confirm control as destructive. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matched =
    phrase === undefined || typed.trim().toLowerCase() === phrase.trim().toLowerCase();

  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={danger ? 'btn btn-danger' : 'btn btn-accent'}
            disabled={busy || !matched}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-[13.5px] leading-relaxed text-[color:var(--paper-dim)]">{body}</div>
        {phrase !== undefined ? (
          <label className="flex flex-col gap-1.5">
            <span className="instrument">
              Type <span className="!tracking-normal text-[color:var(--paper)]">{phrase}</span> to
              confirm
            </span>
            <input
              className="field"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && matched && !busy)
                  onConfirm();
              }}
            />
          </label>
        ) : null}
      </div>
    </Modal>
  );
}

/* --------------------------------- toasts -------------------------------- */

export interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
  /**
   * One action the toast carries, which in practice is always undo.
   *
   * It exists because of the swipe actions: a gesture that files something is
   * only safe if the same glance that tells you it happened also tells you how
   * to take it back. A confirmation dialog in front of a gesture would defeat
   * the gesture; a toast with an undo in it is the shape every phone app that
   * swipes to file has converged on.
   */
  action?: { label: string; run: () => void };
}

let toastSeq = 0;
const listeners = new Set<(toast: Toast) => void>();

export function notify(
  message: string,
  tone: 'ok' | 'error' = 'ok',
  action?: { label: string; run: () => void },
): void {
  const toast: Toast = { id: (toastSeq += 1), message, tone, ...(action ? { action } : {}) };
  for (const listener of listeners) listener(toast);
}

/**
 * How long a toast stays: an acknowledgement is read in a glance; an error or
 * an undo needs time to be decided on, and 3s is enough to read "Moved to
 * Done" and not enough to decide you did not mean it.
 */
export const TOAST_LIFE_MS = { plain: 3200, error: 6000, action: 8000 } as const;

/**
 * One toast, owning its own clock. The clock stops while the pointer is over
 * it or focus is inside it — somebody reaching for Undo must not have it
 * vanish under the pointer — and resumes with the time that was left.
 */
function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const life = toast.action
    ? TOAST_LIFE_MS.action
    : toast.tone === 'error'
      ? TOAST_LIFE_MS.error
      : TOAST_LIFE_MS.plain;
  const [held, setHeld] = useState({ hover: false, focus: false });
  const left = useRef<number>(life);
  const done = useRef(onDone);
  done.current = onDone;
  const paused = held.hover || held.focus;
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => done.current(), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(left.current - (Date.now() - started), 1200);
    };
  }, [paused]);
  return (
    <div
      // An error is said now; "Saved" can wait for a pause in the host's
      // polite region. One polite region for both meant a failure was
      // queued behind whatever the screen reader was already saying.
      role={toast.tone === 'error' ? 'alert' : undefined}
      data-toast-paused={paused ? 'true' : undefined}
      className="ping-in panel pointer-events-auto flex max-w-md items-center gap-3 px-4 py-2.5 text-[13px] shadow-xl"
      style={{
        borderColor: toast.tone === 'error' ? 'var(--danger)' : 'var(--line)',
        background: 'var(--ink-750)',
      }}
      onMouseEnter={() => setHeld((h) => ({ ...h, hover: true }))}
      onMouseLeave={() => setHeld((h) => ({ ...h, hover: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setHeld((h) => ({ ...h, focus: false }));
      }}
    >
      <span>{toast.message}</span>
      {toast.action ? (
        <button
          className="instrument toast-undo"
          onClick={() => {
            toast.action?.run();
            onDone();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const listener = (toast: Toast) => {
      setToasts((current) => [...current, toast]);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return createPortal(
    /* `toast-host` carries the one thing a utility class cannot: the bottom
       offset has to clear the phone tab bar and the home indicator, and on a
       desktop it must not. A toast landing under the tab bar is a toast nobody
       reads, and the undo in it is then a control nobody can reach. */
    <div data-live-announcements className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDone={() => remove(toast.id)} />
      ))}
    </div>,
    document.body,
  );
}

/* --------------------------------- states -------------------------------- */

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="text-[color:var(--accent-from)] opacity-70">
        <Mark size={54} />
      </div>
      <h3 className="mt-5 text-[15px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-[color:var(--paper-dim)]">
        {hint}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[color:var(--paper-faint)]">
      <span className="sweep inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent" />
      <span className="instrument">{label}</span>
    </div>
  );
}

export function AccentSwatch({ accent, active }: { accent: string; active: boolean }) {
  // Falls back rather than throwing: an accent key this build does not know is
  // the same class of thing as an unknown template id, and a settings dialog
  // that white-screens on one is worse than a swatch in the wrong colour.
  const value = entry(RADAR_ACCENTS, accent) ?? RADAR_ACCENTS[DEFAULT_RADAR_ACCENT];
  return (
    <span
      className="block h-6 w-6 rounded-full"
      style={{
        background: value.from,
        boxShadow: active ? `0 0 0 2px var(--ink-800), 0 0 0 4px ${value.from}` : undefined,
      }}
    />
  );
}

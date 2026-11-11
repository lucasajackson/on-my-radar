/**
 * Swipe actions on a row.
 *
 * The most native thing a capture app does, and the thing whose absence made
 * the phone view read as a narrow desktop: on a phone you triage by pushing the
 * thing sideways, not by hunting for a 12px glyph.
 *
 * ## What it must not fight
 *
 * **Vertical scroll.** The row declares `touch-action: pan-y`, so the browser
 * keeps the vertical gesture for itself and hands us the horizontal one. That is
 * a browser-level decision made before the first move event, which is the only
 * way to win this reliably — a JS angle test runs after the browser has already
 * decided, and the two disagreeing is what produces a list that scrolls in jerks.
 * The angle test below is still there, but it is a second gate, not the first.
 *
 * **The board pager.** Board cards are never swipeable — `BlipCard` passes
 * `swipe` only from the list views. A lane full of horizontally-swipeable cards
 * inside a horizontally-paged board is two gestures competing for one axis, and
 * there is no threshold that resolves it; the answer is that one of them does
 * not exist there.
 *
 * **The decision log.** Not a gesture conflict — a meaning one. Its lanes are
 * Proposed / Accepted / Rejected / Superseded, so the swipe that means "done"
 * on every other surface would mean *accepting a decision*, and "later" has no
 * lane to land in. So the surfaces that swipe are the ones where triage is
 * housekeeping: the stream, the reading list and the drop box. The timeline
 * does not: a post's triage state is shown nowhere on it, so a swipe there
 * changed something invisible. What each swipe does, and where one exists at
 * all, is the contract's (`packages/contract/src/triage.ts`), shared with iOS.
 *
 * **A mouse.** Only touch and pen start a swipe. A mouse drag across a card is
 * text selection, and stealing it would break copying a blip.
 *
 * ## Why every action here is reversible
 *
 * A gesture has no confirmation step by definition, so a gesture may only do
 * things that undo cleanly. Advancing and deferring are both a single field
 * write with a known previous value, so both come back with one tap on the
 * toast. Delete is deliberately not offered: the destructive control stays a
 * button with a confirm behind it, which is the same rule that separated reply
 * from delete in the discussion thread.
 *
 * ## Reachability
 *
 * A gesture cannot be performed by a keyboard, a switch or a screen reader, so
 * **every action here also exists as a control**: the lane/state select in the
 * card's own action cluster does exactly what these do, and that cluster is now
 * painted at rest wherever there is no hover to reveal it. Nothing in this file
 * is the only way to do anything.
 */
import { useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../lib/motion';

export interface SwipeAction {
  /** Shown under the row as it opens, and read out as the button's label. */
  label: string;
  icon: ReactNode;
  /** `danger` tints the track; nothing here is destructive today. */
  tone?: 'accent' | 'quiet' | 'danger';
  run: () => void;
}

/** Horizontal travel before the row starts following the finger at all. */
const LOCK_PX = 10;

/** How far past a lock the gesture has to go before it counts as a decision. */
function commitDistance(width: number): number {
  // A third of a narrow row is a small gesture; a third of a wide one is a
  // journey. The cap is what makes the phone and a tablet feel the same.
  return Math.min(96, Math.max(56, width * 0.28));
}

export function SwipeRow({
  left,
  right,
  disabled = false,
  children,
}: {
  /** Revealed by dragging right — the row moves right, the track sits on its left. */
  left?: SwipeAction;
  /** Revealed by dragging left. */
  right?: SwipeAction;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  /*
    The capture target has to be the element the handlers are on.
    `setPointerCapture` retargets every later event to the capturing element,
    and an element does not receive events retargeted to its parent — capturing
    on the row while listening on the surface silently delivered exactly one
    move, so the card followed the finger for ten pixels and then stopped dead.
  */
  const node = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const locked = useRef<'x' | 'y' | null>(null);

  const armed = !disabled && (left || right);

  const reset = (): void => {
    start.current = null;
    locked.current = null;
    // Reduced motion means no motion, not a faster one: the row goes back to
    // where it was in the same frame, with no transition to watch.
    setSettling(!prefersReducedMotion());
    setDx(0);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!armed) return;
    // Mouse drags stay text selection. Only a finger or a pen files anything.
    if (event.pointerType === 'mouse') return;
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    locked.current = null;
    setSettling(false);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = start.current;
    if (!from || event.pointerId !== from.id) return;
    const moveX = event.clientX - from.x;
    const moveY = event.clientY - from.y;

    if (locked.current === null) {
      if (Math.abs(moveX) < LOCK_PX && Math.abs(moveY) < LOCK_PX) return;
      // The second gate. `touch-action: pan-y` has already given the browser
      // first refusal on a vertical drag; this catches the diagonal that got
      // through, so a scroll that drifts sideways does not open a row under it.
      locked.current = Math.abs(moveX) > Math.abs(moveY) * 1.3 ? 'x' : 'y';
      if (locked.current === 'y') {
        start.current = null;
        return;
      }
      surface.current?.setPointerCapture(from.id);
    }

    // A row with nothing on one side does not open on that side. Resisting
    // rather than refusing keeps the gesture legible — the row moves a little
    // and springs back, which reads as "not that way" rather than as a dead app.
    const wanted = moveX > 0 ? left : right;
    setDx(wanted ? moveX : moveX * 0.18);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = start.current;
    if (!from || event.pointerId !== from.id) {
      if (dx !== 0) reset();
      return;
    }
    const width = node.current?.clientWidth ?? 320;
    const past = Math.abs(dx) >= commitDistance(width);
    const action = dx > 0 ? left : right;
    reset();
    if (past && action) action.run();
  };

  if (!armed) return <>{children}</>;

  const opening = dx > 0 ? left : dx < 0 ? right : null;
  const width = node.current?.clientWidth ?? 320;
  const ready = Math.abs(dx) >= commitDistance(width);

  return (
    <div className="swipe-row" ref={node}>
      {/* The track under the row. It is painted only while the row is open, so a
          list at rest has no extra colour in it at all — the instrument panel
          does not grow a stripe down its side for a gesture nobody made. */}
      {opening ? (
        <div
          className={`swipe-track ${dx > 0 ? 'is-left' : 'is-right'} ${
            ready ? 'is-ready' : ''
          } tone-${opening.tone ?? 'accent'}`}
          aria-hidden="true"
        >
          <span className="swipe-track-mark">
            {opening.icon}
            <span className="instrument">{opening.label}</span>
          </span>
        </div>
      ) : null}

      <div
        ref={surface}
        className={`swipe-surface ${settling ? 'is-settling' : ''}`}
        style={dx === 0 ? undefined : { transform: `translate3d(${Math.round(dx)}px,0,0)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        // A cancel is the system taking the pointer (a scroll, a call, an edge
        // gesture), not the person letting go past the line: never commit on it.
        onPointerCancel={reset}
        onTransitionEnd={() => setSettling(false)}
      >
        {children}
      </div>
    </div>
  );
}

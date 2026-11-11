/**
 * A navigation stack, so moving between screens has a direction.
 *
 * ## The problem
 *
 * Every route in this app replaced the last one with no motion at all, which is
 * the single biggest "this is a website" tell on a phone. Depth is how a person
 * keeps their place: a screen that slid in from the right is a screen you get
 * out of by going back, and one that slid in from the left is where you came
 * from. Without it, a radar, a topic and the settings screen are three
 * interchangeable pages and the only way back is browser chrome.
 *
 * ## Why the stack is a module singleton
 *
 * It was written this way because there was no component alive long enough to
 * hold it: every authenticated route rendered its own `<RequireAccount>`, so
 * React unmounted the whole frame on each navigation and a `useRef` in the shell
 * was reinitialised on exactly the event it existed to observe.
 *
 * **That is no longer true.** `router.tsx` now mounts the guard and the shell
 * once, above an `<Outlet />`, so the frame survives a navigation and this state
 * could be ordinary component state. It has not been moved, and the reason is
 * scope rather than inertia: the conversion is a second behavioural change in a
 * file the phone battery drives, and the router change is worth landing on its
 * own where a regression is attributable to it. What the stable frame bought
 * immediately is below, in `useNavStack`, and it was not optional.
 *
 * The singleton is still *correct* — one tab, one stack — and `resetNavStack`
 * keeps it testable. It is simply no longer *required*.
 *
 * ## How direction is decided
 *
 * Not from the URL's shape, which lies — `/radar/a` to `/radar/b` is neither
 * deeper nor shallower — and not from `history.state`, which TanStack Router
 * does not promise anything about. It is decided from the stack: a path already
 * in it, below the top, is a **pop** and truncates it; anything else is a
 * **push**. That makes the common journeys read correctly without a table of
 * routes: Radars → a radar → its settings pushes three deep, and each back pops
 * one.
 *
 * ## Tab roots are not a stack
 *
 * The bottom tab bar is not depth. Boards, Radars, the drop box and You are
 * peers, and sliding sideways between them would say something false about where
 * they sit. Moving between two of them is a `switch`, which the stylesheet draws
 * as a short lift — and it **resets** the stack, because a tab is a fresh place
 * to be, not a rung on the ladder you were already climbing.
 *
 * ## Scroll
 *
 * A pop that lands you at the top of a screen you had scrolled halfway down has
 * lost your place, which is the thing the whole idea is for. Each path's offset
 * is recorded while you are on it — not on the way out, because the remount
 * above means there is no moment with the outgoing scroller still in the
 * document — and restored on the way back. A push always starts at the top: it
 * is somewhere you have not been.
 */
import { useEffect, useState } from 'react';

export type NavDirection = 'push' | 'pop' | 'switch' | 'none';

export interface NavStack {
  direction: NavDirection;
  /** True when there is a screen underneath this one to go back to. */
  canPop: boolean;
  /** What the screen underneath is, for the back control's label. Null at a root. */
  backTo: string | null;
  /** Bumped on every navigation, so an effect can restart an animation. */
  nonce: number;
}

const EMPTY: NavStack = { direction: 'none', canPop: false, backTo: null, nonce: 0 };

/** Survives the shell being torn down and rebuilt. See the note above. */
const stack: string[] = [];
const scrolls = new Map<string, number>();
let state: NavStack = EMPTY;
let previous: string | null = null;
let previousIndex: number | null = null;

/**
 * The tab bar's destinations. The drop box is one of them and its path carries a
 * uuid, so it is passed in rather than listed here.
 */
function isTabRoot(path: string, dropBoxPath: string | null): boolean {
  if (dropBoxPath && path === dropBoxPath) return true;
  return path === '/' || path === '/radars' || path === '/settings';
}

/**
 * The screen above this one, for when there is no history to go back through.
 *
 * Opened from a link or a reload, a radar had no back control at all on a
 * phone — the stack had nothing under it — so the way out was a tab you had to
 * know about. A detail screen has an obvious parent regardless of how you got
 * there. Tab roots have none, and that is what keeps them free of a title bar.
 */
export function upFor(path: string, dropBoxPath: string | null): string | null {
  if (isTabRoot(path, dropBoxPath)) return null;
  if (/^\/settings\/[^/]+$/.test(path)) return '/settings';
  const settings = /^(\/radar\/[^/]+)\/settings$/.exec(path);
  if (settings?.[1]) return settings[1];
  if (/^\/radar\/[^/]+$/.test(path)) return '/radars';
  if (/^\/repo\/[^/]+$/.test(path)) return '/repo';
  if (/^\/array\/[^/]+$/.test(path)) return '/arrays';
  return null;
}

/**
 * Fold one navigation into the stack. Exported for the same reason the markdown
 * renderer's helpers are: the interesting behaviour here is a state machine, and
 * a state machine that can only be exercised through a browser is one nothing
 * ever checks the edges of.
 */
/**
 * `index` is the router's own position in the session history (`__TSR_index`),
 * when it is known. It settles the one question a path cannot: whether arriving
 * at a screen already in the stack is going *back* to it or following a link
 * *forward* to it. Guessed from the path alone, a forward link from a radar's
 * settings to the radar truncated the stack as if it were a pop — so the back
 * control named the screen under the radar while `history.back()` went to the
 * settings. With the index, a higher number is a push whatever the path.
 */
export function advance(path: string, dropBoxPath: string | null, index?: number): NavStack {
  if (previous === path) return state;
  const from = previous;
  const fromIndex = previousIndex;
  previous = path;
  previousIndex = index ?? null;
  const forward = index !== undefined && fromIndex !== null ? index > fromIndex : null;

  if (from === null) {
    stack.length = 0;
    stack.push(path);
    state = { direction: 'none', canPop: false, backTo: null, nonce: state.nonce + 1 };
    return state;
  }

  let direction: NavDirection;
  if (isTabRoot(path, dropBoxPath) && isTabRoot(from, dropBoxPath)) {
    direction = 'switch';
    stack.length = 0;
    stack.push(path);
  } else {
    const at = stack.lastIndexOf(path);
    if (forward !== true && at >= 0 && at < stack.length - 1) {
      direction = 'pop';
      stack.length = at + 1;
    } else if (forward === false) {
      // Back past the start of this stack — to a screen it never saw.
      direction = 'pop';
      stack.length = 0;
      stack.push(path);
    } else if (isTabRoot(path, dropBoxPath)) {
      // Arriving at a tab root from inside a stack is leaving the stack, not
      // pushing another screen onto it.
      direction = 'pop';
      stack.length = 0;
      stack.push(path);
    } else {
      direction = 'push';
      stack.push(path);
    }
  }

  state = {
    direction,
    canPop: stack.length > 1,
    backTo: stack.length > 1 ? (stack[stack.length - 2] ?? null) : null,
    nonce: state.nonce + 1,
  };
  return state;
}

/** Test seam: forget everything, as though the tab had just been opened. */
export function resetNavStack(): void {
  stack.length = 0;
  scrolls.clear();
  state = EMPTY;
  previous = null;
  previousIndex = null;
}

export function useNavStack(path: string, dropBoxPath: string | null, index?: number): NavStack {
  /*
    Folded **during render**, because a direction computed a frame later arrives
    after the paint it is meant to describe — and the way it stays during render
    had to change when the frame stopped being rebuilt.

    While every route mounted its own guard, this hook was new on every
    navigation and the `useState` initialiser was the fold: it ran during the
    render of the incoming screen, which is exactly when the answer is needed.
    The effect below then re-folded and `advance` returned early, so it cost
    nothing and nobody had to think about it.

    With the frame mounted once, that initialiser runs once in the life of the
    tab. Left as it was, the only fold left would have been the effect's — one
    paint late, every time, which is precisely the failure the original note
    warned about, arriving by the opposite route. Every screen would have entered
    with `direction: 'none'` and animated afterwards, if at all.

    So the fold is an explicit render-phase update instead: React's own pattern
    for adjusting state when an input changes, which re-renders before the
    browser paints rather than after. `advance` returns early when the path has
    not moved, so a double render — StrictMode, or a discarded concurrent one —
    folds nothing twice.
  */
  const [current, setCurrent] = useState<NavStack>(() => advance(path, dropBoxPath, index));
  const [folded, setFolded] = useState(path);
  if (folded !== path) {
    setFolded(path);
    setCurrent(advance(path, dropBoxPath, index));
  }

  useEffect(() => {
    // Restoring has to happen after the new screen has been laid out, or the
    // scroller has nothing to scroll to yet. One frame is enough for a route
    // already cached; a route still loading starts at the top, which is the
    // honest answer rather than a jump once its data lands.
    const target = current.direction === 'pop' ? (scrolls.get(path) ?? 0) : 0;
    const frame = requestAnimationFrame(() => {
      const el = document.querySelector('.app-content');
      if (el) el.scrollTop = target;
    });
    return () => cancelAnimationFrame(frame);
    // `nonce` rather than `current`: it is bumped once per navigation, so this
    // runs once per navigation and not on every unrelated re-render of a frame
    // that now stays mounted for the life of the tab.
  }, [path, current.direction, current.nonce]);

  /*
    Where this screen is scrolled to, kept current while you are on it.

    Recorded continuously rather than once on the way out. That used to be forced
    — the frame was rebuilt by the navigation, so there was no moment at which
    this code ran with the outgoing screen's scroller still in the document — and
    it is now merely right: the cleanup below could read a final offset, but a
    scroller that has already been replaced by the incoming screen's content
    would give the wrong one. Recording while you are on a screen needs no such
    argument.
  */
  useEffect(() => {
    const el = document.querySelector('.app-content');
    if (!el) return;
    const record = (): void => {
      scrolls.set(path, el.scrollTop);
    };
    el.addEventListener('scroll', record, { passive: true });
    return () => el.removeEventListener('scroll', record);
  }, [path]);

  return current;
}

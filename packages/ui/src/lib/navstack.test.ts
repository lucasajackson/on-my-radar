/**
 * The navigation state machine.
 *
 * `advance` is exported so this can exist — the direction a screen enters from
 * is the difference between an app and a website on a phone, and until now the
 * only way to exercise it was to drive a real browser. The phone battery does
 * that and should; it cannot practically enumerate the edges, which is what this
 * is for.
 *
 * The reason it is worth having *now*: the frame these paths move inside used to
 * be rebuilt on every navigation, and is not any more. The stack outliving the
 * frame was the whole reason this file was a module singleton, so the rules it
 * encodes are exactly what a reader would assume had changed with it. They have
 * not, and this says so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { advance, resetNavStack, upFor } from './navstack';

const DROP_BOX = '/radar/drop-box-id';

/** Walk a journey and return the direction each step entered from. */
function journey(paths: string[], dropBoxPath: string | null = DROP_BOX): string[] {
  return paths.map((path) => advance(path, dropBoxPath).direction);
}

describe('navigation direction', () => {
  beforeEach(() => resetNavStack());

  it('opens without a direction — there is nowhere to have come from', () => {
    const first = advance('/radars', DROP_BOX);
    expect(first.direction).toBe('none');
    expect(first.canPop).toBe(false);
    expect(first.backTo).toBeNull();
  });

  /** The journey the whole feature is for: Radars → a radar → its settings. */
  it('pushes deeper and pops back out again', () => {
    expect(journey(['/radars', '/radar/a', '/radar/a/settings'])).toEqual(['none', 'push', 'push']);
    expect(advance('/radar/a', DROP_BOX).direction).toBe('pop');
    expect(advance('/radars', DROP_BOX).direction).toBe('pop');
  });

  it('knows what is underneath, for the back control to name', () => {
    journey(['/radars', '/radar/a']);
    const deep = advance('/radar/a/settings', DROP_BOX);
    expect(deep.canPop).toBe(true);
    expect(deep.backTo).toBe('/radar/a');
  });

  /**
   * The URL's shape lies here — `/radar/a` to `/radar/b` is neither deeper nor
   * shallower — so a sibling is a push, and only a path already below the top is
   * a pop.
   */
  it('treats a sibling as a push, not a pop', () => {
    journey(['/radars', '/radar/a']);
    expect(advance('/radar/b', DROP_BOX).direction).toBe('push');
  });

  it('truncates the stack on a pop, so going back twice is not going forward', () => {
    journey(['/radars', '/radar/a', '/radar/a/settings']);
    advance('/radars', DROP_BOX);
    // `/radar/a/settings` is no longer below anything; reaching it is a push.
    expect(advance('/radar/a/settings', DROP_BOX).direction).toBe('push');
  });

  /** Tab roots are peers. Sliding sideways between them would say otherwise. */
  it('switches between tab roots and resets the stack', () => {
    journey(['/radars']);
    expect(advance('/', DROP_BOX).direction).toBe('switch');
    expect(advance('/settings', DROP_BOX).direction).toBe('switch');
    expect(advance(DROP_BOX, DROP_BOX).direction).toBe('switch');
    expect(advance(DROP_BOX, DROP_BOX).canPop).toBe(false);
  });

  /** The drop box's path carries a uuid, so it is passed in rather than listed. */
  it('does not mistake a radar for a tab root when it is not the drop box', () => {
    journey(['/radars']);
    expect(advance('/radar/not-the-drop-box', DROP_BOX).direction).toBe('push');
  });

  it('reads arriving at a tab root from inside a stack as leaving it', () => {
    journey(['/radars', '/radar/a', '/radar/a/settings']);
    const out = advance('/', DROP_BOX);
    expect(out.direction).toBe('pop');
    expect(out.canPop).toBe(false);
  });

  it('says nothing happened when the path has not moved', () => {
    const before = advance('/radars', DROP_BOX);
    const again = advance('/radars', DROP_BOX);
    // Same object, so a render-phase fold can be run twice without folding twice
    // — which is what makes calling this during render safe.
    expect(again).toBe(before);
  });

  it('bumps the nonce on every real navigation, so an animation can restart', () => {
    const a = advance('/radars', DROP_BOX);
    const b = advance('/radar/a', DROP_BOX);
    const c = advance('/radars', DROP_BOX);
    expect(b.nonce).toBeGreaterThan(a.nonce);
    expect(c.nonce).toBeGreaterThan(b.nonce);
  });

  it('works for an account with no drop box yet', () => {
    expect(journey(['/radars', '/radar/a'], null)).toEqual(['none', 'push']);
  });

  /**
   * The back control's label and its action must name the same screen. The
   * action is `history.back()`, so when the history says a navigation went
   * forward, the stack must say so too — even onto a path it already holds.
   */
  it('treats a forward link onto a screen already in the stack as a push', () => {
    advance('/radars', DROP_BOX, 0);
    advance('/radar/a', DROP_BOX, 1);
    advance('/radar/a/settings', DROP_BOX, 2);
    // "Back to the radar" in settings is a link, not history.back().
    const onRadar = advance('/radar/a', DROP_BOX, 3);
    expect(onRadar.direction).toBe('push');
    expect(onRadar.backTo).toBe('/radar/a/settings');
    // And the browser's back from there really is a pop, to settings.
    const back = advance('/radar/a/settings', DROP_BOX, 2);
    expect(back.direction).toBe('pop');
    expect(back.backTo).toBe('/radar/a');
  });

  it('pops to a screen the stack never saw when history goes back past it', () => {
    advance('/radar/a/settings', DROP_BOX, 5);
    const back = advance('/radar/a', DROP_BOX, 4);
    expect(back.direction).toBe('pop');
    expect(back.canPop).toBe(false);
  });
});

it('gives a detail screen a way up when there is no history under it', () => {
  const dropBox = '/radar/drop';
  expect(upFor('/radar/r1', dropBox)).toBe('/radars');
  expect(upFor('/radar/r1/settings', dropBox)).toBe('/radar/r1');
  expect(upFor('/repo/a1', dropBox)).toBe('/repo');
  expect(upFor('/array/t1', dropBox)).toBe('/arrays');
  expect(upFor('/settings/notifications', dropBox)).toBe('/settings');
  // Tab roots stay bare: a band on every screen is chrome, not an affordance.
  for (const root of ['/', '/radars', '/settings', dropBox])
    expect(upFor(root, dropBox)).toBeNull();
});

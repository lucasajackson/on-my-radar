/**
 * The three phone idioms, driven rather than described.
 *
 * `sweep.ts` asserts that the phone view *fits*. This file asserts that it
 * behaves like an application: that the board pager actually pages, that a
 * swipe actually triages and can be taken back, that a screen arrives from a
 * direction, and that somebody who has asked for no motion gets none — not a
 * shorter animation, none.
 *
 * It is separate from `sweep.ts` for one practical reason: that sweep ends by
 * reading the public and invitation screens the way a stranger reads them, and
 * to do that it deletes the session cookie. Everything here needs an account.
 * So it runs afterwards, signs back in the way `desktop.ts` does, and stays at
 * 390x844 — the desktop sweep resizes and must come last.
 *
 * ## Why gestures are driven through CDP and not `page.touchscreen.tap`
 *
 * A swipe is a sequence — down, several moves, up — and what is being asserted
 * is the *thresholds*: that a small push springs back, a large one commits, and
 * a vertical drag scrolls instead. `Input.dispatchTouchEvent` is the only thing
 * here that can hold a finger down and move it in steps, which is the shape of
 * the gesture the code has to distinguish.
 */
import type { Page } from 'puppeteer-core';
import { PATIENCE_MS, shot, wait } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

/** A phone-sized commit threshold, from `components/swipe.tsx`. */
const PAST_THRESHOLD = 130;
const SHORT_OF_THRESHOLD = 30;

export async function runIdiomSweep(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const notes: unknown[] = [];

  const check = (name: string, ok: boolean, detail: unknown = null): void => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };

  page.on('pageerror', (err) => failures.push(`page error (idiom): ${String(err)}`));

  /*
   * Sign back in. The phone sweep deletes every cookie on purpose, and without
   * this every assertion below would be taken against the sign-in screen and
   * pass or fail for reasons that have nothing to do with the phone. The desktop
   * sweep carries the same paragraph and the same three lines.
   */
  const [cookieName, cookieValue] = seeded.ownerCookie.split('=');
  if (cookieName && cookieValue) {
    await page.browser().setCookie({
      name: cookieName,
      value: cookieValue,
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  }

  const goto = async (path: string): Promise<void> => {
    await page.goto(seeded.baseUrl + path, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app-main', { timeout: PATIENCE_MS }).catch(() => null);
    await wait(600);
  };

  const cdp = await page.createCDPSession();
  type TouchType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';
  const touch = async (type: TouchType, x: number, y: number): Promise<void> => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 5, radiusY: 5, force: 1, id: 1 }],
    });
  };

  /** Drag from a point by (dx, dy) in steps, holding the finger down throughout. */
  const drag = async (
    from: { x: number; y: number },
    dx: number,
    dy: number,
    hold = false,
  ): Promise<void> => {
    await touch('touchStart', from.x, from.y);
    for (let i = 1; i <= 6; i += 1) {
      await touch('touchMove', from.x + (dx * i) / 6, from.y + (dy * i) / 6);
      await wait(35);
    }
    if (!hold) {
      await touch('touchEnd', 0, 0);
      await wait(500);
    }
  };

  const board = seeded.radars.find((r) => r.template === 'kanban');
  const stream = seeded.radars.find((r) => r.template === 'stream');
  if (!board || !stream) throw new Error('the seed no longer has a kanban and a stream radar');

  /* ================================================== A — the board pager == */

  await goto(`/radar/${board.id}`);
  await shot(page, outDir, '40-pager-first');

  const pagerShape = (): Promise<{
    lanes: string[];
    active: number;
    heading: string | null;
    cards: number;
    columnWidth: number | null;
    cardWidth: number | null;
    boardWidth: number | null;
    swipeRowsInBoard: number;
  }> =>
    page.evaluate(() => {
      const chips = [...document.querySelectorAll('.board-pager-lane')];
      const col = document.querySelector('.board-column');
      const card = document.querySelector('.board-card');
      const boardEl = document.querySelector('.board');
      const round = (n: number | undefined): number | null =>
        n === undefined ? null : Math.round(n);
      return {
        lanes: chips.map((c) => c.textContent.trim()),
        active: chips.findIndex((c) => c.classList.contains('is-active')),
        heading: chips.find((c) => c.classList.contains('is-active'))?.textContent.trim() ?? null,
        cards: document.querySelectorAll('.board-card').length,
        columnWidth: round(col?.getBoundingClientRect().width),
        cardWidth: round(card?.getBoundingClientRect().width),
        boardWidth: round(boardEl?.getBoundingClientRect().width),
        swipeRowsInBoard: document.querySelectorAll('.board .swipe-row').length,
      };
    });

  const firstPage = await pagerShape();
  notes.push({ what: 'board pager, first lane', ...firstPage });

  check(
    '[pager] one lane is drawn and the pager offers all five',
    firstPage.lanes.length === 5 && firstPage.active === 0,
    firstPage,
  );
  /*
   * Full width, which is the whole argument for a pager over five columns. A
   * lane that is 90% of the board is a lane; a lane that is a fifth of it is a
   * bar chart. The card inside is measured too, because that is what a person
   * actually reads.
   */
  check(
    '[pager] the lane is the full width of the board',
    firstPage.columnWidth !== null &&
      firstPage.boardWidth !== null &&
      firstPage.columnWidth > firstPage.boardWidth * 0.9,
    firstPage,
  );
  check(
    '[pager] and the card fills the lane',
    firstPage.cardWidth !== null &&
      firstPage.columnWidth !== null &&
      firstPage.cardWidth > firstPage.columnWidth * 0.85,
    firstPage,
  );
  /*
   * Board cards are deliberately NOT swipeable. A row that pages horizontally
   * and cards inside it that triage horizontally are two gestures competing for
   * one axis, and there is no threshold that resolves it — so one of them does
   * not exist there. This is the assertion that keeps it that way when somebody
   * later passes `swipe` from the board because the stream has it.
   */
  check(
    '[pager] board cards carry no swipe — one axis, one gesture',
    firstPage.swipeRowsInBoard === 0,
    firstPage,
  );

  // It pages. Not "there is a next control" — that the next control moves you.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[aria-label="Next lane"]')?.click();
  });
  await wait(400);
  const secondPage = await pagerShape();
  notes.push({ what: 'board pager, after next', ...secondPage });
  check(
    '[pager] the next control actually pages',
    secondPage.active === 1 && secondPage.heading !== firstPage.heading,
    { from: firstPage.heading, to: secondPage.heading, active: secondPage.active },
  );
  check(
    '[pager] and the lane on screen changed with it',
    secondPage.cards !== firstPage.cards || secondPage.heading !== firstPage.heading,
    { before: firstPage.cards, after: secondPage.cards },
  );

  // And a chip is a direct jump, not only a readout of where you are.
  await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.board-pager-lane')];
    (chips[4] as HTMLElement | undefined)?.click();
  });
  await wait(400);
  const jumped = await pagerShape();
  check('[pager] a lane chip jumps straight to that lane', jumped.active === 4, jumped);
  await shot(page, outDir, '41-pager-last');

  /* ============================================== B — the navigation stack == */

  const navShape = (): Promise<{
    path: string;
    dataNav: string | null;
    animations: number;
    back: string | null;
    backHeight: number | null;
  }> =>
    page.evaluate(() => {
      const pane = document.querySelector('.nav-pane');
      const back = document.querySelector('.nav-back');
      return {
        path: location.pathname,
        dataNav: pane?.getAttribute('data-nav') ?? null,
        animations: pane ? (pane as HTMLElement).getAnimations().length : -1,
        back: back ? back.textContent.trim() : null,
        backHeight: back ? Math.round(back.getBoundingClientRect().height) : null,
      };
    });

  const intoRadar = async (id: string): Promise<void> => {
    await page.evaluate((radarId: string) => {
      document.querySelector<HTMLElement>(`a[href*="${radarId}"]`)?.click();
    }, id);
    // Read while the animation is still running: `getAnimations()` is empty once
    // it has finished, and 260ms is the whole of it.
    await wait(120);
  };

  await goto('/radars');
  const atRoot = await navShape();
  notes.push({ what: 'nav at a tab root', ...atRoot });
  /*
   * No back control on a tab root, and that is what keeps this a control rather
   * than a title bar. A band that is there on every screen is chrome; one that
   * appears only when there is something underneath is an affordance.
   */
  check('[nav] a tab root offers no back control', atRoot.back === null, atRoot);

  await intoRadar(stream.id);
  const pushed = await navShape();
  notes.push({ what: 'nav after a push', ...pushed });
  check(
    '[nav] going into a radar is a push',
    pushed.dataNav === 'push' && pushed.path.startsWith('/radar/'),
    pushed,
  );
  check('[nav] and it is drawn as one — the pane is animating', pushed.animations >= 1, pushed);
  /*
   * The back affordance itself: present, thumb-sized, and it names where it
   * goes. "Back" alone says nothing a chevron did not already say.
   */
  check(
    '[nav] a back control appears, thumb-sized, naming its destination',
    pushed.back !== null && /radars/i.test(pushed.back) && (pushed.backHeight ?? 0) >= 44,
    pushed,
  );
  await shot(page, outDir, '42-nav-pushed');

  await page.evaluate(() => document.querySelector<HTMLElement>('.nav-back')?.click());
  await wait(120);
  const popped = await navShape();
  notes.push({ what: 'nav after a pop', ...popped });
  check(
    '[nav] back pops, and pops the other way',
    popped.dataNav === 'pop' && popped.path === '/radars',
    popped,
  );
  check(
    '[nav] and the back control goes with the depth it described',
    popped.back === null,
    popped,
  );

  // A tab is a peer, not a rung. Sliding sideways between tabs would say
  // something false about where they sit.
  await wait(500);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.app-tabbar a[href="/"]')?.click();
  });
  await wait(120);
  const switched = await navShape();
  notes.push({ what: 'nav after a tab switch', ...switched });
  check(
    '[nav] switching tabs is neither a push nor a pop',
    switched.dataNav === 'switch',
    switched,
  );

  /*
   * Reduced motion, and the assertion is absence rather than brevity. A 1ms
   * animation is still an animation, and the setting exists for people for whom
   * that is not a distinction. So: no direction attribute at all, and nothing
   * running on the pane.
   */
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await goto('/radars');
  await intoRadar(stream.id);
  const reduced = await navShape();
  notes.push({ what: 'nav under reduced motion', ...reduced });
  check(
    '[nav] reduced motion means no motion at all, not a shorter one',
    reduced.dataNav === null && reduced.animations === 0,
    reduced,
  );
  check(
    '[nav] and the back control is still there — motion is what was removed, not the way back',
    reduced.back !== null,
    reduced,
  );

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  /* ================================================ C — swipe to triage === */

  await goto(`/radar/${stream.id}`);
  await shot(page, outDir, '43-swipe-rest');

  const rowShape = (): Promise<{
    rows: number;
    touchAction: string | null;
    firstState: string | null;
    actionsOpacity: string | null;
    selectHeight: number | null;
    buttonHeight: number | null;
    actionsInsideCard: boolean | null;
    tracks: number;
  }> =>
    page.evaluate(() => {
      const row = document.querySelector('.swipe-row');
      const surface = row?.querySelector('.swipe-surface') ?? null;
      const card = row?.querySelector('.blip-card') ?? null;
      const actions = card?.querySelector('.blip-actions') ?? null;
      const select = actions?.querySelector('[role="combobox"]') ?? null;
      const button = actions?.querySelector('button') ?? null;
      const inside = (): boolean | null => {
        if (!card || !actions) return null;
        const c = card.getBoundingClientRect();
        const a = actions.getBoundingClientRect();
        return a.left >= c.left - 0.5 && a.right <= c.right + 0.5;
      };
      return {
        rows: document.querySelectorAll('.swipe-row').length,
        touchAction: surface ? window.getComputedStyle(surface).touchAction : null,
        firstState: select ? select.getAttribute('data-value') : null,
        actionsOpacity: actions ? window.getComputedStyle(actions).opacity : null,
        selectHeight: select ? Math.round(select.getBoundingClientRect().height) : null,
        buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : null,
        actionsInsideCard: inside(),
        tracks: document.querySelectorAll('.swipe-track').length,
      };
    });

  const atRest = await rowShape();
  notes.push({ what: 'swipe rows at rest', ...atRest });

  check('[swipe] the list is made of swipe rows', atRest.rows > 1, atRest);
  /*
   * The line that stops this fighting the list. `pan-y` hands vertical panning
   * back to the browser before the first move event exists; a JS angle test on
   * its own runs after the browser has already decided, and the two disagreeing
   * is what makes a swipeable list scroll in jerks.
   */
  check(
    '[swipe] and each one leaves vertical panning to the browser',
    atRest.touchAction === 'pan-y',
    atRest,
  );
  check('[swipe] nothing is painted behind a row nobody has touched', atRest.tracks === 0, atRest);

  /*
   * The reachability rule, and it is the reason the gesture is allowed to exist.
   * Everything a swipe does is also a control on the card — and on a touch
   * device that control has to be *visible*, which it was not: `opacity-0` with
   * a `group-hover` reveal is invisible and still hit-testable on a phone, so
   * the lane select, edit, pin and delete could be pressed by accident and
   * reached no other way.
   */
  check(
    '[swipe] every gesture has a control: the triage select is painted at rest',
    atRest.actionsOpacity !== null && Number(atRest.actionsOpacity) > 0.4,
    atRest,
  );
  check(
    '[swipe] and it is thumb-sized, like every other control on a phone',
    (atRest.selectHeight ?? 0) >= 44 && (atRest.buttonHeight ?? 0) >= 44,
    atRest,
  );
  check(
    "[swipe] the cluster is inside its card, not clipped by the row's own overflow",
    atRest.actionsInsideCard === true,
    atRest,
  );

  /*
   * And the one list template that deliberately does not swipe. Not a gesture
   * conflict — a meaning one: a decision log's lanes are Proposed / Accepted /
   * Rejected / Superseded, so the swipe that means "done" everywhere else would
   * mean *accepting a decision*, and "later" has no lane to land in. Paired with
   * the positive check above that the stream does have swipe rows, so this
   * cannot pass by pointing at nothing.
   */
  const log = seeded.radars.find((r) => r.template === 'decisions');
  if (log) {
    await goto(`/radar/${log.id}`);
    const decisionRows = await page.evaluate(() => ({
      swipeRows: document.querySelectorAll('.swipe-row').length,
      entries: document.querySelectorAll('.log-entry').length,
    }));
    notes.push({ what: 'decision log rows', ...decisionRows });
    check(
      '[swipe] a decision log does not accept decisions by thumb',
      decisionRows.entries > 0 && decisionRows.swipeRows === 0,
      decisionRows,
    );
    await goto(`/radar/${stream.id}`);
  }

  const rowAt = async (index: number): Promise<{ x: number; y: number } | null> =>
    page.evaluate((at: number) => {
      const el = document.querySelectorAll('.swipe-row')[at];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + Math.min(28, r.height / 2)) };
    }, index);

  /* --- a short push springs back and changes nothing --- */
  const target = await rowAt(0);
  if (target) {
    await drag(target, SHORT_OF_THRESHOLD, 0);
    const afterShort = await rowShape();
    check(
      '[swipe] a push short of the threshold springs back and files nothing',
      afterShort.firstState === atRest.firstState,
      { before: atRest.firstState, after: afterShort.firstState },
    );
  }

  /* --- the settle, with motion allowed and with it refused --- */

  /*
   * Measured *during* the settle, and as a pair.
   *
   * A negative assertion whose positive twin is never made cannot tell a working
   * rule from a misspelt selector — this suite already carries that lesson about
   * the modal scrim. So the same gesture is driven twice: once with motion
   * allowed, where the row must actually be transitioning back, and once with it
   * refused, where the duration must be zero and the row must not be given the
   * class that transitions at all.
   *
   * Zero, not "small". The universal reduced-motion reset in `styles.css` said
   * `transition-duration: 1ms !important`, which is the version of this rule
   * everybody copies and is exactly the shortened-animation the setting is not
   * asking for — and being `!important` it silently outranked every specific
   * `transition: none` in the file. This is the assertion that found it.
   */
  const settleDuration = async (): Promise<{ duration: string | null; settling: boolean }> => {
    const at = await rowAt(0);
    if (!at) return { duration: null, settling: false };
    await drag(at, SHORT_OF_THRESHOLD, 0, true);
    await touch('touchEnd', 0, 0);
    // Read on the next frame: the class is applied by the release, and 200ms
    // later there is nothing left to observe.
    await wait(40);
    const observed = await page.evaluate(() => {
      const el = document.querySelector('.swipe-surface');
      return {
        duration: el ? window.getComputedStyle(el).transitionDuration : null,
        settling: el ? el.classList.contains('is-settling') : false,
      };
    });
    await wait(400);
    return observed;
  };

  const settleWithMotion = await settleDuration();
  notes.push({ what: 'swipe settle, motion allowed', ...settleWithMotion });
  check(
    '[swipe] the row settles with a real transition when motion is allowed',
    settleWithMotion.settling &&
      settleWithMotion.duration !== null &&
      Number.parseFloat(settleWithMotion.duration) > 0.05,
    settleWithMotion,
  );

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await goto(`/radar/${stream.id}`);
  const settleReduced = await settleDuration();
  notes.push({ what: 'swipe settle, motion refused', ...settleReduced });
  check(
    '[swipe] and with no transition at all under reduced motion — 0s, not 1ms',
    settleReduced.duration === '0s' && settleReduced.settling === false,
    settleReduced,
  );
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await goto(`/radar/${stream.id}`);

  /* --- a vertical drag scrolls the list rather than opening a row --- */
  const beforeScroll = await page.evaluate(
    () => document.querySelector('.app-content')?.scrollTop ?? -1,
  );
  const scrollTarget = await rowAt(0);
  if (scrollTarget) {
    await drag(scrollTarget, 0, -160);
    const afterVertical = await page.evaluate(() => ({
      scrollTop: document.querySelector('.app-content')?.scrollTop ?? -1,
      tracks: document.querySelectorAll('.swipe-track').length,
    }));
    notes.push({ what: 'vertical drag over a swipe row', before: beforeScroll, ...afterVertical });
    check(
      '[swipe] a vertical drag scrolls the list and opens no row',
      afterVertical.tracks === 0,
      afterVertical,
    );
  }

  /* --- a full swipe triages, and the toast takes it back --- */
  await goto(`/radar/${stream.id}`);
  const before = await rowShape();
  const commitTarget = await rowAt(0);
  if (commitTarget) {
    await drag(commitTarget, PAST_THRESHOLD, 0, true);
    const opened = await page.evaluate(() => {
      const track = document.querySelector('.swipe-track');
      return {
        track: track?.className ?? null,
        label: (track?.textContent ?? '').trim(),
      };
    });
    notes.push({ what: 'swipe held open', ...opened });
    await shot(page, outDir, '44-swipe-open');
    /*
     * The track lights up *before* you let go. That is the whole feedback loop
     * of a swipe action: you learn where the threshold is by crossing it, not by
     * releasing and finding out what happened.
     */
    check(
      '[swipe] the track names the action and lights up before release',
      opened.track !== null && opened.track.includes('is-ready') && opened.label.length > 0,
      opened,
    );
    await touch('touchEnd', 0, 0);
    await wait(900);

    const committed = await page.evaluate(() => {
      const select = document
        .querySelector('.swipe-row .blip-actions')
        ?.querySelector('[role="combobox"]') as HTMLElement | null;
      const toast = document.querySelector('.toast-host');
      const undo = document.querySelector('.toast-undo');
      const bar = document.querySelector('.app-tabbar');
      return {
        state: select?.getAttribute('data-value') ?? null,
        toast: (toast?.textContent ?? '').trim(),
        undo: undo ? undo.textContent.trim() : null,
        toastBottom: toast?.lastElementChild
          ? Math.round(toast.lastElementChild.getBoundingClientRect().bottom)
          : null,
        tabBarTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
      };
    });
    notes.push({ what: 'swipe committed', before: before.firstState, ...committed });
    await shot(page, outDir, '45-swipe-committed');

    check(
      '[swipe] a full swipe triages the blip',
      committed.state !== null && committed.state !== before.firstState,
      { before: before.firstState, after: committed.state },
    );
    check(
      '[swipe] and says so, with a way to take it back',
      committed.toast.length > 0 && committed.undo !== null,
      committed,
    );
    /*
     * The undo is a control, so it has to be somewhere a thumb can reach it. A
     * toast pinned to `bottom-4` sat underneath the tab bar, which made the undo
     * unreachable on the one screen size it exists for.
     */
    check(
      '[swipe] the toast clears the tab bar, so its undo can be pressed',
      committed.toastBottom !== null &&
        committed.tabBarTop !== null &&
        committed.toastBottom <= committed.tabBarTop,
      committed,
    );

    // And undo really undoes.
    await page.evaluate(() => document.querySelector<HTMLElement>('.toast-undo')?.click());
    await wait(900);
    const undone = await page.evaluate(() => {
      const select = document
        .querySelector('.swipe-row .blip-actions')
        ?.querySelector('[role="combobox"]') as HTMLElement | null;
      return select?.getAttribute('data-value') ?? null;
    });
    notes.push({ what: 'swipe undone', state: undone });
    check('[swipe] undo puts it back where it was', undone === before.firstState, {
      expected: before.firstState,
      got: undone,
    });
  }

  /* ============================ D — what containment could have broken === */

  /*
   * A dialog opened from inside a blip card still covers the whole viewport.
   *
   * This is here because two changes in the same push put a `position: fixed`
   * dialog inside boxes that can capture one, and neither is obvious from
   * reading the diff:
   *
   *  - `.discussion` is a **query container** now, and `container-type:
   *    inline-size` carries layout containment with it. A containing block for
   *    fixed descendants is exactly what layout containment can establish.
   *  - `.swipe-row` is `overflow: hidden`, which is how the track stays behind
   *    the card, and the surface takes a `transform` while a finger is on it.
   *    A transformed ancestor definitively captures a fixed descendant.
   *
   * Every blip card renders its own delete confirmation inside its `<article>`,
   * so both boxes are ancestors of a real dialog. Measured, both are fine — the
   * scrim comes out at the full viewport in a discussion and in a stream. This
   * asserts the measurement rather than the reasoning, because the reasoning
   * here is about implementation detail in two specs and the browser is the only
   * authority worth consulting.
   */
  for (const template of ['discussion', 'stream'] as const) {
    const radar = seeded.radars.find((r) => r.template === template);
    if (!radar) continue;
    await goto(`/radar/${radar.id}`);
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>('.blip-actions button[title^="Delete"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    await wait(600);
    const scrim = await page.evaluate(() => {
      const el = document.querySelector('.modal-scrim');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      /*
       * Geometry is not enough, and finding that out cost a screenshot. The
       * scrim measured exactly right — full width, at the origin — while two
       * blip cards painted straight through it, because `.swipe-surface` had a
       * `z-index` and every card renders its own dialog *inside itself*: the
       * dialog's `z-index: 50` was scoped to one row's stacking context, and
       * every later row outranked the whole subtree. So the real question is
       * "what would a finger hit", and `elementFromPoint` is the only thing that
       * answers it. Sampled down the page rather than once, because the failure
       * was partial — the top of the screen was covered and the middle was not.
       */
      const through: string[] = [];
      for (const frac of [0.2, 0.35, 0.5, 0.65]) {
        const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight * frac);
        if (hit && !el.contains(hit) && hit !== el) {
          through.push(`${frac}: ${hit.className || hit.tagName}`);
        }
      }
      return {
        top: Math.round(b.top),
        left: Math.round(b.left),
        width: Math.round(b.width),
        height: Math.round(b.height),
        viewport: window.innerWidth,
        viewportHeight: window.innerHeight,
        paintingThrough: through,
      };
    });
    notes.push({ what: `dialog from a ${template} card`, clicked, scrim });
    check(
      `[${template}] a dialog opened from a blip card still covers the viewport`,
      clicked &&
        scrim !== null &&
        scrim.left === 0 &&
        scrim.width === scrim.viewport &&
        scrim.height >= scrim.viewportHeight - 1,
      { clicked, scrim },
    );
    check(
      `[${template}] and nothing paints through it`,
      scrim !== null && scrim.paintingThrough.length === 0,
      { paintingThrough: scrim?.paintingThrough },
    );
    await shot(page, outDir, `46-dialog-${template}`);
    await page.keyboard.press('Escape').catch(() => null);
    await wait(300);
  }

  return { checks, failures, notes };
}

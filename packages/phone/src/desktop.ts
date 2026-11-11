/**
 * The same app at the three desktop widths people actually have.
 *
 * ## Why this exists
 *
 * `packages/phone` gated 390 and **nothing gated a desktop viewport at all**,
 * which is exactly where this app's two width-sensitive decisions live: the
 * sidebar's expanded-versus-railed states, and the kanban lane budget. Both had
 * been tuned from arithmetic in a CSS comment, and the arithmetic was wrong — an
 * older comment claimed ~312px of shell overhead when the measured figure is
 * 264px expanded and 60px railed, and a lane floor had been derived from it.
 *
 * So: measure, record the numbers in `report.json`, and hold the few that are
 * genuine guarantees.
 *
 * ## What is asserted, and what is only recorded
 *
 * Asserted are the things that are true at every width and would be defects if
 * they stopped being true: no sideways scroll, nothing painted past the right
 * edge, the sidebar expanded above its breakpoint, the settings page a tab strip
 * with one scroll region, and a budget on the vertical chrome above a radar's
 * first blip.
 *
 * **Not** asserted: whether a board scrolls horizontally. That is `23083131`,
 * still open — the product owner is opposed to it and the two follow-up reports pull against
 * each other, because fitting more lanes without a horizontal scroll is exactly
 * what narrows the cards until the edit control disappears. Asserting either
 * side of a live argument would be this suite taking a position it has not been
 * given. The lane width is measured and recorded so whoever settles it has the
 * numbers.
 *
 * The lane **count** is settled and is five. `79c3f5d5` was closed without
 * adding a sixth; retention is going the archiving route instead.
 */
import type { Page } from 'puppeteer-core';
import { PATIENCE_MS, shot, wait } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

/**
 * The four shapes worth holding: the breakpoint itself, a laptop, a large
 * laptop, and a monitor.
 *
 * **1024 is in the list because it is the cruel one, not because it is anybody's
 * screen.** It is the exact pixel at which the sidebar appears, so the content
 * pane is narrower there than at 1023 with no sidebar at all — 712px against
 * 912px. Every width-sensitive decision in this app is at its worst at that one
 * value and nowhere else, which is how the discussion rail went unnoticed:
 * measured at 1366, 1440 and 1920 it was defensible at all three, and at 1024 it
 * left the prose 534px.
 */
export const DESKTOP_WIDTHS = [1024, 1366, 1440, 1920] as const;

declare global {
  interface Window {
    __omrMouseDrag?: {
      counts: Record<string, number>;
      positions: Record<string, { x: number; y: number }>;
      admittedLanes: number[];
      targets: Record<
        string,
        {
          tag: string;
          classes: string[];
          draggableAncestor: boolean;
          card: boolean;
          laneIndex: number;
        }[]
      >;
      documentEvents: {
        type: string;
        x: number | null;
        y: number | null;
        target: { tag: string; category: string; laneIndex: number };
        scroll: { x: number; y: number; lanes: number[][] };
        geometry: { source: number[] | null; destination: number[] | null };
      }[];
      stop: () => void;
    };
    __omrLaneTouch?: {
      starts: number;
      card: boolean;
      trusted: boolean;
      touchAction: string;
      stop: () => void;
    };
  }
}

/** Served card-origin containment; physical Safari/touch drag remain separate. */
async function laneContainment(
  page: Page,
  check: (name: string, ok: boolean, detail: unknown) => void,
): Promise<void> {
  const selector = '[data-lane-scroll-probe]';
  const origin = await page.evaluate(() => {
    const lane = document.querySelector<HTMLElement>('.board-column-body');
    const card = lane?.querySelector<HTMLElement>('.board-card');
    if (!lane || !card) throw new Error('Lane containment requires a populated open lane');
    lane.dataset['laneScrollProbe'] = '';
    const content = document.createElement('div');
    content.dataset['laneContentProbe'] = '';
    content.style.cssText = 'white-space:nowrap;height:1800px';
    content.textContent = 'unbroken-card-content-'.repeat(100);
    card.append(content);
    lane.scrollTop = 0;
    lane.scrollLeft = 0;
    const box = card.getBoundingClientRect();
    // Explicitly start over a card: touch target adjustment made a nominal
    // two-pixel gutter hit a card too. The user needs scrolling over both.
    return { x: box.left + box.width / 2, y: box.top + 120 };
  });
  const cdp = await page.createCDPSession();
  await page.evaluate(() => {
    const record = (event: TouchEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[data-lane-scroll-probe]')) return;
      const state = window.__omrLaneTouch;
      if (!state) throw new Error('Missing lane touch observer');
      const card = event.target.closest('.board-card');
      state.starts++;
      state.card = card !== null;
      state.trusted = event.isTrusted;
      state.touchAction = card ? getComputedStyle(card).touchAction : '';
    };
    window.__omrLaneTouch = {
      starts: 0,
      card: false,
      trusted: false,
      touchAction: '',
      stop: () => document.removeEventListener('touchstart', record),
    };
    document.addEventListener('touchstart', record, { passive: true });
  });
  const swipe = async (dx: number, dy: number, name: string) => {
    const starts = await page.evaluate(() => window.__omrLaneTouch?.starts ?? 0);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...origin, id: 1 }],
    });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: origin.x + (dx * step) / 6, y: origin.y + (dy * step) / 6, id: 1 }],
      });
      await wait(35);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(500);
    const target = await page.evaluate(() => {
      const state = window.__omrLaneTouch;
      if (!state) throw new Error('Missing lane touch result');
      return {
        starts: state.starts,
        card: state.card,
        trusted: state.trusted,
        touchAction: state.touchAction,
      };
    });
    check(
      `${name} starts on an actual card`,
      target.starts > starts && target.card && target.trusted,
      target,
    );
  };
  const measure = () =>
    page.$eval(selector, (lane) => ({
      left: lane.scrollLeft,
      top: lane.scrollTop,
      wide: lane.scrollWidth > lane.clientWidth + 1,
      tall: lane.scrollHeight > lane.clientHeight + 1,
    }));
  try {
    const before = await measure();
    check(
      'tablet lane probe actually overflows in both directions',
      before.wide && before.tall,
      before,
    );
    await swipe(-100, -20, 'tablet diagonal lane swipe');
    const sideways = await measure();
    check('tablet diagonal lane swipe cannot move content sideways', sideways.left === 0, sideways);
    await swipe(0, -90, 'tablet vertical lane swipe');
    const vertical = await measure();
    check('tablet lane card swipe still scrolls vertically', vertical.top > sideways.top, vertical);
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.wheel({ deltaY: 10000 });
    await wait(500);
    const end = await page.$eval(selector, (lane) => {
      const final = lane.querySelector('.board-card:last-of-type');
      const outer = lane.getBoundingClientRect();
      const inner = final?.getBoundingClientRect();
      return {
        remaining: lane.scrollHeight - lane.clientHeight - lane.scrollTop,
        finalBottom: inner?.bottom ?? null,
        bottom: outer.bottom,
      };
    });
    check(
      'tablet lane can reach its final card',
      end.remaining <= 2 && end.finalBottom !== null && end.finalBottom <= end.bottom + 2,
      end,
    );
  } finally {
    await cdp.detach();
    await page.evaluate(() => {
      window.__omrLaneTouch?.stop();
      delete window.__omrLaneTouch;
      document.querySelector('[data-lane-content-probe]')?.remove();
      const lane = document.querySelector<HTMLElement>('[data-lane-scroll-probe]');
      if (lane) {
        lane.scrollTop = 0;
        delete lane.dataset['laneScrollProbe'];
      }
    });
  }
}

/** Native mouse HTML drag, with a return move to preserve the seeded board. */
async function mouseLaneDrag(
  page: Page,
  check: (name: string, ok: boolean, detail: unknown) => void,
  outDir: string,
): Promise<void> {
  // Navigation can paint the shell before the populated board. Readiness is
  // part of the first native gesture's existing absolute deadline, not an
  // additional allowance for a missing card.
  let firstGestureDeadline: number | null = Date.now() + PATIENCE_MS;
  try {
    const readyCard = await page.waitForSelector('.board-card [data-blip-id]', {
      visible: true,
      timeout: Math.max(1, firstGestureDeadline - Date.now()),
    });
    await readyCard?.dispose();
  } catch (error) {
    const facts = await page
      .evaluate(() => ({
        readyState: document.readyState,
        width: innerWidth,
        height: innerHeight,
        shell: document.querySelector('.app-main') !== null,
        loadingIndicatorCount: document.querySelectorAll('.app-main .sweep').length,
        boardCount: document.querySelectorAll('.board').length,
        laneCount: document.querySelectorAll('.board-column').length,
        cardCount: document.querySelectorAll('.board-card').length,
        identityCount: document.querySelectorAll('.board-card [data-blip-id]').length,
      }))
      .catch(() => null);
    const screenshot = await shot(page, outDir, 'desktop-mouse-readiness-failure')
      .then(() => true)
      .catch(() => false);
    console.log('[mouse lane readiness failure]', JSON.stringify({ facts, screenshot }));
    throw error;
  }
  const id = await page.$eval('.board-card [data-blip-id]', (card) =>
    card.getAttribute('data-blip-id'),
  );
  if (!id) throw new Error('Missing card identity for mouse drag regression');
  const cardSelector = `.board-card:has([data-blip-id="${id}"])`;
  const dragTo = async (index: number, originalTouch: boolean) => {
    const originalCard = await page.$(cardSelector);
    if (!originalCard) throw new Error('Missing original mouse drag card');
    const savedTouch = await originalCard.evaluate((card, baseline) => {
      if (!(card instanceof HTMLElement)) throw new Error('Mouse drag card must be HTML');
      const saved = {
        value: card.style.getPropertyValue('touch-action'),
        priority: card.style.getPropertyPriority('touch-action'),
      };
      if (baseline) card.style.setProperty('touch-action', 'none');
      return saved;
    }, originalTouch);
    const runGesture = async () => {
      const sourceElement = await page.$(`${cardSelector} .blip-body`);
      if (!sourceElement) throw new Error('Missing native mouse source element');
      const lanes = await page.$$('.board-column');
      const targetElement = lanes[index];
      if (!targetElement) {
        await Promise.all([sourceElement.dispose(), ...lanes.map((lane) => lane.dispose())]);
        throw new Error('Missing native mouse destination element');
      }
      try {
        await sourceElement.scrollIntoView();
        const source = await sourceElement.clickablePoint();
        const sourceReady = await sourceElement.evaluate((body, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          const card = body.closest('.board-card');
          return (
            card instanceof HTMLElement &&
            card.draggable &&
            hit instanceof Element &&
            body.contains(hit) &&
            hit.closest('.board-card') === card &&
            !hit.closest('button, input, select, textarea, a, [contenteditable="true"]')
          );
        }, source);
        if (!sourceReady)
          throw new Error(
            'Native drag source must hit its noninteractive body inside the draggable card',
          );
        const target = await targetElement.clickablePoint();
        const context = await page.evaluate(
          (points) => {
            const card = document.querySelector(points.cardSelector);
            if (!card) throw new Error('Missing card while recording mouse baseline');
            const inspect = (element: Element | null) => {
              const chain = [];
              for (let depth = 0; element && depth < 6; depth++) {
                chain.push({
                  tag: element.tagName,
                  classes: Array.from(element.classList).slice(0, 8),
                  draggableAncestor: element.closest('[draggable="true"]') !== null,
                  card: element.classList.contains('board-card'),
                  laneIndex: Array.from(document.querySelectorAll('.board-column')).indexOf(
                    element.closest('.board-column') ?? element,
                  ),
                });
                element = element.parentElement;
              }
              return chain;
            };
            const counts: Record<string, number> = {};
            const positions: Record<string, { x: number; y: number }> = {};
            const admittedLanes: number[] = [];
            const targets: NonNullable<Window['__omrMouseDrag']>['targets'] = {};
            const documentEvents: NonNullable<Window['__omrMouseDrag']>['documentEvents'] = [];
            const documentTypes = [
              'mousemove',
              'mousedown',
              'dragstart',
              'dragenter',
              'dragover',
              'drop',
              'dragend',
            ];
            const documentRecord = (event: Event) => {
              const target = event.target instanceof Element ? event.target : null;
              const targetLane = target?.closest('.board-column');
              const columns = Array.from(document.querySelectorAll('.board-column'));
              const box = (element: Element | null) => {
                if (!element) return null;
                const bounds = element.getBoundingClientRect();
                return [bounds.left, bounds.top, bounds.right, bounds.bottom];
              };
              documentEvents.push({
                type: event.type,
                x: event instanceof MouseEvent ? event.clientX : null,
                y: event instanceof MouseEvent ? event.clientY : null,
                target: {
                  tag: target?.tagName ?? 'NON_ELEMENT',
                  category: target?.closest('.board-card')
                    ? 'card'
                    : target?.closest('.board-column-rail')
                      ? 'rail'
                      : target?.closest('.board-column')
                        ? 'lane'
                        : target?.closest('.board')
                          ? 'board'
                          : 'outside-board',
                  laneIndex: targetLane ? columns.findIndex((column) => column === targetLane) : -1,
                },
                scroll: {
                  x: scrollX,
                  y: scrollY,
                  lanes: columns.map((column) => {
                    const body = column.querySelector('.board-column-body');
                    return [body?.scrollLeft ?? 0, body?.scrollTop ?? 0];
                  }),
                },
                geometry: {
                  source: box(document.querySelector(points.cardSelector)),
                  destination: box(columns[points.index] ?? null),
                },
              });
              if (documentEvents.length > 32) documentEvents.shift();
            };
            const types = ['mousedown', 'dragstart', 'dragover', 'drop', 'dragend'];
            const record = (event: Event) => {
              if (!(event.target instanceof Element) || !event.target.closest('.board')) return;
              counts[event.type] = (counts[event.type] ?? 0) + 1;
              if (event instanceof MouseEvent)
                positions[event.type] = { x: event.clientX, y: event.clientY };
              targets[event.type] = inspect(event.target);
            };
            /*
             * Admission is a dragover the lane answered with preventDefault, read after
             * the app's handler has run (a bubble listener; React listens at the root).
             * It was the `is-over` class, which a lane only paints if React commits
             * between the dragover and the drop that follows it in the same breath:
             * the one dragover is a continuous-priority update, the drop's setOver(null)
             * supersedes it, and under load the class was never painted at all.
             */
            const admit = (event: Event) => {
              if (!event.defaultPrevented || !(event.target instanceof Element)) return;
              const at = Array.from(document.querySelectorAll('.board-column')).indexOf(
                event.target.closest('.board-column') ?? event.target,
              );
              if (at >= 0 && !admittedLanes.includes(at)) admittedLanes.push(at);
            };
            document.addEventListener('dragover', admit);
            for (const type of types)
              document.addEventListener(type, record, { capture: true, passive: true });
            for (const type of documentTypes)
              document.addEventListener(type, documentRecord, { capture: true, passive: true });
            window.__omrMouseDrag = {
              documentEvents,
              counts,
              positions,
              admittedLanes,
              targets,
              stop: () => {
                for (const type of types) document.removeEventListener(type, record, true);
                for (const type of documentTypes)
                  document.removeEventListener(type, documentRecord, true);
                document.removeEventListener('dragover', admit);
              },
            };
            return {
              cardTouchAction: getComputedStyle(card).touchAction,
              viewport: {
                width: innerWidth,
                height: innerHeight,
                maxTouchPoints: navigator.maxTouchPoints,
                coarse: matchMedia('(pointer: coarse)').matches,
              },
              source: {
                ...points.source,
                hit: inspect(document.elementFromPoint(points.source.x, points.source.y)),
              },
              destination: {
                ...points.target,
                hit: inspect(document.elementFromPoint(points.target.x, points.target.y)),
              },
            };
          },
          { source, target, cardSelector, index },
        );
        const destinationGeometry = () =>
          page.evaluate(
            (point) => {
              const lane = document.querySelectorAll('.board-column')[point.index];
              if (!lane) throw new Error('Missing current drag destination');
              const box = lane.getBoundingClientRect();
              const actual = window.__omrMouseDrag?.positions['dragover'];
              const hitPoint = actual ?? point;
              const hit = document.elementFromPoint(hitPoint.x, hitPoint.y);
              return {
                hitPoint: { x: hitPoint.x, y: hitPoint.y },
                box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
                classes: Array.from(lane.classList).slice(0, 8),
                hit: hit
                  ? {
                      tag: hit.tagName,
                      classes: Array.from(hit.classList).slice(0, 8),
                      laneIndex: Array.from(document.querySelectorAll('.board-column')).indexOf(
                        hit.closest('.board-column') ?? hit,
                      ),
                    }
                  : null,
              };
            },
            { ...target, index },
          );
        let afterGesture: unknown = null;
        let destinationReady = false;
        const deadline = firstGestureDeadline ?? Date.now() + PATIENCE_MS;
        firstGestureDeadline = null;
        const response = page
          .waitForResponse(
            (reply) =>
              new URL(reply.url()).pathname === `/api/blips/${id}` &&
              reply.request().method() === 'PATCH',
            { timeout: Math.max(1, deadline - Date.now()) },
          )
          .catch(() => null);
        let nativeDropElapsedMs: number | null = null;
        const dragovers = await page.evaluate(() => window.__omrMouseDrag?.counts['dragover'] ?? 0);
        try {
          // Installed nondeprecated drop(source) owns one drag and release,
          // resetting its internal drag lifecycle without intercepted payloads.
          const nativeDropStartedAt = Date.now();
          await new Promise<void>((resolve, reject) => {
            let timedOut = false;
            const timer = setTimeout(
              () => {
                timedOut = true;
                // Terminate this scratch page before rejecting: no native input
                // can leak into the return/current pair after the deadline.
                void page.close().then(
                  () => {
                    reject(
                      new Error('Native element drop exceeded the 20-second fixture deadline'),
                    );
                  },
                  (error: unknown) => {
                    reject(
                      error instanceof Error
                        ? error
                        : new Error('Scratch page closure rejected unexpectedly'),
                    );
                  },
                );
              },
              Math.max(1, deadline - Date.now()),
            );
            void targetElement.drop(sourceElement).then(
              () => {
                clearTimeout(timer);
                if (!timedOut) resolve();
              },
              (error: unknown) => {
                clearTimeout(timer);
                if (!timedOut)
                  reject(
                    error instanceof Error
                      ? error
                      : new Error('Native element drop rejected unexpectedly'),
                  );
              },
            );
          });
          nativeDropElapsedMs = Date.now() - nativeDropStartedAt;
          destinationReady = await page
            .waitForFunction(
              (expected) => {
                const state = window.__omrMouseDrag;
                const lane = document.querySelectorAll('.board-column')[expected.index];
                return Boolean(
                  state &&
                  lane &&
                  (state.counts['dragover'] ?? 0) > expected.dragovers &&
                  state.targets['dragover']?.[0]?.laneIndex === expected.index &&
                  state.targets['drop']?.[0]?.laneIndex === expected.index &&
                  state.admittedLanes.includes(expected.index),
                );
              },
              { timeout: Math.max(1, deadline - Date.now()) },
              { index, dragovers },
            )
            .then(() => true)
            .catch(() => false);
          afterGesture = await destinationGeometry();
        } catch (error) {
          if (!page.isClosed()) await page.mouse.reset();
          throw error;
        }
        const reply = await response;
        const events = await page.evaluate(() => {
          const state = window.__omrMouseDrag;
          if (!state) throw new Error('Missing mouse drag diagnostic');
          const result = {
            documentEvents: state.documentEvents,
            counts: state.counts,
            positions: state.positions,
            admittedLanes: state.admittedLanes,
            targets: state.targets,
          };
          state.stop();
          delete window.__omrMouseDrag;
          return result;
        });
        console.log(
          '[mouse lane drag]',
          JSON.stringify({
            direction: index === 1 ? 'outward' : 'return',
            inputPath: 'element-associated-native',
            originalTouch,
            nativeDropElapsedMs,
            destinationReady,
            configuredHasTouch: page.viewport()?.hasTouch ?? false,
            context,
            helperBoundary: 'native drop owns drag and release; admission observed afterward',
            afterGesture,
            afterRelease: await destinationGeometry(),
            events,
            status: reply?.status() ?? null,
          }),
        );
        if (!destinationReady || !reply?.ok())
          return { status: reply?.status() ?? null, destinationReady, moved: false };
        const destinationRail = await targetElement.$('.board-column-rail');
        if (destinationRail) {
          try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              await page.close();
              throw new Error('Native lane opening exhausted the 20-second fixture deadline');
            }
            await new Promise<void>((resolve, reject) => {
              let timedOut = false;
              const timer = setTimeout(() => {
                timedOut = true;
                void page.close().then(
                  () =>
                    reject(
                      new Error('Native lane opening exceeded the 20-second fixture deadline'),
                    ),
                  (error: unknown) =>
                    reject(
                      error instanceof Error
                        ? error
                        : new Error('Scratch page closure rejected unexpectedly'),
                    ),
                );
              }, remaining);
              void destinationRail.click().then(
                () => {
                  clearTimeout(timer);
                  if (!timedOut) resolve();
                },
                (error: unknown) => {
                  clearTimeout(timer);
                  if (!timedOut)
                    reject(
                      error instanceof Error
                        ? error
                        : new Error('Native lane opening rejected unexpectedly'),
                    );
                },
              );
            });
          } finally {
            await destinationRail.dispose();
          }
        }
        await page.waitForFunction(
          (args) => {
            const card = document.querySelector(args.selector);
            return (
              card?.closest('.board-column') ===
              document.querySelectorAll('.board-column')[args.index]
            );
          },
          { timeout: Math.max(1, deadline - Date.now()) },
          { selector: cardSelector, index },
        );
        return { status: reply.status(), destinationReady, moved: true };
      } finally {
        await Promise.all([sourceElement.dispose(), ...lanes.map((lane) => lane.dispose())]);
      }
    };
    let result: Awaited<ReturnType<typeof runGesture>> | undefined;
    let primaryFailed = false;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      result = await runGesture();
    } catch (error) {
      primaryFailed = true;
      primaryFailure = error;
    } finally {
      try {
        if (!page.isClosed()) {
          const restore = (card: Element, saved: { value: string; priority: string }) => {
            if (!(card instanceof HTMLElement))
              throw new Error('Mouse baseline restoration requires an HTML card');
            if (saved.value) card.style.setProperty('touch-action', saved.value, saved.priority);
            else card.style.removeProperty('touch-action');
            if (
              card.style.getPropertyValue('touch-action') !== saved.value ||
              card.style.getPropertyPriority('touch-action') !== saved.priority
            )
              throw new Error('Mouse baseline did not restore original inline touch declaration');
          };
          await originalCard.evaluate(restore, savedTouch);
          const currentCard = await page.$(cardSelector);
          if (currentCard) {
            try {
              await currentCard.evaluate(restore, savedTouch);
            } finally {
              await currentCard.dispose();
            }
          }
        }
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      } finally {
        try {
          await originalCard.dispose();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        primaryFailed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
        'Native mouse drag or style restoration failed',
      );
    if (primaryFailed) throw primaryFailure;
    if (!result) throw new Error('Native mouse drag produced no result');
    return result;
  };
  try {
    const exercise = async (originalTouch: boolean) => {
      const prefix = originalTouch
        ? 'desktop original-touch baseline'
        : 'desktop native mouse drag';
      const outward = await dragTo(1, originalTouch);
      check(`${prefix} moves a card to another lane`, outward.moved, outward);
      if (!outward.moved) return false;
      const returned = await dragTo(0, originalTouch);
      check(`${prefix} restores the original lane`, returned.moved, returned);
      return returned.moved;
    };
    if (await exercise(true)) await exercise(false);
  } finally {
    if (!page.isClosed())
      await page.evaluate(() => {
        window.__omrMouseDrag?.stop();
        delete window.__omrMouseDrag;
      });
  }
}

/** Viewport heights paired with them — the laptop is the cruel one. */
const HEIGHTS: Record<(typeof DESKTOP_WIDTHS)[number], number> = {
  1024: 768,
  1366: 768,
  1440: 900,
  1920: 1080,
};

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/**
 * The vertical chrome budget, in CSS pixels, between the top of a radar's
 * content column and its first blip.
 *
 * Measured at 270px before this work — a bearing strip, an always-expanded
 * three-line composer, a search box and a tag chip row — which is 32% of a
 * 900px viewport and worse on a 768px laptop. The board's first lane header
 * landed at y=362 on a 33-card radar.
 *
 * 190 is not a round number chosen for comfort: it is above what the collapsed
 * composer plus one filter row measures, and below what any of the arrangements
 * this replaced measured. A change that pushes past it is a change that has put
 * a band of chrome back, and it should have to say so.
 */
const CHROME_BUDGET_PX = 190;

export async function runDesktopSweep(
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

  page.on('pageerror', (err) => failures.push(`page error (desktop): ${String(err)}`));
  await page.setUserAgent({ userAgent: DESKTOP_UA });

  /*
   * Sign back in.
   *
   * The phone sweep deletes every cookie on purpose — the public-radar and
   * invitation sections have to be read the way a stranger reads them, and a
   * logged-in page redirects straight past an invitation. So by the time control
   * reaches here there is no session, and every measurement below would be taken
   * against the sign-in screen: `.app-sidebar` absent, no blips, no sections,
   * and eleven confident failures with nothing to do with layout. Which is
   * exactly what happened on the first run.
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
    // Wait on the frame rather than on a clock, for the reason the phone sweep
    // carries at length: the shell paints before the route data arrives.
    await page.waitForSelector('.app-main', { timeout: PATIENCE_MS }).catch(() => null);
    await wait(500);
  };

  const board = seeded.radars.find((r) => r.template === 'kanban');
  const discussion = seeded.radars.find((r) => r.template === 'discussion');
  const stream = seeded.radars.find((r) => r.template === 'stream');
  if (!board || !discussion || !stream) {
    throw new Error('the seed is missing a board, a discussion or a stream to measure');
  }

  // Exercise the actual scroll containers, including a route-loading sibling
  // before the frame. A percentage-height shell used to move with that sibling.
  for (const width of [390, 1366]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    await goto('/radars');
    await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      if (!shell) throw new Error('No .app-shell on the page');
      const pending = document.createElement('div');
      pending.dataset['scrollFixture'] = 'pending';
      pending.style.height = '120px';
      pending.textContent = 'Loading';
      shell.before(pending);
      for (const selector of ['.nav-pane', '.sidebar-nav']) {
        const spacer = document.createElement('div');
        spacer.dataset['scrollFixture'] = 'content';
        spacer.style.height = '3000px';
        spacer.style.flexShrink = '0';
        const host = document.querySelector(selector);
        if (!host) throw new Error(`Nothing matches ${selector}`);
        host.append(spacer);
      }
    });
    const measure = () =>
      page.evaluate(() => {
        const found = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Nothing matches ${selector}`);
          return element;
        };
        const rect = (selector: string) => {
          const box = found(selector).getBoundingClientRect();
          return { top: box.top, bottom: box.bottom };
        };
        return {
          shell: rect('.app-shell'),
          head: rect('.sidebar-head'),
          foot: rect('.sidebar-foot'),
          tabs: rect('.app-tabbar'),
          main: found('.app-content').scrollTop,
          nav: found('.sidebar-nav').scrollTop,
          documentTop: window.scrollY,
          documentHeight: document.documentElement.scrollHeight,
          viewport: innerHeight,
        };
      });
    const before = await measure();
    await page.mouse.move(width - 80, 400);
    await page.mouse.wheel({ deltaY: 650 });
    await wait(250);
    const mainScrolled = await measure();
    check(
      `[${width}] main scroll stays inside a viewport-locked shell`,
      mainScrolled.main > before.main &&
        mainScrolled.shell.top === 0 &&
        mainScrolled.shell.bottom === mainScrolled.viewport &&
        mainScrolled.documentTop === 0 &&
        mainScrolled.documentHeight <= mainScrolled.viewport + 1,
      mainScrolled,
    );
    if (width >= 1024) {
      await page.mouse.move(150, 400);
      await page.mouse.wheel({ deltaY: 650 });
      await wait(250);
      const navScrolled = await measure();
      check(
        'sidebar scroll is independent and keeps its header and footer visible',
        navScrolled.nav > mainScrolled.nav &&
          navScrolled.main === mainScrolled.main &&
          navScrolled.head.top === before.head.top &&
          navScrolled.foot.bottom === before.foot.bottom &&
          navScrolled.foot.bottom <= navScrolled.viewport &&
          navScrolled.documentTop === 0,
        navScrolled,
      );
    } else {
      check(
        'phone navigation stays at the viewport bottom while content scrolls',
        mainScrolled.tabs.bottom === mainScrolled.viewport && mainScrolled.tabs.top > 0,
        mainScrolled,
      );
    }
    await page.evaluate(() => {
      document.querySelectorAll('[data-scroll-fixture]').forEach((node) => node.remove());
    });
  }

  for (const width of DESKTOP_WIDTHS) {
    const height = HEIGHTS[width];
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const at = `[${width}]`;

    /* ------------------------------------------------------ the shell ----- */

    await goto('/radars');
    await shot(page, outDir, `d${width}-radars`);

    const shell = await page.evaluate(() => {
      const aside = document.querySelector('.app-sidebar');
      const main = document.querySelector('.app-main');
      const doc = document.documentElement;
      return {
        sidebarWidth: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
        mainLeft: main ? Math.round(main.getBoundingClientRect().left) : null,
        scrollsSideways: doc.scrollWidth > doc.clientWidth + 1,
        // The tab bar is the phone's navigation and must not appear here.
        tabBarPainted: (document.querySelector('.app-tabbar')?.getClientRects().length ?? 0) > 0,
      };
    });
    notes.push({ what: `shell at ${width}`, ...shell });

    check(`${at} the desktop shell shows a sidebar, not the phone tab bar`, !shell.tabBarPainted, {
      tabBarPainted: shell.tabBarPainted,
    });
    check(`${at} the sidebar is expanded above its breakpoint`, shell.sidebarWidth >= 200, {
      sidebarWidth: shell.sidebarWidth,
    });
    check(`${at} the page does not scroll sideways`, !shell.scrollsSideways, shell);

    /* ------------------------------------------- the furled rail's labels -- */

    /*
     * Furled, the rail is glyphs; pointing at one, or tabbing to it, floats its
     * name (and count or shortcut) beside it over the page. Asserted by what a
     * person sees: the label's text, that it takes no pointer events, that it
     * stays inside the viewport — and that the page's layout does not move,
     * which is the difference between a label and a panel.
     */
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[aria-label="Collapse the sidebar"]')?.click(),
    );
    await wait(400);
    const mainWidth = () =>
      page.evaluate(() =>
        Math.round(document.querySelector('.app-main')?.getBoundingClientRect().width ?? 0),
      );
    const railLabel = () =>
      page.evaluate(() => {
        const shown = document.querySelector('.rail-label.is-shown');
        if (!shown) return null;
        const r = shown.getBoundingClientRect();
        return {
          text: shown.textContent,
          passesPointer: getComputedStyle(shown).pointerEvents === 'none',
          inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        };
      });
    const furledWidth = await mainWidth();
    const agentsItem = await page.$('.app-sidebar [data-rail-label="Agents"]');
    await agentsItem?.hover();
    await wait(250);
    const hovered = await railLabel();
    const whileShown = await mainWidth();
    await page.mouse.move(width - 20, 400);
    await wait(200);
    const afterLeave = await railLabel();
    await page.focus('[aria-label="Expand the sidebar"]');
    await page.keyboard.press('Tab');
    await wait(250);
    const focused = await railLabel();
    const focusedName = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-rail-label'),
    );
    const titles = await page.evaluate(
      () => document.querySelectorAll('.app-sidebar [data-rail-label][title]').length,
    );
    notes.push({ what: `rail labels at ${width}`, hovered, focused, focusedName, titles });
    check(
      `${at} hovering a rail item floats its name beside it, over the page`,
      hovered?.text === 'Agents' && hovered.passesPointer && hovered.inside,
      hovered,
    );
    check(`${at} and the page layout does not move`, whileShown === furledWidth, {
      furledWidth,
      whileShown,
    });
    check(`${at} and it goes when the pointer does`, afterLeave === null, afterLeave);
    check(
      `${at} keyboard focus on a rail item shows its name too`,
      focused !== null && focused.text === focusedName,
      { focused, focusedName },
    );
    check(`${at} the rail carries no native title tooltips to double it`, titles === 0, {
      titles,
    });
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[aria-label="Expand the sidebar"]')?.click(),
    );
    await wait(400);

    /* -------------------------------------------- chrome above content ---- */

    /*
     * The 270px finding, measured rather than eyeballed: from the top of the
     * content column to the top of the first blip. On a 768px laptop that band
     * was a third of the screen before a single word of anybody's thinking.
     */
    await goto(`/radar/${stream.id}`);
    await shot(page, outDir, `d${width}-radar-stream`);

    const chrome = await page.evaluate(() => {
      const main = document.querySelector('.app-main');
      const first = document.querySelector('[data-blip-id]');
      const header = main?.querySelector('.app-content header');
      if (!main || !first || !header) return null;
      return {
        headerBottom: Math.round(header.getBoundingClientRect().bottom),
        firstBlipTop: Math.round(first.getBoundingClientRect().top),
        composerRows: document.querySelectorAll('#composer').length,
        filterRows: document.querySelectorAll('.filter-rail').length,
      };
    });
    notes.push({ what: `chrome above content at ${width}`, ...(chrome ?? {}) });

    check(`${at} a radar renders a first blip to measure against`, chrome !== null, chrome);
    if (chrome) {
      const band = chrome.firstBlipTop - chrome.headerBottom;
      notes.push({ what: `chrome band at ${width}`, band, budget: CHROME_BUDGET_PX });
      check(
        `${at} the chrome between the header and the first blip is under ${CHROME_BUDGET_PX}px`,
        band <= CHROME_BUDGET_PX,
        { band, budget: CHROME_BUDGET_PX, ...chrome },
      );
      check(
        `${at} the capture box is still there — the budget must not be met by removing it`,
        chrome.composerRows === 1,
        chrome,
      );
      check(`${at} and the filters are one row, not two`, chrome.filterRows === 1, chrome);
    }

    /*
     * And it grows when there is something to capture.
     *
     * The budget above could be met by a box that cannot be used, so the two
     * assertions belong together: one line at rest, and the toolbar — the
     * inference preview and Capture — arriving with the first character. Typed
     * with real key events rather than by setting `value`, because React's
     * controlled input only sees the second one.
     */
    await page.click('#composer');
    await page.type('#composer', 'a thought');
    await wait(300);
    await shot(page, outDir, `d${width}-composer-open`);

    const open = await page.evaluate(() => {
      const field = document.querySelector('#composer');
      const panel = field?.closest('.panel') ?? null;
      const buttons = [...(panel?.querySelectorAll('button') ?? [])]
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => b.textContent.trim());
      return {
        panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        hasCapture: buttons.some((t) => /capture|drop it in/i.test(t)),
      };
    });
    notes.push({ what: `composer opened at ${width}`, ...open });
    check(`${at} the composer grows once there is something to capture`, open.hasCapture, open);

    /*
     * An unsent capture is a draft now: it survives leaving the radar, so the
     * next width's visit would measure an expanded box against the at-rest
     * budget above. Asserted, then cleared the way a person would — which is
     * also the proof that clearing the box clears the draft.
     */
    await goto(`/radar/${stream.id}`);
    const kept = await page.evaluate(
      () => document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? null,
    );
    check(
      `${at} an unsent capture is still there after leaving and coming back`,
      kept === 'a thought',
      {
        kept,
      },
    );
    await page.focus('#composer');
    await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('#composer')?.select());
    await page.keyboard.press('Backspace');
    await wait(200);
    await goto(`/radar/${stream.id}`);
    const cleared = await page.evaluate(
      () => document.querySelector<HTMLTextAreaElement>('#composer')?.value ?? null,
    );
    check(`${at} clearing the box clears the draft`, cleared === '', { cleared });

    /* -------------------------------------------------- the lane budget --- */

    await goto(`/radar/${board.id}`);
    await shot(page, outDir, `d${width}-radar-board`);

    const lanes = await page.evaluate(() => {
      const columns = [...document.querySelectorAll('.board-column')].filter(
        (el) => el.getClientRects().length > 0,
      );
      const rail = document.querySelector('.board');
      return {
        count: columns.length,
        widths: columns.map((el) => Math.round(el.getBoundingClientRect().width)),
        boardWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
        scrollsSideways: rail ? rail.scrollWidth > rail.clientWidth + 1 : null,
      };
    });
    notes.push({ what: `lanes at ${width}`, ...lanes });

    /*
     * The count is a guarantee. `79c3f5d5` proposed a sixth lane and was closed
     * without one — retention is going the archiving route instead — so five is
     * settled rather than pending, and a change to it should be a deliberate act
     * that trips this rather than a side effect of a layout tweak.
     *
     * The widths are recorded and not asserted. See the note at the top.
     */
    check(`${at} the kanban board draws five lanes`, lanes.count === 5, lanes);

    /*
     * And it never scrolls sideways. This was recorded and not asserted while
     * `23083131` was live, because the two reports consolidated on it pulled
     * against each other and a suite should not take a side in an argument.
     *
     * That half is settled now: measured at 1024, 1152, 1280, 1366, 1440 and
     * 1920 the board does not scroll horizontally at any of them, and on a phone
     * it is a pager. "I am adamantly opposed to horizontal scrolling of blips in
     * the kanban" is a standing constraint rather than a report, so it becomes a
     * guarantee here. The lane *widths* stay recorded — density is a judgement,
     * scrolling is not.
     */
    check(
      `${at} and the board still does not scroll sideways`,
      lanes.scrollsSideways === false,
      lanes,
    );

    if (width === 1024) {
      await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: true });
      await goto(`/radar/${board.id}`);
      await laneContainment(page, check);
      await shot(page, outDir, 'tablet-lane-containment');
      await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: false });
      await goto(`/radar/${board.id}`);
      await mouseLaneDrag(page, check, outDir);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, hasTouch: true });
      await goto(`/radar/${board.id}`);
      await laneContainment(page, check);
      await shot(page, outDir, 'phone-lane-containment');
      await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: false });
      await goto(`/radar/${board.id}`);
    }

    /* ------------------------------------------------ railed lanes -------- */

    /*
     * A lane the budget rails — an empty working lane gives its width to lanes
     * with cards in — must still read as a lane: its name painted in full (not
     * ellipsised), its count, a target wide enough to hit, and a name that says
     * both. At 1920 all five kanban lanes are open and there is no rail at all.
     */
    const rails = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.board-column-rail')]
        .filter((rail) => rail.getClientRects().length > 0)
        .map((rail) => {
          const label = rail.querySelector<HTMLElement>('.board-column-label');
          return {
            name: rail.getAttribute('aria-label') ?? '',
            label: label?.textContent ?? '',
            labelWhole: label ? label.scrollHeight <= label.clientHeight + 1 : false,
            // The column, which is the designed `--lane-rail` (44px); the button
            // fills it inside its 1px border.
            width: Math.round(
              (rail.closest('.board-column') ?? rail).getBoundingClientRect().width,
            ),
          };
        }),
    );
    notes.push({ what: `railed lanes at ${width}`, rails });
    if (width >= 1920) {
      check(`${at} every kanban lane is open, none railed`, rails.length === 0, rails);
    }
    for (const rail of rails) {
      check(
        `${at} the ${rail.label} rail reads as a lane: whole name, count, and a hittable width`,
        rail.labelWhole &&
          rail.width >= 44 &&
          rail.name.startsWith(`Open ${rail.label}, `) &&
          /\d+ cards?$/.test(rail.name),
        rail,
      );
    }

    /* -------------------------------------------- a hovered board card -- */

    /*
     * Paint order, not geometry. The in-lane toolbar used to float over the
     * card (absolute, z-10) and lay over the comment count: a click at the
     * count's centre landed on "Lane for …" and opened the lane menu. Two
     * boxes overlapping is only a defect if the wrong one takes the click, so
     * the question is asked the way the pointer asks it — elementFromPoint —
     * with the card hovered, which is when the toolbar paints.
     */
    const card = await page.$('.board-card:has(.card-discuss)');
    check(`${at} a board card with a comment button to test`, card !== null);
    if (card) {
      await card.hover();
      await wait(250);
      const hits = await card.evaluate((el) => {
        const at = (target: Element | null) => {
          if (!target) return null;
          const r = target.getBoundingClientRect();
          return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        };
        const discuss = el.querySelector('.card-discuss');
        const firstLine = el.querySelector('.blip-body, h3');
        const lineHit = firstLine
          ? document.elementFromPoint(
              firstLine.getBoundingClientRect().right - 8,
              firstLine.getBoundingClientRect().top + 6,
            )
          : null;
        return {
          discussHit: at(discuss)?.closest('.card-discuss') === discuss,
          discussHitWas: at(discuss)?.getAttribute('aria-label') ?? at(discuss)?.className ?? null,
          firstLineClear: firstLine ? !lineHit?.closest('.blip-actions') : null,
        };
      });
      notes.push({ what: `hovered board card at ${width}`, ...hits });
      check(
        `${at} a hovered board card's comment button takes its own click`,
        hits.discussHit,
        hits,
      );
      check(
        `${at} and its toolbar does not cover the card's first line`,
        hits.firstLineClear === true,
        hits,
      );
    }

    /* ------------------------------------------------- the settings page -- */

    await goto(`/radar/${board.id}/settings?section=appearance`);
    await page.evaluate(() => {
      const colour = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Colour',
      );
      colour?.click();
    });
    await wait(400);
    await shot(page, outDir, `d${width}-radar-settings`);

    const settings = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.section-tab')].filter(
        (el) => el.getClientRects().length > 0,
      );
      const nested = [...document.querySelectorAll('.app-main *')].filter((el) => {
        if (el.getClientRects().length === 0) return false;
        // `.app-content` is the shell's own scroll pane — on a desktop it IS
        // the page, and counting it would make this assertion unfailable-in-
        // reverse rather than unfailable.
        if (el.classList.contains('app-content')) return false;
        const style = getComputedStyle(el);
        return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
      });
      const save = document.querySelector('[data-role="settings-save"]');
      return {
        tabs: tabs.map((el) => el.textContent.trim()),
        nestedScrollers: nested.map((el) => (el.getAttribute('class') ?? '').slice(0, 60)),
        saveOnScreen: save ? save.getBoundingClientRect().bottom <= window.innerHeight + 1 : false,
      };
    });
    notes.push({ what: `settings at ${width}`, ...settings });

    check(
      `${at} the settings page is a tab strip`,
      ['Identity', 'Appearance', 'People', 'Sources', 'Webhooks'].every((label) =>
        settings.tabs.some((tab) => tab.startsWith(label)),
      ),
      settings,
    );
    check(
      `${at} nothing scrolls inside the page that already scrolls`,
      settings.nestedScrollers.length === 0,
      { nestedScrollers: settings.nestedScrollers },
    );
    check(`${at} the primary action is on screen`, settings.saveOnScreen, settings);

    /* ----------------------------------------------------- the topic page - */

    await goto(`/array/${seeded.topicId}`);
    await shot(page, outDir, `d${width}-topic`);

    const topic = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('main section')].filter(
        (el) => el.getClientRects().length > 0,
      );
      const cascade = [...document.querySelectorAll('button')].find((b) =>
        /share every radar/i.test(b.textContent),
      );
      const main = document.querySelector('.app-main');
      return {
        sectionCount: sections.length,
        // Every section is label-outside-panel, so the gap from a section's top
        // to the next one is the same all the way down. Three container idioms
        // with three different gaps is what made this page read as three
        // components pasted together.
        gaps: sections
          .slice(1)
          .map((el, at) =>
            Math.round(
              el.getBoundingClientRect().top -
                (sections[at]?.getBoundingClientRect().bottom ?? el.getBoundingClientRect().top),
            ),
          ),
        cascadeWidth: cascade ? Math.round(cascade.getBoundingClientRect().width) : null,
        contentWidth: main
          ? Math.round(
              main.querySelector('section')?.getBoundingClientRect().width ??
                main.getBoundingClientRect().width,
            )
          : null,
      };
    });
    notes.push({ what: `topic page at ${width}`, ...topic });

    check(`${at} the array page has its sections`, topic.sectionCount >= 3, topic);
    check(
      `${at} every section is spaced the same way — one rhythm, not three`,
      topic.gaps.length > 0 && new Set(topic.gaps).size === 1,
      { gaps: topic.gaps },
    );
    /*
     * The riskiest control on the page is not the loudest thing on it.
     *
     * "Share every radar in it" was a full-width, full-saturation accent
     * gradient — the weight of a primary call to action — on the one switch that
     * grants access to every radar in the topic and every radar added
     * afterwards, while "Add a radar" (safe) was a quiet ghost link beside it.
     * Weight inverted against risk. Asserted as width rather than as colour
     * because width is what "full-width CTA" actually means here.
     */
    check(
      `${at} the cascade switch is a normal-width control, not a full-width CTA`,
      topic.cascadeWidth !== null &&
        topic.contentWidth !== null &&
        topic.cascadeWidth < topic.contentWidth * 0.75,
      { cascadeWidth: topic.cascadeWidth, contentWidth: topic.contentWidth },
    );

    /* ------------------------------------------------------- a discussion - */

    await goto(`/radar/${discussion.id}`);
    await shot(page, outDir, `d${width}-radar-discussion`);
  }

  /* ---------------------------------------------- every template, per width - */

  /*
   * Every template is photographed at 1920, 1440, 1024 and 390, and at each width holds that
   * nothing scrolls sideways. The columns answer to the pane, which is the viewport less a 264px
   * sidebar from 1024 up: 1920 is a 1656px pane (xl), 1440 is 1176 (lg), 1024 is 760 and 390 has
   * no sidebar, both below the 1000px threshold where every template is its single column.
   *
   * At 1440 and 1920 the template's columns (or, for a board and the map, its root) must span at
   * least 90% of the pane, and the columns it declares sit side by side. One table, by seeded
   * template: the page itself never branches on one.
   */
  const COLUMN =
    '.cols > :is(.cols-index, .cols-main, .cols-panel), .radar-cols > :is(.radar-rail, .radar-main)';
  const SHAPES: Record<string, (width: number) => { side: string[]; folded?: string }> = {
    stream: () => ({ side: ['.radar-rail', '.radar-main'] }),
    reading: () => ({ side: ['.radar-rail', '.radar-main'] }),
    microblog: () => ({ side: ['.cols-index', '.cols-main', '.cols-panel'] }),
    // The log keeps its context beside the decision at lg too (a narrow column, not a strip above).
    decisions: () => ({ side: ['.cols-index', '.cols-main', '.cols-panel'] }),
    discussion: (width) =>
      width >= 1500 + 264
        ? { side: ['.cols-index', '.cols-main', '.cols-panel'] }
        : { side: ['.cols-index', '.cols-main'], folded: '.cols-panel' },
    kanban: () => ({ side: [] }),
    helpdesk: () => ({ side: [] }),
    architecture: () => ({ side: [] }),
  };
  for (const template of Object.keys(SHAPES)) {
    const radar = seeded.radars.find((r) => r.template === template);
    if (!radar) throw new Error(`the seed has no ${template} radar to measure`);
    // 2112 is a 1848px pane, the width of a 1920 screen with the sidebar furled (the production
    // microblog measured 87.6% there while the 1656px pane of an open sidebar passed).
    for (const width of [1920, 1440, 1024, 390, ...(template === 'microblog' ? [2112] : [])]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await goto(`/radar/${radar.id}`);
      await page.waitForSelector('.app-content', { timeout: PATIENCE_MS }).catch(() => null);
      await wait(600);
      await shot(page, outDir, `${template}-${width}`);
      const facts = await page.evaluate((columns: string) => {
        const box = (el: Element | null) => {
          const r = el && el.getClientRects().length > 0 ? el.getBoundingClientRect() : null;
          return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
        };
        const pane = document.querySelector('.app-content');
        return {
          pane: pane ? pane.clientWidth : null,
          columns: [...document.querySelectorAll(columns)]
            .map((el) => ({
              kind:
                ['cols-index', 'cols-main', 'cols-panel', 'radar-rail', 'radar-main'].find((k) =>
                  el.classList.contains(k),
                ) ?? '',
              box: box(el),
            }))
            .filter((c) => c.box !== null),
          root: box(document.querySelector('.board, .arch')),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, COLUMN);
      const at = `[${template}] at ${width}px`;
      notes.push({ what: `${template} at ${width}`, ...facts });
      check(`${at} nothing scrolls sideways`, facts.overflow <= 0, facts);
      if (width < 1440) continue;
      const shape: { side: string[]; folded?: string } = (
        SHAPES[template] ?? (() => ({ side: [] }))
      )(width);
      const find = (sel: string) => facts.columns.find((c) => `.${c.kind}` === sel)?.box ?? null;
      const side = shape.side.map(find);
      const spans = (shape.side.length > 0 ? side : [facts.root]).flatMap((b) => (b ? [b] : []));
      check(
        `${at} the content fills at least 90% of the pane`,
        facts.pane !== null &&
          spans.length === Math.max(shape.side.length, 1) &&
          Math.max(...spans.map((b) => b.right)) - Math.min(...spans.map((b) => b.left)) >=
            facts.pane * 0.9,
        { pane: facts.pane, spans },
      );
      check(
        `${at} its columns sit side by side${shape.side.length === 0 ? ' (none declared)' : ''}`,
        side.every((b, i) => {
          const prev = side[i - 1];
          return (
            b !== null &&
            (!prev || (prev.right <= b.left + 1 && prev.top < b.bottom && b.top < prev.bottom))
          );
        }),
        { want: shape.side, side },
      );
      if (shape.folded) {
        const folded = find(shape.folded);
        const main = find('.cols-main');
        check(
          `${at} the panel is folded above the open item`,
          folded !== null && main !== null && folded.bottom <= main.top + 1,
          { folded, main },
        );
      }
    }
  }

  /* ------------------------------------------------------- both themes -- */

  /*
    The light theme, and `data-theme` beating `prefers-color-scheme`.
    
    Both are standing constraints and neither had a gate. The one that matters
    most is the precedence: a colour whose only definition lives inside a
    `@media (prefers-color-scheme: …)` block is a colour the toggle cannot win
    against, and that is a mistake nobody notices until somebody sets the theme
    explicitly on a machine set the other way. So the browser is emulated as
    *dark* while the app is told *light*, and the assertion is that the app wins.

    Contrast is measured on the token that failed AA before this work — the
    faintest ink, against the ground it is actually painted on — rather than
    trusted from the stylesheet. `theme.test.ts` holds surfaces to a floor in the
    abstract; this holds the rendered page to one, through the real cascade.
  */
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await goto('/radars');
  await page.evaluate(() => localStorage.setItem('omr.theme', 'light'));
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(600);
  await shot(page, outDir, 'd1440-light');

  const light = await page.evaluate(() => {
    const lin = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const luminance = (colour: string): number => {
      const [r, g, b] = (colour.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number);
      return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
    };
    const root = getComputedStyle(document.documentElement);
    const faint = root.getPropertyValue('--paper-faint').trim();
    const probe = document.createElement('span');
    probe.style.color = faint;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const ground = getComputedStyle(document.body).backgroundColor;
    const a = luminance(resolved);
    const b = luminance(ground);
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      bodyBackground: ground,
      faint: resolved,
      contrast: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
      /* A light theme whose body is still near-black means the tokens did not
         swap and every assertion about "light" below would be about dark. */
      isLight: b > 0.5,
    };
  });
  notes.push({ what: 'light theme at 1440', ...light });

  check(
    '[light] data-theme wins over a dark prefers-color-scheme',
    light.dataTheme === 'light' && light.isLight,
    light,
  );
  check(
    '[light] the faintest ink clears AA against the ground it is painted on',
    light.contrast >= 4.5,
    { contrast: light.contrast, faint: light.faint, ground: light.bodyBackground },
  );

  /* Put the browser back, so nothing after this measures a page it did not set up. */
  await page.evaluate(() => localStorage.removeItem('omr.theme'));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  return { checks, failures, notes };
}

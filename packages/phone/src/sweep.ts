/**
 * One sweep of the phone view: home, the radars screen, the composer with the
 * keyboard up, the flat screens, and every template.
 *
 * Every assertion here is a defect the product owner saw on a real iPhone, turned into
 * something that cannot come back quietly. None of them is a screenshot
 * comparison — they are geometry and computed values, because a suite that
 * fails on font rendering gets disabled within a week and is worse than nothing.
 * Screenshots are still written, as evidence to read when one of these fails.
 */
import {
  conversationFor,
  DROP_BOX_TEMPLATE_IDS,
  RADAR_TEMPLATES,
  RADAR_TEMPLATE_IDS,
  templateFor,
} from '@onmyradar/contract';
import type { HTTPRequest, Page } from 'puppeteer-core';
import {
  KEYBOARD_VISUAL_HEIGHT,
  PATIENCE_MS,
  keyboard,
  paintKeyboard,
  rectOf,
  shot,
  unpaintKeyboard,
  wait,
} from './harness.js';
import type { Rect } from './harness.js';
import type { Seeded } from './seed.js';

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: unknown;
}

export interface SweepResult {
  readonly checks: readonly Check[];
  readonly failures: readonly string[];
  readonly notes: readonly unknown[];
}

interface FrameFacts {
  innerWidth: number;
  bodyScrollsSideways: boolean;
  overflowingRight: string[];
  stackedBands: string[] | null;
  searchHeaderHeight: number | null;
  scrimPresent: boolean;
  sidebarPainted: boolean;
  tabBar: { bottom: number; paddingBottom: string } | null;
  titleCollisions: string[];
}

export async function runSweep(page: Page, outDir: string, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const notes: unknown[] = [];

  const check = (name: string, ok: boolean, detail: unknown = null): void => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };

  // A script error on the page is a failure of the page, whatever the geometry
  // says afterwards.
  page.on('pageerror', (err) => failures.push(`page error: ${String(err)}`));

  const goto = async (path: string): Promise<void> => {
    await page.goto(seeded.baseUrl + path, { waitUntil: 'networkidle2' });
    /*
     * Wait on the frame, not on a clock. The shell paints before the route data
     * arrives, and a fixed 700ms delay was intermittently losing `.tab-capture`
     * and the /api/radars fetch on a loaded machine — which is exactly the shape
     * of flake that gets a suite switched off.
     */
    await page.waitForSelector('.app-tabbar', { timeout: PATIENCE_MS }).catch(() => null);
    await wait(600);
  };

  /** Layout facts that must hold on every screen. */
  const frameFacts = (): Promise<FrameFacts> =>
    page.evaluate((): FrameFacts => {
      const bar = document.querySelector('.app-tabbar');
      const aside = document.querySelector('.app-sidebar');
      const doc = document.documentElement;

      /*
       * "No second header band above the screen's own header", measured rather
       * than looked up by class name.
       *
       * This used to probe `.app-topbar`. That element was deleted on purpose —
       * see the note at the top of `shell.tsx`, it carried the wordmark and
       * nothing else — and the probe was left behind, so `topbarPresent` was
       * structurally `false` and `=== false` was structurally `true`: eleven
       * green ticks a run, none of them an observation. A wordmark bar coming
       * back under any other class name passed.
       *
       * So the shape is what is measured now: inside `.app-main`, a full-width
       * painted band sitting entirely above the screen's own heading. Ancestors
       * of the heading are excluded because they ARE that header. The intentional
       * universal search header is measured separately against a compact-height
       * budget; its subtree is excluded here. A band is 60%
       * of the viewport or wider — narrower than that is a control, not a bar.
       */
      const main = document.querySelector('.app-main');
      const heading = main?.querySelector('h1, h2') ?? null;
      const headingTop = heading?.getBoundingClientRect().top ?? null;
      const stackedBands =
        main && heading && headingTop !== null
          ? [...main.querySelectorAll('*')]
              .filter((el) => !el.contains(heading) && !el.closest('.app-search-header'))
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter(
                ({ r }) =>
                  r.height > 0 && r.width >= window.innerWidth * 0.6 && r.bottom <= headingTop + 1,
              )
              .map(({ el }) => el.className || el.tagName)
          : null;

      const overflowing = [...document.querySelectorAll('body *')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        /*
         * A scroll container is allowed to hold content wider than itself; what
         * is not allowed is a box whose own painted edge is off the screen.
         *
         * A **clipping** ancestor counts too, and that is a widening. This check
         * is about what a person sees — its name says "painted" — and something
         * inside `overflow: hidden` is not painted past anything. The case that
         * forced the question is the bearing strip: its newest tick sits at
         * `left: 100%` and is 1.5px wide, so it lays out 1.5px past the strip
         * and is clipped away by `.bearing`'s own `overflow: hidden`. Reporting
         * that as content off the screen edge is a false positive, and the fix
         * is here rather than in the CSS — moving the tick would move every
         * tick, and the strip's whole meaning is where its ticks are.
         *
         * The page-level version of this defect is still caught, by
         * `bodyScrollsSideways` two lines below, which no clipping ancestor can
         * hide.
         */
        .filter((x) => {
          if (x.r.width === 0 || x.r.height === 0) return false;
          if (x.r.right <= window.innerWidth + 1) return false;
          let parent = x.el.parentElement;
          while (parent) {
            const style = getComputedStyle(parent);
            if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) return false;
            parent = parent.parentElement;
          }
          return true;
        })
        .slice(0, 4)
        .map((x) => `${x.el.className || x.el.tagName}@${Math.round(x.r.right)}`);

      return {
        innerWidth: window.innerWidth,
        bodyScrollsSideways: doc.scrollWidth > doc.clientWidth + 1,
        overflowingRight: overflowing,
        // `null` means there was no heading to measure against, which the checks
        // treat as a failure rather than as a pass — see the note above.
        stackedBands,
        searchHeaderHeight:
          document.querySelector('.app-search-header')?.getBoundingClientRect().height ?? null,
        scrimPresent: Boolean(document.querySelector('.modal-scrim')),
        sidebarPainted: aside ? getComputedStyle(aside).display !== 'none' : false,
        tabBar: bar
          ? {
              bottom: Math.round(bar.getBoundingClientRect().bottom),
              paddingBottom: getComputedStyle(bar).paddingBottom,
            }
          : null,
        /*
         * A screen title whose box runs under a control. This is the exact shape
         * of the Activity-page bug: a flex header that squeezed the heading
         * instead of wrapping the buttons.
         */
        titleCollisions: [...document.querySelectorAll('h1, h2')]
          .filter((h) => h.getClientRects().length > 0)
          .flatMap((h) => {
            const a = h.getBoundingClientRect();
            return [...document.querySelectorAll('button, a.btn, .btn')]
              .filter((b) => {
                if (b.getClientRects().length === 0) return false;
                if (h.contains(b) || b.contains(h)) return false;
                const r = b.getBoundingClientRect();
                // Page content scrolls under the fixed tab bar by design: a heading that
                // starts below the bar's top edge is below the fold, not squeezed by it.
                if (bar?.contains(b) && a.top >= Math.min(bar.getBoundingClientRect().top, r.top))
                  return false;
                return (
                  a.left < r.right - 1 &&
                  a.right > r.left + 1 &&
                  a.top < r.bottom - 1 &&
                  a.bottom > r.top + 1
                );
              })
              .map((b) => {
                // Name the control even when it is an icon: its label, else its tag and class.
                const name =
                  b.textContent.trim() ||
                  b.getAttribute('aria-label') ||
                  b.getAttribute('title') ||
                  `<${b.tagName.toLowerCase()}.${b.className}>`;
                const top = Math.round(b.getBoundingClientRect().top);
                return `${h.textContent.trim().slice(0, 20)} x ${name.slice(0, 40)} @${top}/${Math.round(a.top)}`;
              });
          }),
      };
    });

  /* ------------------------------------------------------------- home ---- */

  await goto('/');
  await shot(page, outDir, '01-home');
  const home = await frameFacts();
  notes.push({ what: 'home frame', ...home });

  check(
    'the tab bar clears the bottom edge with room for Safari chrome',
    home.tabBar !== null && parseFloat(home.tabBar.paddingBottom) >= 7,
    home.tabBar,
  );
  /*
   * The title-bar check is NOT made here, deliberately.
   *
   * It is anchored on the screen's own heading, and the home screen has none —
   * the boards grid leads with the tab strip, so there is no second header for a
   * bar to stack above and the property is undefined rather than satisfied. The
   * version that used to stand here probed `.app-topbar` and was vacuous; a
   * `stackedBands === null ||` arm would be exactly as vacuous, in a better
   * disguise. It runs on every radar screen below, where there is a real anchor.
   */
  notes.push({ what: 'home has no screen heading to anchor a title-bar check on' });
  check('the desktop sidebar is not painted on a phone', home.sidebarPainted === false, {
    sidebarPainted: home.sidebarPainted,
  });
  check('nothing on home is painted past the right edge', home.overflowingRight.length === 0, {
    overflowingRight: home.overflowingRight,
  });
  check('home does not scroll sideways', home.bodyScrollsSideways === false, {
    bodyScrollsSideways: home.bodyScrollsSideways,
  });
  /*
   * Without a correct `<meta name="viewport">` a mobile browser lays the page
   * out at 980px and scales it down. Everything still "fits", every overflow
   * assertion below still passes, and the app is unreadable on the phone. So the
   * width itself has to be asserted, or the rest of this suite is measuring a
   * desktop layout that happens to have been shrunk.
   */
  check('the layout viewport is the phone width, not a scaled-down 980', home.innerWidth === 390, {
    innerWidth: home.innerWidth,
  });

  const tabDot = await page.evaluate(() => {
    const dot = document.querySelector('.app-tabbar .tab-dot');
    if (!dot) return null;
    const r = dot.getBoundingClientRect();
    return {
      painted: r.width > 0,
      inside: r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    };
  });
  notes.push({ what: 'unread dot', tabDot, unreadTotal: seeded.unreadTotal });
  check(
    'the unread total has a home on a phone (the tab dot)',
    tabDot !== null && tabDot.painted && tabDot.inside,
    tabDot,
  );

  /*
   * `.notification-widget` is the section itself. Of the three selectors this
   * used to try, `[data-widget="activity"]` and `.activity-widget` appear
   * nowhere in the SPA and never have; the third, `.notification-list`, is the
   * inner `<ul>`, so the check was measuring the list under the widget's name
   * and would have missed a header or a footer painted past the edge. The text
   * fallback resolved to some ancestor `<div>` of the label, which is a third
   * different box again.
   */
  const widget = await page.evaluate(() => {
    const node = document.querySelector('.notification-widget, [aria-label="Activity"]');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { right: Math.round(r.right), width: Math.round(r.width) };
  });
  notes.push({ what: 'dashboard activity widget', widget });
  // Presence is its own assertion, like the composer and the search box: the
  // `widget === null ||` escape hatch meant a widget that stopped rendering at
  // all passed the check named for its width.
  check('the activity widget is on the screen to be checked', widget !== null, widget);
  check('the activity widget fits the phone width', widget !== null && widget.right <= 391, widget);

  /* -------------------------------------------------------- radars nav --- */

  const radarsTab = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.app-tabbar .tab')].find((t) =>
      /radars/i.test(t.textContent),
    );
    return tab ? { tag: tab.tagName, href: tab.getAttribute('href') } : null;
  });
  check(
    'Radars is a link to a screen, not an overlay trigger',
    radarsTab !== null && radarsTab.tag === 'A' && radarsTab.href === '/radars',
    radarsTab,
  );

  await goto('/radars');
  await shot(page, outDir, '02-radars');

  const radarsScreen = await page.evaluate(() => {
    const aside = document.querySelector('.app-sidebar');
    const list = document.querySelector('.radar-list');
    const header = document.querySelector('h1')?.parentElement;
    const creates = header
      ? [...header.querySelectorAll('button')].map((b) => b.textContent.trim())
      : [];
    return {
      url: location.pathname,
      sidebarPainted: aside ? getComputedStyle(aside).display !== 'none' : false,
      /*
       * `.modal-scrim`, not `.fixed.inset-0.z-30`. The scrim was re-sized to the
       * *visual* viewport when the iOS keyboard fix landed (see the note on
       * `primitives.tsx`) and took a real class name with it; `z-30` has not
       * appeared anywhere in the SPA since. This half of the check below was
       * therefore inert — only the `sidebarPainted` conjunct could still fail,
       * so a drawer regressing to an overlay on this screen passed.
       */
      scrimPresent: Boolean(document.querySelector('.modal-scrim')),
      listWidth: list ? Math.round(list.getBoundingClientRect().width) : null,
      rowHeights: [...document.querySelectorAll('.radar-row')].map((r) =>
        Math.round(r.getBoundingClientRect().height),
      ),
      /*
       * The rail is not painted on a phone, so this header is the ONLY place a
       * radar or a topic can be made. Topics shipped with no create control
       * anywhere and were therefore invisible; a phone has one fewer surface to
       * hide that on, which is why it is asserted here.
       */
      createControls: creates,
      createsClipped: header
        ? [...header.querySelectorAll('button')].filter(
            (b) => b.getBoundingClientRect().right > window.innerWidth + 1,
          ).length
        : null,
    };
  });
  notes.push({ what: 'radars screen', ...radarsScreen });

  check('tapping Radars lands on a full screen', radarsScreen.url === '/radars', {
    url: radarsScreen.url,
  });
  check(
    'nothing fans out over the content',
    !radarsScreen.scrimPresent && !radarsScreen.sidebarPainted,
    { scrim: radarsScreen.scrimPresent, sidebar: radarsScreen.sidebarPainted },
  );
  check(
    'rows are full width and thumb sized',
    (radarsScreen.listWidth ?? 0) >= 330 &&
      radarsScreen.rowHeights.length > 0 &&
      radarsScreen.rowHeights.every((h) => h >= 52),
    { listWidth: radarsScreen.listWidth, rowHeights: radarsScreen.rowHeights },
  );
  check(
    'a radar can be made from the radars screen',
    radarsScreen.createControls.some((t) => /new radar/i.test(t)),
    { createControls: radarsScreen.createControls },
  );
  check(
    'an array can be made from the radars screen',
    radarsScreen.createControls.some((t) => /new array/i.test(t)),
    { createControls: radarsScreen.createControls },
  );
  check('neither create control is sliced at the screen edge', radarsScreen.createsClipped === 0, {
    createsClipped: radarsScreen.createsClipped,
  });

  /* ------------------------------------------------------------ topics --- */

  /*
   * Topics have now been reported invisible TWICE — the second time after
   * creation had been fixed — so the way in gets a guarantee rather than a
   * comment.
   *
   * A phone has no rail, so this screen is the whole navigation. A topic used to
   * reach it only as a heading over a slice of the list below, which means the
   * word appeared nowhere at all until you already had one. The row asserted
   * here sits in the top list beside Search and Drop box, and it has to be there
   * whatever the count.
   */
  const topicsWayIn = await page.evaluate(() => {
    const row = [...document.querySelectorAll('a.radar-row')].find(
      (a) => a.getAttribute('href') === '/arrays',
    );
    return {
      present: Boolean(row),
      inTopList: row
        ? document.querySelector('.directory-shortcuts')?.contains(row) === true
        : false,
      text: row ? (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : null,
      clipped: row ? row.getBoundingClientRect().right > window.innerWidth + 1 : null,
    };
  });
  notes.push({ what: 'topics way in', ...topicsWayIn });

  check('the radars screen offers a way into arrays', topicsWayIn.present, topicsWayIn);
  check('it sits in the top list, not under the radars', topicsWayIn.inTopList, topicsWayIn);
  check('it says in words what an array is for', /group radars/i.test(topicsWayIn.text ?? ''), {
    text: topicsWayIn.text,
  });
  check('the topics row is not sliced at the screen edge', topicsWayIn.clipped === false, {
    clipped: topicsWayIn.clipped,
  });

  /*
   * The zero-topic case, which is the ONE that regressed, and which the seed
   * cannot produce because it makes a topic so the roll-up has something to roll
   * up. `/api/topics` is answered empty for one load only.
   *
   * Interception is turned off again immediately: leaving it on would slow every
   * request in the rest of the sweep and is the kind of shared state that makes a
   * later assertion fail for a reason nobody can find.
   */
  await page.setRequestInterception(true);
  const emptyTopics = (request: HTTPRequest): void => {
    if (new URL(request.url()).pathname === '/api/topics') {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ topics: [] }),
      });
      return;
    }
    void request.continue();
  };
  page.on('request', emptyTopics);
  try {
    await goto('/radars');
    const atZero = await page.evaluate(() => {
      const row = [...document.querySelectorAll('a.radar-row')].find(
        (a) => a.getAttribute('href') === '/arrays',
      );
      return {
        present: Boolean(row),
        text: row ? (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : null,
      };
    });
    notes.push({ what: 'topics way in at zero', ...atZero });
    check(
      'the way into arrays is there with NO arrays — the state that regressed',
      atZero.present && /group radars/i.test(atZero.text ?? ''),
      atZero,
    );

    await goto('/arrays');
    await shot(page, outDir, '02b-topics-empty');
    const empty = await page.evaluate(() => {
      const main = document.querySelector('.app-main');
      const text = main ? (main as HTMLElement).innerText : '';
      const creates = [...document.querySelectorAll('button')]
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => b.textContent.trim());
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        creates,
        scrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    notes.push({ what: 'topics screen at zero', ...empty });
    check(
      'an empty arrays screen still explains what a topic is',
      /groups radars|related radars together/i.test(empty.text),
      { text: empty.text.slice(0, 200) },
    );
    check(
      'an empty arrays screen offers to make one',
      empty.creates.some((t) => /new array/i.test(t)),
      { creates: empty.creates },
    );
    check('the arrays screen does not scroll sideways', !empty.scrollsSideways, {
      scrollsSideways: empty.scrollsSideways,
    });
  } finally {
    page.off('request', emptyTopics);
    await page.setRequestInterception(false);
  }

  /* The real list, with the seeded topic in it, and the rename control on it. */
  await goto('/arrays');
  await shot(page, outDir, '02c-topics');
  const topicsScreen = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('li.topic-row')];
    return {
      rows: rows.length,
      linksOut: rows.filter((r) => r.querySelector('a[href^="/array/"]')).length,
      renames: rows.filter((r) => r.querySelector('button[aria-label^="Rename"]')).length,
      clipped: rows.filter((r) => r.getBoundingClientRect().right > window.innerWidth + 1).length,
      tallEnough: rows.every((r) => r.getBoundingClientRect().height >= 52),
    };
  });
  notes.push({ what: 'topics screen', ...topicsScreen });

  check('the arrays screen lists the topics', topicsScreen.rows > 0, topicsScreen);
  check('each topic opens', topicsScreen.linksOut === topicsScreen.rows, topicsScreen);
  /*
   * `api.topics.update` shipped with zero callers in `packages/ui`, exactly as
   * `api.topics.create` had — so a topic named wrong stayed wrong short of
   * deleting it. A rename control that quietly disappears again is the same
   * defect a third time.
   */
  check('each topic can be renamed', topicsScreen.renames === topicsScreen.rows, topicsScreen);
  check('no topic row is sliced at the screen edge', topicsScreen.clipped === 0, topicsScreen);
  check('topic rows are thumb sized', topicsScreen.tallEnough, topicsScreen);

  /*
   * Back to `/radars` before the badge section, which measures whatever page is
   * currently loaded rather than navigating for itself. Leaving the sweep on
   * `/topics` failed four badge assertions that had nothing wrong with them —
   * they were being asked about a screen that has no radar rows.
   */
  await goto('/radars');

  /* ------------------------------------------------------------ badges --- */

  const badges = await page.evaluate(async () => {
    const counts = (await (await fetch('/api/notifications/counts?box=needs_you')).json()) as {
      total: number;
      byRadar: Record<string, number>;
    };
    const radars = (
      (await (await fetch('/api/radars')).json()) as {
        radars: { id: string; topic?: { id: string } | null }[];
      }
    ).radars;

    /*
     * Painted only. The desktop sidebar is display:none on a phone but is still
     * in the DOM, and it carries its own copy of every badge — counting them
     * flatly would double everything.
     */
    const painted = [...document.querySelectorAll('.notification-badge')].filter(
      (b) => b.getClientRects().length > 0,
    );

    /*
     * Classified rather than counted flatly. Radars are grouped by topic now,
     * and a topic heading carries the SUM of the radars beneath it — a real
     * badge with a real meaning, so a bare count of badges no longer says
     * anything. Checking each class against the API separately is a stronger
     * assertion than the flat total ever was, and it is the one that catches a
     * roll-up that lies.
     */
    const classify = (b: Element): string => {
      if (b.closest('a[href="/notifications"]')) return 'total';
      if (b.closest('h2')) return 'topic';
      return b.closest('a[href^="/radar/"]') ? 'radar' : 'other';
    };

    const perRadar = painted
      .filter((b) => classify(b) === 'radar')
      .map((b) => ({
        id: b.closest('a[href^="/radar/"]')?.getAttribute('href')?.split('/').pop() ?? null,
        shown: Number(b.textContent.trim()),
      }));

    const topicRollups = painted
      .filter((b) => classify(b) === 'topic')
      .map((b) => {
        const link = b.closest('h2')?.querySelector('a[href^="/array/"]');
        return {
          topicId: link ? (link.getAttribute('href')?.split('/').pop() ?? null) : null,
          shown: Number(b.textContent.trim()),
        };
      });

    const totals = painted
      .filter((b) => classify(b) === 'total')
      .map((b) => Number(b.textContent.trim()));

    // What each roll-up SHOULD say, computed from the API and not from the page.
    const expectedRollups: Record<string, number> = {};
    for (const r of radars) {
      if (!r.topic) continue;
      expectedRollups[r.topic.id] =
        (expectedRollups[r.topic.id] ?? 0) + (counts.byRadar[r.id] ?? 0);
    }

    return {
      expectedPerRadar: Object.values(counts.byRadar).filter((n) => n > 0).length,
      expectedTotal: counts.total,
      expectedRollups,
      perRadar,
      topicRollups,
      totals,
      stray: painted.filter((b) => classify(b) === 'other').length,
      activityRow: Boolean(document.querySelector('a[href="/notifications"]')),
    };
  });
  notes.push({ what: 'radars screen badges', ...badges });

  check('Activity is reachable from the radars screen', badges.activityRow);
  check(
    'every unread radar carries its own badge',
    badges.perRadar.length === badges.expectedPerRadar,
    { shown: badges.perRadar, expected: badges.expectedPerRadar },
  );
  check(
    'each radar badge says what the API says',
    badges.perRadar.every((b) => b.id !== null && b.shown > 0),
    { shown: badges.perRadar },
  );
  check(
    'the unread total is on Activity, and it is the API total',
    badges.expectedTotal > 0
      ? badges.totals.length === 1 && badges.totals[0] === badges.expectedTotal
      : badges.totals.length === 0,
    { totals: badges.totals, expected: badges.expectedTotal },
  );
  check(
    'each topic heading rolls up exactly the unread beneath it',
    badges.topicRollups.every(
      (r) => r.topicId !== null && badges.expectedRollups[r.topicId] === r.shown && r.shown > 0,
    ),
    { shown: badges.topicRollups, expected: badges.expectedRollups },
  );
  check(
    'no topic with unread beneath it is missing its roll-up',
    // Grouping a radar under a topic must not hide the badge that was asking
    // you to look at it.
    Object.entries(badges.expectedRollups)
      .filter(([, n]) => n > 0)
      .every(([id]) => badges.topicRollups.some((r) => r.topicId === id)),
    { shown: badges.topicRollups, expected: badges.expectedRollups },
  );
  check('no badge painted outside a row, a topic heading or Activity', badges.stray === 0, {
    stray: badges.stray,
  });

  /* -------------------------------------------------- drill in and back --- */

  const firstRadarHref = await page.evaluate(
    () => document.querySelector('.radar-list a[href^="/radar/"]')?.getAttribute('href') ?? null,
  );
  check('the radar list actually links to radars', firstRadarHref !== null);

  if (firstRadarHref) {
    await page.click(`.radar-list a[href="${firstRadarHref}"]`);
    await page.waitForSelector('.app-tabbar', { timeout: PATIENCE_MS }).catch(() => null);
    await wait(700);
    await shot(page, outDir, '03-radar-drilled');
    await page.goBack();
    await page.waitForSelector('.app-tabbar', { timeout: PATIENCE_MS }).catch(() => null);
    await wait(700);
    await shot(page, outDir, '04-after-back');

    const backUrl = new URL(page.url()).pathname;
    check('back from a radar returns to the radar list', backUrl === '/radars', {
      drilledTo: firstRadarHref,
      backUrl,
    });
    check(
      'the tab bar stays put through the drill-in',
      await page.evaluate(() => Boolean(document.querySelector('.app-tabbar'))),
    );
  }

  /* --------------------------------------------- composer + keyboard ----- */

  await goto('/');
  await page.click('.app-tabbar .tab-capture');
  await page.waitForSelector('#quick-drop', { timeout: PATIENCE_MS });
  await page.evaluate(() => document.querySelector<HTMLElement>('#quick-drop')?.focus());
  await keyboard(page, KEYBOARD_VISUAL_HEIGHT);
  await page.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('#quick-drop');
    if (!field) return;
    // The prototype's own setter, with the field as receiver: React tracks the
    // instance property, so only this makes the input event read as a change.
    Reflect.set(HTMLTextAreaElement.prototype, 'value', 'Dentist Tuesday 3pm #home', field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(500);

  const submit = await rectOf(page, ['[data-omr="drop-submit"]', '.btn-accent']);
  const field = await rectOf(page, ['#quick-drop']);
  notes.push({ what: 'composer with the keyboard up', submit, field });

  /*
   * THE assertion — the one that reproduces the screenshot the product owner sent. With the
   * keyboard up, iOS shrinks the visual viewport to ~390px and leaves the layout
   * viewport at 844. A composer that positions against the layout viewport puts
   * its own submit button underneath the keyboard, and the person cannot capture
   * at all.
   */
  const inside = (r: Rect | null): boolean =>
    r !== null && r.top >= 0 && r.bottom <= KEYBOARD_VISUAL_HEIGHT;
  const overshoot = (r: Rect | null): number | null =>
    r === null ? null : r.bottom - KEYBOARD_VISUAL_HEIGHT;

  check('the composer submit is inside the visible rect with the keyboard up', inside(submit), {
    submit,
    visibleHeight: KEYBOARD_VISUAL_HEIGHT,
    pxBelowTheKeyboardLine: overshoot(submit),
  });
  check('the composer field is inside the visible rect with the keyboard up', inside(field), {
    field,
    visibleHeight: KEYBOARD_VISUAL_HEIGHT,
    pxBelowTheKeyboardLine: overshoot(field),
  });

  await paintKeyboard(page, KEYBOARD_VISUAL_HEIGHT);
  await shot(page, outDir, '05-composer-keyboard');
  await unpaintKeyboard(page);
  await keyboard(page, null);
  await wait(300);
  await shot(page, outDir, '06-composer-no-keyboard');
  await page.keyboard.press('Escape');
  await wait(300);

  /* ---------------------------------------------------- the flat screens - */

  for (const [path, name] of [
    ['/notifications', '07-screen-activity'],
    ['/settings', '08-screen-settings'],
  ] as const) {
    await goto(path);
    await shot(page, outDir, name);
    const facts = await frameFacts();
    notes.push({ what: `screen ${path}`, ...facts });

    check(`[${path}] nothing painted past the right edge`, facts.overflowingRight.length === 0, {
      overflowingRight: facts.overflowingRight,
    });
    check(`[${path}] the tab bar is still there`, facts.tabBar !== null);
    check(`[${path}] no screen title running under a control`, facts.titleCollisions.length === 0, {
      titleCollisions: facts.titleCollisions,
    });
  }

  // Sign out and the waitlist link lost their home when the drawer went. They
  // must have found one.
  await goto('/settings');
  await page
    .waitForSelector('[data-omr="settings-section-link"]', { timeout: PATIENCE_MS })
    .catch(() => undefined);
  const account = await page.evaluate(() => ({
    signOut: [...document.querySelectorAll('button')].some(
      (b) => /sign out/i.test(b.textContent) && b.getClientRects().length > 0,
    ),
    waitlist: [...document.querySelectorAll('a')].some(
      (a) => a.getAttribute('href') === '/admin' && a.getClientRects().length > 0,
    ),
  }));
  notes.push({ what: 'account controls on a phone', ...account });
  check('sign out survived the drawer removal', account.signOut, account);
  check('the waitlist link survived the drawer removal', account.waitlist, account);

  /*
   * The furled rail's floating labels are a desktop idea: a phone has the tab
   * bar and no rail. Touching a tab must not float a rail label over the
   * screen, and the page keeps the whole width.
   */
  await page.tap('.app-tabbar a').catch(() => undefined);
  await wait(300);
  const phoneRail = await page.evaluate(() => ({
    labels: document.querySelectorAll('.rail-label').length,
    mainWidth: Math.round(document.querySelector('.app-main')?.getBoundingClientRect().width ?? 0),
    viewport: innerWidth,
  }));
  notes.push({ what: 'rail labels on a phone', ...phoneRail });
  check(
    'no rail label floats on a phone, and the page keeps the width',
    phoneRail.labels === 0 && phoneRail.mainWidth === phoneRail.viewport,
    phoneRail,
  );

  /* ------------------------------------------------- universal search --- */

  /*
   * Search is a new screen rather than a new template, so nothing in this suite
   * covers it by accident: the self-maintaining half is `Record<RadarTemplate,…>`
   * in the seed, which is about templates and says nothing about routes. This
   * block is deliberate, and it has to stay deliberate — see docs/PHONE.md.
   *
   * Two things are being defended here, and only one of them is geometry.
   *
   * The layout half is the ordinary phone question: a box you type into, on the
   * screen with the least room, with a keyboard covering half of it.
   *
   * The other half is a *product* property that happens to be checkable from a
   * browser, and it is the one worth the most: **an unmatched filter returns
   * nothing and says so.** The failure it guards against — dropping a filter the
   * server could not resolve and returning the whole corpus — looks exactly like
   * a working search until the day somebody trusts an answer it did not test.
   * `services/search.test.ts` proves it in the service; this proves the screen
   * actually shows it.
   */
  {
    const s = seeded.search;

    // Universal search is available directly in the application header.
    await goto('/radars');
    const entry = await page.$eval('#global-search', (input) => ({
      visible: input.getClientRects().length > 0,
      role: input.getAttribute('role'),
      label: input.getAttribute('aria-label'),
    }));
    check(
      '[radars] universal search is available in the header',
      entry.visible && entry.role === 'combobox' && entry.label === 'Search',
      entry,
    );

    /** Every fact the search screen has to answer for, in one read. */
    const searchFacts = () =>
      page.evaluate(() => {
        const round = (n_: number) => Math.round(n_);
        const painted = (el: Element) => el.getClientRects().length > 0;
        const box = document.querySelector('#global-search');
        /*
         * `[data-search-result]`, not `[data-blip-id]`.
         *
         * A result is an excerpt now and only renders a real `BlipCard` once you
         * expand it, so counting cards counts expanded results — which is zero on
         * a fresh page. The row carries its own attribute for exactly this
         * reason: an assertion should measure the thing it is named after.
         */
        const results = [...document.querySelectorAll('[data-search-result]')].filter(painted);
        const snippets = [...document.querySelectorAll('.search-snippet')].filter(painted);
        return {
          boxPresent: Boolean(box) && (box ? painted(box) : false),
          boxValue: (box as HTMLInputElement | null)?.value ?? null,
          examples: [...document.querySelectorAll('.search-example')].filter(painted).length,
          tokens: [...document.querySelectorAll('.search-token')].filter(painted).map((el) => ({
            text: el.textContent.trim(),
            unresolved: el.classList.contains('is-unresolved'),
          })),
          problems: [...document.querySelectorAll('.search-problem')]
            .filter(painted)
            .map((el) => el.textContent.trim()),
          results: results.length,
          snippets: snippets.length,
          /* The whole point of a snippet: the query is marked inside it. */
          marked: snippets.flatMap((el) =>
            [...el.querySelectorAll('mark')].map((m) => m.textContent.trim().toLowerCase()),
          ),
          /* And a result is short. One used to be two screens. */
          tallestResult: results.length
            ? Math.max(...results.map((el) => Math.round(el.getBoundingClientRect().height)))
            : 0,
          expandControls: [...document.querySelectorAll('.search-expand')].filter(painted).length,
          resultsPastEdge: results
            .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
            .map((el) => round(el.getBoundingClientRect().right)),
          completions: [...document.querySelectorAll('.search-completion')].filter(painted).length,
        };
      });

    /* -- empty ------------------------------------------------------------ */

    await goto('/search');
    await shot(page, outDir, 'search-empty');
    const empty = await searchFacts();
    const emptyFrame = await frameFacts();
    notes.push({ what: 'search, empty', ...empty, ...emptyFrame });

    // Asserted before anything about what is on it: every check below would pass
    // perfectly on a screen that failed to render a box at all.
    check('[/search] the box is on the screen to be checked', empty.boxPresent, empty);
    check('[/search] the grammar is shown while the box is empty', empty.examples > 0, {
      examples: empty.examples,
      why: 'a filter grammar nobody can see is a grammar nobody uses',
    });
    check(
      '[/search] nothing painted past the right edge',
      emptyFrame.overflowingRight.length === 0,
      { overflowingRight: emptyFrame.overflowingRight },
    );
    check('[/search] the tab bar is still there', emptyFrame.tabBar !== null);
    check(
      '[/search] no screen title running under a control',
      emptyFrame.titleCollisions.length === 0,
      { titleCollisions: emptyFrame.titleCollisions },
    );

    /* -- words ------------------------------------------------------------ */

    await goto(`/search?q=${encodeURIComponent(s.needle)}`);
    await shot(page, outDir, 'search-results');
    const words = await searchFacts();
    const wordsFrame = await frameFacts();
    notes.push({ what: 'search, words', ...words });

    check(
      `[/search] a result is an excerpt, not a whole blip`,
      words.snippets === words.results && words.results > 0,
      { snippets: words.snippets, results: words.results },
    );
    check(
      `[/search] the query is marked inside the excerpt`,
      words.marked.length > 0 && words.marked.every((m) => m === s.needle.toLowerCase()),
      { marked: words.marked, needle: s.needle },
    );
    check(
      `[/search] and the whole blip is one control away`,
      words.expandControls === words.results,
      { expandControls: words.expandControls, results: words.results },
    );
    /*
     * A result used to be a full `BlipCard`, so one ~700-word essay filled the
     * viewport and you could not reach result 2 without scrolling past all of
     * result 1. Held against the phone's own height: a result that is taller
     * than the screen is not a list row.
     */
    check(
      `[/search] no result is taller than the screen it is listed on`,
      words.tallestResult > 0 && words.tallestResult < 844,
      { tallestResult: words.tallestResult },
    );
    check(`[/search] the words find the seeded needle`, words.results === s.matches, {
      expected: s.matches,
      got: words.results,
      needle: s.needle,
    });
    check(
      '[/search] no result is painted past the right edge',
      words.resultsPastEdge.length === 0,
      {
        resultsPastEdge: words.resultsPastEdge,
        results: words.results,
      },
    );
    check(
      '[/search] the results screen still fits',
      wordsFrame.overflowingRight.length === 0 && !wordsFrame.bodyScrollsSideways,
      wordsFrame,
    );

    /* -- a filter that resolves ------------------------------------------- */

    await goto(`/search?q=${encodeURIComponent(`${s.needle} in:"${s.radarName}"`)}`);
    const scoped = await searchFacts();
    notes.push({ what: 'search, in: resolves', ...scoped });

    check(`[/search] in: narrows and still finds them`, scoped.results === s.matches, {
      expected: s.matches,
      got: scoped.results,
    });
    check(
      '[/search] a resolved filter shows what it matched',
      scoped.tokens.length === 1 &&
        scoped.tokens[0]?.unresolved === false &&
        scoped.tokens[0].text.includes(s.radarName),
      { tokens: scoped.tokens, radarName: s.radarName },
    );

    /* -- a filter that does not ------------------------------------------- */

    await goto(`/search?q=${encodeURIComponent(`${s.needle} in:${s.missingRadar}`)}`);
    await shot(page, outDir, 'search-unresolved');
    const unresolved = await searchFacts();
    notes.push({ what: 'search, in: unresolved', ...unresolved });

    /*
     * THE assertion of this block. The needle on its own returns `s.matches`
     * rows; with a filter that resolves to nothing it must return ZERO. A search
     * that quietly drops what it could not understand would return `s.matches`
     * here and look entirely healthy.
     */
    check(
      '[/search] an unmatched filter returns nothing rather than everything',
      unresolved.results === 0,
      {
        got: unresolved.results,
        wouldBeIfTheFilterWereDropped: s.matches,
        query: `${s.needle} in:${s.missingRadar}`,
      },
    );
    check(
      '[/search] ...and the screen says which filter did it',
      unresolved.problems.length === 1 && unresolved.tokens.some((t) => t.unresolved),
      { problems: unresolved.problems, tokens: unresolved.tokens },
    );

    /* -- completion ------------------------------------------------------- */

    /*
     * `in:` is unusable without this. The honest failure message cannot say
     * whether a name was misspelled or the radar belongs to somebody else — that
     * indistinguishability is the point — so guessing at names has to stop being
     * necessary rather than being made easier to recover from.
     */
    await goto('/search');
    await page.focus('#global-search');
    await page.evaluate(() => {
      const box = document.querySelector<HTMLInputElement>('#global-search');
      if (!box) return;
      /*
       * `My` rather than `On`, and that is a lesson rather than a detail: `On`
       * matched "Decisi-ON-s" as well as "On My Radar", and which of the two
       * sorted first is not something this assertion should depend on. `My`
       * names exactly one seeded radar — and one whose name has a space in it,
       * which is what the check below is actually about.
       */
      Reflect.set(HTMLInputElement.prototype, 'value', 'in:My', box);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.setSelectionRange(5, 5);
      box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'y' }));
    });
    await page.waitForSelector('.search-completion', { timeout: PATIENCE_MS }).catch(() => null);
    const offering = await searchFacts();
    notes.push({ what: 'search, completing in:', ...offering });
    check('[/search] typing in: offers radars it can name', offering.completions > 0, offering);

    await page.evaluate(() => {
      const first = document.querySelector<HTMLElement>('.search-completion');
      first?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await wait(300);
    const completed = await searchFacts();
    notes.push({ what: 'search, after completing', boxValue: completed.boxValue });
    check(
      '[/search] a completed name with a space in it comes back quoted',
      /in:"[^"]+ [^"]+"/.test(completed.boxValue ?? ''),
      {
        boxValue: completed.boxValue,
        why: 'an unquoted value stops at the first space, so half the name would become a stray word',
      },
    );

    /* -- the keyboard ----------------------------------------------------- */

    await page.evaluate(() => document.querySelector<HTMLElement>('#global-search')?.focus());
    await keyboard(page, KEYBOARD_VISUAL_HEIGHT);
    await wait(400);
    const searchBox = await rectOf(page, ['#global-search']);
    notes.push({ what: 'search box with the keyboard up', searchBox });

    // Same defect class as the composer sitting under the keyboard: a box you
    // are typing into that you cannot see while typing into it.
    check(
      '[/search] the box stays inside the visible rect with the keyboard up',
      searchBox !== null && searchBox.top >= 0 && searchBox.bottom <= KEYBOARD_VISUAL_HEIGHT,
      {
        searchBox,
        visibleHeight: KEYBOARD_VISUAL_HEIGHT,
        pxBelowTheKeyboardLine: searchBox
          ? Math.max(0, searchBox.bottom - KEYBOARD_VISUAL_HEIGHT)
          : null,
      },
    );

    await paintKeyboard(page, KEYBOARD_VISUAL_HEIGHT);
    await shot(page, outDir, 'search-keyboard');
    await unpaintKeyboard(page);
    await keyboard(page, null);
    await wait(300);
  }

  /* --------------------------------------------------------- templates -- */

  const covered = new Set<string>();
  let n = 9;

  for (const radar of seeded.radars) {
    await goto(`/radar/${radar.id}`);
    const slug = radar.name.toLowerCase().replace(/\W+/g, '-');
    await shot(page, outDir, `${String(n).padStart(2, '0')}-template-${radar.template}-${slug}`);
    n += 1;
    covered.add(radar.template);

    const facts = await frameFacts();
    const chips = await page.evaluate(() => {
      /*
       * `.filter-rail`, not `.chip-wrap`.
       *
       * The triage chips used to live in a `.chip-wrap` of their own. The filter
       * box landed and folded them into `.filter-rail` alongside the search
       * field and the lane chips — and this selector was not moved, so
       * `triageWrapPresent` had been `false` and `triageChipsOffScreen` `null` on
       * every template ever since. The check below short-circuits on `null`, so
       * it could not fail on anything, while `PHONE.md` and `TEMPLATES.md` both
       * cited it as a guarantee. The orphaned `.chip-wrap` rule has been removed
       * from styles.css along with this, so there is nothing left to point at
       * by mistake.
       *
       * The presence of the rail is now asserted separately rather than being
       * folded into the clipping check, for the reason the composer note below
       * gives: "no chip is clipped" and "there are no chips" must not be the same
       * green.
       */
      const wrap = document.querySelector('.filter-rail');
      /*
       * The composer is anchored from its FIELD, not from a class name. The first
       * attempt at scoping this guessed at `.composer`, which does not exist —
       * the root is a `.panel` — so the selector matched nothing and fell back to
       * `document.body`, leaving the check document-wide while looking scoped.
       * That is the very bug this scoping was meant to fix, so the anchor is an
       * id that is actually in the markup and asserted to be present below.
       */
      const composerField = document.querySelector('#composer, #quick-drop');
      const composerScope = composerField
        ? (composerField.closest('.panel, form, [role="dialog"]') ?? composerField.parentElement)
        : null;
      const clipped = (el: Element): string[] =>
        [...el.children]
          .filter((c) => c.getBoundingClientRect().right > window.innerWidth + 1)
          .map((c) => c.textContent.trim().slice(0, 24) || c.className);
      return {
        composerPresent: Boolean(composerScope),
        proposePresent: [...document.querySelectorAll('.arch-bar button')].some(
          (b) => b.textContent === 'Propose ADR',
        ),
        triageWrapPresent: Boolean(wrap),
        triageChipsOffScreen: wrap ? clipped(wrap).length : null,
        // The offending elements, not just how many. A count tells you the
        // layout broke; the labels tell you where, which is the difference
        // between a reproducible failure and a screenshot hunt.
        triageChipsClipped: wrap ? clipped(wrap) : null,
        /*
         * The tag chips are IN the filter rail now, not in a `.chip-rail` band
         * of their own — that band was a full 40px row which on most radars
         * carried one chip, inside a 270px stack of chrome above the first blip.
         *
         * Measured as a property of the chips rather than by probing a class
         * name, which is this suite's characteristic defect: `.chip-rail`,
         * `.chip-wrap`, `.app-topbar` and `[data-widget="activity"]` all
         * outlived their consumers here while their assertions went on passing.
         */
        tagChips: wrap
          ? [...wrap.querySelectorAll('button')].filter((b) => b.textContent.trim().startsWith('#'))
              .length
          : 0,
        tagChipsInARail: wrap
          ? [...wrap.querySelectorAll('button')].filter(
              (b) =>
                b.textContent.trim().startsWith('#') &&
                b.getBoundingClientRect().right > window.innerWidth + 1,
            ).length
          : 0,
        /* A band of its own would be a second row under the rail. */
        separateTagBand: document.querySelectorAll('.chip-rail').length,
        /*
         * Scoped to the composer, which is the affordance this is about.
         *
         * It used to match the whole document, and that was wrong in a way that
         * only showed up when somebody seeded a radar with no blips: it matched
         * the EMPTY-STATE PROSE, which is legitimately painted, and reported the
         * composer as broken when the composer was fine. An assertion that fails
         * for a reason other than the one in its name is worse than no assertion,
         * because the next person deletes it.
         *
         * Leaf elements only: the parent `.instrument` span contains the text of
         * its own display:none child, so matching up the tree finds a hint that
         * is not painted.
         */
        cmdHintVisible: [
          ...(composerScope ?? document.createElement('div')).querySelectorAll('*'),
        ].some(
          (el) =>
            el.children.length === 0 &&
            /cmd \+ enter/i.test(el.textContent) &&
            el.getClientRects().length > 0,
        ),
        /*
         * And the prose, separately — because the same defect lives there too.
         * "Type in the box above and hit cmd + enter" on a device with no Cmd key
         * is the bug the product owner photographed, written as copy instead of as a hint,
         * which is exactly how it survived the first fix. Tightening the check
         * above without adding this one would have silently dropped it.
         */
        keyboardProse: [...document.querySelectorAll('p, .empty-hint, .instrument')]
          // Leaf elements only, and the same trap as above caught this one on its
          // first run: a parent `.instrument` reports the text of its own
          // display:none child, so `cmd + enter to capture` appeared to be
          // painted on every radar when the composer was behaving correctly.
          .filter((el) => el.children.length === 0 && el.getClientRects().length > 0)
          .map((el) => el.textContent.trim())
          .filter((t) => /\bcmd\b|\bctrl\b|\u2318|keyboard shortcut/i.test(t))
          .slice(0, 3),
      };
    });
    notes.push({ what: `template ${radar.template} (${radar.name})`, ...facts, ...chips });

    /*
     * The radar name is in the tag, not just the template: several radars are
     * streams (the drop box and the first radar both are), and three assertions
     * called `[stream/stream] …` cannot tell you which one failed.
     */
    const tag = `${radar.template}/${templateFor(radar.template).layout} ${radar.name}`;

    check(`[${tag}] no box painted off the right edge`, facts.overflowingRight.length === 0, {
      overflowingRight: facts.overflowingRight,
    });
    check(`[${tag}] the radar does not scroll sideways`, facts.bodyScrollsSideways === false, {
      bodyScrollsSideways: facts.bodyScrollsSideways,
    });
    // The same shape as the composer check further down: without this, the
    // clipping check below is green on a screen with no filter rail at all,
    // which is what it had silently become.
    check(`[${tag}] the filter rail is on the screen to be checked`, chips.triageWrapPresent, {
      triageWrapPresent: chips.triageWrapPresent,
    });
    check(`[${tag}] no triage chip sliced at the screen edge`, chips.triageChipsOffScreen === 0, {
      offScreen: chips.triageChipsOffScreen,
      clipped: chips.triageChipsClipped,
    });
    check(
      `[${tag}] the tags share the filter row rather than getting a band of their own`,
      chips.separateTagBand === 0,
      { separateTagBand: chips.separateTagBand, tagChips: chips.tagChips },
    );
    check(`[${tag}] no tag chip sliced at the screen edge`, chips.tagChipsInARail === 0, {
      clipped: chips.tagChipsInARail,
      tagChips: chips.tagChips,
    });
    // Without this, the check below passes trivially on a screen that has no
    // composer at all — which is the difference between "no bad hint" and
    // "nothing to hint about".
    // An Architecture radar has no capture box: its proposals start from a button in the tab bar.
    if (radar.template === 'architecture')
      check(
        `[${tag}] the Propose ADR button stands in for the capture box`,
        chips.proposePresent && !chips.composerPresent,
        {
          proposePresent: chips.proposePresent,
          composerPresent: chips.composerPresent,
        },
      );
    else
      check(`[${tag}] the composer is on the screen to be checked`, chips.composerPresent, {
        composerPresent: chips.composerPresent,
      });
    check(
      `[${tag}] no cmd+enter hint in the composer on a touch device`,
      chips.cmdHintVisible === false,
      {
        cmdHintVisible: chips.cmdHintVisible,
      },
    );
    check(
      `[${tag}] no keyboard-shortcut prose painted on a touch device`,
      chips.keyboardProse.length === 0,
      {
        keyboardProse: chips.keyboardProse,
      },
    );
    check(
      `[${tag}] no phone title bar above the radar header`,
      facts.stackedBands !== null && facts.stackedBands.length === 0,
      { stackedBands: facts.stackedBands },
    );
    check(
      `[${tag}] universal search header stays compact`,
      facts.searchHeaderHeight !== null &&
        facts.searchHeaderHeight > 0 &&
        facts.searchHeaderHeight <= 64,
      { height: facts.searchHeaderHeight, budget: 64 },
    );
    check(`[${tag}] no screen title running under a control`, facts.titleCollisions.length === 0, {
      titleCollisions: facts.titleCollisions,
    });

    /*
     * The discussion layout, which is the only one whose shape is a *nested*
     * list. The generic checks above prove it does not overflow; these prove it
     * is the thing it claims to be. Driven off the registry declaration rather
     * than off the template id, so a second template declaring `threaded` gets
     * the same coverage without touching this file.
     */
    const wanted = conversationFor(radar.template);
    if (wanted.expanded) {
      // The phone shows the index of threads first; the thread itself is one tap in, full screen.
      const index = await page.evaluate(() => ({
        topics: document.querySelectorAll('.disc-topic').length,
        threadsPainted: [...document.querySelectorAll('.thread')].filter(
          (el) => el.getClientRects().length > 0,
        ).length,
      }));
      check(
        `[${tag}] the index comes first on a phone, the thread is a tap away`,
        index.topics > 0 && index.threadsPainted === 0,
        index,
      );
      /*
       * The index screen is the index alone. `.btn` and the panel's own display outranked the rules
       * that hid them, so the Threads button and the thread's facts sat on the list; `.thread` was
       * all this counted. Asked again after each Back below.
       */
      const onlyIndex = () =>
        page.evaluate(() =>
          ['.cols-back', '.cols-panel', '.cols-main'].filter((sel) =>
            [...document.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0),
          ),
        );
      check(
        `[${tag}] the index screen has no Threads button or thread beside it`,
        (await onlyIndex()).length === 0,
        {
          painted: await onlyIndex(),
        },
      );
      await page.click('.disc-topic');
      await page.waitForSelector('.thread', { visible: true, timeout: PATIENCE_MS });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(`[${tag}] the open thread does not scroll sideways`, overflow <= 0, { overflow });
      const thread = await page.evaluate(() => {
        // Painted only. A `display: none` subtree keeps all its children, and
        // counting across the whole document double-counts the hidden desktop
        // sidebar — the trap this suite has already been caught by once.
        const painted = (el: Element) => el.getClientRects().length > 0;
        const q = (sel: string) => [...document.querySelectorAll(sel)].filter(painted);
        const replies = q('.comment.is-reply');
        return {
          threads: q('.thread').length,
          lanes: q('.thread-lane').length,
          metas: q('.thread-meta').length,
          comments: q('.comment').length,
          replies: replies.length,
          // The measure an indented reply is left with. The whole argument for
          // capping nesting at one level is that a second indent does not
          // survive this number.
          narrowestReply: replies.length
            ? Math.min(...replies.map((el) => Math.round(el.getBoundingClientRect().width)))
            : null,
          // A folded thread would render the toggle instead; an expanded one
          // must not, or the reply count is printed twice within a few lines.
          togglesPainted: q('.conversation-toggle').length,
          replyBoxes: q('.comment-input').length,
          // Rendered mentions, as the reader sees them. The seeded body says
          // `@owner`; what must appear is the account's display name, because
          // that is the entire argument for storing the resolution rather than
          // parsing the body back out at render time.
          mentions: q('.mention').map((el) => el.textContent.trim()),
        };
      });
      /*
       * Only one thread is open at a time now, and the seeded mention is in one of the others (it
       * used to be that every thread was on the page at once). So the mentions are read across the
       * threads: back to the index, open the next, read what is painted.
       */
      for (let at = 1; at < index.topics; at += 1) {
        await page.click('.cols-back');
        await page.waitForSelector('.disc-topic', { visible: true, timeout: PATIENCE_MS });
        check(
          `[${tag}] after Back, the index screen is the index alone (thread ${at})`,
          (await onlyIndex()).length === 0,
          {
            painted: await onlyIndex(),
          },
        );
        await (await page.$$('.disc-topic'))[at]?.click();
        await page.waitForSelector('.thread', { visible: true, timeout: PATIENCE_MS });
        await wait(500);
        thread.mentions.push(
          ...(await page.$$eval('.mention', (els) =>
            els.filter((el) => el.getClientRects().length > 0).map((el) => el.textContent.trim()),
          )),
        );
      }
      notes.push({ what: `discussion shape (${radar.name})`, ...thread });

      check(`[${tag}] the thread renders open, without a tap`, thread.comments > 0, thread);
      check(
        `[${tag}] no fold toggle where the thread is already open`,
        thread.togglesPainted === 0,
        { togglesPainted: thread.togglesPainted },
      );
      check(
        `[${tag}] every thread states its lane and its recency`,
        thread.lanes === thread.threads && thread.metas === thread.threads,
        thread,
      );
      check(`[${tag}] a reply box is present to reply into`, thread.replyBoxes > 0, {
        replyBoxes: thread.replyBoxes,
      });
      /*
       * The seeded body says `@owner` — the local part of the address. What must
       * render is the account's DISPLAY name, which the seed sets after signing
       * in. That gap between what was typed and what is painted is the whole
       * argument for resolving a mention at write time and storing the account
       * rather than parsing the handle back out of the body on every render.
       */
      check(
        `[${tag}] a mention renders the account's name, not the handle typed`,
        thread.mentions.some((m) => /\s/.test(m)) && !thread.mentions.includes('@owner'),
        { mentions: thread.mentions },
      );

      if (wanted.threaded) {
        check(`[${tag}] a reply to a reply is indented one level`, thread.replies > 0, thread);
        /*
         * 240px is not a guess. The reply column measured 296px inside a 390px
         * viewport with one indent; a second level would take roughly another
         * 18px of padding and border off that, and the floor is set below the
         * measured value with room to move rather than at it. If this ever
         * fails, the answer is a shallower indent — not a deeper thread.
         */
        check(
          `[${tag}] an indented reply keeps a readable measure`,
          thread.narrowestReply === null || thread.narrowestReply >= 240,
          { narrowestReply: thread.narrowestReply },
        );
      }
    }

    /*
     * The board layout. On a desktop the lanes now share the width under a
     * measured budget and the ones that do not fit become rails; on a phone none
     * of that applies — there is room for exactly one lane and the pager is how
     * you reach the others. These assertions exist because the desktop change
     * and the phone behaviour are the same component, and a budget that leaked
     * across the breakpoint would draw five 60px columns again.
     *
     * The other half is the card's action cluster, which on a board card is
     * lifted out of the meta row so no column width can push it outside. A phone
     * lane is full width, so this is not where that was failing — but it is the
     * narrowest lane the app ever draws, so it is the cheapest place to prove
     * the cluster still lands inside its card.
     */
    if (templateFor(radar.template).layout === 'board') {
      const board = await page.evaluate(() => {
        const painted = (el: Element) => el.getClientRects().length > 0;
        const q = (sel: string) => [...document.querySelectorAll(sel)].filter(painted);
        const boardEl = document.querySelector('.board');
        const cards = q('.board-card');
        const strays = cards.filter((card) => {
          const cluster = card.querySelector('button[title="Edit"]')?.parentElement;
          if (!cluster) return false;
          const c = card.getBoundingClientRect();
          const k = cluster.getBoundingClientRect();
          return k.left < c.left - 0.5 || k.right > c.right + 0.5;
        }).length;
        return {
          columns: q('.board-column').length,
          rails: q('.board-column-rail').length,
          pagerLanes: q('.board-pager-lane').length,
          boardScrollsSideways: boardEl ? boardEl.scrollWidth > boardEl.clientWidth + 1 : null,
          cards: cards.length,
          clustersOutsideTheirCard: strays,
        };
      });
      notes.push({ what: `board shape (${radar.name})`, ...board });

      check(`[${tag}] exactly one lane is drawn at a time`, board.columns === 1, board);
      check(`[${tag}] no lane is railed on a phone`, board.rails === 0, board);
      check(`[${tag}] the pager offers every lane`, board.pagerLanes > 1, board);
      check(
        `[${tag}] the board itself does not scroll sideways`,
        board.boardScrollsSideways === false,
        board,
      );
      check(
        `[${tag}] every card's controls are inside the card`,
        board.cards > 0 && board.clustersOutsideTheirCard === 0,
        board,
      );
    }
  }

  /* ---------------------------------------------------- the drop box ----- */

  /*
   * What the drop box does NOT offer. Two rules that are refused by the service
   * and by CHECK constraints regardless of what is on screen, so what is being
   * asserted here is the other half: that the controls for them are *absent*
   * rather than present and then refused. A control that fails when you use it
   * is worse than one that is not there, and on a 390px screen a dead end costs
   * a scroll to find and a modal to escape.
   *
   * The allowed set is read from the registry, not written out, so a template
   * that later declares `inbox: true` is expected here without anybody editing
   * this file — the same self-maintaining promise as the template sweep below.
   */
  await goto(`/radar/${seeded.dropBoxId}`);
  await shot(page, outDir, '20-drop-box');

  const dropBoxHeader = await page.evaluate(() => {
    // Buttons AND links: the way into settings is a `<Link>` since the three
    // header icons became one labelled control pointing at a route.
    const labelled = (label: string): boolean =>
      [...document.querySelectorAll('button, a')].some(
        (b) => b.getAttribute('aria-label') === label && b.getClientRects().length > 0,
      );
    return {
      signedIn: Boolean(document.querySelector('.app-tabbar')),
      heading: (document.querySelector('h1, h2')?.textContent ?? '').trim(),
      settings: labelled('Radar settings'),
      // The two that were folded in. Their absence from the *header* is the
      // point — they are sections of the settings page now, and the assertion
      // below proves the way in still exists, so this is not an absence that
      // costs anybody anything.
      share: labelled('Share this radar'),
      webhooks: labelled('Webhooks'),
    };
  });
  notes.push({ what: 'drop box header', ...dropBoxHeader });

  /*
   * The precondition, and it is not ceremony: every interesting assertion below
   * is a *negative* one, and a negative assertion passes trivially on the wrong
   * page. The first run of this section sat after the invitation checks, which
   * delete the session cookie on purpose — so "no Publish control" passed
   * against the sign-in screen, as did "a person field is still offered",
   * because the sign-in screen has an email input too. Ordering fixed it; this
   * check is what would say so out loud if it ever moved back.
   */
  check(
    '[drop box] the session survived to this point — the negatives below mean something',
    dropBoxHeader.signedIn && /drop box/i.test(dropBoxHeader.heading),
    dropBoxHeader,
  );
  check('[drop box] the settings control is reachable at all', dropBoxHeader.settings);
  /*
   * One labelled way in, not three unlabelled icons.
   *
   * The header carried webhooks / share / settings as three 20px glyphs with no
   * labels — all `canManage`-only, all configuring the same radar, all opening a
   * modal. Asserting the two are gone from the header is only safe beside the
   * assertion above that the one that replaced them is present, and beside the
   * section checks below that prove sharing is still reachable through it.
   */
  check(
    '[drop box] configuring a radar is one control, not three unlabelled icons',
    dropBoxHeader.share === false && dropBoxHeader.webhooks === false,
    dropBoxHeader,
  );

  /*
   * Click by visible text and let the frame settle. Waiting on the frame rather
   * than on a clock: a fixed delay flaked on the first loaded machine it met —
   * the surface had not painted, so `.template-card` came back empty and a check
   * about *which* templates are offered failed for reasons that had nothing to
   * do with templates. That is the same defect the `goto` helper above carries a
   * note about, and the same one that gets a suite switched off.
   */
  const clickText = async (text: string): Promise<void> => {
    await page.evaluate((label) => {
      const target = [...document.querySelectorAll('button, a')].find(
        (el) => el.textContent.trim().toLowerCase() === label.toLowerCase(),
      );
      (target as HTMLElement | undefined)?.click();
    }, text);
    await wait(400);
  };

  // Settings: the template grid offers exactly the inbox-capable templates.
  await goto(`/radar/${seeded.dropBoxId}/settings`);
  await shot(page, outDir, '21-drop-box-settings');

  /*
   * The tab strip, and what a drop box is offered.
   *
   * Webhooks used to be absent here entirely, because a drop box refuses an
   * ingest URL. DESIGN.md 34 narrowed that: the refusal was always about what
   * may WRITE into a private inbox, and a drop box has blips it can report, so
   * the tab is present with only its outbound half. The asymmetry itself —
   * outbound offered, inbound withheld — is asserted inside the pane by
   * `outbound-webhooks.ts`; what belongs here is that the tab exists at all.
   *
   * Read from the page rather than written out, so a section added later shows
   * up here as a diff rather than passing silently. That is exactly how the
   * rule change above was caught.
   */
  const sectionTabs = await page.evaluate(() =>
    [...document.querySelectorAll('.section-tab')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => el.textContent.trim()),
  );
  notes.push({ what: 'drop box settings tabs', sectionTabs });
  check(
    '[drop box] the settings page is a tab strip, not three screens of scroll',
    sectionTabs.length >= 3,
    { sectionTabs },
  );
  check(
    '[drop box] a webhooks section, for the outbound half it may have (DESIGN 34)',
    sectionTabs.some((t) => /webhook/i.test(t)),
    { sectionTabs },
  );

  /*
   * The template is a summary row until you ask to change it. The six-card grid
   * was ~620px of a 512px dialog, for a decision made once at creation.
   */
  const templateAtRest = await page.evaluate(() => ({
    summary: document.querySelectorAll('.template-summary').length,
    cards: [...document.querySelectorAll('.template-card')].filter(
      (el) => el.getClientRects().length > 0,
    ).length,
  }));
  check(
    '[drop box] the template is one summary row at rest, not a six-card grid',
    templateAtRest.summary === 1 && templateAtRest.cards === 0,
    templateAtRest,
  );

  await clickText('Change template');
  const templateCards = await page.evaluate(() =>
    [...document.querySelectorAll('.template-card')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => (el.querySelector('.template-card-name')?.textContent ?? '').trim()),
  );
  const expectedCards = DROP_BOX_TEMPLATE_IDS.map((id) => RADAR_TEMPLATES[id].label);
  notes.push({ what: 'drop box template cards', offered: templateCards, expected: expectedCards });

  check(
    '[drop box] the template picker offers exactly the inbox templates',
    templateCards.length === expectedCards.length &&
      expectedCards.every((label) => templateCards.includes(label)),
    { offered: templateCards, expected: expectedCards },
  );
  check(
    '[drop box] and offers strictly fewer than a radar with a free choice',
    templateCards.length < RADAR_TEMPLATE_IDS.length,
    { offered: templateCards.length, all: RADAR_TEMPLATE_IDS.length },
  );

  const settingsFacts = await frameFacts();
  check(
    '[drop box] the settings page does not scroll sideways',
    settingsFacts.bodyScrollsSideways === false,
    settingsFacts,
  );
  check(
    '[drop box] nothing on the settings page is painted past the right edge',
    settingsFacts.overflowingRight.length === 0,
    { overflowingRight: settingsFacts.overflowingRight },
  );

  /*
   * One scroll region, which is the whole reason this stopped being a dialog.
   *
   * The old surface had three stacked vertically — the modal body, the glyph
   * panel (`max-height: 17rem`) and the theme panel — all painting a scrollbar
   * at once, so a swipe did something different depending on which 100px band
   * the finger was over. That is the mechanism; "cluttered" was the symptom.
   *
   * Measured as a property, not by class name: count the elements that actually
   * have more content than height AND clip it. The page itself is allowed to be
   * one of them; nothing nested inside it is.
   */
  await goto(`/radar/${seeded.dropBoxId}/settings?section=appearance`);
  await clickText('Colour');
  const scrollers = await page.evaluate(() =>
    [...document.querySelectorAll('main *')]
      .filter((el) => {
        if (el.getClientRects().length === 0) return false;
        // `.app-content` is the shell's own scroll pane — it IS the page here.
        if (el.classList.contains('app-content')) return false;
        const style = getComputedStyle(el);
        const clips = /auto|scroll/.test(style.overflowY);
        return clips && el.scrollHeight > el.clientHeight + 1;
      })
      .map((el) => (el.getAttribute('class') ?? '').slice(0, 60)),
  );
  notes.push({ what: 'nested scrollers on the settings page', scrollers });
  check(
    '[settings] the open picker does not scroll inside the page that already scrolls',
    scrollers.length === 0,
    { scrollers },
  );

  // Share: no public link, and the reason said rather than the section missing
  // without explanation.
  await goto(`/radar/${seeded.dropBoxId}/settings?section=people`);
  await shot(page, outDir, '22-drop-box-share');

  const shareFacts = await page.evaluate(() => {
    const text = document.body.innerText;
    const buttons = [...document.querySelectorAll('button')]
      .filter((b) => b.getClientRects().length > 0)
      .map((b) => b.textContent.trim());
    return {
      text,
      buttons,
      publishButton: buttons.some((t) => /^publish$/i.test(t)),
      newLinkButton: buttons.some((t) => /^new link$/i.test(t)),
      sharePersonField: Boolean(document.querySelector('input[type="email"]')),
    };
  });
  notes.push({
    what: 'drop box share dialog',
    buttons: shareFacts.buttons,
    publishButton: shareFacts.publishButton,
  });

  check(
    '[drop box] no Publish control — the private inbox has no public address',
    shareFacts.publishButton === false,
    { buttons: shareFacts.buttons },
  );
  check('[drop box] no public-link rotation either', shareFacts.newLinkButton === false, {
    buttons: shareFacts.buttons,
  });
  check(
    '[drop box] the missing section says why, so it does not read as a bug',
    /no public link/i.test(shareFacts.text),
    { text: shareFacts.text.slice(0, 400) },
  );
  /*
   * And nothing else on the screen promises the link that paragraph has just
   * said does not exist. The dialog's standing description offered "or publish a
   * read-only link" two lines above it, which no assertion here caught because
   * every one of them was looking for the *control*. Prose contradicting prose
   * is invisible to geometry, so it is asserted as prose.
   */
  check(
    '[drop box] and nothing above it still offers to publish one',
    !/publish a read-only link/i.test(shareFacts.text),
    { text: shareFacts.text.slice(0, 400) },
  );
  check(
    '[drop box] sharing with a named person survives — that is a different act',
    shareFacts.sharePersonField,
  );
  check(
    '[drop box] sharing is reachable from the settings page the header now points at',
    shareFacts.sharePersonField,
  );

  const shareFrame = await frameFacts();
  check(
    '[drop box] the sharing section does not scroll sideways',
    shareFrame.bodyScrollsSideways === false,
    shareFrame,
  );
  /* --------------------------------------------- the appearance picker --- */

  /*
   * The settings dialog on a phone, which is what the whole picker exists for.
   *
   * the product owner's ask was "more icons and more colours" *and* "think of a clean way to
   * display these, because I reckon we'll end up making it feel cluttered". A
   * flat wrap of twenty-six swatches and forty-eight glyphs is about eleven rows
   * on a 390px screen, sitting between the template grid and the delete button.
   * So the assertion is not "the picker exists" — it is that the picker is
   * CLOSED at rest and costs one row, which is the entire design.
   */
  {
    const microblog = seeded.radars.find((r) => r.template === 'microblog');
    if (!microblog) throw new Error('the seed has no microblog to open settings on');
    await goto(`/radar/${microblog.id}/settings?section=appearance`);
    await shot(page, outDir, '80-settings-picker');

    const picker = await page.evaluate(() => {
      const painted = (el: Element) => el.getClientRects().length > 0;
      const q = (sel: string) => [...document.querySelectorAll(sel)].filter(painted);
      const summary = q('.picker-summary')[0] ?? null;
      // The surface holding the picker. It used to be the dialog; it is the
      // page's content column now, and the assertions below still ask the same
      // question — does the picker fit what it is chosen in.
      const dialog = summary?.closest('main') ?? document.querySelector('main');
      const swatches = q('.picker-swatch').length + q('.picker-glyph').length;
      return {
        summaryPresent: Boolean(summary),
        // At rest the whole control is one row. Two rows would mean it wrapped,
        // which on this screen is the clutter the design is avoiding.
        summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : null,
        // Nothing is expanded until asked for. This is the number that would
        // grow to seventy-four if a later change reverted to a flat list.
        swatchesAtRest: swatches,
        panelsAtRest: q('.picker-panel').length,
        // The theme preview is always on, because you cannot pick a paper from
        // a word — but it must not be wider than the dialog holding it.
        previewPresent: q('.theme-preview').length,
        previewOverflows:
          summary && dialog
            ? q('.theme-preview').some(
                (el) => el.getBoundingClientRect().width > dialog.getBoundingClientRect().width + 1,
              )
            : false,
        dialogOverflowsRight: dialog
          ? Math.round(dialog.getBoundingClientRect().right) > window.innerWidth + 1
          : false,
      };
    });
    notes.push({ what: 'appearance picker on a phone', ...picker });

    check(
      '[picker] the appearance control is on the settings screen',
      picker.summaryPresent,
      picker,
    );
    check(
      '[picker] the appearance control is one row at rest, not a wall of swatches',
      picker.summaryHeight !== null && picker.summaryHeight <= 64,
      { summaryHeight: picker.summaryHeight },
    );
    check(
      '[picker] nothing is expanded until it is asked for',
      picker.swatchesAtRest === 0 && picker.panelsAtRest === 0,
      { swatchesAtRest: picker.swatchesAtRest, panelsAtRest: picker.panelsAtRest },
    );
    check(
      '[picker] the style preview is shown without being asked for',
      picker.previewPresent > 0,
      {
        previewPresent: picker.previewPresent,
      },
    );
    check(
      '[picker] the preview fits the surface it is chosen in',
      !picker.previewOverflows,
      picker,
    );
    check(
      '[picker] the settings page is not painted off the right edge',
      !picker.dialogOverflowsRight,
      {
        dialogOverflowsRight: picker.dialogOverflowsRight,
      },
    );

    /* One panel at a time, and it opens where it can be seen. */
    await page.click('.picker-toggle');
    await wait(400);
    const opened = await page.evaluate(() => {
      const painted = (el: Element) => el.getClientRects().length > 0;
      const q = (sel: string) => [...document.querySelectorAll(sel)].filter(painted);
      const panel = q('.picker-panel')[0] ?? null;
      const rows = q('.picker-group-label').map((el) => el.textContent.trim());
      return {
        panels: q('.picker-panel').length,
        groups: rows,
        swatches: q('.picker-swatch').length,
        // Bounded and scrollable rather than pushing Save off the bottom.
        panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        panelScrolls: panel ? panel.scrollHeight > panel.clientHeight + 1 : null,
        offRight: q('.picker-swatch').filter(
          (el) => el.getBoundingClientRect().right > window.innerWidth + 1,
        ).length,
        searchPresent: q('.picker-panel input').length,
      };
    });
    notes.push({ what: 'appearance picker, opened', ...opened });

    check('[picker] exactly one panel opens at a time', opened.panels === 1, {
      panels: opened.panels,
    });
    check('[picker] the colours arrive grouped, with the family named', opened.groups.length >= 4, {
      groups: opened.groups,
    });
    check('[picker] the panel offers a search', opened.searchPresent > 0, {
      searchPresent: opened.searchPresent,
    });
    check('[picker] no swatch sliced at the screen edge', opened.offRight === 0, {
      offRight: opened.offRight,
    });
    /*
     * Inverted on purpose, and the reason matters.
     *
     * This used to assert the open panel capped itself at 300px, because inside
     * a dialog an uncapped panel pushes Save off the bottom of the phone. On the
     * settings *page* that cap was one of three scroll regions stacked
     * vertically, and Save is now a sticky action bar that cannot leave the
     * screen at all. So the cap is not needed and is actively harmful — the
     * guarantee it was standing in for is asserted directly, below.
     */
    check(
      '[picker] the open panel does not scroll inside the page',
      opened.panelScrolls === false,
      { panelHeight: opened.panelHeight, panelScrolls: opened.panelScrolls },
    );

    /*
     * Save is reachable. Directly, rather than through a proxy.
     *
     * The audit's finding was that "Save changes" sat at the bottom of 3.2 phone
     * screens of scroll and nothing asserted you could get to it — the suite
     * proved the dialog *fitted*, never that it could be *used*. The bar is
     * sticky now, so the assertion is that it is inside the visible rectangle
     * without scrolling anywhere.
     */
    const saveBar = await page.evaluate(() => {
      const save = document.querySelector('[data-role="settings-save"]');
      if (!save) return null;
      const rect = save.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        viewport: window.innerHeight,
      };
    });
    notes.push({ what: 'settings save bar', ...(saveBar ?? {}) });
    check(
      '[settings] the primary action is on screen without scrolling for it',
      saveBar !== null && saveBar.bottom <= saveBar.viewport + 1 && saveBar.top >= 0,
      saveBar,
    );
    check('[settings] and it is a thumb target', saveBar !== null && saveBar.height >= 40, saveBar);
  }

  // The settings tabs share one save: a tab switch must preserve the draft.
  {
    const radar = seeded.radars.find((r) => r.template === 'microblog');
    if (!radar) throw new Error('the seed has no microblog for draft navigation');
    await goto(`/radar/${radar.id}/settings`);
    await page.type('::-p-aria([name="Name"][role="textbox"])', ' draft');
    const expected = await page.$eval(
      '::-p-aria([name="Name"][role="textbox"])',
      (el) => (el as HTMLInputElement).value,
    );
    await page.click('.section-tabs a[href*="section=appearance"]');
    await page.waitForSelector('.picker-toggle', { timeout: PATIENCE_MS });
    await page.click('.section-tabs a[href*="section=identity"]');
    await page.waitForSelector('::-p-aria([name="Name"][role="textbox"])', {
      timeout: PATIENCE_MS,
    });
    const actual = await page.$eval(
      '::-p-aria([name="Name"][role="textbox"])',
      (el) => (el as HTMLInputElement).value,
    );
    check('[settings] Identity draft survives a trip through Appearance', actual === expected, {
      expected,
      actual,
    });
    // Reset the draft before the following navigation tests.
    await page.$eval('::-p-aria([name="Name"][role="textbox"])', (el) => {
      (el as HTMLInputElement).select();
    });
    await page.keyboard.press('Backspace');
    await page.type('::-p-aria([name="Name"][role="textbox"])', radar.name);
  }

  // Navigate through the SPA to a warm radar so a loading spinner cannot hide
  // leaked route state by incidentally unmounting the form.
  {
    const source = seeded.radars.find((r) => r.template === 'stream');
    const target = seeded.radars.find((r) => r.template === 'microblog');
    if (!source || !target) throw new Error('the seed lacks navigation radars');
    await goto(`/radar/${target.id}`);
    const navigateRadar = async (id: string) => {
      await page.evaluate((href) => {
        const link = [...document.querySelectorAll<HTMLAnchorElement>('a')].find(
          (el) => el.getAttribute('href') === href,
        );
        if (!link) throw new Error(`Missing radar link: ${href}`);
        link.click();
      }, `/radar/${id}`);
      await page.waitForFunction((id) => window.location.pathname === `/radar/${id}`, {}, id);
      await page.waitForSelector('#global-search', { timeout: PATIENCE_MS });
    };
    await navigateRadar(source.id);
    await page.type('#global-search', 'no-matching-review-blip');
    await wait(500);
    await navigateRadar(target.id);
    const filter = await page.$eval('#global-search', (el) => (el as HTMLInputElement).value);
    check('[radar] changing radar clears the previous header search', filter === '', { filter });
  }

  /* -------------------------------------- tap targets inside a dialog ---- */

  /*
   * **A general gate, not a one-off.** Every interactive element inside an open
   * dialog has a hit box of at least 44px in its smaller dimension.
   *
   * The suite proved a dialog *fitted* — scrim present, no sideways scroll,
   * nothing past the right edge — and never once asserted the size of anything
   * you tap inside one. There was exactly one height assertion in the whole
   * file and it covered nav rows. Meanwhile every `.picker-toggle` measured
   * 32×32, which clears WCAG 2.5.8's 24px and misses the 44px both iOS and
   * Android ask for, on the only route to 26 accents and 48 glyphs.
   *
   * Written against whatever dialog happens to be open rather than a named one,
   * so a dialog added later is covered without anybody editing this block.
   */
  {
    const microblog = seeded.radars.find((r) => r.template === 'microblog');
    if (!microblog) throw new Error('the seed has no microblog for the dialog gate');
    await goto(`/radar/${microblog.id}/settings`);
    await clickText('Delete radar');
    await page.waitForSelector('[role="dialog"]', { timeout: PATIENCE_MS }).catch(() => null);
    await shot(page, outDir, '81-dialog-tap-targets');

    const dialog = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      if (!panel) return null;
      const targets = [...panel.querySelectorAll('button, a, input, select, textarea, [tabindex]')]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            what: `${el.tagName.toLowerCase()}${el.getAttribute('class') ? `.${(el.getAttribute('class') ?? '').split(' ')[0] ?? ''}` : ''}`,
            label: (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 32),
            smaller: Math.round(Math.min(rect.width, rect.height)),
          };
        });
      return {
        // The positive twin of "no scrim on the Radars screen". A negative
        // assertion whose positive twin is never made is a spelling mistake
        // waiting to happen, and this one was: it probed a class that had been
        // deleted, and passed for free.
        scrimPresent: Boolean(document.querySelector('.modal-scrim')),
        targets,
        tooSmall: targets.filter((t) => t.smaller < 44),
        // The consequence is in words, with the real number in it — which is
        // the whole reason a designed confirmation beats `window.prompt`.
        saysWhatItRemoves: /blips?/i.test(panel.textContent),
        // The type-the-name pattern survived the move. It was always right.
        asksForTheName: Boolean(panel.querySelector('input:not([type=checkbox])')),
      };
    });
    notes.push({ what: 'confirm dialog on a phone', ...(dialog ?? {}) });

    check('[dialog] the delete confirmation opens at all', dialog !== null, dialog);
    check(
      '[dialog] a real modal does paint a scrim, so the absence of one means something',
      dialog?.scrimPresent === true,
      { scrimPresent: dialog?.scrimPresent },
    );
    check(
      '[dialog] every control inside an open dialog is at least 44px in its smaller dimension',
      dialog !== null && dialog.tooSmall.length === 0,
      { tooSmall: dialog?.tooSmall, checked: dialog?.targets.length },
    );
    /* The gate would pass vacuously against a dialog with nothing in it. */
    check(
      '[dialog] and there was something in it to measure',
      dialog !== null && dialog.targets.length >= 3,
      { checked: dialog?.targets.length },
    );
    check(
      '[dialog] the confirmation states the consequence in words',
      dialog?.saysWhatItRemoves === true,
      dialog,
    );
    check('[dialog] and still asks for the radar name', dialog?.asksForTheName === true, dialog);
  }

  /* ------------------------------------------------ published radars ----- */

  /*
   * The public page at 390, signed out — the only screen in this product a
   * stranger loads, and now the only one that can be styled by the person who
   * published it.
   *
   * Two radars on the same layout, one carrying the loudest theme in the
   * vocabulary and one carrying none. The pair is what makes the assertions mean
   * something: "the theme is applied" is only informative beside a page where it
   * demonstrably was not.
   *
   * The check that matters most is the byline. The claim made in theme.ts and in
   * DESIGN is that **no theme can hide or fake an author's name**, and it rests
   * on two things — a surface ships its ink with its ground, and nothing in the
   * vocabulary can position or size anything. `theme.test.ts` holds every
   * surface to a contrast floor in the abstract; this holds the rendered page to
   * one, on a real screen, through the real cascade.
   */
  await page.browser().deleteCookie(...(await page.browser().cookies()));

  for (const site of seeded.published) {
    await goto(`/r/${site.slug}`);
    await wait(500);
    await shot(page, outDir, `81-public-${site.preset ?? 'plain'}`);

    const facts = await frameFacts();
    const surface = await page.evaluate(() => {
      const painted = (el: Element) => el.getClientRects().length > 0;
      const q = (sel: string) => [...document.querySelectorAll(sel)].filter(painted);
      const root = document.querySelector('.radar-theme');

      /* WCAG 2.1 relative luminance, over an rgb() string. */
      const rgb = (value: string): [number, number, number] => {
        const nums = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
        return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
      };
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = (value: string) => {
        const [r, g, b] = rgb(value);
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      /** The nearest ancestor that actually paints a background. */
      const groundOf = (el: Element): string => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const contrast = (a: string, b: string) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };

      const byline = q('.attribution')[0] ?? null;
      return {
        themed: Boolean(root),
        surfaceAttr: root?.getAttribute('data-omr-surface') ?? null,
        patternAttr: root?.getAttribute('data-omr-pattern') ?? null,
        // The themed container must cover the window, or a short radar ends in
        // a band of the application's own near-black under the footer.
        coversScreen: root ? root.getBoundingClientRect().height >= window.innerHeight - 1 : null,
        bylinePresent: Boolean(byline),
        bylineText: (byline?.textContent ?? '').trim().slice(0, 60),
        bylineContrast: byline
          ? Math.round(contrast(getComputedStyle(byline).color, groundOf(byline)) * 100) / 100
          : null,
        // A microblog must be drawn as a timeline here, not as the ordinary
        // stream with a kind badge on every post. This is the bug the screenshot
        // showed: the server was already ordering by the template and the SPA
        // was throwing the template away on arrival.
        timeline: q('.timeline').length,
        posts: q('.timeline-post').length,
        // Read-only, always. A public page must offer no way in.
        composers: q('#composer, #quick-drop, textarea, .comment-input').length,
      };
    });
    notes.push({ what: `public radar (${site.name})`, preset: site.preset, ...surface });

    const tag = `public/${site.preset ?? 'unthemed'}`;
    check(`[${tag}] nothing painted off the right edge`, facts.overflowingRight.length === 0, {
      overflowingRight: facts.overflowingRight,
    });
    check(`[${tag}] the page does not scroll sideways`, facts.bodyScrollsSideways === false, facts);
    check(
      `[${tag}] a published microblog is drawn as a timeline, not a stream`,
      surface.timeline === 1 && surface.posts > 0,
      { timeline: surface.timeline, posts: surface.posts },
    );
    check(`[${tag}] a stranger is offered no way to write`, surface.composers === 0, {
      composers: surface.composers,
    });
    check(`[${tag}] the radar is attributed`, surface.bylinePresent, {
      bylineText: surface.bylineText,
    });
    /*
     * 3:1, the WCAG floor for large or incidental text, applied to the smallest
     * text on the page. If a theme could ever push this below the floor the
     * "a theme cannot hide an author" claim would be false, and it is the one
     * claim that lets the whole page be themed rather than just the posts.
     */
    check(
      `[${tag}] the byline stays legible whatever the theme does`,
      surface.bylineContrast !== null && surface.bylineContrast >= 3,
      { bylineContrast: surface.bylineContrast },
    );

    if (site.preset) {
      check(`[${tag}] the theme is applied to the page`, surface.themed === true, surface);
      check(
        `[${tag}] the theme's own paper and pattern are the ones drawn`,
        surface.surfaceAttr === 'bubblegum' && surface.patternAttr === 'stars',
        { surface: surface.surfaceAttr, pattern: surface.patternAttr },
      );
      check(`[${tag}] the paper covers the screen`, surface.coversScreen === true, {
        coversScreen: surface.coversScreen,
      });
    } else {
      // The twin. Without it, "themed" above could pass on a page where every
      // radar is wrapped whether it was styled or not.
      check(
        `[${tag}] an unstyled radar is left completely alone`,
        surface.themed === false,
        surface,
      );
    }
  }

  /* ------------------------------------------------- the invitation ------ */

  /*
   * `/invite/$token` is the one screen a person can reach with no account at
   * all, which makes it the one screen where getting the phone layout wrong
   * costs a user rather than annoying one. It is also where the waitlist
   * promise is made, and an admin's invitation and an ordinary user's must not
   * read the same — that difference is the whole security boundary of the
   * feature (docs/DESIGN.md §19), so it is asserted here as text a person
   * actually sees rather than only as a service-layer return value.
   *
   * Signed out for this part: the invitation screen is what somebody with no
   * session sees, and a logged-in page would redirect straight past it.
   */
  await page.browser().deleteCookie(...(await page.browser().cookies()));

  const inviteFacts = async (
    path: string,
  ): Promise<{ text: string; email: string | null; overflowingRight: string[] }> => {
    await page.goto(seeded.baseUrl + path, { waitUntil: 'networkidle2' });
    await wait(900);
    return page.evaluate(() => {
      const field = document.querySelector('input[type="email"]');
      return {
        text: document.body.innerText,
        email: field instanceof HTMLInputElement ? field.value : null,
        overflowingRight: [...document.querySelectorAll('body *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1;
          })
          .map((el) => `${el.tagName}.${(el.getAttribute('class') ?? '').slice(0, 40)}`),
      };
    });
  };

  const admin = await inviteFacts(`/invite/${seeded.adminInvite.token}`);
  await shot(page, outDir, 'invite-from-admin');

  check('[invite] nothing painted past the right edge', admin.overflowingRight.length === 0, {
    overflowingRight: admin.overflowingRight,
  });
  check(
    '[invite] the radar being handed over is named',
    admin.text.includes(seeded.adminInvite.radarName),
    { radar: seeded.adminInvite.radarName },
  );
  // `.instrument` uppercases, so this has to be case-insensitive — a
  // case-sensitive match here failed against a screen that was entirely correct.
  check(
    '[invite] the person doing the inviting is named',
    new RegExp(seeded.adminInvite.inviterName, 'i').test(admin.text),
    { inviter: seeded.adminInvite.inviterName },
  );
  check('[invite] the role is stated in words', /capture into it/i.test(admin.text));
  check(
    "[invite] an admin's invitation says you go straight in",
    /straight in/i.test(admin.text) && !/waitlist/i.test(admin.text),
    { straightIn: /straight in/i.test(admin.text), waitlist: /waitlist/i.test(admin.text) },
  );
  check('[invite] the invited address is pre-filled', admin.email === seeded.adminInvite.email, {
    email: admin.email,
    expected: seeded.adminInvite.email,
  });
  check('[invite] the generic signup line is replaced', !/New here\?/i.test(admin.text));

  const ordinary = await inviteFacts(`/invite/${seeded.userInvite.token}`);
  await shot(page, outDir, 'invite-from-user');

  check(
    "[invite] an ordinary user's invitation says the account joins a waitlist",
    /waitlist/i.test(ordinary.text) && !/straight in/i.test(ordinary.text),
    {
      waitlist: /waitlist/i.test(ordinary.text),
      straightIn: /straight in/i.test(ordinary.text),
    },
  );
  check(
    '[invite] the two invitations do not read the same',
    /straight in/i.test(admin.text) !== /straight in/i.test(ordinary.text),
  );
  check(
    '[invite] the ordinary invitation names its own radar',
    ordinary.text.includes(seeded.userInvite.radarName),
    { radar: seeded.userInvite.radarName },
  );
  check(
    '[invite] nothing painted past the right edge, ordinary',
    ordinary.overflowingRight.length === 0,
    { overflowingRight: ordinary.overflowingRight },
  );

  const dead = await inviteFacts('/invite/not-a-real-token');
  await shot(page, outDir, 'invite-dead-link');

  check(
    '[invite] a dead link says the invitation is no longer open',
    /no longer open/i.test(dead.text),
  );
  check('[invite] a dead link still offers a working sign-in form', dead.email === '');
  check(
    '[invite] a dead link names no radar',
    !dead.text.includes(seeded.adminInvite.radarName) &&
      !dead.text.includes(seeded.userInvite.radarName),
  );
  check('[invite] a dead link is not a dead end', dead.overflowingRight.length === 0, {
    overflowingRight: dead.overflowingRight,
  });

  /*
   * The self-maintaining part. Adding a template to the registry without giving
   * it a phone screen fails here — and it already failed at `pnpm -r typecheck`,
   * because the seed is a Record keyed on RadarTemplate. This is the runtime
   * half of that same promise, and it is what keeps the `log` layout covered now
   * that the decision log has one.
   */
  const missingTemplates = RADAR_TEMPLATE_IDS.filter((id) => !covered.has(id));
  check('every radar template got a phone screen', missingTemplates.length === 0, {
    covered: [...covered],
    missing: missingTemplates,
  });

  const coveredLayouts = new Set([...covered].map((id) => templateFor(id).layout));
  const expectedLayouts = new Set(RADAR_TEMPLATE_IDS.map((id) => templateFor(id).layout));
  check(
    'every template LAYOUT got a phone screen, `log` included',
    [...expectedLayouts].every((l) => coveredLayouts.has(l)),
    { covered: [...coveredLayouts], expected: [...expectedLayouts] },
  );

  return { checks, failures, notes };
}

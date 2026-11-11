/**
 * The architecture radar in a real browser, at a phone and at three desktop
 * sizes (1280x900, 1440x900, 1920x1080): the page never scrolls sideways, every
 * tap target is 44px, the phone gets the Seams list (and a full-screen map that
 * pinches), a desktop gets the drawing beside its detail rail with both on
 * screen at once and no Open map button, the card uses the content pane's
 * width, and no control in it is a square-cornered bordered button. Called from
 * `runArchitectureFlows`; run alone with `--architecture-only`.
 */
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { IOS_UA, PATIENCE_MS, PHONE } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

const TARGETS =
  '.arch-tab, .arch-bar .segmented button, .arch-seam-head, .arch-seams > .btn, .arch-links .btn, .arch-matrix-one .select-trigger, .arch-cell-link, .arch-zoom .btn, .arch-overlay-bar .btn';

/** A large pack's shape: 24 boundaries of ours, 16 outside, 26 contracts. The seeded radar has four. */
const OURS = [
  'C1 Edge',
  'C2 Identity and access',
  'C3 Command bus',
  'C4 Query service and read models',
  'C5 Policy PDP',
  'C6 Run engine',
  'C7 Scheduler and jobs',
  'C8 Event log, outbox and audit',
  'C9 Persistence, schemas, migrations',
  'M1 Sites',
  'M2 Catalog',
  'M3 Placement',
  'M4 Delivery',
  'M5 Domains and edge',
  'M6 Credentials and secrets',
  'M7 Backup and seal',
  'M8 Billing',
  'M9 Health',
  'M10 Notifications',
  'M11 Platform apps',
  'M12 Associations',
  'Admin UI',
  'Every module',
  'Adapters and fakes (A*)',
];
const OUTSIDE = [
  'Stripe',
  'Cloudflare',
  'Harbor',
  'Kubernetes',
  'Secret store',
  'GitLab API',
  'GitOps repository layout and Fleet',
  'Roving CMS',
  'Transactional email',
  'Shared-delivery platform apps',
  'Domain registrar',
  'External Secrets Operator',
  'Acme portal',
  'MCP task tools',
  'Site CI to Acme',
  'Per-site Helm chart',
];

/** Press a view's tab. */
async function tab(human: Page, label: string): Promise<void> {
  await human.evaluate((text) => {
    [...document.querySelectorAll<HTMLElement>('[role=tab]')]
      .find((t) => t.textContent === text)
      ?.click();
  }, label);
}

/** A scratch radar of that size, made through the API, and the way to take it away again. */
async function largeSized(seeded: Seeded): Promise<{ id: string; drop: () => Promise<void> }> {
  const call = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
  const { radar } = await call<{ radar: { id: string } }>('/api/radars', 'POST', {
    name: 'Architecture at large-pack size',
    accent: 'slate',
    glyph: 'compass',
    template: 'architecture',
  });
  const boundary = async (title: string, external: boolean) =>
    (
      await call<{ boundary: { id: string } }>(`/api/radars/${radar.id}/boundaries`, 'POST', {
        title,
        external,
        owns: external ? [] : [`${title.toLowerCase().replace(/\W+/g, '_')}.rows`],
      })
    ).boundary.id;
  const ours: string[] = [];
  for (const title of OURS) ours.push(await boundary(title, false));
  const theirs: string[] = [];
  for (const title of OUTSIDE) theirs.push(await boundary(title, true));
  const seam = async (title: string, a: string, b: string) =>
    call(`/api/radars/${radar.id}/contracts`, 'POST', { title, version: '1.0', a, b });
  for (const [i, other] of theirs.entries())
    await seam(OUTSIDE[i] ?? 'Link', ours[(i * 3) % ours.length] as string, other);
  for (let i = 0; i < 10; i += 1)
    await seam(`Step ${i + 1}`, ours[i * 2] as string, ours[i * 2 + 1] as string);
  return { id: radar.id, drop: async () => void (await call(`/api/radars/${radar.id}`, 'DELETE')) };
}

export async function runArchitectureMapFlows(page: Page, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
    assert(ok, `${name} ${JSON.stringify(detail)}`);
  };
  const radar = seeded.radars.find((r) => r.template === 'architecture');
  assert(radar, 'seed has no architecture radar');
  const VIEWS = [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];
  for (const { width, height } of VIEWS) {
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    human.setDefaultTimeout(PATIENCE_MS);
    await human.setViewport(width === 390 ? PHONE : { width, height });
    if (width === 390) await human.setUserAgent({ userAgent: IOS_UA });
    await context.setCookie({
      name: 'omr_session',
      value: seeded.ownerCookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    const tag = `[architecture map ${width}]`;
    const facts = () =>
      human.evaluate(
        (targets) => ({
          sideways:
            document.documentElement.scrollWidth > window.innerWidth ||
            document.body.scrollWidth > window.innerWidth,
          small: [...document.querySelectorAll<HTMLElement>(targets)]
            .filter((el) => el.offsetParent !== null)
            .map((el) => [el.className || el.tagName, el.getBoundingClientRect()] as const)
            .filter(([, box]) => box.height < 43.5)
            .map(([name]) => name),
        }),
        TARGETS,
      );
    const tab = async (label: string) => {
      await human.evaluate((text) => {
        [...document.querySelectorAll<HTMLElement>('[role=tab]')]
          .find((t) => t.textContent === text)
          ?.click();
      }, label);
    };
    /*
     * What every view of the card must hold at every size: it takes the content
     * pane's width (not a 760px column in a 1250px pane), no button in it has
     * square corners with a border (nowhere else in the app does), and "Open map"
     * is a phone's way to the drawing, so a desktop never says it.
     */
    const layout = async (view: string) => {
      const l = await human.evaluate(() => {
        const arch = document.querySelector<HTMLElement>('.arch');
        const pane = document.querySelector<HTMLElement>('.app-content');
        const square = [...document.querySelectorAll<HTMLButtonElement>('.arch button')]
          .filter((b) => {
            const css = getComputedStyle(b);
            const bordered = (['Top', 'Right', 'Bottom', 'Left'] as const).some(
              (side) =>
                parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
                css.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
                !/rgba\(.*, 0\)$/.test(css.getPropertyValue(`border-${side.toLowerCase()}-color`)),
            );
            const corners = [
              css.borderTopLeftRadius,
              css.borderTopRightRadius,
              css.borderBottomRightRadius,
              css.borderBottomLeftRadius,
            ];
            return bordered && corners.some((r) => parseFloat(r) === 0);
          })
          .map((b) => `${b.className || b.tagName} “${b.textContent.trim().slice(0, 24)}”`);
        return {
          share: arch && pane ? arch.getBoundingClientRect().width / pane.clientWidth : 0,
          square,
          openMap: document.body.textContent.includes('Open map'),
          sideways: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      check(
        `${tag} ${view}: the card does not scroll the page sideways, and no button in it is square-cornered with a border`,
        !l.sideways && l.square.length === 0,
        l,
      );
      if (width >= 1024) {
        check(
          `${tag} ${view}: the card is at least 90% of the content pane (${l.share.toFixed(2)})`,
          l.share >= 0.9,
          l,
        );
        check(`${tag} ${view}: there is no Open map button on a desktop`, !l.openMap, l);
      }
    };
    try {
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await human.waitForSelector('.arch-tab', { visible: true });
      await layout('Charter');
      if (width >= 1024) {
        const rail = await human.evaluate(() => {
          const doc = document.querySelector('.arch-doc')?.getBoundingClientRect();
          const rail = document.querySelector('.arch-rail')?.getBoundingClientRect();
          const prose = document.querySelector<HTMLElement>('.arch-page > p');
          return {
            beside: Boolean(doc && rail && rail.left >= doc.right - 1 && rail.top <= doc.top + 1),
            // The charter is one document at the full width of its column: no prose measure.
            proseWidth: prose?.getBoundingClientRect().width ?? 0,
            columnWidth: doc?.width ?? 0,
            font: prose ? parseFloat(getComputedStyle(prose).fontSize) : 16,
          };
        });
        check(
          `${tag} the charter sits beside its ledger rail, and its prose fills the column`,
          rail.beside && rail.proseWidth >= rail.columnWidth - 120,
          rail,
        );
        // The rail keeps its place down a long charter, and scrolls on its own if it must.
        const sticky = await human.evaluate(() => {
          const pane = document.querySelector<HTMLElement>('.app-content');
          const inner = document.querySelector<HTMLElement>('.arch-rail-inner');
          if (!pane || !inner) return null;
          const before = inner.getBoundingClientRect().top;
          pane.scrollTop = 1500;
          const after = inner.getBoundingClientRect();
          const bar = document.querySelector('.arch-bar')?.getBoundingClientRect();
          const header = document.querySelector('header.sticky')?.getBoundingClientRect();
          return {
            barTop: bar ? Math.round(bar.top) : null,
            barBottom: bar ? Math.round(bar.bottom) : null,
            headerBottom: header ? Math.round(header.bottom) : null,
            scrolled: pane.scrollTop,
            before: Math.round(before),
            top: Math.round(after.top),
            bottom: Math.round(after.bottom),
            height: window.innerHeight,
            overflowY: getComputedStyle(inner).overflowY,
          };
        });
        check(
          `${tag} the ledger rail stays in view while the charter scrolls, and scrolls on its own`,
          sticky !== null &&
            sticky.scrolled > 500 &&
            sticky.top > 0 &&
            sticky.top < sticky.before &&
            sticky.bottom <= sticky.height &&
            sticky.overflowY === 'auto',
          sticky,
        );
        check(
          `${tag} the tabs stay under the radar header while the charter scrolls, above the rail`,
          sticky !== null &&
            sticky.barTop !== null &&
            sticky.headerBottom !== null &&
            sticky.barTop >= sticky.headerBottom - 1 &&
            sticky.barTop <= sticky.headerBottom + 2 &&
            sticky.barBottom !== null &&
            sticky.top >= sticky.barBottom - 1,
          sticky,
        );
        await human.evaluate(() => {
          document.querySelector('.app-content')?.scrollTo(0, 0);
        });
      }

      await tab('Map');
      if (width === 390) {
        await human.waitForSelector('.arch-seam-head', { visible: true });
        const heads = await human.$$eval('.arch-seam-head', (n) => n.map((h) => h.textContent));
        check(
          `${tag} the Map tab is the Seams list: every boundary, with its owns count`,
          heads.length === 4 && heads.some((t) => t.includes('2 owned')),
          heads,
        );
        check(
          `${tag} no drawing is squeezed into the page`,
          (await human.$('.arch-map-svg')) === null,
        );
        await human.click('.arch-seam-head');
        await human.waitForSelector('.arch-seam-row .arch-detail', { visible: true });
        const detail = await human.$eval('.arch-seam-row .arch-detail', (n) => n.textContent);
        check(
          `${tag} a boundary opens onto what it owns, its seams and its ADRs`,
          detail.includes('billing.billing_links') &&
            detail.includes('Stripe v1.0') &&
            detail.includes('Site billing') &&
            /ADR/.test(detail),
          detail,
        );
        await human.evaluate(() => {
          [...document.querySelectorAll<HTMLElement>('.arch-seam-row .arch-links .btn')]
            .find((b) => b.textContent.includes('Stripe v1.0'))
            ?.click();
        });
        await human.waitForFunction(() =>
          document.querySelector('.arch-seam-row .arch-detail')?.textContent.includes('Contract'),
        );
        const seam = await human.$eval('.arch-seam-row .arch-detail', (n) => n.textContent);
        check(
          `${tag} tapping a seam keeps its panel: both sides, the version and the ADRs`,
          seam.includes('Contract · v1.0') &&
            seam.includes('M8 Billing') &&
            seam.includes('Stripe') &&
            /ADR/.test(seam),
          seam,
        );
        let f = await facts();
        check(
          `${tag} the Seams list never scrolls sideways and every target is 44px`,
          !f.sideways && f.small.length === 0,
          f,
        );
        await layout('Map list');

        await human.evaluate(() => {
          [...document.querySelectorAll<HTMLElement>('.arch-seams > .btn')]
            .find((b) => b.textContent === 'Open map')
            ?.click();
        });
        await human.waitForSelector('.arch-overlay .map-node', { visible: true });
        // Fixed to the screen, not to the card it is drawn inside (containment would crop it).
        const cover = await human.evaluate(() => {
          const box = document.querySelector('.arch-overlay')?.getBoundingClientRect();
          return {
            left: box?.left,
            top: box?.top,
            width: box?.width,
            height: box?.height,
            screen: [window.innerWidth, window.innerHeight],
          };
        });
        check(
          `${tag} the full-screen map covers the whole screen`,
          cover.left === 0 &&
            cover.top === 0 &&
            cover.width === cover.screen[0] &&
            cover.height === cover.screen[1],
          cover,
        );
        const before = await human.$eval('[data-zoom]', (n) => Number(n.getAttribute('data-zoom')));
        // Two fingers spreading apart, as the pointer events a touch screen sends.
        await human.evaluate(() => {
          const pane = document.querySelector('.arch-pinch') as HTMLElement;
          const steps: Array<[string, number, number]> = [
            ['pointerdown', 1, 150],
            ['pointerdown', 2, 240],
            ['pointermove', 1, 100],
            ['pointermove', 2, 290],
            ['pointerup', 1, 100],
            ['pointerup', 2, 290],
          ];
          for (const [type, id, x] of steps)
            pane.dispatchEvent(
              new PointerEvent(type, { pointerId: id, clientX: x, clientY: 300, bubbles: true }),
            );
        });
        const after = await human.$eval('[data-zoom]', (n) => Number(n.getAttribute('data-zoom')));
        check(`${tag} spreading two fingers zooms the map`, after > before * 1.5, {
          before,
          after,
        });
        /*
         * A finger that lands on a box and drags: the first move hands the pointer from the box to
         * the pane, which must not end the drag. Real touch events, through CDP, with the drag
         * starting on a box; then a tap on a box (no movement) still picks it.
         */
        const cdp = await human.createCDPSession();
        const finger = async (
          type: 'touchStart' | 'touchMove' | 'touchEnd',
          x: number,
          y: number,
        ) => {
          await cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints:
              type === 'touchEnd' ? [] : [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
          });
          await new Promise((done) => setTimeout(done, 20));
        };
        // Wait for the page to catch up (a loaded runner renders late): poll, never a fixed pause.
        const until = async (ready: () => Promise<boolean>, ms = 4000) => {
          const end = Date.now() + ms;
          while (Date.now() < end) {
            if (await ready()) return true;
            await new Promise((done) => setTimeout(done, 25));
          }
          return false;
        };
        const refit = async () => {
          await human.evaluate(() => {
            document.querySelector<HTMLElement>('[aria-label="Fit to box"]')?.click();
          });
          await until(async () =>
            human.evaluate(
              () => document.querySelector('.arch-pinch')?.getAttribute('data-zoom') === '1.00',
            ),
          );
          await new Promise((done) => setTimeout(done, 150));
        };
        // A box that can be touched: its centre is on it, on the screen, in the drawing's pane.
        const reachable = async (skip: string, want = '') =>
          human.evaluate(
            (avoid, only) => {
              const pane = document.querySelector('.arch-pinch')?.getBoundingClientRect();
              const nodes = [...document.querySelectorAll('.arch-overlay .map-node')];
              for (const n of nodes) {
                const r = n.getBoundingClientRect();
                const x = r.left + r.width / 2;
                const y = r.top + r.height / 2;
                if (!pane || x < pane.left + 20 || x > pane.right - 20) continue;
                if (y < pane.top + 20 || y > pane.bottom - 20) continue;
                if (
                  only
                    ? n.textContent !== only
                    : n.classList.contains('is-selected') || n.textContent === avoid
                )
                  continue;
                const hit = document.elementFromPoint(x, y);
                if (hit && n.contains(hit)) return { x, y, text: n.textContent };
              }
              return null;
            },
            skip,
            want,
          );
        await refit();
        const selectedText = async () =>
          human.evaluate(
            () => document.querySelector('.arch-overlay .map-node.is-selected')?.textContent ?? '',
          );
        const viewNow = async () =>
          human.evaluate(
            () => document.querySelector('.arch-pinch svg')?.getAttribute('viewBox') ?? '',
          );
        const grab = await reachable('');
        const chosenBefore = await selectedText();
        const views: string[] = [await viewNow()];
        if (grab) {
          await finger('touchStart', grab.x, grab.y);
          for (let i = 1; i <= 14; i += 1) {
            const previous = views[views.length - 1];
            await finger('touchMove', grab.x - i * 8, grab.y - i * 4);
            await until(async () => (await viewNow()) !== previous, 1500);
            views.push(await viewNow());
          }
          await finger('touchEnd', 0, 0);
        }
        await new Promise((done) => setTimeout(done, 300));
        const moved = views.filter((v, i) => i > 0 && v !== views[i - 1]).length;
        check(
          `${tag} a touch drag that starts on a box keeps panning on every move`,
          grab !== null && moved >= 13 && (await selectedText()) === chosenBefore,
          { moved, of: 14, grabbed: grab?.text, selectedBefore: chosenBefore },
        );
        await refit();
        const tapped = await reachable('');
        if (tapped) {
          await finger('touchStart', tapped.x, tapped.y);
          await finger('touchEnd', 0, 0);
          await until(async () => (await selectedText()) === tapped.text);
        }
        check(
          `${tag} a tap on a box, with no movement, picks it`,
          tapped !== null && (await selectedText()) === tapped.text,
          { tapped: tapped?.text, selected: await selectedText() },
        );
        // Leave the selection where the rest of the flow expects it: the Matrix tab's one-boundary
        // view starts from it. Back on the box that was chosen, or, when none was, nothing chosen
        // (a tap on the bare drawing clears it).
        await refit();
        if (chosenBefore) {
          const back = await reachable('', chosenBefore);
          if (back) {
            await finger('touchStart', back.x, back.y);
            await finger('touchEnd', 0, 0);
            await until(async () => (await selectedText()) === chosenBefore);
          }
        } else {
          const bare = await human.evaluate(() => {
            const pane = document.querySelector('.arch-pinch')?.getBoundingClientRect();
            if (!pane) return null;
            for (let y = pane.bottom - 12; y > pane.top + 60; y -= 14)
              for (let x = pane.left + 12; x < pane.right - 60; x += 14) {
                const hit = document.elementFromPoint(x, y);
                if (
                  hit &&
                  (hit.classList.contains('map-frame') || hit.classList.contains('arch-map-svg'))
                )
                  return { x, y };
              }
            return null;
          });
          if (bare) {
            await finger('touchStart', bare.x, bare.y);
            await finger('touchEnd', 0, 0);
            await until(async () => (await selectedText()) === '');
          }
          check(
            `${tag} the map is left with nothing chosen, as it was found`,
            bare !== null && (await selectedText()) === '',
            {
              bare,
            },
          );
        }
        await cdp.detach();
        const close = await human.evaluate(() => {
          const button = [...document.querySelectorAll<HTMLElement>('.arch-overlay-bar .btn')].find(
            (b) => b.textContent === 'Close map',
          );
          const box = button?.getBoundingClientRect();
          const hit = box
            ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            : null;
          return {
            reachable: Boolean(hit && button?.contains(hit)),
            height: box?.height ?? 0,
            sideways: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        check(
          `${tag} the full-screen map can be closed, and does not widen the page`,
          close.reachable && close.height >= 43.5 && !close.sideways,
          close,
        );
        await human.evaluate(() => {
          [...document.querySelectorAll<HTMLElement>('.arch-overlay-bar .btn')]
            .find((b) => b.textContent === 'Close map')
            ?.click();
        });

        await tab('Matrix');
        await human.waitForSelector('.arch-matrix-one .select-trigger', { visible: true });
        const rows = await human.$$eval('.arch-matrix-one > .arch-links li', (n) =>
          n.map((li) => li.textContent),
        );
        check(
          `${tag} the Matrix tab shows one boundary: each counterparty, with its contract or a way to add one`,
          rows.length === 3 &&
            rows.some((r) => r.includes('Add a contract')) &&
            rows.some((r) => r.includes('Stripe')),
          rows,
        );
        await human.evaluate(() => {
          [...document.querySelectorAll<HTMLElement>('.arch-matrix-one .arch-cell-link')]
            .find((b) => b.textContent === 'v1.0')
            ?.click();
        });
        // The owner can write, so a cell opens its contract in a full-height sheet.
        // The sheet opens at once and fills in when the contract has been read.
        await human.waitForSelector('.modal-panel.is-side input[id$="-version"]', {
          visible: true,
        });
        const cell = await human.evaluate(() => ({
          text: document.querySelector('.modal-panel.is-side')?.textContent ?? '',
          version: document.querySelector<HTMLInputElement>(
            '.modal-panel.is-side input[id$="-version"]',
          )?.value,
          remove: [...document.querySelectorAll('.modal-panel.is-side button')].some(
            (b) => b.textContent === 'Remove contract',
          ),
        }));
        check(
          `${tag} tapping a matrix cell opens its contract: both sides, the version, Remove`,
          cell.text.includes('M8 Billing') &&
            cell.text.includes('Stripe') &&
            cell.version === '1.0' &&
            cell.remove,
          cell,
        );
        await human.click('.modal-panel.is-side .side-panel-close');
        await human.waitForSelector('.modal-panel.is-side', { hidden: true });
        f = await facts();
        check(
          `${tag} the Matrix tab never scrolls sideways and every target is 44px`,
          !f.sideways && f.small.length === 0,
          f,
        );
        await layout('Matrix');
      } else {
        await human.waitForSelector('.arch-map-svg', { visible: true });
        await human.click('.map-node');
        await human.waitForSelector('.arch-focus .arch-detail', { visible: true });
        const panel = await human.evaluate(() => ({
          text: document.querySelector('.arch-focus')?.textContent ?? '',
          dimmed: document.querySelectorAll('.map-node.is-dim').length,
          badges: [
            document.querySelectorAll('.map-badge.is-proposed').length,
            document.querySelectorAll('.map-seam.is-accepted').length,
          ],
        }));
        check(
          `${tag} clicking a boundary dims the rest and fills the focus panel`,
          panel.dimmed > 0 && panel.text.length > 20,
          panel,
        );
        check(
          `${tag} an open ADR marks Billing amber and an accepted one the Stripe seam red`,
          panel.badges[0] === 1 && panel.badges[1] === 1,
          panel.badges,
        );
        const frame = await human.$eval('.map-frame', (n) => {
          const box = n.getBoundingClientRect();
          return [Math.round(box.width), Math.round(box.height)];
        });
        check(
          `${tag} the application frame is drawn`,
          (frame[0] ?? 0) > 100 && (frame[1] ?? 0) > 30,
          frame,
        );
        /*
         * The drawing is fitted to its box, so it is whole inside it; zooming in
         * (the labels are 11px drawn at 1:1) is what makes them readable.
         */
        const fit = await human.evaluate(() => {
          const box = document.querySelector('.arch-mapbox')?.getBoundingClientRect();
          const frame = document.querySelector('.map-frame')?.getBoundingClientRect();
          return {
            inside: Boolean(
              box &&
              frame &&
              frame.left >= box.left - 1 &&
              frame.right <= box.right + 1 &&
              frame.top >= box.top - 1 &&
              frame.bottom <= box.bottom + 1,
            ),
            zoom: document.querySelector('.arch-pinch')?.getAttribute('data-zoom'),
          };
        });
        check(
          `${tag} the drawing starts fitted to its box (zoom 1.00)`,
          fit.inside && fit.zoom === '1.00',
          fit,
        );
        // The frame's own label is not under the first row of boxes.
        const labelled = await human.evaluate(() => {
          const label = document.querySelector('.map-frame-label')?.getBoundingClientRect();
          const tops = [...document.querySelectorAll('.map-node:not(.is-external)')]
            .map((n) => n.getBoundingClientRect())
            .filter((r) => label && r.left < label.right && r.right > label.left)
            .map((r) => r.top);
          return {
            labelBottom: label ? Math.round(label.bottom) : null,
            firstBox: tops.length ? Math.round(Math.min(...tops)) : null,
          };
        });
        check(
          `${tag} the frame label clears the first row of boxes`,
          labelled.labelBottom !== null &&
            (labelled.firstBox === null || labelled.firstBox >= labelled.labelBottom),
          labelled,
        );
        if (width >= 1024) {
          // A pinch (ctrl + wheel) zooms and a plain wheel pans, and neither scrolls the page.
          const wheels = await human.evaluate(async () => {
            // No named arrow functions in here: the bundler's name helper is not in the page.
            const pane = document.querySelector('.arch-pinch') as HTMLElement;
            const read = {
              zoom: pane.getAttribute('data-zoom'),
              view: pane.querySelector('svg')?.getAttribute('viewBox'),
            };
            const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
            pane.dispatchEvent(plain);
            // Until the drawing has moved (a loaded runner renders late), then a beat to settle.
            for (let t = 0; t < 120; t += 1) {
              if (pane.querySelector('svg')?.getAttribute('viewBox') !== read.view) break;
              await new Promise((done) => setTimeout(done, 25));
            }
            await new Promise((done) => setTimeout(done, 100));
            const afterPan = {
              zoom: pane.getAttribute('data-zoom'),
              view: pane.querySelector('svg')?.getAttribute('viewBox'),
            };
            const pinch = new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: -200,
              ctrlKey: true,
            });
            pane.dispatchEvent(pinch);
            for (let t = 0; t < 120; t += 1) {
              if (pane.getAttribute('data-zoom') !== afterPan.zoom) break;
              await new Promise((done) => setTimeout(done, 25));
            }
            await new Promise((done) => setTimeout(done, 100));
            return {
              panned: plain.defaultPrevented,
              pannedMoved: afterPan.view !== read.view && afterPan.zoom === read.zoom,
              pinched: pinch.defaultPrevented,
              pinchedZoom: Number(pane.getAttribute('data-zoom')) > Number(afterPan.zoom),
              hint: document.querySelector('.arch-hint')?.textContent ?? '',
            };
          });
          check(
            `${tag} a plain wheel pans the map, a pinch zooms it, and the hint says so`,
            wheels.panned &&
              wheels.pannedMoved &&
              wheels.pinched &&
              wheels.pinchedZoom &&
              wheels.hint === 'Pinch or ⌘-scroll to zoom',
            wheels,
          );
          // Hard on the wheel: twenty ticks down, then a pinch-free run the other way. The drawing
          // keeps at least 40% of the box's height (the fitted view stays reachable, never empty).
          const reach = await human.evaluate(async () => {
            const pane = document.querySelector('.arch-pinch') as HTMLElement;
            const [w, h] = (pane.getAttribute('data-extent') ?? '1x1').split('x').map(Number);
            const svg = pane.querySelector('svg') as SVGSVGElement;
            const out: Record<string, number> = {};
            for (const [name, dy] of [
              ['down', 150],
              ['up', -150],
            ] as const) {
              for (let i = 0; i < 20; i += 1)
                pane.dispatchEvent(
                  new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy }),
                );
              // Settled: the drawing has not moved for three looks in a row.
              let still = 0;
              let last = '';
              for (let t = 0; t < 200 && still < 3; t += 1) {
                await new Promise((done) => setTimeout(done, 40));
                const now = svg.getAttribute('viewBox') ?? '';
                still = now === last ? still + 1 : 0;
                last = now;
              }
              const ctm = svg.getScreenCTM() as DOMMatrix;
              const box = pane.getBoundingClientRect();
              const top = ctm.f;
              const bottom = ctm.f + (h as number) * ctm.d;
              const across = Math.min(box.bottom, bottom) - Math.max(box.top, top);
              out[name] = Math.max(0, across) / box.height;
            }
            void w;
            return out;
          });
          check(
            `${tag} after 20 wheel ticks either way the drawing still covers 40% of the box height`,
            (reach['down'] ?? 0) >= 0.4 - 0.01 && (reach['up'] ?? 0) >= 0.4 - 0.01,
            reach,
          );
          await human.evaluate(() => {
            document.querySelector<HTMLElement>('[aria-label="Fit to box"]')?.click();
          });
        }
        for (let i = 0; i < 5; i += 1)
          await human.evaluate(() => {
            document.querySelector<HTMLElement>('[aria-label="Zoom in"]')?.click();
          });
        const type = await human.evaluate(() => {
          const svg = document.querySelector<SVGSVGElement>('.arch-map-svg');
          const scale = svg?.getScreenCTM()?.a ?? 0;
          const sizes = [...document.querySelectorAll('.arch-map-svg text')].map(
            (t) => parseFloat(getComputedStyle(t).fontSize) * scale,
          );
          return {
            largest: Math.round(Math.max(...sizes) * 10) / 10,
            zoom: document.querySelector('.arch-pinch')?.getAttribute('data-zoom'),
          };
        });
        check(
          `${tag} zooming in draws the labels at 11px or more`,
          type.largest >= 10.9 && Number(type.zoom) > 3,
          type,
        );
        await human.evaluate(() => {
          document.querySelector<HTMLElement>('[aria-label="Fit to box"]')?.click();
        });

        /*
         * Everything at once: after a click the detail rail is on screen, beside
         * the drawing, without scrolling the page.
         */
        await human.click('.map-node');
        await human.waitForSelector('.arch-focus .arch-detail', { visible: true });
        const seen = await human.evaluate(() => {
          const rail = document.querySelector('.arch-focus')?.getBoundingClientRect();
          const box = document.querySelector('.arch-mapbox')?.getBoundingClientRect();
          return {
            railBottom: Math.round(rail?.bottom ?? Infinity),
            railRight: Math.round(rail?.right ?? Infinity),
            beside: Boolean(rail && box && rail.left >= box.right - 1 && rail.top <= box.top + 1),
            height: window.innerHeight,
            width: window.innerWidth,
          };
        });
        check(
          `${tag} after a click the detail rail sits beside the map and is fully on screen`,
          seen.beside && seen.railBottom <= seen.height && seen.railRight <= seen.width,
          seen,
        );
        await layout('Map');

        let f = await facts();
        check(`${tag} the Map tab never scrolls sideways`, !f.sideways, f);

        await tab('Matrix');
        await human.waitForSelector('.arch-matrix', { visible: true });
        const matrix = await human.evaluate(() => {
          const row = document.querySelector('.arch-matrix tbody th') as HTMLElement;
          return {
            sticky: getComputedStyle(row).position === 'sticky',
            empty: document.querySelectorAll('td.is-none').length,
            filled: document.querySelectorAll('td.is-hit .arch-cell-link').length,
            insideBox:
              (document.querySelector('.arch-matrix-scroll') as HTMLElement).getBoundingClientRect()
                .right <=
              window.innerWidth + 1,
          };
        });
        check(
          `${tag} the matrix has a sticky first column, empty cells labelled, and stays in its box`,
          matrix.sticky && matrix.empty > 0 && matrix.filled === 6 && matrix.insideBox,
          matrix,
        );
        f = await facts();
        check(`${tag} the Matrix tab never scrolls sideways`, !f.sideways, f);
        await layout('Matrix');
      }
      await human
        .screenshot({
          path: `${process.env['OMR_PHONE_OUT'] ?? '/tmp'}/architecture-map-${width}.png`,
        })
        .catch(() => null);
    } finally {
      await context.close();
    }
  }
  /*
   * The picture at a large pack's size. Four boundaries fit any box, so this is where the layout is
   * held to account: the drawing is shaped for the box (it fills it, with no band of nothing above
   * and below), and at 1440 and 1920 it is drawn at a scale where a 12px label is 9px or more.
   */
  const big = await largeSized(seeded);
  try {
    for (const { width, height, scale } of [
      { width: 1280, height: 900, scale: 0 },
      { width: 1440, height: 900, scale: 0.75 },
      { width: 1920, height: 1080, scale: 0.9 },
    ]) {
      const context = await page.browser().createBrowserContext();
      const human = await context.newPage();
      human.setDefaultTimeout(PATIENCE_MS);
      await human.setViewport({ width, height });
      await context.setCookie({
        name: 'omr_session',
        value: seeded.ownerCookie.slice('omr_session='.length),
        domain: new URL(seeded.baseUrl).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      });
      const tag = `[architecture map ${width}x${height}, large-pack size]`;
      try {
        await human.goto(`${seeded.baseUrl}/radar/${big.id}?tab=map`, {
          waitUntil: 'networkidle2',
        });
        await human.waitForSelector('.map-node', { visible: true });
        const read = () =>
          human.evaluate(() => {
            const box = document.querySelector('.arch-pinch')?.getBoundingClientRect();
            const nodes = [...document.querySelectorAll('.map-node')].map((n) =>
              n.getBoundingClientRect(),
            );
            const svg = document.querySelector<SVGSVGElement>('.arch-map-svg');
            const left = Math.min(...nodes.map((r) => r.left));
            const right = Math.max(...nodes.map((r) => r.right));
            const top = Math.min(...nodes.map((r) => r.top));
            const bottom = Math.max(...nodes.map((r) => r.bottom));
            return {
              boxes: nodes.length,
              box: [Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)],
              drawing: [Math.round(right - left), Math.round(bottom - top)],
              fillW: (right - left) / (box?.width ?? Infinity),
              fillH: (bottom - top) / (box?.height ?? Infinity),
              scale: svg?.getScreenCTM()?.a ?? 0,
            };
          });
        // It is laid out again once the box has its final size; wait for that to stop moving.
        let seen = await read();
        for (let i = 0; i < 20; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          const next = await read();
          const settled = next.drawing.join() === seen.drawing.join();
          seen = next;
          if (settled && i > 2) break;
        }
        const wide = Math.max(seen.fillW, seen.fillH);
        const narrow = Math.min(seen.fillW, seen.fillH);
        check(
          `${tag} the drawing fills its box: ${Math.round(wide * 100)}% one way, ${Math.round(narrow * 100)}% the other`,
          seen.boxes === 40 && wide >= 0.85 && narrow >= 0.7,
          seen,
        );
        if (scale > 0)
          check(
            `${tag} drawn at ${seen.scale.toFixed(2)}x, so a 12px label is ${(12 * seen.scale).toFixed(1)}px`,
            seen.scale >= scale,
            seen,
          );
        if (width === 1440) {
          // The matrix at this size: every row the same height, the header and first column sticky.
          await tab(human, 'Matrix');
          await human.waitForSelector('.arch-matrix', { visible: true });
          const rows = await human.evaluate(() => {
            const heights = [...document.querySelectorAll('.arch-matrix tbody tr')].map(
              (r) => r.getBoundingClientRect().height,
            );
            const head = document.querySelector('.arch-matrix thead th');
            const first = document.querySelector('.arch-matrix tbody th');
            return {
              rows: heights.length,
              spread: Math.max(...heights) - Math.min(...heights),
              headSticky: head ? getComputedStyle(head).position === 'sticky' : false,
              firstSticky: first ? getComputedStyle(first).position === 'sticky' : false,
            };
          });
          check(
            `${tag} matrix rows are one height (within ${rows.spread.toFixed(1)}px) with a sticky header and first column`,
            rows.rows === 40 && rows.spread <= 2 && rows.headSticky && rows.firstSticky,
            rows,
          );
        }
        await human
          .screenshot({
            path: `${process.env['OMR_PHONE_OUT'] ?? '/tmp'}/architecture-xl-${width}.png`,
          })
          .catch(() => null);
      } finally {
        await context.close();
      }
    }
  } finally {
    await big.drop();
  }
  return { checks, failures, notes: [] };
}

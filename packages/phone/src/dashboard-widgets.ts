/** Dashboard display modes and filing use the real API, not mocked counts. */
import type { Page } from 'puppeteer-core';
import type { DashboardDto, RadarDto, BlipDto } from '@onmyradar/contract';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';
import { shot, wait, must } from './harness.js';
import { chooseSelect } from './select.js';

export async function runDashboardWidgets(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  const { radar: drop } = await request<{ radar: RadarDto }>('/api/radars/drop-box');
  const { radar: target } = await request<{ radar: RadarDto }>('/api/radars', 'POST', {
    name: 'Dashboard filing target',
    template: 'kanban',
  });
  const createBlip = async (radarId: string, body: string) =>
    (
      await request<{ blip: BlipDto }>(`/api/radars/${radarId}/blips`, 'POST', {
        body,
        tags: ['widgetqa'],
      })
    ).blip;
  const task = await createBlip(drop.id, '# Dashboard completion task\n#widgetqa');
  const filing = await createBlip(drop.id, '# Dashboard filing task\n#widgetqa');
  await createBlip(target.id, '# Dashboard chart task\n#widgetqa');
  const { dashboard: created } = await request<{ dashboard: DashboardDto }>(
    '/api/dashboards',
    'POST',
    { name: 'Widget QA' },
  );
  const query = 'tag:widgetqa';
  const counts = Array.from({ length: 6 }, (_, i) => ({
    radarId: null,
    w: 2,
    h: 2,
    config: { type: 'query', title: `Count ${i + 1}`, query, display: 'count', limit: 12 },
  }));
  const { dashboard } = await request<{ dashboard: DashboardDto }>(
    `/api/dashboards/${created.id}`,
    'PATCH',
    {
      append: [
        ...counts,
        {
          radarId: null,
          w: 6,
          h: 8,
          config: {
            type: 'query',
            title: 'Grouped tasks',
            query,
            display: 'list',
            groupByRadar: true,
            limit: 12,
          },
        },
        {
          radarId: null,
          w: 6,
          h: 8,
          config: { type: 'query', title: 'Lane counts', query, display: 'lanes', limit: 12 },
        },
        {
          radarId: null,
          w: 6,
          h: 6,
          config: {
            type: 'query',
            title: 'Capture trend',
            query,
            display: 'activity',
            activityDays: 7,
            limit: 12,
          },
        },
        {
          radarId: null,
          w: 3,
          h: 2,
          config: {
            type: 'query',
            title: 'Hidden zero',
            query: 'tag:widgetqaabsent',
            display: 'count',
            hideWhenEmpty: true,
            limit: 12,
          },
        },
        { radarId: drop.id, w: 6, h: 8, config: {} },
        { radarId: target.id, w: 6, h: 8, config: {} },
      ],
    },
  );
  const id = (title: string) =>
    must(
      dashboard.widgets.find(
        (widget) => widget.config.type === 'query' && widget.config.title === title,
      ),
    ).id;
  const box = (title: string) => `[data-widget-id="${id(title)}"]`;
  const [cookieName, cookieValue] = seeded.ownerCookie.split('=');
  await page.browser().setCookie({
    name: must(cookieName),
    value: must(cookieValue),
    domain: new URL(seeded.baseUrl).hostname,
    path: '/',
    httpOnly: true,
  });
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(seeded.baseUrl, { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent.includes('Widget QA'),
    );
    tab?.click();
  });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent.includes('3matching blips'),
    {},
    box('Count 1'),
  );
  const sizes = await page.evaluate(
    (ids) =>
      ids.map((widgetId) => {
        const tile = document.querySelector(`[data-widget-id="${widgetId}"]`);
        if (!tile) throw new Error(`No widget ${widgetId} on the page`);
        const rect = tile.getBoundingClientRect();
        return { height: rect.height, top: rect.top };
      }),
    dashboard.widgets.slice(0, 6).map((widget) => widget.id),
  );
  check(
    'six count tiles fit one row with compact heights',
    sizes.every((size) => size.height < 120 && size.top === sizes[0]?.top),
    sizes,
  );
  await page.waitForSelector(`${box('Grouped tasks')} .widget-group-heading`);
  const grouped = await page.$eval(box('Grouped tasks'), (element) =>
    Array.from(element.querySelectorAll('.widget-group-heading')).map(
      (heading) => heading.textContent,
    ),
  );
  check(
    'query lists group matching radars with exact subtotals',
    grouped.some((text) => text.includes(drop.name) && text.includes('2')) &&
      grouped.some((text) => text.includes('Dashboard filing target') && text.includes('1')),
    grouped,
  );
  check(
    'lane chart renders declared lanes and readable counts',
    await page.$$eval(`${box('Lane counts')} .widget-lane-row`, (rows) => rows.length >= 4),
  );
  check(
    'capture chart exposes seven UTC daily values',
    await page.$$eval(`${box('Capture trend')} tbody tr`, (rows) => rows.length === 7),
  );
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      return element !== null && getComputedStyle(element).display === 'none';
    },
    {},
    box('Hidden zero'),
  );
  check(
    'confirmed empty widgets hide without being removed',
    (await page.$(box('Hidden zero'))) !== null,
  );
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Show hidden widgets'))
      ?.click(),
  );
  check(
    'hidden widgets can be revealed and edited',
    await page.$eval(box('Hidden zero'), (element) => getComputedStyle(element).display !== 'none'),
  );
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.trim() === 'Hide empty widgets')
      ?.click(),
  );
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      return element !== null && getComputedStyle(element).display === 'none';
    },
    {},
    box('Hidden zero'),
  );
  // Wait for the actual layout transition, including one frame for React's commit.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(
      Array.from(document.querySelectorAll('[data-widget-id]'))
        .flatMap((element) => element.getAnimations())
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const compact = await page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Nothing matches ${selector}`);
        return element.getBoundingClientRect().top;
      }),
    [
      box('Capture trend'),
      `[data-widget-id="${must(dashboard.widgets.find((widget) => widget.radarId === drop.id)).id}"]`,
    ],
  );
  check(
    'auto-hidden widgets leave no gap before neighboring panels',
    Math.abs(must(compact[0]) - must(compact[1])) < 1,
    compact,
  );
  await page.$eval(box('Count 1'), (element) => element.scrollIntoView({ block: 'start' }));
  await shot(page, outDir, 'dashboard-widgets-desktop');

  await page.click(
    `${box('Grouped tasks')} button[aria-label="Move to Done: Dashboard completion task"]`,
  );
  await wait(400);
  const completed = await request<{ items: BlipDto[] }>(`/api/radars/${drop.id}/blips`);
  check(
    'dashboard Done persists triage state without opening radar',
    completed.items.find((blip) => blip.id === task.id)?.state === 'done',
  );

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getBoundingClientRect().height === 130,
    {},
    box('Count 1'),
  );
  await page.click(
    `${box('Grouped tasks')} button[aria-label="File Dashboard filing task to radar"]`,
  );
  await page.waitForSelector('[role="dialog"][aria-label="File to radar"]');
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent === 'Dashboard filing target')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await page.waitForSelector('[role="dialog"][aria-label="File to radar"]', { hidden: true });
  const filed = await request<{ items: BlipDto[] }>(`/api/radars/${target.id}/blips`);
  check(
    'phone File action moves Drop box blip to selected radar',
    filed.items.some((blip) => blip.id === filing.id),
  );
  check(
    'file success offers undo',
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent === 'Undo',
      ),
    ),
  );
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent === 'Undo')
      ?.click(),
  );
  await wait(400);
  const undone = await request<{ items: BlipDto[] }>(`/api/radars/${drop.id}/blips`);
  check(
    'undo restores filed blip to Drop box',
    undone.items.some((blip) => blip.id === filing.id),
  );
  await page.$eval(box('Count 1'), (element) => element.scrollIntoView({ block: 'start' }));
  await shot(page, outDir, 'dashboard-widgets-phone');
  const phoneSize = await page.$eval(
    box('Count 1'),
    (element) => element.getBoundingClientRect().height,
  );
  check('phone count widgets keep compact height', phoneSize <= 140, phoneSize);
  check(
    'dashboard has no horizontal overflow on phone',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  );

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      return element !== null && getComputedStyle(element).position === 'absolute';
    },
    {},
    box('Count 1'),
  );
  const dropWidgetId = must(dashboard.widgets.find((widget) => widget.radarId === drop.id)).id;
  const sourceSelector = `[data-widget-id="${dropWidgetId}"] [data-dashboard-blip="${filing.id}"] .dashboard-file-grip`;
  await page.waitForSelector(sourceSelector, { visible: true });
  await page.$eval(sourceSelector, (element) => element.scrollIntoView({ block: 'center' }));
  const start = await page.$eval(sourceSelector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const end = await page.$eval(`[data-file-target="${target.id}"]`, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + 80 };
  });
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the board drag is HTML5 drag-and-drop, which headless Chrome dispatches only with drag interception on; puppeteer names no replacement
  await page.setDragInterception(true);
  await page.mouse.dragAndDrop(start, end, { delay: 150 });
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the board drag is HTML5 drag-and-drop, which headless Chrome dispatches only with drag interception on; puppeteer names no replacement
  await page.setDragInterception(false);
  await wait(500);
  const dragged = await request<{ items: BlipDto[] }>(`/api/radars/${target.id}/blips`);
  check(
    'dragging a Drop box blip to a radar panel files it',
    dragged.items.some((blip) => blip.id === filing.id),
  );
  await shot(page, outDir, 'dashboard-filing-desktop');

  await page.click(`${box('Count 1')} button[aria-label="Edit Count 1"]`);
  await page.waitForSelector('[role="dialog"][aria-label="Edit widget"]');
  await chooseSelect(page, '[role="dialog"]', 'activity');
  await page.waitForSelector('[role="dialog"] .widget-activity');
  check('display picker previews charts before saving', true);
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')).some(
      (button) => button.textContent.trim() === 'Save widget' && !button.disabled,
    ),
  );
  await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button'))
      .find((button) => button.textContent.trim() === 'Save widget')
      ?.click(),
  );
  await page.waitForSelector('[role=dialog]', { hidden: true });
  const updated = await request<{ dashboards: DashboardDto[] }>('/api/dashboards');
  const changed = updated.dashboards
    .find((item) => item.id === dashboard.id)
    ?.widgets.find((widget) => widget.id === id('Count 1'));
  check(
    'changing a compact count to a chart saves and makes room safely',
    changed?.config.type === 'query' &&
      changed.config.display === 'activity' &&
      changed.h >= 4 &&
      changed.w >= 3,
  );
  return { checks, failures, notes: [] };
}

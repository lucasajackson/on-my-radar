/** Header search against real data, including late network responses and radar-prioritized navigation. */
import type { HTTPRequest, Page } from 'puppeteer-core';
import { PHONE, shot, must } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';
const INPUT = '#global-search';
const RESULTS = '[role="listbox"][aria-label="Search results"]';
const OPTIONS = `${RESULTS} [role="option"][data-search-result]`;

export async function runHeaderSearch(
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
  const other = must(seeded.radars.find((radar) => radar.id !== seeded.search.radarId));
  const extraResponse = await fetch(`${seeded.baseUrl}/api/radars/${other.id}/blips`, {
    method: 'POST',
    headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ body: `Cross-radar ${seeded.search.needle} match` }),
  });
  if (!extraResponse.ok) throw new Error(`Search fixture failed: ${extraResponse.status}`);
  const { blip: extra } = (await extraResponse.json()) as { blip: { id: string } };
  const waitForMatches = async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 3,
      {},
      OPTIONS,
    );
  };
  const waitForEmptyResults = async (value: string) => {
    await page.waitForFunction(
      (query) =>
        document.querySelector<HTMLInputElement>('#global-search')?.value === query &&
        document.querySelector('.universal-search-message[role="status"]')?.textContent.trim() ===
          'No matching blips. Try another search.',
      {},
      value,
    );
  };
  const typeQuery = async (value: string) => {
    await page.focus(INPUT);
    await page.$eval(INPUT, (element) => (element as HTMLInputElement).select());
    await page.keyboard.press('Backspace');
    await page.type(INPUT, value);
  };
  for (const width of [390, 1366]) {
    const label = `[header search ${width}]`,
      needle = seeded.search.needle;
    await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await page.goto(`${seeded.baseUrl}/radar/${seeded.search.radarId}`, {
      waitUntil: 'networkidle2',
    });
    check(
      `${label} replaces the composer filter`,
      (await page.$('input[aria-label="Search blips"]')) === null,
    );
    check(`${label} has no scope selector`, (await page.$('[aria-label="Search scope"]')) === null);
    await typeQuery(needle);
    await waitForMatches();
    const baseline = await page.$$eval(OPTIONS, (elements) =>
      elements.map((element) => element.getAttribute('data-search-result')),
    );
    check(
      `${label} matching blips appear while typing`,
      baseline.length === seeded.search.matches + 1,
    );
    const grouped = await page.$$eval(`${RESULTS} [data-search-group]`, (groups) =>
      groups.map((group) => ({
        group: group.getAttribute('data-search-group'),
        ids: [...group.querySelectorAll('[data-search-result]')].map((item) =>
          item.getAttribute('data-search-result'),
        ),
      })),
    );
    check(
      `${label} current radar matches precede other accessible matches`,
      grouped[0]?.group === 'current' &&
        grouped[0].ids.length === 2 &&
        !grouped[0].ids.includes(extra.id) &&
        grouped[1]?.group === 'other' &&
        grouped[1].ids.includes(extra.id),
      grouped,
    );
    const placement = await page.$eval(RESULTS, (element) => {
      const search = document.querySelector('#global-search');
      if (!search) throw new Error('No #global-search on the page');
      const r = element.getBoundingClientRect(),
        input = search.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        inputBottom: input.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    check(
      `${label} dropdown stays below header and within viewport`,
      placement.left >= -1 &&
        placement.right <= placement.width + 1 &&
        placement.top >= placement.inputBottom - 1 &&
        placement.bottom <= placement.height + 1,
      placement,
    );
    await shot(page, outDir, `header-search-${width}`);
    // Tab through the clear control to the dropdown action, not a direct DOM focus.
    for (let index = 0; index < 4; index++) {
      if (
        await page.evaluate(() =>
          document.activeElement?.classList.contains('universal-search-all'),
        )
      )
        break;
      await page.keyboard.press('Tab');
    }
    check(
      `${label} View all results is keyboard reachable`,
      await page.evaluate(
        () => document.activeElement?.classList.contains('universal-search-all') === true,
      ),
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector(RESULTS, { hidden: true });
    check(
      `${label} Escape from dropdown action restores input focus`,
      await page.evaluate(() => document.activeElement?.id === 'global-search'),
    );
    check(
      `${label} Escape preserves query and route`,
      (await page.$eval(
        INPUT,
        (element, value) => (element as HTMLInputElement).value === value,
        needle,
      )) && new URL(page.url()).pathname === `/radar/${seeded.search.radarId}`,
    );
    await page.focus(INPUT);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.pathname === '/search');
    const full = new URL(page.url());
    check(
      `${label} Enter opens full results with same query and priority`,
      full.searchParams.get('q') === needle &&
        full.searchParams.get('preferRadarId') === seeded.search.radarId,
      full.search,
    );
    await page.goBack({ waitUntil: 'networkidle2' });
    check(
      `${label} Back returns to source radar`,
      new URL(page.url()).pathname === `/radar/${seeded.search.radarId}`,
    );
    await typeQuery(needle);
    await page.waitForSelector(OPTIONS, { visible: true });
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() =>
      Boolean(document.querySelector('#global-search')?.getAttribute('aria-activedescendant')),
    );
    const selected = await page.$eval(INPUT, (element) =>
      document
        .getElementById(element.getAttribute('aria-activedescendant') ?? '')
        ?.getAttribute('data-search-result'),
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get('blip') === id,
      {},
      selected,
    );
    await page.waitForSelector(`[data-blip-id="${must(selected, 'a selected result')}"]`, {
      visible: true,
    });
    check(`${label} keyboard result opens its actual blip`, baseline.includes(selected ?? null));
    await page.reload({ waitUntil: 'networkidle2' });
    check(
      `${label} selected blip deep link survives reload`,
      Boolean(await page.$(`[data-blip-id="${must(selected, 'a selected result')}"]`)),
    );
    await page.goto(`${seeded.baseUrl}/radars`, { waitUntil: 'networkidle2' });
    await typeQuery(needle);
    await page.waitForSelector(OPTIONS, { visible: true });
    const clicked = await page.$eval(OPTIONS, (element) =>
      element.getAttribute('data-search-result'),
    );
    await page.click(OPTIONS);
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get('blip') === id,
      {},
      clicked,
    );
    await page.waitForSelector(`[data-blip-id="${must(clicked, 'a clicked result')}"]`, {
      visible: true,
    });
    check(`${label} pointer selection opens its matching blip`, baseline.includes(clicked));
    await page.goto(`${seeded.baseUrl}/radar/${other.id}`, { waitUntil: 'networkidle2' });
    await typeQuery(needle);
    await waitForMatches();
    const prioritized = await page.$$eval(OPTIONS, (items) =>
      items.map((item) => item.getAttribute('data-search-result')),
    );
    check(
      `${label} changing radar changes priority without hiding global matches`,
      prioritized[0] === extra.id && prioritized.length === 3,
      prioritized,
    );
    await page.keyboard.press('Escape');
    await page.focus(INPUT);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.pathname === '/search');
    await page.waitForSelector('.app-content [data-search-result]');
    const fullIds = await page.$$eval('.app-content [data-search-result]', (items) =>
      items.map((item) => item.getAttribute('data-search-result')),
    );
    check(
      `${label} full results preserve current-first global ordering`,
      new URL(page.url()).searchParams.get('preferRadarId') === other.id &&
        fullIds[0] === extra.id &&
        fullIds.length === 3,
      fullIds,
    );
  }
  // Delay one genuinely matching response, then finish a newer empty search first.
  await page.goto(`${seeded.baseUrl}/radars`, { waitUntil: 'networkidle2' });
  const held: HTTPRequest[] = [];
  const settled = new Set<HTTPRequest>();
  const markSettled = (request: HTTPRequest) => settled.add(request);
  page.on('requestfinished', markSettled);
  page.on('requestfailed', markSettled);
  const delayOld = (request: HTTPRequest) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/search' && url.searchParams.get('q') === seeded.search.needle)
      held.push(request);
    else void request.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', delayOld);
  try {
    await typeQuery(seeded.search.needle);
    const until = Date.now() + 10000;
    while (!held.length && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (!held.length) throw new Error('Matching search request was not intercepted');
    const latest = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/search' &&
        new URL(response.url()).searchParams.get('q') === 'no-header-search-match',
    );
    await typeQuery('no-header-search-match');
    await latest;
    for (const request of held)
      if (!request.isInterceptResolutionHandled()) await request.continue().catch(() => undefined);
    // Search cancellation can finish via requestfailed; unrelated app polling is
    // irrelevant. Observe only the deliberately delayed requests settling.
    const settleDeadline = Date.now() + 10000;
    while (held.some((request) => !settled.has(request)) && Date.now() < settleDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (held.some((request) => !settled.has(request)))
      throw new Error('Delayed search requests did not finish or cancel');
    await waitForEmptyResults('no-header-search-match');
    check(
      '[header search] late response cannot replace newer empty results',
      (await page.$$(OPTIONS)).length === 0 &&
        (await page.$eval(
          INPUT,
          (element) => (element as HTMLInputElement).value === 'no-header-search-match',
        )),
    );
  } finally {
    page.off('request', delayOld);
    page.off('requestfinished', markSettled);
    page.off('requestfailed', markSettled);
    for (const request of held)
      if (!request.isInterceptResolutionHandled()) await request.continue().catch(() => undefined);
    await page.setRequestInterception(false);
  }
  // Dedicated theme fixtures keep the shared seeded radars and later suites unchanged.
  const themeRadars: { name: string; id: string }[] = [];
  for (const [name, theme] of [
    ['paper', { preset: 'paper' }],
    ['terminal', { preset: 'terminal' }],
    ['custom', { preset: 'paper', chromeFont: 'serif', corners: 'sharp' }],
  ] as const) {
    const response = await fetch(`${seeded.baseUrl}/api/radars`, {
      method: 'POST',
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Search theme ${name}`, template: 'microblog', theme }),
    });
    if (!response.ok) throw new Error(`Theme fixture failed: ${response.status}`);
    const { radar } = (await response.json()) as { radar: { id: string } };
    themeRadars.push({ name, id: radar.id });
  }
  const originalTheme = await page.evaluate(() => localStorage.getItem('omr.theme'));
  try {
    for (const width of [390, 1366]) {
      await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
      const appearances = new Map<string, { background: string; font: string }>();
      for (const fixture of [
        { name: 'light', id: seeded.search.radarId },
        { name: 'dark', id: seeded.search.radarId },
        ...themeRadars,
      ]) {
        await page.evaluate(
          (mode) => localStorage.setItem('omr.theme', mode),
          fixture.name === 'light' ? 'light' : 'dark',
        );
        await page.goto(`${seeded.baseUrl}/radar/${fixture.id}`, { waitUntil: 'networkidle2' });
        await typeQuery(seeded.search.needle);
        await waitForMatches();
        const appearance = await page.evaluate(() => {
          const header = document.querySelector<HTMLElement>('.app-search-header');
          const input = document.querySelector<HTMLElement>('#global-search');
          const menu = document.querySelector<HTMLElement>('.universal-search-dropdown');
          if (!header || !input || !menu) throw new Error('Search header, input or menu missing');
          const h = getComputedStyle(header),
            i = getComputedStyle(input),
            m = getComputedStyle(menu);
          const bounds = menu.getBoundingClientRect();
          return {
            background: h.backgroundColor,
            font: i.fontFamily,
            menuFont: m.fontFamily,
            menuRadius: m.borderTopLeftRadius,
            color: i.color,
            menuColor: m.color,
            contained:
              bounds.left >= -1 &&
              bounds.right <= innerWidth + 1 &&
              bounds.bottom <= innerHeight + 1,
          };
        });
        appearances.set(fixture.name, appearance);
        check(
          `[header search ${width} ${fixture.name}] menu fits the viewport`,
          appearance.contained,
          appearance,
        );
        if (fixture.name === 'terminal' || fixture.name === 'custom')
          check(
            `[header search ${width} ${fixture.name}] theme preserves sharp corners and chrome font`,
            appearance.menuRadius === '0px' && appearance.font === appearance.menuFont,
            appearance,
          );
        await shot(page, outDir, `header-search-${width}-${fixture.name}`);
      }
      check(
        `[header search ${width}] default follows light and dark appearance`,
        appearances.get('light')?.background !== appearances.get('dark')?.background,
      );
      check(
        `[header search ${width}] radar themes change search surface and font`,
        appearances.get('paper')?.background !== appearances.get('terminal')?.background &&
          appearances.get('custom')?.font !== appearances.get('terminal')?.font,
      );
      // A settings route for the same radar is outside the content-only theme boundary.
      await page.goto(`${seeded.baseUrl}/radar/${must(themeRadars[2]).id}/settings`, {
        waitUntil: 'networkidle2',
      });
      check(
        `[header search ${width}] settings do not inherit the radar search theme`,
        await page.$eval('.app-search-header', (header) => !header.getAttribute('style')),
      );
    }
  } finally {
    await page.evaluate(
      (value) =>
        value === null
          ? localStorage.removeItem('omr.theme')
          : localStorage.setItem('omr.theme', value),
      originalTheme,
    );
  }
  return { checks, failures, notes: [] };
}

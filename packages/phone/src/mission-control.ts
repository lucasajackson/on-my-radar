/** Fresh human signup and editable starter dashboard against the served scratch app. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import type { BlipDto, DashboardDto, DashboardQueryResultDto, RadarDto } from '@onmyradar/contract';
import { must, PHONE } from './harness.js';
import { OWNER_EMAIL, type Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runMissionControl(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [],
    evidence: unknown[] = [];
  const check = (name: string, ok: boolean) => {
    checks.push({ name, ok, detail: null });
    if (!ok) failures.push(name);
  };
  const request = async <T>(
    cookie: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Mission Control ${method} ${path}: HTTP${response.status}`);
    return (await response.json()) as T;
  };
  const login = async (email: string): Promise<string> => {
    const challenge = await fetch(seeded.baseUrl + '/api/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!challenge.ok) throw new Error(`Mission Control login challenge: HTTP${challenge.status}`);
    const body = (await challenge.json()) as { devCode?: string };
    const cookie = challenge.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const verified = await fetch(seeded.baseUrl + '/api/auth/verify-code', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        code: must(body.devCode, 'documented scratch development code'),
      }),
    });
    if (!verified.ok) throw new Error(`Mission Control login verification: HTTP${verified.status}`);
    return must(
      verified.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .find((value) => value?.startsWith('omr_session=')),
      'normal scratch human session',
    );
  };
  const dashboards = async (cookie: string) =>
    (await request<{ dashboards: DashboardDto[] }>(cookie, '/api/dashboards')).dashboards;
  const existing = await dashboards(seeded.ownerCookie);
  const existingCookie = await login(OWNER_EMAIL);
  check(
    'Mission Control leaves existing owner dashboards unchanged on login',
    JSON.stringify(await dashboards(existingCookie)) === JSON.stringify(existing),
  );

  for (const width of [390, 1280]) {
    const tag = `[Mission Control ${width}]`;
    const email = `mission-${randomUUID()}@example.test`;
    const cookie = await login(email);
    const session = await request<{ user: { state: string; isAdmin: boolean } }>(
      cookie,
      '/api/auth/session',
    );
    check(
      `${tag} normal fresh account is active without admin bootstrap`,
      session.user.state === 'active' && !session.user.isAdmin,
    );
    const all = await dashboards(cookie);
    const dashboard = must(all[0], 'fresh first dashboard');
    check(
      `${tag} exactly one Mission Control has three starter widgets`,
      all.length === 1 && dashboard.name === 'Mission Control' && dashboard.widgets.length === 3,
    );
    const inbox = must(
      dashboard.widgets.find(
        (widget) => widget.config.type === 'query' && widget.config.title === 'Inbox',
      ),
    );
    const active = must(
      dashboard.widgets.find(
        (widget) => widget.config.type === 'query' && widget.config.title === 'Active work',
      ),
    );
    const radarWidget = must(dashboard.widgets.find((widget) => widget.radarId !== null));
    const radarId = must(radarWidget.radarId);
    const { radar } = await request<{ radar: RadarDto }>(cookie, `/api/radars/${radarId}`);
    const { radar: privateInbox } = await request<{ radar: RadarDto }>(
      cookie,
      '/api/radars/drop-box',
    );
    check(
      `${tag} private inbox is separate from the welcome radar`,
      privateInbox.id !== radarId &&
        privateInbox.isDropBox &&
        privateInbox.publicSlug === null &&
        radar.name === 'First Radar',
    );
    const welcome = must(
      (await request<{ items: BlipDto[] }>(cookie, `/api/radars/${radarId}/blips`)).items[0],
    );
    check(
      `${tag} ordinary welcome content explains editable live starters`,
      welcome.body.includes('Mission Control') &&
        welcome.body.includes('Inbox') &&
        welcome.body.includes('Active work') &&
        welcome.body.includes('changed or removed'),
    );
    const totals = async (widgetId: string) =>
      (
        await request<DashboardQueryResultDto>(
          cookie,
          `/api/dashboards/${dashboard.id}/widgets/${widgetId}/results`,
        )
      ).total;
    check(
      `${tag} actual queries start with one inbox and no active work`,
      (await totals(inbox.id)) === 1 && (await totals(active.id)) === 0,
    );
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    human.setDefaultTimeout(20_000);
    await human.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await context.setCookie({
      name: 'omr_session',
      value: cookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    const inboxBox = `[data-widget-id="${inbox.id}"]`;
    const activeBox = `[data-widget-id="${active.id}"]`;
    try {
      await human.goto(seeded.baseUrl, { waitUntil: 'networkidle2' });
      await human.waitForSelector(
        `${inboxBox} .widget-count[aria-label="1 matching blips. Open results"]`,
      );
      await human.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent.includes('0 matching blips'),
        {},
        activeBox,
      );
      check(
        `${tag} native first screen shows all starter widgets`,
        await human.$$eval('[data-widget-id]', (nodes) => nodes.length === 3),
      );
      check(
        `${tag} first screen fits viewport`,
        await human.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      );
      await human.screenshot({
        path: `${outDir}/mission-control-first-${width}.png`,
        fullPage: true,
      });
      const edit = must(await human.$('button[aria-label="Edit Inbox"]'));
      await edit.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await edit.click();
      const title = must(
        await human.waitForSelector('[role="dialog"] input[placeholder="Reading to catch up on"]'),
      );
      // Select by API, not Ctrl+A: the chord does not select on macOS Chrome, so
      // the old text survived ("InboMy Inbox"). Typing over a selection replaces it,
      // and the value wait proves every keystroke landed before Save.
      await title.click();
      await title.evaluate((input) => input.select());
      await title.type('My Inbox');
      await human.waitForFunction((input) => input.value === 'My Inbox', {}, title);
      await human.waitForFunction(() =>
        Array.from(document.querySelectorAll('button')).some(
          (node) => node.textContent.trim() === 'Save widget' && !node.disabled,
        ),
      );
      const saved = human.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/dashboards/${dashboard.id}` &&
          response.request().method() === 'PATCH',
      );
      for (const button of await human.$$('[role="dialog"] button')) {
        if (await button.evaluate((node) => node.textContent.trim() === 'Save widget')) {
          await button.click();
          break;
        }
      }
      check(`${tag} native starter edit succeeds`, (await saved).status() === 200);
      await human.waitForSelector('button[aria-label="Edit My Inbox"]');
      await human.reload({ waitUntil: 'networkidle2' });
      const edited = must((await dashboards(cookie))[0]);
      const editedInbox = must(edited.widgets.find((widget) => widget.id === inbox.id));
      check(
        `${tag} saved customization survives reload`,
        editedInbox.config.type === 'query' &&
          editedInbox.config.title === 'My Inbox' &&
          editedInbox.config.query === 'is:inbox',
      );
      await request(cookie, `/api/blips/${welcome.id}`, 'PATCH', { state: 'active' });
      await human.reload({ waitUntil: 'networkidle2' });
      await human.waitForSelector(
        `${inboxBox} .widget-count[aria-label="0 matching blips. Open results"]`,
      );
      await human.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent.includes('1 matching blips'),
        {},
        activeBox,
      );
      check(
        `${tag} live starters follow ordinary blip state change`,
        (await totals(inbox.id)) === 0 && (await totals(active.id)) === 1,
      );
      await human.screenshot({
        path: `${outDir}/mission-control-edited-${width}.png`,
        fullPage: true,
      });
      const retained = await dashboards(cookie);
      const repeatCookie = await login(email);
      check(
        `${tag} repeat login preserves customization without duplicate starters`,
        JSON.stringify(await dashboards(repeatCookie)) === JSON.stringify(retained),
      );
      evidence.push({
        width,
        firstName: dashboard.name,
        widgetCount: dashboard.widgets.length,
        editedTitle: editedInbox.config.type === 'query' ? editedInbox.config.title : null,
        inboxTotal: await totals(inbox.id),
        activeTotal: await totals(active.id),
      });
    } finally {
      await context.close();
    }
  }
  check(
    'Mission Control fresh-account journeys preserve existing owner dashboards',
    JSON.stringify(await dashboards(seeded.ownerCookie)) === JSON.stringify(existing),
  );
  writeFileSync(join(outDir, 'mission-control-provenance.json'), JSON.stringify(evidence, null, 2));
  return {
    checks,
    failures,
    notes: [
      'Mission Control acceptance uses ordinary scratch development request-code/verify-code login, native isolated browser interactions and normal human APIs. No production mail or live deployment claim.',
    ],
  };
}

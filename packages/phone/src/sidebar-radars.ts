/** Real served overflow-of-twenty navigation, seeded through ordinary human APIs. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { must, PHONE, PATIENCE_MS } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runSidebarRadars(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [],
    evidence: unknown[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const email = `sidebar-${randomUUID()}@example.test`;
  const challenge = await fetch(seeded.baseUrl + '/api/auth/request-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!challenge.ok) throw new Error(`Sidebar challenge HTTP${challenge.status}`);
  const code = must(((await challenge.json()) as { devCode?: string }).devCode);
  const challengeCookie = challenge.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const login = await fetch(seeded.baseUrl + '/api/auth/verify-code', {
    method: 'POST',
    headers: { cookie: challengeCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!login.ok) throw new Error(`Sidebar login HTTP${login.status}`);
  const cookie = must(
    login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .find((value) => value?.startsWith('omr_session=')),
  );
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Sidebar ${method} ${path}: HTTP${response.status}`);
    return (await response.json()) as T;
  };
  const topics: string[] = [];
  for (const name of ['Sidebar Alpha', 'Sidebar Beta']) {
    const result = await request<{ topic: { id: string } }>('/api/topics', 'POST', {
      name,
      accent: 'moss',
    });
    topics.push(result.topic.id);
  }
  const radars: { id: string; name: string; group: number }[] = [];
  for (let index = 0; index < 26; index++) {
    const name = `Sidebar Radar ${String(index + 1).padStart(2, '0')}`;
    const result = await request<{ radar: { id: string } }>('/api/radars', 'POST', {
      name,
      accent: 'moss',
      glyph: 'radar',
      template: 'stream',
    });
    const group = index < 14 ? 0 : index < 22 ? 1 : -1;
    if (group >= 0)
      await request(`/api/radars/${result.radar.id}/topic`, 'PUT', {
        topicId: must(topics[group]),
      });
    radars.push({ id: result.radar.id, name, group });
  }
  const late = must(radars.at(-1));
  for (const width of [1280, 390]) {
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    human.setDefaultTimeout(PATIENCE_MS);
    await human.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await context.setCookie({
      name: 'omr_session',
      value: cookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    const tag = `[sidebar ${width}]`;
    const scope = width === 390 ? 'main' : '.app-sidebar';
    const filter = `${scope} input[aria-label="${width === 390 ? 'Filter radars' : 'Filter sidebar radars'}"]`;
    try {
      await human.goto(seeded.baseUrl + '/', { waitUntil: 'networkidle2' });
      if (width === 390) {
        await human.click('.app-tabbar a[href="/radars"]');
      } else {
        const expand = await human.$('.app-sidebar button[aria-label="Expand the sidebar"]');
        if (expand) {
          await expand.click();
          await expand.dispose();
        }
      }
      await human.waitForSelector(filter, { visible: true });
      await human.waitForFunction(
        (root, ids) => ids.every((id) => document.querySelector(`${root} a[href="/radar/${id}"]`)),
        {},
        scope,
        radars.map((radar) => radar.id),
      );
      const initial = await human.evaluate(
        (root, ids) => ({
          matched: ids.filter((id) => document.querySelector(`${root} a[href="/radar/${id}"]`))
            .length,
          sidebarVisible: Boolean(document.querySelector('.app-sidebar')?.getClientRects().length),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        }),
        scope,
        radars.map((radar) => radar.id),
      );
      check(`${tag} all twenty-six owned radars remain available`, initial.matched === 26, initial);
      check(
        `${tag} navigation matches the intended viewport`,
        initial.sidebarVisible === (width !== 390),
        initial,
      );
      check(
        `${tag} directory has no horizontal viewport overflow`,
        !initial.horizontalOverflow,
        initial,
      );
      await human.screenshot({
        path: `${outDir}/sidebar-radars-${width}.png`,
        fullPage: false,
      });
      await human.click(filter);
      await human.type(filter, 'Sidebar Beta');
      const beta = radars.filter((radar) => radar.group === 1);
      await human.waitForFunction(
        (root, wanted, other) =>
          wanted.every((id) => document.querySelector(`${root} a[href="/radar/${id}"]`)) &&
          other.every((id) => !document.querySelector(`${root} a[href="/radar/${id}"]`)),
        {},
        scope,
        beta.map((radar) => radar.id),
        radars.filter((radar) => radar.group !== 1).map((radar) => radar.id),
      );
      check(`${tag} topic filter preserves all eight matching radars`, true);
      await human.click(filter);
      await human.keyboard.down('Control');
      await human.keyboard.press('A');
      await human.keyboard.up('Control');
      await human.keyboard.press('Backspace');
      await human.type(filter, late.name);
      await human.waitForFunction(
        (root, id, other) =>
          Boolean(document.querySelector(`${root} a[href="/radar/${id}"]`)) &&
          other.every((otherId) => !document.querySelector(`${root} a[href="/radar/${otherId}"]`)),
        {},
        scope,
        late.id,
        radars.filter((radar) => radar.id !== late.id).map((radar) => radar.id),
      );
      check(`${tag} name filter finds the radar beyond twenty`, true);
      await human.screenshot({
        path: `${outDir}/sidebar-radars-filtered-${width}.png`,
        fullPage: false,
      });
      await human.click(`${scope} a[href="/radar/${late.id}"]`);
      await human.waitForFunction((id) => location.pathname === `/radar/${id}`, {}, late.id);
      await human.waitForFunction(
        (name) =>
          [...document.querySelectorAll('main h1, main h2')].some(
            (heading) => heading.textContent.trim() === name,
          ),
        {},
        late.name,
      );
      check(`${tag} native late-radar link opens the correct radar`, true);
      evidence.push({
        width,
        initial,
        ownedRadarCount: 26,
        topicMatchCount: beta.length,
        navigatedBeyondTwenty: true,
      });
    } finally {
      await context.close();
    }
  }
  writeFileSync(
    join(outDir, 'sidebar-radars-provenance.json'),
    JSON.stringify(
      {
        sourceSha: process.env['CI_COMMIT_SHA'] ?? null,
        pipelineId: process.env['CI_PIPELINE_ID'] ?? null,
        jobId: process.env['CI_JOB_ID'] ?? null,
        setup:
          'normal scratch human devCode login; twenty-six API-created radars, two topics; no database patch',
        evidence,
      },
      null,
      2,
    ),
  );
  return { checks, failures, notes: [] };
}

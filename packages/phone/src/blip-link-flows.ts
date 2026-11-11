/** C4: a card's link opens the radar with that card on top, at 390 and 1440, and Back and close behave. */
import type { Page } from 'puppeteer-core';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { IOS_UA, PATIENCE_MS, PHONE } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runBlipLinkFlows(owner: Page, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method: 'POST',
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (!response.ok) throw new Error(`Synthetic link fixture refused: ${path}`);
    return (await response.json()) as T;
  };
  const { radar } = await call<{ radar: RadarDto }>('/api/radars', {
    name: 'Link board',
    template: 'kanban',
  });
  const { blip, url } = await call<{ blip: BlipDto; url: string }>(
    `/api/radars/${radar.id}/blips`,
    { title: 'Linked card', body: 'Synthetic link fixture.', status: 'backlog' },
  );
  // Its own browser context, so the widths and user agent below leak into no later flow.
  const context = await owner.browser().createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(PATIENCE_MS);
  await context.setCookie({
    name: 'omr_session',
    value: seeded.ownerCookie.slice('omr_session='.length),
    domain: new URL(seeded.baseUrl).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
  const radarPath = `/radar/${radar.id}`;
  check(
    'create answers with the card address',
    url === `${seeded.baseUrl}${radarPath}/blip/${blip.id}`,
    url,
  );
  const dialog = '[role="dialog"]';
  const path = () => page.evaluate(() => location.pathname);
  const closed = () => page.waitForFunction((s) => !document.querySelector(s), {}, dialog);
  for (const width of [1440, 390]) {
    const tag = `${width}px`;
    await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
    if (width === 390) await page.setUserAgent({ userAgent: IOS_UA });
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.waitForSelector(`${dialog} .comment-thread`, { visible: true });
    check(
      `${tag} cold load opens the card inside the viewport`,
      await page.$eval(dialog, (node) => {
        const box = node.getBoundingClientRect();
        return (
          node.textContent.includes('Synthetic link fixture.') &&
          box.left >= 0 &&
          box.right <= innerWidth &&
          document.documentElement.scrollWidth <= innerWidth
        );
      }),
    );
    await page.keyboard.press('Escape');
    await closed();
    check(`${tag} close returns to the radar address`, (await path()) === radarPath, await path());
    await page.waitForSelector('.board-card .blip-body', { visible: true });
    await page.click('.board-card .blip-body');
    await page.waitForSelector(`${dialog} .comment-thread`, { visible: true });
    check(
      `${tag} opening a card pushes its address`,
      (await path()) === `${radarPath}/blip/${blip.id}`,
    );
    await page.goBack();
    await closed();
    check(`${tag} Back closes the card`, (await path()) === radarPath, await path());
    await page.goForward();
    await page.waitForSelector(`${dialog} .comment-thread`, { visible: true });
    check(`${tag} Forward reopens it`, (await path()) === `${radarPath}/blip/${blip.id}`);
  }
  await context.close();
  return { checks, failures, notes: [] };
}

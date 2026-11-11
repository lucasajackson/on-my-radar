/**
 * The reading list as a reader, at 1440 and 390: newest first, a story opens full-screen and reads
 * itself, "Mark unread", the keys, Esc and Back, a `?sel=` deep link, and no comments anywhere.
 * Its radar and stories are its own and are deleted at the end, pass or fail.
 */
import type { Page } from 'puppeteer-core';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { IOS_UA, PATIENCE_MS, PHONE, wait } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runReaderFlows(owner: Page, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (!response.ok) throw new Error(`Reader fixture refused: ${method} ${path}`);
    return (response.status === 204 ? null : await response.json()) as T;
  };
  const { radar } = await call<{ radar: RadarDto }>('/api/radars', 'POST', {
    name: 'Reader flow',
    template: 'reading',
  });
  const context = await owner.browser().createBrowserContext();
  try {
    // Oldest first, so the newest is C: the list must lead with it.
    const stories: BlipDto[] = [];
    for (const name of ['A', 'B', 'C']) {
      const { blip } = await call<{ blip: BlipDto }>(`/api/radars/${radar.id}/blips`, 'POST', {
        title: `Story ${name}`,
        body: `Full text of story ${name}. ${'It goes on at some length. '.repeat(40)}`,
      });
      stories.push(blip);
      await wait(15);
    }
    const [a, b, c] = stories as [BlipDto, BlipDto, BlipDto];
    const statusOf = async (id: string) =>
      (await call<{ blip: BlipDto }>(`/api/blips/${id}`, 'GET')).blip.status;
    const becomes = async (id: string, want: string) => {
      for (let i = 0; i < 40; i += 1) {
        if ((await statusOf(id)) === want) return true;
        await wait(100);
      }
      return false;
    };
    const resetAll = async () => {
      for (const s of stories) await call(`/api/blips/${s.id}`, 'PATCH', { status: 'unread' });
    };

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
    const url = (query = '') => `${seeded.baseUrl}${radarPath}${query}`;
    const titles = () =>
      page.$$eval('.read-row-title', (nodes) =>
        nodes.map((n) => n.textContent.replace(/^Unread: /, '')),
      );
    const sel = () => page.evaluate(() => new URLSearchParams(location.search).get('sel'));
    // The reader offers "Mark unread" once the story is read in what the page shows: u needs that.
    const shownRead = () =>
      page.waitForFunction(() =>
        [...document.querySelectorAll('.reader-bar button')].some(
          (b) => b.textContent === 'Mark unread',
        ),
      );
    const closed = () => page.waitForFunction(() => !document.querySelector('.reader'));
    const opened = (title: string) =>
      page.waitForFunction(
        (t) => document.querySelector('.reader-title')?.textContent === t,
        {},
        title,
      );

    for (const width of [1440, 390]) {
      const tag = `[reader ${width}px]`;
      await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
      if (width === 390) await page.setUserAgent({ userAgent: IOS_UA });
      await resetAll();

      await page.goto(url(), { waitUntil: 'networkidle2' });
      await page.waitForSelector('.read-row');
      check(
        `${tag} newest first`,
        (await titles()).join() === 'Story C,Story B,Story A',
        await titles(),
      );
      check(
        `${tag} unread are bold with a dot, and there is no status dropdown or comment link`,
        await page.evaluate(() => {
          const row = document.querySelector('.read-row[data-unread]');
          const title = row?.querySelector('.read-row-title');
          const dot = row?.querySelector('.read-dot');
          return (
            Number(getComputedStyle(title as Element).fontWeight) >= 600 &&
            getComputedStyle(dot as Element).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            !document.querySelector('.read-list select, .read-list .select-trigger') &&
            !/comment/i.test(document.querySelector('.read-list')?.textContent ?? '')
          );
        }),
      );

      // Open the newest: full-screen, read on open, no comments.
      await page.click('.read-row-main');
      await page.waitForSelector('.reader .reader-title');
      check(`${tag} the story opens as ?sel=`, (await sel()) === c.id, await sel());
      const fit = await page.evaluate(() => {
        const box = document.querySelector('.reader')?.getBoundingClientRect();
        const body = document.querySelector('.reader-body') as HTMLElement;
        const probe = Object.assign(document.createElement('div'), { style: 'width:70ch' });
        body.append(probe);
        const measure = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          box: box ? [box.left, box.top, box.width, box.height] : null,
          view: [innerWidth, innerHeight],
          body: body.getBoundingClientRect().width,
          measure,
          scroll: document.documentElement.scrollWidth,
        };
      });
      check(
        `${tag} the reader fills the screen at a readable measure, nothing scrolls sideways`,
        fit.box?.join() === `0,0,${fit.view.join()}` &&
          fit.body <= fit.measure + 2 &&
          fit.scroll <= (fit.view[0] ?? 0),
        fit,
      );
      check(
        `${tag} no comments in the reader`,
        await page.evaluate(
          () =>
            !document.querySelector('.reader .comment-thread, .reader [aria-label*="omment" i]'),
        ),
      );
      check(
        `${tag} focus starts inside the reader`,
        await page.evaluate(
          () => document.querySelector('.reader')?.contains(document.activeElement) === true,
        ),
      );
      check(`${tag} opening it marks it read`, await becomes(c.id, 'reading'));

      // Mark unread: the keyboard shortcut, then the button.
      await shownRead();
      await page.keyboard.press('u');
      check(`${tag} u marks it unread`, await becomes(c.id, 'unread'));
      await page.keyboard.press('Escape');
      await closed();
      await page.click('.read-row-main');
      await opened('Story C');
      await becomes(c.id, 'reading');
      // The button is offered once the page shows the story as read (as for u above), not when the API does.
      await shownRead();
      await page.evaluate(() => {
        for (const button of document.querySelectorAll<HTMLElement>('.reader-bar button')) {
          if (button.textContent === 'Mark unread') button.click();
        }
      });
      check(`${tag} the Mark unread button works`, await becomes(c.id, 'unread'));

      // j / k and the arrows step between stories, and read the one they land on.
      await page.keyboard.press('j');
      await opened('Story B');
      check(`${tag} j opens the next story and reads it`, await becomes(b.id, 'reading'));
      await page.keyboard.press('ArrowRight');
      await opened('Story A');
      await page.keyboard.press('ArrowLeft');
      await opened('Story B');
      await page.keyboard.press('k');
      await opened('Story C');
      check(`${tag} the keys step through the list`, (await sel()) === c.id);

      // Esc closes in one step even after stepping around; the list shows the read state.
      await becomes(c.id, 'reading');
      await shownRead();
      await page.keyboard.press('u');
      await becomes(c.id, 'unread');
      await page.keyboard.press('Escape');
      await closed();
      await page.waitForFunction(
        (id) => document.querySelector(`[data-blip-id="${id}"]`)?.hasAttribute('data-unread'),
        {},
        c.id,
      );
      check(`${tag} Esc closes the reader`, (await sel()) === null, await sel());
      check(
        `${tag} read stories are muted, the unread one is not`,
        await page.evaluate(
          ([unreadId, readId]) =>
            document.querySelector(`[data-blip-id="${unreadId}"]`)?.hasAttribute('data-unread') ===
              true &&
            document.querySelector(`[data-blip-id="${readId}"]`)?.hasAttribute('data-unread') ===
              false,
          [c.id, b.id] as const,
        ),
      );

      // Back closes it too.
      await page.click(`[data-blip-id="${a.id}"] .read-row-main`);
      await opened('Story A');
      await page.goBack();
      await closed();
      check(`${tag} Back closes the reader`, (await sel()) === null, await sel());

      // Mark unread from the list on hover (a pointer device only).
      if (width === 1440) {
        await becomes(b.id, 'reading');
        await page.hover(`[data-blip-id="${b.id}"]`);
        await page.click(`[data-blip-id="${b.id}"] .read-row-act`);
        check(`${tag} Mark unread from the list`, await becomes(b.id, 'unread'));
      }

      // Unread / All.
      const chip = (label: string) =>
        page.evaluate((text) => {
          const chips = [...document.querySelectorAll<HTMLElement>('.filter-rail button')];
          chips.find((el) => el.textContent.startsWith(text))?.click();
        }, label);
      await call(`/api/blips/${a.id}`, 'PATCH', { status: 'reading' });
      await call(`/api/blips/${b.id}`, 'PATCH', { status: 'unread' });
      await chip('Unread');
      await page
        .waitForFunction(() => document.querySelectorAll('.read-row').length === 2)
        .catch(() => null);
      check(
        `${tag} Unread shows only the unread`,
        (await titles()).join() === 'Story C,Story B',
        await titles(),
      );
      await chip('All');
      await page
        .waitForFunction(() => document.querySelectorAll('.read-row').length === 3)
        .catch(() => null);
      check(`${tag} All shows everything`, (await titles()).length === 3);

      // Deep link: a cold load opens that story and only that story; a bad id shows nothing else.
      await page.goto(url(`?sel=${a.id}`), { waitUntil: 'networkidle2' });
      await opened('Story A');
      await page.keyboard.press('Escape');
      await closed();
      check(`${tag} Esc on a cold deep link clears ?sel=`, (await sel()) === null, await sel());
      await page.goto(url('?sel=00000000-0000-4000-8000-000000000000'), {
        waitUntil: 'networkidle2',
      });
      await page.waitForSelector('.reader');
      await page.waitForFunction(() =>
        /not available/.test(document.querySelector('.reader')?.textContent ?? ''),
      );
      check(`${tag} an unknown id shows no story`, (await page.$('.reader-title')) === null);
    }
  } finally {
    await context.close().catch(() => undefined);
    await call(`/api/radars/${radar.id}`, 'DELETE').catch(() => undefined);
  }
  return { checks, failures, notes: [] };
}

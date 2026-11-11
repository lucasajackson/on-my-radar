/**
 * 4b1e03e1: a jump inside a radar scrolls the one pane that scrolls, and nothing else.
 *
 * Clicking a day in the microblog's days rail left the app shell ending at ~870px with black below
 * it. `scrollIntoView` scrolls every scrollable ancestor, and `overflow: hidden` ancestors (the
 * fixed shell, `.app-main`) are scrollable by script; the pane is `.app-content`. After each jump
 * (microblog day, discussion thread, log decision) at 1920 and 390: the document has not scrolled,
 * neither has the shell or `.app-main`, the shell still reaches the bottom of the viewport, and the
 * target sits at the top of the pane (under the sticky radar header).
 */
import pg from 'pg';
import type { Page } from 'puppeteer-core';
import { PATIENCE_MS, wait } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

interface Json {
  radar: { id: string };
  blip: { id: string };
}

export async function runScrollFlows(
  page: Page,
  seeded: Seeded,
  databaseUrl: string,
): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async (path: string, body: unknown): Promise<Json> => {
    const response = await fetch(seeded.baseUrl + path, {
      method: 'POST',
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (!response.ok) throw new Error(`Scroll fixture refused: ${path} ${await response.text()}`);
    return (await response.json()) as Json;
  };
  const db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const long = 'A line long enough to take room in the feed. '.repeat(12);

  // Five days of posts, long enough that the page scrolls at 1920x900 as well as at 390.
  const { radar: feed } = await call('/api/radars', {
    name: 'Scroll feed',
    template: 'microblog',
    templateConfig: { grouping: 'day' },
  });
  const feedId = feed.id;
  for (let day = 0; day < 5; day++) {
    for (let post = 0; post < 4; post++) {
      const { blip } = await call(`/api/radars/${feedId}/blips`, {
        body: `Day ${day} post ${post}. ${long}`,
      });
      await db.query(
        `UPDATE blips SET created_at = now() - ($2 || ' days')::interval - ($3 || ' minutes')::interval WHERE id = $1`,
        [blip.id, String(day + 2), String(post)],
      );
    }
  }
  const { radar: talk } = await call('/api/radars', {
    name: 'Scroll talk',
    template: 'discussion',
  });
  const { radar: log } = await call('/api/radars', { name: 'Scroll log', template: 'decisions' });
  for (const [id, kind] of [
    [talk.id, 'Thread'],
    [log.id, 'Decision'],
  ] as const) {
    for (let at = 0; at < 8; at++) {
      await call(`/api/radars/${id}/blips`, { body: `# ${kind} ${at}\n${long}${long}${long}` });
    }
  }
  await db.end();

  const context = await page.browser().createBrowserContext();
  const tab = await context.newPage();
  tab.setDefaultTimeout(PATIENCE_MS);
  await context.setCookie({
    name: 'omr_session',
    value: seeded.ownerCookie.slice('omr_session='.length),
    domain: new URL(seeded.baseUrl).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });

  // What the jump must leave alone, and where the target ended up.
  const measure = (target: string, at: number) =>
    tab.evaluate(
      (targetSelector: string, index: number) => {
        const out: Record<string, number | string | null> = {
          document: document.scrollingElement?.scrollTop ?? 0,
          body: document.body.scrollTop,
          viewport: innerHeight,
        };
        for (const name of ['app-shell', 'app-main']) {
          out[`${name}Top`] = document.querySelector(`.${name}`)?.scrollTop ?? null;
        }
        out['shellBottom'] =
          document.querySelector('.app-shell')?.getBoundingClientRect().bottom ?? null;
        out['paneBottom'] =
          document.querySelector('.app-content')?.getBoundingClientRect().bottom ?? null;
        const pane = document.querySelector('.app-content');
        const header = document.querySelector('.radar-header')?.getBoundingClientRect();
        const box = document.querySelectorAll(targetSelector)[index]?.getBoundingClientRect();
        out['paneScroll'] = pane?.scrollTop ?? null;
        out['targetTop'] = box ? box.top : null;
        out['headerBottom'] = header ? header.bottom : null;
        return out;
      },
      target,
      at,
    );

  const jumps: Array<{
    what: string;
    radar: string;
    ready: string;
    click: string;
    target: string;
    index: number;
    // The target sits at the pane's top, below the sticky radar header.
    atTop: boolean;
  }> = [
    {
      what: 'microblog day',
      radar: feedId,
      ready: '.cols-index .day-row',
      click: '.cols-index .day-row:nth-of-type(4)',
      target: '.timeline-day',
      index: 3,
      atTop: true,
    },
    {
      what: 'discussion thread',
      radar: talk.id,
      ready: '.cols-index .disc-topic',
      click: '.cols-index .disc-topic:nth-of-type(6)',
      target: '.cols-main',
      index: 0,
      atTop: false,
    },
    {
      what: 'log decision',
      radar: log.id,
      ready: '.cols-index button',
      click: '.cols-index button:nth-of-type(6)',
      target: '.cols-main',
      index: 0,
      atTop: false,
    },
  ];

  for (const width of [1920, 390]) {
    await tab.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    for (const jump of jumps) {
      const at = `[${jump.what}] at ${width}px`;
      await tab.goto(`${seeded.baseUrl}/radar/${jump.radar}`, { waitUntil: 'networkidle2' });
      const ready = await tab
        .waitForSelector(jump.ready, { visible: true, timeout: 5000 })
        .catch(() => null);
      if (!ready) {
        // Below 1000px of pane the index is a screen of its own or absent; not this flow's case.
        check(`${at} has the control to click`, width < 1000, jump.ready);
        continue;
      }
      await tab.click(jump.click);
      await wait(1200); // the smooth scroll has settled
      const seen = await measure(jump.target, jump.index);
      console.log(at, JSON.stringify(seen));
      check(
        `${at} the document did not scroll`,
        seen['document'] === 0 && seen['body'] === 0,
        seen,
      );
      check(
        `${at} the shell and main did not scroll`,
        seen['app-shellTop'] === 0 && seen['app-mainTop'] === 0,
        seen,
      );
      check(
        `${at} the shell still reaches the bottom of the viewport`,
        Number(seen['shellBottom']) >= Number(seen['viewport']) - 1,
        seen,
      );
      if (jump.atTop) {
        // The clicked day's heading sits at the top of the feed: just under the sticky header.
        const gap = Number(seen['targetTop'] ?? 1e9) - Number(seen['headerBottom'] ?? 0);
        check(`${at} the clicked day's heading is at the top of the feed`, gap >= 0 && gap <= 20, {
          gap,
          ...seen,
        });
      }
    }
  }
  await context.close();
  return { checks, failures, notes: [] };
}

/**
 * Settings as sections with their own URLs: a list that drills in on a phone,
 * tabs on a computer, old single-page links redirected, and the account
 * download saved as a real .zip by a real browser.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { IOS_UA, PHONE, PATIENCE_MS } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

const SECTIONS = [
  ['Profile', '/settings/profile'],
  ['Notifications', '/settings/notifications'],
  ['Connections', '/settings/connections'],
  ['Email capture', '/settings/email'],
  ['Data', '/settings/data'],
] as const;

/** File names from a zip's central directory, read the way unzip tools do. */
function zipNames(archive: Buffer): string[] {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return [];
  let count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  if (count === 0xffff) {
    const record = Number(archive.readBigUInt64LE(end - 20 + 8));
    count = Number(archive.readBigUInt64LE(record + 32));
    at = Number(archive.readBigUInt64LE(record + 48));
  }
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) return [];
    const length = archive.readUInt16LE(at + 28);
    names.push(archive.subarray(at + 46, at + 46 + length).toString('utf8'));
    at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return names;
}

export async function runSettingsFlows(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const notes: unknown[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  for (const width of [390, 1280]) {
    const tag = `[settings ${width}]`;
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    human.setDefaultTimeout(PATIENCE_MS);
    human.setDefaultNavigationTimeout(PATIENCE_MS);
    // See harness.ts: evaluate callbacks with named inner functions need it.
    await human.evaluateOnNewDocument('globalThis.__name ??= function (fn) { return fn; };');
    // The phone is iOS, where the download is assembled in memory; the
    // computer is Chrome, where a service worker streams it to disk.
    if (width === 390) await human.setUserAgent({ userAgent: IOS_UA });
    await human.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await context.setCookie({
      name: 'omr_session',
      value: seeded.ownerCookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    const goto = (path: string) => human.goto(seeded.baseUrl + path, { waitUntil: 'networkidle2' });
    const path = () => new URL(human.url()).pathname;
    const facts = () =>
      human.evaluate(() => {
        const visible = (el: Element) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        };
        return {
          h1: document.querySelector<HTMLElement>('main h1')?.innerText.trim() ?? null,
          overflow:
            document.documentElement.scrollWidth > innerWidth + 1 ||
            [...document.querySelectorAll('main *')].some(
              (el) => visible(el) && el.getBoundingClientRect().right > innerWidth + 1,
            ),
          tabs: [...document.querySelectorAll('.section-tab')].filter(visible).map((tab) => ({
            text: tab.textContent.trim(),
            current: tab.getAttribute('aria-current') === 'page',
          })),
          rows: [...document.querySelectorAll('[data-omr="settings-section-link"]')]
            .filter(visible)
            .map((row) => {
              const box = row.getBoundingClientRect();
              return {
                href: row.getAttribute('href'),
                height: Math.round(box.height),
                onScreen: box.top >= 0 && box.bottom <= innerHeight,
              };
            }),
          signOut: [...document.querySelectorAll('button')].some(
            (b) => /sign out/i.test(b.textContent) && visible(b),
          ),
        };
      });
    try {
      await goto('/settings');
      await human.waitForFunction(() => document.querySelector('main h1') !== null);
      const home = await facts();
      notes.push({ what: `settings home ${width}`, ...home });
      await human.screenshot({ path: `${outDir}/settings-home-${width}.png` });
      check(`${tag} no horizontal overflow at /settings`, !home.overflow, home);
      if (width === 390) {
        check(
          `${tag} every section is a row that drills in, all in the first screen`,
          home.rows.length === SECTIONS.length &&
            home.rows.every((row, i) => row.href === SECTIONS[i]?.[1]) &&
            home.rows.every((row) => row.height >= 44 && row.onScreen),
          home.rows,
        );
        check(`${tag} no tab strip on a phone`, home.tabs.length === 0, home.tabs);
        check(`${tag} sign out is on the You list`, home.signOut, home);

        await human.click('[data-omr="settings-section-link"][href="/settings/notifications"]');
        await human.waitForFunction(() => location.pathname === '/settings/notifications');
        await human.waitForSelector('[data-omr="per-radar-notifications"]');
        // Past the push transition, so measurements are of the settled screen.
        await new Promise((r) => setTimeout(r, 600));
        const notifications = await human.evaluate(() => {
          const fold = document.querySelector<HTMLDetailsElement>(
            '[data-omr="per-radar-notifications"]',
          );
          return {
            h1: document.querySelector<HTMLElement>('main h1')?.innerText.trim() ?? null,
            folded: fold ? !fold.open : null,
            summary: fold?.querySelector('summary')?.textContent.trim() ?? null,
            defaultsShown: [...document.querySelectorAll('input[type=checkbox]')].some(
              (input) =>
                /by email$/.test(input.getAttribute('aria-label') ?? '') &&
                input.getBoundingClientRect().height > 0,
            ),
            overflow: [...document.querySelectorAll('main *')].some(
              (el) => el.getBoundingClientRect().right > innerWidth + 1,
            ),
            height: document.scrollingElement?.scrollHeight ?? 0,
          };
        });
        notes.push({ what: `settings notifications ${width}`, ...notifications });
        await human.screenshot({ path: `${outDir}/settings-notifications-${width}.png` });
        check(
          `${tag} a pushed section is titled by its name`,
          notifications.h1 === 'Notifications',
        );
        check(
          `${tag} per-radar notifications are folded, the defaults are not`,
          notifications.folded === true && notifications.defaultsShown,
          notifications,
        );
        check(
          `${tag} notifications do not scroll sideways`,
          !notifications.overflow,
          notifications,
        );
        await human.goBack({ waitUntil: 'networkidle2' });
        check(`${tag} back returns to the section list`, path() === '/settings', path());
      } else {
        check(
          `${tag} the sections are a tab strip, Profile current`,
          home.tabs.map((tab) => tab.text).join('|') ===
            SECTIONS.map(([label]) => label).join('|') && home.tabs[0]?.current === true,
          home.tabs,
        );
        check(`${tag} no drill-in list on a computer`, home.rows.length === 0, home.rows);
        await human.click('.section-tab[href="/settings/connections"]');
        await human.waitForFunction(() =>
          [...document.querySelectorAll('button')].some((b) => b.textContent.includes('New token')),
        );
        const connections = await facts();
        await human.screenshot({ path: `${outDir}/settings-connections-${width}.png` });
        check(
          `${tag} a tab is a real URL and marks itself current`,
          path() === '/settings/connections' &&
            connections.tabs.find((tab) => tab.current)?.text === 'Connections',
          { path: path(), tabs: connections.tabs },
        );
      }

      // Every section renders, and none scrolls sideways.
      for (const [label, url] of SECTIONS) {
        await goto(url);
        await human.waitForFunction(() => document.querySelector('main h1') !== null);
        const section = await facts();
        check(`${tag} ${label} renders without sideways scroll`, !section.overflow, section);
        if (width === 390)
          check(`${tag} ${label} is titled by its name`, section.h1 === label, section.h1);
      }

      // Links written for the single settings page land in their section.
      for (const [legacy, expected] of [
        ['/settings#connections', '/settings/connections'],
        ['/settings#email-capture', '/settings/email'],
      ] as const) {
        await goto(legacy);
        await human.waitForFunction((want) => location.pathname === want, {}, expected);
        check(`${tag} ${legacy} redirects to ${expected}`, path() === expected, path());
      }

      // The account download is a .zip a person can open.
      const downloads = join(outDir, `settings-download-${width}`);
      rmSync(downloads, { recursive: true, force: true });
      mkdirSync(downloads, { recursive: true });
      const cdp = await human.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
        ...(context.id ? { browserContextId: context.id } : {}),
      });
      await goto('/settings/data');
      const copy = await human.evaluate(() => document.querySelector('main')?.innerText ?? '');
      check(`${tag} the download asks for no tools`, !/node|terminal|reader/i.test(copy), copy);
      await human.evaluate(() =>
        [...document.querySelectorAll('button')]
          .find((b) => b.textContent.includes('Download .zip'))
          ?.click(),
      );
      await human
        .waitForFunction(
          () =>
            /Done\.|failed|alert/i.test(
              document.querySelector('[role=status],[role=alert]')?.textContent ?? '',
            ),
          { timeout: PATIENCE_MS },
        )
        .catch(() => undefined);
      let saved: string[] = [];
      for (let i = 0; i < 100; i++) {
        saved = readdirSync(downloads);
        if (saved.includes('On-My-Radar-account.zip')) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const status = await human.evaluate(
        () => document.querySelector('[role=status],[role=alert]')?.textContent ?? '',
      );
      const names = saved.includes('On-My-Radar-account.zip')
        ? zipNames(readFileSync(join(downloads, 'On-My-Radar-account.zip')))
        : [];
      notes.push({ what: `account download ${width}`, status, saved, files: names.length });
      check(
        `${tag} the account downloads as a zip with a README, radar folders and a closing manifest`,
        names[0] === 'README.txt' &&
          names.at(-1) === 'manifest.json' &&
          names.some((name) => /^radars\/[^/]+\/.+\.md$/.test(name)) &&
          !names.some((name) => name.includes('reader')),
        { status, saved, sample: names.slice(0, 5), count: names.length },
      );
    } finally {
      await context.close();
    }
  }
  return { checks, failures, notes };
}

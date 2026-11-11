/**
 * The architecture radar in a real browser, at a phone and a desktop width:
 * the toggle, the wide tables, and select-to-amend (where the Amend bar is, and
 * that nothing covers it). Run alone with `--architecture-only`.
 */
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { IOS_UA, PATIENCE_MS, PHONE } from './harness.js';
import type { Seeded } from './seed.js';
import { runArchitectureAuthoringFlows } from './architecture-authoring-flows.js';
import { runArchitectureMapFlows } from './architecture-map-flows.js';
import type { Check, SweepResult } from './sweep.js';

/** A plain sentence in the seeded Stripe row, with no amendment in it. */
const CELL = 'Reads only. Webhooks are triggers that cause Acme to re-read the objects';

async function select(page: Page): Promise<string> {
  return page.evaluate((text) => {
    const cell = [...document.querySelectorAll('.arch-page td')].find((td) =>
      td.textContent.includes(text),
    );
    if (!cell) throw new Error('seeded cell missing');
    const range = document.createRange();
    range.selectNodeContents(cell);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    cell.scrollIntoView({ block: 'center', inline: 'start' });
    return cell.textContent.trim();
  }, CELL);
}

export async function runArchitectureFlows(page: Page, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
    assert(ok, `${name} ${JSON.stringify(detail)}`);
  };
  const radar = seeded.radars.find((r) => r.template === 'architecture');
  assert(radar, 'seed has no architecture radar');
  for (const width of [390, 1280]) {
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    human.setDefaultTimeout(PATIENCE_MS);
    await human.setViewport(width === 390 ? PHONE : { width, height: 900 });
    if (width === 390) await human.setUserAgent({ userAgent: IOS_UA });
    await context.setCookie({
      name: 'omr_session',
      value: seeded.ownerCookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    const tag = `[architecture ${width}]`;
    try {
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await human.waitForSelector('.arch-page', { visible: true });

      const facts = await human.evaluate(() => {
        const tables = [...document.querySelectorAll<HTMLElement>('.arch-page table')];
        return {
          pageScrollsSideways:
            document.documentElement.scrollWidth > window.innerWidth ||
            document.body.scrollWidth > window.innerWidth,
          tableScrollsInside: tables.some((t) => t.scrollWidth > t.clientWidth),
          tableFitsItsColumn: tables.every(
            (t) => t.getBoundingClientRect().right <= window.innerWidth + 1,
          ),
        };
      });
      check(`${tag} the page body never scrolls sideways`, !facts.pageScrollsSideways, facts);
      check(`${tag} tables stay inside the screen`, facts.tableFitsItsColumn, facts);
      if (width === 390)
        check(`${tag} a wide table scrolls inside its own box`, facts.tableScrollsInside, facts);

      const marks = async () =>
        human.evaluate(() => ({
          struck: document.querySelectorAll('.arch-page del.amend-struck').length,
          replaced: document.querySelectorAll('.arch-page ins.amend-with').length,
          proposed: document.querySelectorAll('.arch-page mark.amend-proposed').length,
        }));
      const toggle = (label: string) =>
        human.evaluate((text) => {
          [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Charter text"] button')]
            .find((b) => b.textContent === text)
            ?.click();
        }, label);
      await toggle('As written');
      let m = await marks();
      check(`${tag} As written strikes the accepted text`, m.struck === 1 && m.replaced === 0, m);
      await toggle('As amended');
      m = await marks();
      check(`${tag} As amended shows the replacement`, m.struck === 0 && m.replaced === 1, m);
      check(`${tag} a proposed amendment is highlighted`, m.proposed === 1, m);

      await toggle('As written');
      const struck = await human.evaluate(() => {
        const [r = 0, g = 0, b = 0] = (
          getComputedStyle(
            document.querySelector('.arch-page .amend-struck') as Element,
          ).color.match(/\d+/g) ?? []
        ).map(Number);
        return { r, g, b };
      });
      check(
        `${tag} struck text is red`,
        struck.r > 150 && struck.r > struck.g + 60 && struck.r > struck.b + 60,
        struck,
      );

      // The sticky radar header must be cleared by the margin an anchor scroll keeps. Measured
      // rather than scrolled to: a short page cannot scroll its last section to the top.
      const landed = await human.evaluate(() => {
        const header =
          document.querySelector('header.sticky')?.getBoundingClientRect().height ?? Infinity;
        const margins = [...document.querySelectorAll('.arch-adr, .arch-open')].map((el) =>
          parseFloat(getComputedStyle(el).scrollMarginTop),
        );
        return { header, margins };
      });
      check(
        `${tag} anchor links keep clear of the sticky header`,
        landed.margins.length > 0 && landed.margins.every((m) => m >= landed.header),
        landed,
      );

      await human.click('.arch-adr-head');
      await human.waitForSelector('.arch-adr-detail .blip-body', { visible: true });
      const read = await human.evaluate(() => ({
        decision: document.querySelector('.arch-adr-detail .blip-body')?.textContent.trim() ?? '',
        changes: document.querySelector('.arch-adr-detail .arch-changes')?.textContent ?? '',
        sideways: document.documentElement.scrollWidth > window.innerWidth,
      }));
      check(
        `${tag} an accepted ADR opens to its decision and what it changed`,
        read.decision.length > 0 && read.changes.includes('all billing truth') && !read.sideways,
        read,
      );
      // Earlier flows in the shared run file a plain blip into every radar, which lands here as
      // a proposed ADR of its own, so the seeded one is found by title, not by position.
      const proposed = await human.evaluate(
        () =>
          [...document.querySelectorAll('.arch-open')]
            .map((node) => node.textContent)
            .find((text) => text.includes('Billing acts on its own')) ?? '',
      );
      check(
        `${tag} a proposed ADR shows its quote and replacement before Accept`,
        proposed.includes('Never acts on its own (ADR-0005)') &&
          proposed.includes('Suspends and resumes on the clock'),
        proposed,
      );

      const quote = await select(human);
      await human.waitForSelector('.amend-bar button', { visible: true });
      const bar = await human.evaluate(() => {
        const button = document.querySelector<HTMLElement>('.amend-bar button');
        const box = button?.getBoundingClientRect();
        const tabs = document.querySelector('.app-tabbar')?.getBoundingClientRect();
        const hit = box
          ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          : null;
        return {
          reachable: Boolean(hit && button?.contains(hit)),
          inside: Boolean(box && box.left >= 0 && box.right <= window.innerWidth && box.top >= 0),
          position: getComputedStyle(document.querySelector('.amend-bar') as Element).position,
          // Docked: the bar's foot rests on the tab bar's head, not under it.
          aboveTabBar:
            tabs && box
              ? tabs.top -
                (document.querySelector('.amend-bar')?.getBoundingClientRect().bottom ?? 0)
              : null,
        };
      });
      check(
        `${tag} the selection toolbar is on screen and nothing covers it`,
        bar.reachable && bar.inside,
        bar,
      );
      if (width === 390)
        check(
          `${tag} the bar docks directly above the tab bar`,
          bar.position === 'sticky' && bar.aboveTabBar !== null && Math.abs(bar.aboveTabBar) <= 2,
          bar,
        );
      else check(`${tag} the bar floats beside the selection`, bar.position === 'fixed', bar);

      await human.click('.amend-bar button');
      await human.waitForSelector('.panel-quote del', { visible: true });
      const shown = await human.$eval('.panel-quote del', (node) => node.textContent);
      check(`${tag} the Propose ADR panel opens with the quote filled in`, shown === quote, {
        shown,
        quote,
      });
      // From 1024px it is a column of the card beside the charter; below that a full-height sheet.
      const placed = await human.evaluate(() => ({
        inline: Boolean(document.querySelector('.arch-charter > .side-panel-slot .side-panel')),
        sheet: document.querySelector('.modal-panel.is-side')?.getAttribute('role') ?? null,
      }));
      check(
        `${tag} the panel is ${width >= 1024 ? 'beside the charter, not a dialog' : 'a full-height sheet'}`,
        width >= 1024
          ? placed.inline && placed.sheet === null
          : !placed.inline && placed.sheet === 'dialog',
        placed,
      );
      await human
        .screenshot({ path: `${process.env['OMR_PHONE_OUT'] ?? '/tmp'}/architecture-${width}.png` })
        .catch(() => null);
    } finally {
      await context.close();
    }
  }
  const map = await runArchitectureMapFlows(page, seeded);
  const authoring = await runArchitectureAuthoringFlows(page, seeded);
  return {
    checks: [...checks, ...map.checks, ...authoring.checks],
    failures: [...failures, ...map.failures, ...authoring.failures],
    notes: ['Hosted Chromium only; Safari’s selection callout is not emulated.'],
  };
}

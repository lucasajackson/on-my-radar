/**
 * Writing an Architecture radar from the page, in a real browser at a phone and a
 * desktop width: a new radar is empty but whole (its card, tabs and Propose ADR),
 * then the charter is written, two boundaries and a contract are drawn, and an ADR
 * is proposed, every step through the UI, and all of it is there at the end. Run
 * alone with `--architecture-only`; screenshots of the empty and the filled radar
 * go to OMR_PHONE_OUT.
 */
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { IOS_UA, PATIENCE_MS, PHONE } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

const OUT = () => process.env['OMR_PHONE_OUT'] ?? '/tmp';

async function api<T>(seeded: Seeded, path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(seeded.baseUrl + path, {
    method,
    headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Press the first visible button with exactly this text, inside `scope`, with a real click. */
async function press(human: Page, text: string, scope = 'body'): Promise<void> {
  const found = await human.evaluate(
    (label, root) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(`${root} button`)].find(
        (b) => b.textContent === label && b.offsetParent !== null,
      );
      button?.setAttribute('data-press', 'now');
      button?.scrollIntoView({ block: 'center' });
      return Boolean(button);
    },
    text,
    scope,
  );
  assert(found, `no visible button "${text}" in ${scope}`);
  await human.click('[data-press="now"]');
  await human.evaluate(() => document.querySelector('[data-press]')?.removeAttribute('data-press'));
}

/** Type into the field whose label starts with this text. */
async function fill(human: Page, label: string, value: string): Promise<void> {
  const id = await human.evaluate((text) => {
    const found = [...document.querySelectorAll('label')].find((l) =>
      l.textContent.startsWith(text),
    );
    return found?.htmlFor ?? '';
  }, label);
  assert(id, `no field labelled "${label}"`);
  const field = await human.$(`[id="${id}"]`);
  assert(field, `no field ${id}`);
  await field.click({ clickCount: 3 });
  await field.type(value);
}

/** A side panel, wherever it is: a column of the card from 1024px, a full-height sheet below. */
const PANEL = '.side-panel';
/** The same, for a selector that goes on inside it. */
const IN_PANEL = '.side-panel';

/** Press a button in the open panel's footer. */
const pressInPanel = (human: Page, text: string) => press(human, text, '.side-panel-foot');

/** Add items to the open panel's chip input: type each, then Enter. */
async function addChips(human: Page, items: readonly string[]): Promise<void> {
  const box = await human.waitForSelector(`${IN_PANEL} .chip-text`, { visible: true });
  assert(box, 'no chip input');
  for (const item of items) {
    await box.click();
    await box.type(item);
    await human.keyboard.press('Enter');
  }
}

/** Type into the open panel's Milkdown field (the first rich-text box in it). */
async function writeRich(human: Page, text: string): Promise<void> {
  const editor = await human.waitForSelector(`${IN_PANEL} [contenteditable]`, { visible: true });
  assert(editor, 'no rich-text field');
  await editor.click();
  await editor.type(text);
  // The panel reads what was typed a moment later.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Choose an option of a shared Select by the label on its trigger. */
async function choose(human: Page, aria: string, option: string): Promise<void> {
  await human.click(`[role=combobox][aria-label="${aria}"]`);
  await human.waitForSelector('[role=option]', { visible: true });
  await human.evaluate((name) => {
    [...document.querySelectorAll('[role=option]')]
      .find((o) => o.textContent === name)
      ?.setAttribute('data-press', 'now');
  }, option);
  await human.click('[data-press="now"]');
  await human.waitForSelector('[role=option]', { hidden: true });
}

export async function runArchitectureAuthoringFlows(
  page: Page,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
    assert(ok, `${name} ${JSON.stringify(detail)}`);
  };
  for (const width of [390, 1440]) {
    const { radar } = await api<{ radar: { id: string } }>(seeded, '/api/radars', 'POST', {
      name: `Authoring ${width}`,
      accent: 'slate',
      glyph: 'compass',
      template: 'architecture',
    });
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
    const tag = `[architecture authoring ${width}]`;
    const sideways = () =>
      human.evaluate(
        () =>
          document.documentElement.scrollWidth > window.innerWidth ||
          document.body.scrollWidth > window.innerWidth,
      );
    const tab = (label: string) =>
      human.evaluate((text) => {
        [...document.querySelectorAll<HTMLElement>('[role=tab]')]
          .find((t) => t.textContent === text)
          ?.click();
      }, label);
    try {
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await human.waitForSelector('.arch', { visible: true });

      /* ----------------------------------------------------------- empty -- */
      const empty = await human.evaluate(() => ({
        tabs: [...document.querySelectorAll('.arch [role=tab]')].map((t) => t.textContent),
        composer: Boolean(document.querySelector('#composer')),
        write: [...document.querySelectorAll('.arch button')].some(
          (b) => b.textContent === 'Write the charter',
        ),
        propose: [...document.querySelectorAll('.arch-bar button')].some(
          (b) => b.textContent === 'Propose ADR',
        ),
        generic: document.body.textContent.includes('Nothing on this radar yet'),
      }));
      check(
        `${tag} an empty radar still has its card, three tabs and a Propose ADR button`,
        empty.tabs.join() === 'Charter,Map,Matrix' && empty.propose && !empty.generic,
        empty,
      );
      check(`${tag} the empty Charter offers to write it`, empty.write, empty);
      check(`${tag} there is no capture box above the card`, !empty.composer, empty);
      check(`${tag} the empty radar never scrolls sideways`, !(await sideways()));
      await tab('Map');
      await human.waitForSelector('.arch-empty', { visible: true });
      check(
        `${tag} the empty Map says what goes in it and offers Add boundary`,
        await human.evaluate(
          () =>
            document.querySelector('.arch-empty')?.textContent.includes('No boundaries yet') ===
              true &&
            [...document.querySelectorAll('.arch-empty button')].some(
              (b) => b.textContent === 'Add boundary',
            ),
        ),
      );
      await tab('Matrix');
      check(
        `${tag} the empty Matrix explains itself`,
        await human.evaluate(
          () =>
            document.querySelector('.arch-empty')?.textContent.includes('Nothing to compare') ===
            true,
        ),
      );
      await tab('Charter');
      await human.screenshot({ path: `${OUT()}/architecture-empty-${width}.png` });

      /* --------------------------------------------------------- charter -- */
      // The charter is one document, written in place: the empty Charter's button opens the editor
      // on an empty document (never a boxed form), typing is saved by itself, and Done closes it.
      await press(human, 'Write the charter', '.arch');
      const box = await human.waitForSelector('.charter-edit .md-rich [contenteditable]', {
        visible: true,
      });
      assert(box, 'no charter editor');
      check(
        `${tag} Write the charter opens the editor in place, not a form`,
        await human.evaluate(
          () => !document.querySelector('.arch-form') && !document.querySelector('.arch-empty'),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await box.click();
      await human.keyboard.type('# Principles');
      await human.keyboard.press('Enter');
      await human.keyboard.type('Billing owns all billing truth. Everything else asks it.');
      await human.screenshot({ path: `${OUT()}/architecture-charter-editing-${width}.png` });
      // Saved and Done stay in reach while the document is typed in (a phone scrolls the page).
      const reach = await human.evaluate(() => {
        const done = [...document.querySelectorAll<HTMLElement>('.arch-bar button')].find(
          (b) => b.textContent === 'Done',
        );
        const rect = done?.getBoundingClientRect();
        return { top: rect?.top ?? -1, bottom: rect?.bottom ?? -1, height: window.innerHeight };
      });
      check(
        `${tag} Done is on screen while editing`,
        reach.top >= 0 && reach.bottom <= reach.height,
        reach,
      );
      await human.waitForFunction(
        () => document.querySelector('.charter-save')?.textContent === 'Saved just now',
        { timeout: 15_000 },
      );
      await press(human, 'Done', '.arch-bar');
      await human.waitForSelector('.charter-edit', { hidden: true });
      await human.waitForSelector('.arch-page', { visible: true });
      const written = await human.evaluate(() => ({
        text: document.querySelector('.arch-page')?.textContent ?? '',
        form: Boolean(document.querySelector('.arch-form')),
      }));
      check(
        `${tag} the charter is written in place and read back`,
        written.text.includes('Principles') &&
          written.text.includes('Everything else asks it.') &&
          !written.form,
        written,
      );

      /* ------------------------------------------------------------- map -- */
      await tab('Map');
      for (const [name, owns] of [
        ['Billing', 'billing.invoices\nbilling.plans'],
        ['Sites', 'sites.sites'],
      ] as const) {
        await press(human, 'Add boundary', '.arch-actions');
        await human.waitForSelector(PANEL, { visible: true });
        if (width === 1440) {
          // The first boundary is written under the empty Map's explanation; the second in the rail.
          const placed = await human.evaluate(() => ({
            inRail: Boolean(document.querySelector('.arch-focus .side-panel')),
            dialog: Boolean(document.querySelector('[role=dialog]')),
          }));
          check(
            `${tag} the boundary panel never covers the map (${name})`,
            !placed.dialog && (name === 'Billing' || placed.inRail),
            placed,
          );
        } else {
          check(
            `${tag} the boundary panel is a full-height sheet (${name})`,
            await human.evaluate(() => Boolean(document.querySelector('.modal-panel.is-side'))),
          );
        }
        await fill(human, 'Name', name);
        await addChips(human, owns.split('\n'));
        const chipped = await human.$$eval(`${IN_PANEL} .chip-body`, (n) =>
          n.map((c) => c.textContent),
        );
        check(
          `${tag} what it owns is one chip per item (${name})`,
          chipped.join() === owns.split('\n').join(),
          chipped,
        );
        await writeRich(human, `${name} is part of the application.`);
        await pressInPanel(human, 'Create boundary');
        await human.waitForSelector(PANEL, { hidden: true });
      }
      // Add contract is off until the refetch after the second save has put two boundaries in the count.
      await human.waitForFunction(() =>
        /\b2 boundaries\b/.test(document.querySelector('.arch-count')?.textContent ?? ''),
      );
      await press(human, 'Add contract', '.arch-actions');
      await human.waitForSelector(PANEL, { visible: true });
      await fill(human, 'Name', 'Site billing');
      await fill(human, 'Version', '1.0');
      await choose(human, 'From boundary', 'Billing');
      await choose(human, 'To boundary', 'Sites');
      await pressInPanel(human, 'Create contract');
      await human.waitForSelector(PANEL, { hidden: true });
      // The tab's counts follow the refetch that a save triggers.
      await human
        .waitForFunction(() =>
          /\b2 boundaries\b.*\b1 contract\b/.test(
            document.querySelector('.arch-count')?.textContent ?? '',
          ),
        )
        .catch(() => null);
      const count = (await human.$eval('.arch-count', (n) => n.textContent)).replace(/\s+/g, ' ');
      check(
        `${tag} two boundaries and a contract are drawn`,
        count.trim() === '2 boundaries · 1 contract',
        count,
      );
      check(`${tag} the Map never scrolls sideways`, !(await sideways()));

      /* ---------------------------------------------------------- propose -- */
      await press(human, 'Propose ADR', '.arch-actions');
      await human.waitForSelector(PANEL, { visible: true });
      await fill(human, 'Title', 'Retry jobs through a queue');
      await writeRich(human, 'Webhooks fail, and a person should not have to re-send them.');
      await pressInPanel(human, 'Propose ADR');
      await human.waitForSelector(PANEL, { hidden: true });
      await human.waitForSelector('.arch-open', { visible: true });

      /* ----------------------------------------------------------- filled -- */
      const all = await human.evaluate(() => ({
        tab: document.querySelector('[role=tab][aria-selected=true]')?.textContent,
        page: document.querySelector('.arch-page')?.textContent.includes('Principles') ?? false,
        adr:
          document
            .querySelector('.arch-open')
            ?.textContent.includes('Retry jobs through a queue') ?? false,
      }));
      check(
        `${tag} the proposed ADR is in the ledger beside the charter`,
        all.tab === 'Charter' && all.page && all.adr,
        all,
      );
      await human.screenshot({ path: `${OUT()}/architecture-filled-charter-${width}.png` });
      await tab('Map');
      if (width === 1440) await human.waitForSelector('.map-node', { visible: true });
      check(`${tag} nothing scrolls sideways once the radar is filled`, !(await sideways()));
      await human.screenshot({ path: `${OUT()}/architecture-filled-${width}.png` });
    } catch (error) {
      // Which screen and which refusal, for whoever reads the failure.
      await human
        .screenshot({ path: `${OUT()}/architecture-authoring-failed-${width}.png` })
        .catch(() => null);
      const alerts = await human
        .evaluate(() => [...document.querySelectorAll('[role=alert]')].map((a) => a.textContent))
        .catch(() => []);
      throw new Error(`${String(error)} ${JSON.stringify(alerts)}`);
    } finally {
      await context.close();
      await api(seeded, `/api/radars/${radar.id}`, 'DELETE').catch(() => null);
    }
  }
  return { checks, failures, notes: [] };
}

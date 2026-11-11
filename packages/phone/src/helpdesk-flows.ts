/**
 * The helpdesk conversation in a real browser (docs/HELPDESK.md §7), at 390 and
 * at a desktop width.
 *
 * The seed leaves one request with an internal note, a released reply and a
 * collaborator's draft waiting for the owner. What has to be true on screen:
 *
 * - the two outward states are labelled and the note is not;
 * - the owner's release bar is on screen and its buttons take their own clicks
 *   (`elementFromPoint`, not geometry — the board has lost clicks to paint
 *   order before);
 * - the composer offers both choices at once, inside the dialog, and says what
 *   "reply to client" will do before anything is sent;
 * - nothing scrolls sideways;
 * - Release actually releases: the draft becomes a reply to the client.
 *
 * And slice 3, the client portal (§3.4, §6):
 *
 * - a portal request's card leads with its requester, not the owner, and shows
 *   the ball-in-court clock, both painted where they are (elementFromPoint);
 * - the Helpdesk's Client portal tab names the connected portal and offers
 *   Disconnect on screen, without sideways scroll;
 * - Settings → Integrations lists the portal with its token's last use.
 *
 * And slice 4, events (§5.4): the portal's row says it pulls events and offers
 * "Add receiver", whose dialog fits the phone.
 */
import type { Page } from 'puppeteer-core';
import { PHONE, shot } from './harness.js';
import { PORTAL_REQUEST, type Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

const REQUEST = 'Contact form sends twice';

export async function runHelpdeskFlows(
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
  const radar = seeded.radars.find((r) => r.template === 'helpdesk');
  if (!radar) {
    check('[helpdesk] the seed has a helpdesk radar', false);
    return { checks, failures, notes };
  }

  for (const width of [390, 1280]) {
    const at = `[helpdesk ${width}]`;
    await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await page.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
    const bodies = await page.$$('.board-card .blip-body');
    let opened = false;
    try {
      for (const body of bodies) {
        if (
          await body.evaluate(
            (node, title) => node.closest('.board-card')?.textContent.includes(title) === true,
            REQUEST,
          )
        ) {
          await body.click();
          opened = true;
          break;
        }
      }
    } finally {
      await Promise.all(bodies.map((body) => body.dispose()));
    }
    check(`${at} a native request body click opens its conversation`, opened);
    if (!opened) continue;
    await page.waitForFunction(
      () => document.querySelectorAll('[role=dialog] li.comment').length >= 3,
      { timeout: 20_000 },
    );

    const seen = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[role=dialog]');
      const tags = [...(dialog?.querySelectorAll('.visibility-tag') ?? [])].map(
        (el) => el.textContent,
      );
      const unmarked = [...(dialog?.querySelectorAll('li.comment') ?? [])].filter(
        (li) => !li.classList.contains('is-client') && !li.classList.contains('is-pending'),
      ).length;
      const hits = (selector: string) =>
        [...(dialog?.querySelectorAll<HTMLElement>(selector) ?? [])].map((el) => {
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const panel = dialog?.getBoundingClientRect();
          return {
            text: el.textContent.trim(),
            hit: hit === el || el.contains(hit),
            inside: panel
              ? r.left >= panel.left - 1 && r.right <= panel.right + 1 && r.width > 0
              : false,
          };
        });
      return {
        tags,
        unmarked,
        fullReader:
          dialog?.classList.contains('max-w-6xl') === true &&
          dialog.querySelector('.kanban-detail') !== null,
        panelWidth: dialog?.getBoundingClientRect().width ?? 0,
        release: hits('.release-bar button'),
        switch: hits('.composer-visibility [role=radio]'),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : null,
      };
    });
    notes.push({ what: `helpdesk conversation at ${width}`, ...seen });
    check(
      `${at} native body opens the shared wide full reader`,
      seen.fullReader && seen.panelWidth >= (width === 390 ? 388 : 900),
      { fullReader: seen.fullReader, panelWidth: seen.panelWidth },
    );
    check(
      `${at} a released reply and a draft are labelled; the internal note is not`,
      seen.tags.includes('to client') &&
        seen.tags.includes('draft · awaiting review') &&
        seen.unmarked >= 1,
      seen.tags,
    );
    check(
      `${at} the owner's Release and Discard are on screen and take their own clicks`,
      seen.release.length === 2 && seen.release.every((b) => b.hit && b.inside),
      seen.release,
    );
    check(
      `${at} the composer shows internal note and reply to client side by side`,
      seen.switch.length === 2 && seen.switch.every((b) => b.hit && b.inside),
      seen.switch,
    );
    check(
      `${at} nothing scrolls sideways`,
      seen.pageOverflow <= 1 && (seen.dialogOverflow ?? 0) <= 1,
      seen,
    );

    // "Reply to client" says what it will do before anything is sent.
    await page.evaluate(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] [role=radio]')]
        .find((b) => b.textContent.trim() === 'reply to client')
        ?.click();
    });
    const hint = await page
      .waitForSelector('[role=dialog] .composer-visibility-hint', { timeout: 5_000 })
      .then((el) => el?.evaluate((node) => node.textContent))
      .catch(() => null);
    check(
      `${at} choosing reply to client says it goes out as written, before sending`,
      typeof hint === 'string' && /as written/.test(hint),
      hint,
    );
    await shot(page, outDir, `helpdesk-conversation-${width}`);

    if (width === 1280) {
      // Release, and see the draft become a reply to the client.
      await page.evaluate(() => {
        [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] .release-bar button')]
          .find((b) => b.textContent.trim() === 'Release to client')
          ?.click();
      });
      const released = await page
        .waitForFunction(
          () =>
            !document.querySelector('[role=dialog] .release-bar') &&
            document.querySelectorAll('[role=dialog] li.comment.is-client').length === 2,
          { timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false);
      check(`${at} Release turns the draft into a reply to the client`, released);
      await shot(page, outDir, `helpdesk-released-${width}`);
    }
    await page.keyboard.press('Escape');
  }
  await runPortalChecks(page, outDir, seeded, radar.id, check, notes);
  return { checks, failures, notes };
}

async function runPortalChecks(
  page: Page,
  outDir: string,
  seeded: Seeded,
  radarId: string,
  check: (name: string, ok: boolean, detail?: unknown) => void,
  notes: unknown[],
): Promise<void> {
  for (const width of [390, 1280]) {
    // Preserve the portal requester and waiting clock in compact cards at both widths.
    await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await page.goto(`${seeded.baseUrl}/radar/${radarId}`, { waitUntil: 'networkidle2' });
    if (width === 390) {
      const lanes = await page.$$('.board-pager-lane');
      try {
        for (const lane of lanes) {
          if (
            await lane.evaluate(
              (node) => node.firstChild?.textContent?.trim() === 'Waiting on client',
            )
          ) {
            await lane.click();
            break;
          }
        }
      } finally {
        await Promise.all(lanes.map((lane) => lane.dispose()));
      }
    }
    await page.waitForSelector('[data-facet="requester"]', { visible: true, timeout: 20_000 });
    const card = await page.evaluate((title) => {
      const el = [...document.querySelectorAll<HTMLElement>('.board-card')].find((c) =>
        c.textContent.includes(title),
      );
      const painted = (selector: string) => {
        const node = el?.querySelector<HTMLElement>(selector);
        if (!node) return null;
        node.scrollIntoView({ block: 'center' });
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + Math.min(8, r.width / 2),
          r.top + r.height / 2,
        );
        return { text: node.textContent.trim(), painted: hit === node || node.contains(hit) };
      };
      return {
        found: Boolean(el),
        requester: painted('[data-facet="requester"]'),
        clock: painted('[data-facet="awaiting-client"]'),
        ownerByline: el?.textContent.includes('Owner Okonkwo') ?? null,
      };
    }, PORTAL_REQUEST);
    notes.push({ what: `portal request card at ${width}`, ...card });
    check(
      `[portal ${width}] a portal request leads with its requester, painted, not the owner`,
      card.found &&
        card.requester?.text === 'from Pat Client · via portal' &&
        card.requester.painted &&
        card.ownerByline === false,
      card,
    );
    check(
      `[portal ${width}] the card shows how long it has waited on the client`,
      Boolean(card.clock?.painted && card.clock.text.startsWith('waiting on client · ')),
      card.clock,
    );
    await shot(page, outDir, `portal-card-${width}`);

    const bodies = await page.$$('.board-card .blip-body');
    try {
      for (const body of bodies) {
        if (
          await body.evaluate(
            (node, title) => node.closest('.board-card')?.textContent.includes(title) === true,
            PORTAL_REQUEST,
          )
        ) {
          await body.click();
          break;
        }
      }
    } finally {
      await Promise.all(bodies.map((body) => body.dispose()));
    }
    await page.waitForSelector('[role="dialog"] .kanban-detail', {
      visible: true,
      timeout: 20_000,
    });
    const popup = await page.evaluate(() => ({
      requester: document
        .querySelector('[role="dialog"] [data-facet="requester"]')
        ?.textContent.trim(),
      clock: document
        .querySelector('[role="dialog"] [data-facet="awaiting-client"]')
        ?.textContent.trim(),
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      modalOverflow: (() => {
        const modal = document.querySelector<HTMLElement>('[role="dialog"]');
        return modal ? modal.scrollWidth - modal.clientWidth : null;
      })(),
    }));
    check(
      `[portal ${width}] full reader preserves requester and clock without horizontal overflow`,
      popup.requester === 'from Pat Client · via portal' &&
        popup.clock?.startsWith('waiting on client · ') === true &&
        popup.pageOverflow <= 1 &&
        popup.modalOverflow !== null &&
        popup.modalOverflow <= 1,
      popup,
    );
    await shot(page, outDir, `helpdesk-requester-popup-${width}`);
    await page.click('[role="dialog"] button[aria-label="Close"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), {
      timeout: 20_000,
    });
  }

  for (const width of [390, 1280]) {
    const at = `[portal ${width}]`;
    await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await page.goto(`${seeded.baseUrl}/radar/${radarId}/settings?section=portal`, {
      waitUntil: 'networkidle2',
    });
    const tab = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('button')].some(
            (b) => b.textContent.trim() === 'Disconnect',
          ),
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
    const seen = await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent.trim() === 'Disconnect',
      );
      let hit = false;
      if (button) {
        button.scrollIntoView({ block: 'center' });
        const r = button.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hit = at === button || button.contains(at);
      }
      const activeEl = document.querySelector<HTMLElement>('.section-tab.is-active');
      const tabBox = activeEl?.getBoundingClientRect();
      const tabHit = tabBox
        ? document.elementFromPoint(tabBox.left + tabBox.width / 2, tabBox.top + tabBox.height / 2)
        : null;
      return {
        activeTabPainted: Boolean(
          activeEl && tabHit && (tabHit === activeEl || activeEl.contains(tabHit)),
        ),
        activeTab: activeEl?.textContent.trim() ?? null,
        names: document.body.textContent.includes('W&W portal'),
        website: document.body.textContent.includes('website site-phone'),
        disconnectHit: hit,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    notes.push({ what: `client portal tab at ${width}`, ...seen });
    check(
      `${at} the Helpdesk's Client portal tab names the connected portal and its website`,
      tab && seen.names && seen.website && Boolean(seen.activeTab?.match(/Portal|Client portal/)),
      seen,
    );
    check(`${at} the active Client portal tab is scrolled into view`, seen.activeTabPainted, seen);
    check(`${at} Disconnect is on screen and takes its own click`, seen.disconnectHit, seen);
    check(`${at} the Client portal tab does not scroll sideways`, seen.overflow <= 1, seen);
    await shot(page, outDir, `portal-tab-${width}`);

    await page.goto(`${seeded.baseUrl}/settings/connections`, { waitUntil: 'networkidle2' });
    const listed = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[data-integration]')].some((el) =>
            el.textContent.includes('W&W portal'),
          ),
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
    const settings = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-integration]');
      return {
        lastUsed: row?.textContent.includes('last used') ?? false,
        reaches: row?.textContent.includes('website site-phone') ?? false,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    notes.push({ what: `settings integrations at ${width}`, ...settings });
    check(
      `${at} Settings → Integrations lists the portal, its token's last use and what it reaches`,
      listed && settings.lastUsed && settings.reaches,
      settings,
    );
    check(`${at} Settings does not scroll sideways`, settings.overflow <= 1, settings);

    // Slice 4: the row says the portal pulls events, and offers a receiver.
    const events = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('[data-integration] [data-delivery]');
      const button = [...(block?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (b) => b.textContent.trim() === 'Add receiver',
      );
      let hit = false;
      if (button) {
        button.scrollIntoView({ block: 'center' });
        const r = button.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hit = at === button || button.contains(at);
      }
      return {
        mode: block?.getAttribute('data-delivery') ?? null,
        says: block?.textContent.includes('The portal pulls events') ?? false,
        addHit: hit,
      };
    });
    notes.push({ what: `settings events at ${width}`, ...events });
    check(
      `${at} the portal's Events say it pulls them, and Add receiver takes its own click`,
      events.mode === 'pull' && events.says && events.addHit,
      events,
    );
    await page.evaluate(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[data-delivery] button')]
        .find((b) => b.textContent.trim() === 'Add receiver')
        ?.click();
    });
    const dialog = await page
      .waitForSelector('input[aria-label="Receiver URL"]', { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const field = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Receiver URL"]');
      const r = input?.getBoundingClientRect();
      const at = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        painted: Boolean(input && at && (at === input || input.contains(at))),
        inside: Boolean(r && r.left >= 0 && r.right <= innerWidth),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    notes.push({ what: `receiver dialog at ${width}`, ...field });
    check(
      `${at} the receiver dialog's URL field is on screen and inside the viewport`,
      dialog && field.painted && field.inside && field.overflow <= 1,
      field,
    );
    await shot(page, outDir, `receiver-dialog-${width}`);
    await page.keyboard.press('Escape');
  }
}

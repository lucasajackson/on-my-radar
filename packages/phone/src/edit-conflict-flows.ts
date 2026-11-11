/** A stale browser save must not overwrite a newer agent edit (eval 2026-11-01, trials 1 and 2). */
import type { Page } from 'puppeteer-core';
import type { BlipDto, BlipRevisionDto, RadarDto } from '@onmyradar/contract';
import { PHONE, IOS_UA, PATIENCE_MS } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runEditConflictFlows(page: Page, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  // Another writer, through the same service the MCP update_blip tool wraps.
  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (!response.ok) throw new Error(`Edit conflict ${method} ${path}: HTTP${response.status}`);
    return (await response.json()) as T;
  };
  const stored = async (id: string) => (await call<{ blip: BlipDto }>(`/api/blips/${id}`)).blip;

  for (const width of [390, 1440]) {
    const tag = `[edit conflict ${width}]`;
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    try {
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
      const { radar } = await call<{ radar: RadarDto }>('/api/radars', 'POST', {
        name: `edit conflict scratch ${width}`,
        template: 'kanban',
      });
      const { blip } = await call<{ blip: BlipDto }>(`/api/radars/${radar.id}/blips`, 'POST', {
        body: 'Original words',
      });
      const dialog = '[role="dialog"]';
      const field = `${dialog} textarea[id="body-${blip.id}"]`;
      const press = (label: string) =>
        human.evaluate((text) => {
          const found = [...document.querySelectorAll('[role="dialog"] button')].find(
            (b) => b.textContent.trim() === text,
          );
          if (!(found instanceof HTMLElement)) throw new Error('Synthetic button unavailable');
          found.click();
        }, label);
      const typeDraft = async (text: string) => {
        await human.click(`${dialog} button[title="Edit"]`);
        await human.waitForSelector(field, { visible: true });
        await human.$eval(field, (node) => (node as HTMLTextAreaElement).select());
        await human.keyboard.type(text);
      };
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await human.click(`.board-card [data-blip-id="${blip.id}"] .blip-body`);
      await human.waitForSelector(dialog, { visible: true });

      // Trials 1 and 2: type at revision N, an agent writes N+1, save, then overwrite on request.
      let revision = blip.revision;
      for (const trial of [1, 2]) {
        const draft = `Browser draft ${trial} at ${width}`;
        const agent = `Agent newer ${trial} at ${width}`;
        await typeDraft(draft);
        await call(`/api/blips/${blip.id}`, 'PATCH', { body: agent, expectedRevision: revision });
        if (trial === 1) {
          // The 15 s poll moves the open card's revision under the editor; the draft must survive it.
          await human.waitForResponse(
            (r) =>
              r.request().method() === 'GET' && r.url().includes(`/api/radars/${radar.id}/blips`),
            { timeout: 20_000 },
          );
        }
        await press('Save');
        await human.waitForSelector(`${dialog} [role="alert"]`, { visible: true });
        const seen = await human.evaluate(
          (sel, f) => {
            const box = document.querySelector(sel)?.getBoundingClientRect();
            return {
              text: document.querySelector(sel)?.textContent ?? '',
              draft: (document.querySelector(f) as HTMLTextAreaElement).value,
              contained: !!box && box.left >= 0 && box.right <= innerWidth && box.width > 0,
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
            };
          },
          `${dialog} [role="alert"]`,
          field,
        );
        const kept = await stored(blip.id);
        await press('Save mine over it');
        await human.waitForSelector(field, { hidden: true });
        const saved = await stored(blip.id);
        const { revisions } = await call<{ revisions: BlipRevisionDto[] }>(
          `/api/blips/${blip.id}/revisions`,
        );
        check(
          `${tag} trial ${trial}: panel shows theirs and the draft stays, agent text kept until overwrite, overwrite lands N+2, agent text recoverable`,
          seen.text.includes(agent) &&
            seen.draft === draft &&
            seen.contained &&
            !seen.overflow &&
            kept.body === agent &&
            kept.revision === revision + 1 &&
            saved.body === draft &&
            saved.revision === revision + 2 &&
            revisions.some((r) => r.priorBody === agent),
          { seen, kept: kept.revision, saved: saved.revision },
        );
        revision = saved.revision;
      }

      // Only metadata moved (a pin stands in for a claim renewal): no panel, saved first time.
      await typeDraft(`Quiet draft at ${width}`);
      await call(`/api/blips/${blip.id}`, 'PATCH', { pinned: true });
      await press('Save');
      await human.waitForSelector(field, { hidden: true });
      const quiet = await stored(blip.id);
      check(
        `${tag} metadata-only change saves with no conflict`,
        quiet.body === `Quiet draft at ${width}` && quiet.pinned,
        quiet.revision,
      );
    } finally {
      await context.close();
    }
  }
  return { checks, failures, notes: [] };
}

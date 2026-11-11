/** A card is assigned to a person and then an agent from the browser; the board shows it and a reload keeps it. */
import type { Page } from 'puppeteer-core';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { PATIENCE_MS } from './harness.js';
import { viewerLogin } from './kanban-popup.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runAssignFlows(page: Page, seeded: Seeded): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (!response.ok) throw new Error(`Assign ${method} ${path}: HTTP${response.status}`);
    return (await response.json()) as T;
  };
  let agentId: string | null = null;
  const context = await page.browser().createBrowserContext();
  const human = await context.newPage();
  try {
    human.setDefaultTimeout(PATIENCE_MS);
    await human.setViewport({ width: 1280, height: 900 });
    await context.setCookie({
      name: 'omr_session',
      value: seeded.ownerCookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    const email = 'assign-flow-teammate@example.test';
    await viewerLogin(seeded.baseUrl, email);
    const { radar } = await call<{ radar: RadarDto }>('/api/radars', 'POST', {
      name: 'assign scratch',
      template: 'kanban',
    });
    await call(`/api/radars/${radar.id}/members`, 'POST', { email, role: 'editor' });
    const { agent } = await call<{ agent: { id: string } }>('/api/repo-agents', 'POST', {
      name: 'Assignable Agent',
    });
    agentId = agent.id;
    const { blip } = await call<{ blip: BlipDto }>(`/api/radars/${radar.id}/blips`, 'POST', {
      body: 'Card to assign',
    });
    const chip = `.board-card [data-blip-id="${blip.id}"] [data-assignee]`;
    const pickFrom = async (option: string, text: string) => {
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await human.click(`.board-card [data-blip-id="${blip.id}"] .blip-body`);
      await human.waitForSelector('[role="dialog"]', { visible: true });
      await human.evaluate(() => {
        const found = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
          /^(Assign|Reassign)$/.test(b.textContent.trim()),
        );
        if (!(found instanceof HTMLElement)) throw new Error('Synthetic assign button unavailable');
        found.click();
      });
      await human.waitForSelector(`[data-assign-option="${option}"]`, { visible: true });
      await human.evaluate(
        (kind, needle) => {
          const found = [...document.querySelectorAll(`[data-assign-option="${kind}"]`)].find((b) =>
            b.textContent.includes(needle),
          );
          if (!(found instanceof HTMLElement)) throw new Error('Synthetic assignee unavailable');
          found.click();
        },
        option,
        text,
      );
      await human.waitForSelector(`${chip}[data-assignee="${option}"]`, { visible: true });
    };
    const holderAfterReload = async () => {
      await human.reload({ waitUntil: 'networkidle2' });
      await human.waitForSelector(chip, { visible: true });
      return human.$eval(chip, (node) => node.getAttribute('data-assignee'));
    };
    const stored = async () => (await call<{ blip: BlipDto }>(`/api/blips/${blip.id}`)).blip;

    await pickFrom('person', email);
    const person = await stored();
    check(
      'assign: a person from the card detail shows on the board and survives a reload',
      Boolean(person.assignee?.userId) &&
        !person.assignee?.agentId &&
        (await holderAfterReload()) === 'person',
      person.assignee,
    );
    await pickFrom('agent', 'Assignable Agent');
    const held = await stored();
    check(
      'assign: an agent replaces the person, shows the agent badge, and survives a reload',
      held.assignee?.agentId === agent.id &&
        !held.assignee.userId &&
        (await holderAfterReload()) === 'agent',
      held.assignee,
    );
  } finally {
    // The agents flow asserts the owner's repo is empty; leave it that way.
    if (agentId)
      await fetch(`${seeded.baseUrl}/api/repo-agents/${agentId}`, {
        method: 'DELETE',
        headers: { cookie: seeded.ownerCookie },
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
    await context.close();
  }
  return { checks, failures, notes: [] };
}

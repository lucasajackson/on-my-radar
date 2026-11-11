/** Due dates and personal notification choices against the real scratch API. */
import type { Page } from 'puppeteer-core';
import type { BlipDto, NotificationSettingsDto } from '@onmyradar/contract';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';
import { shot, PHONE, must } from './harness.js';

export async function runDueNotifications(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const button = async (name: string) => {
    for (const item of await page.$$('button'))
      if (
        await item.evaluate(
          (e, label) =>
            e.getClientRects().length > 0 &&
            !e.closest('[inert]') &&
            (e.getAttribute('aria-label') ?? e.textContent).trim() === label,
          name,
        )
      ) {
        await item.click();
        return;
      }
    throw new Error(`Missing button ${name}`);
  };
  await page.setViewport(PHONE);
  const dueAt = new Date(Date.now() + 7 * 86400000).toISOString();
  let first: BlipDto | undefined;
  for (const radar of seeded.radars) {
    const { blip } = await request<{ blip: BlipDto }>(`/api/radars/${radar.id}/blips`, 'POST', {
      body: `Due QA ${radar.template}`,
      dueAt,
    });
    first ??= blip;
    await page.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector(`[data-blip-id="${blip.id}"] .due-chip`);
    check(
      `shared due date visible in ${radar.template}`,
      await page.$eval(`[data-blip-id="${blip.id}"] .due-chip`, (e) =>
        e.textContent.includes('Due'),
      ),
    );
  }
  const published = must(seeded.published[0]);
  await page.goto(`${seeded.baseUrl}/r/${published.slug}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.due-chip');
  check('public radar shows shared due date', Boolean(await page.$('.due-chip')));
  check(
    'public radar omits personal reminder controls',
    !(await page.$(
      'button[aria-label="Personal reminder"],button[aria-label="Due date and reminder"],button[aria-label="Set due date"]',
    )),
  );
  if (!first) throw new Error('No seeded radars');
  await page.goto(`${seeded.baseUrl}/radar/${first.radarId}`, { waitUntil: 'networkidle2' });
  await page.click(`[data-blip-id="${first.id}"] button[aria-label="Due date and reminder"]`);
  await page.waitForSelector('.modal-panel input[type="datetime-local"]');
  await page.click('.modal-panel input[type="checkbox"]');
  await button('Save');
  await page.waitForSelector('.modal-panel', { hidden: true });
  const reminder = await request<{ reminder: { status: string; leadMinutes: number } }>(
    `/api/blips/${first.id}/reminder`,
  );
  check(
    'explicit Remind me schedules a personal reminder',
    reminder.reminder.status === 'scheduled' && reminder.reminder.leadMinutes === 0,
    reminder,
  );
  await page.click(`[data-blip-id="${first.id}"] button[aria-label="Due date and reminder"]`);
  await page.waitForSelector('.modal-panel');
  await page.evaluate(async () => {
    await Promise.all(
      document
        .querySelector('.modal-panel')
        ?.getAnimations()
        .map((a) => a.finished.catch(() => undefined)) ?? [],
    );
  });
  await shot(page, outDir, 'due-reminder-phone');
  await button('Clear due date');
  await button('Save');
  await page.waitForSelector('.modal-panel', { hidden: true });
  const paused = await request<{ reminder: { status: string; reason: string } }>(
    `/api/blips/${first.id}/reminder`,
  );
  check(
    'clearing shared date retains personal consent as paused',
    paused.reminder.status === 'paused' && paused.reminder.reason === 'no_due_date',
    paused,
  );
  // Force the linked target beyond the default first page without changing its timestamp.
  for (let i = 0; i < 55; i++)
    await request(`/api/radars/${first.radarId}/blips`, 'POST', {
      body: `Deep link paging filler ${i}`,
    });
  await page.goto(`${seeded.baseUrl}/radar/${first.radarId}?blip=${first.id}`, {
    waitUntil: 'networkidle2',
  });
  await page.waitForSelector(`.modal-panel [data-blip-id="${first.id}"]`);
  check(
    'notification opens exact blip beyond the first page',
    Boolean(await page.$(`.modal-panel [data-blip-id="${first.id}"]`)),
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-panel', { hidden: true });
  check(
    'closing linked blip clears URL without reopening',
    !new URL(page.url()).searchParams.has('blip'),
  );
  const movedTo = must(seeded.radars.find((r) => r.id !== first.radarId));
  await request(`/api/blips/${first.id}`, 'PATCH', { radarId: movedTo.id });
  await page.goto(`${seeded.baseUrl}/radar/${first.radarId}?blip=${first.id}`, {
    waitUntil: 'networkidle2',
  });
  await page.waitForSelector(`.modal-panel [data-blip-id="${first.id}"]`);
  check(
    'notification resolves current radar after filing',
    await page.$eval('.modal-panel', (e) => e.textContent.includes('This blip is now in')),
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-panel', { hidden: true });
  const deleted = await fetch(`${seeded.baseUrl}/api/blips/${first.id}`, {
    method: 'DELETE',
    headers: { cookie: seeded.ownerCookie },
  });
  if (!deleted.ok) throw new Error('Could not delete linked fixture');
  await page.goto(`${seeded.baseUrl}/radar/${first.radarId}?blip=${first.id}`, {
    waitUntil: 'networkidle2',
  });
  await page.waitForFunction(() =>
    document.querySelector('.modal-panel')?.textContent.includes('no longer available'),
  );
  check(
    'deleted notification target has an honest unavailable state',
    !(await page.$(`.modal-panel [data-blip-id="${first.id}"]`)),
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-panel', { hidden: true });
  await page.goto(`${seeded.baseUrl}/settings/notifications`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[aria-label="Incoming email by email"]');
  await page.click('input[aria-label="Incoming email by email"]');
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[aria-label="Incoming email by email"]')
        ?.checked === true &&
      !document.querySelector<HTMLInputElement>('input[aria-label="Incoming email by email"]')
        ?.disabled,
  );
  // Partial: this is the server's answer under test, and a missing field must
  // fail the check below rather than throw and end the run.
  const preferences = await request<Partial<NotificationSettingsDto>>(
    '/api/notifications/settings',
  );
  check(
    'per-kind preference persists independently',
    preferences.kindPreferences?.email_received.email === true &&
      preferences.kindPreferences.due.email === false,
  );
  check(
    'this browser never claims connected without server confirmation',
    !(await page.evaluate(() =>
      document.body.textContent.includes('Connected and ready for notifications.'),
    )),
  );
  await (await page.$('.notification-browser'))?.scrollIntoView();
  await shot(page, outDir, 'notification-browser-phone');
  const events = await page.$('.notification-events');
  await events?.scrollIntoView();
  await shot(page, outDir, 'notification-preferences-phone');
  check(
    'notification preferences fit the phone viewport',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  return { checks, failures, notes: [] };
}

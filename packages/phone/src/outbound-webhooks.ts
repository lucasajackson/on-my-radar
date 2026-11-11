/**
 * Outbound webhook subscriptions, driven through the real settings pane.
 *
 * The server suite already proves the delivery machinery — signing, retries,
 * access rechecks. What only a browser can prove is the part the feature
 * request asked for by name: that the pane does not confuse the two directions
 * ("webhook" was already taken by ingress), and that the signing secret is
 * shown once and never read back.
 *
 * The receiver is deliberately on `.invalid` (RFC 2606), a name that never
 * resolves. A private address such as 127.0.0.1 is now refused when the
 * subscription is saved, but a name that does not resolve yet is accepted (the
 * transport re-checks on every delivery), so this one saves and then fails on
 * every attempt. That gives a real failed delivery to assert the history
 * against without standing up a receiver.
 */
import type { Page } from 'puppeteer-core';
import type { SubscriptionDto } from '@onmyradar/contract';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';
import { shot, PHONE, must } from './harness.js';

const RECEIVER = 'https://receiver.onmyradar-phone.invalid/portal/hooks';

export async function runOutboundWebhooks(
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
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  /** Click by accessible name, optionally scoped to the open dialog. */
  const button = async (name: string, dialog = false) => {
    await page.waitForFunction(
      (label: string, scoped: boolean) => {
        const root = scoped ? document.querySelector('[role="dialog"]') : document;
        return Boolean(
          root &&
          [...root.querySelectorAll('button')].some(
            (b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === label && !b.disabled,
          ),
        );
      },
      {},
      name,
      dialog,
    );
    await page.evaluate(
      (label: string, scoped: boolean) => {
        const root = scoped ? document.querySelector('[role="dialog"]') : document;
        const target = [...(root?.querySelectorAll('button') ?? [])].find(
          (b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === label,
        );
        if (!target) throw new Error(`Missing button ${label}`);
        target.click();
      },
      name,
      dialog,
    );
  };
  const secretField = async (): Promise<string> => {
    await page.waitForSelector('[aria-label="Signing secret"]');
    return page.$eval('[aria-label="Signing secret"]', (e) => (e as HTMLInputElement).value);
  };

  await page.setViewport(PHONE);
  const radar = seeded.radars[0];
  if (!radar) throw new Error('No seeded radars');

  /* ------------------------------------------------------------ the pane --- */

  await page.goto(`${seeded.baseUrl}/radar/${radar.id}/settings?section=webhooks`, {
    waitUntil: 'networkidle2',
  });
  await page.waitForFunction(() => document.body.textContent.includes('Outbound webhooks'));
  check(
    'settings names both webhook directions separately',
    await page.evaluate(() => {
      const text = document.body.textContent;
      return text.includes('Inbound webhooks') && text.includes('Outbound webhooks');
    }),
  );

  /* ---------------------------------------------------------- create it --- */

  await button('New subscription');
  await page.waitForSelector('[role="dialog"] input[type="url"]');
  await page.type('[role="dialog"] input:not([type])', 'Customer portal');
  await page.type('[role="dialog"] input[type="url"]', RECEIVER);
  await shot(page, outDir, 'outbound-webhook-create-phone');
  await button('Create subscription', true);

  const created = await secretField();
  check('the signing secret is shown once, in full', created.startsWith('omr_whsec_'), {
    length: created.length,
  });
  const listed = await request<{ subscriptions: SubscriptionDto[] }>(
    `/api/radars/${radar.id}/subscriptions`,
  );
  check(
    'reading a subscription back never returns its secret',
    listed.subscriptions.length === 1 && !('secret' in must(listed.subscriptions[0])),
    listed.subscriptions[0],
  );
  await button('I have saved it');

  /* ------------------------------------------------- a refused delivery --- */

  await button('Send test');
  // The failure is the point: the creator can see an undeliverable receiver
  // without asking anybody.
  await page.waitForFunction(() =>
    document.querySelector('[role="dialog"]')?.textContent.includes('Connection failed'),
  );
  check(
    'delivery history records the refused attempt against the event id',
    await page.evaluate(() => {
      const text = document.querySelector('[role="dialog"]')?.textContent ?? '';
      return (
        text.includes('subscription.test') && text.includes('attempt 1') && text.includes('evt_')
      );
    }),
  );
  await shot(page, outDir, 'outbound-webhook-history-phone');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { hidden: true });

  /* ------------------------------------------------------------- rotate --- */

  await button('Rotate secret');
  await button('Rotate secret', true);
  const rotated = await secretField();
  check(
    'rotation mints a different secret',
    rotated !== created && rotated.startsWith('omr_whsec_'),
  );
  await button('I have saved it');

  /* --------------------------------------------------------- pause/resume --- */

  await button('Pause');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Resume'),
  );
  check(
    'a paused subscription says so and offers to resume',
    await page.evaluate(() => document.body.textContent.includes('Paused')),
  );
  await shot(page, outDir, 'outbound-webhook-settings-phone');
  check(
    'the outbound pane fits the phone viewport',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  await button('Resume');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Pause'),
  );

  /* ------------------------------------------------------------- delete --- */

  await button('Delete');
  await button('Delete subscription', true);
  await page.waitForFunction(() =>
    document.body.textContent.includes('No outbound subscriptions yet.'),
  );
  const empty = await request<{ subscriptions: SubscriptionDto[] }>(
    `/api/radars/${radar.id}/subscriptions`,
  );
  check('deleting removes the subscription server-side too', empty.subscriptions.length === 0);

  /* ------------------------------------------------------- the drop box --- */

  /*
   * The drop box refuses an ingest URL (DESIGN.md §6.2) but has blips to
   * report, so it gets the outbound half of the pane and not the inbound half.
   * That asymmetry is easy to regress into "no webhooks section at all", which
   * is what the rule used to say.
   */
  await page.goto(`${seeded.baseUrl}/radar/${seeded.dropBoxId}/settings?section=webhooks`, {
    waitUntil: 'networkidle2',
  });
  await page.waitForFunction(() => document.body.textContent.includes('Outbound webhooks'));
  check(
    'the drop box offers outbound events without an inbound URL',
    await page.evaluate(() => !document.body.textContent.includes('Inbound webhooks')),
  );

  return { checks, failures, notes: [] };
}

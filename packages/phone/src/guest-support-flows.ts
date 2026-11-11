/** Real served guest support, with only synthetic scratch-account credentials. */
import type { Page } from 'puppeteer-core';
import type { GuestSupportThreadDto } from '@onmyradar/contract';
import { PHONE, must } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

async function staff<T>(
  seeded: Seeded,
  path: string,
  cookie: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(seeded.baseUrl + path, {
    method: body === undefined ? 'GET' : method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Scratch support API ${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

export async function supportQueue(seeded: Seeded): Promise<{ radarId: string; ownerId: string }> {
  const radar = must(seeded.radars.find((item) => item.template === 'helpdesk'));
  const { user } = await staff<{ user: { id: string; isAdmin: boolean } }>(
    seeded,
    '/api/auth/session',
    seeded.ownerCookie,
  );
  const result = await staff<{
    radar: { ownerId: string; template: string; publicSlug: string | null; kind: string };
  }>(seeded, `/api/radars/${radar.id}`, seeded.ownerCookie);
  if (
    !user.isAdmin ||
    result.radar.ownerId !== user.id ||
    result.radar.template !== 'helpdesk' ||
    result.radar.kind !== 'standard' ||
    result.radar.publicSlug
  )
    throw new Error('Scratch support queue must be an owned private standard helpdesk');
  return { radarId: radar.id, ownerId: user.id };
}

async function mateCookie(seeded: Seeded): Promise<string> {
  const email = 'mate@example.test';
  const response = await fetch(`${seeded.baseUrl}/api/auth/request-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) throw new Error(`Scratch staff login: ${response.status}`);
  const { devCode } = (await response.json()) as { devCode?: string };
  if (!devCode) throw new Error('Scratch staff requires documented no-mail development login');
  const challenge = response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
  const verified = await fetch(`${seeded.baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: { cookie: challenge, 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: devCode }),
  });
  if (!verified.ok) throw new Error(`Scratch staff verification: ${verified.status}`);
  return verified.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
}

async function click(page: Page, text: string) {
  const buttons = await page.$$('button');
  for (const button of buttons) {
    if (await button.evaluate((item, target) => item.textContent.trim() === target, text)) {
      await button.click();
      return;
    }
  }
  throw new Error(`Guest support action missing: ${text}`);
}
async function field(page: Page, label: string, value: string) {
  const labels = await page.$$('label');
  for (const item of labels) {
    if (
      await item.evaluate(
        (element, target) => element.querySelector('span')?.textContent.trim() === target,
        label,
      )
    ) {
      const input = must(await item.$('input,textarea'));
      await input.click();
      await input.type(value);
      return;
    }
  }
  throw new Error(`Guest support field missing: ${label}`);
}
async function contains(page: Page, text: string) {
  await page.waitForFunction((value) => document.body.textContent.includes(value), {}, text);
}
async function shot(page: Page, outDir: string, name: string) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

async function controlGeometry(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector('main');
    const targets = [...(surface?.querySelectorAll('button,input,textarea,a[href]') ?? [])]
      .map((element) => element.getBoundingClientRect())
      .filter((bounds) => bounds.width > 0 && bounds.height > 0);
    const receiptButtons = [
      ...document.querySelectorAll('section[aria-label="Private support receipt"] button'),
    ].map((element) => element.getBoundingClientRect());
    const [refresh, revoke] = receiptButtons;
    return {
      wrappedActionsAligned:
        !refresh ||
        !revoke ||
        revoke.top < refresh.bottom ||
        Math.abs(revoke.left - refresh.left) <= 1,
      count: targets.length,
      minimumHeight: Math.min(...targets.map((bounds) => bounds.height)),
      minimumWidth: Math.min(...targets.map((bounds) => bounds.width)),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      contained: targets.every(
        (bounds) => bounds.left >= -1 && bounds.right <= document.documentElement.clientWidth + 1,
      ),
    };
  });
}

export async function runGuestSupportFlows(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    checks.push({ name, ok, detail: null });
    if (!ok) failures.push(name);
  };
  const measure = async (target: Page, stage: string, width: number) => {
    const geometry = await controlGeometry(target);
    checks.push({
      name: `[support ${width}] ${stage} has 44px targets without overflow`,
      ok:
        geometry.count > 0 &&
        geometry.minimumHeight >= 44 &&
        geometry.minimumWidth >= 44 &&
        geometry.overflow <= 1 &&
        geometry.contained &&
        geometry.wrappedActionsAligned,
      detail: geometry,
    });
    if (!checks[checks.length - 1]?.ok)
      failures.push(`[support ${width}] ${stage} target geometry`);
  };
  const measureField = async (selector: string, width: number) => {
    const resting = await page.$eval(selector, (element) => {
      const style = getComputedStyle(element);
      let ground = element.parentElement;
      while (
        ground?.parentElement &&
        getComputedStyle(ground).backgroundColor === 'rgba(0, 0, 0, 0)'
      )
        ground = ground.parentElement;
      return {
        borderWidth: parseFloat(style.borderTopWidth),
        borderStyle: style.borderTopStyle,
        borderColor: style.borderTopColor,
        background: style.backgroundColor,
        ground: ground ? getComputedStyle(ground).backgroundColor : null,
        paddingX: Math.min(parseFloat(style.paddingLeft), parseFloat(style.paddingRight)),
        paddingY: Math.min(parseFloat(style.paddingTop), parseFloat(style.paddingBottom)),
        shadow: style.boxShadow,
      };
    });
    await page.focus(selector);
    const focused = await page.$eval(selector, (element) => ({
      active: document.activeElement === element,
      shadow: getComputedStyle(element).boxShadow,
    }));
    await page.$eval(selector, (element) => (element as HTMLElement).blur());
    const name = `[support ${width}] ${selector} has visible field and focus affordance`;
    const ok =
      resting.borderWidth >= 1 &&
      resting.borderStyle === 'solid' &&
      resting.background !== 'rgba(0, 0, 0, 0)' &&
      resting.background !== 'transparent' &&
      resting.background !== resting.ground &&
      resting.borderColor !== resting.background &&
      resting.paddingX >= 10 &&
      resting.paddingY >= 8 &&
      focused.active &&
      focused.shadow !== 'none' &&
      focused.shadow !== resting.shadow;
    checks.push({ name, ok, detail: { resting, focused } });
    if (!ok) failures.push(name);
  };
  const mate = await mateCookie(seeded);
  for (const width of [390, 1280]) {
    const context = await page.browser().createBrowserContext();
    const guest = await context.newPage();
    guest.setDefaultTimeout(20_000);
    try {
      await guest.setViewport(width === 390 ? PHONE : { width, height: 900 });
      await guest.goto(`${seeded.baseUrl}/help`, { waitUntil: 'networkidle2' });
      await measure(guest, 'initial intake/recovery', width);
      await shot(guest, outDir, `guest-support-${width}-signed-out`);
      check(
        `[guest ${width}] signed-out intake needs no account`,
        (await context.cookies()).every((cookie) => cookie.name !== 'omr_session'),
      );
      const title = `Scratch access request ${width}`;
      await field(guest, 'Short summary', title);
      await field(
        guest,
        'What happened?',
        'Cannot access my account or email. Synthetic hosted QA only.',
      );
      await click(guest, 'Send support request');
      await contains(guest, 'Your request reached the private support queue.');
      const credentials = await guest.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem('omr-guest-support') ?? '{}') as {
            token?: string;
            recoveryCode?: string;
          },
      );
      const token = must(credentials.token),
        recoveryCode = must(credentials.recoveryCode);
      check(
        `[guest ${width}] receipt strips fragment and has independent recovery`,
        new URL(guest.url()).hash === '' && token !== recoveryCode,
      );
      // Screenshot redaction only: capability-bearing readonly fields are never painted.
      await guest.addStyleTag({
        content:
          'input[readonly]{color:transparent!important;text-shadow:none!important;-webkit-text-security:disc!important}',
      });
      await measure(guest, 'receipt/reply', width);
      await shot(guest, outDir, `guest-support-${width}-receipt-redacted`);
      const queue = must(seeded.radars.find((item) => item.template === 'helpdesk'));
      const listed = await staff<{ items: { id: string; title: string | null }[] }>(
        seeded,
        `/api/radars/${queue.id}/blips?limit=50`,
        seeded.ownerCookie,
      );
      const request = must(listed.items.find((item) => item.title === title));
      await staff(seeded, `/api/blips/${request.id}/comments`, seeded.ownerCookie, {
        body: 'STAFF INTERNAL PRIVATE',
        visibility: 'internal',
      });
      const pending = await staff<{
        comment: { id: string; bodySha256: string; visibility: string };
      }>(seeded, `/api/blips/${request.id}/comments`, mate, {
        body: 'Reviewed support reply for this guest.',
        visibility: 'client',
      });
      check(
        `[guest ${width}] collaborator reply awaits release`,
        pending.comment.visibility === 'client_pending',
      );
      await click(guest, 'Refresh conversation');
      await guest.waitForNetworkIdle();
      const hidden = await guest.evaluate(() => document.body.textContent);
      check(
        `[guest ${width}] internal and pending replies stay private`,
        !hidden.includes('STAFF INTERNAL PRIVATE') &&
          !hidden.includes('Reviewed support reply for this guest.'),
      );
      await staff(seeded, `/api/comments/${pending.comment.id}/release`, seeded.ownerCookie, {
        bodySha256: pending.comment.bodySha256,
      });
      await staff(
        seeded,
        `/api/blips/${request.id}`,
        seeded.ownerCookie,
        { status: 'waiting-on-client' },
        'PATCH',
      );
      await click(guest, 'Refresh conversation');
      await contains(guest, 'Reviewed support reply for this guest.');
      await contains(guest, 'Waiting on you');
      check(`[guest ${width}] released reply and customer status appear`, true);
      await field(guest, 'Your reply', 'Here is my follow-up without an email account.');
      const [response] = await Promise.all([
        guest.waitForResponse(
          (item) =>
            new URL(item.url()).pathname === '/api/guest-support/conversation/replies' &&
            item.request().method() === 'POST',
        ),
        click(guest, 'Send reply'),
      ]);
      if (response.status() !== 201)
        throw new Error(`Guest ${width} follow-up HTTP status: ${response.status()}`);
      const returned = (await response.json()) as GuestSupportThreadDto;
      const replyState = {
        width,
        httpStatus: response.status(),
        projectedStatus: returned.thread?.request.status ?? null,
        replyCount: returned.thread?.replies.length ?? 0,
      };
      process.stdout.write(`[guest follow-up] ${JSON.stringify(replyState)}\n`);
      // Composer text is already present before submission; wait for the server-backed list.
      try {
        await guest.waitForFunction(
          (reply) =>
            [...document.querySelectorAll('section ol li')].some((item) =>
              item.textContent.includes(reply),
            ) && document.body.textContent.includes('In progress'),
          {},
          'Here is my follow-up without an email account.',
        );
      } catch (error) {
        throw new Error(`Guest follow-up UI commit failed: ${JSON.stringify(replyState)}`, {
          cause: error,
        });
      }
      check(
        `[guest ${width}] follow-up appears and advances status`,
        await guest.evaluate(() => document.body.textContent.includes('In progress')),
      );
      await shot(guest, outDir, `guest-support-${width}-conversation-redacted`);
      await click(guest, 'Start another request');
      await field(guest, 'Saved recovery code', recoveryCode);
      await click(guest, 'Recover conversation');
      await contains(guest, 'Recovered. Save the new private link');
      const rotated = await guest.evaluate(
        () => JSON.parse(sessionStorage.getItem('omr-guest-support') ?? '{}') as { token?: string },
      );
      check(
        `[guest ${width}] recovery rotates the private link`,
        Boolean(rotated.token && rotated.token !== token),
      );
      const old = await fetch(`${seeded.baseUrl}/api/guest-support/conversation`, {
        headers: { authorization: `Support ${token}` },
      });
      check(`[guest ${width}] previous link is denied`, old.status === 404);
      await guest.addStyleTag({
        content:
          'input[readonly],section[aria-label="Recover a support conversation"] input{color:transparent!important;-webkit-text-security:disc!important}',
      });
      await measure(guest, 'recovered conversation', width);
      await shot(guest, outDir, `guest-support-${width}-recovered-redacted`);
      await click(guest, 'Revoke this link');
      await contains(guest, 'The conversation link and recovery code were revoked.');
      const revoked = await fetch(`${seeded.baseUrl}/api/guest-support/conversation`, {
        headers: { authorization: `Support ${must(rotated.token)}` },
      });
      check(`[guest ${width}] revoked conversation is denied`, revoked.status === 404);
      await shot(guest, outDir, `guest-support-${width}-revoked`);
      await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
      await page.goto(`${seeded.baseUrl}/support`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#support-title');
      await measure(page, 'signed-in intake', width);
      await measureField('#support-title', width);
      await measureField('#support-body', width);
      await shot(page, outDir, `support-${width}-signed-in`);
      await page.type('#support-title', `Synthetic phone controls ${width}`);
      await page.type('#support-body', 'Disposable hosted support controls acceptance.');
      await click(page, 'Send request');
      await page.waitForSelector('#support-reply');
      await measure(page, 'signed-in reply/navigation', width);
      await measureField('#support-reply', width);
      await shot(page, outDir, `support-${width}-conversation`);
    } finally {
      await context.close();
    }
  }
  return {
    checks,
    failures,
    notes: [
      'Support queue configured only in isolated CI scratch runtime after ordinary owner API seed; screenshots redact capability-bearing fields. No mailbox/provider/production readiness claim.',
    ],
  };
}

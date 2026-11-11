/** Real human review and revocation of a synthetic guest conversation. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { conversationFor, type GuestSupportThreadDto } from '@onmyradar/contract';
import { must, PHONE, PATIENCE_MS } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

type StaffPhase =
  | 'guest-start'
  | 'guest-conversation'
  | 'internal-note'
  | 'collaborator-session'
  | 'collaborator-open'
  | 'collaborator-client-mode'
  | 'collaborator-type'
  | 'collaborator-post'
  | 'pending-render'
  | 'guest-private-read'
  | 'owner-session'
  | 'owner-open'
  | 'owner-release-visible'
  | 'owner-release'
  | 'released-render'
  | 'guest-open'
  | 'guest-visible'
  | 'revoke-open'
  | 'revoke-confirm'
  | 'revoked-render'
  | 'saved-link-read'
  | 'saved-recovery-read'
  | 'retained-read';

function safeHttpStatus(status: number): number | null {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

async function nativeButton(page: Page, name: string, scope = '') {
  const buttons = await page.$$(`${scope} button`);
  try {
    for (const button of buttons) {
      if (await button.evaluate((element, label) => element.textContent.trim() === label, name)) {
        await button.click();
        return;
      }
    }
    throw new Error('Scratch staff support control unavailable');
  } finally {
    await Promise.all(buttons.map((button) => button.dispose()));
  }
}

async function collaboratorCookie(baseUrl: string) {
  const email = 'mate@example.test';
  const challenge = await fetch(baseUrl + '/api/auth/request-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(PATIENCE_MS),
  });
  if (!challenge.ok) throw new Error('Scratch collaborator challenge failed');
  const code = must(((await challenge.json()) as { devCode?: string }).devCode);
  const cookie = challenge.headers
    .getSetCookie()
    .map((part) => part.split(';')[0])
    .join('; ');
  const signedIn = await fetch(baseUrl + '/api/auth/verify-code', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
    signal: AbortSignal.timeout(PATIENCE_MS),
  });
  if (!signedIn.ok) throw new Error('Scratch collaborator sign-in failed');
  return must(
    signedIn.headers
      .getSetCookie()
      .map((part) => part.split(';')[0])
      .find((part) => part?.startsWith('omr_session=')),
  );
}

export async function runStaffSupportFlows(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const evidence: {
    width: number;
    pending: boolean;
    hidden: boolean;
    hashMatched: boolean;
    releaseStatus: number;
    visible: boolean;
    revokeStatus: number;
    linkStatus: number;
    recoveryStatus: number;
    retained: boolean;
  }[] = [];
  const check = (name: string, ok: boolean) => {
    checks.push({ name, ok, detail: null });
    if (!ok) failures.push(name);
  };
  const queue = must(seeded.radars.find((radar) => radar.template === 'helpdesk'));
  const postLabel = `Post ${conversationFor(queue.template).replyNoun}`;
  const mate = await collaboratorCookie(seeded.baseUrl);
  for (const width of [390, 1280]) {
    const diagnostic: { phase: StaffPhase; httpStatus: number | null } = {
      phase: 'guest-start',
      httpStatus: null,
    };
    const initialCheckCount = checks.length;
    const begin = (phase: StaffPhase) => {
      diagnostic.phase = phase;
      diagnostic.httpStatus = null;
    };
    const api = async <T>(
      path: string,
      credential: string,
      method = 'GET',
      body?: unknown,
    ): Promise<T> => {
      const response = await fetch(seeded.baseUrl + path, {
        method,
        headers: { cookie: credential, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      diagnostic.httpStatus = safeHttpStatus(response.status);
      if (!response.ok) throw new Error('Scratch staff support API failed');
      return (await response.json()) as T;
    };
    const staffContext = await page.browser().createBrowserContext();
    const guestContext = await page.browser().createBrowserContext();
    const staff = await staffContext.newPage(),
      guest = await guestContext.newPage();
    staff.setDefaultTimeout(PATIENCE_MS);
    guest.setDefaultTimeout(PATIENCE_MS);
    await staff.setViewport(width === 390 ? PHONE : { width, height: 900 });
    await guest.setViewport(width === 390 ? PHONE : { width, height: 900 });
    const setHuman = async (cookie: string) => {
      await staffContext.setCookie({
        name: 'omr_session',
        value: cookie.slice('omr_session='.length),
        domain: new URL(seeded.baseUrl).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      });
    };
    try {
      const start = await fetch(seeded.baseUrl + '/api/guest-support/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      diagnostic.httpStatus = safeHttpStatus(start.status);
      if (start.status !== 201) throw new Error('Scratch guest start failed');
      const credentials = (await start.json()) as { token: string; recoveryCode: string };
      const token = must(credentials.token),
        recoveryCode = must(credentials.recoveryCode);
      begin('guest-conversation');
      const created = await fetch(seeded.baseUrl + '/api/guest-support/conversation', {
        method: 'POST',
        headers: { authorization: `Support ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: randomUUID(),
          category: 'account',
          title: `Native staff review ${width}`,
          body: 'Synthetic private support request.',
        }),
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      diagnostic.httpStatus = safeHttpStatus(created.status);
      if (created.status !== 201) throw new Error('Scratch guest conversation failed');
      const thread = (await created.json()) as GuestSupportThreadDto;
      const requestId = must(thread.thread).request.id;
      begin('internal-note');
      await api(`/api/blips/${requestId}/comments`, seeded.ownerCookie, 'POST', {
        body: 'Synthetic internal staff note.',
        visibility: 'internal',
      });
      const openConversation = async () => {
        const response = await staff.goto(`${seeded.baseUrl}/radar/${queue.id}`, {
          waitUntil: 'networkidle2',
        });
        diagnostic.httpStatus = response ? safeHttpStatus(response.status()) : null;
        const card = `:is(.board-card:has([data-blip-id="${requestId}"]),.board-card[data-blip-id="${requestId}"])`;
        await staff.waitForSelector(`${card} .card-discuss`, { visible: true });
        await staff.click(`${card} .card-discuss`);
        await staff.waitForSelector('[role="dialog"] .comment-input', { visible: true });
      };
      begin('collaborator-session');
      await setHuman(mate);
      begin('collaborator-open');
      await openConversation();
      begin('collaborator-client-mode');
      await nativeButton(staff, 'reply to client', '[role="dialog"]');
      const reply = `Reviewed native staff reply ${width}.`;
      begin('collaborator-type');
      await staff.type('[role="dialog"] .comment-input', reply);
      begin('collaborator-post');
      const [posted] = await Promise.all([
        staff.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().endsWith(`/api/blips/${requestId}/comments`),
        ),
        staff.click(`[role="dialog"] button[aria-label="${postLabel}"]`),
      ]);
      diagnostic.httpStatus = safeHttpStatus(posted.status());
      if (posted.status() !== 201) throw new Error('Scratch native collaborator reply failed');
      const pendingComment = (
        (await posted.json()) as { comment: { id: string; visibility: string; bodySha256: string } }
      ).comment;
      const pending = pendingComment.visibility === 'client_pending';
      check(`[staff support ${width}] native collaborator reply is pending`, pending);
      begin('pending-render');
      await staff.waitForSelector('[role="dialog"] li.comment.is-pending');
      await staff.screenshot({
        path: `${outDir}/staff-support-${width}-pending.png`,
        fullPage: false,
      });
      begin('guest-private-read');
      const hiddenResponse = await fetch(seeded.baseUrl + '/api/guest-support/conversation', {
        headers: { authorization: `Support ${token}` },
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      diagnostic.httpStatus = safeHttpStatus(hiddenResponse.status);
      if (!hiddenResponse.ok) throw new Error('Scratch guest read failed');
      const hiddenProjection = JSON.stringify(await hiddenResponse.json());
      const hidden =
        !hiddenProjection.includes(reply) &&
        !hiddenProjection.includes('Synthetic internal staff note.');
      check(`[staff support ${width}] pending and internal notes stay private`, hidden);
      begin('owner-session');
      await setHuman(seeded.ownerCookie);
      begin('owner-open');
      await openConversation();
      begin('owner-release-visible');
      await staff.waitForSelector('[role="dialog"] li.comment.is-pending .release-bar', {
        visible: true,
      });
      begin('owner-release');
      const [released] = await Promise.all([
        staff.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().endsWith(`/api/comments/${pendingComment.id}/release`),
        ),
        nativeButton(staff, 'Release to client', '[role="dialog"]'),
      ]);
      diagnostic.httpStatus = safeHttpStatus(released.status());
      const releaseBody = JSON.parse(must(await released.request().fetchPostData())) as {
        bodySha256?: string;
      };
      const hashMatched = releaseBody.bodySha256 === pendingComment.bodySha256;
      check(
        `[staff support ${width}] owner releases the exact reviewed hash`,
        hashMatched && released.status() === 200,
      );
      begin('released-render');
      await staff.waitForFunction(
        () => !document.querySelector('[role="dialog"] li.comment.is-pending'),
      );
      await staff.screenshot({
        path: `${outDir}/staff-support-${width}-released.png`,
        fullPage: false,
      });
      begin('guest-open');
      const guestPage = await guest.goto(seeded.baseUrl + '/help#' + token, {
        waitUntil: 'networkidle2',
      });
      diagnostic.httpStatus = guestPage ? safeHttpStatus(guestPage.status()) : null;
      begin('guest-visible');
      await guest.waitForFunction(
        (text) =>
          [...document.querySelectorAll('section ol li')].some((item) =>
            item.textContent.includes(text),
          ),
        {},
        reply,
      );
      const visible = await guest.evaluate(
        (text) =>
          document.body.textContent.includes(text) &&
          !document.body.textContent.includes('Synthetic internal staff note.'),
        reply,
      );
      check(`[staff support ${width}] guest sees only the released reply`, visible);
      check(
        `[staff support ${width}] private fragment leaves the visible address`,
        new URL(guest.url()).hash === '',
      );
      begin('revoke-open');
      await nativeButton(staff, 'Revoke guest conversation link', '[role="dialog"]');
      begin('revoke-confirm');
      const [revoked] = await Promise.all([
        staff.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().endsWith(`/api/guest-support/requests/${requestId}/revoke`),
        ),
        nativeButton(staff, 'Confirm revocation', '[role="dialog"]'),
      ]);
      diagnostic.httpStatus = safeHttpStatus(revoked.status());
      check(`[staff support ${width}] owner confirms native revocation`, revoked.status() === 200);
      begin('revoked-render');
      await staff.waitForFunction(() =>
        document
          .querySelector('[role="dialog"]')
          ?.textContent.includes(
            'Guest link and recovery code revoked. The private support record remains.',
          ),
      );
      await staff.screenshot({
        path: `${outDir}/staff-support-${width}-revoked.png`,
        fullPage: false,
      });
      begin('saved-link-read');
      const link = await fetch(seeded.baseUrl + '/api/guest-support/conversation', {
        headers: { authorization: `Support ${token}` },
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      diagnostic.httpStatus = safeHttpStatus(link.status);
      begin('saved-recovery-read');
      const recovery = await fetch(seeded.baseUrl + '/api/guest-support/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryCode }),
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      diagnostic.httpStatus = safeHttpStatus(recovery.status);
      check(`[staff support ${width}] saved conversation link is denied`, link.status === 404);
      check(
        `[staff support ${width}] independent saved recovery code is denied`,
        recovery.status === 404,
      );
      begin('retained-read');
      const retained = await api<{ blip: { id: string } }>(
        `/api/blips/${requestId}`,
        seeded.ownerCookie,
      );
      check(
        `[staff support ${width}] private support record remains`,
        retained.blip.id === requestId,
      );
      evidence.push({
        width,
        pending,
        hidden,
        hashMatched,
        releaseStatus: released.status(),
        visible,
        revokeStatus: revoked.status(),
        linkStatus: link.status,
        recoveryStatus: recovery.status,
        retained: retained.blip.id === requestId,
      });
    } catch {
      console.log(
        '[staff-support-failure]',
        JSON.stringify({
          width,
          phase: diagnostic.phase,
          httpStatus: diagnostic.httpStatus,
          completedCheckCount: checks.length - initialCheckCount,
        }),
      );
      throw new Error(`Native staff support ${width} failed; capability details withheld`);
    } finally {
      await staffContext.close();
      await guestContext.close();
    }
  }
  writeFileSync(
    `${outDir}/staff-support-provenance.json`,
    JSON.stringify(
      {
        sourceSha: process.env['CI_COMMIT_SHA'] ?? null,
        pipelineId: process.env['CI_PIPELINE_ID'] ?? null,
        jobId: process.env['CI_JOB_ID'] ?? null,
        setup:
          'Ordinary scratch guest API and human owner/collaborator sessions; native pending, hash-bound release and owner revocation. No mail/provider action.',
        evidence,
      },
      null,
      2,
    ),
  );
  return {
    checks,
    failures,
    notes: [
      'Synthetic staff support browser evidence; live delivery and staff coverage remain separate.',
    ],
  };
}

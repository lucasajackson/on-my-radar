/** Real authorized events and served Activity UI, only on the hosted CI scratch app. */
import type { ConsoleMessage, HTTPResponse, Page } from 'puppeteer-core';
import type { CommentDto, NotificationDto, UserDto } from '@onmyradar/contract';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { PHONE, PATIENCE_MS, shot, must } from './harness.js';
import { scratchDatabase } from './database.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runNotificationIdentity(
  page: Page,
  outDir: string,
  seeded: Seeded,
  databaseUrl: string,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    bearer?: string,
    cookie = seeded.ownerCookie,
  ): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`identity fixture ${method} ${path}: ${response.status}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  const { user: owner } = await call<{ user: UserDto }>('/api/auth/session');
  const { radar } = await call<{ radar: { id: string } }>('/api/radars', 'POST', {
    name: 'Notification identity acceptance',
  });
  const agentToken = async (name: string, cookie = seeded.ownerCookie) => {
    const { agent } = await call<{ agent: { id: string } }>(
      '/api/repo-agents',
      'POST',
      { name },
      undefined,
      cookie,
    );
    const { token } = await call<{ token: { token: string } }>(
      '/api/tokens',
      'POST',
      {
        name: 'CI notification identity',
        agentId: agent.id,
        voices: ['persona', 'principal'],
      },
      undefined,
      cookie,
    );
    return { id: agent.id, bearer: token.token };
  };
  const lulu = await agentToken('Lulu');
  const mia = await agentToken('Mia');
  const thought = async (title: string) =>
    (
      await call<{ blip: { id: string } }>(`/api/radars/${radar.id}/blips`, 'POST', {
        body: `# ${title}\nA private CI-owned thought.`,
      })
    ).blip.id;
  const reply = async (
    blipId: string,
    body: string,
    bearer?: string,
    cookie?: string,
    voice: 'agent' | 'me' = 'agent',
  ) =>
    (
      await call<{ comment: CommentDto }>(
        `/api/blips/${blipId}/comments`,
        'POST',
        { body, ...(bearer ? { as: voice } : {}) },
        bearer,
        cookie,
      )
    ).comment;

  /** The worker delivers an agent's comment as a notification a moment after the request. */
  const delivered = async (blipId: string) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { items } = await call<{ items: NotificationDto[] }>('/api/notifications?limit=100');
      if (items.some((n) => n.kind === 'comment' && n.blipId === blipId)) return;
      await new Promise<void>((r) => {
        setTimeout(() => r(), 500);
      });
    }
    throw new Error(`notification for ${blipId} was not delivered by the worker`);
  };

  const single = await thought('Agent-leading identity');
  const committed = await reply(single, 'I am working on this.', lulu.bearer);
  check(
    'identity: real agent comment retains agent and human cosigner',
    committed.agent?.id === lulu.id &&
      committed.author?.id === owner.id &&
      committed.voice === 'persona',
  );
  const grouped = await thought('Two agents one cosigner');
  await reply(grouped, 'First agent reply.', lulu.bearer);
  await reply(grouped, 'Second agent reply.', mia.bearer);

  // Ordinary magic-code authentication on the suite's development-mode scratch
  // app, exactly as seed.ts does. No production/dev-host auth or SQL patching.
  const email = 'notification-human@example.test';
  let humanCookie = '';
  let code = '';
  let human: UserDto | undefined;
  for (const path of ['/api/auth/request-code', '/api/auth/verify-code']) {
    const response = await fetch(seeded.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: humanCookie },
      body: JSON.stringify(path.endsWith('request-code') ? { email } : { email, code }),
    });
    if (!response.ok) throw new Error(`identity human sign-in: ${response.status}`);
    for (const raw of response.headers.getSetCookie())
      humanCookie = raw.split(';')[0] ?? humanCookie;
    const result = (await response.json()) as { devCode?: string; user?: UserDto };
    if (path.endsWith('request-code'))
      code = must(result.devCode, 'CI development login did not return a code');
    else human = result.user;
  }
  const humanId = must(human).id;
  await call('/api/auth/profile', 'PATCH', { name: 'Lulu' }, undefined, humanCookie);
  await call(`/api/radars/${radar.id}/members`, 'POST', { email, role: 'editor' });
  const mixed = await thought('Agent and human same name');
  await reply(mixed, 'Human participation.', undefined, humanCookie);
  const humanAgent = await agentToken('Courier', humanCookie);
  const principal = await reply(mixed, 'Explicit human voice.', humanAgent.bearer, undefined, 'me');
  check(
    'identity: explicit as:me commits human-leading voice',
    principal.author?.id === humanId &&
      principal.agent?.id === humanAgent.id &&
      principal.voice === 'principal',
  );
  await reply(mixed, 'Agent participation.', lulu.bearer);

  const legacy = await thought('Unknown historical identity');
  const historicMixed = await thought('Known agent with earlier unknown activity');
  // Old-writer shape is constructed ONLY in main.ts's validated CI scratch DB.
  // The test never uses an application/service secret or updates real accounts.
  const expectedDatabase = scratchDatabase(new URL(databaseUrl).pathname.slice(1));
  const scratch = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const clientEnds: Promise<void>[] = [];
  scratch.on('connect', (client) =>
    clientEnds.push(new Promise<void>((resolve) => client.once('end', resolve))),
  );
  try {
    const database = (await scratch.query<{ name: string }>('SELECT current_database() AS name'))
      .rows[0]?.name;
    if (database !== expectedDatabase) throw new Error('identity scratch database mismatch');
    for (const [id, subject] of [
      [legacy, 'Unknown historical identity'],
      [historicMixed, 'Known agent with earlier unknown activity'],
    ] as const)
      await scratch.query(
        `INSERT INTO notifications(user_id,kind,radar_id,blip_id,group_key,count,actor_ids,subject,excerpt)
         VALUES($1,'comment',$2,$3,$4,2,ARRAY[$1::uuid],$5,'Retained old-writer activity')`,
        [owner.id, radar.id, id, `comment:${id}`, subject],
      );
  } finally {
    await scratch.end();
    await Promise.all(clientEnds);
  }
  await reply(historicMixed, 'Fresh known agent reply.', lulu.bearer);
  const archived = await agentToken('Archived helper');
  const archivedThought = await thought('Archived agent identity');
  await reply(archivedThought, 'Committed before archiving.', archived.bearer);
  await delivered(archivedThought);
  await call(`/api/repo-agents/${archived.id}/archived`, 'PUT', { archived: true });
  const removed = await agentToken('Removed private helper');
  const removedThought = await thought('Deleted agent neutral identity');
  await reply(removedThought, 'Committed before removal.', removed.bearer);
  await delivered(removedThought);
  await call(`/api/repo-agents/${removed.id}`, 'DELETE');

  /*
   * An agent's comment is delivered by the worker's outbox drain, not inside the request, so
   * the notifications arrive a moment after the replies above. Wait for all of them (the
   * worker drains every couple of seconds) rather than reading once and calling a slow
   * drain a missing notification.
   */
  const wanted = [single, grouped, mixed, legacy, historicMixed, archivedThought, removedThought];
  let items: NotificationDto[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    ({ items } = await call<{ items: NotificationDto[] }>('/api/notifications?limit=100'));
    if (wanted.every((id) => items.some((n) => n.kind === 'comment' && n.blipId === id))) break;
    await new Promise<void>((r) => {
      setTimeout(() => r(), 500);
    });
  }
  const find = (id: string) => must(items.find((n) => n.kind === 'comment' && n.blipId === id));
  const one = find(single),
    two = find(grouped),
    both = find(mixed),
    old = find(legacy),
    oldAndNew = find(historicMixed),
    retired = find(archivedThought),
    deleted = find(removedThought);
  check(
    'identity: single real event leads actual agent rather than cosigner',
    one.title.startsWith('Lulu (agent) commented') &&
      one.count === 1 &&
      one.principals?.[0]?.id === lulu.id,
    one.title,
  );
  check(
    'identity: different agents sharing one cosigner remain distinct',
    two.title.startsWith('Mia (agent) and Lulu (agent)') &&
      two.count === 2 &&
      two.actors.length === 1 &&
      two.principals?.length === 2,
    two.title,
  );
  check(
    'identity: equal-named human and agent have distinguishable labels',
    both.title.startsWith('Lulu (agent) and Lulu ') &&
      both.principals?.some((p) => p.kind === 'human' && p.id === humanId) === true &&
      both.principals.some((p) => p.kind === 'agent' && p.id === lulu.id) === true,
    both.title,
  );
  check(
    'identity: legacy events do not guess a human or agent from cosigner',
    old.principals?.length === 0 &&
      old.hasUnattributedEvents === true &&
      old.title.startsWith('Someone ') &&
      old.title.includes('2 events, including unattributed earlier activity'),
    old.title,
  );
  check(
    'identity: fresh known agent remains visible in older coalesced activity',
    oldAndNew.title.startsWith('Lulu (agent) commented') &&
      oldAndNew.count === 3 &&
      oldAndNew.hasUnattributedEvents === true &&
      oldAndNew.title.includes('3 events, including unattributed earlier activity'),
    oldAndNew.title,
  );
  check(
    'identity: archived agent resolves its actual live name',
    retired.title.startsWith('Archived helper (agent) commented'),
    retired.title,
  );
  check(
    'identity: deleted principal uses a neutral label without private name',
    deleted.title.startsWith('Former agent (agent) commented') &&
      !JSON.stringify(deleted).includes('Removed private helper'),
    deleted.title,
  );

  const [name, value] = seeded.ownerCookie.split('=');
  await page.browser().setCookie({
    name: must(name),
    value: must(value),
    domain: new URL(seeded.baseUrl).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
  const artifacts: unknown[] = [];
  const browserErrors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const network: Array<{ path: string; status: number }> = [];
  const onError = (error: unknown) =>
    browserErrors.push(error instanceof Error ? error.message : 'Unknown browser error');
  const onConsole = (message: ConsoleMessage) =>
    consoleMessages.push({ type: message.type(), text: message.text().slice(0, 300) });
  const onResponse = (response: HTTPResponse) => {
    const url = new URL(response.url());
    if (url.origin === new URL(seeded.baseUrl).origin)
      network.push({ path: url.pathname, status: response.status() });
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  const scenarios = [
    ['single-agent', one],
    ['two-agents', two],
    ['human-agent', both],
    ['legacy-unknown', old],
    ['mixed-history', oldAndNew],
    ['archived-agent', retired],
    ['deleted-agent', deleted],
  ] as const;
  const inspect = async (title: string, focus: boolean) =>
    page.evaluate(
      (text: string, focusRead: boolean) => {
        const node = [...document.querySelectorAll<HTMLElement>('.notification-title')].find(
          (el) => el.innerText === text,
        );
        if (!node) return null;
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const row = node.closest('li');
        const button = row?.querySelector<HTMLButtonElement>('button');
        if (focusRead) button?.focus();
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          title: node.innerText,
          rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          visible:
            r.width > 0 &&
            r.height > 0 &&
            r.left >= 0 &&
            r.right <= window.innerWidth + 1 &&
            r.top >= 0 &&
            r.bottom <= window.innerHeight,
          topmost: hit !== null && (node.closest('.notification-body')?.contains(hit) ?? false),
          readLabel: button?.getAttribute('aria-label'),
          focused: document.activeElement === button,
        };
      },
      title,
      focus,
    );
  try {
    for (const width of [390, 1280]) {
      await page.setViewport(
        width === 390
          ? PHONE
          : { width, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
      );
      await page.goto(`${seeded.baseUrl}/notifications`, {
        waitUntil: 'networkidle0',
        timeout: PATIENCE_MS,
      });
      // Agents' comments are reports, so they sit in the "Agents reported" box; the page opens on
      // "Needs you" (open questions and mentions by people) since the inbox split.
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.segmented button')]
          .find((button) => /reported/i.test(button.textContent))
          ?.click(),
      );
      const expected = scenarios.map(([, item]) => item.title);
      await page.waitForFunction(
        (titles: string[]) =>
          titles.every((title) =>
            [...document.querySelectorAll<HTMLElement>('.notification-title')].some(
              (node) => node.innerText === title,
            ),
          ),
        { timeout: PATIENCE_MS },
        expected,
      );
      for (const [label, item] of scenarios) {
        const geometry = await inspect(item.title, true);
        check(
          `identity ${width}: Activity visibly renders ${label}`,
          geometry?.visible === true,
          geometry,
        );
        check(`identity ${width}: ${label} link is topmost`, geometry?.topmost === true, geometry);
        check(
          `identity ${width}: ${label} read control is focusable and names server title`,
          geometry?.focused === true && geometry.readLabel === `Mark as read: ${item.title}`,
          geometry,
        );
        const file = `identity-activity-${label}-${width}`;
        await shot(page, outDir, file);
        artifacts.push({
          file: `${file}.png`,
          width,
          surface: 'Activity',
          notificationId: item.id,
          geometry,
        });
      }
      check(
        `identity ${width}: Activity has no horizontal overflow`,
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      );
      const { items: widget } = await call<{ items: NotificationDto[] }>(
        '/api/notifications?unreadOnly=true&limit=6',
      );
      await page.goto(seeded.baseUrl, { waitUntil: 'networkidle0', timeout: PATIENCE_MS });
      await page.waitForSelector('.notification-widget .notification-title');
      const expectedWidget = widget.filter((item) =>
        scenarios.some(([, known]) => known.id === item.id),
      );
      for (const item of expectedWidget) {
        const geometry = await inspect(item.title, true);
        check(
          `identity ${width}: dashboard widget retains ${item.title}`,
          geometry?.visible === true &&
            geometry.topmost === true &&
            geometry.readLabel === `Mark as read: ${item.title}` &&
            geometry.focused,
          geometry,
        );
      }
      check(
        `identity ${width}: dashboard widget has real identity events`,
        expectedWidget.length > 0,
      );
      const widgetFile = `identity-dashboard-${width}`;
      await shot(page, outDir, widgetFile);
      artifacts.push({
        file: `${widgetFile}.png`,
        width,
        surface: 'dashboard',
        notificationIds: expectedWidget.map((item) => item.id),
      });
    }
    const readLabel = `Mark as read: ${deleted.title}`;
    let clicked = false;
    for (const button of await page.$$('button[aria-label]')) {
      if ((await button.evaluate((node) => node.getAttribute('aria-label'))) === readLabel) {
        await button.click();
        clicked = true;
        break;
      }
    }
    check('identity: actual dashboard mark-read control can be clicked', clicked);
    if (clicked) {
      await page.waitForFunction(
        (label: string) =>
          [...document.querySelectorAll('button')].every(
            (button) => button.getAttribute('aria-label') !== label,
          ),
        { timeout: PATIENCE_MS },
        readLabel,
      );
      const { items: afterRead } = await call<{ items: NotificationDto[] }>(
        '/api/notifications?limit=100',
      );
      check(
        'identity: dashboard action marks exactly its notification read',
        afterRead.find((item) => item.id === deleted.id)?.read === true &&
          scenarios
            .filter(([, item]) => item.id !== deleted.id)
            .every(([, item]) => afterRead.find((row) => row.id === item.id)?.read === false),
      );
    }
    check(
      'identity: served browser has no uncaught errors',
      browserErrors.length === 0,
      browserErrors,
    );
    check(
      'identity: served UI requests have no unexpected HTTP errors',
      network.every((response) => response.status < 400),
      network.filter((response) => response.status >= 400),
    );
    check(
      'identity: served UI has no console errors',
      consoleMessages.every((message) => message.type !== 'error'),
      consoleMessages.filter((message) => message.type === 'error'),
    );
  } finally {
    page.off('pageerror', onError);
    page.off('console', onConsole);
    page.off('response', onResponse);
    writeFileSync(
      join(outDir, 'identity-provenance.json'),
      JSON.stringify(
        {
          sourceSha: process.env['CI_COMMIT_SHA'] ?? null,
          baseUrl: seeded.baseUrl,
          committed: {
            agentId: committed.agent?.id,
            cosignerId: committed.author?.id,
            voice: committed.voice,
          },
          notifications: scenarios.map(([scenario, item]) => ({ scenario, item })),
          artifacts,
          browserErrors,
          consoleMessages,
          network,
        },
        null,
        2,
      ),
    );
  }
  return { checks, failures, notes: [] };
}

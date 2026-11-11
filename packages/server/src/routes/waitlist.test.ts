/**
 * `POST /api/waitlist`, over the wire on an isolated database, with outbound
 * mail captured at the Resend call.
 *
 * Each abuse guard is asserted on its own, and the whole flow is walked once:
 * the form queues somebody, the admin approves them through the unchanged
 * console route, and they sign in with the address the approval email names.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAITLIST } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { WAITLIST_RESPONSE } from '../services/waitlist.js';

interface Sent {
  to: string;
  subject: string;
  text: string;
}

describe.skipIf(!process.env['DATABASE_URL'])('the waitlist form (isolated postgres)', () => {
  const database = `omr_waitlist_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let sent: Sent[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env['DATABASE_URL'] ?? '');
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'waitlist-test-secret-not-used-anywhere-else',
        RESEND_API_KEY: 're_test_key',
        AUTO_APPROVE_EMAILS: '@vip.test',
        APP_URL: 'https://onmyradar.io',
        NODE_ENV: 'test',
      }),
    );
    await runMigrations();
    // Resend is the only outbound call these requests make; capture it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const target = input instanceof Request ? input.url : input.toString();
        if (target.startsWith('https://api.resend.com/')) {
          const raw = typeof init?.body === 'string' ? init.body : '{}';
          const body = JSON.parse(raw) as {
            to: string[];
            subject: string;
            text: string;
          };
          sent.push({ to: body.to[0] ?? '', subject: body.subject, text: body.text });
          return new Response('{"id":"sent"}', { status: 200 });
        }
        return realFetch(input, init);
      }),
    );
    app = createApp();
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
    setEnvForTesting(null);
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(() => {
    sent = [];
  });

  const join = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      // A name unless the case is about the name: it is required, and a case
      // that forgot it would pass every other check for the wrong reason.
      body: JSON.stringify('name' in body ? body : { name: 'Tester', ...body }),
    });
  const fresh = (domain = 'example.test') => `wl-${randomUUID()}@${domain}`;
  const userBy = async (email: string) =>
    (await getDb().select().from(schema.users).where(eq(schema.users.email, email)))[0];
  const requestOf = async (userId: string) =>
    (
      await getDb()
        .select()
        .from(schema.waitlistRequests)
        .where(eq(schema.waitlistRequests.userId, userId))
    )[0];
  /** Mail goes through the outbox after the response; wait for it to land. */
  const mailTo = async (email: string, expected: number) => {
    await vi.waitFor(() => expect(sent.filter((m) => m.to === email)).toHaveLength(expected));
    // …and give a stray second send the chance to show up before trusting a count.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return sent.filter((m) => m.to === email);
  };

  it('queues a new address as a pending account and confirms once', async () => {
    const email = fresh();
    const res = await join({ email, name: 'Ada', useCase: 'agent_builder', source: 'homepage' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(WAITLIST_RESPONSE);
    const user = await userBy(email);
    expect(user?.state).toBe('pending');
    // The form's name is kept beside the account, not written into it.
    expect(user?.name).toBeNull();
    expect(await requestOf(user?.id ?? '')).toMatchObject({
      name: 'Ada',
      useCase: 'agent_builder',
      source: 'homepage',
    });
    const [mail] = await mailTo(email, 1);
    expect(mail?.subject).toMatch(/on the list/);
    expect(mail?.text).toMatch(/^Hi Ada,/);
    expect(mail?.text).toMatch(/opens by invitation/);
  });

  it('confirms at most once a day, and keeps the first submission’s details', async () => {
    const email = fresh();
    await join({ email, name: 'First' });
    await join({ email, name: 'Somebody else' });
    await join({ email });
    await mailTo(email, 1);
    const user = await userBy(email);
    expect((await requestOf(user?.id ?? ''))?.name).toBe('First');

    // A day later, it may confirm again.
    await getDb()
      .update(schema.waitlistRequests)
      .set({
        confirmationSentAt: new Date(
          Date.now() - (WAITLIST.confirmationIntervalHours + 1) * 3_600_000,
        ),
      })
      .where(eq(schema.waitlistRequests.userId, user?.id ?? ''));
    await join({ email });
    await mailTo(email, 2);
  });

  it('never mails, queues or changes an account that is already in', async () => {
    for (const state of ['active', 'suspended'] as const) {
      const email = fresh();
      const [user] = await getDb().insert(schema.users).values({ email, state }).returning();
      const res = await join({ email, name: 'Impostor' });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual(WAITLIST_RESPONSE);
      expect((await userBy(email))?.state).toBe(state);
      expect(await requestOf(user?.id ?? '')).toBeUndefined();
      await mailTo(email, 0);
    }
  });

  it('creates nothing for an address a first sign-in would let straight in', async () => {
    const email = fresh('vip.test');
    expect((await join({ email })).status).toBe(202);
    expect(await userBy(email)).toBeUndefined();
    await mailTo(email, 0);
  });

  it('answers a honeypot hit exactly like a real submission, and does nothing', async () => {
    const email = fresh();
    const res = await join({ email, website: 'http://spam.example' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(WAITLIST_RESPONSE);
    expect(await userBy(email)).toBeUndefined();
    await mailTo(email, 0);
  });

  it('gives one answer whoever the address belongs to', async () => {
    const queued = fresh();
    await join({ email: queued });
    const active = fresh();
    await getDb().insert(schema.users).values({ email: active, state: 'active' });
    const bodies = new Set<string>();
    for (const email of [fresh(), queued, active, fresh('vip.test')]) {
      const res = await join({ email });
      bodies.add(`${res.status} ${await res.text()}`);
    }
    bodies.add(`202 ${JSON.stringify(WAITLIST_RESPONSE)}`);
    expect(bodies.size).toBe(1);
  });

  it('caps one network, from CF-Connecting-IP only', async () => {
    const network = `198.51.100.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < WAITLIST.requestsPerNetworkPerHour; i++) {
      expect((await join({ email: fresh() }, { 'cf-connecting-ip': network })).status).toBe(202);
    }
    const refused = await join({ email: fresh() }, { 'cf-connecting-ip': network });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    // Another network is unaffected, and a spoofable header keys nothing.
    expect((await join({ email: fresh() }, { 'cf-connecting-ip': '203.0.113.77' })).status).toBe(
      202,
    );
    expect((await join({ email: fresh() }, { 'x-forwarded-for': network })).status).toBe(202);
  });

  it('requires a name, and says so like any other field', async () => {
    const email = fresh();
    for (const name of [undefined, '', '   ']) {
      const res = await join({ email, name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(await res.text()).toMatch(/Tell us your name|Required/);
    }
    expect(await userBy(email)).toBeUndefined();
  });

  it('caps its fields and takes JSON only', async () => {
    const email = fresh();
    for (const body of [
      { email, name: 'x'.repeat(121) },
      { email, source: 'has spaces' },
      { email, source: 'x'.repeat(65) },
      { email, useCase: 'enterprise' },
      { email, website: 'x'.repeat(201) },
      { email: 'not-an-address' },
    ]) {
      expect((await join(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const form = await app.request('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ email, name: 'Form' }),
    });
    expect(form.status).toBe(415);
    expect(await userBy(email)).toBeUndefined();
  });

  it('queue → approve → sign in with the address the approval email names', async () => {
    const email = fresh();
    await join({ email, name: 'Grace', useCase: 'team' });
    await mailTo(email, 1);
    const queued = await userBy(email);
    if (!queued) throw new Error('not queued');

    // Signing in before approval finds the queued account rather than making a
    // second one, and sends no second "you are on the waitlist" email.
    const early = await app.request('/api/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const earlyCode = ((await early.json()) as { devCode?: string }).devCode;
    // Mail is configured here, so the code is in the captured email instead.
    const codeMail = (await mailTo(email, 2)).at(-1);
    const code = earlyCode ?? /\b(\d{6})\b/.exec(codeMail?.text ?? '')?.[1];
    const challenge = early.headers.getSetCookie().find((c) => c.startsWith('omr_login='));
    const signedIn = await app.request('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: challenge?.split(';')[0] ?? '' },
      body: JSON.stringify({ email, code }),
    });
    expect(signedIn.status).toBe(200);
    expect(((await signedIn.json()) as { user: { id: string; state: string } }).user).toMatchObject(
      { id: queued.id, state: 'pending' },
    );
    await mailTo(email, 2);

    // The admin's console, unchanged, lists what the form said and approves.
    const [adminUser] = await getDb()
      .insert(schema.users)
      .values({ email: fresh(), state: 'active', isAdmin: true })
      .returning();
    if (!adminUser) throw new Error('admin insert returned no row');
    const cookie = `${SESSION_COOKIE}=${(await createSession(adminUser)).token}`;
    const listed = (await (
      await app.request('/api/admin/users?state=pending', { headers: { cookie } })
    ).json()) as { users: Array<{ id: string; waitlist: unknown }> };
    expect(listed.users.find((u) => u.id === queued.id)?.waitlist).toMatchObject({
      name: 'Grace',
      useCase: 'team',
      source: null,
    });
    const approved = await app.request(`/api/admin/users/${queued.id}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(approved.status).toBe(200);
    expect((await userBy(email))?.state).toBe('active');
    const approval = (await mailTo(email, 3)).at(-1);
    expect(approval?.subject).toMatch(/ready/);
    expect(approval?.text).toContain('https://onmyradar.io/login');
    expect(approval?.text).toContain(email);
  });
});

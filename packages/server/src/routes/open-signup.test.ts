/**
 * SIGNUP_MODE=open (the default), over the wire on an isolated database: a first sign-in
 * lands active with its workspace, the waitlist form
 * stops queueing anybody, and the existing backlog is let in on its next sign-in
 * or request — without an approval email, and never a suspended account.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { openSignupResponse } from '../services/waitlist.js';

interface Sent {
  to: string;
  subject: string;
  text: string;
}

it('signs people straight in unless the operator asks for a waitlist', () => {
  const base = {
    DATABASE_URL: 'postgres://fixture',
    SESSION_SECRET: 'open-signup-default-secret-0123456789',
  };
  expect(loadEnv(base).SIGNUP_MODE).toBe('open');
  expect(loadEnv({ ...base, SIGNUP_MODE: 'waitlist' }).SIGNUP_MODE).toBe('waitlist');
});

describe.skipIf(!process.env['DATABASE_URL'])('open signup (isolated postgres)', () => {
  const database = `omr_open_signup_${randomUUID().replaceAll('-', '')}`;
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
        SESSION_SECRET: 'open-signup-test-secret-not-used-anywhere-else',
        RESEND_API_KEY: 're_test_key',
        SIGNUP_MODE: 'open',
        APP_URL: 'https://onmyradar.io',
        NODE_ENV: 'test',
      }),
    );
    await runMigrations();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const target = input instanceof Request ? input.url : input.toString();
        if (target.startsWith('https://api.resend.com/')) {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
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

  const fresh = () => `open-${randomUUID()}@example.test`;
  const userBy = async (email: string) =>
    (await getDb().select().from(schema.users).where(eq(schema.users.email, email)))[0];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  const signIn = async (email: string) => {
    const requested = await app.request('/api/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(requested.status).toBe(200);
    await vi.waitFor(() => expect(sent.some((m) => m.to === email)).toBe(true));
    const code = /\b(\d{6})\b/.exec(sent.filter((m) => m.to === email).at(-1)?.text ?? '')?.[1];
    const challenge = requested.headers.getSetCookie().find((c) => c.startsWith('omr_login='));
    const res = await app.request('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: challenge?.split(';')[0] ?? '' },
      body: JSON.stringify({ email, code }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    return {
      user: ((await res.json()) as { user: { id: string; state: string } }).user,
      cookie: cookie?.split(';')[0] ?? '',
    };
  };

  it('lets a brand-new address straight in, with a workspace', async () => {
    const email = fresh();
    const { user } = await signIn(email);
    expect(user.state).toBe('active');
    await settle();
    // The sign-in code is the only mail: no waitlist or approval message.
    expect(sent.filter((m) => m.to === email)).toHaveLength(1);

    const radars = await getDb()
      .select()
      .from(schema.radars)
      .where(eq(schema.radars.ownerId, user.id));
    expect(radars.some((r) => !r.isDropBox)).toBe(true);
  });

  it('has no billing or plan surface, even for an active signed-in account', async () => {
    const { cookie } = await signIn(fresh());
    for (const path of ['/api/billing', '/api/billing/usage', '/api/plans', '/api/admin/plans']) {
      expect((await app.request(path, { headers: { cookie } })).status, path).toBe(404);
    }
    const hook = await app.request('/hooks/stripe', { method: 'POST', body: '{}' });
    expect(hook.status).toBe(404);
  });

  it('stops queueing: the form answers that signup is open and creates nothing', async () => {
    const email = fresh();
    const res = await app.request('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'Ada' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(openSignupResponse());
    expect(await userBy(email)).toBeUndefined();
    await settle();
    expect(sent.filter((m) => m.to === email)).toHaveLength(0);
  });

  it('admits a waitlisted account on its next sign-in, without an approval email', async () => {
    const email = fresh();
    const [queued] = await getDb()
      .insert(schema.users)
      .values({ email, state: 'pending' })
      .returning();
    const { user } = await signIn(email);
    expect(user).toMatchObject({ id: queued?.id, state: 'active' });
    expect((await userBy(email))?.state).toBe('active');
    await settle();
    expect(sent.filter((m) => m.to === email)).toHaveLength(1);
  });

  it('admits a waitlisted account that is already holding a session', async () => {
    const email = fresh();
    const [queued] = await getDb()
      .insert(schema.users)
      .values({ email, state: 'pending' })
      .returning();
    if (!queued) throw new Error('insert returned no row');
    const cookie = `${SESSION_COOKIE}=${(await createSession(queued)).token}`;
    const res = await app.request('/api/auth/session', { headers: { cookie } });
    expect(((await res.json()) as { user: { state: string } }).user.state).toBe('active');
    expect((await app.request('/api/radars', { headers: { cookie } })).status).toBe(200);
    const audit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, queued.id));
    expect(audit.map((a) => a.action)).toContain('user.approve');
  });

  it('never lets a suspended account back in', async () => {
    const email = fresh();
    const [suspended] = await getDb()
      .insert(schema.users)
      .values({ email, state: 'suspended' })
      .returning();
    if (!suspended) throw new Error('insert returned no row');
    const cookie = `${SESSION_COOKIE}=${(await createSession(suspended)).token}`;
    expect((await app.request('/api/radars', { headers: { cookie } })).status).toBe(403);
    expect((await userBy(email))?.state).toBe('suspended');
  });
});

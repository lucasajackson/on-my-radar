/**
 * Small route defects from the 2026-09-26 review, each asserted over the wire.
 *
 * - Admin actions are transitions from a named state. `approve` on a suspended
 *   account used to reinstate it; `reinstate` on a waitlisted one activated it
 *   outside `activateUser`.
 * - `/health/ready` is unauthenticated and used to return the driver's error
 *   text, which names hosts, roles and why authentication failed.
 * - A schema `.parse` that escaped into `onError` was a 500 (the topic-invite
 *   revoke with a bad address was one).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LOGIN_CODE } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import * as dbClient from '../db/client.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { errorBody } from '../http.js';
import { must } from '../errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe('an escaped schema refusal', () => {
  it('is a 400 naming the field, not a 500', () => {
    const parsed = z.object({ email: z.string().email('An email address is required') });
    const err = parsed.safeParse({ email: 'nope' });
    if (err.success) throw new Error('expected a refusal');
    const { status, body } = errorBody(err.error);
    expect(status).toBe(400);
    expect(body.error.message).toBe('An email address is required');
    expect(body.error.fields).toEqual({ email: 'An email address is required' });
  });
});

describe('a server fault', () => {
  it('is opaque whatever NODE_ENV says, with a fresh error id each time', () => {
    const fault = new Error('relation "secret_table" does not exist');
    const first = errorBody(fault);
    const second = errorBody(fault);
    expect(first.status).toBe(500);
    expect(JSON.stringify(first.body)).not.toContain('secret_table');
    expect(first.body.error.id).toMatch(/^err_/);
    expect(second.body.error.id).not.toBe(first.body.error.id);
  });
});

describe.skipIf(!hasDatabase)('route hardening (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  async function user(state: 'pending' | 'active' | 'suspended', isAdmin = false) {
    const [row] = await getDb()
      .insert(schema.users)
      .values({ email: `hardening-${randomUUID()}@example.test`, state, isAdmin })
      .returning();
    return must(row);
  }

  const act = (id: string, action: string) =>
    app.request(`/api/admin/users/${id}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  const stateOf = async (id: string) =>
    (await getDb().select().from(schema.users).where(eq(schema.users.id, id)))[0]?.state;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    const admin = await user('active', true);
    adminCookie = `${SESSION_COOKIE}=${(await createSession(admin)).token}`;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('refuses to approve a suspended account, and leaves it suspended', async () => {
    const target = await user('suspended');
    const res = await act(target.id, 'approve');
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(
      /Only a waitlisted account can be approved; this one is suspended/,
    );
    expect(await stateOf(target.id)).toBe('suspended');
  });

  it('refuses to reinstate a waitlisted account, and leaves it waiting', async () => {
    const target = await user('pending');
    const res = await act(target.id, 'reinstate');
    expect(res.status).toBe(409);
    expect(await stateOf(target.id)).toBe('pending');
  });

  it('still approves, suspends and reinstates from the right states', async () => {
    const target = await user('pending');
    expect((await act(target.id, 'approve')).status).toBe(200);
    expect(await stateOf(target.id)).toBe('active');
    expect((await act(target.id, 'suspend')).status).toBe(200);
    expect(await stateOf(target.id)).toBe('suspended');
    expect((await act(target.id, 'suspend')).status).toBe(409);
    expect((await act(target.id, 'reinstate')).status).toBe(200);
    expect(await stateOf(target.id)).toBe('active');
  });

  it('refuses an unknown state filter rather than casting it', async () => {
    const res = await app.request('/api/admin/users?state=bogus', {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(400);
  });

  it('answers a bad topic-invite address with a 400', async () => {
    const res = await app.request(`/api/topics/${randomUUID()}/invites?email=not-an-address`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/An email address is required/);
  });

  it('names the missing parameter on a malformed authorization request', async () => {
    const res = await app.request('/oauth/authorize?client_id=x&response_type=code');
    expect(res.status).toBe(302);
    const location = decodeURIComponent(res.headers.get('location') ?? '');
    expect(location).toMatch(/^\/connect\/error\?message=redirect_uri: Required$/);
  });

  it('lets a suspended account change nothing, its own profile included', async () => {
    const suspended = await user('suspended');
    const waiting = await user('pending');
    const patch = async (who: typeof suspended) =>
      app.request('/api/auth/profile', {
        method: 'PATCH',
        headers: {
          cookie: `${SESSION_COOKIE}=${(await createSession(who)).token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed' }),
      });
    expect((await patch(suspended)).status).toBe(403);
    // Control: somebody in the waiting room may still set their name.
    expect((await patch(waiting)).status).toBe(200);
  });

  it('serves the topic routes under the array vocabulary too (same router, same bodies)', async () => {
    const create = (path: string, name: string) =>
      app.request(path, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    const viaArrays = await create('/api/arrays', 'Made as an array');
    expect(viaArrays.status).toBe(201);
    const { topic } = (await viaArrays.json()) as { topic: { id: string } };
    for (const base of ['/api/arrays', '/api/topics', '/api/v1/arrays']) {
      const read = await app.request(`${base}/${topic.id}`, { headers: { cookie: adminCookie } });
      expect(read.status, base).toBe(200);
      const listed = (await (
        await app.request(base, { headers: { cookie: adminCookie } })
      ).json()) as { topics: Array<{ id: string }> };
      expect(
        listed.topics.map((t) => t.id),
        base,
      ).toContain(topic.id);
    }
  });

  it('reads ?archived= strictly on the radar and topic lists', async () => {
    for (const list of ['/api/radars', '/api/topics']) {
      const get = (query: string) =>
        app.request(`${list}${query}`, { headers: { cookie: adminCookie } });
      // A typo used to mean "false" without a word; now it says so.
      expect((await get('?archived=ture')).status, list).toBe(400);
      for (const ok of ['', '?archived=true', '?archived=1', '?archived=false']) {
        expect((await get(ok)).status, `${list}${ok}`).toBe(200);
      }
    }
    // The agent list has views rather than a flag (v2), read as strictly.
    const agents = (query: string) =>
      app.request(`/api/repo-agents${query}`, { headers: { cookie: adminCookie } });
    expect((await agents('?view=archive')).status).toBe(400);
    expect((await agents('?archived=ture')).status).toBe(400);
    for (const ok of ['', '?view=mine', '?view=shared', '?view=archived', '?archived=true']) {
      expect((await agents(ok)).status, `/api/repo-agents${ok}`).toBe(200);
    }
  });

  it('caps code requests per network from CF-Connecting-IP, never from X-Forwarded-For', async () => {
    const ask = (headers: Record<string, string>) =>
      app.request('/api/auth/request-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ email: `net-${randomUUID()}@example.test` }),
      });
    const spoofed = `192.0.2.${Math.floor(Math.random() * 250)}`;
    // X-Forwarded-For is the client's to write; a limit keyed on it would be
    // the caller's to choose. Past the ceiling and still answered.
    for (let i = 0; i <= LOGIN_CODE.requestsPerNetworkPerHour; i++) {
      expect((await ask({ 'x-forwarded-for': spoofed })).status).toBe(200);
    }
    // The edge's header is honoured, and one network is capped across addresses.
    const real = `2001:db8:${Math.floor(Math.random() * 9000).toString(16)}:1::`;
    for (let i = 0; i < LOGIN_CODE.requestsPerNetworkPerHour; i++) {
      // A different host in the same /64 is the same network.
      expect((await ask({ 'cf-connecting-ip': `${real}${i + 1}` })).status).toBe(200);
    }
    const refused = await ask({ 'cf-connecting-ip': `${real}ffff` });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await refused.text()).toMatch(/from your network/);
  });

  it('answers a server fault with an opaque body and an error id: no SQL, no stack, in any environment', async () => {
    // What a Drizzle failure looks like: the query and its parameters in the
    // message, file paths in the stack.
    const fault = new Error(
      'Failed query: SELECT "id" FROM "radars" WHERE "owner_id" = $1\nparams: secret-param',
    );
    fault.stack = `${fault.message}\n    at query (/app/node_modules/pg/lib/client.js:526:17)`;
    const spy = vi.spyOn(dbClient, 'getDb').mockImplementation(() => {
      throw fault;
    });
    let res: Response;
    try {
      res = await app.request('/api/radars', { headers: { cookie: adminCookie } });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    const text = await res.text();
    for (const leak of ['Failed query', 'SELECT', 'secret-param', 'node_modules', '    at '])
      expect([leak, text.includes(leak)]).toEqual([leak, false]);
    const body = JSON.parse(text) as { error: { code: string; message: string; id?: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('Something went wrong on our end.');
    expect(body.error.id).toMatch(/^err_[0-9a-f-]{36}$/);
  });

  it('never tells an unauthenticated prober why the database is unreachable', async () => {
    const secret = 'password authentication failed for user "on-my-radar"';
    const spy = vi.spyOn(dbClient, 'pingDbForReadiness').mockRejectedValueOnce(new Error(secret));
    const res = await app.request('/health/ready');
    spy.mockRestore();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('unready');
    expect(body).not.toContain('password');
  });
});

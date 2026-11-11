/**
 * Single-user mode over the wire. Each guard has its own test, so removing any one of
 * them fails a named test here rather than being covered silently by the others.
 */
import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, schema } from '../db/client.js';
import { authRoutes } from '../routes/auth.js';
import { createToken } from '../services/tokens.js';
import { cookieOf, json, startAuthApp } from './auth-test-kit.js';

const EMAIL = 'owner@example.test';
const HOST = 'localhost:3500';
const ENV = { SINGLE_USER_EMAIL: EMAIL, PUBLIC_URL: `http://${HOST}`, SIGNUP_MODE: 'waitlist' };
const mcpEnv = { outgoing: { on: () => undefined } };

describe.skipIf(!process.env['DATABASE_URL'])('single-user mode (isolated postgres)', () => {
  let kit: Awaited<ReturnType<typeof startAuthApp>>;
  beforeAll(async () => {
    kit = await startAuthApp(ENV);
  }, 30_000);
  afterAll(() => kit.stop());

  const request = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    kit.app.request(path, { ...init, headers: { host: HOST, ...headers } }, mcpEnv);
  const session = (headers: Record<string, string> = {}) => request('/api/auth/session', headers);
  const counts = async () => ({
    users: (await getDb().select({ n: count() }).from(schema.users))[0]?.n,
    sessions: (await getDb().select({ n: count() }).from(schema.sessions))[0]?.n,
  });

  it('answers a Host that is not ours with 421, and writes nothing', async () => {
    const before = await counts();
    for (const host of ['evil.example.com', 'evil.example.com:3500', 'localhost:9999', '']) {
      for (const path of ['/api/auth/session', '/api/radars', '/']) {
        const res = await request(path, { host });
        expect(res.status, `${host} ${path}`).toBe(421);
      }
    }
    expect(await counts()).toEqual(before);
    // Probes are exempt: /health says nothing worth rebinding for.
    expect((await request('/health/live', { host: 'pod-1.internal:3500' })).status).not.toBe(421);
  });

  it('mints nothing for a foreign Host even where the fence is not in front of it', async () => {
    // The route on its own, as if the fence had been taken out: the mint checks the Host itself.
    const bare = new Hono().route('/api/auth', authRoutes);
    const before = await counts();
    const res = await bare.request('/api/auth/session', { headers: { host: 'evil.example.com' } });
    expect(await res.json()).toEqual({ user: null });
    expect(await counts()).toEqual(before);
  });

  it('mints an active admin on /session, and a second call reuses the session', async () => {
    const res = await session();
    const { user } = (await res.json()) as {
      user: { email: string; state: string; isAdmin: boolean };
    };
    expect(user).toMatchObject({ email: EMAIL, state: 'active', isAdmin: true });
    const cookie = cookieOf(res, 'omr_session');
    expect(cookie).toBeTruthy();
    const before = await counts();
    const again = await session({ cookie: cookie ?? '' });
    expect(((await again.json()) as { user: { email: string } }).user.email).toBe(EMAIL);
    expect(cookieOf(again, 'omr_session')).toBeUndefined();
    expect(await counts()).toEqual(before);
  });

  it('mints for our own page only: not for a header, another site or a foreign Host', async () => {
    const before = await counts();
    for (const headers of [
      { authorization: 'Bearer something' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      const res = await session(headers);
      expect(await res.json(), JSON.stringify(headers)).toEqual({ user: null });
      expect(cookieOf(res, 'omr_session')).toBeUndefined();
    }
    expect(await counts()).toEqual(before);
    for (const site of ['same-origin', 'none']) {
      expect(cookieOf(await session({ 'sec-fetch-site': site }), 'omr_session')).toBeTruthy();
    }
  });

  it('keeps /mcp for tokens: a cookie session is refused, a personal token works', async () => {
    const cookie = cookieOf(await session(), 'omr_session') ?? '';
    const init = {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    };
    const accept = 'application/json, text/event-stream';
    const viaCookie = await request('/mcp', { ...json, accept, cookie }, init);
    expect(viaCookie.status).toBe(401);
    // The session is a plain string: sent as a bearer token it is the same credential.
    const bearer = cookie.split('=')[1] ?? '';
    const viaBearer = await request(
      '/mcp',
      { ...json, accept, authorization: `Bearer ${bearer}` },
      init,
    );
    expect(viaBearer.status).toBe(401);
    const [user] = await getDb().select().from(schema.users).where(eq(schema.users.email, EMAIL));
    if (!user) throw new Error('no single-user account');
    const { token } = await createToken({ user, kind: 'user' }, { name: 'agent' });
    const viaToken = await request(
      '/mcp',
      { ...json, accept, authorization: `Bearer ${token ?? ''}` },
      init,
    );
    expect(viaToken.status).toBe(200);
  });

  it('does not let a bare API call approve an OAuth connection', async () => {
    const cookie = cookieOf(await session(), 'omr_session') ?? '';
    const decide = (headers: Record<string, string>) =>
      request(
        '/oauth/authorize/decision',
        { ...json, cookie, ...headers },
        { method: 'POST', body: '{}' },
      );
    expect((await decide({})).status).toBe(403);
    // From our own page it reaches the real validation (an empty body is a 400, not a refusal).
    expect((await decide({ 'sec-fetch-site': 'same-origin' })).status).toBe(400);
    // Plain http on a LAN host: browsers send no Fetch Metadata, so our own Origin stands in.
    expect((await decide({ origin: `http://${HOST}` })).status).toBe(400);
    for (const headers of [
      { origin: 'https://evil.example.com' },
      { 'sec-fetch-site': 'cross-site', origin: `http://${HOST}` },
      { 'sec-fetch-site': 'same-site' },
    ])
      expect((await decide(headers)).status, JSON.stringify(headers)).toBe(403);
  });

  it('refuses to invite somebody new, and the other sign-in routes answer 404', async () => {
    const cookie = cookieOf(await session(), 'omr_session') ?? '';
    const radar = await request(
      '/api/radars',
      { ...json, cookie },
      { method: 'POST', body: JSON.stringify({ name: 'Mine' }) },
    );
    const { radar: made } = (await radar.json()) as { radar: { id: string } };
    const share = await request(
      `/api/radars/${made.id}/members`,
      { ...json, cookie },
      {
        method: 'POST',
        body: JSON.stringify({ email: `new-${randomUUID()}@example.test`, role: 'viewer' }),
      },
    );
    expect(share.status).toBe(403);
    // The same service path answers MCP: a token holder cannot invite a new address either.
    const [owner] = await getDb().select().from(schema.users).where(eq(schema.users.email, EMAIL));
    if (!owner) throw new Error('no single-user account');
    const { token } = await createToken({ user: owner, kind: 'user' }, { name: 'inviter' });
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'share_radar',
        arguments: { radarId: made.id, email: `new-${randomUUID()}@example.test` },
      },
    };
    const viaMcp = await request(
      '/mcp',
      {
        ...json,
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token ?? ''}`,
      },
      { method: 'POST', body: JSON.stringify(call) },
    );
    expect(await viaMcp.text()).toMatch(/one user/);
    for (const [method, path] of [
      ['POST', '/api/auth/request-code'],
      ['POST', '/api/auth/verify-code'],
      ['GET', '/api/auth/oidc/start'],
      ['POST', '/api/auth/password/login'],
    ] as const) {
      const res = await request(
        path,
        json,
        method === 'POST' ? { method, body: '{}' } : { method },
      );
      expect(res.status, path).toBe(404);
    }
  });

  it('reports the mode, and is {user:null} with the mode off', async () => {
    const config = (await (await request('/api/auth/config')).json()) as { singleUser: boolean };
    expect(config.singleUser).toBe(true);
    kit.withEnv({ PUBLIC_URL: `http://${HOST}` });
    const off = await session();
    expect(await off.json()).toEqual({ user: null });
    expect(cookieOf(off, 'omr_session')).toBeUndefined();
    kit.withEnv(ENV);
  });

  it('activates and promotes a waiting, non-admin owner row, and mints for it', async () => {
    await getDb()
      .update(schema.users)
      .set({ state: 'pending', isAdmin: false })
      .where(eq(schema.users.email, EMAIL));
    const res = await session();
    const { user } = (await res.json()) as { user: { state: string; isAdmin: boolean } };
    expect(user).toMatchObject({ state: 'active', isAdmin: true });
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect(row).toMatchObject({ state: 'active', isAdmin: true });
  });

  it('never un-suspends: a suspended account mints nothing', async () => {
    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.email, EMAIL));
    const before = await counts();
    const res = await session();
    expect(await res.json()).toEqual({ user: null });
    expect(await counts()).toEqual(before);
    const [user] = await getDb().select().from(schema.users).where(eq(schema.users.email, EMAIL));
    expect(user?.state).toBe('suspended');
  });
});

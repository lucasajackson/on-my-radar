/**
 * Cross-origin access, and the line it must not cross.
 *
 * This class of defect is invisible to every other test in this repository,
 * because a same-origin request never sends `Origin` and never asks for a
 * preflight — so nothing in a suite of same-origin `app.request()` calls can
 * fail when the allowance is wrong, missing, or far too wide. It is asserted
 * here rather than left for whichever browser-context client tries next.
 *
 * The fence at the bottom is the important one. A *blanket* allowance on `/api`
 * would be a genuine security regression, and the pressure to hoist this to the
 * whole app is the obvious next move for somebody who does not know why it is
 * scoped. The narrow, bearer-only allowance that `CORS_ALLOWED_ORIGINS` enables
 * is fenced separately in `api-cors.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from './app.js';
import { hashSecret, randomToken } from './auth/crypto.js';
import { closeDb, getDb, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const initialize = (token: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cors', version: '0' },
    },
  }),
});

/**
 * Cross-origin access, and the line it must not cross.
 *
 * This class of defect is invisible to every other test in the suite, because a
 * same-origin request never sends `Origin` and never asks for a preflight. It
 * is asserted here rather than left to be discovered by whichever browser-based
 * client tries next.
 */
describe.skipIf(!hasDatabase)('cross-origin access is allowed where there is no cookie', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });
  const origin = { origin: 'http://localhost:1234' };

  it('answers the preflight a browser sends before a token exchange', async () => {
    const res = await app.request('/oauth/token', {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
  });

  it('lets a browser read the token response, without credentials', async () => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { ...origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'nope' }).toString(),
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // `*` and credentials are mutually exclusive by spec, and credentials are
    // exactly what these endpoints are safe *without*. Never add this.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('lets a browser read the discovery documents', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
    ]) {
      const res = await app.request(path, { headers: origin });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  /**
   * A 401 whose challenge the client cannot read is not a challenge — it is the
   * same silent hang, arriving by a different route.
   */
  it('exposes WWW-Authenticate so a browser client can read the challenge', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...origin, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toMatch(/www-authenticate/i);
  });

  /**
   * The fence, and the reason this file rather than a one-line `cors()` in
   * `app.ts`. `/api` is authenticated by a cookie a browser attaches on its
   * own; its only defence against another origin driving it as the signed-in
   * person is that the response cannot be read.
   *
   * This now pins the **default** rather than an absolute: a deployment can
   * list origins in `CORS_ALLOWED_ORIGINS` and get a bearer-only allowance, and
   * `api-cors.test.ts` fences that narrower rule — above all that
   * `Access-Control-Allow-Credentials` is never sent, which is what keeps the
   * cookie out of it. What is asserted here is that a deployment which
   * configures nothing is answered exactly as it always was. If this goes red
   * without `CORS_ALLOWED_ORIGINS` being set, that is the finding — not the
   * test.
   */
  it('gives the cookie-authenticated API no cross-origin access by default', async () => {
    for (const path of ['/api/radars', '/api/auth/session', '/api/notifications/counts']) {
      const res = await app.request(path, { headers: origin });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const preflight = await app.request('/api/radars', {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.status).not.toBe(204);
  });
});

/**
 * The MCP success path, which only a real socket can show.
 *
 * A successful MCP call never becomes a Hono `Response` — the transport writes
 * to the raw Node response and the handler returns `RESPONSE_ALREADY_SENT` — so
 * the headers have to be set on `c.env.outgoing` and `app.request()` cannot see
 * any of it.
 */
describe.skipIf(!hasDatabase)('cross-origin headers reach a successful MCP response', () => {
  let base: string;
  let listener: ReturnType<typeof serve>;
  let userId: string;

  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({
        email: `cors-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        state: 'active',
      })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    userId = user.id;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('no ephemeral port');
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await closeDb();
  });

  async function mintAccess(clientId: string): Promise<string> {
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId,
        userId,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    return access;
  }

  /**
   * The MCP reply is the transport's own `Response`, returned through Hono, so
   * the CORS middleware adds these like anywhere else. It used to be written
   * straight to the Node response, where a header set on the context was
   * silently dropped; this is what says it still arrives.
   */
  it('puts the cross-origin headers on a successful MCP response too', async () => {
    const token = await mintAccess('omr_client_live_cors');
    const res = await fetch(`${base}/mcp`, initialize(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    await res.text();
  });
});

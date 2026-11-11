/**
 * Can a remote MCP client actually finish connecting, and stay connected.
 *
 * Every assertion here is a fence around one production incident. On 2026-08-27
 * LM Studio completed the whole OAuth flow correctly — registered, authorized,
 * exchanged the code, made three successful MCP calls — and then spent four
 * minutes in a loop that could not converge: 1039 `GET /mcp` 401s, 1047
 * refreshes, 1043 access tokens minted and two ever presented. Nothing surfaced
 * to the user; the client just sat there.
 *
 * The flow tests that already existed could not see any of it, because each one
 * asked whether a single request was answered correctly and every single request
 * *was*. What was broken lived in the sequence: an answer that told a client to
 * retry something that could never work, and a rotation that destroyed the
 * credential a working connection was holding. So these tests are written as
 * sequences, and two of them assert the state of a *second* actor after an
 * unrelated first one acted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
// Capture hasDatabase first so the socket/DB suites still skip without a DB.
process.env['DATABASE_URL'] ??= 'postgres://unused';

interface Grant {
  access: string;
  refresh: string;
}

async function makeUser(label: string) {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return user;
}

/** A grant in the shape `issueTokens` writes, so rotation is exercised for real. */
async function mintGrant(userId: string, clientId: string): Promise<Grant> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await getDb()
    .insert(schema.oauthTokens)
    .values({
      accessTokenHash: hashSecret(access),
      refreshTokenHash: hashSecret(refresh),
      clientId,
      userId,
      scope: TOKEN_SCOPES.join(' '),
      scopeConsented: true,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  return { access, refresh };
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

/** A well-formed `initialize`, so a 200 means the transport really answered. */
const initialize = (token?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'regression', version: '0' },
    },
  }),
});

describe.skipIf(!hasDatabase)('a remote MCP client can connect and stay connected', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });
  let userId: string;

  beforeAll(async () => {
    await runMigrations();
    userId = (await makeUser('mcp-connect')).id;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------- the answer that ended the retry loop ---------------- */

  /**
   * The loop-breaker. A client opening the server-to-client stream without a
   * header used to get 401 + `WWW-Authenticate`, which says "authenticate and
   * try again" about a request that authenticating cannot fix.
   */
  it('answers an unauthenticated GET /mcp with 405, not an auth challenge', async () => {
    const res = await app.request('/mcp', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/statelessly/i);
  });

  it('answers an unauthenticated DELETE /mcp the same way', async () => {
    const res = await app.request('/mcp', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  /**
   * The control on the ordering change: answering before the actor is resolved
   * is only safe because the answer does not depend on the actor. If these two
   * ever diverge, the method list has become an oracle for something.
   */
  it('gives an authenticated caller the identical 405 for GET', async () => {
    const grant = await mintGrant(userId, 'omr_client_get405');
    const res = await app.request('/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${grant.access}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  /** POST is still challenged, or a client would never learn where to go. */
  it('still challenges an unauthenticated POST /mcp, with the resource metadata', async () => {
    const res = await app.request('/mcp', initialize());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(
      /^Bearer resource_metadata="https?:\/\/.+\/\.well-known\/oauth-protected-resource"$/,
    );
  });

  /* ------------------ the rotation that broke live connections ------------- */

  it('a refresh retires only the refresh token — the access token keeps working', async () => {
    const grant = await mintGrant(userId, 'omr_client_rotate');
    expect(await resolveBearerToken(grant.access)).not.toBeNull();

    const res = await app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: grant.refresh }),
    );
    expect(res.status).toBe(200);

    // The half that used to die. An access token has its own expiry and a
    // rotation is not it.
    expect(await resolveBearerToken(grant.access)).not.toBeNull();
    // The half that must still die, or rotation means nothing.
    const replay = await app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: grant.refresh }),
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error?: string }).error).toBe('invalid_grant');
  });

  /* --------------- the grant is bound to the client that holds it ---------- */

  /**
   * The second half of the LM Studio report, and the part the livelock fix did
   * not reach. Two bridge processes registered two clients over one shared token
   * store; only one was ever authorised, and the other refreshed against its
   * sibling's refresh token successfully. Every row it minted was written
   * against the *authorised* client, which is why the database showed one grant
   * with six tokens and one presentation.
   */
  it('refuses a refresh token presented by a client it was not issued to', async () => {
    const grant = await mintGrant(userId, 'omr_client_authorised');

    const res = await app.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: grant.refresh,
        client_id: 'omr_client_never_authorised',
      }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
  });

  /**
   * The refusal must be inert. Retiring the token on a rejected attempt would
   * hand any registered client a way to disconnect somebody else's connection
   * by presenting a string it is not allowed to use — a worse outcome than the
   * bug being fixed.
   */
  it('leaves the grant usable after refusing the wrong client', async () => {
    const grant = await mintGrant(userId, 'omr_client_inert');

    await app.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: grant.refresh,
        client_id: 'omr_client_impostor',
      }),
    );

    const rightful = await app.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: grant.refresh,
        client_id: 'omr_client_inert',
      }),
    );
    expect(rightful.status).toBe(200);
  });

  /**
   * The deliberate tolerance, asserted so that tightening it later is a visible
   * decision rather than an accident. OAuth 2.1 requires `client_id` here for a
   * public client; refusing an omission today would break any compliant client
   * that leaves it out, at its next hour boundary, with nothing to tell the
   * person holding it why. Mismatched is the case that was actually observed.
   */
  it('still refreshes when client_id is omitted altogether', async () => {
    const grant = await mintGrant(userId, 'omr_client_omitted');
    const res = await app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: grant.refresh }),
    );
    expect(res.status).toBe(200);
  });

  /* ------------------------- the token response shape ---------------------- */

  it('answers a refresh with exactly the fields RFC 6749 §5.1 requires', async () => {
    const grant = await mintGrant(userId, 'omr_client_shape');
    const res = await app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: grant.refresh }),
    );

    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    // Live credentials must not land in a shared cache.
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    // A number, not the string "3600" — a strict client rejects the string.
    expect(typeof body['expires_in']).toBe('number');
    expect(typeof body['access_token']).toBe('string');
    expect(typeof body['refresh_token']).toBe('string');
  });

  it('says no-store on a token error too, not only on success', async () => {
    const res = await app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: 'not-a-token' }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

/**
 * The half that has to run over a real socket.
 *
 * A successful MCP call never becomes a Hono `Response`: the transport writes
 * to the raw Node response and the handler returns `RESPONSE_ALREADY_SENT`.
 * `app.request()` supplies no `c.env.incoming`/`outgoing`, so under that harness
 * every authenticated POST answers 500 — which is a fact about the harness and
 * would quietly turn the most important assertion in this file into a test of
 * nothing. These run against `serve()` on an ephemeral port instead.
 */
describe.skipIf(!hasDatabase)('a live connection survives what a client does to recover', () => {
  let base: string;
  let listener: ReturnType<typeof serve>;
  let userId: string;

  beforeAll(async () => {
    await runMigrations();
    userId = (await makeUser('mcp-live')).id;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('no ephemeral port');
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await closeDb();
  });

  /** The control: the harness can reach the real transport at all. */
  it('answers an authenticated initialize over the real transport', async () => {
    const grant = await mintGrant(userId, 'omr_client_live_ok');
    const res = await fetch(`${base}/mcp`, initialize(grant.access));
    expect(res.status).toBe(200);
    await res.text();
  });

  /**
   * The livelock itself, end to end.
   *
   * Two consumers of one grant is not exotic — it is what LM Studio did. One
   * connection works; something else calls without a header, 401s, and the
   * client refreshes to recover. Before this fix that refresh revoked the
   * *working* connection's access token, so the act of recovering was what broke
   * the thing that was fine — and every subsequent attempt did it again, 1047
   * times in four minutes, converging on nothing.
   */
  it('a refresh triggered by one caller does not break another caller mid-session', async () => {
    const grant = await mintGrant(userId, 'omr_client_livelock');

    expect((await fetch(`${base}/mcp`, initialize(grant.access))).status).toBe(200);

    // The stray unauthenticated call, and the refresh it provokes.
    expect((await fetch(`${base}/mcp`, initialize())).status).toBe(401);
    const refreshed = await fetch(
      `${base}/oauth/token`,
      form({ grant_type: 'refresh_token', refresh_token: grant.refresh }),
    );
    expect(refreshed.status).toBe(200);

    // The working connection is still working, which is the whole point.
    expect((await fetch(`${base}/mcp`, initialize(grant.access))).status).toBe(200);

    // And the token the refresh handed back works, so the caller that rotated
    // is not stranded either.
    const next = (await refreshed.json()) as { access_token: string };
    expect((await fetch(`${base}/mcp`, initialize(next.access_token))).status).toBe(200);
  });
});

/**
 * The SPA fallback, and what it must never swallow.
 *
 * A machine-facing path that answers `200 text/html` is the worst possible
 * failure: the client reads a success, parses nothing, and waits. This is
 * asserted for the transport paths an older or differently-configured MCP
 * client would probe for, because those are the ones where the silence would be
 * indistinguishable from the bug this file exists for.
 */
describe('unknown machine-facing paths fail loudly, not as the React shell', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it('404s the legacy MCP transport paths instead of serving index.html', async () => {
    for (const path of ['/mcp/sse', '/mcp/messages', '/mcp/anything']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    }
  });

  it('404s unknown API, oauth and discovery paths as JSON', async () => {
    for (const path of ['/api/nope', '/oauth/nope', '/.well-known/nope']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    }
  });
});

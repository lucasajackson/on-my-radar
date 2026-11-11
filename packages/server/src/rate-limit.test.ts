/**
 * Rate limits per bearer connection and per person, and the smaller /mcp body cap.
 *
 * Real Postgres: the property is that the database is the arbiter between replicas,
 * so a mock would only assert that we called the function we wrote.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { createApp } from './app.js';
import { createSession, SESSION_COOKIE } from './auth/session.js';
import { hashSecret, newApiToken } from './auth/crypto.js';
import { closeDb, getDb, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv, setEnvForTesting } from './env.js';
import { rateLimitedCount } from './metrics.js';
import { resetTokenBucketsForTesting, takeToken } from './services/token-bucket.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
process.env['DATABASE_URL'] ??= 'postgres://unused';

const useEnv = (patch: Record<string, string> = {}) =>
  setEnvForTesting(
    loadEnv({
      ...process.env,
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_LEASE: '1',
      RATE_LIMIT_TOKEN_BURST: '3',
      // 0.1 per second: nothing refills inside a test.
      RATE_LIMIT_TOKEN_PER_MINUTE: '6',
      RATE_LIMIT_USER_BURST: '5',
      RATE_LIMIT_USER_PER_MINUTE: '6',
      ...patch,
    }),
  );

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function makeUser() {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `limit-${unique()}@example.test`, state: 'active' })
    .returning();
  if (!user) throw new Error('no user');
  return user;
}
async function makePat(userId: string): Promise<string> {
  const token = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({ userId, name: 'pat', prefix: token.slice(0, 14), tokenHash: hashSecret(token) });
  return token;
}

describe.skipIf(!hasDatabase)('the token bucket', () => {
  beforeAll(async () => {
    useEnv();
    await runMigrations();
  }, 30_000);
  beforeEach(() => resetTokenBucketsForTesting());
  afterAll(closeDb);

  it('spends the burst, then refuses with a Retry-After that says when a token exists', async () => {
    const key = `test:${unique()}`;
    const spec = { perMinute: 6, burst: 3 };
    for (let i = 0; i < 3; i++) expect((await takeToken(key, spec)).ok).toBe(true);
    const refused = await takeToken(key, spec);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(10);
    }
  });

  it('refills with time', async () => {
    const key = `test:${unique()}`;
    const spec = { perMinute: 120, burst: 2 };
    await takeToken(key, spec);
    await takeToken(key, spec);
    expect((await takeToken(key, spec)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect((await takeToken(key, spec)).ok).toBe(true);
  });

  it('never grants more than the burst to concurrent callers (the cross-replica property)', async () => {
    const key = `test:${unique()}`;
    const results = await Promise.all(
      Array.from({ length: 60 }, () => takeToken(key, { perMinute: 6, burst: 10 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
  });

  it('with a lease, spends it locally and never exceeds the burst', async () => {
    useEnv({ RATE_LIMIT_LEASE: '5' });
    const key = `test:${unique()}`;
    const spec = { perMinute: 6, burst: 10 };
    const balance = async () =>
      Number(
        (
          await getDb().execute<{ tokens: number }>(
            sql`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`,
          )
        ).rows[0]?.tokens,
      );
    // One write took five tokens; the next four requests cost the database nothing.
    for (let i = 0; i < 5; i++) expect((await takeToken(key, spec)).ok).toBe(true);
    expect(await balance()).toBeCloseTo(5, 0);
    // The sixth needs a second lease.
    expect((await takeToken(key, spec)).ok).toBe(true);
    expect(await balance()).toBeCloseTo(0, 0);
    // Concurrent callers on a fresh key: at most the burst, whatever the interleaving.
    const other = `test:${unique()}`;
    const results = await Promise.all(Array.from({ length: 60 }, () => takeToken(other, spec)));
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!hasDatabase)('the token bucket under a burst of first requests', () => {
  beforeAll(async () => {
    useEnv({ RATE_LIMIT_LEASE: '5' });
    await runMigrations();
  }, 30_000);
  beforeEach(() => resetTokenBucketsForTesting());
  afterAll(async () => {
    useEnv();
    await closeDb();
  });

  it('serves every simultaneous caller that fits in the burst, instead of leasing the bucket empty', async () => {
    // Thirteen cache misses used to reserve thirteen leases of five: sixty tokens gone, the
    // thirteenth refused, and most of them sitting unspent in this process.
    const key = `test:${unique()}`;
    const spec = { perMinute: 6, burst: 60 };
    const results = await Promise.all(Array.from({ length: 13 }, () => takeToken(key, spec)));
    expect(results.filter((r) => r.ok)).toHaveLength(13);
    const stored = Number(
      (
        await getDb().execute<{ tokens: number }>(
          sql`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`,
        )
      ).rows[0]?.tokens,
    );
    // Three leases of five were taken in turn, not thirteen at once.
    expect(stored).toBeGreaterThanOrEqual(60 - 15 - 0.5);
  });

  it('serves exactly the burst to a larger crowd and refuses the rest', async () => {
    const key = `test:${unique()}`;
    const spec = { perMinute: 6, burst: 60 };
    const results = await Promise.all(Array.from({ length: 90 }, () => takeToken(key, spec)));
    expect(results.filter((r) => r.ok)).toHaveLength(60);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(30);
    expect(refused.every((r) => 'retryAfterSeconds' in r)).toBe(true);
  });

  it('with a lease of one, 100 concurrent callers get exactly the burst and are charged no more', async () => {
    useEnv({ RATE_LIMIT_LEASE: '1' });
    const key = `test:${unique()}`;
    const spec = { perMinute: 6, burst: 60 };
    const results = await Promise.all(Array.from({ length: 100 }, () => takeToken(key, spec)));
    expect(results.filter((r) => r.ok)).toHaveLength(60);
    const stored = Number(
      (
        await getDb().execute<{ tokens: number }>(
          sql`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`,
        )
      ).rows[0]?.tokens,
    );
    // Sixty tokens were taken for sixty callers: nothing was spent twice or given away free.
    expect(stored).toBeGreaterThanOrEqual(0);
    expect(stored).toBeLessThan(1);
    useEnv({ RATE_LIMIT_LEASE: '5' });
  });
});

describe.skipIf(!hasDatabase)('the limiter on the wire', () => {
  let base: string;
  let listener: ReturnType<typeof serve>;

  beforeAll(async () => {
    useEnv();
    await runMigrations();
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  afterEach(() => {
    resetTokenBucketsForTesting();
    useEnv();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await closeDb();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const rpc = (id: number) =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami' } });
  const mcp = (token: string, body = rpc(1)) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        ...bearer(token),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    });

  it('answers REST with 429, Retry-After and the API error shape', async () => {
    const pat = await makePat((await makeUser()).id);
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${base}/api/auth/session`, { headers: bearer(pat) })).status).toBe(200);
    }
    const res = await fetch(`${base}/api/auth/session`, { headers: bearer(pat) });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toMatch(/requests per minute/);
    expect(rateLimitedCount({ scope: 'token', surface: 'rest' })).toBeGreaterThan(0);
  });

  it('gives an MCP client a well-formed JSON-RPC error with Retry-After', async () => {
    const pat = await makePat((await makeUser()).id);
    for (let i = 0; i < 3; i++) expect((await mcp(pat)).status).toBe(200);
    const res = await mcp(pat);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32029, data: { code: 'rate_limited', status: 429 } },
    });
    expect(body.error.message).toMatch(/limited/);
  });

  it('limits a person across all of their connections', async () => {
    const user = await makeUser();
    const [a, b] = [await makePat(user.id), await makePat(user.id)];
    useEnv({ RATE_LIMIT_USER_BURST: '4' });
    const statuses: number[] = [];
    // Two connections, three tokens each: the person's bucket (4) runs out first.
    for (const pat of [a, b, a, b, a, b]) {
      statuses.push((await fetch(`${base}/api/auth/session`, { headers: bearer(pat) })).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    // Another person is untouched.
    const other = await makePat((await makeUser()).id);
    expect((await fetch(`${base}/api/auth/session`, { headers: bearer(other) })).status).toBe(200);
  });

  it('exempts /health and browser sessions', async () => {
    const user = await makeUser();
    const pat = await makePat(user.id);
    const session = (await createSession(user, { client: 'web', label: 'test' })).token;
    for (let i = 0; i < 3; i++) await fetch(`${base}/api/auth/session`, { headers: bearer(pat) });
    expect((await fetch(`${base}/api/auth/session`, { headers: bearer(pat) })).status).toBe(429);
    for (let i = 0; i < 8; i++) {
      expect((await fetch(`${base}/health/ready`, { headers: bearer(pat) })).status).toBe(200);
      expect((await fetch(`${base}/health/live`, { headers: bearer(pat) })).status).toBe(200);
    }
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${base}/api/auth/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${session}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it('can be switched off', async () => {
    useEnv({ RATE_LIMIT_ENABLED: 'false' });
    const pat = await makePat((await makeUser()).id);
    for (let i = 0; i < 8; i++) {
      expect((await fetch(`${base}/api/auth/session`, { headers: bearer(pat) })).status).toBe(200);
    }
  });

  describe('the /mcp body cap', () => {
    it('refuses a body over MCP_BODY_LIMIT_BYTES with a JSON-RPC 413, before parsing it', async () => {
      useEnv({ RATE_LIMIT_ENABLED: 'false', MCP_BODY_LIMIT_BYTES: '16384' });
      const pat = await makePat((await makeUser()).id);
      const huge = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: { pad: 'x'.repeat(20_000) } },
      });
      const res = await mcp(pat, huge);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    });

    it('still takes a full 100,000-character blip body at the default cap', async () => {
      useEnv({ RATE_LIMIT_ENABLED: 'false' });
      const pat = await makePat((await makeUser()).id);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_blip',
          arguments: { radarId: '00000000-0000-4000-8000-000000000000', body: 'x'.repeat(100_000) },
        },
      });
      expect(Buffer.byteLength(body)).toBeLessThan(262_144);
      const res = await mcp(pat, body);
      expect(res.status).toBe(200);
    });

    it('leaves the REST cap alone', async () => {
      useEnv({ RATE_LIMIT_ENABLED: 'false', MCP_BODY_LIMIT_BYTES: '16384' });
      const pat = await makePat((await makeUser()).id);
      const res = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { ...bearer(pat), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(20_000) }),
      });
      expect(res.status).not.toBe(413);
    });
  });
});

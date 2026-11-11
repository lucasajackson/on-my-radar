/**
 * The CSRF exemption belongs to requests that were authenticated by a bearer
 * credential — not to any request that merely carries an Authorization header.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createSession, SESSION_COOKIE } from './auth/session.js';
import { API_TOKEN_PREFIX, hashSecret, randomToken } from './auth/crypto.js';
import { closeDb, getDb, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('refuseCrossSiteWrites (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let pat: string;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `csrf-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    if (!user) throw new Error('no user');
    const { token } = await createSession(user, {});
    cookie = `${SESSION_COOKIE}=${token}`;
    pat = `${API_TOKEN_PREFIX}${randomToken()}`;
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: user.id,
        name: 'csrf test',
        prefix: pat.slice(0, 14),
        tokenHash: hashSecret(pat),
        scope: 'radars:read radars:write radars:manage',
      });
  }, 30_000);
  afterAll(closeDb);

  const write = (headers: Record<string, string>) =>
    app.request('/api/radars', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'csrf probe' }),
    });
  const code = async (res: Response) =>
    ((await res.json()) as { error?: { code?: string } }).error?.code;

  it('refuses a cross-site write carrying a session cookie and a junk bearer header', async () => {
    const res = await write({
      cookie,
      authorization: 'Bearer not-a-real-token',
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('cross_site_request');
  });

  it('refuses a cross-site write with a junk bearer header and no credential at all', async () => {
    const res = await write({ authorization: 'Bearer nope', 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('cross_site_request');
  });

  it('still lets a real bearer token write cross-origin', async () => {
    const res = await write({ authorization: `Bearer ${pat}`, 'sec-fetch-site': 'cross-site' });
    expect(await code(res)).not.toBe('cross_site_request');
    expect(res.status).toBeLessThan(400);
  });

  it('leaves clients that send neither Sec-Fetch-Site nor Origin alone', async () => {
    const res = await write({ authorization: 'Bearer nope' });
    expect(await code(res)).not.toBe('cross_site_request');
  });

  it('still allows the cookie session from its own origin', async () => {
    const res = await write({ cookie, 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBeLessThan(400);
  });
});

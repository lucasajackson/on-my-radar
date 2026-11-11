/** Account decisions stay with the person, including someone on the waitlist. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { hashSecret, newApiToken, randomToken } from './crypto.js';
import { createSession, listSessions, SESSION_COOKIE } from './session.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('human account management', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    app = createApp();
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  async function fixture(state: 'active' | 'pending' = 'active') {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `account-review-${randomUUID()}@example.test`, state, name: 'Original' })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    const session = await createSession(user, { client: 'ios' });
    const [device] = await listSessions(user.id);
    if (!device) throw new Error('session insert returned no row');
    return { user, session, device };
  }

  it.each(['pat', 'oauth'] as const)(
    'refuses account decisions from a read-only %s',
    async (kind) => {
      const { user, device } = await fixture();
      const token = kind === 'pat' ? newApiToken() : randomToken(32);
      if (kind === 'pat') {
        await getDb()
          .insert(schema.apiTokens)
          .values({
            userId: user.id,
            name: 'read-only review',
            prefix: token.slice(0, 14),
            tokenHash: hashSecret(token),
            scope: 'radars:read',
          });
      } else {
        const clientId = `account-review-${randomUUID()}`;
        await getDb()
          .insert(schema.oauthClients)
          .values({
            clientId,
            clientName: 'read-only review',
            redirectUris: ['https://example.test/callback'],
          });
        await getDb()
          .insert(schema.oauthTokens)
          .values({
            accessTokenHash: hashSecret(token),
            clientId,
            userId: user.id,
            scope: 'radars:read',
            scopeConsented: true,
            expiresAt: new Date(Date.now() + 3_600_000),
          });
      }
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      // Prove this is an authenticated delegate, not an invalid-token refusal.
      const resolved = await app.request('/api/auth/session', { headers });
      expect(((await resolved.json()) as { user: { id: string } }).user.id).toBe(user.id);
      expect((await app.request('/api/auth/sessions', { headers })).status).toBe(403);
      expect(
        (await app.request(`/api/auth/sessions/${device.id}`, { method: 'DELETE', headers }))
          .status,
      ).toBe(403);
      expect(
        (
          await app.request('/api/auth/profile', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ name: 'Agent changed me', theme: 'dark' }),
          })
        ).status,
      ).toBe(403);
      expect((await listSessions(user.id)).map((s) => s.id)).toContain(device.id);
      const [unchanged] = await getDb()
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id));
      expect(unchanged?.name).toBe('Original');
      expect(unchanged?.theme).toBe(user.theme);
    },
  );

  it.each([
    ['active', 'bearer'],
    ['active', 'cookie'],
    ['pending', 'bearer'],
    ['pending', 'cookie'],
  ] as const)('allows a %s person via %s', async (state, transport) => {
    const { user, session, device } = await fixture(state);
    const auth: Record<string, string> =
      transport === 'cookie'
        ? { cookie: `${SESSION_COOKIE}=${session.token}` }
        : { authorization: `Bearer ${session.token}` };
    const headers = { ...auth, 'content-type': 'application/json' };
    expect((await app.request('/api/auth/sessions', { headers })).status).toBe(200);
    expect(
      (
        await app.request('/api/auth/profile', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ name: 'My new name', theme: 'dark' }),
        })
      ).status,
    ).toBe(200);
    const [updated] = await getDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(updated?.name).toBe('My new name');
    expect(updated?.state).toBe(state);
    expect(
      (await app.request(`/api/auth/sessions/${device.id}`, { method: 'DELETE', headers })).status,
    ).toBe(204);
    expect(await listSessions(user.id)).toHaveLength(0);
  });
});

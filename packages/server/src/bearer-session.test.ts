/**
 * A session token presented as a bearer credential.
 *
 * The property is that it produces the *same person* as the cookie does, and
 * the way that could quietly go wrong is subtle: resolve it through the token
 * path instead of the session path and it becomes `kind: 'agent'`, at which
 * point `assertHumanDecision` starts refusing a first-party client the things
 * only a person may do -- registering for push, changing notification settings
 * -- and the failure looks like a permissions bug rather than a routing one.
 *
 * So the assertions are paired: what a session bearer CAN do that an agent
 * token cannot, and that an agent token still cannot do it. A test that only
 * checked the first would pass just as happily if the fence had been removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_TTL_DAYS } from '@onmyradar/contract';
import { createApp } from './app.js';
import { createSession, listSessions, revokeSessionFor, SESSION_COOKIE } from './auth/session.js';
import { hashSecret, newApiToken } from './auth/crypto.js';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { must } from './errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('a session token as a bearer credential', () => {
  // Built in beforeAll, not at module scope: `createApp()` loads the
  // environment, and a suite that is skipped for want of a database must not
  // fail at import for want of one either.
  let app: ReturnType<typeof createApp>;
  let userId: string;
  let sessionToken: string;
  let patToken: string;

  beforeAll(async () => {
    app = createApp();
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({
        email: `bearer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        state: 'active',
      })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    userId = user.id;

    sessionToken = (await createSession(user, { client: 'ios', label: 'A phone' })).token;

    patToken = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId,
        name: 'pat',
        prefix: patToken.slice(0, 14),
        tokenHash: hashSecret(patToken),
      });
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  it('authenticates the same person the cookie would', async () => {
    const viaBearer = await app.request('/api/auth/session', as(sessionToken));
    const viaCookie = await app.request('/api/auth/session', {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(viaBearer.status).toBe(200);
    const bearerBody = (await viaBearer.json()) as { user?: { id?: string } };
    const cookieBody = (await viaCookie.json()) as { user?: { id?: string } };
    expect(bearerBody.user?.id).toBe(userId);
    expect(cookieBody.user?.id).toBe(userId);
  });

  it('works under the versioned prefix too', async () => {
    const res = await app.request('/api/v1/auth/session', as(sessionToken));
    expect(res.status).toBe(200);
  });

  /**
   * The positive half of the fence: a person may change their own notification
   * settings, and a session bearer is a person.
   */
  it('may do what only a person may do', async () => {
    const res = await app.request('/api/notifications/settings', {
      method: 'PATCH',
      headers: { ...as(sessionToken).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ emailEnabled: false }),
    });
    expect(res.status).toBeLessThan(400);
  });

  /** The negative half. Without this, a removed fence would still look green. */
  it('does not extend that to an agent token', async () => {
    const res = await app.request('/api/notifications/settings', {
      method: 'PATCH',
      headers: { ...as(patToken).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ emailEnabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it('records the client and label, and lists them without the token', async () => {
    const sessions = await listSessions(userId);
    const mine = sessions.find((s) => s.client === 'ios');
    expect(mine?.label).toBe('A phone');
    expect(JSON.stringify(sessions)).not.toContain(sessionToken);
  });

  it('is refused once revoked', async () => {
    const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, userId));
    if (!user) throw new Error('user vanished');
    const doomed = await createSession(user, { client: 'cli', label: 'throwaway' });

    const before = await app.request('/api/auth/session', as(doomed.token));
    expect(((await before.json()) as { user?: unknown }).user).toBeTruthy();

    const [row] = (await listSessions(userId)).filter((s) => s.label === 'throwaway');
    expect(await revokeSessionFor(userId, must(row).id)).toBe(true);

    const after = await app.request('/api/auth/session', as(doomed.token));
    expect(((await after.json()) as { user: unknown }).user).toBeNull();
  });

  it('cannot revoke a session belonging to somebody else', async () => {
    const [other] = await getDb()
      .insert(schema.users)
      .values({ email: `other-${Date.now()}@example.test`, state: 'active' })
      .returning();
    if (!other) throw new Error('user insert returned no row');
    await createSession(other, { client: 'ios', label: 'not yours' });
    const [theirs] = await listSessions(other.id);
    expect(await revokeSessionFor(userId, must(theirs).id)).toBe(false);
  });

  it('issues a bearer session with the full TTL', async () => {
    const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, userId));
    const issued = await createSession(must(user), { client: 'android' });
    const days = (issued.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(SESSION_TTL_DAYS - 1);
    expect(days).toBeLessThanOrEqual(SESSION_TTL_DAYS);
  });
});

/**
 * A new personal access token expires after 90 days unless the person explicitly
 * chose "never" (`expiresInDays: null`). Omitting the field is not a choice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TOKEN_EXPIRY_DAYS } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createRepoAgent, mintAgentToken } from './repo-agents.js';
import { createToken } from './tokens.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
const rnd = () => Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label}-${Date.now()}-${rnd()}@example.test`, state: 'active', name: label })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user', sessionId: `web-${rnd()}` };
}

const daysFromNow = (iso: string | null) =>
  iso === null ? null : (new Date(iso).getTime() - Date.now()) / DAY;

describe.skipIf(!hasDatabase)('personal access token expiry (real postgres)', () => {
  let owner: Actor;
  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('te-owner');
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  it('defaults to 90 days when the caller says nothing', async () => {
    expect(DEFAULT_TOKEN_EXPIRY_DAYS).toBe(90);
    const token = await createToken(owner, { name: 'default' });
    expect(daysFromNow(token.expiresAt)).toBeGreaterThan(89.9);
    expect(daysFromNow(token.expiresAt)).toBeLessThan(90.1);
  });

  it('keeps an explicit number of days, and an explicit "never"', async () => {
    const week = await createToken(owner, { name: 'week', expiresInDays: 7 });
    expect(daysFromNow(week.expiresAt)).toBeGreaterThan(6.9);
    expect(daysFromNow(week.expiresAt)).toBeLessThan(7.1);
    const never = await createToken(owner, { name: 'never', expiresInDays: null });
    expect(never.expiresAt).toBeNull();
  });

  it('applies the same default over REST and to agent tokens', async () => {
    const session = await createSession(owner.user);
    const post = async (path: string, body: unknown) => {
      const res = await createApp().request(path, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE}=${session.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: { expiresAt: string | null } }).token;
    };
    expect(daysFromNow((await post('/api/tokens', { name: 'rest' })).expiresAt)).toBeCloseTo(90, 0);
    expect(
      (await post('/api/tokens', { name: 'rest-never', expiresInDays: null })).expiresAt,
    ).toBeNull();

    const agent = await createRepoAgent(owner, { name: `Expiry ${rnd()}` });
    expect(daysFromNow((await mintAgentToken(owner, agent.id, 'bound')).expiresAt)).toBeCloseTo(
      90,
      0,
    );
    const route = await post(`/api/repo-agents/${agent.id}/connections`, {
      name: 'bound-never',
      expiresInDays: null,
    });
    expect(route.expiresAt).toBeNull();
    expect((await mintAgentToken(owner, agent.id, 'bound-30', 30)).expiresAt).not.toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { hashSecret } from './crypto.js';
import { createApp } from '../app.js';
import { sweepAuthRetention } from './retention.js';
import { must } from '../errors.js';

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
describe.skipIf(!process.env['DATABASE_URL'])('auth retention (isolated postgres)', () => {
  const database = `omr_retention_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let scratchUrl: string;
  let userId: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    scratchUrl = url.toString();
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: scratchUrl,
        SESSION_SECRET: 'retention-only-test-secret-not-for-real-use',
      }),
    );
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: 'retention@example.test', state: 'active' })
      .returning();
    userId = must(user).id;
  });
  beforeEach(async () => {
    await getDb().execute(
      sql`TRUNCATE sessions, login_codes, login_code_limits, oauth_codes, oauth_tokens CASCADE`,
    );
  });
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('sweeps idle OAuth client registrations, never one holding something live', async () => {
    await getDb().execute(sql`TRUNCATE oauth_clients`);
    const client = async (
      label: string,
      createdDaysAgo: number,
      lastUsedDaysAgo: number | null,
    ) => {
      const clientId = `omr_client_${label}`;
      await getDb()
        .insert(schema.oauthClients)
        .values({
          clientId,
          redirectUris: ['http://localhost/cb'],
          createdAt: daysAgo(createdDaysAgo),
          lastUsedAt: lastUsedDaysAgo === null ? null : daysAgo(lastUsedDaysAgo),
        });
      return clientId;
    };
    const neverUsedOld = await client('never_old', 31, null);
    const neverUsedYoung = await client('never_young', 29, null);
    const idle = await client('idle', 400, 181);
    const recent = await client('recent', 400, 179);
    // Idle by the clock, but a refresh token inside its window says a device
    // still holds this grant — and will come back to the token endpoint.
    const idleButLive = await client('idle_live', 400, 181);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: randomUUID(),
        refreshTokenHash: randomUUID(),
        clientId: idleButLive,
        userId,
        scope: 'radars:read',
        expiresAt: daysAgo(1),
        createdAt: daysAgo(2),
      });
    // Never used and old, but a consent was approved a moment ago.
    const pendingCode = await client('pending_code', 31, null);
    await getDb()
      .insert(schema.oauthCodes)
      .values({
        userId,
        clientId: pendingCode,
        codeHash: randomUUID(),
        codeChallenge: 'challenge',
        redirectUri: 'http://localhost/cb',
        expiresAt: daysAgo(-0.003),
      });

    expect((await sweepAuthRetention()).oauth_clients).toBe(2);
    const left = (await getDb().select().from(schema.oauthClients)).map((c) => c.clientId).sort();
    expect(left).toEqual([neverUsedYoung, recent, idleButLive, pendingCode].sort());
    expect(left).not.toContain(neverUsedOld);
    expect(left).not.toContain(idle);
  });

  it('marks a client used when it redeems or refreshes, at most hourly', async () => {
    await getDb().execute(sql`TRUNCATE oauth_clients`);
    const clientId = 'omr_client_refreshing';
    await getDb()
      .insert(schema.oauthClients)
      .values({ clientId, redirectUris: ['http://localhost/cb'], lastUsedAt: daysAgo(100) });
    const refresh = randomUUID();
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: randomUUID(),
        refreshTokenHash: hashSecret(refresh),
        clientId,
        userId,
        scope: 'radars:read',
        scopeConsented: true,
        expiresAt: daysAgo(-0.01),
      });
    const res = await createApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const [row] = await getDb()
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId));
    expect(Date.now() - must(must(row).lastUsedAt).getTime()).toBeLessThan(60_000);
  });

  it('removes stale codes/sessions/windows and preserves usable and recent rows', async () => {
    for (const age of [-1, 0.05, 2]) {
      await getDb()
        .insert(schema.sessions)
        .values({ userId, tokenHash: randomUUID(), expiresAt: daysAgo(age) });
      await getDb()
        .insert(schema.loginCodes)
        .values({ email: `${age}@test.test`, codeHash: randomUUID(), expiresAt: daysAgo(age) });
      await getDb()
        .insert(schema.oauthCodes)
        .values({
          userId,
          clientId: 'test',
          codeHash: randomUUID(),
          codeChallenge: 'challenge',
          redirectUri: 'http://localhost/callback',
          expiresAt: daysAgo(age),
        });
      await getDb()
        .insert(schema.loginCodeLimits)
        .values({ email: `${age}@test.test`, windowStartedAt: daysAgo(age) });
    }
    expect(await sweepAuthRetention()).toMatchObject({
      sessions: 2,
      login_codes: 1,
      oauth_codes: 1,
      login_code_limits: 1,
    });
    expect(await getDb().select().from(schema.sessions)).toHaveLength(1);
    expect(await getDb().select().from(schema.loginCodeLimits)).toHaveLength(2);
  });

  it('preserves valid refresh grants after access expiry and they can still rotate', async () => {
    const validRefresh = randomUUID();
    const rows = await getDb()
      .insert(schema.oauthTokens)
      .values([
        {
          userId,
          clientId: 'test',
          accessTokenHash: randomUUID(),
          refreshTokenHash: hashSecret(validRefresh),
          expiresAt: daysAgo(8),
          createdAt: daysAgo(20),
        },
        // Past its refresh window and the evidence margin: swept.
        {
          userId,
          clientId: 'test',
          accessTokenHash: randomUUID(),
          refreshTokenHash: randomUUID(),
          expiresAt: daysAgo(38),
          createdAt: daysAgo(39),
        },
        // Rotated, revoked and merely expired rows inside the window are reuse
        // evidence and stay.
        {
          userId,
          clientId: 'test',
          accessTokenHash: randomUUID(),
          refreshTokenHash: null,
          expiresAt: daysAgo(8),
          createdAt: daysAgo(8),
        },
        {
          userId,
          clientId: 'test',
          accessTokenHash: randomUUID(),
          refreshTokenHash: randomUUID(),
          expiresAt: daysAgo(-1),
          revokedAt: daysAgo(8),
          createdAt: daysAgo(29),
        },
        {
          userId,
          clientId: 'test',
          accessTokenHash: randomUUID(),
          refreshTokenHash: randomUUID(),
          expiresAt: daysAgo(30),
          createdAt: daysAgo(31),
        },
      ])
      .returning();
    expect((await sweepAuthRetention()).oauth_tokens).toBe(1);
    expect((await getDb().select().from(schema.oauthTokens)).map((row) => row.id).sort()).toEqual(
      [must(rows[0]).id, must(rows[2]).id, must(rows[3]).id, must(rows[4]).id].sort(),
    );
    const response = await createApp().request('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: validRefresh,
        client_id: 'test',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('refresh_token');
  });

  it('keeps a rotated row long enough that a replay on day 8 still revokes the successor', async () => {
    const stolen = randomUUID();
    const [old] = await getDb()
      .insert(schema.oauthTokens)
      .values({
        userId,
        clientId: 'replay',
        accessTokenHash: randomUUID(),
        refreshTokenHash: hashSecret(stolen),
        expiresAt: daysAgo(-1),
      })
      .returning();
    const rotate = () =>
      createApp().request('/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: stolen,
          client_id: 'replay',
        }),
      });
    expect((await rotate()).status).toBe(200);
    // Eight days pass: the access token is long dead, the old row is rotated.
    await getDb().execute(
      sql`UPDATE oauth_tokens SET created_at = ${daysAgo(8)}, expires_at = ${daysAgo(8)} WHERE id = ${must(old).id}`,
    );
    expect((await sweepAuthRetention()).oauth_tokens).toBe(0);
    const replay = await rotate();
    expect(replay.status).toBe(400);
    const live = await getDb()
      .select()
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.clientId, 'replay'));
    expect(live).toHaveLength(2);
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('sweeps a rotated row once it is past the refresh window plus the margin', async () => {
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        userId,
        clientId: 'old',
        accessTokenHash: randomUUID(),
        refreshTokenHash: null,
        previousRefreshHash: randomUUID(),
        expiresAt: daysAgo(40),
        createdAt: daysAgo(38),
      });
    expect((await sweepAuthRetention()).oauth_tokens).toBe(1);
  });

  it('limits each batch and does not wait on a window being refreshed', async () => {
    await getDb()
      .insert(schema.loginCodes)
      .values(
        Array.from({ length: 7 }, () => ({
          email: 'expired@test.test',
          codeHash: randomUUID(),
          expiresAt: daysAgo(2),
        })),
      );
    await getDb()
      .insert(schema.loginCodeLimits)
      .values({ email: 'inflight@test.test', windowStartedAt: daysAgo(2) });
    const issuer = new pg.Client({ connectionString: scratchUrl });
    await issuer.connect();
    await issuer.query('BEGIN');
    await issuer.query('UPDATE login_code_limits SET window_started_at = now() WHERE email = $1', [
      'inflight@test.test',
    ]);
    try {
      expect(await sweepAuthRetention(3)).toMatchObject({ login_codes: 3, login_code_limits: 0 });
      expect(await getDb().select().from(schema.loginCodes)).toHaveLength(4);
    } finally {
      await issuer.query('COMMIT');
      await issuer.end();
    }
    expect((await sweepAuthRetention(3)).login_code_limits).toBe(0);
    expect(
      await getDb()
        .select()
        .from(schema.loginCodeLimits)
        .where(eq(schema.loginCodeLimits.email, 'inflight@test.test')),
    ).toHaveLength(1);
  });
});

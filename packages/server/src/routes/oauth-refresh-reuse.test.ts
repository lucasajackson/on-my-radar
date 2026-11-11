/**
 * A refresh token is single-use. Presenting a retired one means two parties hold
 * the same credential, so the whole grant is revoked — not only the replayed
 * token, which would leave the thief's copy of the successor working.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
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

describe.skipIf(!hasDatabase)('refresh token reuse revokes the replayed family', () => {
  let app: ReturnType<typeof createApp>;
  let userId: string;
  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    userId = (await makeUser('refresh-reuse')).id;
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  async function refresh(token: string, extra: Record<string, string> = {}) {
    const res = await app.request(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: token, ...extra }),
    );
    return { res, body: (await res.json()) as Record<string, string> };
  }

  it('rotates once, then a replay kills the successor access and refresh tokens too', async () => {
    const grant = await mintGrant(userId, 'omr_client_reuse_a');
    const first = await refresh(grant.refresh);
    expect(first.res.status).toBe(200);
    const successor = first.body as { access_token: string; refresh_token: string };
    expect(await resolveBearerToken(successor.access_token)).not.toBeNull();

    const replay = await refresh(grant.refresh);
    expect(replay.res.status).toBe(400);
    expect(replay.body['error']).toBe('invalid_grant');
    expect(replay.body['error_description']).toMatch(/already been used/);

    expect(await resolveBearerToken(successor.access_token)).toBeNull();
    expect(await resolveBearerToken(grant.access)).toBeNull();
    const dead = await refresh(successor.refresh_token);
    expect(dead.res.status).toBe(400);
    expect(dead.body['error']).toBe('invalid_grant');
  });

  it('leaves another client of the same user untouched', async () => {
    const mine = await mintGrant(userId, 'omr_client_reuse_b');
    const other = await mintGrant(userId, 'omr_client_reuse_other');
    expect((await refresh(mine.refresh)).res.status).toBe(200);
    expect((await refresh(mine.refresh)).res.status).toBe(400);
    expect(await resolveBearerToken(other.access)).not.toBeNull();
    expect((await refresh(other.refresh)).res.status).toBe(200);
  });

  it('does not let a different client revoke a grant by replaying its token', async () => {
    const grant = await mintGrant(userId, 'omr_client_reuse_c');
    const first = await refresh(grant.refresh);
    const successor = first.body as { access_token: string };
    const impostor = await refresh(grant.refresh, { client_id: 'omr_client_impostor' });
    expect(impostor.res.status).toBe(400);
    expect(await resolveBearerToken(successor.access_token)).not.toBeNull();
  });

  it('two simultaneous refreshes of one token leave exactly no live grant', async () => {
    const grant = await mintGrant(userId, 'omr_client_reuse_race');
    const results = await Promise.all([refresh(grant.refresh), refresh(grant.refresh)]);
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses).toEqual([200, 400]);
    const winner = results.find((r) => r.res.status === 200)?.body as { access_token: string };
    expect(await resolveBearerToken(winner.access_token)).toBeNull();
  });

  /** A consented authorization, redeemed through the real token endpoint: a new family. */
  async function authorize(clientId: string): Promise<{ access: string; refresh: string }> {
    const verifier = randomToken(32);
    const code = randomToken(32);
    await getDb()
      .insert(schema.oauthCodes)
      .values({
        codeHash: hashSecret(code),
        clientId,
        userId,
        redirectUri: 'http://127.0.0.1:9999/cb',
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        scope: TOKEN_SCOPES.join(' '),
        expiresAt: new Date(Date.now() + 300_000),
      });
    const res = await app.request(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:9999/cb',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    return { access: body.access_token, refresh: body.refresh_token };
  }

  it('revokes only the replayed family: a re-authorization survives a stale replay', async () => {
    const client = `omr_client_family_a_${randomUUID()}`;
    const other = await mintGrant(userId, `omr_client_family_other_${randomUUID()}`);

    const f1 = await authorize(client);
    const f1next = (await refresh(f1.refresh)).body as {
      access_token: string;
      refresh_token: string;
    };
    // Replaying the rotated-out token kills F1 and everything it rotated into.
    expect((await refresh(f1.refresh)).res.status).toBe(400);
    expect(await resolveBearerToken(f1next.access_token)).toBeNull();
    expect((await refresh(f1next.refresh_token)).res.status).toBe(400);

    // The person authorizes again: a fresh family.
    const f2 = await authorize(client);
    expect(await resolveBearerToken(f2.access)).not.toBeNull();

    // The stale F1 token is replayed again. F2 must not notice.
    const stale = await refresh(f1.refresh);
    expect(stale.res.status).toBe(400);
    expect(stale.body['error']).toBe('invalid_grant');
    expect(await resolveBearerToken(f2.access)).not.toBeNull();
    const f2next = await refresh(f2.refresh);
    expect(f2next.res.status).toBe(200);

    // A second client of the same user is untouched throughout.
    expect(await resolveBearerToken(other.access)).not.toBeNull();
    expect((await refresh(other.refresh)).res.status).toBe(200);
  });

  it('carries the family forward through rotation and starts a new one per authorization', async () => {
    const client = `omr_client_family_b_${randomUUID()}`;
    const first = await authorize(client);
    const second = await authorize(client);
    await refresh(first.refresh);
    await refresh(second.refresh);
    const rows = await getDb()
      .select({ family: schema.oauthTokens.familyId })
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.clientId, client));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.family, (counts.get(r.family) ?? 0) + 1);
    expect(rows).toHaveLength(4);
    expect([...counts.values()].sort()).toEqual([2, 2]);
  });

  it('a replay of an already-dead family is a no-op: no audit row, unredeemed codes untouched', async () => {
    const client = `omr_client_family_c_${randomUUID()}`;
    const f1 = await authorize(client);
    await refresh(f1.refresh);
    expect((await refresh(f1.refresh)).res.status).toBe(400); // revokes F1
    const audits = async () =>
      (
        await getDb()
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, 'oauth.grant.reuse_revoke'))
      ).length;
    const before = await audits();

    // A pending authorization the person has just approved.
    const pendingCode = randomToken(32);
    await getDb()
      .insert(schema.oauthCodes)
      .values({
        codeHash: hashSecret(pendingCode),
        clientId: client,
        userId,
        redirectUri: 'http://127.0.0.1:9999/cb',
        codeChallenge: 'x',
        scope: TOKEN_SCOPES.join(' '),
        expiresAt: new Date(Date.now() + 300_000),
      });
    expect((await refresh(f1.refresh)).res.status).toBe(400);
    expect(await audits()).toBe(before);
    const [pending] = await getDb()
      .select()
      .from(schema.oauthCodes)
      .where(eq(schema.oauthCodes.codeHash, hashSecret(pendingCode)));
    expect(pending?.consumedAt).toBeNull();
  });
});

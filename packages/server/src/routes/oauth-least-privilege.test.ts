/**
 * A new OAuth consent grants read and write; manage is a box the person ticks.
 * Grants made before that keep what they were given, through refresh.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { REFRESH_TOKEN_TTL_MS } from '../auth/lifetimes.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createRadar, shareRadar } from '../services/radars.js';
import { listGrants } from '../services/tokens.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
process.env['DATABASE_URL'] ??= 'postgres://unused';

const REDIRECT = 'http://127.0.0.1:9999/cb';
const DAY = 24 * 3_600_000;

describe.skipIf(!hasDatabase)('OAuth least privilege (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let human: Actor;
  let cookie: string;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `least-${Date.now()}@example.test`, state: 'active' })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    human = { user, kind: 'user' };
    cookie = `${SESSION_COOKIE}=${(await createSession(user)).token}`;
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  /** Consent (optionally with a scope) and redeem, through the real endpoints. */
  async function connect(scope?: string) {
    const clientId = `omr_client_lp_${randomToken(6)}`;
    await getDb()
      .insert(schema.oauthClients)
      .values({ clientId, redirectUris: [REDIRECT] });
    const verifier = randomToken(32);
    const decision = await app.request('/oauth/authorize/decision', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        approve: true,
        ...(scope === undefined ? {} : { scope }),
      }),
    });
    expect(decision.status).toBe(200);
    const { redirectTo } = (await decision.json()) as { redirectTo: string };
    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(redirectTo).searchParams.get('code') ?? '',
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; scope: string };
    const bearer = await resolveBearerToken(body.access_token);
    if (!bearer) throw new Error('the new grant does not authenticate');
    const actor: Actor = {
      user: bearer.user,
      kind: 'agent',
      tokenId: bearer.tokenId,
      scopes: bearer.scopes,
      ceiling: bearer.ceiling,
    };
    return { actor, scope: body.scope };
  }

  it('a client that asks for nothing gets read and write, and share_radar says how to reconnect', async () => {
    const { actor, scope } = await connect();
    expect(scope).toBe('radars:read radars:write');
    expect(actor.ceiling).toBe('editor');
    const radar = await createRadar(human, { name: `LP ${Math.random()}` });
    const err = await shareRadar(actor, radar.id, 'ada@example.test', 'viewer').catch(
      (e: unknown) => e as { status?: number; message: string },
    );
    expect(err).toMatchObject({ status: 403 });
    expect((err as Error).message).toMatch(/radars:manage.*reconnect/i);
  });

  it('manage is granted only when the consent screen sends it', async () => {
    expect((await connect(TOKEN_SCOPES.join(' '))).actor.ceiling).toBe('owner');
  });

  /** A grant row as written before this change, refreshed through the real endpoint. */
  async function refreshed(row: { scope: string; scopeConsented: boolean }) {
    const refresh = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(randomToken(32)),
        refreshTokenHash: hashSecret(refresh),
        clientId: `omr_client_old_${randomToken(6)}`,
        userId: human.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...row,
      });
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; scope: string };
    return { scope: body.scope, ceiling: (await resolveBearerToken(body.access_token))?.ceiling };
  }

  it('an old consented grant with manage still refreshes with manage', async () => {
    const out = await refreshed({ scope: TOKEN_SCOPES.join(' '), scopeConsented: true });
    expect(out).toEqual({ scope: 'radars:read radars:write radars:manage', ceiling: 'owner' });
  });

  it('an old unconsented grant stays unenforced, so it still has manage after a refresh', async () => {
    const out = await refreshed({ scope: 'radars:read radars:write', scopeConsented: false });
    expect(out.ceiling).toBe('owner');
  });

  it('Settings lists a grant inside its window and omits one past it', async () => {
    const mint = async (clientId: string, ageDays: number) =>
      getDb()
        .insert(schema.oauthTokens)
        .values({
          accessTokenHash: hashSecret(randomToken(32)),
          refreshTokenHash: hashSecret(randomToken(32)),
          clientId,
          userId: human.user.id,
          scope: 'radars:read radars:write',
          scopeConsented: true,
          createdAt: new Date(Date.now() - ageDays * DAY),
          expiresAt: new Date(Date.now() - ageDays * DAY + 3_600_000),
        });
    await mint('omr_client_inside', 29);
    await mint('omr_client_past', 31);
    const ids = (await listGrants(human)).map((g) => g.clientId);
    expect(ids).toContain('omr_client_inside');
    expect(ids).not.toContain('omr_client_past');
  });

  it('a re-authorized client lapses from its newest grant, not its oldest', async () => {
    const mint = (ageDays: number) =>
      getDb()
        .insert(schema.oauthTokens)
        .values({
          accessTokenHash: hashSecret(randomToken(32)),
          refreshTokenHash: hashSecret(randomToken(32)),
          clientId: 'omr_client_twice',
          userId: human.user.id,
          scope: 'radars:read radars:write',
          scopeConsented: true,
          createdAt: new Date(Date.now() - ageDays * DAY),
          expiresAt: new Date(Date.now() - ageDays * DAY + 3_600_000),
        });
    await mint(29);
    await mint(1);
    const grant = (await listGrants(human)).find((g) => g.clientId === 'omr_client_twice');
    expect(new Date(grant?.lapsesAt ?? 0).getTime()).toBeCloseTo(
      Date.now() - DAY + REFRESH_TOKEN_TTL_MS,
      -4,
    );
  });
});

/**
 * Check-then-act, and the five places it was reachable.
 *
 * Every case here has the same shape: read a row, decide from what was read,
 * then write keyed only on `id`. Two requests that arrive together both read the
 * same row, both decide they are allowed, and both write. Node interleaves at
 * every `await`, so none of this needed more than one replica to happen — more
 * replicas only removes the accidental serialisation that made it rare.
 *
 * These run concurrent operations against a real database because that is the
 * only place the property exists. A mock has one caller by construction and
 * would pass against every version of this code, including the broken one.
 *
 * Each assertion is written as a count rather than a boolean -- "exactly one
 * succeeded", not "it succeeded" -- because the bug being fenced is precisely
 * that *both* succeeded, and a boolean cannot tell those apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { LOGIN_CODE } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { issueLoginCode, RateLimitedError, verifyLoginCode } from './codes.js';
import { hashSecret, randomToken } from './crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { lockGrant, revokeGrant } from '../services/tokens.js';
import { must } from '../errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const freshEmail = () => `race-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

describe.skipIf(!hasDatabase)('concurrent redemption', () => {
  let app: ReturnType<typeof createApp>;
  let userId: string;

  beforeAll(async () => {
    app = createApp();
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: freshEmail(), state: 'active' })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    userId = user.id;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /** A single-use code, submitted twice at once, must sign in once. */
  it('redeems a login code exactly once', async () => {
    const email = freshEmail();
    const { code } = await issueLoginCode(email, null);

    const results = await Promise.all([
      verifyLoginCode(email, code),
      verifyLoginCode(email, code),
      verifyLoginCode(email, code),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  /**
   * The cap has to cost an attacker one increment per *guess*. Computed in
   * JavaScript from an earlier read it costs one per *burst*, which is the
   * difference between a bound and none.
   */
  it('counts every wrong guess, not every burst of them', async () => {
    const email = freshEmail();
    await issueLoginCode(email, null);

    const wrong = Array.from({ length: 4 }, () => verifyLoginCode(email, '000001'));
    await Promise.all(wrong);

    const [row] = await getDb()
      .select({ attempts: schema.loginCodes.attempts })
      .from(schema.loginCodes)
      .where(eq(schema.loginCodes.email, email))
      .limit(1);

    expect(row?.attempts).toBe(4);
  });

  /** The positive twin: the cap still stops the fifth guess. */
  it('still refuses once the cap is reached', async () => {
    const email = freshEmail();
    const { code } = await issueLoginCode(email, null);
    for (let i = 0; i < LOGIN_CODE.maxAttempts; i += 1) {
      await verifyLoginCode(email, '000001');
    }
    // Even the *correct* code is refused now, which is the point of the cap.
    expect(await verifyLoginCode(email, code)).toMatchObject({ ok: false });
  });

  /**
   * The ceiling, asserted under a concurrent burst — exactly.
   *
   * This assertion was deliberately impossible against the previous shape,
   * where the count was folded into a conditional INSERT and READ COMMITTED
   * left a gap the comment had to disclose. The window is a row now
   * (`login_code_limits`, charged webhook-style in one statement whose CASE
   * arms read the pre-update values), so concurrent charges serialise on the
   * row for the duration of one statement and the count cannot miss. Twelve at
   * once, six through, six refused: any other split is a regression.
   */
  it('holds the per-address ceiling exactly, even under a concurrent burst', async () => {
    const email = freshEmail();
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => issueLoginCode(email, null)),
    );
    const issued = attempts.filter((r) => r.status === 'fulfilled').length;
    const refused = attempts
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as unknown)
      .filter((reason): reason is RateLimitedError => reason instanceof RateLimitedError);

    expect(issued).toBe(LOGIN_CODE.requestsPerHour);
    expect(refused).toHaveLength(12 - LOGIN_CODE.requestsPerHour);
    // Retry-After is computed from the window row rather than guessed, so it
    // must be a real duration within the hour, not a flat constant.
    for (const err of refused) {
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  /**
   * A refused request must not retire the code somebody is mid-way through
   * typing -- otherwise holding down the button is a way to lock a person out
   * of their own account.
   */
  it('leaves the live code alone when it refuses', async () => {
    const email = freshEmail();
    let live = '';
    for (let i = 0; i < LOGIN_CODE.requestsPerHour; i += 1) {
      live = (await issueLoginCode(email, null)).code;
    }
    await expect(issueLoginCode(email, null)).rejects.toBeInstanceOf(RateLimitedError);
    expect(await verifyLoginCode(email, live)).toMatchObject({ ok: true });
  });

  /** An authorization code, redeemed twice at once, must mint one grant. */
  it('redeems an OAuth authorization code exactly once', async () => {
    const clientId = `omr_client_race_${randomUUID().slice(0, 8)}`;
    await getDb()
      .insert(schema.oauthClients)
      .values({ clientId, clientName: 'race', redirectUris: ['http://127.0.0.1:9999/cb'] });

    const verifier = randomToken(32);
    const code = randomToken(32);
    await getDb()
      .insert(schema.oauthCodes)
      .values({
        codeHash: hashSecret(code),
        clientId,
        userId,
        redirectUri: 'http://127.0.0.1:9999/cb',
        codeChallenge: s256(verifier),
        codeChallengeMethod: 'S256',
        scope: 'radars:read',
        expiresAt: new Date(Date.now() + 300_000),
      });

    const redeem = () =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          redirect_uri: 'http://127.0.0.1:9999/cb',
          code_verifier: verifier,
        }).toString(),
      });

    const [a, b] = await Promise.all([redeem(), redeem()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const minted = await getDb()
      .select({ id: schema.oauthTokens.id })
      .from(schema.oauthTokens)
      .where(and(eq(schema.oauthTokens.clientId, clientId), eq(schema.oauthTokens.userId, userId)));
    expect(minted).toHaveLength(1);
  });

  /**
   * A consent approved just before a disconnect must not mint a credential
   * after it — neither when redeemed later, nor when its redemption is already
   * in flight while the disconnect holds the grant.
   */
  it('burns an unredeemed code when its grant is disconnected, even mid-redemption', async () => {
    const clientId = `omr_client_rev_${randomUUID().slice(0, 8)}`;
    const redirectUri = 'http://127.0.0.1:9999/cb';
    await getDb()
      .insert(schema.oauthClients)
      .values({ clientId, clientName: 'race-revoke', redirectUris: [redirectUri] });
    const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, userId));
    const actor = { user: must(user), kind: 'user' as const };

    const liveToken = () =>
      getDb()
        .insert(schema.oauthTokens)
        .values({
          accessTokenHash: hashSecret(randomToken(32)),
          refreshTokenHash: hashSecret(randomToken(32)),
          clientId,
          userId,
          scope: 'radars:read',
          scopeConsented: true,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
    const approve = async () => {
      const verifier = randomToken(32);
      const code = randomToken(32);
      await getDb()
        .insert(schema.oauthCodes)
        .values({
          codeHash: hashSecret(code),
          clientId,
          userId,
          redirectUri,
          codeChallenge: s256(verifier),
          codeChallengeMethod: 'S256',
          scope: 'radars:read',
          expiresAt: new Date(Date.now() + 300_000),
        });
      return { code, verifier };
    };
    const redeem = ({ code, verifier }: { code: string; verifier: string }) =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      });
    const liveTokens = async () =>
      (
        await getDb()
          .select({ id: schema.oauthTokens.id })
          .from(schema.oauthTokens)
          .where(
            and(
              eq(schema.oauthTokens.clientId, clientId),
              eq(schema.oauthTokens.userId, userId),
              isNull(schema.oauthTokens.revokedAt),
            ),
          )
      ).length;

    // Approved, then disconnected, then redeemed.
    await liveToken();
    const first = await approve();
    await revokeGrant(actor, clientId);
    expect((await redeem(first)).status).toBe(400);
    expect(await liveTokens()).toBe(0);

    // The loser's write: a redemption already past its read, arriving while a
    // disconnect holds the grant lock, must see that disconnect's burn.
    const second = await approve();
    let redemption: Response | Promise<Response> | undefined;
    await getDb().transaction(async (tx) => {
      await lockGrant(tx, userId, clientId);
      redemption = redeem(second);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await tx
        .update(schema.oauthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(schema.oauthCodes.clientId, clientId), isNull(schema.oauthCodes.consumedAt)));
    });
    expect((await must(redemption)).status).toBe(400);
    expect(await liveTokens()).toBe(0);
  });

  /**
   * One refresh token must rotate into one grant. Two live grants from one
   * credential would also disable the replay defence, which works by a replayed
   * token matching no row.
   */
  it('rotates a refresh token exactly once', async () => {
    const clientId = `omr_client_ref_${randomUUID().slice(0, 8)}`;
    await getDb()
      .insert(schema.oauthClients)
      .values({ clientId, clientName: 'race-refresh', redirectUris: ['http://127.0.0.1:9999/cb'] });

    const refresh = randomToken(32);
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(refresh),
        clientId,
        userId,
        scope: 'radars:read',
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

    const rotate = () =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: clientId,
        }).toString(),
      });

    const [a, b] = await Promise.all([rotate(), rotate()]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);

    // The access token is deliberately untouched by rotation, which is what
    // keeps the loser able to make progress rather than looping. Asserted
    // because it is the property that makes refusing the loser safe at all.
    const rows = await getDb()
      .select({ id: schema.oauthTokens.id })
      .from(schema.oauthTokens)
      .where(
        and(
          eq(schema.oauthTokens.accessTokenHash, hashSecret(access)),
          eq(schema.oauthTokens.clientId, clientId),
        ),
      );
    expect(rows).toHaveLength(1);

    // Rotate-and-mint commit together, so the grant family is exactly two rows:
    // the predecessor (hash nulled, access token live) and one successor. A
    // third row would mean the loser also minted; a lone predecessor would mean
    // rotation destroyed the credential without replacing it — the pod-death
    // shape this transaction exists to make impossible.
    const family = await getDb()
      .select({ id: schema.oauthTokens.id })
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.clientId, clientId));
    expect(family).toHaveLength(2);
  });
});

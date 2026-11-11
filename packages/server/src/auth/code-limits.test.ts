/** The attempt ceiling and replacement invariant must hold under contention. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, isNull, and, sql } from 'drizzle-orm';
import { LOGIN_CODE } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { issueLoginCode, lockAddress, RateLimitedError, verifyLoginCode } from './codes.js';
import { hashSecret } from './crypto.js';
import { must } from '../errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
const freshEmail = () => `code-review-${randomUUID()}@example.test`;
const wrongCode = (code: string) => (code === '000001' ? '000002' : '000001');

describe.skipIf(!hasDatabase)('login code bounds under contention', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  it('compares only five of a concurrent burst of wrong guesses and retires the code', async () => {
    const email = freshEmail();
    const { code } = await issueLoginCode(email, null);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => verifyLoginCode(email, wrongCode(code))),
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.filter((r) => !r.ok && r.reason === 'mismatch')).toHaveLength(
      LOGIN_CODE.maxAttempts - 1,
    );
    expect(results.filter((r) => !r.ok && r.reason === 'too_many_attempts')).toHaveLength(1);
    const [row] = await getDb()
      .select()
      .from(schema.loginCodes)
      .where(eq(schema.loginCodes.email, email));
    expect(row?.attempts).toBe(LOGIN_CODE.maxAttempts);
    expect(row?.consumedAt).not.toBeNull();
    expect(await verifyLoginCode(email, code)).toMatchObject({ ok: false });
  });

  it('allows the correct fifth attempt exactly once', async () => {
    const email = freshEmail();
    const { code } = await issueLoginCode(email, null);
    for (let i = 0; i < LOGIN_CODE.maxAttempts - 1; i++) {
      expect(await verifyLoginCode(email, wrongCode(code))).toEqual({
        ok: false,
        reason: 'mismatch',
      });
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyLoginCode(email, code)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const [row] = await getDb()
      .select()
      .from(schema.loginCodes)
      .where(eq(schema.loginCodes.email, email));
    expect(row?.attempts).toBe(LOGIN_CODE.maxAttempts);
  });

  it('keeps at most maxLive codes while concurrent issuance holds the exact request ceiling', async () => {
    const email = freshEmail();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => issueLoginCode(email, null)),
    );
    const issued = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    expect(issued).toHaveLength(LOGIN_CODE.requestsPerHour);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(RateLimitedError);
    }
    const live = await getDb()
      .select()
      .from(schema.loginCodes)
      .where(and(eq(schema.loginCodes.email, email), isNull(schema.loginCodes.consumedAt)));
    expect(live).toHaveLength(LOGIN_CODE.maxLive);
    const last = issued.find((value) => hashSecret(value.code) === live[0]?.codeHash);
    expect(last).toBeDefined();
    expect(await verifyLoginCode(email, must(last).code)).toEqual({ ok: true });
  });

  it('keeps earlier codes valid after a resend, and using one retires them all', async () => {
    const email = freshEmail();
    const first = (await issueLoginCode(email, null)).code;
    const second = (await issueLoginCode(email, null)).code;
    const third = (await issueLoginCode(email, null)).code;
    expect(await verifyLoginCode(email, first)).toEqual({ ok: true });
    expect(await verifyLoginCode(email, second)).toMatchObject({ ok: false });
    expect(await verifyLoginCode(email, third)).toMatchObject({ ok: false });
  });

  it('counts the attempt limit across every live code of the address', async () => {
    const email = freshEmail();
    const first = (await issueLoginCode(email, null)).code;
    const wrong = wrongCode(first);
    for (let i = 0; i < 3; i++) await verifyLoginCode(email, wrong);
    const second = (await issueLoginCode(email, null)).code;
    expect(await verifyLoginCode(email, wrongCode(second))).toMatchObject({ reason: 'mismatch' });
    expect(await verifyLoginCode(email, wrongCode(second))).toMatchObject({
      reason: 'too_many_attempts',
    });
    expect(await verifyLoginCode(email, first)).toMatchObject({ ok: false });
    expect(await verifyLoginCode(email, second)).toMatchObject({ ok: false });
  });

  it('refuses an expired code while a live one still works', async () => {
    const email = freshEmail();
    const old = (await issueLoginCode(email, null)).code;
    await getDb().execute(
      sql`UPDATE login_codes SET expires_at = now() - interval '1 second' WHERE email = ${email}`,
    );
    const fresh = (await issueLoginCode(email, null)).code;
    expect(await verifyLoginCode(email, old)).toMatchObject({ ok: false });
    expect(await verifyLoginCode(email, fresh)).toEqual({ ok: true });
  });

  it('retires the oldest code once an address holds more than the cap', async () => {
    const email = freshEmail();
    const codes: string[] = [];
    for (let i = 0; i <= LOGIN_CODE.maxLive; i++)
      codes.push((await issueLoginCode(email, null)).code);
    const live = await getDb()
      .select()
      .from(schema.loginCodes)
      .where(and(eq(schema.loginCodes.email, email), isNull(schema.loginCodes.consumedAt)));
    expect(live).toHaveLength(LOGIN_CODE.maxLive);
    expect(await verifyLoginCode(email, must(codes[0]))).toMatchObject({ ok: false });
    expect(await verifyLoginCode(email, must(codes[1]))).toEqual({ ok: true });
  });

  it('does not refund failures when more codes are issued', async () => {
    const email = freshEmail();
    const first = (await issueLoginCode(email, null)).code;
    for (let i = 0; i < LOGIN_CODE.maxAttempts - 1; i++)
      await verifyLoginCode(email, wrongCode(first));
    for (let i = 0; i < 5; i++) await issueLoginCode(email, null);
    expect(await verifyLoginCode(email, wrongCode(first))).toMatchObject({
      reason: 'too_many_attempts',
    });
  });

  it('charges the daily failure budget once per live code compared', async () => {
    const email = freshEmail();
    for (let i = 0; i < LOGIN_CODE.maxLive; i++) await issueLoginCode(email, null);
    await verifyLoginCode(email, '000001');
    await verifyLoginCode(email, '000001');
    const count = async () =>
      (
        await getDb()
          .select()
          .from(schema.loginVerifyLimits)
          .where(eq(schema.loginVerifyLimits.key, `address:${email}`))
      )[0]?.windowCount;
    await expect(count()).resolves.toBe(2 * LOGIN_CODE.maxLive);
    // Three more misses retire the set (5 guesses x 3 codes = 15 of 20); a new
    // set's two misses then pass the daily ceiling and lock the address.
    for (let i = 0; i < 3; i++) await verifyLoginCode(email, '000001');
    for (let i = 0; i < LOGIN_CODE.maxLive; i++) await issueLoginCode(email, null);
    await verifyLoginCode(email, '000001');
    await verifyLoginCode(email, '000001');
    await expect(verifyLoginCode(email, '000001')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('never compares or charges past the daily budget (19 must not reach 22)', async () => {
    const email = freshEmail();
    const miss = async (n: number) => {
      for (let i = 0; i < n; i++) await verifyLoginCode(email, '000001');
    };
    await issueLoginCode(email, null);
    await miss(4);
    for (let i = 0; i < 2; i++) await issueLoginCode(email, null);
    await miss(1);
    const fresh: string[] = [];
    for (let i = 0; i < LOGIN_CODE.maxLive; i++)
      fresh.push((await issueLoginCode(email, null)).code);
    await miss(4);
    const spent = async () =>
      (
        await getDb()
          .select()
          .from(schema.loginVerifyLimits)
          .where(eq(schema.loginVerifyLimits.key, `address:${email}`))
      )[0]?.windowCount;
    expect(await spent()).toBe(19);
    // One unit left: only the newest code may be compared, so the oldest
    // (right) code is refused and the budget stops at exactly 20.
    expect(await verifyLoginCode(email, must(fresh[0]))).toMatchObject({ ok: false });
    expect(await spent()).toBe(LOGIN_CODE.verifyFailuresPerAddressPerDay);
  });

  it('issues and verifies behind the same per-address lock', async () => {
    const email = freshEmail();
    const { code } = await issueLoginCode(email, null);
    const settled: string[] = [];
    await getDb().transaction(async (tx) => {
      await lockAddress(tx, email);
      const pending = [
        issueLoginCode(email, null).then(() => settled.push('issue')),
        verifyLoginCode(email, wrongCode(code)).then(() => settled.push('verify')),
      ];
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toEqual([]);
      void Promise.all(pending);
    });
    await expect.poll(() => settled.length).toBe(2);
  });

  it('caps one network across many addresses, without charging the addresses it refused', async () => {
    const network = `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < LOGIN_CODE.requestsPerNetworkPerHour; i++) {
      await issueLoginCode(freshEmail(), network, network);
    }
    const victim = freshEmail();
    const refused = await issueLoginCode(victim, network, network).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect((refused as RateLimitedError).scope).toBe('network');
    // The refused request spent none of the victim's own allowance.
    const [window] = await getDb()
      .select()
      .from(schema.loginCodeLimits)
      .where(eq(schema.loginCodeLimits.email, victim));
    expect(window).toBeUndefined();
    // Another network, and a caller with no trusted network, are unaffected.
    await expect(
      issueLoginCode(victim, null, `203.0.113.${Math.floor(Math.random() * 250)}`),
    ).resolves.toBeTruthy();
    await expect(issueLoginCode(freshEmail(), null, null)).resolves.toBeTruthy();
  });
});

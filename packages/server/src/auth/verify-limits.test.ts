/**
 * The verify side of sign-in codes: a per-address daily cap on wrong guesses
 * with a lockout, and a per-network ceiling on verifications.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LOGIN_CODE } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { issueLoginCode, RateLimitedError, verifyLoginCode } from './codes.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
const freshEmail = () => `verify-limit-${randomUUID()}@example.test`;
const wrongCode = (code: string) => (code === '000001' ? '000002' : '000001');
const network = () =>
  `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

/** Fails `n` guesses, minting a new code whenever the last one was retired. */
async function failTimes(email: string, n: number): Promise<string> {
  let { code } = await issueLoginCode(email, null);
  let attempts = 0;
  for (let i = 0; i < n; i++) {
    if (attempts === LOGIN_CODE.maxAttempts) {
      // Unique per call: the per-hour request ceiling is per address, so reset it.
      await getDb().delete(schema.loginCodeLimits).where(eq(schema.loginCodeLimits.email, email));
      ({ code } = await issueLoginCode(email, null));
      attempts = 0;
    }
    await verifyLoginCode(email, wrongCode(code));
    attempts += 1;
  }
  if (attempts === LOGIN_CODE.maxAttempts) {
    await getDb().delete(schema.loginCodeLimits).where(eq(schema.loginCodeLimits.email, email));
    ({ code } = await issueLoginCode(email, null));
  }
  return code;
}

describe.skipIf(!hasDatabase)('verify-side sign-in limits', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  it('locks an address after the daily cap of wrong guesses, even for the right code', async () => {
    const email = freshEmail();
    const code = await failTimes(email, LOGIN_CODE.verifyFailuresPerAddressPerDay);
    const refused = await verifyLoginCode(email, code).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect((refused as RateLimitedError).scope).toBe('locked');
    expect((refused as RateLimitedError).retryAfterSeconds).toBeGreaterThan(23 * 3600);
    // And it stays locked.
    await expect(verifyLoginCode(email, code)).rejects.toBeInstanceOf(RateLimitedError);
  }, 60_000);

  it('does not lock below the cap, and the right code still signs in', async () => {
    const email = freshEmail();
    const code = await failTimes(email, LOGIN_CODE.verifyFailuresPerAddressPerDay - 1);
    expect(await verifyLoginCode(email, code)).toEqual({ ok: true });
  }, 60_000);

  it('leaves other addresses unaffected by a locked one', async () => {
    const locked = freshEmail();
    await failTimes(locked, LOGIN_CODE.verifyFailuresPerAddressPerDay);
    const other = freshEmail();
    const { code } = await issueLoginCode(other, null);
    expect(await verifyLoginCode(other, code)).toEqual({ ok: true });
  }, 60_000);

  it('does not charge an address for a verification with no live code', async () => {
    const email = freshEmail();
    for (let i = 0; i < LOGIN_CODE.verifyFailuresPerAddressPerDay + 5; i++) {
      expect(await verifyLoginCode(email, '123456')).toEqual({ ok: false, reason: 'not_found' });
    }
    const { code } = await issueLoginCode(email, null);
    expect(await verifyLoginCode(email, code)).toEqual({ ok: true });
  });

  it('caps verifications per network, whatever the address', async () => {
    const net = network();
    for (let i = 0; i < LOGIN_CODE.verifiesPerNetworkPerHour; i++) {
      await verifyLoginCode(freshEmail(), '123456', net);
    }
    const refused = await verifyLoginCode(freshEmail(), '123456', net).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect((refused as RateLimitedError).scope).toBe('network');
    // Another network, and a caller with no trusted network, are unaffected.
    await expect(verifyLoginCode(freshEmail(), '123456', network())).resolves.toMatchObject({
      ok: false,
    });
    await expect(verifyLoginCode(freshEmail(), '123456', null)).resolves.toMatchObject({
      ok: false,
    });
  }, 60_000);

  it('answers 429 with Retry-After from the route, keyed on the trusted client IP header', async () => {
    const app = createApp();
    const email = freshEmail();
    await failTimes(email, LOGIN_CODE.verifyFailuresPerAddressPerDay);
    const res = await app.request('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: '123456', client: 'cli' }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);

    const net = network();
    for (let i = 0; i < LOGIN_CODE.verifiesPerNetworkPerHour; i++) {
      await app.request('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': net },
        body: JSON.stringify({ email: freshEmail(), code: '123456', client: 'cli' }),
      });
    }
    const over = await app.request('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': net },
      body: JSON.stringify({ email: freshEmail(), code: '123456', client: 'cli' }),
    });
    expect(over.status).toBe(429);
  }, 60_000);
});

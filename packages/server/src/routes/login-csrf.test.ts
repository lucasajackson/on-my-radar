/**
 * Login CSRF, and the three layers that each stop it.
 *
 * The attack: the attacker requests a code for their own address, then a page
 * of theirs makes the victim's browser POST `{email, code}` to verify-code as a
 * `text/plain` form. The response's `Set-Cookie` signs the victim's browser in
 * as the attacker, and everything the victim captures afterwards lands in the
 * attacker's account. No victim cookie is needed, so `SameSite` does not help.
 *
 * Each layer is asserted on its own, so removing any one of them fails a test
 * here rather than being covered silently by the others.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('login CSRF (real postgres)', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  const json = { 'content-type': 'application/json' };

  /** The attacker's half, done in their own browser: a fresh code and its challenge. */
  async function requestCode(email: string) {
    const res = await app.request('/api/auth/request-code', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    const { devCode } = (await res.json()) as { devCode: string };
    const challenge = res.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('omr_login='))
      ?.split(';')[0];
    if (!challenge) throw new Error('request-code set no challenge cookie');
    return { code: devCode, challenge };
  }

  const verify = (body: Record<string, unknown>, headers: Record<string, string> = json) =>
    app.request('/api/auth/verify-code', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

  const attempts = async (email: string) =>
    (await getDb().select().from(schema.loginCodes).where(eq(schema.loginCodes.email, email)))[0]
      ?.attempts;

  it('refuses a body that is not declared JSON — the only kind a form can send', async () => {
    const email = `csrf-type-${randomUUID()}@example.test`;
    const { code, challenge } = await requestCode(email);
    const res = await verify({ email, code }, { 'content-type': 'text/plain', cookie: challenge });
    expect(res.status).toBe(415);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('omr_session='))).toBe(false);
  });

  it('refuses a write another site sent, by Sec-Fetch-Site or by Origin', async () => {
    const email = `csrf-site-${randomUUID()}@example.test`;
    const { code, challenge } = await requestCode(email);
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://attacker.example' },
      { origin: 'null' },
    ]) {
      const res = await verify({ email, code }, { ...json, cookie: challenge, ...headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.text()).toMatch(/sent by another website/);
    }
    // Control: the app's own origin passes. A bearer caller from anywhere passes
    // only when the token is real (see csrf.test.ts); the bare header does not.
    const own = await app.request('/api/radars', {
      method: 'POST',
      headers: { ...json, origin: 'http://localhost:3500', 'sec-fetch-site': 'same-origin' },
      body: '{}',
    });
    expect(own.status).toBe(401);
    const junkBearer = await app.request('/api/radars', {
      method: 'POST',
      headers: { ...json, 'sec-fetch-site': 'cross-site', authorization: 'Bearer omr_pat_nope' },
      body: '{}',
    });
    expect(junkBearer.status).toBe(403);
  });

  it('signs in only the browser that asked for the code', async () => {
    const attacker = `csrf-attacker-${randomUUID()}@example.test`;
    const { code, challenge } = await requestCode(attacker);

    // The victim's browser holds no challenge, or one for a different address.
    const bare = await verify({ email: attacker, code });
    expect(bare.status).toBe(401);
    expect(await bare.text()).toMatch(/same browser you requested it from/);
    const other = await requestCode(`csrf-victim-${randomUUID()}@example.test`);
    const mismatched = await verify(
      { email: attacker, code },
      { ...json, cookie: other.challenge },
    );
    expect(mismatched.status).toBe(401);
    // Neither refusal cost the address one of its five attempts.
    expect(await attempts(attacker)).toBe(0);

    // The browser that asked signs in, and the challenge is spent.
    const ok = await verify({ email: attacker, code }, { ...json, cookie: challenge });
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies.at(-1)).toMatch(/^omr_session=/);
    expect(cookies.some((c) => /^omr_login=;/.test(c))).toBe(true);
  });

  it('asks no challenge of a native client, which gets a token and never a cookie', async () => {
    const email = `csrf-native-${randomUUID()}@example.test`;
    const { code } = await requestCode(email);
    const res = await verify({ email, code, client: 'ios' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session?: { token: string } }).session?.token).toMatch(
      /^omr_s_/,
    );
  });
});

/** Password sign-in over the wire on an isolated database. */
import { randomUUID } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import type * as Accounts from './accounts.js';
import type * as Password from './password.js';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PASSWORD } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { networkOf } from '../services/public-request.js';
import { createToken } from '../services/tokens.js';
import { cookieOf, json, startAuthApp } from './auth-test-kit.js';
import { chargePasswordAttempt } from './codes.js';
import { rehashPassword, savePassword } from './password.js';
import { createSession } from './session.js';

const scrypts = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof NodeCrypto>();
  const scrypt = ((...args: Parameters<typeof actual.scrypt>) => {
    scrypts.n += 1;
    actual.scrypt(...args);
  }) as typeof actual.scrypt;
  return { ...actual, scrypt };
});

/** Holds `afterSignIn` (a password sign-in's pause between verifying and issuing its session). */
const gate = vi.hoisted(() => ({
  reached: undefined as (() => void) | undefined,
  hold: undefined as Promise<void> | undefined,
}));
vi.mock('./accounts.js', async (original) => {
  const actual = await original<typeof Accounts>();
  return {
    ...actual,
    claimInvites: async (...args: Parameters<typeof actual.claimInvites>) => {
      gate.reached?.();
      await gate.hold;
      return actual.claimInvites(...args);
    },
  };
});

/** Pauses the next `verifyPassword` after it has checked, the moment a stale change would resume from. */
const pause = vi.hoisted(() => ({
  reached: undefined as (() => void) | undefined,
  hold: undefined as Promise<void> | undefined,
}));
vi.mock('./password.js', async (original) => {
  const actual = await original<typeof Password>();
  return {
    ...actual,
    verifyPassword: async (...args: Parameters<typeof actual.verifyPassword>) => {
      const result = await actual.verifyPassword(...args);
      const { reached, hold } = pause;
      pause.reached = pause.hold = undefined;
      reached?.();
      await hold;
      return result;
    },
  };
});

const PASSWORD_OK = 'a long enough password';
const ENV = { PASSWORD_LOGIN_ENABLED: 'true', PUBLIC_URL: 'http://localhost:3500' };
const email = () => `pw-${randomUUID()}@example.test`;

describe.skipIf(!process.env['DATABASE_URL'])('password sign-in (isolated postgres)', () => {
  let kit: Awaited<ReturnType<typeof startAuthApp>>;
  beforeAll(async () => {
    kit = await startAuthApp(ENV);
  }, 30_000);
  afterAll(() => kit.stop());

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = 'POST',
  ) =>
    kit.app.request(path, { method, headers: { ...json, ...headers }, body: JSON.stringify(body) });
  const login = (address: string, password: string, extra: Record<string, unknown> = {}) =>
    post('/api/auth/password/login', { email: address, password, ...extra });

  async function userWithPassword(password: string | null = PASSWORD_OK) {
    const address = email();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: address, state: 'active' })
      .returning();
    if (!user) throw new Error('no user');
    if (password) await savePassword(user.id, password);
    return { user, address };
  }
  const sessionsOf = async (userId: string) =>
    (await getDb().select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).length;
  /** A login code for the address, and the browser's challenge cookie for it. */
  async function codeFor(address: string) {
    const res = await post('/api/auth/request-code', { email: address });
    const { devCode } = (await res.json()) as { devCode: string };
    return { code: devCode, challenge: cookieOf(res, 'omr_login') ?? '' };
  }

  it('signs a browser in with a cookie and a bearer client with a token', async () => {
    const { address } = await userWithPassword();
    const web = await login(address, PASSWORD_OK);
    expect(web.status).toBe(200);
    expect(cookieOf(web, 'omr_session')).toBeTruthy();
    expect(((await web.json()) as { user: { email: string } }).user.email).toBe(address);
    const app = await login(address, PASSWORD_OK, { client: 'ios', label: 'phone' });
    const body = (await app.json()) as { session: { token: string } };
    expect(body.session.token).toMatch(/^omr_s_/);
    expect(cookieOf(app, 'omr_session')).toBeUndefined();
  });

  it('answers every way of missing identically, and spends exactly one scrypt on each', async () => {
    const noPassword = await userWithPassword(null);
    const wrong = await userWithPassword();
    const closed = await userWithPassword();
    await getDb().insert(schema.accountClosureRequests).values({
      id: randomUUID(),
      userId: closed.user.id,
      confirmedSessionId: randomUUID(),
      billingSnapshot: {},
    });
    const misses = [email(), noPassword.address, wrong.address, closed.address];
    const answers: string[] = [];
    for (const address of misses) {
      const before = scrypts.n;
      const res = await login(
        address,
        address === closed.address ? PASSWORD_OK : 'not the password',
      );
      expect(res.status, address).toBe(401);
      expect(cookieOf(res, 'omr_session')).toBeUndefined();
      expect(scrypts.n - before, address).toBe(1);
      answers.push(await res.text());
    }
    expect(new Set(answers).size).toBe(1);
    // And it never creates the account it was asked about.
    const unknown = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, misses[0] ?? ''));
    expect(unknown).toHaveLength(0);
  });

  it('locks an address after its twentieth wrong password, and the lock refuses the right one', async () => {
    const { address } = await userWithPassword();
    for (let i = 0; i < PASSWORD.failuresPerAddressPerDay; i++)
      expect((await login(address, 'wrong password!!')).status).toBe(401);
    const before = scrypts.n;
    const locked = await login(address, PASSWORD_OK);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(23 * 3600);
    expect(scrypts.n).toBe(before);
    // Sign-in codes are a separate budget: they still work while the password is locked.
    const { code, challenge } = await codeFor(address);
    const viaCode = await post(
      '/api/auth/verify-code',
      { email: address, code },
      { cookie: challenge },
    );
    expect(viaCode.status).toBe(200);
  }, 60_000);

  it('a right password clears the address’s failures; the code keys are never touched', async () => {
    const { address } = await userWithPassword();
    await login(address, 'wrong password!!');
    expect((await login(address, PASSWORD_OK)).status).toBe(200);
    const keys = await getDb()
      .select()
      .from(schema.loginVerifyLimits)
      .where(like(schema.loginVerifyLimits.key, `%${address}`));
    expect(keys).toEqual([]);
  });

  it('refuses a network over its ceiling before any scrypt runs', async () => {
    const ip = '203.0.113.77';
    await getDb()
      .insert(schema.loginVerifyLimits)
      .values({
        key: `pw-net:${networkOf(ip) ?? ''}`,
        windowCount: PASSWORD.attemptsPerNetworkPerHour,
      });
    const before = scrypts.n;
    const body = { email: email(), password: 'whatever password' };
    const res = await post('/api/auth/password/login', body, { 'cf-connecting-ip': ip });
    expect(res.status).toBe(429);
    expect(scrypts.n).toBe(before);
  });

  it('is login-CSRF safe: another site’s page, or a form post, signs nobody in', async () => {
    const { address } = await userWithPassword();
    const attempt = (headers: Record<string, string>) =>
      kit.app.request('/api/auth/password/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: address, password: PASSWORD_OK }),
      });
    const cross = await attempt({ ...json, 'sec-fetch-site': 'cross-site' });
    const form = await attempt({ 'content-type': 'text/plain' });
    expect([cross.status, form.status]).toEqual([403, 415]);
    expect([cookieOf(cross, 'omr_session'), cookieOf(form, 'omr_session')]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('resets by emailed code: new password in, old one out, every session ended', async () => {
    const { user, address } = await userWithPassword();
    await createSession(user);
    const { code, challenge } = await codeFor(address);
    const res = await post(
      '/api/auth/password/reset',
      { email: address, code, password: 'brand new password' },
      { cookie: challenge },
    );
    expect(res.status).toBe(200);
    expect(await sessionsOf(user.id)).toBe(1); // only the one this reset signed in
    expect((await login(address, PASSWORD_OK)).status).toBe(401);
    expect((await login(address, 'brand new password')).status).toBe(200);
    // The code is the proof: a wrong one changes nothing.
    const bad = await post(
      '/api/auth/password/reset',
      { email: address, code: '000000', password: 'another new password' },
      { cookie: challenge },
    );
    expect(bad.status).toBe(401);
    expect((await login(address, 'brand new password')).status).toBe(200);
  });

  it('changes a password only for a session, with proof, and ends the other sessions', async () => {
    const { user, address } = await userWithPassword(null);
    const mine = (await createSession(user)).token;
    await createSession(user);
    const put = (body: unknown, headers: Record<string, string>) =>
      post('/api/auth/password', body, headers, 'PUT');
    const cookie = { cookie: `omr_session=${mine}` };

    // No password yet: the first one needs a code.
    expect((await put({ password: PASSWORD_OK }, cookie)).status).toBe(400);
    const { code } = await codeFor(address);
    expect((await put({ password: PASSWORD_OK, code }, cookie)).status).toBe(200);
    expect(await sessionsOf(user.id)).toBe(1);
    expect((await login(address, PASSWORD_OK)).status).toBe(200);

    // After that, the current one.
    expect((await put({ password: 'second long password' }, cookie)).status).toBe(400);
    expect(
      (await put({ password: 'second long password', currentPassword: 'nope nope nope' }, cookie))
        .status,
    ).toBe(401);
    expect(
      (await put({ password: 'second long password', currentPassword: PASSWORD_OK }, cookie))
        .status,
    ).toBe(200);
    expect(
      (await put({ password: address, currentPassword: 'second long password' }, cookie)).status,
    ).toBe(400);

    // A personal access token may not set a password.
    const { token } = await createToken({ user, kind: 'user' }, { name: 'agent' });
    const viaToken = await put(
      { password: 'third long password', currentPassword: 'second long password' },
      { authorization: `Bearer ${token ?? ''}` },
    );
    expect(viaToken.status).toBe(403);
    expect((await put({ password: 'short' }, cookie)).status).toBe(400);

    // Somebody who has a password may prove it with a fresh emailed code instead of the old one.
    const forgotten = await codeFor(address);
    const viaCode = await put({ password: 'fourth long password', code: forgotten.code }, cookie);
    expect(viaCode.status).toBe(200);
    expect((await login(address, 'fourth long password')).status).toBe(200);
  });

  it('a login that paused after verifying cannot outlive the password change that ended it', async () => {
    const { user, address } = await userWithPassword();
    const mine = (await createSession(user)).token;
    let release!: () => void;
    gate.hold = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    const pending = login(address, PASSWORD_OK);
    await reached;
    // The owner changes the password while that login is between its check and its session.
    const changed = await post(
      '/api/auth/password',
      { password: 'changed long password', currentPassword: PASSWORD_OK },
      { cookie: `omr_session=${mine}` },
      'PUT',
    );
    expect(changed.status).toBe(200);
    gate.hold = gate.reached = undefined;
    release();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(cookieOf(res, 'omr_session')).toBeUndefined();
    expect(await sessionsOf(user.id)).toBe(1); // only the owner's own
  });

  /** Starts a change that stops after its proof is checked; resolves with the finish and its response. */
  async function pausedChange(cookie: string) {
    let release!: () => void;
    pause.hold = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (pause.reached = resolve));
    const response = post(
      '/api/auth/password',
      { password: 'attacker chosen password', currentPassword: PASSWORD_OK },
      { cookie },
      'PUT',
    );
    await reached;
    return { release, response };
  }

  it('a change that paused after verifying cannot overwrite a recovery that finished meanwhile', async () => {
    const { user, address } = await userWithPassword();
    const attacker = `omr_session=${(await createSession(user)).token}`;
    const owner = `omr_session=${(await createSession(user)).token}`;
    const stale = await pausedChange(attacker);
    const recovered = await post(
      '/api/auth/password',
      { password: 'owner new password', currentPassword: PASSWORD_OK },
      { cookie: owner },
      'PUT',
    ); // ends every other session, the attacker's included
    expect(recovered.status).toBe(200);
    stale.release();
    expect((await stale.response).status).toBe(409);
    expect((await login(address, 'owner new password')).status).toBe(200);
    expect((await login(address, 'attacker chosen password')).status).toBe(401);
  });

  it('a change whose session was revoked meanwhile changes nothing, even if the hash did not move', async () => {
    const { user, address } = await userWithPassword();
    const session = await createSession(user);
    const stale = await pausedChange(`omr_session=${session.token}`);
    await getDb().delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
    stale.release();
    expect((await stale.response).status).toBe(409);
    expect((await login(address, PASSWORD_OK)).status).toBe(200);
  });

  it('a change whose hash moved meanwhile changes nothing, even if the session is still live', async () => {
    const { user, address } = await userWithPassword();
    const stale = await pausedChange(`omr_session=${(await createSession(user)).token}`);
    await savePassword(user.id, 'moved long password');
    stale.release();
    expect((await stale.response).status).toBe(409);
    expect((await login(address, 'moved long password')).status).toBe(200);
  });

  it('upgrades a hash only if it is still the one that was verified', async () => {
    const { user } = await userWithPassword();
    expect(await rehashPassword(user.id, 'scrypt$1$stale', PASSWORD_OK)).toBeNull();
    const [row] = await getDb()
      .select()
      .from(schema.userPasswords)
      .where(eq(schema.userPasswords.userId, user.id));
    expect(await rehashPassword(user.id, row?.hash ?? '', PASSWORD_OK)).toMatch(/^scrypt\$1\$/);
  });

  it('keeps a hash out of the error when saving a password fails', async () => {
    const err: unknown = await savePassword(randomUUID(), 'a password to leak').catch(
      (e: unknown) => e,
    );
    if (!(err instanceof Error)) throw new Error('expected an error');
    expect(err.message).toBe('saving a password failed (23503)');
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err)) + String(err.stack)).not.toContain(
      'scrypt$',
    );
  });

  it('admits at most twenty concurrent guesses for one address', async () => {
    const address = email();
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => chargePasswordAttempt(address, null)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      PASSWORD.failuresPerAddressPerDay,
    );
  });

  it('answers 404 on every password route with the flag off, and /config says so', async () => {
    kit.withEnv({ PUBLIC_URL: 'http://localhost:3500' });
    for (const [method, path] of [
      ['POST', '/api/auth/password/login'],
      ['POST', '/api/auth/password/reset'],
      ['PUT', '/api/auth/password'],
    ] as const)
      expect((await post(path, {}, {}, method)).status, path).toBe(404);
    const config = (await (await kit.app.request('/api/auth/config')).json()) as {
      password: { enabled: boolean };
    };
    expect(config.password.enabled).toBe(false);
    kit.withEnv(ENV);
    const on = (await (await kit.app.request('/api/auth/config')).json()) as {
      password: { enabled: boolean };
      singleUser: boolean;
    };
    expect(on).toMatchObject({ password: { enabled: true }, singleUser: false });
  });

  it('reports each allowed mix of single-user, password and SSO', async () => {
    // Explicit endpoints, so SSO is "enabled" without a discovery fetch.
    const sso = {
      OIDC_ISSUER_URL: 'https://idp.test',
      OIDC_CLIENT_ID: 'a',
      OIDC_CLIENT_SECRET: 'b',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.test/auth',
      OIDC_TOKEN_ENDPOINT: 'https://idp.test/token',
      OIDC_JWKS_URI: 'https://idp.test/keys',
    };
    const mixes: [Record<string, string>, boolean, boolean, boolean][] = [
      [{}, false, false, false],
      [{ SINGLE_USER_EMAIL: 'me@example.test' }, true, false, false],
      [{ PASSWORD_LOGIN_ENABLED: 'true' }, false, true, false],
      [sso, false, false, true],
      [{ ...sso, PASSWORD_LOGIN_ENABLED: 'true' }, false, true, true],
    ];
    for (const [extra, singleUser, password, oidc] of mixes) {
      kit.withEnv({ PUBLIC_URL: 'http://localhost:3500', ...extra });
      const body = (await (
        await kit.app.request('/api/auth/config', { headers: { host: 'localhost:3500' } })
      ).json()) as {
        singleUser: boolean;
        password: { enabled: boolean };
        oidc: { enabled: boolean };
      };
      expect(
        [body.singleUser, body.password.enabled, body.oidc.enabled],
        JSON.stringify(extra),
      ).toEqual([singleUser, password, oidc]);
    }
    kit.withEnv(ENV);
  });
});

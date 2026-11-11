/**
 * SSO sign-in against a local, in-process IdP. Nothing here talks to a real
 * identity provider. The IdP signs ID tokens with a key it publishes at /jwks;
 * each test shapes the token the token endpoint will return, then drives the
 * real `/api/auth/oidc/start` -> `/callback` flow through the app.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { resetOidcForTesting } from './oidc.js';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const CLIENT_ID = 'omr-test-client';
const KID = 'test-key-1';

interface Scenario {
  /** Overrides for the claims of the ID token. `undefined` deletes a claim. */
  claims: Record<string, unknown>;
  /** Sign with this key instead of the published one. */
  signWith?: SigningKey;
  /** Return this exact string as id_token (alg none and the like). */
  rawIdToken?: (nonce: string) => string;
  omitIdToken?: boolean;
  userinfo?: Record<string, unknown> | null;
  /** Use this nonce in the token instead of the one the app sent. */
  nonce?: string;
}

describe.skipIf(!hasDatabase)('OIDC sign-in (mock IdP, real postgres)', () => {
  let server: Server;
  let base: string;
  let publicJwk: JWK;
  let privateKey: SigningKey;
  let scenario: Scenario;
  let sentNonce = '';
  let app: ReturnType<typeof createApp>;
  let baseEnv: NodeJS.ProcessEnv = {};
  const useEnv = (extra: NodeJS.ProcessEnv = {}) =>
    setEnvForTesting(loadEnv({ ...baseEnv, ...extra }));

  const issuer = () => `${base}/idp`;
  const email = () => `sso-${randomUUID()}@example.test`;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base);
      const json = (body: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/jwks' || url.pathname === '/idp/openid-jwks.json') {
        json({ keys: [publicJwk] });
        return;
      }
      if (url.pathname === '/userinfo') {
        json(scenario.userinfo ?? {});
        return;
      }
      if (url.pathname === '/token') {
        req.resume();
        req.on('end', () => {
          void mintToken().then(json);
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    baseEnv = {
      ...process.env,
      OIDC_ISSUER_URL: issuer(),
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: 'not-a-real-secret',
      OIDC_AUTHORIZATION_ENDPOINT: `${base}/authorize`,
      OIDC_TOKEN_ENDPOINT: `${base}/token`,
      OIDC_USERINFO_ENDPOINT: `${base}/userinfo`,
      // Some providers serve their keys at .../openid-jwks.json.
      OIDC_JWKS_URI: `${base}/idp/openid-jwks.json`,
    };
    useEnv();
    resetOidcForTesting();
    await runMigrations();
    app = createApp();
  }, 30_000);

  afterAll(async () => {
    setEnvForTesting(null);
    resetOidcForTesting();
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  async function mintToken(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { access_token: 'at', token_type: 'Bearer' };
    if (scenario.omitIdToken) return out;
    if (scenario.rawIdToken !== undefined)
      return { ...out, id_token: scenario.rawIdToken(sentNonce) };
    const claims: Record<string, unknown> = Object.fromEntries(
      Object.entries<unknown>({
        email: 'unset@example.test',
        email_verified: true,
        nonce: scenario.nonce ?? sentNonce,
        ...scenario.claims,
      }).filter(([, value]) => value !== undefined),
    );
    const exp = typeof claims['exp'] === 'number' ? claims['exp'] : undefined;
    delete claims['exp'];
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt(exp && exp < Date.now() / 1000 ? exp - 600 : undefined)
      .setExpirationTime(exp ?? '5m');
    if (!('iss' in claims)) jwt.setIssuer(issuer());
    if (!('aud' in claims)) jwt.setAudience(CLIENT_ID);
    return { ...out, id_token: await jwt.sign(scenario.signWith ?? privateKey) };
  }

  /** Runs start -> IdP -> callback and returns where the app sent the browser. */
  async function signIn(
    next: Scenario,
    nextParam?: string,
  ): Promise<{ location: string; signedIn: boolean }> {
    scenario = next;
    const start = await app.request(
      `/api/auth/oidc/start${nextParam === undefined ? '' : `?next=${nextParam}`}`,
    );
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get('location') ?? '');
    sentNonce = auth.searchParams.get('nonce') ?? '';
    expect(sentNonce).not.toBe('');
    const state = auth.searchParams.get('state') ?? '';
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await app.request(
      `/api/auth/oidc/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    return {
      location: res.headers.get('location') ?? '',
      signedIn: /omr_session=[^;]+/.test(setCookie) && !/omr_session=;/.test(setCookie),
    };
  }

  const usersWithEmail = async (address: string) =>
    getDb().select().from(schema.users).where(eq(schema.users.email, address));
  const identitiesFor = async (userId: string) =>
    getDb().select().from(schema.identities).where(eq(schema.identities.userId, userId));
  const refused = (r: { location: string; signedIn: boolean }) => {
    expect(r.signedIn).toBe(false);
    expect(r.location).toMatch(/^\/login\?error=/);
  };

  function good(address: string, subject = `sub-${randomUUID()}`, extra: Partial<Scenario> = {}) {
    return {
      userinfo: { sub: subject, email: address, email_verified: true },
      ...extra,
      claims: { sub: subject, email: address, email_verified: true, ...extra.claims },
    } satisfies Scenario;
  }

  beforeEach(() => {
    scenario = { claims: {} };
  });

  it('a good token signs a new person in and stores the identity with its issuer', async () => {
    const address = email();
    const subject = `sub-${randomUUID()}`;
    const result = await signIn(good(address, subject));
    expect(result).toMatchObject({ location: '/', signedIn: true });
    const [user] = await usersWithEmail(address);
    const [identity] = await identitiesFor(user?.id ?? '');
    expect(identity).toMatchObject({ provider: 'oidc', subject, issuer: issuer() });
  });

  it('sends a signed-in person to a safe next path, and never off the origin', async () => {
    expect(await signIn(good(email()), '%2Fradar%2Fabc')).toMatchObject({
      location: '/radar/abc',
      signedIn: true,
    });
    // A tab, newline or CR is stripped by the browser, so `/\t/host` would resolve to `//host`.
    for (const next of [
      '/%09/evil.example',
      '/%0a/evil.example',
      '/%0d/evil.example',
      '/%5Cevil.example',
      '//evil.example',
    ]) {
      expect(await signIn(good(email()), next), next).toMatchObject({
        location: '/',
        signedIn: true,
      });
    }
  });

  it('refuses a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256');
    const address = email();
    refused(await signIn(good(address, undefined, { signWith: other.privateKey })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses a token for another audience', async () => {
    const address = email();
    refused(await signIn(good(address, undefined, { claims: { aud: 'someone-else' } })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses a token from another issuer', async () => {
    const address = email();
    refused(await signIn(good(address, undefined, { claims: { iss: 'https://evil.example' } })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses an expired token', async () => {
    const address = email();
    const expired = Math.floor(Date.now() / 1000) - 3600;
    refused(await signIn(good(address, undefined, { claims: { exp: expired } })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses an authorized party that is not this client', async () => {
    const address = email();
    refused(await signIn(good(address, undefined, { claims: { azp: 'another-client' } })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses an unsigned token (alg none)', async () => {
    const address = email();
    const subject = `sub-${randomUUID()}`;
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const raw = (nonce: string) =>
      `${part({ alg: 'none', typ: 'JWT' })}.${part({
        iss: issuer(),
        aud: CLIENT_ID,
        sub: subject,
        email: address,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce,
      })}.`;
    refused(await signIn({ ...good(address, subject), rawIdToken: raw }));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses a token whose nonce is not the one this attempt sent', async () => {
    const address = email();
    refused(await signIn(good(address, undefined, { nonce: 'replayed-from-another-attempt' })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses a response with no id_token rather than trusting the back channel', async () => {
    const address = email();
    refused(await signIn(good(address, undefined, { omitIdToken: true })));
    expect(await usersWithEmail(address)).toHaveLength(0);
  });

  it('refuses a token with no nonce claim unless OIDC_ALLOW_MISSING_NONCE is set', async () => {
    const refusedAddress = email();
    refused(await signIn(good(refusedAddress, undefined, { claims: { nonce: undefined } })));
    expect(await usersWithEmail(refusedAddress)).toHaveLength(0);

    useEnv({ OIDC_ALLOW_MISSING_NONCE: '1' });
    try {
      expect(
        await signIn(good(email(), undefined, { claims: { nonce: undefined } })),
      ).toMatchObject({ location: '/', signedIn: true });
    } finally {
      useEnv();
    }
  });

  it('refuses a present nonce that is empty or not a string', async () => {
    for (const nonce of ['', 12345, null]) {
      const address = email();
      refused(await signIn(good(address, undefined, { claims: { nonce } })));
      expect(await usersWithEmail(address)).toHaveLength(0);
    }
  });

  it('never stores a userinfo identifier for a new identity', async () => {
    const address = email();
    const subject = `real-${randomUUID()}`;
    const s = good(address, subject);
    const result = await signIn({
      ...s,
      userinfo: { uid: `uid-${randomUUID()}`, email: address },
    });
    expect(result.signedIn).toBe(true);
    const [user] = await usersWithEmail(address);
    expect((await identitiesFor(user?.id ?? '')).map((i) => i.subject)).toEqual([subject]);
  });

  it('does not link to an existing account when email_verified is false', async () => {
    const address = email();
    const [victim] = await getDb()
      .insert(schema.users)
      .values({ email: address, state: 'active' })
      .returning();
    const subject = `sub-${randomUUID()}`;
    refused(
      await signIn({
        claims: { sub: subject, email: address, email_verified: false },
        userinfo: { sub: subject, email: address, email_verified: false },
      }),
    );
    expect(await identitiesFor(victim?.id ?? '')).toHaveLength(0);
  });

  it('treats a missing or non-boolean email_verified as unverified', async () => {
    const address = email();
    await getDb().insert(schema.users).values({ email: address, state: 'active' });
    const subject = `sub-${randomUUID()}`;
    refused(
      await signIn({
        claims: { sub: subject, email: address, email_verified: 'true' },
        userinfo: { sub: subject, email: address },
      }),
    );
    refused(
      await signIn({
        claims: { sub: subject, email: address, email_verified: undefined },
        userinfo: { sub: subject, email: address },
      }),
    );
  });

  it('links a verified email to an existing account that has no identity yet', async () => {
    const address = email();
    const [existing] = await getDb()
      .insert(schema.users)
      .values({ email: address, state: 'active' })
      .returning();
    const subject = `sub-${randomUUID()}`;
    expect(await signIn(good(address, subject))).toMatchObject({ location: '/', signedIn: true });
    expect(await identitiesFor(existing?.id ?? '')).toHaveLength(1);
  });

  it('does not let the same email with a new subject take over a linked account', async () => {
    const address = email();
    const original = `original-${randomUUID()}`;
    const attackerSubject = `attacker-${randomUUID()}`;
    expect(await signIn(good(address, original))).toMatchObject({ signedIn: true });
    const [user] = await usersWithEmail(address);
    refused(await signIn(good(address, attackerSubject)));
    const identities = await identitiesFor(user?.id ?? '');
    expect(identities).toHaveLength(1);
    expect(identities[0]?.subject).toBe(original);
    const attacker = await getDb()
      .select()
      .from(schema.identities)
      .where(
        and(eq(schema.identities.provider, 'oidc'), eq(schema.identities.subject, attackerSubject)),
      );
    expect(attacker).toHaveLength(0);
  });

  it('signs a returning user in by subject even when the email claim has changed', async () => {
    const address = email();
    const subject = `sub-${randomUUID()}`;
    expect(await signIn(good(address, subject))).toMatchObject({ signedIn: true });
    const changed = email();
    expect(await signIn(good(changed, subject))).toMatchObject({ location: '/', signedIn: true });
    expect(await usersWithEmail(changed)).toHaveLength(0);
    const [user] = await usersWithEmail(address);
    expect(await identitiesFor(user?.id ?? '')).toHaveLength(1);
  });

  it('signs a returning user in by subject even when the IdP stops saying the email is verified', async () => {
    const address = email();
    const subject = `sub-${randomUUID()}`;
    expect(await signIn(good(address, subject))).toMatchObject({ signedIn: true });
    const again = await signIn({
      claims: { sub: subject, email: address, email_verified: false },
      userinfo: { sub: subject, email: address, email_verified: false },
    });
    expect(again).toMatchObject({ signedIn: true });
  });

  describe('OIDC_TRUST_IDP_EMAIL', () => {
    afterEach(() => useEnv());

    it('is off by default: an unverified email still does not link', async () => {
      const address = email();
      const [existing] = await getDb()
        .insert(schema.users)
        .values({ email: address, state: 'active' })
        .returning();
      refused(
        await signIn(
          good(address, undefined, {
            claims: { email_verified: undefined },
            userinfo: { email: address },
          }),
        ),
      );
      expect(await identitiesFor(existing?.id ?? '')).toHaveLength(0);
    });

    it('on: an email with no verified flag links to an existing account on first sign-in', async () => {
      useEnv({ OIDC_TRUST_IDP_EMAIL: '1' });
      const address = email();
      const [existing] = await getDb()
        .insert(schema.users)
        .values({ email: address, state: 'active' })
        .returning();
      const subject = `sub-${randomUUID()}`;
      const r = await signIn(
        good(address, subject, {
          claims: { email_verified: undefined },
          userinfo: { email: address },
        }),
      );
      expect(r).toMatchObject({ location: '/', signedIn: true });
      expect((await identitiesFor(existing?.id ?? '')).map((i) => i.subject)).toEqual([subject]);
    });

    it('on: the same email with a new subject still cannot take over a linked account', async () => {
      useEnv({ OIDC_TRUST_IDP_EMAIL: '1' });
      const address = email();
      const original = `original-${randomUUID()}`;
      expect(await signIn(good(address, original))).toMatchObject({ signedIn: true });
      const [user] = await usersWithEmail(address);
      refused(
        await signIn(
          good(address, `attacker-${randomUUID()}`, { claims: { email_verified: undefined } }),
        ),
      );
      expect((await identitiesFor(user?.id ?? '')).map((i) => i.subject)).toEqual([original]);
    });
  });

  describe('a minimal-claims token (RS256; iss aud exp iat sub email groups username only)', () => {
    // The recipe in .env.example: it sends no nonce and no email_verified.
    beforeEach(() => useEnv({ OIDC_TOKEN_AUTH_METHOD: 'post', OIDC_ALLOW_MISSING_NONCE: '1' }));
    afterEach(() => useEnv());
    const minimal = (address: string, subject: string, userinfo?: Record<string, unknown>) =>
      ({
        claims: {
          sub: subject,
          email: address,
          groups: ['users'],
          username: 'someone',
          email_verified: undefined,
          nonce: undefined,
        },
        userinfo: userinfo ?? { data: { email: address } },
      }) satisfies Scenario;
    const legacyRow = async (address: string, subject: string) => {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: address, state: 'active' })
        .returning();
      await getDb()
        .insert(schema.identities)
        .values({ userId: user?.id ?? '', provider: 'oidc', issuer: issuer(), subject });
      return user;
    };

    it('signs a returning user with a backfilled legacy identity in by subject', async () => {
      const address = email();
      const subject = `sub-${randomUUID()}`;
      const user = await legacyRow(address, subject);
      expect(await signIn(minimal(address, subject))).toMatchObject({
        location: '/',
        signedIn: true,
      });
      expect(await usersWithEmail(address)).toHaveLength(1);
      expect((await identitiesFor(user?.id ?? '')).map((i) => i.subject)).toEqual([subject]);
    });

    it('finds a legacy row stored under the userinfo identifier and re-keys it to the token sub', async () => {
      const address = email();
      const userinfoId = `uid-${randomUUID()}`;
      const tokenSub = `sub-${randomUUID()}`;
      const user = await legacyRow(address, userinfoId);
      const first = await signIn(
        minimal(address, tokenSub, { data: { uid: userinfoId, email: address } }),
      );
      expect(first).toMatchObject({ location: '/', signedIn: true });
      expect((await identitiesFor(user?.id ?? '')).map((i) => i.subject)).toEqual([tokenSub]);
      // The next sign-in is by the verified subject alone.
      expect(await signIn(minimal(address, tokenSub))).toMatchObject({ signedIn: true });
      expect(await usersWithEmail(address)).toHaveLength(1);
    });

    it('refuses a first-time user while OIDC_TRUST_IDP_EMAIL is off, saying why', async () => {
      const address = email();
      const r = await signIn(minimal(address, `sub-${randomUUID()}`));
      refused(r);
      expect(decodeURIComponent(r.location)).toMatch(/has not verified this email/);
      expect(await usersWithEmail(address)).toHaveLength(0);
    });
  });
});

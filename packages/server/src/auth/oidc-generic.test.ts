/**
 * OIDC against providers that only publish a discovery document (no OIDC_*_ENDPOINT
 * set), the way Keycloak and Authentik do. No database: the module under test is the
 * protocol half of sign-in (`getEndpoints`, `buildAuthorizationRequest`,
 * `exchangeCode`), driven against an in-process IdP.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, setEnvForTesting } from '../env.js';
import {
  buildAuthorizationRequest,
  exchangeCode,
  getEndpoints,
  OidcError,
  resetOidcForTesting,
} from './oidc.js';

const CLIENT_ID = 'omr-generic';
const CLIENT_SECRET = 'generic-secret-not-real';
const KID = 'generic-key';

interface TokenCall {
  authorization: string | undefined;
  body: URLSearchParams;
}

describe('OIDC with discovery only (no endpoint config)', () => {
  let server: Server;
  let base: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicJwk: JWK;
  // What the IdP serves; each test reshapes it.
  let discoveryStatus = 200;
  let discoveryHits = 0;
  let tokenCalls: TokenCall[] = [];
  let userinfo: Record<string, unknown> = {};
  /** The path the IdP's issuer lives under, and the issuer string it names itself with. */
  let prefix = '/realms/x';
  let issuerSuffix = '';
  let idTokenClaims: Record<string, unknown> = {};

  const issuerName = () => `${base}${prefix}${issuerSuffix}`;

  function configure(extra: Record<string, string> = {}) {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
        SESSION_SECRET: 'generic-oidc-test-secret-not-for-real-use',
        PUBLIC_URL: 'http://localhost:3500',
        OIDC_ISSUER_URL: issuerName(),
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: CLIENT_SECRET,
        ...extra,
      }),
    );
    resetOidcForTesting();
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base);
      const json = (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (url.pathname === `${prefix}/.well-known/openid-configuration`) {
        discoveryHits += 1;
        if (discoveryStatus !== 200) {
          json({ error: 'down' }, discoveryStatus);
          return;
        }
        json({
          issuer: issuerName(),
          authorization_endpoint: `${base}${prefix}/auth`,
          token_endpoint: `${base}${prefix}/token`,
          userinfo_endpoint: `${base}${prefix}/userinfo`,
          jwks_uri: `${base}${prefix}/certs`,
        });
        return;
      }
      if (url.pathname === `${prefix}/certs`) {
        json({ keys: [publicJwk] });
        return;
      }
      if (url.pathname === `${prefix}/userinfo`) {
        json(userinfo);
        return;
      }
      if (url.pathname === `${prefix}/token`) {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        req.on('end', () => {
          tokenCalls.push({
            authorization: req.headers.authorization,
            body: new URLSearchParams(raw),
          });
          void new SignJWT({ ...idTokenClaims })
            .setProtectedHeader({ alg: 'RS256', kid: KID })
            .setIssuer(issuerName())
            .setAudience(CLIENT_ID)
            .setExpirationTime('5m')
            .sign(privateKey)
            .then((id_token) => json({ access_token: 'at', token_type: 'Bearer', id_token }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setEnvForTesting(null);
    resetOidcForTesting();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    prefix = '/realms/x';
    issuerSuffix = '';
    discoveryStatus = 200;
    discoveryHits = 0;
    tokenCalls = [];
    userinfo = {};
    idTokenClaims = { sub: 'user-1', email: 'token@example.test', email_verified: true };
  });
  afterEach(() => vi.restoreAllMocks());

  /** Start a sign-in and finish it with whatever nonce the IdP is told to return. */
  async function signIn(nonce: string | null) {
    const start = await buildAuthorizationRequest();
    if (!start) throw new Error('discovery failed');
    if (nonce !== null) idTokenClaims['nonce'] = nonce === 'echo' ? start.nonce : nonce;
    else delete idTokenClaims['nonce'];
    const profile = await exchangeCode('code-1', start.codeVerifier, start.nonce);
    return { start, profile };
  }

  it('a Keycloak-style issuer needs only discovery: authorizes with the defaults and signs in', async () => {
    configure();
    const { start, profile } = await signIn('echo');
    const authorize = new URL(start.url);
    expect(authorize.origin + authorize.pathname).toBe(`${base}/realms/x/auth`);
    expect(authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(profile).toMatchObject({
      subject: 'user-1',
      email: 'token@example.test',
      emailVerified: true,
      issuer: issuerName(),
    });
  });

  it('authenticates the client with HTTP Basic by default, and never puts the secret in the body', async () => {
    configure();
    await signIn('echo');
    const call = tokenCalls[0];
    expect(call?.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect([...(call?.body.keys() ?? [])].sort()).toEqual([
      'code',
      'code_verifier',
      'grant_type',
      'redirect_uri',
    ]);
  });

  it('form-urlencodes the client secret before the Basic header (RFC 6749 §2.3.1)', async () => {
    configure({ OIDC_CLIENT_SECRET: 'secret+with%' });
    await signIn('echo');
    const header = tokenCalls[0]?.authorization ?? '';
    expect(Buffer.from(header.replace('Basic ', ''), 'base64').toString()).toBe(
      `${CLIENT_ID}:secret%2Bwith%25`,
    );
  });

  it('OIDC_TOKEN_AUTH_METHOD=post moves the credentials into the body and drops the header', async () => {
    configure({ OIDC_TOKEN_AUTH_METHOD: 'post' });
    await signIn('echo');
    expect(tokenCalls[0]?.authorization).toBeUndefined();
    expect(tokenCalls[0]?.body.get('client_secret')).toBe(CLIENT_SECRET);
  });

  describe('an Authentik-style issuer, which ends in a slash', () => {
    beforeEach(() => {
      prefix = '/application/o/app';
      issuerSuffix = '/';
    });

    it('works whether or not OIDC_ISSUER_URL keeps the slash, and the identity key has none', async () => {
      for (const configured of [`${base}/application/o/app/`, `${base}/application/o/app`]) {
        configure({ OIDC_ISSUER_URL: configured });
        const { profile } = await signIn('echo');
        expect(profile.subject).toBe('user-1');
        expect(profile.issuer).toBe(`${base}/application/o/app`);
      }
    });
  });

  describe('nonce', () => {
    it('a token that does not carry the nonce is refused by default', async () => {
      configure();
      await expect(signIn(null)).rejects.toBeInstanceOf(OidcError);
    });

    it('OIDC_ALLOW_MISSING_NONCE accepts an absent nonce, but never a wrong one', async () => {
      configure({ OIDC_ALLOW_MISSING_NONCE: '1' });
      expect((await signIn(null)).profile.subject).toBe('user-1');
      await expect(signIn('replayed-from-another-attempt')).rejects.toBeInstanceOf(OidcError);
    });
  });

  describe('failed discovery', () => {
    it('leaves SSO unavailable, is not asked again at once, and is retried once the interval has passed', async () => {
      configure();
      discoveryStatus = 503;
      expect(await getEndpoints()).toBeNull();
      const failedHits = discoveryHits;
      expect(failedHits).toBeGreaterThan(0);

      // The provider is back, but a failure is remembered for five minutes.
      discoveryStatus = 200;
      expect(await getEndpoints()).toBeNull();
      expect(discoveryHits).toBe(failedHits);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000);
      const endpoints = await getEndpoints();
      expect(endpoints?.tokenEndpoint).toBe(`${base}/realms/x/token`);
      expect(discoveryHits).toBeGreaterThan(failedHits);
    });

    it('never guesses endpoints from the issuer', async () => {
      configure();
      discoveryStatus = 404;
      expect(await buildAuthorizationRequest()).toBeNull();
    });
  });

  describe('userinfo wrapper', () => {
    const exchange = async () => (await signIn('echo')).profile;

    it('unwraps { data: {...} } when the top level has no sub', async () => {
      configure();
      userinfo = { data: { email: 'wrapped@example.test' } };
      expect((await exchange()).email).toBe('wrapped@example.test');
    });

    it('leaves a response that has a sub alone, so a real `data` claim is not mistaken for a wrapper', async () => {
      configure();
      userinfo = {
        sub: 'user-1',
        email: 'top@example.test',
        data: { email: 'inner@example.test' },
      };
      expect((await exchange()).email).toBe('top@example.test');
    });
  });
});

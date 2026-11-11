/**
 * OIDC single sign-on against any standards-conforming provider (Keycloak,
 * Authentik, Okta, Entra, ...); `.env.example` has a recipe for each.
 *
 * The ID token is the proof of who signed in, so it is verified, and the flow
 * fails closed when it cannot be: the signature is checked against the issuer's
 * JWKS (`OIDC_JWKS_URI`, else the discovery document's `jwks_uri`), and the
 * issuer, audience, authorized party, expiry and the per-attempt nonce must all
 * match. A missing id_token, a missing JWKS, or any failed check ends the
 * sign-in; there is no fallback to "trust the back channel". The authorization
 * code is still exchanged over a direct TLS call to the configured token
 * endpoint with a PKCE verifier, and userinfo supplies the profile, but userinfo
 * can never change *who* the subject is: its `sub` must equal the verified one.
 *
 * Endpoints come from `OIDC_*_ENDPOINT` when set, else from the issuer's
 * discovery document. There is no guessed fallback: a provider that serves no
 * discovery document needs its endpoints (and `OIDC_JWKS_URI`) set explicitly.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { env, oidcConfigured as isOidcConfigured } from '../env.js';
import { errorMessage, errorName } from '../errors.js';
import { logger } from '../logger.js';
import { safeEqual } from './crypto.js';

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
}

export interface OidcProfile {
  /** From the verified ID token. */
  subject: string;
  /**
   * What userinfo calls the person when that is not the token's `sub`. Only for
   * finding an identity stored before tokens were verified; never stored fresh.
   */
  legacySubject: string | null;
  /**
   * The identity key's issuer: the configured `OIDC_ISSUER_URL`, slash-trimmed.
   * Deliberately not the token's `iss`, so the key is stable across discovery.
   */
  issuer: string;
  email: string;
  /** True only when the IdP said `email_verified: true` (a boolean, not a string). */
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

let cachedEndpoints: OidcEndpoints | null = null;
let discoveryAttemptedAt = 0;
const DISCOVERY_RETRY_MS = 5 * 60 * 1000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The issuer identities are keyed by: the configured one, as an operator wrote it. */
export function configuredIssuer(): string {
  return trimSlash(env().OIDC_ISSUER_URL ?? '');
}

/** Test seam: forget discovery and JWKS caches so a suite can point at a new IdP. */
export function resetOidcForTesting(): void {
  cachedEndpoints = null;
  discoveryAttemptedAt = 0;
  jwksSets.clear();
}

/** Explicit endpoint config always wins; discovery only fills the gaps. */
function fromConfig(): OidcEndpoints | null {
  const e = env();
  if (!e.OIDC_ISSUER_URL) return null;
  if (!e.OIDC_AUTHORIZATION_ENDPOINT || !e.OIDC_TOKEN_ENDPOINT) return null;
  return {
    issuer: trimSlash(e.OIDC_ISSUER_URL),
    authorizationEndpoint: e.OIDC_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: e.OIDC_TOKEN_ENDPOINT,
    userinfoEndpoint: e.OIDC_USERINFO_ENDPOINT ?? null,
    jwksUri: e.OIDC_JWKS_URI ?? null,
  };
}

async function discover(issuer: string): Promise<OidcEndpoints | null> {
  const base = trimSlash(issuer);
  // An issuer with a path serves its document under that path (OIDC Discovery),
  // and some providers only at the host root, so that form is tried second.
  const candidates = [
    `${base}/.well-known/openid-configuration`,
    `${new URL(base).origin}/.well-known/openid-configuration`,
  ];

  // Discovery runs on the login page, so it gets its own shorter budget — it
  // must not hold up a page render the way the token exchange can.
  const discoveryTimeoutMs = Math.min(env().OIDC_HTTP_TIMEOUT_MS, 10_000);

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(discoveryTimeoutMs),
      });
      if (!res.ok) continue;
      const doc = (await res.json()) as Record<string, unknown>;
      const authorization = doc['authorization_endpoint'];
      const token = doc['token_endpoint'];
      if (typeof authorization !== 'string' || typeof token !== 'string') continue;
      return {
        issuer: typeof doc['issuer'] === 'string' ? doc['issuer'] : base,
        authorizationEndpoint: authorization,
        tokenEndpoint: token,
        userinfoEndpoint:
          typeof doc['userinfo_endpoint'] === 'string' ? doc['userinfo_endpoint'] : null,
        jwksUri: typeof doc['jwks_uri'] === 'string' ? doc['jwks_uri'] : null,
      };
    } catch (err) {
      logger.debug({ err, url }, 'oidc discovery attempt failed');
    }
  }
  return null;
}

/**
 * Resolves endpoints, preferring explicit config, then discovery. Returns null
 * when SSO is not usable, which the login screen reports as "SSO unavailable"
 * rather than failing the request. A failed discovery is cached for
 * DISCOVERY_RETRY_MS only, so SSO recovers by itself once the provider is back.
 */
export async function getEndpoints(): Promise<OidcEndpoints | null> {
  if (!isOidcConfigured(env())) return null;
  if (cachedEndpoints) return cachedEndpoints;

  const explicit = fromConfig();
  if (explicit) {
    cachedEndpoints = explicit;
    return explicit;
  }

  if (Date.now() - discoveryAttemptedAt < DISCOVERY_RETRY_MS) return null;
  discoveryAttemptedAt = Date.now();

  const issuer = trimSlash(env().OIDC_ISSUER_URL ?? '');
  const discovered = await discover(issuer);
  if (discovered) {
    cachedEndpoints = discovered;
    logger.info({ issuer: discovered.issuer }, 'oidc endpoints discovered');
    return discovered;
  }

  logger.warn(
    { issuer },
    'oidc discovery failed; SSO is unavailable until it succeeds — or set ' +
      'OIDC_AUTHORIZATION_ENDPOINT, OIDC_TOKEN_ENDPOINT and OIDC_JWKS_URI',
  );
  return null;
}

export function redirectUri(): string {
  return `${env().PUBLIC_URL}/api/auth/oidc/callback`;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  /** Sent as `nonce` and required back, unchanged, in the ID token. */
  nonce: string;
}

export async function buildAuthorizationRequest(): Promise<AuthorizationRequest | null> {
  const endpoints = await getEndpoints();
  if (!endpoints) return null;

  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env().OIDC_CLIENT_ID ?? '');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', env().OIDC_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  if (env().OIDC_USE_PKCE) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  return { url: url.toString(), state, codeVerifier, nonce };
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const ID_TOKEN_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksSets.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri), {
      timeoutDuration: env().OIDC_HTTP_TIMEOUT_MS,
      cooldownDuration: 30_000,
    });
    jwksSets.set(uri, set);
  }
  return set;
}

/** Both spellings of an issuer, since jose compares `iss` exactly. */
function issuerForms(...issuers: string[]): string[] {
  const out = new Set<string>();
  for (const issuer of issuers) {
    const trimmed = trimSlash(issuer);
    if (!trimmed) continue;
    out.add(trimmed);
    out.add(`${trimmed}/`);
  }
  return [...out];
}

/**
 * Verify the ID token end to end and return its claims. Everything that can
 * go wrong is an OidcError with a sentence a person can act on; the specific
 * reason is logged, not shown.
 */
async function verifyIdToken(
  idToken: string,
  endpoints: OidcEndpoints,
  clientId: string,
  expectedNonce: string,
): Promise<Record<string, unknown>> {
  const jwksUri = env().OIDC_JWKS_URI ?? endpoints.jwksUri;
  if (!jwksUri) {
    logger.warn('oidc refused: no JWKS available to verify the id_token');
    throw new OidcError(
      'The SSO server publishes no signing keys, so the sign-in could not be verified. Set OIDC_JWKS_URI.',
    );
  }
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, jwksFor(jwksUri), {
      issuer: issuerForms(endpoints.issuer, configuredIssuer()),
      audience: clientId,
      algorithms: ID_TOKEN_ALGS,
      clockTolerance: 30,
      requiredClaims: ['exp', 'iss', 'aud', 'sub'],
    });
    payload = verified.payload;
  } catch (err) {
    logger.warn(
      { err, code: err instanceof joseErrors.JOSEError ? err.code : undefined },
      'oidc id_token verification failed',
    );
    throw new OidcError('The SSO response could not be verified. Try again.');
  }
  const azp = payload['azp'];
  const aud = payload['aud'];
  if (
    (azp !== undefined && azp !== clientId) ||
    (Array.isArray(aud) && aud.length > 1 && azp !== clientId)
  ) {
    logger.warn('oidc id_token authorized party mismatch');
    throw new OidcError('The SSO response could not be verified. Try again.');
  }
  /*
    We always send a nonce and the token must return it: present-but-wrong
    (including empty or not a string) is always a failure, and so is absent,
    unless OIDC_ALLOW_MISSING_NONCE is set for a provider that never echoes it.
    Then the binding rests on the PKCE verifier and the signed state cookie
    alone, which is sound for the code flow but weaker, so it is opt-in.
  */
  if ('nonce' in payload || !env().OIDC_ALLOW_MISSING_NONCE) {
    const nonce = payload['nonce'];
    if (typeof nonce !== 'string' || !nonce || !safeEqual(nonce, expectedNonce)) {
      logger.warn('oidc id_token nonce mismatch');
      throw new OidcError('That sign-in response could not be verified. Try again.');
    }
  }
  if (typeof payload['sub'] !== 'string' || !payload['sub']) {
    throw new OidcError('SSO did not return a subject identifier');
  }
  return payload;
}

function pickBoolean(source: Record<string, unknown> | null, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : null;
}

function pickString(source: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Some providers answer failures with a styled HTML page whose first few
 * kilobytes are a base64 image, so logging the raw body truncates to the image
 * and throws away the sentence that says what went wrong. Strip the markup and
 * the data URIs and keep the text.
 */
function summarizeErrorBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '(empty body)';
  if (!/^\s*</.test(trimmed)) return trimmed.slice(0, 500);
  return (
    trimmed
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/\bdata:[^"')\s]+/gi, '[data-uri]')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || '(html body with no readable text)'
  );
}

export class OidcError extends Error {}

/** Exchanges the code and returns the caller's identity, or throws OidcError. */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  expectedNonce: string,
): Promise<OidcProfile> {
  const endpoints = await getEndpoints();
  const e = env();
  if (!endpoints || !isOidcConfigured(e)) throw new OidcError('SSO is not configured');

  const method = e.OIDC_TOKEN_AUTH_METHOD;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  // Exactly one authentication method unless explicitly told otherwise —
  // RFC 6749 §2.3 forbids presenting two, and servers do reject it.
  if (method === 'post' || method === 'both') {
    body.set('client_id', e.OIDC_CLIENT_ID);
    body.set('client_secret', e.OIDC_CLIENT_SECRET);
  }
  if (env().OIDC_USE_PKCE) body.set('code_verifier', codeVerifier);

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (method === 'basic' || method === 'both') {
    // RFC 6749 §2.3.1: both halves are form-urlencoded before they are joined and base64'd.
    const form = (v: string) => new URLSearchParams({ v }).toString().slice(2);
    headers['authorization'] =
      `Basic ${Buffer.from(`${form(e.OIDC_CLIENT_ID)}:${form(e.OIDC_CLIENT_SECRET)}`).toString('base64')}`;
  }

  const timeoutMs = e.OIDC_HTTP_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A timeout here used to surface as the generic "SSO sign-in failed", which
    // says nothing about what to do. Name it, and say it is worth retrying.
    const timedOut = errorName(err) === 'TimeoutError';
    logger.warn(
      { err, timeoutMs, tokenEndpoint: endpoints.tokenEndpoint },
      timedOut ? 'oidc token endpoint timed out' : 'oidc token endpoint unreachable',
    );
    throw new OidcError(
      timedOut
        ? `The SSO server did not respond within ${Math.round(timeoutMs / 1000)} seconds. Try again.`
        : `Could not reach the SSO server: ${errorMessage(err, 'no further detail')}`,
    );
  }

  const raw = await res.text().catch(() => '');
  let payload: TokenResponse | null = null;
  try {
    payload = JSON.parse(raw) as TokenResponse;
  } catch {
    payload = null;
  }

  if (!res.ok || !payload || payload.error || !payload.access_token) {
    // Some providers answer a bare `server_error` to anything they dislike, so
    // the response body and the request shape are logged together — without
    // them there is nothing to tell one cause from another on the next attempt.
    logger.warn(
      {
        status: res.status,
        body: summarizeErrorBody(raw),
        contentType: res.headers.get('content-type'),
        tokenEndpoint: endpoints.tokenEndpoint,
        authMethod: method,
        pkce: env().OIDC_USE_PKCE,
        scopes: e.OIDC_SCOPES,
        sentParams: [...body.keys()],
      },
      'oidc token endpoint rejected the exchange',
    );
    throw new OidcError(
      payload?.error_description ?? payload?.error ?? `token endpoint returned ${res.status}`,
    );
  }

  if (!payload.id_token) {
    logger.warn('oidc token response carried no id_token');
    throw new OidcError(
      'The SSO server did not return an ID token, so the sign-in cannot be verified.',
    );
  }
  const claims = await verifyIdToken(payload.id_token, endpoints, e.OIDC_CLIENT_ID, expectedNonce);
  let userinfo: Record<string, unknown> | null = null;

  if (endpoints.userinfoEndpoint && payload.access_token) {
    try {
      const infoRes = await fetch(endpoints.userinfoEndpoint, {
        headers: {
          authorization: `Bearer ${payload.access_token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (infoRes.ok) {
        const parsed = (await infoRes.json()) as Record<string, unknown>;
        // Some providers wrap the claims in { data: {...} }. Unwrap only when the
        // top level has no `sub`, so a real `data` claim is never mistaken for it.
        const inner = parsed['data'];
        userinfo =
          !('sub' in parsed) && inner && typeof inner === 'object'
            ? (inner as Record<string, unknown>)
            : parsed;
      }
    } catch (err) {
      logger.warn({ err }, 'oidc userinfo request failed; falling back to id_token claims');
    }
  }

  // Who signed in is what the signed token says. Userinfo may add a profile,
  // never a different person.
  const subject = pickString(claims, 'sub');
  const infoSubject = pickString(userinfo, 'sub', 'user_id', 'uid');
  if (!subject) throw new OidcError('SSO did not return a subject identifier');
  // Before the ID token was verified, identities were stored under whatever
  // userinfo called the person (`sub`, `user_id` or `uid`), which need not be the
  // token's `sub`. It is offered ONLY for finding such a legacy row; it is never
  // used to create or authenticate anything.
  const legacySubject = infoSubject && infoSubject !== subject ? infoSubject : null;
  const infoEmail = pickString(userinfo, 'email', 'mail');
  const claimEmail = pickString(claims, 'email');
  const email = infoEmail ?? claimEmail;
  // The flag must describe the address we use: userinfo's own flag first, then
  // the token's flag when the token names the same address.
  const emailVerified =
    (infoEmail ? pickBoolean(userinfo, 'email_verified') : null) ??
    (claimEmail && email && claimEmail.toLowerCase() === email.toLowerCase()
      ? pickBoolean(claims, 'email_verified')
      : null) ??
    false;
  if (!email) {
    throw new OidcError(
      'SSO did not return an email address. Grant the "email" scope to this application at the SSO provider.',
    );
  }

  return {
    subject,
    legacySubject,
    issuer: configuredIssuer(),
    email,
    emailVerified,
    name:
      pickString(userinfo, 'name', 'display_name', 'preferred_username') ??
      pickString(claims, 'name', 'preferred_username'),
    avatarUrl: pickString(userinfo, 'picture') ?? pickString(claims, 'picture'),
  };
}

/**
 * Secret handling.
 *
 * Every credential this app issues is high-entropy random, so tokens are stored
 * as an HMAC-SHA256 keyed by SESSION_SECRET rather than a slow password hash:
 * there is nothing to brute-force in a 256-bit random string, and the keying
 * means a database dump alone is not enough to forge a lookup.
 *
 * Login codes are the exception — six digits is *low* entropy — so they lean on
 * a short TTL, an attempt cap and a per-address rate limit instead of hash cost.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { LOGIN_CODE } from '@onmyradar/contract';

/**
 * The stored form of a credential this app issued: sessions, PATs, OAuth
 * tokens and codes, login codes, webhook tokens. Looked up, never shown.
 *
 * Deliberately unprefixed, and it must stay so: every row in those tables was
 * written this way, and a stored HMAC cannot be re-derived without the secret
 * it hashes, so changing this function signs everybody out.
 */
export function hashSecret(value: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(value).digest('hex');
}

/** What a `signFor` signature vouches for. Each is its own HMAC domain. */
export type SignaturePurpose = 'invite' | 'oidc-state' | 'login-challenge';

/**
 * A signature a caller gets to see — an invitation link, the SSO state cookie.
 *
 * Separate from `hashSecret` by a purpose prefix inside the MAC, so a value
 * signed for one purpose is never a valid signature for another, and never
 * equal to the stored hash of any credential. The prefix starts `onmyradar/`,
 * which no issued credential does (`omr_…`, base64url, six digits), so the two
 * domains are disjoint by construction rather than by the formats happening
 * not to collide.
 */
export function signFor(purpose: SignaturePurpose, value: string): string {
  return createHmac('sha256', env().SESSION_SECRET)
    .update(`onmyradar/${purpose}/v1\n`)
    .update(value)
    .digest('hex');
}

/** Compare two same-length hex digests without leaking position through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 32 bytes of entropy, base64url, no padding. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export const SESSION_TOKEN_PREFIX = 'omr_s_';
export const API_TOKEN_PREFIX = 'omr_pat_';
/** An outside system's credential (`docs/HELPDESK.md` §3). Resolves on `/api/v1/helpdesk` only. */
export const INTEGRATION_TOKEN_PREFIX = 'omr_int_';

export function newSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomToken()}`;
}

export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomToken()}`;
}

export function newIntegrationToken(): string {
  return `${INTEGRATION_TOKEN_PREFIX}${randomToken()}`;
}

/**
 * The non-secret shard shown in the UI after the secret is gone, so a user can
 * tell which row to revoke. Long enough to disambiguate, far too short to guess.
 */
export function tokenPrefix(token: string): string {
  return token.slice(0, API_TOKEN_PREFIX.length + 6);
}

/** Uniformly random N-digit code, zero-padded. `randomInt` is rejection-sampled. */
export function newLoginCode(): string {
  const max = 10 ** LOGIN_CODE.length;
  return String(randomInt(0, max)).padStart(LOGIN_CODE.length, '0');
}

/**
 * RFC 7636 S256 verifier check for the MCP OAuth authorization server.
 *
 * S256 only. `plain` is refused rather than compared: OAuth 2.1 drops it, the
 * authorize endpoint has never accepted it, and a `plain` challenge is the
 * verifier itself — anything that saw the authorization request could redeem
 * the code.
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

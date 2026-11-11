import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadEnv, setEnvForTesting } from '../env.js';
import {
  API_TOKEN_PREFIX,
  hashSecret,
  newApiToken,
  newLoginCode,
  safeEqual,
  tokenPrefix,
  verifyPkce,
} from './crypto.js';

beforeAll(() => {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'x'.repeat(48),
      NODE_ENV: 'test',
    }),
  );
});

describe('hashSecret', () => {
  it('is deterministic and does not return the input', () => {
    const hashed = hashSecret('hunter2');
    expect(hashed).toBe(hashSecret('hunter2'));
    expect(hashed).not.toContain('hunter2');
    expect(hashed).toHaveLength(64);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal values without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('login codes', () => {
  it('are always six digits, zero-padded', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(newLoginCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('api tokens', () => {
  it('carry a recognisable prefix and enough entropy', () => {
    const token = newApiToken();
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(tokenPrefix(token)).toHaveLength(API_TOKEN_PREFIX.length + 6);
    expect(token.startsWith(tokenPrefix(token))).toBe(true);
  });
});

describe('PKCE', () => {
  it('accepts a correct S256 verifier', () => {
    const verifier = 'a'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge, 'S256')).toBe(true);
  });

  it('rejects a wrong verifier and an unsupported method', () => {
    const challenge = createHash('sha256').update('a'.repeat(64)).digest('base64url');
    expect(verifyPkce('b'.repeat(64), challenge, 'S256')).toBe(false);
    expect(verifyPkce('anything', challenge, 'RS256')).toBe(false);
  });

  it('refuses plain, where the challenge is the verifier', () => {
    const verifier = 'a'.repeat(64);
    expect(verifyPkce(verifier, verifier, 'plain')).toBe(false);
  });
});

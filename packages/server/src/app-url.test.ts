/**
 * `APP_URL` splits "where a person goes" from "what the API is called".
 *
 * The default is the property worth pinning: a deployment that has not split
 * its client must not discover that it now points people somewhere else.
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://unused',
  SESSION_SECRET: 'x'.repeat(48),
  NODE_ENV: 'test',
} as NodeJS.ProcessEnv;

describe('APP_URL', () => {
  it('defaults to PUBLIC_URL when unset', () => {
    const env = loadEnv({ ...base, PUBLIC_URL: 'https://onmyradar.io' });
    expect(env.APP_URL).toBe('https://onmyradar.io');
  });

  it('takes its own value when set, leaving PUBLIC_URL alone', () => {
    const env = loadEnv({
      ...base,
      PUBLIC_URL: 'https://api.onmyradar.io',
      APP_URL: 'https://app.onmyradar.io',
    });
    expect(env.PUBLIC_URL).toBe('https://api.onmyradar.io');
    expect(env.APP_URL).toBe('https://app.onmyradar.io');
  });

  it('strips a trailing slash, like PUBLIC_URL does', () => {
    const env = loadEnv({ ...base, PUBLIC_URL: 'https://a.io/', APP_URL: 'https://b.io///' });
    expect(env.APP_URL).toBe('https://b.io');
    expect(env.PUBLIC_URL).toBe('https://a.io');
  });

  it('parses an empty CORS list to no origins at all', () => {
    expect(loadEnv({ ...base }).CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('trims and drops the blanks a hand-edited CSV collects', () => {
    const env = loadEnv({ ...base, CORS_ALLOWED_ORIGINS: ' https://a.io , ,https://b.io/ ' });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.io', 'https://b.io']);
  });
});

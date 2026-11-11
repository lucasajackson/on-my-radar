/** Which sign-in settings may be combined, refused at boot. */
import { describe, expect, it } from 'vitest';
import { isLocalHost } from './local-host.js';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgres://unused', SESSION_SECRET: 'x'.repeat(48) };
const load = (extra: Record<string, string>) => loadEnv({ ...base, ...extra });
const single = (url: string, extra: Record<string, string> = {}) =>
  load({ SINGLE_USER_EMAIL: 'me@example.com', PUBLIC_URL: url, ...extra });

const LOCAL = [
  'http://localhost:3500',
  'http://notes.localhost',
  'http://127.0.0.1:3500',
  'http://[::1]:3500',
  'http://10.1.2.3',
  'http://172.16.0.5',
  'http://172.31.255.1',
  'http://192.168.1.10:3500',
  'http://100.64.0.1',
  'http://169.254.1.1',
  'http://[fd12:3456::1]',
  'http://[fe80::1]',
  'http://box.local',
  'http://nas.lan',
  'http://box.home.arpa',
  'http://svc.internal',
];
const PUBLIC = [
  'https://example.com',
  'http://8.8.8.8',
  'http://172.32.0.1',
  'http://100.128.0.1',
  'http://[2001:db8::1]',
  'http://localhost.example.com',
  'http://10.example.com',
  'http://notlocal',
];

describe('single-user mode is for local hosts only', () => {
  it.each(LOCAL)('boots on %s', (url) => {
    expect(isLocalHost(new URL(url).hostname)).toBe(true);
    expect(single(url).SINGLE_USER_EMAIL).toBe('me@example.com');
  });

  it.each(PUBLIC)('refuses %s', (url) => {
    expect(() => single(url)).toThrow('must be a local host');
  });

  it('refuses a public APP_URL beside a local PUBLIC_URL', () => {
    expect(() => single('http://localhost:3500', { APP_URL: 'https://example.com' })).toThrow(
      'must be a local host',
    );
  });

  it('is off when the address is empty, and the address must be one', () => {
    expect(
      load({ SINGLE_USER_EMAIL: '', PUBLIC_URL: 'https://example.com' }).SINGLE_USER_EMAIL,
    ).toBe(undefined);
    expect(() => single('http://localhost:3500', { SINGLE_USER_EMAIL: 'nope' })).toThrow();
  });
});

describe('the sign-in combinations', () => {
  const oidc = {
    OIDC_ISSUER_URL: 'https://idp.test',
    OIDC_CLIENT_ID: 'a',
    OIDC_CLIENT_SECRET: 'b',
  };

  it('refuses single-user beside a password or SSO', () => {
    expect(() => single('http://localhost:3500', { PASSWORD_LOGIN_ENABLED: 'true' })).toThrow(
      'cannot be combined',
    );
    expect(() => single('http://localhost:3500', oidc)).toThrow('cannot be combined');
  });

  it('allows password with SSO, and each alone', () => {
    const mail = { MAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://relay.example.com' };
    expect(load({ ...mail, PASSWORD_LOGIN_ENABLED: 'true', ...oidc }).PASSWORD_LOGIN_ENABLED).toBe(
      true,
    );
    expect(load(oidc).PASSWORD_LOGIN_ENABLED).toBe(false);
  });

  it('refuses a password with no way to send the reset code', () => {
    expect(() => load({ PASSWORD_LOGIN_ENABLED: 'true', NODE_ENV: 'production' })).toThrow(
      'needs outbound mail',
    );
  });
});

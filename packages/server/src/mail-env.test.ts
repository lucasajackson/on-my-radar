import { describe, expect, it } from 'vitest';
import { loadEnv, mailConfigured, mailProvider } from './env.js';

const base = { DATABASE_URL: 'postgres://unused', SESSION_SECRET: 'x'.repeat(48) };
const load = (extra: Record<string, string>) => loadEnv({ ...base, ...extra });

describe('MAIL_PROVIDER', () => {
  it('keeps today’s behaviour where it is not set', () => {
    // Production sets a Resend key and nothing else.
    expect(mailProvider(load({ NODE_ENV: 'production', RESEND_API_KEY: 're_x' }))).toBe('resend');
    expect(mailConfigured(load({ NODE_ENV: 'production', RESEND_API_KEY: 're_x' }))).toBe(true);
    // Development with no key logs, and a sign-in code is handed back.
    expect(mailProvider(load({ NODE_ENV: 'development' }))).toBe('console');
    expect(mailConfigured(load({ NODE_ENV: 'development' }))).toBe(false);
    // Production with nothing configured is not a log: sending throws.
    expect(mailProvider(load({ NODE_ENV: 'production' }))).toBe('none');
    expect(mailConfigured(load({ NODE_ENV: 'production' }))).toBe(false);
    // An empty key (a blank secret) is no key.
    expect(mailProvider(load({ NODE_ENV: 'production', RESEND_API_KEY: '' }))).toBe('none');
    expect(mailProvider(load({ NODE_ENV: 'production', MAIL_PROVIDER: '' }))).toBe('none');
  });

  it('delivers through smtp when told to, key or no key', () => {
    const e = load({
      MAIL_PROVIDER: 'smtp',
      SMTP_URL: 'smtp://relay.example.com',
      RESEND_API_KEY: 're_x',
    });
    expect(mailProvider(e)).toBe('smtp');
    expect(mailConfigured(e)).toBe(true);
  });

  it('refuses console in production, at boot', () => {
    expect(() => load({ NODE_ENV: 'production', MAIL_PROVIDER: 'console' })).toThrow(
      'MAIL_PROVIDER=console is development only',
    );
    expect(mailProvider(load({ NODE_ENV: 'development', MAIL_PROVIDER: 'console' }))).toBe(
      'console',
    );
  });

  it('refuses a provider that cannot work', () => {
    expect(() => load({ MAIL_PROVIDER: 'smtp' })).toThrow('requires SMTP_URL');
    expect(() => load({ MAIL_PROVIDER: 'resend' })).toThrow('requires RESEND_API_KEY');
    expect(() => load({ MAIL_PROVIDER: 'smtp', SMTP_URL: 'http://nope' })).toThrow(
      'smtp:// or smtps://',
    );
    expect(() => load({ MAIL_PROVIDER: 'sendgrid' })).toThrow('MAIL_PROVIDER');
  });

  it('derives the sender and the push contact from PUBLIC_URL unless they are set', () => {
    const derived = load({ PUBLIC_URL: 'https://omr.example.org/' });
    expect(derived.MAIL_FROM).toBe('On My Radar <noreply@omr.example.org>');
    expect(derived.VAPID_SUBJECT).toBe('mailto:noreply@omr.example.org');
    const set = load({
      MAIL_FROM: 'Ops <ops@example.com>',
      VAPID_SUBJECT: 'mailto:push@example.com',
    });
    expect(set.MAIL_FROM).toBe('Ops <ops@example.com>');
    expect(set.VAPID_SUBJECT).toBe('mailto:push@example.com');
    // A sender without a display name is the contact as written.
    expect(load({ MAIL_FROM: 'ops@example.com' }).VAPID_SUBJECT).toBe('mailto:ops@example.com');
  });

  it('refuses a sender that spans lines', () => {
    expect(() => load({ MAIL_FROM: 'On My Radar <a@b.com>\r\nBcc: x@y.com' })).toThrow(
      'single line',
    );
  });

  it('keeps the SMTP deadline inside the fence transaction’s idle timeout', () => {
    const smtp = { MAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://relay.example.com' };
    expect(load(smtp).SMTP_TIMEOUT_MS).toBeLessThan(load(smtp).DB_IDLE_IN_TRANSACTION_TIMEOUT_MS);
    expect(() => load({ ...smtp, SMTP_TIMEOUT_MS: '30000' })).toThrow(
      'SMTP_TIMEOUT_MS must be less than',
    );
    expect(
      load({ ...smtp, SMTP_TIMEOUT_MS: '30000', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60000' })
        .SMTP_TIMEOUT_MS,
    ).toBe(30000);
    // Only SMTP runs inside the fence for that long.
    expect(() => load({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1000' })).not.toThrow();
  });
});

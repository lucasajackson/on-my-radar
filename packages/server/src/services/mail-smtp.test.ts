/**
 * The SMTP provider against a real server: `axllent/mailpit`, a CI service of
 * the `verify` job. Everything about SMTP that a mock would flatter (STARTTLS,
 * header folding, what actually lands in the mailbox) is read back from it.
 *
 * Locally, run `docker run -p 11025:1025 -p 18025:8025 mirror.gcr.io/axllent/mailpit`
 * and set MAILPIT_SMTP=127.0.0.1:11025 MAILPIT_API=http://127.0.0.1:18025. Without them the
 * suite is skipped, except in CI, where a missing service fails it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, setEnvForTesting } from '../env.js';
import { MailError, sendMail } from './mail.js';
vi.mock('./account-lifecycle.js', () => ({
  withOpenRecipient: vi.fn(async (_email: string, send: () => Promise<void>) => send()),
}));

const api = process.env['MAILPIT_API'];
const smtpAddress = process.env['MAILPIT_SMTP'];
const API = api ?? '';

interface Listed {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

async function inbox(): Promise<Listed[]> {
  const res = await fetch(`${API}/api/v1/messages`);
  return ((await res.json()) as { messages: Listed[] }).messages;
}

function useSmtp(query: string): void {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'x'.repeat(48),
      NODE_ENV: 'test',
      MAIL_PROVIDER: 'smtp',
      SMTP_URL: `smtp://${smtpAddress ?? ''}${query}`,
      MAIL_FROM: 'On My Radar <hello@onmyradar.test>',
    }),
  );
}

describe.skipIf(!api && !process.env['CI'])('smtp provider against mailpit', () => {
  beforeAll(() => {
    if (!api || !smtpAddress)
      throw new Error('MAILPIT_API and MAILPIT_SMTP must point at the mailpit service in CI');
  });
  beforeEach(async () => {
    await fetch(`${API}/api/v1/messages`, { method: 'DELETE' });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('delivers the message with its sender, recipient, subject and both bodies', async () => {
    useSmtp('?tls=none');
    await sendMail({
      to: 'reader@example.com',
      subject: '123456 is your sign-in code',
      html: '<p>Hello <b>there</b></p>',
      text: 'Hello there',
    });
    const [only, ...rest] = await inbox();
    expect(rest).toEqual([]);
    expect(only?.Subject).toBe('123456 is your sign-in code');
    expect(only?.To.map((t) => t.Address)).toEqual(['reader@example.com']);
    const full = (await (await fetch(`${API}/api/v1/message/${only?.ID ?? ''}`)).json()) as {
      From: { Address: string; Name: string };
      Text: string;
      HTML: string;
    };
    expect(full.From).toMatchObject({ Address: 'hello@onmyradar.test', Name: 'On My Radar' });
    expect(full.Text.trim()).toBe('Hello there');
    expect(full.HTML).toContain('<b>there</b>');
  });

  it('requires STARTTLS unless the URL says otherwise: a server without it gets nothing', async () => {
    // Mailpit offers no STARTTLS here, so the downgrade guard is what refuses.
    useSmtp('');
    await expect(
      sendMail({ to: 'reader@example.com', subject: 'Secret', html: '', text: 'code 123456' }),
    ).rejects.toThrow(/STARTTLS/i);
    expect(await inbox()).toEqual([]);
  });

  it('sends a subject carrying a line break as one header, with no injected Bcc', async () => {
    useSmtp('?tls=none');
    await sendMail({
      to: 'reader@example.com',
      subject: 'Ada shared the "Work\r\nBcc: victim@example.com" radar with you',
      html: '',
      text: 'hi',
    });
    const [only] = await inbox();
    const raw = await (await fetch(`${API}/api/v1/message/${only?.ID ?? ''}/raw`)).text();
    const headers = raw.split(/\r?\n\r?\n/)[0] ?? '';
    expect(headers).not.toMatch(/^bcc:/im);
    expect(only?.Subject).toBe('Ada shared the "Work Bcc: victim@example.com" radar with you');
  });

  it('refuses a recipient that would address a second person, and sends nothing', async () => {
    useSmtp('?tls=none');
    await expect(
      sendMail({
        to: 'reader@example.com\r\nBcc: victim@example.com',
        subject: 'Hi',
        html: '',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(MailError);
    await expect(
      sendMail({ to: 'a@example.com, victim@example.com', subject: 'Hi', html: '', text: 'hi' }),
    ).rejects.toBeInstanceOf(MailError);
    expect(await inbox()).toEqual([]);
  });
});

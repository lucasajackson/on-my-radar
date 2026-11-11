import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, setEnvForTesting, type Env } from '../env.js';
import { logger } from '../logger.js';
import { MailError, deliverQueuedEmail, sendMail } from './mail.js';
import { withOpenRecipient } from './account-lifecycle.js';
vi.mock('./account-lifecycle.js', () => ({
  withOpenRecipient: vi.fn(async (_email: string, send: () => Promise<void>) => send()),
}));

function sentRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    headers: init.headers as Record<string, string>,
    body: JSON.parse(typeof init.body === 'string' ? init.body : '') as { subject: string },
  };
}

describe('outbound mail', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'x'.repeat(48),
        NODE_ENV: 'test',
        RESEND_API_KEY: 're_test_key',
      }),
    );
    fetchMock = vi.fn(async () => new Response('{"id":"sent"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('suppresses a queued message after recipient access closure', async () => {
    vi.mocked(withOpenRecipient).mockImplementationOnce(async () => undefined);
    await deliverQueuedEmail(
      { to: 'reader@example.com', subject: 'Hello', text: 'private', html: '' },
      { id: 'closed-job' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a subject as one line even when a name inside it holds a line break', async () => {
    await sendMail({
      to: 'reader@example.com',
      subject: 'Ada shared the "Work\r\nBcc: someone@example.com" radar with you',
      html: '<p>hi</p>',
      text: 'hi',
    });
    expect(sentRequest(fetchMock).body.subject).toBe(
      'Ada shared the "Work Bcc: someone@example.com" radar with you',
    );
  });

  it('keys a queued email to its job, so a retry after acceptance is not a second send', async () => {
    const payload = { to: 'reader@example.com', subject: 'Hello', html: '<p>hi</p>', text: 'hi' };
    await deliverQueuedEmail(payload, { id: 'job-1' });
    expect(sentRequest(fetchMock).headers['idempotency-key']).toBe('outbox-email/job-1');
  });

  it('sends no idempotency key where the caller cannot promise an identical retry', async () => {
    await sendMail({ to: 'reader@example.com', subject: 'Code', html: '', text: '' });
    expect(sentRequest(fetchMock).headers['idempotency-key']).toBeUndefined();
  });
});

const BASE_ENV = { DATABASE_URL: 'postgres://unused', SESSION_SECRET: 'x'.repeat(48) };
const SMTP_ENV = { MAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://relay.example.com' };

describe('every provider stays inside the closure fence', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let smtpSend: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let inside = false;
  const touched: boolean[] = [];

  /** Each provider’s one outward call, recording whether the fence was open around it. */
  const providers = [
    { name: 'resend', env: { RESEND_API_KEY: 're_test_key' } },
    { name: 'smtp', env: SMTP_ENV },
    { name: 'console', env: { MAIL_PROVIDER: 'console' } },
  ];
  let n = 0;

  beforeEach(() => {
    touched.length = 0;
    inside = false;
    vi.mocked(withOpenRecipient).mockImplementation(async (_email, send) => {
      inside = true;
      try {
        await send();
      } finally {
        inside = false;
      }
    });
    fetchMock = vi.fn(async () => {
      touched.push(inside);
      return new Response('{"id":"sent"}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    smtpSend = vi.fn(async () => {
      touched.push(inside);
      return { accepted: ['reader@example.com'] };
    });
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(
      () => ({ sendMail: smtpSend, close: vi.fn() }) as never,
    );
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
      touched.push(inside);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(withOpenRecipient).mockImplementation(async (_e, send) => send());
  });

  const use = (extra: Record<string, string>) =>
    setEnvForTesting(loadEnv({ ...BASE_ENV, NODE_ENV: 'test', ...extra }));
  // A distinct URL per test: the SMTP transport is cached by URL.
  const smtpEnv = () => ({ ...SMTP_ENV, SMTP_URL: `smtp://relay-${++n}.example.com` });

  for (const provider of providers) {
    const env = () => (provider.name === 'smtp' ? smtpEnv() : provider.env);
    const message = { to: 'reader@example.com', subject: 'Hello', html: '<p>hi</p>', text: 'hi' };

    it(`${provider.name}: is called only while the recipient’s account is open`, async () => {
      use(env());
      await sendMail(message);
      expect(touched).toEqual([true]);
    });

    it(`${provider.name}: is not called for a closed account`, async () => {
      use(env());
      vi.mocked(withOpenRecipient).mockImplementationOnce(async () => undefined);
      await sendMail(message);
      expect(touched).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(smtpSend).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      'a@example.com\r\nBcc: victim@example.com',
      'a@example.com\nBcc: victim@example.com',
      'a@example.com, victim@example.com',
      'a@example.com;victim@example.com',
      'Ada <a@example.com>',
      '"a b"@example.com',
      'a@example.com\u2028victim@example.com',
      'a@example.com\0',
      'not-an-address',
    ])(`${provider.name}: refuses the recipient %j before anything is sent`, async (to) => {
      use(env());
      await expect(sendMail({ ...message, to })).rejects.toBeInstanceOf(MailError);
      expect(withOpenRecipient).not.toHaveBeenCalled();
      expect(touched).toEqual([]);
    });
  }

  it('smtp: hands the library a subject with no line break in it', async () => {
    use(smtpEnv());
    await sendMail({
      to: 'reader@example.com',
      subject: 'Ada shared the "Work\r\nBcc: victim@example.com" radar with you',
      html: '',
      text: '',
    });
    const [sent] = smtpSend.mock.calls[0] as [{ subject: string; to: string }];
    expect(sent.subject).toBe('Ada shared the "Work Bcc: victim@example.com" radar with you');
    expect(sent.to).toBe('reader@example.com');
  });

  it('smtp: a send the server did not accept is an error, and never quotes SMTP_URL', async () => {
    use({ ...SMTP_ENV, SMTP_URL: `smtp://ada:hunter2@relay-${++n}.example.com` });
    smtpSend.mockRejectedValueOnce(
      Object.assign(new Error('Invalid login: 535 5.7.8 rejected'), {
        code: 'EAUTH',
        responseCode: 535,
        command: 'AUTH PLAIN',
      }),
    );
    const err = await sendMail({
      to: 'reader@example.com',
      subject: 'Hi',
      html: '',
      text: '',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(String(err)).toContain('code=EAUTH, status=535, command=AUTH PLAIN');
    expect(String(err)).not.toContain('hunter2');
    smtpSend.mockResolvedValueOnce({ accepted: [] });
    await expect(
      sendMail({ to: 'reader@example.com', subject: 'Hi', html: '', text: '' }),
    ).rejects.toThrow('accepted no recipient');
  });
});

describe('the console provider', () => {
  const CODE = '483920';
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  afterEach(() => vi.restoreAllMocks());

  const message = {
    to: 'reader@example.com',
    subject: `${CODE} is your sign-in code`,
    html: '',
    text: `Your sign-in code is ${CODE}.`,
  };

  it('logs the message outside production, which is the point of it', async () => {
    setEnvForTesting(loadEnv({ ...BASE_ENV, NODE_ENV: 'development', MAIL_PROVIDER: 'console' }));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await sendMail(message);
    expect(JSON.stringify(warn.mock.calls)).toContain(CODE);
  });

  it('never logs a sign-in code in production, even if boot validation was bypassed', async () => {
    const e: Env = {
      ...loadEnv({ ...BASE_ENV, NODE_ENV: 'development', MAIL_PROVIDER: 'console' }),
      NODE_ENV: 'production',
    };
    setEnvForTesting(e);
    const spies = levels.map((level) =>
      vi.spyOn(logger, level).mockImplementation(() => undefined),
    );
    await expect(sendMail(message)).rejects.toBeInstanceOf(MailError);
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(CODE);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('is not what an unconfigured production instance falls back to', async () => {
    setEnvForTesting(loadEnv({ ...BASE_ENV, NODE_ENV: 'production' }));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(sendMail(message)).rejects.toThrow('Email is not configured');
    expect(warn).not.toHaveBeenCalled();
  });
});

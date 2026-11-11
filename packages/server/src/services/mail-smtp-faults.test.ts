/**
 * The SMTP provider against a relay that misbehaves. The relay is a small
 * in-process server, so these run everywhere (no Mailpit needed).
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, setEnvForTesting } from '../env.js';
import { logger } from '../logger.js';
import { MailError, sendMail } from './mail.js';
vi.mock('./account-lifecycle.js', () => ({
  withOpenRecipient: vi.fn(async (_email: string, send: () => Promise<void>) => send()),
}));

const CODE = '483920';

interface Relay {
  port: number;
  /** Resolves when the client has closed or lost its connection. */
  closed: Promise<void>;
  stop: () => Promise<void>;
}

/** Just enough SMTP for one message. `replyDelayMs` is waited before every reply. */
async function relay(opts: { replyDelayMs?: number; rcpt?: string } = {}): Promise<Relay> {
  const sockets = new Set<Socket>();
  let closedAll!: () => void;
  const closed = new Promise<void>((resolve) => (closedAll = resolve));
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      closedAll();
    });
    let data = false;
    let buffer = '';
    const say = (line: string) =>
      setTimeout(() => socket.writable && socket.write(`${line}\r\n`), opts.replyDelayMs ?? 0);
    say('220 relay.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (data) {
        if (!buffer.endsWith('\r\n.\r\n')) return;
        data = false;
        buffer = '';
        say('250 2.0.0 queued');
        return;
      }
      for (let nl = buffer.indexOf('\r\n'); nl >= 0; nl = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, nl).toUpperCase();
        buffer = buffer.slice(nl + 2);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) say('250 relay.test');
        else if (line.startsWith('MAIL')) say('250 2.1.0 ok');
        else if (line.startsWith('RCPT')) say(opts.rcpt ?? '250 2.1.5 ok');
        else if (line.startsWith('DATA')) {
          data = true;
          say('354 go ahead');
          return;
        } else if (line.startsWith('QUIT')) say('221 bye');
        else say('250 ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    closed,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const message = {
  to: 'reader@example.com',
  subject: `${CODE} is your sign-in code`,
  html: '',
  text: `Your sign-in code is ${CODE}.`,
};

function useRelay(port: number, extra: Record<string, string> = {}): void {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'x'.repeat(48),
      NODE_ENV: 'test',
      MAIL_PROVIDER: 'smtp',
      SMTP_URL: `smtp://127.0.0.1:${port}?tls=none`,
      ...extra,
    }),
  );
}

describe('the smtp provider against a faulty relay', () => {
  let current: Relay | undefined;
  beforeEach(() => {
    current = undefined;
  });
  afterEach(async () => {
    await current?.stop();
    vi.restoreAllMocks();
  });

  it('gives up at one overall deadline and drops the connection, though every reply arrives in time', async () => {
    // Each reply lands well inside the library's own 10 s and 15 s timers, so
    // only an overall deadline ends this send: six round trips of 400 ms.
    current = await relay({ replyDelayMs: 400 });
    useRelay(current.port, { SMTP_TIMEOUT_MS: '1000' });
    const started = Date.now();
    const err = await sendMail(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(String(err)).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(1800);
    // The abandoned send is torn down, not left to finish in the background.
    await expect(
      Promise.race([
        current.closed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('still open'), 1000)),
      ]),
    ).resolves.toBe('closed');
  });

  it('delivers when the relay is slow but inside the deadline', async () => {
    current = await relay({ replyDelayMs: 30 });
    useRelay(current.port, { SMTP_TIMEOUT_MS: '5000' });
    await expect(sendMail(message)).resolves.toBeUndefined();
  });

  it('keeps what the relay says out of the error', async () => {
    current = await relay({
      rcpt: `550 5.7.1 rejected: subject "${CODE} is your sign-in code" looks like spam`,
    });
    useRelay(current.port);
    const err = await sendMail(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).message).toContain('status=550');
    expect((err as MailError).cause).toBeUndefined();
    // What a logger would serialise: message, stack, and every own property.
    const logged = JSON.stringify([
      (err as MailError).message,
      (err as MailError).stack,
      Object.getOwnPropertyNames(err).map((k) => String((err as never)[k])),
    ]);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain('spam');
  });

  it('keeps what Resend says out of the error', async () => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'x'.repeat(48),
        NODE_ENV: 'test',
        RESEND_API_KEY: 're_test_key',
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ name: 'validation_error', message: `bad body ${CODE} in subject` }),
            { status: 422 },
          ),
      ),
    );
    try {
      const err = await sendMail(message).catch((e: unknown) => e);
      expect((err as MailError).message).toBe(
        'Resend rejected the message (422, validation_error)',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('logs nothing of the message when a send fails', async () => {
    current = await relay({ rcpt: `550 nope ${CODE}` });
    useRelay(current.port);
    const spies = (['warn', 'info', 'error', 'debug'] as const).map((l) =>
      vi.spyOn(logger, l).mockImplementation(() => undefined),
    );
    await sendMail(message).catch(() => undefined);
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(CODE);
  });
});

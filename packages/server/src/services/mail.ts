import { withOpenRecipient } from './account-lifecycle.js';
/**
 * Transactional email. `MAIL_PROVIDER` picks the transport (docs/DEPLOY.md):
 *
 *   resend   the estate's standard provider, and what production runs.
 *   smtp     any SMTP server, from `SMTP_URL`; STARTTLS is required unless the
 *            URL says otherwise (`smtp-url.ts`).
 *   console  development only: the message is logged, nothing is sent.
 *
 * Unset, the provider is Resend when `RESEND_API_KEY` is set and the log
 * otherwise, so an existing deployment needs no new setting. Where nothing is
 * configured in production, sending is a hard error: silently swallowing a
 * login email would look like a working sign-in flow that simply never arrives.
 *
 * `sendMail` is the only place a provider is called, and every provider is
 * called inside `withOpenRecipient`, so none can mail an account that has closed.
 */
import { connect, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { LOGIN_CODE } from '@onmyradar/contract';
import { env, mailProvider } from '../env.js';
import { logger } from '../logger.js';
import { registerOutboxHandler, type OutboxJob } from './outbox.js';
import { textValue } from '../text-value.js';
import { parseSmtpUrl } from '../smtp-url.js';
import { button, codeBlock, layout, paragraph, quote } from './mail-layout.js';

export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export class MailError extends Error {}

/**
 * One bare address. A recipient is the second header an attacker can reach (the
 * first is the subject): a mail library reads `a@x.com, b@y.com` as two people,
 * and a line break as a new header, so anything that is not a plain
 * `local@domain` is refused rather than cleaned up.
 */
const BARE_ADDRESS = /^[^\s\p{Cc}<>(),;:"\\@]+@[^\s\p{Cc}<>(),;:"\\@]+$/u;

/**
 * A transport for one send, plus a way to cut its connection. The library gives
 * no handle on the socket it opens, so it is handed one of ours: destroying it
 * ends the send at once, where a send merely abandoned at its deadline would
 * carry on in the background, delivering to a closed account or, after a
 * retry, twice. Nothing here may echo `url`: it holds the password.
 */
function smtpTransport(url: string) {
  const target = parseSmtpUrl(url);
  const sockets: Socket[] = [];
  const transport = nodemailer.createTransport({
    host: target.host,
    port: target.port,
    secure: target.secure,
    requireTLS: target.requireTLS,
    ignoreTLS: target.ignoreTLS,
    ...(target.auth ? { auth: target.auth } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    // The connected socket, handed over so that `destroy` can reach it; the
    // library still does the TLS handshake and the conversation on top of it.
    getSocket: (_options, done) => {
      const socket = connect({ host: target.host, port: target.port });
      sockets.push(socket);
      const failed = (err: Error) => done(err, false);
      socket.once('error', failed);
      socket.once('connect', () => {
        socket.off('error', failed);
        done(null, { connection: socket });
      });
    },
  });
  return { transport, destroy: () => sockets.forEach((socket) => socket.destroy()) };
}

const SAFE_NAME = /^[A-Za-z0-9_ -]{1,24}$/;
const safe = (value: unknown): string | undefined =>
  typeof value === 'string' && SAFE_NAME.test(value) ? value : undefined;

/**
 * What may be said about a failed SMTP send: the library's error code, the
 * server's numeric status and the command it failed on. Never the reply text or
 * the original error. Relays echo what they were sent (a rejected message's
 * subject, a login code) and a logged error carries its `cause` and `response`.
 */
function smtpFailure(err: unknown): MailError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const status = typeof e['responseCode'] === 'number' ? e['responseCode'] : undefined;
  const detail: Array<[string, string | undefined]> = [
    ['code', safe(e['code'])],
    ['status', status === undefined ? undefined : String(status)],
    ['command', safe(e['command'])],
  ];
  const parts = detail.flatMap(([key, value]) => (value ? [`${key}=${value}`] : []));
  return new MailError(
    `SMTP server did not accept the message (${parts.join(', ') || 'no detail'})`,
  );
}

const safeId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : undefined;

/** One send, abandoned and its connection closed when the deadline passes. */
async function sendSmtp(
  url: string,
  deadlineMs: number,
  data: Parameters<ReturnType<typeof smtpTransport>['transport']['sendMail']>[0],
): Promise<void> {
  const { transport, destroy } = smtpTransport(url);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailError('SMTP send timed out')), deadlineMs);
  });
  const sending = transport.sendMail(data);
  // Whichever loses the race must not become an unhandled rejection.
  sending.catch(() => undefined);
  try {
    const info: unknown = await Promise.race([sending, expired]);
    if (!(info as { accepted?: unknown[] }).accepted?.length)
      throw new MailError('SMTP server accepted no recipient');
  } catch (err) {
    throw err instanceof MailError ? err : smtpFailure(err);
  } finally {
    clearTimeout(timer);
    destroy();
  }
}

/**
 * `idempotencyKey` is Resend's own duplicate guard: a request repeating a key
 * it accepted in the last 24 hours returns the original response instead of
 * sending again. Only a caller whose retries carry an identical payload may
 * pass one — Resend answers a changed payload under a used key with a 409.
 * SMTP has no such guard, so a retry after a timed-out but accepted send can
 * deliver twice.
 */
export async function sendMail(
  message: Message,
  options: { idempotencyKey?: string } = {},
): Promise<void> {
  if (!BARE_ADDRESS.test(message.to))
    throw new MailError('Refusing to send: recipient is not a single plain address');
  return withOpenRecipient(message.to, async () => {
    const e = env();
    // A subject is one header line. Radar names, array names and display names
    // are user text that may hold a line break, and a subject carrying one is
    // not something a mail API should be asked to interpret.
    const subject = message.subject.replace(/\s+/g, ' ').trim();
    const provider = mailProvider(e);

    if (provider === 'smtp') {
      await sendSmtp(e.SMTP_URL ?? '', e.SMTP_TIMEOUT_MS, {
        from: e.MAIL_FROM,
        to: message.to,
        subject,
        html: message.html,
        text: message.text,
        // A message is built from these fields and nothing else: no value in
        // it may make the server read a file or fetch a URL.
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return;
    }

    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${e.RESEND_API_KEY ?? ''}`,
          'content-type': 'application/json',
          ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: e.MAIL_FROM,
          to: [message.to],
          subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        // The reply is not logged: it can echo the request. Its error type, a
        // short snake_case name, is enough to act on.
        const name = await res
          .json()
          .then((body) => safe((body as { name?: unknown }).name))
          .catch(() => undefined);
        throw new MailError(
          `Resend rejected the message (${res.status}${name ? `, ${name}` : ''})`,
        );
      }
      // The provider's id is what ties a log line to a delivery event there.
      const sent = await res.json().catch(() => ({}));
      logger.info(
        { resendId: safeId((sent as { id?: unknown }).id), domain: message.to.split('@')[1] },
        'mail accepted by Resend',
      );
      return;
    }

    // `console`, or nothing configured. The log holds the message body, sign-in
    // code included, so it is never reachable in production, whatever set it.
    if (e.NODE_ENV === 'production')
      throw new MailError(
        provider === 'console'
          ? 'MAIL_PROVIDER=console is development only'
          : 'Email is not configured (set RESEND_API_KEY, or MAIL_PROVIDER=smtp with SMTP_URL)',
      );
    logger.warn(
      { to: message.to, subject, body: message.text },
      `mail not sent — ${e.MAIL_PROVIDER === 'console' ? 'MAIL_PROVIDER=console' : 'no RESEND_API_KEY'}`,
    );
  });
}

export function loginCodeMessage(to: string, code: string): Message {
  const minutes = Math.round(LOGIN_CODE.ttlSeconds / 60);
  return {
    to,
    subject: `${code} is your On My Radar sign-in code`,
    text: `Your On My Radar sign-in code is ${code}. It expires in ${minutes} minutes.`,
    html: layout({
      heading: 'Your sign-in code',
      preheader: `${code} — it expires in ${minutes} minutes.`,
      blocks: [
        paragraph([`Enter this code to finish signing in. It expires in ${minutes} minutes.`]),
        codeBlock(code),
        paragraph(['Never share this code. On My Radar will not ask you for it.'], {
          dim: true,
          last: true,
        }),
      ],
    }),
  };
}

export function waitlistMessage(to: string): Message {
  return {
    to,
    subject: 'You are on the On My Radar waitlist',
    text: `Thanks for signing up to On My Radar. Your account is waiting to be approved — you will get an email as soon as it is.`,
    html: layout({
      heading: 'You’re on the list',
      preheader: 'Your account is waiting to be approved.',
      blocks: [
        paragraph([
          'Thanks for signing up. On My Radar is invite-only while it settles down, so your account is waiting to be approved.',
        ]),
        paragraph(['You will get an email the moment it is — nothing else to do.'], {
          last: true,
        }),
      ],
    }),
  };
}

/**
 * The waitlist form's confirmation. Sent at most once a day per address, and
 * never to an account that is already in (see `services/waitlist.ts`).
 *
 * `name` is whatever the form said, which nobody has verified — so it is only
 * ever a greeting, escaped, and never a claim about the account.
 */
export function waitlistConfirmationMessage(to: string, name?: string | null): Message {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const invitation =
    'Early access opens by invitation, a few people at a time. We’ll email you at this address as soon as your spot is ready, with everything you need to sign in.';
  return {
    to,
    subject: 'You’re on the list for On My Radar',
    text: [
      greeting,
      '',
      'Thanks for joining the On My Radar waitlist — you’re on the list.',
      '',
      `${invitation} There’s nothing else to do until then.`,
      '',
      'Talk soon,',
      'On My Radar',
    ].join('\n'),
    html: layout({
      heading: 'You’re on the list',
      preheader: 'Early access opens by invitation. We’ll email you when your spot is ready.',
      blocks: [
        paragraph([greeting]),
        paragraph(['Thanks for joining the On My Radar waitlist — you’re on the list.']),
        paragraph([invitation]),
        paragraph(['There’s nothing else to do until then. Talk soon.'], { dim: true, last: true }),
      ],
    }),
  };
}

/**
 * Approval, and the start of onboarding.
 *
 * It names the address, because sign-in is by an emailed code *to* that
 * address: somebody who joined the waitlist weeks ago from one of several
 * mailboxes has to know which one to type.
 */
export function approvedMessage(to: string): Message {
  const login = `${env().APP_URL}/login`;
  return {
    to,
    subject: 'Your On My Radar account is ready',
    text: [
      'You’re in — your On My Radar account has been approved.',
      '',
      `Sign in at ${login} with this email address (${to}). We’ll send a six-digit code to this inbox; there’s no password to remember.`,
      '',
      'Your first radar is waiting for you.',
    ].join('\n'),
    html: layout({
      heading: 'You’re in',
      preheader: 'Your account has been approved. Your first radar is waiting.',
      blocks: [
        paragraph(['Your account has been approved, and your first radar is waiting for you.']),
        paragraph([
          'Sign in with this email address — ',
          { strong: to },
          '. We’ll send a six-digit code to this inbox; there’s no password to remember.',
        ]),
        button(login, 'Sign in to On My Radar'),
      ],
    }),
  };
}

/**
 * How a share reads to the person on the other end.
 *
 * `link` is where the button goes and it is not always the same place. Somebody
 * who already has an account is sent straight to the thing that was shared;
 * somebody who does not is sent to a signed invitation link, which lands on the
 * login screen with their address filled in and the radar named. A generic
 * "go to onmyradar.io" is where an invitation quietly becomes a dead end.
 *
 * `skipsWaitlist` is only meaningful for a person with no account, and it is
 * stated plainly. Signup is waitlisted; being told afterwards that you are in a
 * queue, having already typed a code, is the kind of surprise that makes people
 * assume something is broken.
 */
export interface ShareMailContext {
  hasAccount: boolean;
  link: string;
  skipsWaitlist: boolean;
}

function joinNote(ctx: ShareMailContext): string {
  if (ctx.hasAccount) return '';
  return ctx.skipsWaitlist
    ? 'You do not have an account yet — this invitation creates one, and you will go straight in.'
    : 'You do not have an account yet. Signing up puts you on the waitlist, and this will be waiting for you the moment you are approved.';
}

export function radarSharedMessage(
  to: string,
  radarName: string,
  sharerName: string,
  ctx: ShareMailContext,
): Message {
  const action = ctx.hasAccount ? 'Open the radar' : 'Accept the invitation';
  const note = joinNote(ctx);
  return {
    to,
    subject: `${sharerName} shared the "${radarName}" radar with you`,
    text: `${sharerName} shared the "${radarName}" radar with you on On My Radar.${
      note ? ` ${note}` : ''
    }\n\n${ctx.link}`,
    // The heading is plain text and escaped once, by the layout. It used to be
    // escaped here as well, so a sharer called "R&D" arrived as "R&amp;D".
    html: layout({
      heading: `${sharerName} shared a radar with you`,
      preheader: `${radarName} is now on your radar.`,
      blocks: [
        paragraph([{ strong: radarName }, ' is now on your radar.']),
        ...(note ? [paragraph([note], { dim: true })] : []),
        button(ctx.link, action),
      ],
    }),
  };
}

/**
 * An array share, as an email.
 *
 * `radarCount` is the honest headline. An array share that cascades hands over
 * real access to real radars and should say so; one that does not hands over a
 * grouping and should say *that*, rather than letting somebody assume they have
 * been given content they cannot actually open. The whole permission model of
 * topics is the difference between those two sentences, so the email draws it.
 */
export function topicSharedMessage(
  to: string,
  topicName: string,
  sharerName: string,
  ctx: ShareMailContext,
  radarCount: number,
): Message {
  const action = ctx.hasAccount ? 'Open the array' : 'Accept the invitation';
  const grants =
    radarCount > 0
      ? `It comes with ${radarCount} radar${radarCount === 1 ? '' : 's'}.`
      : 'Radars inside it are shared separately, so you will see the ones you have been given.';
  const note = joinNote(ctx);
  return {
    to,
    subject: `${sharerName} shared the "${topicName}" array with you`,
    text: `${sharerName} shared the "${topicName}" array with you on On My Radar. ${grants}${
      note ? ` ${note}` : ''
    }\n\n${ctx.link}`,
    html: layout({
      heading: `${sharerName} shared an array with you`,
      preheader: `${topicName} is now on your radar. ${grants}`,
      blocks: [
        paragraph([{ strong: topicName }, ' is now on your radar.']),
        paragraph([grants], { dim: true }),
        ...(note ? [paragraph([note], { dim: true })] : []),
        button(ctx.link, action),
      ],
    }),
  };
}

/**
 * One notification, as an email.
 *
 * Deliberately generic in shape — a rendered sentence, an optional excerpt and
 * one link — because the sentence is already assembled by the notification
 * service and there is exactly one phrasing of it (see `renderTitle`). Adding a
 * notification kind therefore needs nothing here at all.
 *
 * The excerpt is escaped and shown as a quotation rather than rendered as
 * markdown. A blip body is user content, and the argument in
 * docs/DESIGN.md §11 — escape first, introduce known-safe tags afterwards —
 * has no counterpart in an email client's HTML renderer, so the safe move is to
 * not introduce any tags at all.
 */
export function notificationMessage(
  to: string,
  headline: string,
  excerpt: string | null,
  href: string,
): Message {
  return {
    to,
    subject: headline,
    text: excerpt ? `${headline}\n\n${excerpt}\n\n${href}` : `${headline}\n\n${href}`,
    html: layout({
      heading: headline,
      preheader: excerpt ?? headline,
      blocks: [
        ...(excerpt ? [quote(excerpt)] : []),
        button(href, 'Open On My Radar', { last: false }),
        paragraph(['You can turn these off in Settings → Notifications.'], {
          dim: true,
          last: true,
        }),
      ],
    }),
  };
}

/**
 * Duplicate-safe twice over. The rendered message rides in the payload because
 * these mails are point-in-time notices with no fresher state to re-render
 * from, so every attempt sends an identical request — which is what makes the
 * job id a valid idempotency key. A re-run after Resend accepted the message
 * (the job's delete failing, or a lease overrun) is answered from Resend's
 * record instead of arriving twice.
 */
export async function deliverQueuedEmail(
  payload: Record<string, unknown>,
  job: Pick<OutboxJob, 'id'>,
): Promise<void> {
  const to = textValue(payload['to']);
  const subject = textValue(payload['subject']);
  if (!to || !subject) return;
  await sendMail(
    {
      to,
      subject,
      text: textValue(payload['text']),
      html: textValue(payload['html']),
    },
    { idempotencyKey: `outbox-email/${job.id}` },
  );
}

registerOutboxHandler('email', deliverQueuedEmail);

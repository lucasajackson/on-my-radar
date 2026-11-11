/**
 * `SMTP_URL`, parsed by us rather than handed to the mail library.
 *
 * The library would read query parameters we never meant to expose (and ignore
 * ones we did), and TLS is the one decision here that must not be left to a
 * default. So the rules are ours, and strict:
 *
 *   smtp://user:pass@host[:587]            STARTTLS is required. A server that
 *                                          does not offer it is refused, never
 *                                          spoken to in the clear.
 *   smtps://user:pass@host[:465]           TLS from the first byte.
 *   smtp://host:1025?tls=none              No TLS at all. The URL has to say so;
 *                                          meant for a local relay or a test
 *                                          mailbox on a trusted network.
 *
 * Errors name what is wrong, never the URL: it carries the password.
 */
export interface SmtpTarget {
  host: string;
  port: number;
  /** TLS from the first byte (`smtps:`). */
  secure: boolean;
  /** Upgrade with STARTTLS and refuse the server if it will not. */
  requireTLS: boolean;
  /** Never upgrade (`?tls=none`). */
  ignoreTLS: boolean;
  auth?: { user: string; pass: string };
}

export function parseSmtpUrl(raw: string): SmtpTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SMTP_URL is not a valid URL');
  }
  const secure = url.protocol === 'smtps:';
  if (!secure && url.protocol !== 'smtp:')
    throw new Error('SMTP_URL must start with smtp:// or smtps://');
  if (!url.hostname) throw new Error('SMTP_URL has no host');
  if (url.pathname !== '' && url.pathname !== '/') throw new Error('SMTP_URL takes no path');
  if (url.hash) throw new Error('SMTP_URL takes no fragment');

  let noTls = false;
  for (const [key, value] of url.searchParams) {
    if (key !== 'tls' || value !== 'none')
      throw new Error('SMTP_URL accepts only the query parameter tls=none');
    noTls = true;
  }
  if (noTls && secure) throw new Error('SMTP_URL: tls=none contradicts smtps://');

  const auth = url.username
    ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
    : undefined;
  return {
    // `[::1]` is how a URL spells an IPv6 host; the socket wants the bare address.
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: !secure && !noTls,
    ignoreTLS: noTls,
    ...(auth ? { auth } : {}),
  };
}

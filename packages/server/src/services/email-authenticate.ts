import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import PostalMime, { type Address } from 'postal-mime';

import { EmailVerificationError } from './email-failures.js';
import { resolveTxt } from 'node:dns/promises';

/** DNS is resolved inside a disposable, deadline-bound parser worker. */
export async function dnsResolver(name: string, type: string): Promise<string[][]> {
  if (type !== 'TXT' || name.length > 253 || !/^[a-z0-9_.-]+$/i.test(name))
    throw new Error('Invalid DKIM DNS lookup');
  return resolveTxt(name);
}
/**
 * The addresses named by the To and Cc header lines a DKIM signature actually
 * covered. `signingHeaders.headers` are the instances chosen by RFC 6376 §5.4.2,
 * bottom-up, one per `h=` entry, so an extra To header an attacker prepends above
 * the signed one is not among them. Anything the signature does not list in `h=`
 * contributes nothing.
 */
async function signedRecipients(signedLines: readonly string[] | undefined): Promise<Set<string>> {
  const lines = (signedLines ?? []).filter((line) => /^(?:to|cc)[ \t]*:/i.test(line));
  const addresses = new Set<string>();
  if (!lines.length) return addresses;
  const parsed = await PostalMime.parse(
    Buffer.from(lines.map((line) => line.replace(/(?:\r?\n)+$/, '')).join('\r\n') + '\r\n\r\n'),
  );
  const collect = (list: Address[]) => {
    for (const entry of list) {
      if (entry.group) collect(entry.group);
      else if (entry.address) addresses.add(entry.address.toLowerCase());
    }
  };
  collect(parsed.to ?? []);
  collect(parsed.cc ?? []);
  return addresses;
}

/** How old a signature's `t=` may be for a message that is not signed for the capture address. */
export const FRESH_SIGNATURE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** How far ahead of our clock a signature's `t=` may be and still count as fresh. */
export const FRESH_SIGNATURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether this signature, the one that passed and gave the aligned domain, was
 * made recently enough to stand in for a destination binding. Reads the `t=` and
 * `x=` of the signature itself (mailauth's `signTime` / `expiresAfter`), never an
 * unsigned header such as Date. No `t=` means freshness cannot be proved.
 */
export function isFreshSignature(result: object): boolean {
  // mailauth's typings omit `signTime` and `expiresAfter` (the signature's t= and x=).
  const signature = result as { signTime?: unknown; expiresAfter?: unknown };
  if (typeof signature.signTime !== 'string') return false;
  const signedAt = Date.parse(signature.signTime);
  if (!Number.isFinite(signedAt)) return false;
  const now = Date.now();
  if (signedAt > now + FRESH_SIGNATURE_CLOCK_SKEW_MS) return false;
  if (now - signedAt > FRESH_SIGNATURE_MAX_AGE_MS) return false;
  if (typeof signature.expiresAfter === 'string') {
    const expires = Date.parse(signature.expiresAfter);
    if (!Number.isFinite(expires) || expires < now) return false;
  }
  return true;
}

/**
 * `recipient` is the capture address the relay delivered this message to. A valid
 * signature proves the sender signed the message, not that they signed it for
 * *us*, so a message legitimately signed for someone else could be replayed into
 * any capture address by whoever holds a copy. A message is accepted when either
 *  (a) the capture address is in a To/Cc header the signature covered, or
 *  (b) the signature is fresh (`isFreshSignature`).
 * (b) keeps Bcc, mailing lists and server-side forwards working, and limits a
 * replay of someone else's signed message to a couple of hours after it was sent.
 */
export async function authenticate(raw: Uint8Array, recipient: string, resolver = dnsResolver) {
  let mail;
  try {
    mail = await PostalMime.parse(raw, { maxNestingDepth: 30, maxHeadersSize: 65536 });
  } catch {
    throw new EmailVerificationError('mime_invalid');
  }
  if (
    mail.headers.length > 1000 ||
    mail.headers.filter((header) => header.key === 'dkim-signature').length > 8
  )
    throw new EmailVerificationError('mime_limits');
  const protectedHeaders = [
    'from',
    'subject',
    'content-type',
    'content-transfer-encoding',
    'mime-version',
  ];
  if (
    protectedHeaders.some((key) => mail.headers.filter((header) => header.key === key).length > 1)
  )
    throw new EmailVerificationError('ambiguous_headers');
  const fromHeaders = mail.headers.filter((header) => header.key === 'from');
  const sender = mail.from?.address?.toLowerCase();
  if (fromHeaders.length !== 1 || !sender || !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(sender))
    throw new EmailVerificationError('sender_invalid');
  if (!mail.headers.some((header) => header.key === 'dkim-signature'))
    throw new EmailVerificationError('dkim_missing');
  const domain = sender.split('@')[1];
  const result = await dkimVerify(Buffer.from(raw), { resolver, minBitLength: 1024 });
  // Exact domain alignment deliberately rejects unsigned forwarding and
  // subdomain signatures. Never accept Authentication-Results supplied in mail.
  if (result.headerFrom?.length !== 1 || result.headerFrom[0]?.toLowerCase() !== sender)
    throw new EmailVerificationError('ambiguous_headers');
  const required = [
    'from',
    ...['subject', 'content-type', 'content-transfer-encoding', 'mime-version'].filter((key) =>
      mail.headers.some((header) => header.key === key),
    ),
  ];
  const wanted = recipient.trim().toLowerCase();
  const signedTo = new Map<unknown, Set<string>>();
  for (const signature of result.results) {
    if (signature.status.result === 'pass')
      signedTo.set(
        signature,
        // mailauth's typings omit `headers`: the exact lines it canonicalised.
        await signedRecipients(
          (signature.signingHeaders as { headers?: string[] } | undefined)?.headers,
        ),
      );
  }
  const valid = result.results.find(
    (signature) =>
      (signedTo.get(signature)?.has(wanted) === true || isFreshSignature(signature)) &&
      signature.status.result === 'pass' &&
      ['rsa-sha256', 'ed25519-sha256'].includes(signature.algo) &&
      signature.signingDomain?.toLowerCase() === domain &&
      signature.signatureTimeValid &&
      !signature.canonBodyLengthLimited &&
      required.every((key) =>
        signature.signingHeaders?.keys
          ?.toLowerCase()
          .split(':')
          .map((value) => value.trim())
          .includes(key),
      ),
  );
  if (!valid) {
    if (result.results.some((signature) => signature.status.result === 'temperror'))
      throw new EmailVerificationError('dkim_dns_unavailable');
    const passed = result.results.filter((signature) => signature.status.result === 'pass');
    if (!passed.length) throw new EmailVerificationError('dkim_invalid');
    const aligned = passed.filter((signature) => signature.signingDomain?.toLowerCase() === domain);
    if (!aligned.length) throw new EmailVerificationError('dkim_domain_mismatch');
    if (
      !aligned.some(
        (signature) =>
          ['rsa-sha256', 'ed25519-sha256'].includes(signature.algo) &&
          signature.signatureTimeValid &&
          !signature.canonBodyLengthLimited,
      )
    )
      throw new EmailVerificationError('dkim_signature_policy');
    // Everything else about the signature is acceptable: the only thing missing is
    // the destination, so say so rather than blaming the sender's headers.
    if (
      aligned.some(
        (signature) =>
          ['rsa-sha256', 'ed25519-sha256'].includes(signature.algo) &&
          signature.signatureTimeValid &&
          !signature.canonBodyLengthLimited &&
          required.every((key) =>
            signature.signingHeaders?.keys
              ?.toLowerCase()
              .split(':')
              .map((value) => value.trim())
              .includes(key),
          ),
      )
    )
      throw new EmailVerificationError('stale_signature_for_other_recipient');
    throw new EmailVerificationError('dkim_unsigned_headers');
  }
  return { sender, mail, signatureId: valid.id };
}

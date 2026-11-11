/** Bounded diagnostics only: no message content, addresses, or DNS/header values. */
export const EMAIL_FAILURE_MESSAGES = {
  mime_invalid: 'This email could not be read. Try sending it as a new message.',
  mime_limits:
    'This email has more than 12 attachments, or too many headers, parts or nested messages. Send the files across more than one email.',
  ambiguous_headers:
    'This email has conflicting sender or formatting headers. Forward it as a new message from your approved address.',
  sender_invalid: 'This email does not identify one sender. Send it from your approved address.',
  dkim_missing:
    'The sender’s email service did not sign this message. Ask its administrator to enable DKIM signing for the sender’s email domain.',
  dkim_invalid:
    'The sender could not be authenticated: the email signature was missing, invalid, or changed in transit. Try sending a new message from your approved address.',
  dkim_domain_mismatch:
    'The email signature does not match the sender’s domain. Ask its administrator to enable DKIM signing for the sender’s email domain.',
  dkim_unsigned_headers:
    'The sender’s email service did not fully verify this message. Ask its administrator to include sender and formatting headers in DKIM signatures.',
  dkim_signature_policy:
    'This message’s sender verification is expired, incomplete, or unsupported. Try sending a new message from your approved address.',
  stale_signature_for_other_recipient:
    'This message was signed too long ago, and not for your capture address. Send it to your capture address (To or Cc), or send it again so it is signed afresh.',
  dkim_dns_unavailable:
    'Sender verification is temporarily unavailable. The email service can retry this message.',
} as const;
export type EmailFailureReason = keyof typeof EMAIL_FAILURE_MESSAGES;
export function isEmailFailureReason(value: unknown): value is EmailFailureReason {
  return typeof value === 'string' && Object.hasOwn(EMAIL_FAILURE_MESSAGES, value);
}
export class EmailVerificationError extends Error {
  readonly temporary: boolean;
  constructor(readonly reason: EmailFailureReason) {
    super(EMAIL_FAILURE_MESSAGES[reason]);
    this.temporary = reason === 'dkim_dns_unavailable';
  }
}

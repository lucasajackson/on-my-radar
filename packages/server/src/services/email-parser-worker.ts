import { parentPort, workerData } from 'node:worker_threads';
import { authenticate } from './email-authenticate.js';
import { EmailVerificationError } from './email-failures.js';
import {
  emailHtmlText,
  isInlineEmailImage,
  normalizeContentId,
  sanitizeEmailHtml,
} from './email-html.js';
import { LIMITS } from '@onmyradar/contract';
import { storableEmailContentType } from './content-types.js';
import { EMAIL_LIMITS, withinInlineBudget } from './email-limits.js';
import type { EmailParserWorkerData } from './email-parser.js';

if (!parentPort) throw new Error('email-parser-worker runs only as a worker thread');
const port = parentPort;
// Spawned only by parseEmail, which builds this shape with `satisfies`;
// workerData is structured-cloned, so the cast is the boundary.
const input = workerData as EmailParserWorkerData;

/**
 * PostgreSQL text and jsonb cannot hold U+0000, and MIME delivers one on
 * request — a quoted-printable `=00` in the body or an encoded word in the
 * subject. Left in, the receipt insert failed with a 500, which the relay
 * reports as temporary, so the sender's server retried for days and the owner
 * was never told why nothing arrived.
 */
function withoutNul(value: string): string;
function withoutNul(value: string | null | undefined): string | null | undefined;
function withoutNul(value: string | null | undefined) {
  return value?.replaceAll('\0', '');
}

async function run() {
  try {
    const { sender, mail, signatureId } = await authenticate(
      input.raw,
      input.recipient,
      input.dnsRecords
        ? (name: string) => {
            const record = input.dnsRecords?.[name];
            return record
              ? Promise.resolve(record)
              : Promise.reject(new Error('Missing DNS fixture'));
          }
        : undefined,
    );
    if (mail.attachments.length > EMAIL_LIMITS.parts)
      throw new EmailVerificationError('mime_limits');
    const text = withoutNul(mail.text || (mail.html ? emailHtmlText(mail.html) : ''));
    const html = mail.html ? withoutNul(sanitizeEmailHtml(mail.html)) : null;
    const body = text.slice(0, LIMITS.blipBody) || '(Email attachment)';
    const original = input.raw;
    const parts = mail.attachments.map((file) => {
      const contentType = storableEmailContentType(file.mimeType);
      const contentId = file.contentId ? normalizeContentId(file.contentId) : null;
      return {
        filename: withoutNul(file.filename || 'attachment').slice(0, 255) || 'attachment',
        contentType,
        bytes: new Uint8Array(file.content as ArrayBuffer),
        contentId,
        inline:
          file.disposition !== 'attachment' && isInlineEmailImage(html, contentType, contentId),
      };
    });
    if (parts.filter((file) => !file.inline).length > EMAIL_LIMITS.attachments)
      throw new EmailVerificationError('mime_limits');
    const files = withinInlineBudget(parts);
    const date = mail.date ? new Date(mail.date) : null;
    port.postMessage(
      {
        sender,
        signatureId,
        body,
        files,
        original,
        text,
        html,
        subject: withoutNul(mail.subject)?.slice(0, 2000) || null,
        senderName: withoutNul(mail.from?.name)?.slice(0, 500) || null,
        sentAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
      },
      [original.buffer as ArrayBuffer, ...files.map((file) => file.bytes.buffer)],
    );
  } catch (error) {
    port.postMessage({
      error: true,
      reason: error instanceof EmailVerificationError ? error.reason : 'mime_invalid',
    });
  }
}
void run();

import { isEmailFailureReason } from './email-failures.js';
import { createHash } from 'node:crypto';
import { ApiError, badRequest } from '../http.js';
import { parseEmail } from './email-parser.js';
import {
  authorizeEmailDelivery,
  cleanupDeletedRadarEmailUploads,
  emailCaptureAvailable,
  finalizeEmailDelivery,
  recordEmailAuthenticationFailure,
} from './inbound-email.js';
import { putEmailAttachment, putEmailContent } from './storage.js';
import { must } from '../errors.js';
import type { ReadableStreamReadResult } from 'node:stream/web';

export const MAX_EMAIL_BYTES = 10 * 1024 * 1024;
const MAX_IN_FLIGHT = 2;
let inFlight = 0;

/** No waiting queue: SMTP retries provide backpressure before any MIME bytes are buffered. */
export async function ingestRawEmail(request: Request): Promise<{ captured: true }> {
  if (!emailCaptureAvailable())
    throw new ApiError(503, 'email_unavailable', 'Email capture is not available.');
  if (inFlight >= MAX_IN_FLIGHT)
    throw new ApiError(503, 'email_busy', 'Email processing is busy. Try again shortly.');
  const size = Number(request.headers.get('x-omr-raw-size'));
  if (size > MAX_EMAIL_BYTES)
    throw new ApiError(413, 'email_too_large', 'Email must be 10 MiB or smaller.');
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'message/rfc822')
    throw badRequest('Expected an email message.');
  const recipient = request.headers.get('x-omr-recipient');
  if (!recipient) throw badRequest('Expected an X-OMR-Recipient header.');
  inFlight++;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  let uploadedKeys: string[] = [];
  let receiptId: string | undefined;
  try {
    const raw = await readEmailBody(request, size, signal);
    let mail;
    try {
      mail = await parseEmail(raw, recipient, signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        const reason = error.code.slice(6);
        await recordEmailAuthenticationFailure(
          recipient,
          isEmailFailureReason(reason) ? reason : 'dkim_invalid',
        );
      }
      throw error;
    }
    signal.throwIfAborted();
    const id = createHash('sha256').update(`${recipient}\0${mail.signatureId}`).digest('hex');
    receiptId = id;
    const payload = (files: Array<{ key: string }>) =>
      Buffer.from(
        JSON.stringify({
          text: mail.text,
          html: mail.html,
          files: files.map((file, index) => ({
            key: file.key,
            contentId: must(mail.files[index], 'a parsed part for each stored file').contentId,
            inline: must(mail.files[index], 'a parsed part for each stored file').inline,
          })),
        }),
      );
    const receipt = await authorizeEmailDelivery({
      id,
      recipient,
      sender: mail.sender,
      body: mail.body,
      email: {
        subject: mail.subject,
        senderName: mail.senderName,
        sentAt: mail.sentAt,
        preview: mail.text.replace(/\s+/g, ' ').trim().slice(0, 220),
        hasHtml: Boolean(mail.html),
        attachmentCount: mail.files.filter((file) => !file.inline).length,
      },
      files: mail.files.map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        size: file.bytes.byteLength,
      })),
    });
    if (receipt.completed) return { captured: true };
    uploadedKeys = [
      ...receipt.files.map((file) => file.key),
      ...(receipt.email ? [receipt.email.payloadKey, receipt.email.originalKey] : []),
    ];
    if (receipt.email) {
      await putEmailContent(receipt.email.payloadKey, payload(receipt.files), false, signal);
      await putEmailContent(receipt.email.originalKey, mail.original, true, signal);
    }
    // Sequential bounded uploads. The persisted receipt owns cleanup after failures;
    // deleting keys here could race another retry that has already captured them.
    for (const [index, file] of mail.files.entries()) {
      signal.throwIfAborted();
      const stored = must(receipt.files[index], 'a stored file for each parsed part');
      await putEmailAttachment(stored.key, file.bytes, file.contentType, signal);
    }
    signal.throwIfAborted();
    await finalizeEmailDelivery(id, signal);
    return { captured: true };
  } catch (error) {
    if (signal.aborted)
      throw new ApiError(503, 'email_timeout', 'Email processing timed out. Please retry.');
    throw error;
  } finally {
    try {
      await cleanupDeletedRadarEmailUploads(uploadedKeys, receiptId);
    } finally {
      inFlight--;
    }
  }
}

/** One preallocated exact-size buffer; length is MAC-bound but still checked against actual bytes. */
export async function readEmailBody(
  request: Request,
  size: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_EMAIL_BYTES)
    throw badRequest('Invalid email size.');
  if (!request.body) throw badRequest('Empty email message.');
  const bytes = new Uint8Array(size);
  const reader = request.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let offset = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk: ReadableStreamReadResult<unknown> = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      const value = chunk.value;
      if (!(value instanceof Uint8Array)) throw badRequest('Email body chunk was not bytes.');
      if (offset + value.byteLength > size)
        throw badRequest('Email size does not match its declaration.');
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw badRequest('Email size does not match its declaration.');
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

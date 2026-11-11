import { createHmac, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { ingestRawEmail, MAX_EMAIL_BYTES, readEmailBody } from './email-ingest.js';
import { parseEmail } from './email-parser.js';
import { authorizeEmailDelivery, finalizeEmailDelivery } from './inbound-email.js';
import { putEmailAttachment, putEmailContent } from './storage.js';
import { rememberRelayNonce } from './relay-nonces.js';
import type * as InboundEmailModule from './inbound-email.js';
import type * as StorageModule from './storage.js';
import { ApiError } from '../http.js';
vi.mock('./email-parser.js', () => ({ parseEmail: vi.fn() }));
// The nonce store is Postgres (relay-nonces.test.ts covers it for real); this suite has no database.
const seenNonces = new Set<string>();
vi.mock('./relay-nonces.js', () => ({
  rememberRelayNonce: vi.fn(async (nonce: string) => {
    if (seenNonces.has(nonce)) return false;
    seenNonces.add(nonce);
    return true;
  }),
}));
vi.mock('./inbound-email.js', async (original) => ({
  ...(await original<typeof InboundEmailModule>()),
  emailCaptureAvailable: () => true,
  authorizeEmailDelivery: vi.fn(),
  finalizeEmailDelivery: vi.fn(),
  recordEmailAuthenticationFailure: vi.fn(),
  cleanupDeletedRadarEmailUploads: vi.fn(),
}));
vi.mock('./storage.js', async (original) => ({
  ...(await original<typeof StorageModule>()),
  putEmailAttachment: vi.fn(),
  putEmailContent: vi.fn(),
}));
const secret = 'relay-test-secret-for-local-tests-only';
function request(
  raw = 'From: alice@example.com\r\n\r\nhello',
  changes: Record<string, string> = {},
) {
  const timestamp = String(Date.now()),
    nonce = randomUUID(),
    recipient = 'reader@onmyradar.io',
    size = String(Buffer.byteLength(raw));
  return new Request('http://localhost/hooks/email-capture/raw', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'message/rfc822',
      'x-omr-timestamp': timestamp,
      'x-omr-nonce': nonce,
      'x-omr-recipient': recipient,
      'x-omr-raw-size': size,
      'x-omr-signature': createHmac('sha256', secret)
        .update(`${timestamp}\n${nonce}\n${recipient}\n${size}`)
        .digest('hex'),
      ...changes,
    },
  });
}
beforeEach(() => {
  seenNonces.clear();
  vi.resetAllMocks();
  vi.mocked(rememberRelayNonce).mockImplementation(async (nonce) => {
    if (seenNonces.has(nonce)) return false;
    seenNonces.add(nonce);
    return true;
  });
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgresql://unused/unused',
      SESSION_SECRET: secret,
      EMAIL_INGEST_SECRET: secret,
      EMAIL_CAPTURE_ENABLED: 'true',
    }),
  );
  vi.mocked(parseEmail).mockResolvedValue({
    sender: 'alice@example.com',
    signatureId: 'verified',
    body: 'hello',
    original: new Uint8Array([65]),
    subject: 'Subject',
    senderName: null,
    sentAt: null,
    text: 'hello',
    html: '<p>hello</p>',
    files: [
      {
        filename: 'proof.txt',
        contentType: 'text/plain',
        bytes: new Uint8Array([65]),
        contentId: null,
        inline: false,
      },
    ],
  });
  vi.mocked(authorizeEmailDelivery).mockResolvedValue({
    id: 'a'.repeat(64),
    completed: false,
    email: {
      subject: 'Subject',
      senderName: null,
      sentAt: null,
      preview: 'hello',
      hasHtml: true,
      attachmentCount: 1,
      payloadKey: 'radars/fixture/email-content.json',
      originalKey: 'radars/fixture/original.eml',
    },
    files: [
      {
        key: 'radars/fixture/proof.txt',
        filename: 'proof.txt',
        contentType: 'text/plain',
        size: 1,
      },
    ],
  });
  vi.mocked(finalizeEmailDelivery).mockResolvedValue({ captured: true });
});
describe('raw email ingress', () => {
  it('authenticates metadata before reading any bytes and binds recipient/size/nonce/time', async () => {
    const changes: Record<string, string>[] = [
      { 'x-omr-signature': '0'.repeat(64) },
      { 'x-omr-recipient': 'other@onmyradar.io' },
      { 'x-omr-raw-size': '100' },
      { 'x-omr-nonce': randomUUID() },
      { 'x-omr-timestamp': String(Date.now() - 600000) },
    ];
    for (const headers of changes) {
      const response = await createApp().fetch(request('hello', headers));
      expect(response.status).toBe(401);
      expect(response.headers.get('x-omr-email-result')).toBeNull();
    }
    let reads = 0;
    const forged = request('hello', { 'x-omr-signature': '0'.repeat(64) });
    const unread = new Request(forged, {
      body: new ReadableStream(
        {
          pull() {
            reads++;
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: 'half',
    });
    expect((await createApp().fetch(unread)).status).toBe(401);
    expect(reads).toBe(0);
    expect(parseEmail).not.toHaveBeenCalled();
  });
  it('refuses a replayed signed header set inside its window', async () => {
    const first = request();
    const replay = new Request(first.url, {
      method: 'POST',
      body: 'From: alice@example.com\r\n\r\nhello',
      headers: first.headers,
    });
    expect((await createApp().fetch(first)).status).toBe(200);
    const refused = await createApp().fetch(replay);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('x-omr-email-result')).toBeNull();
    expect(parseEmail).toHaveBeenCalledOnce();
  });
  it('accepts above the generic2MiB cap, persists files and marks the explicit application verdict', async () => {
    const response = await createApp().fetch(request('x'.repeat(3 * 1024 * 1024)));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-omr-email-result')).toBe('accepted');
    expect(putEmailAttachment).toHaveBeenCalledOnce();
    expect(putEmailContent).toHaveBeenCalledTimes(2);
    expect(finalizeEmailDelivery).toHaveBeenCalledOnce();
  });
  it('quota refusal cannot send an original, JSON, attachment or finalize a capture', async () => {
    vi.mocked(authorizeEmailDelivery).mockRejectedValue(
      new ApiError(409, 'quota_exceeded', 'Storage allowance full'),
    );
    const response = await createApp().fetch(request());
    expect(response.status).toBe(409);
    // SMTP retries this authenticated capacity refusal; it does not discard the message.
    expect(response.headers.get('x-omr-email-result')).toBeNull();
    expect(putEmailContent).not.toHaveBeenCalled();
    expect(putEmailAttachment).not.toHaveBeenCalled();
    expect(finalizeEmailDelivery).not.toHaveBeenCalled();
  });
  it('does not upload attachments again for a completed retry', async () => {
    vi.mocked(authorizeEmailDelivery).mockResolvedValue({
      id: 'a'.repeat(64),
      completed: true,
      email: null,
      files: [],
    });
    expect((await createApp().fetch(request())).status).toBe(200);
    expect(putEmailAttachment).not.toHaveBeenCalled();
  });
  it('marks permanent verification refusals but never storage failures', async () => {
    vi.mocked(parseEmail).mockRejectedValueOnce(
      new ApiError(403, 'email_authentication_failed', 'Rejected'),
    );
    const refused = await createApp().fetch(request());
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-omr-email-result')).toBe('rejected');
    vi.mocked(putEmailAttachment).mockRejectedValueOnce(
      new ApiError(503, 'storage_unavailable', 'Unavailable'),
    );
    const unavailable = await createApp().fetch(request());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('x-omr-email-result')).toBeNull();
    expect(finalizeEmailDelivery).not.toHaveBeenCalled();
  });
  it('rejects oversize input and mismatched actual length', async () => {
    const response = await createApp().fetch(request('x'.repeat(MAX_EMAIL_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(response.headers.get('x-omr-email-result')).toBe('rejected');
    await expect(
      readEmailBody(request('long'), 2, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readEmailBody(request('short'), 8, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('bounds concurrent ingests before body read and releases capacity after failure', async () => {
    let finish!: (value: Awaited<ReturnType<typeof parseEmail>>) => void;
    const held = new Promise<Awaited<ReturnType<typeof parseEmail>>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(parseEmail).mockReturnValue(held);
    const first = ingestRawEmail(request()),
      second = ingestRawEmail(request());
    await expect(ingestRawEmail(request())).rejects.toMatchObject({ status: 503 });
    finish({
      sender: 'alice@example.com',
      signatureId: 'same',
      body: 'body',
      files: [
        {
          filename: 'proof.txt',
          contentType: 'text/plain',
          bytes: new Uint8Array([65]),
          contentId: null,
          inline: false,
        },
      ],
      original: new Uint8Array([65]),
      subject: null,
      senderName: null,
      sentAt: null,
      text: 'body',
      html: null,
    });
    await Promise.all([first, second]);
    await expect(ingestRawEmail(request())).resolves.toEqual({ captured: true });
  });
  it('cancels a stalled body at its deadline', async () => {
    let cancelled = false;
    const raw = new Request('http://localhost/', {
      method: 'POST',
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    });
    await expect(readEmailBody(raw, 10, AbortSignal.timeout(10))).rejects.toBeDefined();
    expect(cancelled).toBe(true);
  });
});

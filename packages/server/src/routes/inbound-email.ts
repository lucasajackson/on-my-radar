import { logger } from '../logger.js';
import { isEmailFailureReason } from '../services/email-failures.js';
import { ingestRawEmail } from '../services/email-ingest.js';
import { rememberRelayNonce } from '../services/relay-nonces.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { Hono } from 'hono';
import {
  updateEmailCaptureIdentitySchema,
  updateRadarEmailCaptureSchema,
} from '@onmyradar/contract';
import { ApiError, readJson, requireActor, type AppEnv } from '../http.js';
import {
  claimEmailCaptureIdentity,
  getEmailCaptureIdentity,
  getRadarEmailCapture,
  updateRadarEmailCapture,
} from '../services/inbound-email.js';

export const emailCaptureRoutes = new Hono<AppEnv>();
emailCaptureRoutes.get('/email-capture', async (c) =>
  c.json(await getEmailCaptureIdentity(requireActor(c))),
);
emailCaptureRoutes.put('/email-capture', async (c) =>
  c.json(
    await claimEmailCaptureIdentity(
      requireActor(c),
      (await readJson(c, updateEmailCaptureIdentitySchema)).username,
    ),
  ),
);
emailCaptureRoutes.get('/radars/:id/email-capture', async (c) =>
  c.json(await getRadarEmailCapture(requireActor(c), c.req.param('id'))),
);
emailCaptureRoutes.put('/radars/:id/email-capture', async (c) =>
  c.json(
    await updateRadarEmailCapture(
      requireActor(c),
      c.req.param('id'),
      await readJson(c, updateRadarEmailCaptureSchema),
    ),
  ),
);

export const emailIngestRoutes = new Hono<AppEnv>();
emailIngestRoutes.post('/raw', async (c) => {
  try {
    await verifyEmailIngress(c.req.raw.headers);
    const result = await ingestRawEmail(c.req.raw);
    c.header('x-omr-email-result', 'accepted');
    return c.json(result);
  } catch (error) {
    if (error instanceof ApiError && isEmailFailureReason(error.code.slice(6)))
      logger.warn(
        { reason: error.code.slice(6), requestId: c.get('requestId') },
        'email verification refused',
      );
    // Only this authenticated application verdict is a permanent SMTP refusal.
    // Proxies/WAFs and deployment failures must never discard incoming mail.
    if (error instanceof ApiError && [400, 403, 413].includes(error.status))
      c.header('x-omr-email-result', 'rejected');
    throw error;
  }
});

// Reserve this namespace so obsolete metadata paths cannot fall through to generic webhooks.
emailIngestRoutes.all('*', (c) =>
  c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404),
);

const SIGNATURE_WINDOW_MS = 300_000;

/**
 * Replay protection lives in Postgres (`services/relay-nonces.ts`), so it holds across API replicas.
 */
export async function verifyEmailIngress(headers: Headers): Promise<void> {
  const secret = env().EMAIL_INGEST_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError(503, 'email_unavailable', 'Email capture is not configured.');
  const timestamp = headers.get('x-omr-timestamp') ?? '';
  const nonce = headers.get('x-omr-nonce') ?? '';
  const recipient = headers.get('x-omr-recipient') ?? '';
  const rawSize = headers.get('x-omr-raw-size') ?? '';
  const signature = headers.get('x-omr-signature') ?? '';
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > SIGNATURE_WINDOW_MS ||
    !/^[a-f0-9-]{36}$/.test(nonce) ||
    !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(recipient) ||
    recipient.length > 254 ||
    recipient !== recipient.toLowerCase() ||
    !/^[1-9]\d{0,8}$/.test(rawSize) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new ApiError(401, 'email_signature_invalid', 'Email receiver authentication failed.');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${recipient}\n${rawSize}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new ApiError(401, 'email_signature_invalid', 'Email receiver authentication failed.');
  // Recorded only after the signature verifies, so unsigned noise cannot fill it.
  if (!(await rememberRelayNonce(nonce, Number(timestamp), SIGNATURE_WINDOW_MS)))
    throw new ApiError(401, 'email_signature_replayed', 'Email receiver authentication failed.');
}

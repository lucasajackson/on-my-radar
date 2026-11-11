/**
 * Inbound webhook deliveries — the one route in this application that answers an
 * unauthenticated request with a write.
 *
 * It lives outside `/api` on purpose: `/hooks/<id>/<token>` is a URL a person
 * pastes into somebody else's product, so it should be short, stable and
 * obviously not part of the browser API surface.
 *
 * This file owns exactly one thing the service layer does not: turning an HTTP
 * request body into a payload. Content types, the size cap, and the mapping from
 * a status code to a service error all belong here; every authorization decision
 * belongs to `ingestWebhook`.
 */
import { Hono, type Context } from 'hono';
import { WEBHOOK } from '@onmyradar/contract';
import { readCappedBody } from '../body-limit.js';
import { badRequest, errorBody, type AppEnv } from '../http.js';
import { logger } from '../logger.js';
import { ingestWebhook, type InboundDelivery } from '../services/webhooks.js';

export const hookRoutes = new Hono<AppEnv>();

/**
 * Every sender shape reduced to one of three. A body that claims to be JSON but
 * is not gets treated as text rather than refused: a webhook that silently drops
 * deliveries because a header was wrong is worse than one that captures the raw
 * text and lets a human see what arrived.
 */
async function readDelivery(request: Request): Promise<InboundDelivery> {
  const originalContentType = request.headers.get('content-type') ?? '';
  const contentType = originalContentType.toLowerCase();
  const raw = new TextDecoder().decode(await readCappedBody(request, WEBHOOK.maxPayloadBytes));

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return { payload: JSON.parse(raw) as unknown, shape: 'json', raw };
    } catch {
      return { payload: null, shape: 'text', raw };
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of params) payload[key] = value;
    return { payload, shape: 'form', raw };
  }

  if (contentType.includes('multipart/form-data')) {
    // Files are ignored: an attachment has to be presigned into MinIO, which a
    // third-party sender has no way to do. The text fields still come through.
    // Deprecated for server use because it buffers the whole body; `raw` is
    // already capped at WEBHOOK.maxPayloadBytes by readCappedBody above.
    const form = await new Response(raw, { headers: { 'content-type': originalContentType } })
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- bounded input, see above
      .formData()
      .catch(() => null);
    if (!form) return { payload: null, shape: 'text', raw };
    const payload: Record<string, unknown> = {};
    for (const [key, value] of form) if (typeof value === 'string') payload[key] = value;
    return { payload, shape: 'form', raw };
  }

  // An unlabelled body is very often JSON anyway; try it before giving up.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { payload: JSON.parse(trimmed) as unknown, shape: 'json', raw };
    } catch {
      /* fall through to text */
    }
  }
  return { payload: null, shape: 'text', raw };
}

async function deliver(c: Context<AppEnv, '/:id/:token'>) {
  const webhookId = c.req.param('id');
  const token = c.req.param('token');
  if (!webhookId || !token) throw badRequest('Malformed webhook URL');

  const delivery = await readDelivery(c.req.raw);
  const result = await ingestWebhook(webhookId, token, delivery);

  logger.info({ webhookId, blipId: result.blipId }, 'webhook delivery accepted');
  // 202 rather than 201: the sender is not the owner of the thing created, and
  // most webhook senders only look for a 2xx.
  return c.json({ ok: true, blipId: result.blipId }, 202);
}

hookRoutes.post('/:id/:token', deliver);
// Some senders can only issue a PUT. The semantics are the same either way.
hookRoutes.put('/:id/:token', deliver);

/**
 * A GET is not a delivery, but senders (and people) will try one to see whether
 * the URL is live. Answer it without creating anything and without confirming
 * whether the token is right — the same 404 either way.
 */
hookRoutes.get('/:id/:token', (c) =>
  c.json({ ok: true, message: 'This webhook accepts POST. Nothing was captured.' }),
);

hookRoutes.onError((err, c) => {
  const { status, body } = errorBody(err);
  // The path carries the ingest token. It is not scrubbed here — `logger`
  // redacts every `path` it is handed, which is what stops the next log call
  // somebody adds from writing a live credential. See `scrubPath`.
  if (status >= 500)
    logger.error({ err, errorId: body.error.id, path: c.req.path }, 'webhook ingest failed');
  return c.json(body, status as 400);
});

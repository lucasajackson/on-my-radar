import { getReminder, setReminder } from '../services/reminders.js';
import { getEmailDetail, getOriginalEmailUrl } from '../services/email-reader.js';
/** Individual blips, cross-radar search, and attachment downloads. */
import { Hono } from 'hono';
import {
  answerDecisionSchema,
  createCommentSchema,
  decideAdrSchema,
  requestDecisionSchema,
  setReminderSchema,
  listBlipRevisionsSchema,
  listBlipsSchema,
  listCommentsSchema,
  toggleReactionSchema,
  claimBlipSchema,
  updateBlipSchema,
  releaseCommentSchema,
  updateCommentSchema,
  updateWebhookSchema,
} from '@onmyradar/contract';
import { blipUrl } from '../blip-url.js';
import { liveActor, readJson, readQuery, requireActor, type AppEnv } from '../http.js';
import { readableRadarIdsFor } from '../services/access.js';
import { decideAdr, trace } from '../services/architecture.js';
import { answerDecision, listDecisionRequests, requestDecision } from '../services/decisions.js';
import { deleteBlip, getBlip, listBlips, scopeOf, tagCounts } from '../services/blips.js';
import {
  createComment,
  deleteComment,
  listComments,
  releaseComment,
  updateComment,
} from '../services/comments.js';
import { resolveIdempotencyKey, withHeaderKey } from '../services/idempotency.js';
import { setReaction } from '../services/reactions.js';
import { getAttachmentUrl } from '../services/attachment-access.js';
import { readAttachmentImage } from '../services/attachment-image.js';
import { claimBlip, updateBlip } from '../services/blips.js';
import { listBlipRevisions } from '../services/blip-history.js';
import { deleteWebhook, rotateWebhookSecret, updateWebhook } from '../services/webhooks.js';

export const blipRoutes = new Hono<AppEnv>();

/** Search across everything the caller can read — the "where did I put that" box. */
blipRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  const query = readQuery(c, listBlipsSchema);
  const radarIds = await readableRadarIdsFor(actor);
  return c.json(
    await listBlips(radarIds, query, null, actor.user.id, null, {
      agentId: actor.agent?.agentId ?? null,
    }),
  );
});

blipRoutes.get('/tags', async (c) => {
  const actor = requireActor(c);
  const radarIds = await readableRadarIdsFor(actor);
  return c.json({ tags: await tagCounts(scopeOf(radarIds)) });
});

blipRoutes.get('/:id', async (c) => {
  const actor = requireActor(c);
  const blip = await getBlip(c.req.param('id'), actor);
  return c.json({ blip, url: blipUrl(blip) });
});

blipRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateBlipSchema);
  return c.json({ blip: await updateBlip(actor, c.req.param('id'), input) });
});

blipRoutes.post('/:id/claim', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, claimBlipSchema);
  return c.json({ blip: await claimBlip(actor, c.req.param('id'), input) });
});

blipRoutes.get('/:id/revisions', async (c) => {
  const actor = requireActor(c);
  const query = readQuery(c, listBlipRevisionsSchema);
  return c.json({ revisions: await listBlipRevisions(actor, c.req.param('id'), query) });
});

blipRoutes.get('/:id/trace', async (c) => c.json(await trace(requireActor(c), c.req.param('id'))));

blipRoutes.post('/:id/decide', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(c.req.header('idempotency-key'), await readJson(c, decideAdrSchema));
  return c.json(await decideAdr(actor, c.req.param('id'), input));
});

/*
 * Decision requests: asking is for anyone who may comment (the MCP `request_decision`); answering
 * is the addressee's own act, signed in, and has no MCP tool.
 */
blipRoutes.get('/:id/decisions', async (c) =>
  c.json({ requests: await listDecisionRequests(requireActor(c), c.req.param('id')) }),
);

blipRoutes.post('/:id/decisions', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, requestDecisionSchema);
  return c.json({ request: await requestDecision(actor, c.req.param('id'), input) }, 201);
});

blipRoutes.post('/:id/decisions/:requestId/answer', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, answerDecisionSchema);
  const request = await answerDecision(actor, c.req.param('id'), c.req.param('requestId'), input);
  return c.json({ request });
});

blipRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  await deleteBlip(actor, c.req.param('id'));
  return c.body(null, 204);
});

blipRoutes.get('/:id/reminder', async (c) =>
  c.json({ reminder: await getReminder(requireActor(c), c.req.param('id')) }),
);
blipRoutes.put('/:id/reminder', async (c) =>
  c.json({
    reminder: await setReminder(
      requireActor(c),
      c.req.param('id'),
      await readJson(c, setReminderSchema),
    ),
  }),
);
blipRoutes.delete('/:id/reminder', async (c) => {
  await setReminder(requireActor(c), c.req.param('id'), null);
  return c.body(null, 204);
});

/* -------------------------------- comments ------------------------------- */

/*
 * The thread on a blip. Reading it needs read access to the radar; writing needs
 * `requireParticipation`, which is a *third* capability between read and write —
 * a viewer may join the conversation without being able to edit the blip. That
 * distinction is decided once, in services/access.ts, and never here.
 */

blipRoutes.get('/:id/comments', async (c) => {
  const actor = liveActor(c);
  const query = readQuery(c, listCommentsSchema);
  return c.json(await listComments(actor, c.req.param('id'), query));
});

blipRoutes.post('/:id/comments', async (c) => {
  const actor = requireActor(c);
  const body = await readJson(c, createCommentSchema);
  const idempotencyKey = resolveIdempotencyKey(
    c.req.header('idempotency-key'),
    body.idempotencyKey,
  );
  const input = idempotencyKey === undefined ? body : { ...body, idempotencyKey };
  const comment = await createComment(actor, c.req.param('id'), input, {
    deferDelivery: actor.connection !== undefined,
    onReplay: () => c.header('Idempotency-Replayed', 'true'),
  });
  return c.json({ comment }, 201);
});

/**
 * One route for both forms. `{reaction}` alone is an atomic toggle — a button
 * that would otherwise have to read state before choosing a call. `{reaction,
 * on}` sets or clears the mark idempotently, which is what anything that might
 * retry must use: a retried toggle takes back the mark it just made.
 */
blipRoutes.post('/:id/reactions', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, toggleReactionSchema);
  return c.json(await setReaction(actor, c.req.param('id'), input.reaction, input.on));
});

/** Item-scoped, because a comment id is enough to find one and re-check its radar. */
export const commentRoutes = new Hono<AppEnv>();

commentRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateCommentSchema);
  return c.json({ comment: await updateComment(actor, c.req.param('id'), input) });
});

/*
 * Releasing a pending reply to a client. Human-only and owner-only in the
 * service (`releaseComment`), so a bearer token reaching this route is refused
 * there, not here — and there is deliberately no MCP tool for it.
 */
commentRoutes.post('/:id/release', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, releaseCommentSchema);
  return c.json({ comment: await releaseComment(actor, c.req.param('id'), input) });
});

commentRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  await deleteComment(actor, c.req.param('id'));
  return c.body(null, 204);
});

/* -------------------------------- webhooks ------------------------------- */

/**
 * Item-scoped webhook routes. They live here rather than under a radar because
 * a webhook id is enough to find one, and `ownWebhook` re-checks the radar.
 */
export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateWebhookSchema);
  return c.json({ webhook: await updateWebhook(actor, c.req.param('id'), input) });
});

webhookRoutes.post('/:id/rotate', async (c) => {
  const actor = requireActor(c);
  return c.json({ webhook: await rotateWebhookSecret(actor, c.req.param('id')) });
});

webhookRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  await deleteWebhook(actor, c.req.param('id'));
  return c.body(null, 204);
});

export const attachmentRoutes = new Hono<AppEnv>();

/**
 * Redirects to a short-lived signed URL rather than proxying the bytes. Access
 * is re-checked on every request, so revoking a share immediately stops working
 * links — the only window is the few minutes an already-issued signature lasts.
 */
attachmentRoutes.get('/:id', async (c) => {
  const actor = liveActor(c);
  const url = await getAttachmentUrl(actor, c.req.param('id'), c.req.query('download') === '1');
  return c.redirect(url, 302);
});

/** Same bounded service as MCP; normal originals still use the redirect above. */
attachmentRoutes.get('/:id/image', async (c) => {
  const image = await readAttachmentImage(requireActor(c), c.req.param('id'));
  return c.body(new Uint8Array(image.bytes), 200, {
    'Content-Type': image.mimeType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});

blipRoutes.get('/:id/email', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    email: await getEmailDetail(
      c.req.param('id'),
      requireActor(c),
      undefined,
      c.req.query('images') === '1',
    ),
  });
});
blipRoutes.get('/:id/email/original', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.redirect(await getOriginalEmailUrl(c.req.param('id'), requireActor(c)), 302);
});

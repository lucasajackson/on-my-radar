/** Radars, their membership, their blip streams, and upload tickets. */
import { Hono } from 'hono';
import {
  listRadarsQuerySchema,
  createBlipSchema,
  createRadarSchema,
  createSmartRadarSchema,
  createWebhookSchema,
  emailSchema,
  proposeAdrSchema,
  upsertBoundarySchema,
  writeCharterSchema,
  editCharterSchema,
  linkCharterSchema,
  listCharterVersionsQuerySchema,
  diffCharterQuerySchema,
  restoreCharterSchema,
  upsertContractSchema,
  readArchitectureQuerySchema,
  listBlipsSchema,
  radarNotifyLevelSchema,
  radarVisibilitySchema,
  setRadarTopicSchema,
  shareRadarSchema,
  updateRadarSchema,
  uploadTicketSchema,
} from '@onmyradar/contract';
import { blipUrl } from '../blip-url.js';
import { badRequest, readJson, readQuery, requireActor, type AppEnv } from '../http.js';
import { requireRadar } from '../services/access.js';
import {
  editCharter,
  proposeAdr,
  readArchitecture,
  retiredCharterPage,
  upsertBoundary,
  upsertContract,
  writeCharter,
} from '../services/architecture.js';
import { resolveIdempotencyKey, withHeaderKey } from '../services/idempotency.js';
import { linkCharter } from '../services/charter-links.js';
import { diffCharter, listCharterVersions, restoreCharter } from '../services/charter-versions.js';
import {
  createBlip,
  radarStream,
  resolveRadarScope,
  stateCounts,
  statusCounts,
  tagCounts,
} from '../services/blips.js';
import {
  createRadar,
  createSmartRadar,
  deleteRadar,
  getDropBox,
  getRadarDto,
  listMembers,
  listRadars,
  removeMember,
  revokeInvite,
  rotatePublicSlug,
  setVisibility,
  shareRadar,
  updateRadar,
} from '../services/radars.js';
import { radarAgents } from '../services/mentions.js';
import { setRadarLevel } from '../services/notifications.js';
import { setRadarTopic } from '../services/topics.js';
import { createWebhook, listWebhooks } from '../services/webhooks.js';
import { requestAttachmentUpload } from '../services/attachment-access.js';

export const radarRoutes = new Hono<AppEnv>();

radarRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  const { archived: includeArchived, template } = readQuery(c, listRadarsQuerySchema);
  return c.json({
    radars: await listRadars(actor, { includeArchived, ...(template ? { template } : {}) }),
  });
});

radarRoutes.post('/', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, createRadarSchema);
  return c.json({ radar: await createRadar(actor, input) }, 201);
});

/**
 * A smart radar: a saved tag query rather than a container. Its own endpoint
 * because the filter is mandatory, which `createRadarSchema` cannot express.
 */
radarRoutes.post('/smart', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, createSmartRadarSchema);
  return c.json({ radar: await createSmartRadar(actor, input) }, 201);
});

/**
 * The account's drop box, created on first use. Deliberately a GET that may
 * write: the caller is asking for a thing that must exist, and making the SPA
 * POST first would just move the same decision one round trip earlier.
 */
radarRoutes.get('/drop-box', async (c) => {
  const actor = requireActor(c);
  return c.json({ radar: await getDropBox(actor) });
});

radarRoutes.get('/:id', async (c) => {
  const actor = requireActor(c);
  const access = await requireRadar(c.req.param('id'), actor, 'read');
  return c.json({ radar: await getRadarDto(access, actor) });
});

radarRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateRadarSchema);
  return c.json({ radar: await updateRadar(actor, c.req.param('id'), input) });
});

radarRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  await deleteRadar(actor, c.req.param('id'));
  return c.body(null, 204);
});

radarRoutes.put('/:id/visibility', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, radarVisibilitySchema);
  const radar = await setVisibility(
    actor,
    c.req.param('id'),
    input.visibility,
    input.allowIndex ?? false,
  );
  return c.json({ radar });
});

radarRoutes.post('/:id/rotate-link', async (c) => {
  const actor = requireActor(c);
  return c.json({ radar: await rotatePublicSlug(actor, c.req.param('id')) });
});

/* ------------------------------- membership ------------------------------ */

radarRoutes.get('/:id/members', async (c) => {
  const actor = requireActor(c);
  const access = await requireRadar(c.req.param('id'), actor, 'read');
  // Two lists, not one. People hold grants and can be shared with; agents are a
  // computed overlay on their owners' grants and can be addressed but never
  // shared with, so putting them in `members` would offer the share dialog a row
  // none of its controls can act on.
  return c.json({ members: await listMembers(access), agents: await radarAgents(access.radar) });
});

/**
 * Telling the recipient — the email and the in-app notification — happens inside
 * `shareRadar` rather than here. It used to live in this route, which meant the
 * MCP tool shared radars silently; one service layer, two transports.
 */
radarRoutes.post('/:id/members', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, shareRadarSchema);
  const result = await shareRadar(actor, c.req.param('id'), input.email, input.role);
  return c.json({ share: result }, 201);
});

radarRoutes.delete('/:id/members/:userId', async (c) => {
  const actor = requireActor(c);
  await removeMember(actor, c.req.param('id'), c.req.param('userId'));
  return c.body(null, 204);
});

radarRoutes.delete('/:id/invites', async (c) => {
  const actor = requireActor(c);
  const parsed = emailSchema.safeParse(c.req.query('email'));
  if (!parsed.success) throw badRequest('An email address is required');
  await revokeInvite(actor, c.req.param('id'), parsed.data);
  return c.body(null, 204);
});

/* ----------------------------- notifications ----------------------------- */

/**
 * How loud this radar is *for the caller*.
 *
 * Only `read` access is required, and deliberately so: this is a statement
 * about your own attention, not about the radar. An editor muting a radar
 * changes nothing for anybody else — which is the whole reason the level is a
 * per-person row rather than a column on `radars` beside `commentsEnabled`.
 */
radarRoutes.put('/:id/notify-level', async (c) => {
  const actor = requireActor(c);
  const access = await requireRadar(c.req.param('id'), actor, 'read');
  const input = await readJson(c, radarNotifyLevelSchema);
  await setRadarLevel(actor, access.radar.id, input.level);
  return c.json({ radarId: access.radar.id, level: input.level });
});

/**
 * Move a radar into a topic, or out of every topic with `topicId: null`.
 *
 * On the radar rather than the topic because the radar is the thing being
 * changed — and because the two directions need different rights: adding needs
 * `manage` on the radar *and* the topic, while withdrawing needs it on only one
 * of the two. `setRadarTopic` is the one place that knows that, along with the
 * drop-box and smart-radar refusals.
 */
radarRoutes.put('/:id/topic', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, setRadarTopicSchema);
  return c.json(await setRadarTopic(actor, c.req.param('id'), input.topicId));
});

/* ---------------------------------- blips -------------------------------- */

radarRoutes.get('/:id/blips', async (c) => {
  const actor = requireActor(c);
  const access = await requireRadar(c.req.param('id'), actor, 'read');
  const query = readQuery(c, listBlipsSchema);
  // `radarStream` is the one entry point that knows how to resolve a smart
  // radar; a route must never assemble the scope itself.
  return c.json(await radarStream(access, actor, query));
});

radarRoutes.post('/:id/blips', async (c) => {
  const actor = requireActor(c);
  const body = await readJson(c, createBlipSchema);
  const idempotencyKey = resolveIdempotencyKey(
    c.req.header('idempotency-key'),
    body.idempotencyKey,
  );
  const input = idempotencyKey === undefined ? body : { ...body, idempotencyKey };
  const blip = await createBlip(actor, c.req.param('id'), input, {
    // An agent's write returns once the blip is committed; the worker does the fan-out.
    deferDelivery: actor.connection !== undefined,
    onReplay: () => c.header('Idempotency-Replayed', 'true'),
  });
  return c.json({ blip, url: blipUrl(blip) }, 201);
});

/** The charter and the ADR index in one read; the paged stream truncates a ledger. */
radarRoutes.get('/:id/architecture', async (c) => {
  const actor = requireActor(c);
  const query = readQuery(c, readArchitectureQuerySchema);
  return c.json(await readArchitecture(actor, c.req.param('id'), query));
});

radarRoutes.post('/:id/adrs', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(c.req.header('idempotency-key'), await readJson(c, proposeAdrSchema));
  return c.json(await proposeAdr(actor, c.req.param('id'), input), 201);
});

/** Replace the whole charter. Anchors never refuse it; the response lists what it orphaned. */
radarRoutes.put('/:id/charter', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, writeCharterSchema),
  );
  return c.json(await writeCharter(actor, c.req.param('id'), input));
});

/** Exact-text edits to the charter: all or none, each `find` once. 409 `charter_conflict` otherwise. */
radarRoutes.post('/:id/charter/edits', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, editCharterSchema),
  );
  return c.json(await editCharter(actor, c.req.param('id'), input));
});

/** Tie a passage of the charter to a boundary or contract (an existing one, or a new one made with it). */
radarRoutes.post('/:id/charter/links', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, linkCharterSchema),
  );
  const result = await linkCharter(actor, c.req.param('id'), input);
  return c.json(result, result.element.created ? 201 : 200);
});

radarRoutes.get('/:id/charter/versions', async (c) => {
  const actor = requireActor(c);
  const query = readQuery(c, listCharterVersionsQuerySchema);
  return c.json(await listCharterVersions(actor, c.req.param('id'), query));
});

radarRoutes.get('/:id/charter/diff', async (c) => {
  const actor = requireActor(c);
  const query = readQuery(c, diffCharterQuerySchema);
  return c.json(await diffCharter(actor, c.req.param('id'), query));
});

/** Put an earlier version back as a new one. History is never rewritten. */
radarRoutes.post('/:id/charter/versions/:version/restore', async (c) => {
  const actor = requireActor(c);
  const version = Number(c.req.param('version'));
  if (!Number.isInteger(version) || version < 1) throw badRequest('A version is a whole number.');
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, restoreCharterSchema),
  );
  return c.json(await restoreCharter(actor, c.req.param('id'), version, input));
});

/** Retired: the charter is one document. 410 `charter_is_one_document`. */
radarRoutes.post('/:id/charter-pages', async (c) => {
  const actor = requireActor(c);
  await retiredCharterPage(actor, c.req.param('id'));
});

radarRoutes.post('/:id/boundaries', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, upsertBoundarySchema),
  );
  const result = await upsertBoundary(actor, c.req.param('id'), input);
  return c.json(result, result.created ? 201 : 200);
});

radarRoutes.post('/:id/contracts', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, upsertContractSchema),
  );
  const result = await upsertContract(actor, c.req.param('id'), input);
  return c.json(result, result.created ? 201 : 200);
});

/**
 * Tag, state and lane counts for the filter bar, in one round trip.
 *
 * `statuses` is what each lane holds now; `archivedStatuses` is what has aged
 * out of it. Both, because the lane header says `12 · 34 archived` and a header
 * that could only say the first number would be the silent version of a feature
 * whose whole point is not being silent.
 */
radarRoutes.get('/:id/facets', async (c) => {
  const actor = requireActor(c);
  const access = await requireRadar(c.req.param('id'), actor, 'read');
  const scope = await resolveRadarScope(access, actor);
  const [tags, states, lanes] = await Promise.all([
    tagCounts(scope),
    stateCounts(scope),
    statusCounts(scope),
  ]);
  return c.json({ tags, states, statuses: lanes.live, archivedStatuses: lanes.archived });
});

/* -------------------------------- webhooks ------------------------------- */

radarRoutes.get('/:id/webhooks', async (c) => {
  const actor = requireActor(c);
  return c.json({ webhooks: await listWebhooks(actor, c.req.param('id')) });
});

/** The only response that ever contains the ingest URL with its token in it. */
radarRoutes.post('/:id/webhooks', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, createWebhookSchema);
  return c.json({ webhook: await createWebhook(actor, c.req.param('id'), input) }, 201);
});

/* --------------------------------- uploads ------------------------------- */

radarRoutes.post('/:id/uploads', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, uploadTicketSchema);
  const ticket = await requestAttachmentUpload(actor, c.req.param('id'), input);
  return c.json({ ticket });
});

/*
 * `GET /:id/lookup?email=` used to live here — "used by the share dialog to say
 * this person already has an account". It was an **account-existence oracle**
 * and it is gone.
 *
 * `manage` on a radar was the only gate, and anybody can create a radar for the
 * purpose, so any signed-in account could ask whether any address in the world
 * was registered, and get their display name with it, unrate-limited. That is
 * exactly the fact `POST /api/auth/request-code` is written to withhold — it
 * answers identically whether or not the address has an account, on purpose —
 * handed over by another door, with a name attached.
 *
 * Removed rather than rate-limited or narrowed, for two reasons. Nothing calls
 * it: not the SPA, not an MCP tool, not the contract package, and nothing has
 * since it was written. And the question it answered is already answered where
 * it matters — `shareRadar` returns `status: 'invited' | 'added' | 'updated'`,
 * so the share dialog learns whether the person had an account at the moment it
 * shares with them. The difference is that sharing writes an audit record and
 * tells the recipient. Probing did neither, which is the whole of what made it
 * an oracle rather than a feature.
 */

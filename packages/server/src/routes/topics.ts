/**
 * Topics: the container, its membership, and the cascade switch.
 *
 * Thin wrappers over `services/topics.ts`, exactly like every other route file —
 * no authorization is decided here. The one thing worth noticing is that
 * `PUT /:id/cascade` is a route of its own rather than a field on the patch
 * below it. Flipping that boolean is the widest single access change in the
 * application: it converts every existing topic membership into access to every
 * radar in the topic, including radars added later. It gets its own endpoint,
 * its own audit action and its own confirmation on screen, rather than riding
 * along in a request that also changed the colour.
 */
import { Hono } from 'hono';
import {
  archivedQuerySchema,
  createTopicSchema,
  emailSchema,
  setTopicCascadeSchema,
  shareTopicSchema,
  updateTopicSchema,
} from '@onmyradar/contract';
import { badRequest, readJson, readQuery, requireActor, type AppEnv } from '../http.js';
import { readableRadarIdsFor, requireTopic } from '../services/access.js';
import { listRadars } from '../services/radars.js';
import {
  createTopic,
  deleteTopic,
  getTopicDto,
  listTopicMembers,
  listTopics,
  removeTopicMember,
  revokeTopicInvite,
  setCascade,
  shareTopic,
  topicRadarIdsFor,
  updateTopic,
} from '../services/topics.js';

export const topicRoutes = new Hono<AppEnv>();

topicRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  const { archived: includeArchived } = readQuery(c, archivedQuerySchema);
  return c.json({ topics: await listTopics(actor, { includeArchived }) });
});

topicRoutes.post('/', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, createTopicSchema);
  return c.json({ topic: await createTopic(actor, input) }, 201);
});

/**
 * A topic and the radars in it **the caller can read**.
 *
 * Never the radars they cannot: a topic grant conveys the grouping, not its
 * contents, and listing the names of radars somebody has not been given would
 * leak them. A radar's name is content. Same reasoning as the 404-not-403 rule.
 */
topicRoutes.get('/:id', async (c) => {
  const actor = requireActor(c);
  const access = await requireTopic(c.req.param('id'), actor, 'read');
  const readable = new Set(await readableRadarIdsFor(actor));
  const visible = new Set(await topicRadarIdsFor(access.topic.id, readable));
  const radars = (await listRadars(actor)).filter((r) => visible.has(r.id));
  return c.json({ topic: await getTopicDto(access, actor), radars });
});

topicRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateTopicSchema);
  return c.json({ topic: await updateTopic(actor, c.req.param('id'), input) });
});

topicRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  const result = await deleteTopic(actor, c.req.param('id'));
  return c.json(result);
});

/** Its own endpoint, for the reason at the top of this file. */
topicRoutes.put('/:id/cascade', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, setTopicCascadeSchema);
  return c.json({ topic: await setCascade(actor, c.req.param('id'), input.cascade) });
});

/* ------------------------------- membership ------------------------------ */

topicRoutes.get('/:id/members', async (c) => {
  const actor = requireActor(c);
  const access = await requireTopic(c.req.param('id'), actor, 'read');
  return c.json({ members: await listTopicMembers(access) });
});

topicRoutes.post('/:id/members', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, shareTopicSchema);
  // The email and the in-app notification are raised inside `shareTopic`, not
  // here — otherwise sharing over MCP would be silent, which is the bug
  // `shareRadar` already had once.
  const result = await shareTopic(actor, c.req.param('id'), input.email, input.role);
  return c.json(result, result.status === 'updated' ? 200 : 201);
});

topicRoutes.delete('/:id/members/:userId', async (c) => {
  const actor = requireActor(c);
  await removeTopicMember(actor, c.req.param('id'), c.req.param('userId'));
  return c.body(null, 204);
});

topicRoutes.delete('/:id/invites', async (c) => {
  const actor = requireActor(c);
  const parsed = emailSchema.safeParse(c.req.query('email'));
  if (!parsed.success) throw badRequest('An email address is required');
  await revokeTopicInvite(actor, c.req.param('id'), parsed.data);
  return c.body(null, 204);
});

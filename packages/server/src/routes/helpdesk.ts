/**
 * The client portal's REST surface, `/api/v1/helpdesk` (`docs/HELPDESK.md` §5).
 *
 * Thin: every rule is in `services/helpdesk.ts` and `requireHelpdeskRadar`.
 * Mounted under `/api/v1` only, and the only routes an `omr_int_` credential
 * resolves on (`auth/middleware.ts`). Not on MCP: its one caller class is
 * refused there, so this is the one deliberate single-transport surface.
 *
 * Uploads and attachments (`/radars/:id/uploads`) are slice 7 and are not
 * registered: an unknown path is a 404.
 */
import { Hono } from 'hono';
import {
  createHelpdeskReplySchema,
  createHelpdeskRequestSchema,
  helpdeskEventsQuerySchema,
  helpdeskThreadQuerySchema,
  listHelpdeskRequestsSchema,
  REQUESTER_SCOPE_HEADER,
} from '@onmyradar/contract';
import { readJson, readQuery, requireIntegration, type AppEnv, type Ctx } from '../http.js';
import {
  consumeIntegrationCall,
  createHelpdeskReply,
  createHelpdeskRequest,
  getHelpdeskRequest,
  listHelpdeskRadars,
  listHelpdeskRequests,
  requesterScope,
  validIdempotencyKey,
} from '../services/helpdesk.js';
import { listHelpdeskEvents } from '../services/integration-events.js';

export const helpdeskRoutes = new Hono<AppEnv>();

/**
 * Every call: the credential, then the per-integration window. A refused
 * credential is a 401 before anything is counted.
 */
async function portal(c: Ctx) {
  const actor = requireIntegration(c);
  await consumeIntegrationCall(actor.integrationId);
  return actor;
}

helpdeskRoutes.get('/radars', async (c) => c.json(await listHelpdeskRadars(await portal(c))));

helpdeskRoutes.get('/radars/:radarId/requests', async (c) => {
  const actor = await portal(c);
  const scope = requesterScope(c.req.header(REQUESTER_SCOPE_HEADER));
  return c.json(
    await listHelpdeskRequests(
      actor,
      c.req.param('radarId'),
      scope,
      readQuery(c, listHelpdeskRequestsSchema),
    ),
  );
});

helpdeskRoutes.post('/radars/:radarId/requests', async (c) => {
  const actor = await portal(c);
  const scope = requesterScope(c.req.header(REQUESTER_SCOPE_HEADER));
  const key = validIdempotencyKey(c.req.header('idempotency-key'));
  const input = await readJson(c, createHelpdeskRequestSchema);
  return c.json(
    { request: await createHelpdeskRequest(actor, c.req.param('radarId'), scope, input, key) },
    201,
  );
});

helpdeskRoutes.get('/requests/:id', async (c) => {
  const actor = await portal(c);
  const scope = requesterScope(c.req.header(REQUESTER_SCOPE_HEADER));
  const { cursor } = readQuery(c, helpdeskThreadQuerySchema);
  return c.json(await getHelpdeskRequest(actor, c.req.param('id'), scope, cursor));
});

helpdeskRoutes.post('/requests/:id/replies', async (c) => {
  const actor = await portal(c);
  const scope = requesterScope(c.req.header(REQUESTER_SCOPE_HEADER));
  const key = validIdempotencyKey(c.req.header('idempotency-key'));
  const input = await readJson(c, createHelpdeskReplySchema);
  return c.json(
    { item: await createHelpdeskReply(actor, c.req.param('id'), scope, input, key) },
    201,
  );
});

/**
 * The reconcile feed (§5.4): ids only, ascending by `(xid, seq)`, below the
 * snapshot watermark. No requester scope: an id discloses nothing.
 */
helpdeskRoutes.get('/events', async (c) =>
  c.json(await listHelpdeskEvents(await portal(c), readQuery(c, helpdeskEventsQuerySchema))),
);

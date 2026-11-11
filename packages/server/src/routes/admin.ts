/** The waitlist queue and account administration. */
import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  adminUserActionSchema,
  idSchema,
  adminInventoryQuerySchema,
  modelCatalogEntrySchema,
  updateModelCatalogEntrySchema,
  type AdminUserDto,
} from '@onmyradar/contract';
import { activateUser, ensureDefaultWorkspace, findUserById } from '../auth/accounts.js';
import { revokeAllSessions } from '../auth/session.js';
import { getDb, schema } from '../db/client.js';
import {
  badRequest,
  conflict,
  notFound,
  readJson,
  readQuery,
  requireAdmin,
  type AppEnv,
} from '../http.js';
import { recordAudit } from '../services/audit.js';
import {
  adminListAgents,
  adminListTokens,
  adminRevokeAgent,
  adminRevokeGrant,
  adminRevokePat,
} from '../services/admin-agents.js';
import {
  adminOverview,
  createModel,
  deleteModel,
  listAllModels,
  updateModel,
} from '../services/model-catalog.js';

export const adminRoutes = new Hono<AppEnv>();

/** A path id that is not a uuid names nothing: a 404, not a database error. */
const uuid = (value: string, message: string): string => {
  if (!idSchema.safeParse(value).success) throw notFound(message);
  return value;
};

adminRoutes.get('/users', async (c) => {
  requireAdmin(c);
  const { state } = readQuery(
    c,
    z.object({ state: z.enum(['pending', 'active', 'suspended']).optional() }),
  );

  const rows = await getDb()
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      state: schema.users.state,
      isAdmin: schema.users.isAdmin,
      createdAt: schema.users.createdAt,
      lastSeenAt: schema.users.lastSeenAt,
      radarCount: sql<number>`(SELECT count(*)::int FROM radars WHERE radars.owner_id = ${schema.users.id})`,
      blipCount: sql<number>`(SELECT count(*)::int FROM blips WHERE blips.author_id = ${schema.users.id})`,
      waitlist: schema.waitlistRequests,
    })
    .from(schema.users)
    .leftJoin(schema.waitlistRequests, eq(schema.waitlistRequests.userId, schema.users.id))
    .where(state ? eq(schema.users.state, state) : undefined)
    .orderBy(desc(schema.users.createdAt))
    .limit(500);

  const users: AdminUserDto[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    state: row.state,
    isAdmin: row.isAdmin,
    radarCount: row.radarCount,
    blipCount: row.blipCount,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    // What the waitlist form said, for the person deciding whether to let them
    // in. Unverified, and labelled so in the contract.
    waitlist: row.waitlist
      ? {
          name: row.waitlist.name,
          useCase: row.waitlist.useCase,
          source: row.waitlist.source,
          requestedAt: row.waitlist.requestedAt.toISOString(),
        }
      : null,
  }));

  const [counts] = await getDb()
    .select({
      pending: sql<number>`count(*) FILTER (WHERE state = 'pending')::int`,
      active: sql<number>`count(*) FILTER (WHERE state = 'active')::int`,
      suspended: sql<number>`count(*) FILTER (WHERE state = 'suspended')::int`,
    })
    .from(schema.users);

  return c.json({ users, counts: counts ?? { pending: 0, active: 0, suspended: 0 } });
});

adminRoutes.post('/users/:id', async (c) => {
  const admin = requireAdmin(c);
  const input = await readJson(c, adminUserActionSchema);
  const target = await findUserById(c.req.param('id'));
  if (!target) throw notFound('User not found');

  if (target.id === admin.user.id && input.action === 'suspend') {
    throw badRequest('You cannot suspend your own account');
  }

  /*
   * Each action is a transition from a named state, and a request that finds
   * the account somewhere else is a 409 rather than a quiet state change.
   * Before, `approve` on a suspended account fell through and reinstated it,
   * and `reinstate` on a waitlisted one activated it without `activateUser` —
   * no welcome email, and audited as a reinstatement it was not.
   *
   * Approving goes through `activateUser`, the one approval path — the same one
   * an admin's share takes when it finds the person already on the waitlist.
   * Reinstating a suspended account is a different decision and stays here: it
   * is not an approval, and it must not send "you are in" to somebody who has
   * been in for months.
   */
  if (input.action === 'approve') {
    if (target.state !== 'pending') {
      throw conflict(`Only a waitlisted account can be approved; this one is ${target.state}.`);
    }
    if (!(await activateUser(admin, target, 'admin'))) {
      throw conflict('That account changed state while you were looking at it. Refresh.');
    }
    return c.json({ user: { id: target.id, email: target.email, state: 'active' } });
  }

  const from: Array<'pending' | 'active' | 'suspended'> =
    input.action === 'suspend' ? ['pending', 'active'] : ['suspended'];
  const nextState = input.action === 'suspend' ? 'suspended' : 'active';

  // The expected state is in the WHERE, so an approve and a suspend landing
  // together cannot overwrite each other: whichever arrives second finds the
  // row moved and says so.
  const [updated] = await getDb()
    .update(schema.users)
    .set({ state: nextState, updatedAt: new Date() })
    .where(and(eq(schema.users.id, target.id), inArray(schema.users.state, from)))
    .returning();
  if (!updated) {
    throw conflict(
      input.action === 'suspend'
        ? 'That account is already suspended.'
        : `Only a suspended account can be reinstated; this one is ${target.state}.`,
    );
  }

  if (nextState === 'suspended') {
    // Suspension has to take effect now, not whenever their cookie expires.
    await revokeAllSessions(updated.id);
  } else {
    await ensureDefaultWorkspace(updated);
  }

  await recordAudit(admin, `user.${input.action}`, 'user', updated.id, { email: updated.email });
  return c.json({ user: { id: updated.id, email: updated.email, state: updated.state } });
});

/* ------------------------------- the dashboard ----------------------------- */

/*
  Agents and the credentials behind them: metadata, and revoke. `requireAdmin` is a signed-in
  admin in a browser, never a token, so an agent cannot list its siblings or revoke anything.
*/
adminRoutes.get('/agents', async (c) =>
  c.json(await adminListAgents(requireAdmin(c), readQuery(c, adminInventoryQuerySchema))),
);

adminRoutes.get('/tokens', async (c) =>
  c.json(await adminListTokens(requireAdmin(c), readQuery(c, adminInventoryQuerySchema))),
);

adminRoutes.post('/agents/:id/revoke', async (c) => {
  await adminRevokeAgent(requireAdmin(c), uuid(c.req.param('id'), 'Agent not found'));
  return c.body(null, 204);
});

adminRoutes.post('/tokens/pat/:id/revoke', async (c) => {
  await adminRevokePat(requireAdmin(c), uuid(c.req.param('id'), 'Token not found'));
  return c.body(null, 204);
});

adminRoutes.post('/tokens/oauth/:userId/:clientId/revoke', async (c) => {
  const admin = requireAdmin(c);
  const userId = uuid(c.req.param('userId'), 'No connected app with that id');
  await adminRevokeGrant(admin, userId, c.req.param('clientId'));
  return c.body(null, 204);
});

adminRoutes.get('/overview', async (c) => {
  requireAdmin(c);
  return c.json(await adminOverview());
});

/* ------------------------------ model catalog ------------------------------ */

adminRoutes.get('/models', async (c) => {
  requireAdmin(c);
  return c.json({ models: await listAllModels() });
});

adminRoutes.post('/models', async (c) => {
  const admin = requireAdmin(c);
  const input = await readJson(c, modelCatalogEntrySchema);
  return c.json({ model: await createModel(admin, input) }, 201);
});

adminRoutes.patch('/models/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = readParamUuid(c.req.param('id'));
  const input = await readJson(c, updateModelCatalogEntrySchema);
  return c.json({ model: await updateModel(admin, id, input) });
});

adminRoutes.delete('/models/:id', async (c) => {
  const admin = requireAdmin(c);
  await deleteModel(admin, readParamUuid(c.req.param('id')));
  return c.body(null, 204);
});

function readParamUuid(raw: string): string {
  if (!z.string().uuid().safeParse(raw).success) throw notFound('Model not found');
  return raw;
}

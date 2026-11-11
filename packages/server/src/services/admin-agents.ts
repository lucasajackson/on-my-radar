/**
 * The platform admin's view of agents and the credentials behind them, and the revoke.
 *
 * Metadata only. A row says who owns an agent, how it is limited and what credentials are
 * live; it never carries a prompt, a brief, a memory, a radar's name, or any part of a token
 * (not the secret, its hash or its prefix). The admin console shows people and settings and
 * grants no content (plan 161d7453 §4); the identifiers here are revoke handles and nothing
 * more. Every act is a signed-in admin's decision, and is audited.
 */
import { and, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  parseScopes,
  DEFAULT_TOKEN_SCOPES,
  AGENT_REPO,
  type AdminAgentPageDto,
  type AdminInventoryQuery,
  type AdminTokenDto,
  type AdminTokenPageDto,
} from '@onmyradar/contract';
import { REFRESH_TOKEN_TTL_MS } from '../auth/lifetimes.js';
import { getDb, schema } from '../db/client.js';
import { badRequest, forbidden, notFound, type Actor } from '../http.js';
import { recordAudit } from './audit.js';
import { assertHumanDecision } from './access.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { revokeAgentCredentials, revokeGrantRows } from './tokens.js';

const PAGE = 100;

function assertAdmin(actor: Actor): void {
  assertHumanDecision(actor, 'The admin console is for a signed-in admin.');
  if (!actor.user.isAdmin) throw forbidden('Admins only');
}

/** A pair of text keys: the last row's creation time as Postgres wrote it (microseconds), and its id. */
function cursorOf(raw: string | undefined): Array<string> | null {
  if (raw === undefined) return null;
  const decoded = decodeCursor(raw);
  const keys = decoded?.['k'];
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string'))
    throw badRequest('Bad cursor');
  return keys;
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const owner = {
  id: schema.users.id,
  email: schema.users.email,
  name: schema.users.name,
};

const livePat = () =>
  and(
    isNull(schema.apiTokens.revokedAt),
    or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, sql`now()`)),
  );
const liveOauth = () =>
  and(
    isNull(schema.oauthTokens.revokedAt),
    or(
      gt(schema.oauthTokens.expiresAt, sql`now()`),
      and(
        sql`${schema.oauthTokens.refreshTokenHash} IS NOT NULL`,
        gt(schema.oauthTokens.createdAt, new Date(Date.now() - REFRESH_TOKEN_TTL_MS)),
      ),
    ),
  );

export async function adminListAgents(
  actor: Actor,
  query: AdminInventoryQuery = {},
): Promise<AdminAgentPageDto> {
  assertAdmin(actor);
  const db = getDb();
  const search = query.q
    ? or(
        ilike(schema.agents.name, like(query.q)),
        ilike(schema.agents.slug, like(query.q)),
        ilike(schema.users.email, like(query.q)),
      )
    : undefined;
  const after = cursorOf(query.cursor);
  const rows = await db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      handle: schema.agents.slug,
      radarScope: schema.agents.radarScope,
      archivedAt: schema.agents.archivedAt,
      createdAt: schema.agents.createdAt,
      createdText: sql<string>`${schema.agents.createdAt}::text`,
      owner,
      grants: sql<number>`(SELECT count(*)::int FROM agent_radar_grants g WHERE g.agent_id = ${schema.agents.id})`,
    })
    .from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.ownerId))
    .where(
      and(
        search,
        after
          ? sql`(${schema.agents.createdAt}, ${schema.agents.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(schema.agents.createdAt), desc(schema.agents.id))
    .limit(PAGE + 1);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.ownerId))
    .where(search);

  const page = rows.slice(0, PAGE);
  const ids = page.map((r) => r.id);
  const last = page[page.length - 1];
  if (ids.length === 0) return { agents: [], total: count?.n ?? 0, nextCursor: null };

  const pats = await db
    .select({
      agentId: schema.apiTokens.agentId,
      n: sql<number>`count(*)::int`,
      lastUsedAt: sql<Date | null>`max(${schema.apiTokens.lastUsedAt})`,
    })
    .from(schema.apiTokens)
    .where(and(livePat(), inArray(schema.apiTokens.agentId, ids)))
    .groupBy(schema.apiTokens.agentId);
  const grants = await db
    .select({
      agentId: schema.oauthTokens.agentId,
      n: sql<number>`count(DISTINCT (${schema.oauthTokens.userId}, ${schema.oauthTokens.clientId}))::int`,
      lastUsedAt: sql<Date | null>`max(${schema.oauthTokens.lastUsedAt})`,
    })
    .from(schema.oauthTokens)
    .where(and(liveOauth(), inArray(schema.oauthTokens.agentId, ids)))
    .groupBy(schema.oauthTokens.agentId);
  const sessions = await db
    .select({ agentId: schema.repoAgentSessions.agentId, n: sql<number>`count(*)::int` })
    .from(schema.repoAgentSessions)
    .where(
      and(
        inArray(schema.repoAgentSessions.agentId, ids),
        gt(
          schema.repoAgentSessions.lastSeenAt,
          new Date(Date.now() - AGENT_REPO.sessionIdleDays * 86_400_000),
        ),
      ),
    )
    .groupBy(schema.repoAgentSessions.agentId);
  const fences = await db
    .select({ agentId: schema.connectionAgentFences.agentId, n: sql<number>`count(*)::int` })
    .from(schema.connectionAgentFences)
    .where(inArray(schema.connectionAgentFences.agentId, ids))
    .groupBy(schema.connectionAgentFences.agentId);

  const agents = page.map((row) => {
    const pat = pats.find((p) => p.agentId === row.id);
    const grant = grants.find((g) => g.agentId === row.id);
    const used = [pat?.lastUsedAt, grant?.lastUsedAt]
      .filter((d): d is Date => d !== null && d !== undefined)
      .map((d) => new Date(d).getTime());
    return {
      id: row.id,
      name: row.name,
      handle: row.handle,
      owner: row.owner,
      radarScope: row.radarScope,
      radarGrantCount: row.radarScope === 'selected' ? row.grants : 0,
      archived: row.archivedAt !== null,
      liveTokens: pat?.n ?? 0,
      liveGrants: grant?.n ?? 0,
      liveSessions: sessions.find((x) => x.agentId === row.id)?.n ?? 0,
      // Only a limited agent's loaders carry its limit; an unlimited one's are just users of it.
      fencedConnections:
        row.radarScope === 'selected' ? (fences.find((x) => x.agentId === row.id)?.n ?? 0) : 0,
      lastUsedAt: used.length ? new Date(Math.max(...used)).toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
  return {
    agents,
    total: count?.n ?? 0,
    nextCursor:
      rows.length > PAGE && last ? encodeCursor({ k: [last.createdText, last.id] }) : null,
  };
}

type TokenRow = {
  kind: 'pat' | 'oauth';
  id: string;
  name: string;
  scope: string;
  consented: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  created_text: string;
  owner_id: string;
  owner_email: string;
  owner_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_slug: string | null;
};

export async function adminListTokens(
  actor: Actor,
  query: AdminInventoryQuery = {},
): Promise<AdminTokenPageDto> {
  assertAdmin(actor);
  const db = getDb();
  // One row per personal access token and per connected app: the apps are collapsed to a
  // (person, client) grant here, before the page is cut, so a busy app cannot fill a page
  // with its own rotations and a page never splits a grant.
  const live = sql`
    WITH pats AS (
      SELECT 'pat'::text AS kind, t.id::text AS id, t.name AS name, t.user_id, t.agent_id,
             t.scope AS scope, true AS consented, t.last_used_at, t.expires_at, t.created_at
        FROM api_tokens t
       WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
    ), grants AS (
      SELECT DISTINCT ON (o.user_id, o.client_id)
             'oauth'::text AS kind, o.client_id AS id, coalesce(c.client_name, o.client_id) AS name,
             o.user_id, o.agent_id, o.scope AS scope, o.scope_consented AS consented,
             max(o.last_used_at) OVER w AS last_used_at, NULL::timestamptz AS expires_at,
             min(o.created_at) OVER w AS created_at
        FROM oauth_tokens o
        LEFT JOIN oauth_clients c ON c.client_id = o.client_id
       WHERE o.revoked_at IS NULL
         AND (o.expires_at > now()
              OR (o.refresh_token_hash IS NOT NULL
                  AND o.created_at > ${new Date(Date.now() - REFRESH_TOKEN_TTL_MS)}))
      WINDOW w AS (PARTITION BY o.user_id, o.client_id)
       ORDER BY o.user_id, o.client_id, o.created_at DESC
    ), u AS (SELECT * FROM pats UNION ALL SELECT * FROM grants)`;
  const search = query.q
    ? sql`AND (u.name ILIKE ${like(query.q)} OR us.email ILIKE ${like(query.q)} OR a.name ILIKE ${like(query.q)} OR a.slug ILIKE ${like(query.q)})`
    : sql``;
  const after = cursorOf(query.cursor);
  const from = sql`FROM u JOIN users us ON us.id = u.user_id LEFT JOIN agents a ON a.id = u.agent_id WHERE true ${search}`;
  const rows = await db.execute<TokenRow>(sql`${live}
    SELECT u.kind, u.id, u.name, u.scope, u.consented, u.last_used_at, u.expires_at, u.created_at,
           u.created_at::text AS created_text, us.id AS owner_id, us.email AS owner_email,
           us.name AS owner_name, a.id AS agent_id, a.name AS agent_name, a.slug AS agent_slug
      ${from}
      ${
        after
          ? sql`AND (u.created_at, u.kind, us.id, u.id) < (${after[0]}::timestamptz, ${after[1]}, ${after[2]}::uuid, ${after[3]})`
          : sql``
      }
     ORDER BY u.created_at DESC, u.kind DESC, us.id DESC, u.id DESC
     LIMIT ${PAGE + 1}`);
  const counted = await db.execute<{ n: number }>(sql`${live} SELECT count(*)::int AS n ${from}`);

  const page = rows.rows.slice(0, PAGE);
  const last = page[page.length - 1];
  const tokens: AdminTokenDto[] = page.map((row) => ({
    kind: row.kind,
    id: row.id,
    name: row.name,
    owner: { id: row.owner_id, email: row.owner_email, name: row.owner_name },
    agent:
      row.agent_id && row.agent_name && row.agent_slug
        ? { id: row.agent_id, name: row.agent_name, handle: row.agent_slug }
        : null,
    // A connected app from before scopes were enforced acts at the defaults.
    scopes: row.consented ? parseScopes(row.scope) : [...DEFAULT_TOKEN_SCOPES],
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
  return {
    tokens,
    total: counted.rows[0]?.n ?? 0,
    nextCursor:
      rows.rows.length > PAGE && last
        ? encodeCursor({ k: [last.created_text, last.kind, last.owner_id, last.id] })
        : null,
  };
}

/** Revoke one personal access token, whoever holds it. */
export async function adminRevokePat(actor: Actor, tokenId: string): Promise<void> {
  assertAdmin(actor);
  const [row] = await getDb()
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, tokenId), isNull(schema.apiTokens.revokedAt)))
    .returning({ id: schema.apiTokens.id, userId: schema.apiTokens.userId });
  if (!row) throw notFound('Token not found');
  await recordAudit(actor, 'admin.token.revoke', 'api_token', tokenId, { ownerId: row.userId });
}

/** Disconnect one connected app of one person: every access and refresh token, now. */
export async function adminRevokeGrant(
  actor: Actor,
  userId: string,
  clientId: string,
): Promise<number> {
  assertAdmin(actor);
  const revoked = await getDb().transaction((tx) => revokeGrantRows(tx, userId, clientId));
  if (revoked === 0) throw notFound('No connected app with that id');
  await recordAudit(actor, 'admin.grant.revoke', 'oauth_client', null, {
    clientId,
    ownerId: userId,
    tokens: revoked,
  });
  return revoked;
}

/** Cut an agent off everywhere: all its credentials and load sessions. The agent stays. */
export async function adminRevokeAgent(actor: Actor, agentId: string): Promise<void> {
  assertAdmin(actor);
  const result = await getDb().transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id, ownerId: schema.agents.ownerId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    if (!agent) throw notFound('Agent not found');
    return { ownerId: agent.ownerId, ...(await revokeAgentCredentials(tx, agentId)) };
  });
  await recordAudit(actor, 'admin.agent.revoke', 'repo_agent', agentId, result);
}

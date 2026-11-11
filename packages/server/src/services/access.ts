/**
 * Radar and topic authorization — the single place that decides who may read or
 * write what. Both the REST routes and the MCP tools call `requireRadar` and
 * `requireTopic`, so an agent and a browser get identical answers by
 * construction.
 *
 * ## How a topic grant and a radar grant combine
 *
 * **Most-permissive union, and a direct grant always survives.**
 *
 * A person's effective role on a radar is the strongest of: ownership, their
 * own `radar_members` row, and whatever a *cascading* topic contributes. Holding
 * `viewer` on the topic and `editor` on one radar gives `editor` there — the
 * narrower grant is the one they were given deliberately, and having it silently
 * demoted by a container is not something anybody would predict.
 *
 * The rule that matters more is the converse: **revoking the topic grant leaves
 * the radar grant standing.** Each grant is stored separately and neither is
 * ever written in terms of the other, so revoking at one level removes exactly
 * that level and nothing else. A revocation whose blast radius depends on what
 * else happens to be true is a revocation nobody can reason about at the moment
 * they most need to.
 *
 * ## The cascade is computed, never materialised
 *
 * `topics.cascade` is read here, at authorization time. Turning it on writes no
 * membership rows and turning it off deletes none. That is what makes the switch
 * safe in both directions — nothing to overwrite going on, nothing left behind
 * coming off — and it is the same argument as `blips.search` being a GENERATED
 * column: a derived value that is computed cannot drift from its source.
 * `drizzle/0005_topics.sql` carries the long version.
 *
 * ## What a cascade can never grant
 *
 * `CASCADE_GRANTS` maps a topic role to `viewer` or `editor` and has no `owner`
 * in its range. A cascade may hand somebody the right to read or to capture; it
 * can never hand them the right to delete a radar, publish it, or share it
 * onward. The blast radius of the switch stops at content and never reaches
 * access itself.
 *
 * ## Union first, then clamp
 *
 * An agent's connection carries a *ceiling* — the strongest role its token was
 * granted (see `TOKEN_SCOPES`). Effective access is
 *
 *     min( decide(the human's grants), the token's ceiling )
 *
 * and the security argument rests on where the `min` is **not**. The union above
 * runs on the human's grants and only the human's grants; a token holds no
 * grants and therefore contributes no term to it. The only token-specific
 * operation in this entire file is a monotonically weakening `min` applied to an
 * answer that has already been decided. To give a token more access than its
 * human you would have to add a term to the union, and there is no term to add.
 * That is what makes this an intersection rather than a union with good
 * intentions.
 *
 * A browser session and a webhook delivery are unscoped, so their ceiling is
 * `'owner'` — the top of `RADAR_ROLES`, and therefore no cap. There is no "is
 * this an agent" branch anywhere: the clamp is unconditional and simply does
 * nothing for callers that are not capped.
 *
 * ## Organizations: one more way to take access away
 *
 * Every container sits in an organization (migration 0089). When that organization is a
 * `team`, a grant on the container counts only for somebody with an active membership in
 * it, a guest's counts only if it names them, and a cascade never crosses organizations.
 * Personal and install organizations are untouched, which is every container today. The
 * term only removes: no org role (not even `owner`) adds a grant, so an administrator reads
 * a member's radar only if it was shared with them. It is computed on each request from the
 * live membership rows, so removing or deactivating a membership ends the access with no
 * clean-up. See `orgStanding`, and `narrowByOrg` for where it meets `decide()`.
 *
 * `viaPublicLink` is untouched by the clamp, because it already requires that no
 * grant applied and a `min` cannot create one.
 *
 * ## Agents: one more way to take access away
 *
 * An agent may be limited to chosen radars (`agents.radar_scope = 'selected'`, with a ceiling
 * per radar in `agent_radar_grants`, migration 0090). The limit binds the *connection* its
 * credential was minted for, and any limited agent that credential has loaded (`Actor.radarFence`,
 * recorded in `connection_agent_fences`, so it outlives any load session),
 * never only the persona it writes as: otherwise an agent could shed its limit by loading a
 * wider one. It is read from the database on each question, so narrowing a grant, or revoking
 * the agent, ends the access on the next request. See `fenceCaps`.
 *
 * The fence is a cap and a filter and nothing else, in the same family as a token's ceiling:
 * it can turn an answer into "no radar" or lower the role, and there is no term in the union
 * for it to add. A radar outside it is a 404, the same as one nobody shared, and that includes
 * a public radar fetched by its slug: the agent was told which radars it has.
 * Topics are containers of radars an agent was not given, so a fenced connection reaches none.
 */
import { and, eq, inArray, isNull, or, sql, type Column, type SQL } from 'drizzle-orm';
import {
  commentsAllowed,
  CASCADE_GRANTS,
  isClientFacingTemplate,
  RADAR_ROLES,
  parseSharedAgentRef,
  roleAtLeast,
  sharedAgentRef,
  topicRoleAtLeast,
  type AccessSource,
  type AgentGrantCeiling,
  type RadarRole,
  type TokenScope,
  type TopicRole,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import {
  ApiError,
  ceilingOf,
  forbidden,
  insufficientScope,
  notFound,
  type Actor,
} from '../http.js';
import { env } from '../env.js';

type AccessDb = Pick<Db, 'select' | 'selectDistinct'>;

export type RadarRow = typeof schema.radars.$inferSelect;
export type TopicRow = typeof schema.topics.$inferSelect;

/**
 * A uuid that cannot exist, used to join membership tables for an anonymous
 * caller. `user_id = <nil uuid>` is false for every row, which is exactly the
 * answer wanted, and it keeps one query shape rather than two.
 */
const NOBODY = '00000000-0000-0000-0000-000000000000';

/* ============================ the organization term ============================ */

/**
 * Where a person stands in the organization a container lives in (migration 0089). One more
 * question, asked of every grant, and it can only ever take access away.
 *
 * - `open`: the container is in a personal or install org. Grants work exactly as they
 *   always did; this is every container that exists today.
 * - `member`: a team org, and the person has an active membership in it.
 * - `guest`: a team org, and their active membership is `guest`. Explicit grants only: a
 *   share to them counts, a cascade or their own ownership does not.
 * - `outsider`: a team org, and no membership or a deactivated one. Nothing they were ever
 *   granted counts. The term is computed on every request, so removing or deactivating a
 *   membership ends their access on the next one, with nothing to clean up.
 *
 * No org role adds access. `owner` and `admin` stand as `member`: they run the people and
 * the settings, and see a radar only if it was shared with them like anyone else. That is
 * also why a membership deleted behind the triggers' back (T1) cannot leave a hole: a
 * container whose owner is not in its team org grants that owner nothing.
 */
export type OrgStanding = 'open' | 'member' | 'guest' | 'outsider';
/** What kind of grant is being weighed: ownership, a row naming the person, or a topic's cascade. */
export type OrgGrant = 'owner' | 'direct' | 'cascade';

/** `role` is the person's role in an ACTIVE membership of that org, or null. A missing org fails closed. */
export function orgStanding(
  kind: 'personal' | 'install' | 'team' | null,
  role: 'owner' | 'admin' | 'member' | 'guest' | null,
): OrgStanding {
  if (kind === null) return 'outsider';
  if (kind !== 'team') return 'open';
  if (role === null) return 'outsider';
  return role === 'guest' ? 'guest' : 'member';
}

export function orgHonours(standing: OrgStanding, grant: OrgGrant): boolean {
  switch (standing) {
    case 'open':
    case 'member':
      return true;
    case 'guest':
      return grant === 'direct';
    case 'outsider':
      return false;
  }
}

/**
 * `orgHonours` for a set query: true when `userId` may use a `grant` of this strength in the
 * organization `orgId`. The same rule as `orgStanding`, written once more in SQL because
 * the readable-set, topic, reader and agent queries answer for many rows at once. A test
 * holds the two forms to the same answers.
 */
export function orgAllows(
  orgId: SQL | Column,
  userId: string | SQL | Column,
  grant: OrgGrant,
): SQL {
  const notGuest = grant === 'direct' ? sql`` : sql` AND org_m.role <> 'guest'`;
  return sql`(NOT EXISTS (SELECT 1 FROM organizations org_o WHERE org_o.id = ${orgId} AND org_o.kind = 'team')
    OR EXISTS (SELECT 1 FROM memberships org_m WHERE org_m.org_id = ${orgId}
      AND org_m.user_id = ${userId}::uuid AND org_m.deactivated_at IS NULL${notGuest}))`;
}

/** The standing of one person in each of these organizations. */
export async function orgStandings(
  userId: string | null,
  orgIds: ReadonlyArray<string | null>,
  db: AccessDb = getDb(),
): Promise<Map<string | null, OrgStanding>> {
  const ids = [...new Set(orgIds.filter((id): id is string => id !== null))];
  const out = new Map<string | null, OrgStanding>([[null, 'outsider']]);
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: schema.organizations.id,
      kind: schema.organizations.kind,
      role: schema.memberships.role,
    })
    .from(schema.organizations)
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.orgId, schema.organizations.id),
        eq(schema.memberships.userId, userId ?? NOBODY),
        isNull(schema.memberships.deactivatedAt),
      ),
    )
    .where(inArray(schema.organizations.id, ids));
  for (const row of rows) out.set(row.id, orgStanding(row.kind, row.role));
  for (const id of ids) if (!out.has(id)) out.set(id, 'outsider');
  return out;
}

/**
 * Whether this radar may never be public: it is client-facing now, or it ever
 * was (`was_client_facing`, set by a trigger and never cleared). A former
 * helpdesk still holds the internal notes and drafts it gathered, so switching
 * its template is not a way to publish them (`docs/HELPDESK.md` §6.1). Every
 * refusal and fence on the public side reads this, never the template alone.
 */
export function neverPublic(radar: Pick<RadarRow, 'template' | 'wasClientFacing'>): boolean {
  return radar.wasClientFacing || isClientFacingTemplate(radar.template);
}

export interface RadarAccess {
  radar: RadarRow;
  /** The effective role: the most permissive of the grants below. */
  role: RadarRole | null;
  /** The caller's own grant on this radar, ignoring every topic. */
  directRole: RadarRole | null;
  /** What a cascading topic contributes, or null when none does. */
  topicRole: RadarRole | null;
  /** Which grant the effective role came from. Null when there is no access. */
  via: AccessSource | null;
  viaPublicLink: boolean;
  /**
   * The topic this radar sits in, for decisions this module makes (whether its
   * members reach the radar). Not a statement that the caller may be *shown*
   * it — that is `topicVisible`.
   */
  topic: TopicRow | null;
  /**
   * Whether the caller may see which topic the radar is filed in: they own the
   * topic or are a member of it. Somebody the *radar* alone was shared with is
   * not told — a topic's name is often the most private string in an account,
   * and sharing one radar is not a decision to reveal the folder it sits in.
   */
  topicVisible: boolean;
  /**
   * The cap the caller's *connection* imposes, independent of their grants.
   * `'owner'` — the default for anything that is not a scoped bearer token — is
   * no cap at all. `role` and the three booleans below already have it applied;
   * it is carried so `canParticipate` can ask about it without re-deriving.
   */
  ceiling: RadarRole;
  /**
   * What the agent's radar grant alone allows here, when the connection is limited to selected
   * radars; absent otherwise. Already folded into `ceiling`, and carried so a refusal can say
   * it was the grant and not the token that stopped the act.
   */
  agentCeiling?: RadarRole;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
}

/** Most permissive wins. `null` is weaker than every role. */
function strongest(a: RadarRole | null, b: RadarRole | null): RadarRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return RADAR_ROLES.indexOf(a) >= RADAR_ROLES.indexOf(b) ? a : b;
}

/**
 * A decided role capped by a token's ceiling. The `min` half of the rule above.
 *
 * `null` in means `null` out: a ceiling can only ever take away, so it must not
 * be able to turn "no access" into any access at all. Exported because
 * `listRadars` computes the same union in SQL for the sidebar, and a list that
 * advertises `canWrite` on a radar the connection cannot write to is the
 * MCP-disagrees-with-REST divergence happening inside one service.
 */
export function clampRole(role: RadarRole | null, ceiling: RadarRole): RadarRole | null {
  if (role === null) return null;
  return RADAR_ROLES.indexOf(role) <= RADAR_ROLES.indexOf(ceiling) ? role : ceiling;
}

/**
 * Apply a connection's ceiling to an access already decided from a human's
 * grants.
 *
 * `role` is capped and the three capability booleans are recomputed from the
 * capped role. `directRole`, `topicRole` and `via` are deliberately *not*
 * capped: they are facts about the person, not capabilities, and they are what
 * the interface uses to explain why access exists and what would survive a
 * cascade being switched off. Capping them would make an agent's answer to
 * "why can I see this" differ from its human's for no benefit.
 */
function clamp(access: RadarAccess, ceiling: RadarRole): RadarAccess {
  const role = clampRole(access.role, ceiling);
  return {
    ...access,
    ceiling,
    role,
    // Unchanged by construction: every ceiling is at least `viewer`, so a clamp
    // can never take reading away. Recomputed rather than copied so that stays
    // true if the scope vocabulary ever grows a weaker rung.
    canRead: role !== null || access.viaPublicLink,
    canWrite: role !== null && roleAtLeast(role, 'editor'),
    canManage: role !== null && roleAtLeast(role, 'owner'),
  };
}

/* ============================ the agent's radar fence ============================ */

/** The role a grant's ceiling stands for, in the vocabulary of token scopes. */
const GRANT_ROLE: Record<AgentGrantCeiling, RadarRole> = {
  read: 'viewer',
  write: 'editor',
  manage: 'owner',
};

export function weakestRole(a: RadarRole, b: RadarRole | undefined): RadarRole {
  return b && RADAR_ROLES.indexOf(b) < RADAR_ROLES.indexOf(a) ? b : a;
}

/**
 * The radars a limited connection may reach, with the most it may do on each; `null` when
 * the connection is not limited at all, which is every browser session, every webhook and
 * every agent left on `all` (so the default changes nothing).
 *
 * Every agent in `Actor.radarFence` must allow a radar for it to be reachable, and the
 * lowest ceiling among them wins. An agent whose row is gone allows nothing: a fence that
 * cannot be read fails closed. `radarIds` narrows the answer to those radars; omitted, it
 * is every radar any limited agent was granted.
 *
 * This is the one place the limit is read. Lookups ask it about one radar, and every set
 * (the sidebar, search, dashboards, tags, notifications) intersects with what it returns.
 */
export async function fenceCaps(
  actor: Actor | null | undefined,
  radarIds?: readonly string[],
  db: AccessDb = getDb(),
): Promise<Map<string, RadarRole> | null> {
  const agentIds = actor?.radarFence;
  if (!agentIds?.length) return null;
  const agents = await db
    .select({ id: schema.agents.id, scope: schema.agents.radarScope })
    .from(schema.agents)
    .where(inArray(schema.agents.id, [...agentIds]));
  const found = new Map(agents.map((a) => [a.id, a.scope]));
  const limited = agentIds.filter((id) => found.get(id) !== 'all');
  if (limited.length === 0) return null;
  const caps = new Map<string, RadarRole>();
  const gone = limited.some((id) => !found.has(id));
  if (gone || (radarIds && radarIds.length === 0)) return caps;
  const grants = await db
    .select({
      agentId: schema.agentRadarGrants.agentId,
      radarId: schema.agentRadarGrants.radarId,
      ceiling: schema.agentRadarGrants.ceiling,
    })
    .from(schema.agentRadarGrants)
    .where(
      and(
        inArray(schema.agentRadarGrants.agentId, limited),
        radarIds ? inArray(schema.agentRadarGrants.radarId, [...radarIds]) : undefined,
      ),
    );
  const byRadar = new Map<string, Map<string, RadarRole>>();
  for (const g of grants) {
    const per = byRadar.get(g.radarId) ?? new Map<string, RadarRole>();
    per.set(g.agentId, GRANT_ROLE[g.ceiling]);
    byRadar.set(g.radarId, per);
  }
  for (const [radarId, per] of byRadar) {
    if (limited.some((id) => !per.has(id))) continue;
    caps.set(
      radarId,
      [...per.values()].reduce((lowest, r) => weakestRole(lowest, r)),
    );
  }
  return caps;
}

/** True for a connection limited to selected radars, which reaches no topic. */
export async function topicsWithheld(
  actor: Actor | null | undefined,
  db: AccessDb = getDb(),
): Promise<boolean> {
  return (await fenceCaps(actor, [], db)) !== null;
}

/** Radar ids a connection may not go beyond: `readable`, cut to the agent's fence. */
export async function readableRadarIdsFor(actor: Actor, db: AccessDb = getDb()): Promise<string[]> {
  const [ids, fence] = await Promise.all([
    readableRadarIds(actor.user.id, db),
    fenceCaps(actor, undefined, db),
  ]);
  return fence ? ids.filter((id) => fence.has(id)) : ids;
}

interface Grants {
  ownerRole: RadarRole | null;
  directRole: RadarRole | null;
  topicRole: RadarRole | null;
  /**
   * The public slug of a public radar was the identifier used. A fact about the request,
   * not a grant: it applies only if no grant does, and an organization's term decides which
   * grants those are.
   */
  publicLink: boolean;
  topicVisible: boolean;
  /** Where the caller stands in the radar's organization. */
  org: OrgStanding;
}

/**
 * The organization term: the grants a person holds on a radar, with every one their
 * standing in the radar's organization does not honour removed. The same function narrows
 * the sidebar's per-row roles, so the list and the lookup apply one rule.
 */
export function narrowByOrg(
  org: OrgStanding,
  grants: Pick<Grants, 'ownerRole' | 'directRole' | 'topicRole'>,
): Pick<Grants, 'ownerRole' | 'directRole' | 'topicRole'> {
  return {
    ownerRole: orgHonours(org, 'owner') ? grants.ownerRole : null,
    directRole: orgHonours(org, 'direct') ? grants.directRole : null,
    topicRole: orgHonours(org, 'cascade') ? grants.topicRole : null,
  };
}

function decide(radar: RadarRow, topic: TopicRow | null, grants: Grants): RadarAccess {
  const { topicVisible, org } = grants;
  const { ownerRole, directRole, topicRole } = narrowByOrg(org, grants);
  // After the term, not before: somebody whose grants an organization no longer honours
  // reads a public radar exactly as a stranger does, and no worse.
  const viaPublicLink =
    grants.publicLink && ownerRole === null && directRole === null && topicRole === null;
  const role = strongest(strongest(ownerRole, directRole), topicRole);

  // Ordered by strength so the reason shown is the one actually doing the work.
  // A person who owns a radar is told they own it, not that a topic let them in.
  const via: AccessSource | null =
    ownerRole !== null && role === ownerRole
      ? 'owner'
      : directRole !== null && role === directRole
        ? 'member'
        : topicRole !== null && role === topicRole
          ? 'topic'
          : viaPublicLink
            ? 'public'
            : null;

  return {
    radar,
    role,
    directRole,
    topicRole,
    via,
    viaPublicLink,
    topic,
    topicVisible,
    // Uncapped. `getRadarAccess` runs `clamp` over this, which is the only
    // place a real ceiling is applied — so `decide` stays a pure function of
    // the human's grants and nothing else.
    ceiling: 'owner',
    canRead: role !== null || viaPublicLink,
    // A public link is read-only, always. Public never implies write.
    canWrite: role !== null && roleAtLeast(role, 'editor'),
    // Unreachable through a cascade by construction: `CASCADE_GRANTS` has no
    // 'owner' in its range, so `topicRole` can never satisfy this.
    canManage: role !== null && roleAtLeast(role, 'owner'),
  };
}

/**
 * The caller's own membership row on a radar, ignoring topics entirely.
 *
 * Kept separate from the effective role because two callers genuinely want the
 * direct grant: `shareRadar` decides whether to notify by asking whether this
 * person had a *direct* grant before (reaching a radar through a cascade does
 * not make a later direct share a non-event), and the UI needs it to say what
 * would survive if a cascade were switched off.
 */
export async function directRoleFor(
  radar: RadarRow,
  userId: string | null,
  db: AccessDb = getDb(),
): Promise<RadarRole | null> {
  if (!userId) return null;
  if (radar.ownerId === userId) return 'owner';
  const rows = await db
    .select({ role: schema.radarMembers.role })
    .from(schema.radarMembers)
    .where(and(eq(schema.radarMembers.radarId, radar.id), eq(schema.radarMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/**
 * Radar, the caller's direct grant, the topic and the caller's topic grant — in
 * one round trip, because this runs on every authorized request in the app.
 */
async function loadAccessRow(
  idOrPublicSlug: string,
  userId: string | null,
  db: AccessDb,
): Promise<{
  radar: RadarRow;
  directRole: RadarRole | null;
  topic: TopicRow | null;
  topicMemberRole: TopicRole | null;
  org: OrgStanding;
} | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    idOrPublicSlug,
  );
  const me = userId ?? NOBODY;

  const rows = await db
    .select({
      radar: schema.radars,
      directRole: schema.radarMembers.role,
      topic: schema.topics,
      topicMemberRole: schema.topicMembers.role,
      orgKind: schema.organizations.kind,
      orgRole: schema.memberships.role,
    })
    .from(schema.radars)
    .leftJoin(
      schema.radarMembers,
      and(eq(schema.radarMembers.radarId, schema.radars.id), eq(schema.radarMembers.userId, me)),
    )
    // A topic in another organization than the radar is not its topic: nothing it holds
    // reaches the radar, and the radar is not shown as filed there.
    .leftJoin(
      schema.topics,
      and(
        eq(schema.topics.id, schema.radars.topicId),
        eq(schema.topics.organizationId, schema.radars.organizationId),
      ),
    )
    .leftJoin(
      schema.topicMembers,
      and(eq(schema.topicMembers.topicId, schema.topics.id), eq(schema.topicMembers.userId, me)),
    )
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.radars.organizationId))
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.orgId, schema.radars.organizationId),
        eq(schema.memberships.userId, me),
        isNull(schema.memberships.deactivatedAt),
      ),
    )
    .where(
      and(
        sql`omr_account_open(${schema.radars.ownerId})`,
        sql`omr_account_open(${me}::uuid)`,
        isUuid
          ? or(eq(schema.radars.id, idOrPublicSlug), eq(schema.radars.publicSlug, idOrPublicSlug))
          : eq(schema.radars.publicSlug, idOrPublicSlug),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    radar: row.radar,
    directRole: row.directRole ?? null,
    topic: row.topic ?? null,
    topicMemberRole: row.topicMemberRole ?? null,
    org: orgStanding(row.orgKind ?? null, row.orgRole ?? null),
  };
}

/**
 * Whether somebody may be shown that a radar sits in `topic`: its owner, or any
 * member of it, cascading or not. The one rule every radar surface applies —
 * `getRadarAccess` for a single radar and `listRadars` for the sidebar.
 */
export function topicVisibleTo(
  topic: TopicRow | null,
  userId: string | null,
  topicMemberRole: TopicRole | null,
  org: OrgStanding = 'open',
): boolean {
  if (!topic || !userId) return false;
  return (
    (topic.ownerId === userId && orgHonours(org, 'owner')) ||
    (topicMemberRole !== null && orgHonours(org, 'direct'))
  );
}

export async function getRadarAccess(
  idOrPublicSlug: string,
  actor: Actor | null,
  db: AccessDb = getDb(),
): Promise<RadarAccess | null> {
  /*
    An integration credential reaches no radar by this road, whatever its
    owner could (`docs/HELPDESK.md` §3.3). It acts *as* the owner, so without
    this the union below would hand it everything the owner holds; with it,
    every service written now or later refuses the portal by default, because
    `requireRadar` — "the only way any code reaches a radar" — comes through
    here. Its one door is `requireHelpdeskRadar`, which narrows instead.
  */
  if (actor?.kind === 'integration' || actor?.kind === 'guest') return null;
  return computeRadarAccess(idOrPublicSlug, actor, db);
}

/**
 * Null whenever the caller may not read the radar. A denied lookup never comes back as an
 * object that says `canRead: false`, because a caller that only checks for null would serve
 * it: the answer to "may this person see this radar" is the lookup returning anything at all.
 */
async function computeRadarAccess(
  idOrPublicSlug: string,
  actor: Actor | null,
  db: AccessDb,
): Promise<RadarAccess | null> {
  const access = await decideRadarAccess(idOrPublicSlug, actor, db);
  return access?.canRead ? access : null;
}

async function decideRadarAccess(
  idOrPublicSlug: string,
  actor: Actor | null,
  db: AccessDb,
): Promise<RadarAccess | null> {
  const userId = actor?.user.id ?? null;
  const loaded = await loadAccessRow(idOrPublicSlug, userId, db);
  if (!loaded) return null;
  const { radar, directRole, topic, topicMemberRole, org } = loaded;

  const ownerRole: RadarRole | null = userId && radar.ownerId === userId ? 'owner' : null;

  /*
    An array contributes access only when it is *cascading*. A grant on a
    non-cascading topic says "you are part of this grouping" and hands over no
    radar at all — which is the whole point of the ask this implements.

    Deliberately no branch for the array's owner. Every radar in an array is
    owned by that array's owner (`setRadarTopic` requires `topic.ownerId ===
    radar.ownerId`, and losing `manage` on a radar detaches it from any array
    its owner does not own), so the owner is already covered above; and if that invariant were ever broken,
    the conservative answer — an array owner gets nothing extra on a radar they
    do not own — is the one that should hold.
  */
  const topicRole: RadarRole | null =
    topic?.cascade && topic.ownerId === radar.ownerId && topicMemberRole
      ? CASCADE_GRANTS[topicMemberRole]
      : null;

  // The public link only grants anything when it is the identifier that was
  // used: knowing a private radar's uuid must not become read access just
  // because the radar was later made public under a different slug. Unchanged
  // by topics — a public visitor holds no membership of anything.
  // Never on a client-facing radar (a helpdesk), whatever the row says: the
  // constraint and the service refusals should make this unreachable, and if
  // they ever fail the answer must still be no (docs/HELPDESK.md §6.1).
  // `decide` withholds it from anybody a grant (that the organization honours) reaches.
  const publicLink =
    !neverPublic(radar) &&
    radar.visibility === 'public' &&
    radar.publicSlug !== null &&
    radar.publicSlug === idOrPublicSlug;

  // The agent's radar grant, asked about this radar alone. Absent grant: no such radar.
  const fence = await fenceCaps(actor, [radar.id], db);
  const agentCeiling = fence ? fence.get(radar.id) : undefined;
  if (fence && !agentCeiling) return null;

  // Union first, then clamp. The clamp is the tail of this function and nowhere
  // else, so there is exactly one expression in the application that can narrow
  // an access for being agent-borne.
  const clamped = clamp(
    decide(radar, topic, {
      ownerRole,
      directRole,
      topicRole,
      publicLink,
      // A fenced connection is not told which topic a radar is filed in.
      topicVisible: !fence && topicVisibleTo(topic, userId, topicMemberRole, org),
      org,
    }),
    weakestRole(ceilingOf(actor), agentCeiling),
  );
  return agentCeiling ? { ...clamped, agentCeiling } : clamped;
}

export type AccessNeed = 'read' | 'write' | 'manage';

/* --------------------------- the integration's door -------------------------- */

export type IntegrationRow = typeof schema.integrations.$inferSelect;
export type EnrolmentRow = typeof schema.integrationRadars.$inferSelect;

declare const helpdeskAccessBrand: unique symbol;
declare const nativeSupportBrand: unique symbol;

/** Capture-only proof. It grants no membership or general radar access. */
export interface NativeSupportAccess {
  readonly access: RadarAccess;
  readonly requester: Actor['user'];
  readonly [nativeSupportBrand]: true;
}

export async function requireNativeSupport(
  actor: Actor | null | undefined,
  db: AccessDb = getDb(),
): Promise<NativeSupportAccess> {
  if (actor?.kind !== 'user' || !actor.sessionId || actor.agent || actor.connection)
    throw new ApiError(401, 'unauthorized', 'Sign in to contact support.');
  const [requester] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.id, actor.sessionId),
        eq(schema.sessions.userId, actor.user.id),
        sql`${schema.sessions.expiresAt} > now()`,
        sql`${schema.users.state} IN ('active', 'pending')`,
      ),
    )
    .for('share');
  if (!requester) throw new ApiError(401, 'unauthorized', 'Sign in to contact support.');
  const config = env();
  if (!config.SUPPORT_RADAR_ID || !config.SUPPORT_OWNER_ID)
    throw new ApiError(503, 'support_unavailable', 'Support intake is not available yet.');
  const [found] = await db
    .select({ radar: schema.radars })
    .from(schema.radars)
    .innerJoin(schema.users, eq(schema.users.id, schema.radars.ownerId))
    .where(
      and(
        eq(schema.radars.id, config.SUPPORT_RADAR_ID),
        eq(schema.radars.ownerId, config.SUPPORT_OWNER_ID),
        eq(schema.users.state, 'active'),
        sql`omr_account_open(${schema.users.id})`,
        sql`omr_account_open(${schema.radars.ownerId})`,
        eq(schema.users.isAdmin, true),
        eq(schema.radars.visibility, 'private'),
        eq(schema.radars.template, 'helpdesk'),
        eq(schema.radars.kind, 'standard'),
        // The queue is the operator's. Capture-only and deliberately open to people outside
        // any organization, but not once its owner has left the organization it lives in.
        orgAllows(schema.radars.organizationId, schema.radars.ownerId, 'owner'),
      ),
    )
    .for('share');
  if (!found)
    throw new ApiError(503, 'support_unavailable', 'Support intake is not available yet.');
  return {
    requester: requester.user,
    access: {
      radar: found.radar,
      role: null,
      directRole: null,
      topicRole: null,
      via: null,
      viaPublicLink: false,
      topic: null,
      topicVisible: false,
      ceiling: 'owner',
      canRead: false,
      canWrite: true,
      canManage: false,
    },
  } as NativeSupportAccess;
}

/**
 * A radar an integration may reach, and why. Only `requireHelpdeskRadar`
 * builds one, so a service that takes it (`createBlip`'s `helpdesk` option) is
 * handed proof rather than a radar id it would have to re-check.
 */
export interface HelpdeskAccess {
  readonly access: RadarAccess;
  readonly integration: IntegrationRow;
  readonly enrolment: EnrolmentRow;
  readonly [helpdeskAccessBrand]: true;
}

/**
 * The only door an integration credential has (`docs/HELPDESK.md` §3.2-3.3).
 *
 * An **intersection, not a union**: the owner's own access, computed exactly
 * as for anybody and clamped to the credential's `editor` ceiling, then
 * narrowed by every one of these, each answering 404 — never 403, which would
 * confirm the radar exists:
 *
 * - a live enrolment of this radar for this integration, and the integration
 *   itself not revoked (expiry and the owner's state were settled when the
 *   token resolved);
 * - the radar still owned by the integration's owner;
 * - a client-facing template (read off the registry, not an id);
 * - an ordinary radar, not a smart one;
 * - private (a helpdesk never is public, and this is the last fence for it);
 * - write access, as the owner's clamped access says.
 *
 * Topics play no part: the enrolment is the scope, so filing the radar,
 * moving it between topics or turning a cascade on changes nothing here.
 */
export async function requireHelpdeskRadar(
  radarId: string,
  actor: Actor | null,
  db: AccessDb = getDb(),
): Promise<HelpdeskAccess> {
  const missing = () => notFound('Radar not found');
  if (actor?.kind !== 'integration' || !actor.integrationId) throw missing();
  const [row] = await db
    .select({ integration: schema.integrations, enrolment: schema.integrationRadars })
    .from(schema.integrationRadars)
    .innerJoin(
      schema.integrations,
      eq(schema.integrations.id, schema.integrationRadars.integrationId),
    )
    .where(
      and(
        eq(schema.integrationRadars.integrationId, actor.integrationId),
        eq(schema.integrationRadars.radarId, radarId),
        isNull(schema.integrationRadars.revokedAt),
        isNull(schema.integrations.revokedAt),
      ),
    )
    .limit(1);
  if (!row) throw missing();
  if (row.integration.ownerId !== actor.user.id) throw missing();
  const access = await computeRadarAccess(radarId, actor, db);
  if (!access) throw missing();
  const radar = access.radar;
  if (radar.ownerId !== row.integration.ownerId) throw missing();
  if (!isClientFacingTemplate(radar.template)) throw missing();
  if (radar.kind !== 'standard') throw missing();
  if (radar.visibility !== 'private') throw missing();
  if (!access.canWrite) throw missing();
  return { access, integration: row.integration, enrolment: row.enrolment } as HelpdeskAccess;
}

/**
 * Loads a radar and asserts the access level, or throws. A radar the caller may
 * not read is reported as 404, never 403 — otherwise the error itself confirms
 * that a given id exists.
 */
export async function requireRadar(
  idOrPublicSlug: string,
  actor: Actor | null,
  need: AccessNeed = 'read',
  db: AccessDb = getDb(),
): Promise<RadarAccess> {
  const access = await getRadarAccess(idOrPublicSlug, actor, db);
  if (!access) throw notFound('Radar not found');
  // The agent's own limit is named first: re-authorizing the token would not lift it.
  assertGrant(access.agentCeiling, need, actor);
  // The connection's grant is tested before the person's permission, and the
  // two refusals are deliberately different sentences. "You have read-only
  // access to this radar" sends an agent looking for a permission its human
  // already has; a scope refusal says the *connection* was granted less than
  // this needs, which only a re-authorization can change.
  assertScope(access.ceiling, need, actor);
  if (need === 'write' && !access.canWrite)
    throw forbidden('You have read-only access to this radar');
  if (need === 'manage' && !access.canManage) throw forbidden('Only the owner can do that');
  return access;
}

/* ------------------------------ token ceilings ---------------------------- */

/** What each level of `AccessNeed` costs, in both vocabularies. */
const NEEDED_ROLE: Record<AccessNeed, RadarRole> = {
  read: 'viewer',
  write: 'editor',
  manage: 'owner',
};
const NEEDED_SCOPE: Record<AccessNeed, TokenScope> = {
  read: 'radars:read',
  write: 'radars:write',
  manage: 'radars:manage',
};

/**
 * A connection minted for an agent that has been archived reads but cannot
 * write; its ceiling is capped at `viewer` in `auth/bearer.ts`, and this is the
 * sentence that says why instead of the generic scope refusal.
 */
function refuseRetiredAgent(actor: Actor | null | undefined): void {
  if (!actor?.retiredAgent) return;
  throw forbidden(
    `This connection was created for ${actor.retiredAgent}, so it can only read. ` +
      'Restore the agent in On My Radar if it still exists, or reconnect with a new token.',
  );
}

/** The agent was limited to this radar at a lower level than the act needs. */
function assertGrant(agentCeiling: RadarRole | undefined, need: AccessNeed, actor?: Actor | null) {
  if (!agentCeiling || roleAtLeast(agentCeiling, NEEDED_ROLE[need])) return;
  const agent = actor?.agent ? `“${actor.agent.name}”` : 'This agent';
  throw forbidden(
    `${agent} was given ${GRANT_NAME[agentCeiling]} access to this radar, so it cannot ${GRANT_ACT[need]}. ` +
      'Its owner can change that in the agent’s settings in On My Radar.',
  );
}
const GRANT_NAME: Record<RadarRole, string> = {
  viewer: 'read-only',
  editor: 'read and write',
  owner: 'full',
};
const GRANT_ACT: Record<AccessNeed, string> = {
  read: 'read it',
  write: 'change it',
  manage: 'manage it',
};

function assertScope(ceiling: RadarRole, need: AccessNeed, actor?: Actor | null): void {
  if (roleAtLeast(ceiling, NEEDED_ROLE[need])) return;
  refuseRetiredAgent(actor);
  const scope = NEEDED_SCOPE[need];
  const hint =
    scope === 'radars:manage'
      ? ' For a connected app, disconnect it in Settings and reconnect, ticking publish and share.'
      : '';
  throw insufficientScope(scope, `This connection was not granted ${scope}.${hint}`);
}

/**
 * Some acts are a person's decision on a real screen, whatever the token was
 * granted. Refuse them for anything that is not a signed-in human.
 *
 * This is a **second, narrower boundary than scopes, and it is not the same
 * question.** A scope asks "how much of what this person can do was handed to
 * this connection"; this asks "is this the kind of act a connection may perform
 * at all". No arrangement of scopes answers the second one, because the acts it
 * covers are all things the person themselves may obviously do — the objection
 * is not to the power, it is to who is exercising it and whether anybody is
 * present to see the consequence.
 *
 * Three of these were already documented as fenced (`docs/DESIGN.md` §17, and
 * `docs/MCP.md` on notification settings) and enforced **only by the absence of
 * an MCP tool**. The absence of a tool is not a refusal: `attachActor` is global
 * middleware with no path restriction, so an agent token authenticates on
 * `/api/*` exactly like a session cookie, and every one of those fences was
 * reachable over REST. Turning a cascade on, adding a stranger to the topic and
 * filing a private radar into it is three ordinary REST calls, and it ends with
 * somebody reading a radar nobody shared with them.
 *
 * So the rule is: **an agent-facing refusal belongs on the shared service path,
 * never in the tool router.** A tool that refuses something the service allows
 * is documentation, not a boundary. `assertMayInvite` in `services/invites.ts`
 * had this right; the topic fences did not.
 */
export function assertHumanDecision(actor: Actor | null, message: string): void {
  if (actor?.kind === 'user') return;
  throw forbidden(message);
}

/**
 * Assert a connection's ceiling reaches `need`, for the handful of operations
 * that have no radar to clamp.
 *
 * Creating a radar, creating a topic, arranging a dashboard and marking your own
 * notifications read all mutate state without ever passing through
 * `requireRadar`, so the clamp cannot reach them. This is the same check the
 * clamp performs, in the same module, against the same two tables above — not a
 * second authorization path, because it decides nothing about *grants*. It only
 * asks what the connection was given.
 *
 * `what` completes the sentence "…so it cannot <what>", so it should read as a
 * verb phrase: 'create a radar', 'change how loud a radar is'.
 */
export async function requireScope(
  actor: Actor | null,
  need: AccessNeed,
  what: string,
  db: AccessDb = getDb(),
): Promise<void> {
  /*
    These acts name no radar, so there is nothing to look up in the agent's grants: an agent
    limited to selected radars may not do them, or it could make itself a radar it was never
    given, or file one into an array, or open an integration. The few acts that are safe for
    it (they are filtered to its radars afterwards) ask `requireScopeWithinGrants` instead,
    so a new caller of this function is refused by default.
  */
  if ((await fenceCaps(actor, [], db)) !== null) {
    throw forbidden(`This agent is limited to selected radars, so it cannot ${what}.`);
  }
  requireScopeWithinGrants(actor, need, what);
}

/**
 * `requireScope` for an act that is already narrowed to the agent's radars afterwards:
 * reading or arranging dashboards, marking its own notifications, deleting a comment on a
 * radar it was given. A limited agent passes this; the token's ceiling still applies.
 */
export function requireScopeWithinGrants(
  actor: Actor | null,
  need: AccessNeed,
  what: string,
): void {
  // No radar-less act — creating a radar, a topic, a dashboard — belongs to the
  // portal's credential, at any level (§3.3).
  if (actor?.kind === 'integration' || actor?.kind === 'guest') {
    throw forbidden(`An integration credential cannot ${what}.`);
  }
  const ceiling = ceilingOf(actor);
  if (roleAtLeast(ceiling, NEEDED_ROLE[need])) return;
  refuseRetiredAgent(actor);
  const scope = NEEDED_SCOPE[need];
  throw insufficientScope(scope, `This connection was not granted ${scope}, so it cannot ${what}.`);
}

/**
 * Commenting and reacting: a third capability, between reading and writing.
 *
 * the product owner's ask was explicit — "if you share a radar with someone, people should
 * be able to comment on blips they don't own" — and a `viewer` is exactly that
 * person. So participation is NOT `canWrite`: a viewer may take part in the
 * conversation around a blip without being able to edit the blip itself. That
 * is the whole point of the capability existing separately.
 *
 * Two things it deliberately is not:
 *
 * - **It is never granted by a public link.** `decide()` says a public link is
 *   read-only, always, and that stays true here: `role !== null` requires a real
 *   membership. Anonymous writes on the public surface are a security decision
 *   about that surface and should be argued on their own, not arrive as a side
 *   effect of shipping comments. (docs/TEMPLATES.md makes the same point about
 *   a public voting board.)
 * - **It is not a way around the radar's own switch.** Each feature has a
 *   per-radar toggle, and an owner turning it off has to mean the surface is
 *   gone for everyone including themselves — otherwise "off" would only mean
 *   "hidden in the SPA" and the MCP tool would still write.
 *
 * A cascaded member *does* get it, because `role` is the effective role: being
 * let into a radar through a topic lets you join the conversation in it, which
 * is the only reading of a shared discussion radar that makes sense.
 */
export type Participation = 'comments' | 'reactions';

export function canParticipate(access: RadarAccess, feature: Participation): boolean {
  if (access.role === null) return false;
  // Participation sits *below* `canWrite` for a human — a viewer may join the
  // conversation without editing the blip, which is the whole reason this
  // capability exists separately. For a token it does not. From the token's
  // side a comment is an outbound utterance, and a connection granted
  // `radars:read` that can still post comments is not read-only in any sense a
  // person would recognise.
  if (!roleAtLeast(access.ceiling, 'editor')) return false;
  return feature === 'comments'
    ? access.radar.commentsEnabled && commentsAllowed(access.radar.template)
    : access.radar.reactionsEnabled;
}

/**
 * Loads a radar and asserts the caller may take part in it, or throws.
 *
 * The 404-not-403 rule from `requireRadar` still applies to the radar itself —
 * this only ever adds a 403 once the caller has demonstrably been let in.
 */
export async function requireParticipation(
  idOrPublicSlug: string,
  actor: Actor | null,
  feature: Participation,
  db: AccessDb = getDb(),
): Promise<RadarAccess> {
  const access = await requireRadar(idOrPublicSlug, actor, 'read', db);
  if (access.role === null) {
    // Reached through the public link. Saying "read-only" is honest and leaks
    // nothing: the caller already knows the radar is public.
    throw forbidden('This radar is published read-only.');
  }
  // Named separately from the radar's own switch below, so an agent is told
  // which of the two stopped it: its own grant, or the owner's setting.
  requireScopeWithinGrants(
    actor,
    'write',
    feature === 'comments' ? 'post a comment' : 'react to a blip',
  );
  if (!canParticipate(access, feature)) {
    throw forbidden(
      feature === 'comments'
        ? 'Comments are turned off on this radar.'
        : 'Reactions are turned off on this radar.',
    );
  }
  return access;
}

/**
 * Radar ids the user can read — used to scope cross-radar search, the tag
 * vocabulary, dashboards and every smart radar's resolution.
 *
 * The topic leg is why this is one query rather than a union in application
 * code: a smart radar resolves against exactly this set, so a radar reachable
 * only through a cascade has to appear here or the same person would find it in
 * the sidebar and not in a search. That divergence is the class of bug the
 * one-service-layer rule exists to prevent, applied within a single service.
 */
/**
 * Composable read scope, so snapshot reads use the same live grants as search.
 *
 * A union of one indexed leg per grant — owned (`radars_owner_idx`), shared
 * directly (`radar_members_user_idx`), reached through a cascading topic
 * (`topic_members_user_idx`, then `radars_topic_idx`) — rather than one scan of
 * `radars` with an OR across three outer joins, which no index can drive: every
 * search, widget, smart radar and notification list read every radar in the
 * database to find the caller's handful. The union is the same set, since the OR
 * was exactly "any of the three legs". `userId` may be a correlated column (the
 * notification sweep passes one); each leg compares against it the same way.
 */
export function unfencedReadableRadarQuery(userId: string | SQL, db: AccessDb = getDb()) {
  // Each leg carries the organization term for its own kind of grant (`orgAllows`).
  return db
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .where(
      and(
        eq(schema.radars.ownerId, userId),
        orgAllows(schema.radars.organizationId, userId, 'owner'),
      ),
    )
    .union(
      db
        .select({ id: schema.radarMembers.radarId })
        .from(schema.radarMembers)
        .innerJoin(schema.radars, eq(schema.radars.id, schema.radarMembers.radarId))
        .where(
          and(
            eq(schema.radarMembers.userId, userId),
            orgAllows(schema.radars.organizationId, userId, 'direct'),
          ),
        ),
    )
    .union(
      db
        .select({ id: schema.radars.id })
        .from(schema.topicMembers)
        // Only a cascading topic can widen anything, so the join carries the flag.
        .innerJoin(
          schema.topics,
          and(eq(schema.topics.id, schema.topicMembers.topicId), eq(schema.topics.cascade, true)),
        )
        // A topic grants only the radars its own owner owns (`setRadarTopic`'s
        // invariant, enforced again here for placements that predate it), and only
        // within its own organization: a cascade never crosses one.
        .innerJoin(
          schema.radars,
          and(
            eq(schema.radars.topicId, schema.topics.id),
            eq(schema.radars.ownerId, schema.topics.ownerId),
            eq(schema.radars.organizationId, schema.topics.organizationId),
          ),
        )
        .where(
          and(
            eq(schema.topicMembers.userId, userId),
            orgAllows(schema.radars.organizationId, userId, 'cascade'),
          ),
        ),
    );
}

export function readableRadarQuery(userId: string | SQL, db: AccessDb = getDb()) {
  return db
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .where(
      and(
        inArray(schema.radars.id, unfencedReadableRadarQuery(userId, db)),
        sql`omr_account_open(${schema.radars.ownerId})`,
        sql`omr_account_open(${userId}::uuid)`,
      ),
    );
}

export async function readableRadarIds(userId: string, db: AccessDb = getDb()): Promise<string[]> {
  return (await readableRadarQuery(userId, db)).map((row) => row.id);
}

/**
 * Topic snapshots require a current ownership or membership grant too. A union
 * of the two indexed legs, for the reason `readableRadarQuery` gives.
 */
export function unfencedReadableTopicQuery(userId: string | SQL | Column, db: AccessDb = getDb()) {
  return db
    .select({ id: schema.topics.id })
    .from(schema.topics)
    .where(
      and(
        eq(schema.topics.ownerId, userId),
        orgAllows(schema.topics.organizationId, userId, 'owner'),
      ),
    )
    .union(
      db
        .select({ id: schema.topicMembers.topicId })
        .from(schema.topicMembers)
        .innerJoin(schema.topics, eq(schema.topics.id, schema.topicMembers.topicId))
        .where(
          and(
            eq(schema.topicMembers.userId, userId),
            orgAllows(schema.topics.organizationId, userId, 'direct'),
          ),
        ),
    );
}

/** Which of these people can read this topic right now: owner or member, as their organization honours. */
export async function topicReaders(
  topicId: string,
  userIds: readonly string[],
  db: AccessDb = getDb(),
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, [...userIds]),
        sql`${topicId}::uuid IN (${unfencedReadableTopicQuery(schema.users.id, db)})`,
      ),
    );
  return new Set(rows.map((row) => row.id));
}

export function readableTopicQuery(userId: string | SQL, db: AccessDb = getDb()) {
  return db
    .select({ id: schema.topics.id })
    .from(schema.topics)
    .where(
      and(
        inArray(schema.topics.id, unfencedReadableTopicQuery(userId, db)),
        sql`omr_account_open(${schema.topics.ownerId})`,
        sql`omr_account_open(${userId}::uuid)`,
      ),
    );
}

/** An account that can currently read a radar. Never carries a role — see below. */
export interface RadarReader {
  id: string;
  name: string | null;
  email: string;
}

/**
 * Every active account that can currently read a radar: its owner, everyone
 * holding a direct grant, and — only when the topic **cascades** — that topic's
 * members.
 *
 * This is the people-shaped counterpart to `readableRadarIds`, and the two have
 * to agree: one asks "which radars can this person reach", the other "who can
 * reach this radar", and a divergence between them is the same class of bug as
 * MCP disagreeing with REST, happening inside one service.
 *
 * ## It is the mention candidate list, and that is what makes mentions safe
 *
 * A mention resolves against exactly this set. So there is no code path in which
 * addressing somebody hands them anything — the parser can only ever name people
 * `requireRadar` would already let in. A handle naming anybody else does not
 * resolve, and an unresolved handle is plain text.
 *
 * The consequence worth stating out loud, because the product owner's ask said "shared on
 * the radar **or on its topic**": a member of a **non-cascading** topic is not a
 * candidate. They hold the grouping and no radar at all, so offering them would
 * be offering to notify somebody about a conversation they cannot open. The
 * honest reading of the ask is "or on its topic, when that topic actually grants
 * the radar", which is what this returns.
 *
 * ## Why active accounts only
 *
 * A suspended account has had every session revoked, and a pending one has never
 * had access at all. Neither can open the radar, so neither may be addressed and
 * neither may be notified — the same rule the notification audience has always
 * applied, now applied in one place instead of two.
 */
export async function radarReaders(
  radar: RadarRow,
  db: AccessDb = getDb(),
): Promise<RadarReader[]> {
  return readersOfRadars([radar.id], db);
}

/**
 * Every active account that can currently read **any** of these radars.
 *
 * The general form of `radarReaders`, which now delegates to it — so there is
 * one definition of "who can read this" and not two that have to be kept in
 * step. That mattered enough to be worth the refactor: universal search needs
 * the people-shaped answer over a whole readable set to decide who a `from:`
 * filter may legally name, and writing a second query for it is precisely how a
 * search comes to offer a name its own radar list would not.
 *
 * ## The `from:` guarantee, stated as a composition
 *
 * Callers pass `readableRadarIds(me)`. So the people this returns are exactly
 *
 *   { u : ∃ r ∈ readableRadarIds(me), u ∈ radarReaders(r) }
 *
 * — people who share at least one radar with the caller. Naming anybody else is
 * impossible by construction rather than by a check somebody has to remember,
 * and `search.test.ts` asserts that equality against a real database rather than
 * taking this comment's word for it.
 *
 * `radarIds` is *not* re-authorized here. It is the output of `readableRadarIds`
 * or of `resolveRadarScope`, both of which have already decided; re-deciding
 * would be the second authorization path the whole design exists to avoid.
 * Passing an arbitrary list is a programming error, and the only callers are in
 * this file's own neighbourhood.
 */
export async function readersOfRadars(
  radarIds: string[],
  db: AccessDb = getDb(),
): Promise<RadarReader[]> {
  if (radarIds.length === 0) return [];

  const rows = await db
    .selectDistinct({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.radars)
    // Every candidate account against every radar in the set; the predicate
    // below is what keeps a pair. Expressed as a cross join because the tests
    // for "can this person read this radar" reference both sides at once and
    // therefore cannot be an ON clause on `users`.
    .innerJoin(schema.users, sql`true`)
    .leftJoin(
      schema.radarMembers,
      and(
        eq(schema.radarMembers.userId, schema.users.id),
        eq(schema.radarMembers.radarId, schema.radars.id),
      ),
    )
    // Only a cascading topic widens anything, so the flag is in the join rather
    // than the predicate — exactly as in `readableRadarIds`. Without this leg a
    // cascaded member is invisible here while being perfectly able to read the
    // radar, which is how they came to receive no notifications about it at all.
    .leftJoin(
      schema.topics,
      and(
        eq(schema.topics.id, schema.radars.topicId),
        eq(schema.topics.cascade, true),
        eq(schema.topics.ownerId, schema.radars.ownerId),
        eq(schema.topics.organizationId, schema.radars.organizationId),
      ),
    )
    .leftJoin(
      schema.topicMembers,
      and(
        eq(schema.topicMembers.topicId, schema.topics.id),
        eq(schema.topicMembers.userId, schema.users.id),
      ),
    )
    .where(
      and(
        inArray(schema.radars.id, radarIds),
        eq(schema.users.state, 'active'),
        sql`omr_account_open(${schema.users.id})`,
        sql`omr_account_open(${schema.radars.ownerId})`,
        // Each kind of grant, weighed by the organization term for that kind.
        or(
          and(
            eq(schema.users.id, schema.radars.ownerId),
            orgAllows(schema.radars.organizationId, schema.users.id, 'owner'),
          ),
          and(
            sql`${schema.radarMembers.userId} IS NOT NULL`,
            orgAllows(schema.radars.organizationId, schema.users.id, 'direct'),
          ),
          and(
            sql`${schema.topicMembers.userId} IS NOT NULL`,
            orgAllows(schema.radars.organizationId, schema.users.id, 'cascade'),
          ),
        ),
      ),
    )
    // A fixed order: callers go on to lock or write one row per reader (notification
    // rows, counters), and two fan-outs that visit the same readers in different orders
    // are how deadlocks happen.
    .orderBy(schema.users.id);
  return rows;
}

/* ================================= topics ================================= */

export interface TopicAccess {
  topic: TopicRow;
  role: TopicRole | 'owner' | null;
  canRead: boolean;
  /**
   * True for an owner or an `editor`. At the topic level this grants nothing
   * extra today — every mutating operation on a topic needs `manage` — so its
   * whole meaning is what it cascades to: an `editor` member of a cascading
   * topic reaches its radars as an editor rather than a viewer.
   */
  canWrite: boolean;
  /** Owner only. Renaming, sharing, assigning radars and the cascade switch. */
  canManage: boolean;
  /** The connection's cap, already applied to the two booleans above. */
  ceiling: RadarRole;
}

/**
 * The same union-then-clamp as a radar, with one difference worth stating.
 *
 * `role` is a `TopicRole` and the ceiling is a `RadarRole`; there is no honest
 * mapping between them, and inventing one would give the two vocabularies a
 * second place to disagree. So the ceiling caps the *capabilities* and leaves
 * `role` as the fact it is. Nothing derives a capability from `TopicAccess.role`
 * outside this function, and `getRadarAccess` reads `topic_members` directly
 * rather than going through here — so the cascade is unaffected either way.
 */
function decideTopic(
  topic: TopicRow,
  role: TopicRole | 'owner' | null,
  ceiling: RadarRole,
): TopicAccess {
  return {
    topic,
    role,
    ceiling,
    canRead: role !== null,
    canWrite:
      roleAtLeast(ceiling, 'editor') &&
      (role === 'owner' || (role !== null && topicRoleAtLeast(role, 'editor'))),
    canManage: roleAtLeast(ceiling, 'owner') && role === 'owner',
  };
}

async function loadTopic(
  idOrSlug: string,
  userId: string | null,
  ceiling: RadarRole,
  db: AccessDb,
): Promise<TopicAccess | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const me = userId ?? NOBODY;

  const rows = await db
    .select({
      topic: schema.topics,
      memberRole: schema.topicMembers.role,
      orgKind: schema.organizations.kind,
      orgRole: schema.memberships.role,
    })
    .from(schema.topics)
    .leftJoin(
      schema.topicMembers,
      and(eq(schema.topicMembers.topicId, schema.topics.id), eq(schema.topicMembers.userId, me)),
    )
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.topics.organizationId))
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.orgId, schema.topics.organizationId),
        eq(schema.memberships.userId, me),
        isNull(schema.memberships.deactivatedAt),
      ),
    )
    .where(
      isUuid
        ? eq(schema.topics.id, idOrSlug)
        : // An array slug is owner-scoped, so resolving one by name is only ever
          // meaningful for the person who owns it.
          and(eq(schema.topics.slug, idOrSlug), eq(schema.topics.ownerId, me)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const open = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, row.topic.ownerId),
        sql`omr_account_open(${schema.users.id})`,
        sql`omr_account_open(${me}::uuid)`,
      ),
    )
    .limit(1);
  if (!open.length) return null;
  // The organization term, for the topic's own organization (see `orgStanding`).
  const org = orgStanding(row.orgKind ?? null, row.orgRole ?? null);
  const role: TopicRole | 'owner' | null =
    userId && row.topic.ownerId === userId
      ? orgHonours(org, 'owner')
        ? 'owner'
        : null
      : orgHonours(org, 'direct')
        ? (row.memberRole ?? null)
        : null;
  // Null when the caller may not read it, for the reason `computeRadarAccess` gives.
  return role === null ? null : decideTopic(row.topic, role, ceiling);
}

export async function getTopicAccess(
  idOrSlug: string,
  actor: Actor | null,
  db: AccessDb = getDb(),
): Promise<TopicAccess | null> {
  // A topic holds radars the agent was not given; its name and members are theirs to hide.
  if (await topicsWithheld(actor, db)) return null;
  return loadTopic(idOrSlug, actor?.user.id ?? null, ceilingOf(actor), db);
}

/**
 * Loads a topic and asserts the access level, or throws.
 *
 * A topic the caller cannot read is a 404, exactly like a radar — a 403 would
 * confirm the id exists, and a topic's existence is as much a disclosure as a
 * radar's. There is no public-link equivalent: topics are never published.
 */
export async function requireTopic(
  idOrSlug: string,
  actor: Actor | null,
  need: AccessNeed = 'read',
  db: AccessDb = getDb(),
): Promise<TopicAccess> {
  const access = await getTopicAccess(idOrSlug, actor, db);
  if (!access) throw notFound('Array not found');
  assertScope(access.ceiling, need, actor);
  if (need === 'write' && !access.canWrite)
    throw forbidden('You have read-only access to this array');
  if (need === 'manage' && !access.canManage) throw forbidden('Only the array owner can do that');
  return access;
}

/**
 * Radars in a topic that this person reaches *only* through the topic — no
 * ownership, no membership row of their own.
 *
 * This is the set that disappears when their topic grant is revoked or the
 * cascade is switched off, and therefore the set whose notifications have to be
 * swept: a notification carries a snapshot excerpt of the content, so leaving
 * one behind hands somebody a readable copy of a conversation they can no
 * longer open. Same rule as `removeMember` on a radar, and the same rule as
 * suspension revoking every session immediately.
 */
export async function radarsReachableOnlyViaTopic(
  topicId: string,
  userId: string,
  db: AccessDb = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .leftJoin(
      schema.radarMembers,
      and(
        eq(schema.radarMembers.radarId, schema.radars.id),
        eq(schema.radarMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.radars.topicId, topicId),
        sql`${schema.radars.ownerId} <> ${userId}`,
        sql`${schema.radarMembers.userId} IS NULL`,
      ),
    );
  return rows.map((r) => r.id);
}

/* ------------------------------ the Agent Repo ----------------------------- */

export type RepoAgentRow = typeof schema.repoAgents.$inferSelect;
export type PromptLevel = 'view' | 'edit';
export type MemoryLevel = 'none' | 'view' | 'edit';

export interface RepoAgentAccess {
  agent: RepoAgentRow;
  /** The caller owns it. */
  owner: boolean;
  /** How it reached a non-owner: a share to them, or to a topic they are in. */
  via: 'owner' | 'user' | 'topic';
  /** Both axes already clamped by the connection. */
  prompt: PromptLevel;
  memory: MemoryLevel;
  ceiling: RadarRole;
  /** Owner-only acts, and only on a connection allowed to manage. */
  canManage: boolean;
  /** A recipient's pin: null for the owner, and for a share not accepted yet. */
  recipient: { acceptedVersion: number; followUpdates: boolean } | null;
}

/** What a caller needs of an agent. */
export type AgentNeed = 'read' | 'prompt' | 'memory-read' | 'memory' | 'manage';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_RANK: Record<PromptLevel, number> = { view: 1, edit: 2 };
const MEMORY_RANK: Record<MemoryLevel, number> = { none: 0, view: 1, edit: 2 };

/**
 * The shares that reach a person, for any agent: to them directly, or to a topic
 * they are a member or the owner of. Computed at access time and never written
 * per person — removing someone from a topic removes the agent in the same
 * moment (the topic-cascade argument, DESIGN §17). `agentShares` is the only
 * grant; `agentRecipients` is a pin, never a grant.
 */
function sharesReaching(userId: string | SQL) {
  const s = schema.agentShares;
  return or(
    and(eq(s.subjectType, 'user'), sql`${s.subjectId} = ${userId}`),
    // The topics the person reaches, by the one definition of that (organization term included).
    and(eq(s.subjectType, 'topic'), sql`${s.subjectId} IN (${unfencedReadableTopicQuery(userId)})`),
  );
}

/** The ids of every agent a person can reach — own or shared, archived included. */
export function reachableAgentQuery(userId: string, db: AccessDb = getDb()) {
  return db
    .select({ id: schema.repoAgents.id })
    .from(schema.repoAgents)
    .where(
      and(
        sql`omr_account_open(${schema.repoAgents.ownerId})`,
        sql`omr_account_open(${userId}::uuid)`,
        or(
          and(
            eq(schema.repoAgents.ownerId, userId),
            orgAllows(schema.repoAgents.organizationId, userId, 'owner'),
          ),
          // A share counts only as far as the agent's own organization honours it: a person
          // it was shared to, or a topic's members, and never a guest by way of a topic.
          sql`${schema.repoAgents.id} IN (SELECT ${schema.agentShares.agentId} FROM ${schema.agentShares}
            WHERE ${sharesReaching(userId)}
              AND CASE WHEN ${schema.agentShares.subjectType} = 'user'
                       THEN ${orgAllows(schema.repoAgents.organizationId, userId, 'direct')}
                       ELSE ${orgAllows(schema.repoAgents.organizationId, userId, 'cascade')} END)`,
        ),
      ),
    );
}

/**
 * The union of a person's grants on one agent, per axis, then the connection's
 * clamp. Shared with the list (`listRepoAgents`), which computes the same union
 * in SQL and hands each row to this function, so the list and the lookup
 * cannot disagree — the second-union trap scopes found by sabotage.
 */
export function decideAgentAccess(
  agent: RepoAgentRow,
  userId: string,
  shares: ReadonlyArray<{
    subjectType: 'user' | 'topic';
    promptAccess: PromptLevel;
    memoryAccess: MemoryLevel;
  }>,
  recipient: { acceptedVersion: number; followUpdates: boolean } | null,
  ceiling: RadarRole,
  /** Where the caller stands in the agent's organization. */
  org: OrgStanding,
): Omit<RepoAgentAccess, 'agent'> | null {
  let prompt: PromptLevel | null = null;
  let memory: MemoryLevel = 'none';
  let via: RepoAgentAccess['via'] = 'user';
  if (agent.ownerId === userId) {
    if (!orgHonours(org, 'owner')) return null;
    prompt = 'edit';
    memory = 'edit';
    via = 'owner';
  } else {
    // The organization term, per share: a share to a person is a direct grant, a share to
    // a topic reaches its members the way a cascade does.
    const reached = shares.filter((share) =>
      orgHonours(org, share.subjectType === 'user' ? 'direct' : 'cascade'),
    );
    for (const share of reached) {
      if (prompt === null || PROMPT_RANK[share.promptAccess] > PROMPT_RANK[prompt])
        prompt = share.promptAccess;
      if (MEMORY_RANK[share.memoryAccess] > MEMORY_RANK[memory]) memory = share.memoryAccess;
      if (share.subjectType === 'user') via = 'user';
      else if (via !== 'user') via = 'topic';
    }
    if (prompt === null) return null;
    if (reached.every((sh) => sh.subjectType === 'topic')) via = 'topic';
  }
  // The clamp, and nothing else: a read-only connection can read at most, and
  // only a manage connection may do the owner's acts.
  if (!roleAtLeast(ceiling, 'editor')) {
    prompt = 'view';
    if (memory === 'edit') memory = 'view';
  }
  return {
    owner: via === 'owner',
    via,
    prompt,
    memory,
    ceiling,
    canManage: via === 'owner' && ceiling === 'owner',
    recipient: via === 'owner' ? null : recipient,
  };
}

/**
 * An agent, by id, by the caller's own slug, or — for one shared with them —
 * by `owner-email/slug`. A bare slug resolves only among the caller's own
 * agents: a share needs no consent from the person shared with, so letting a
 * bare slug fall through to shares would let anybody who knows your address
 * put an agent under a name you type.
 */
export async function getRepoAgentAccess(
  idOrSlug: string,
  actor: Actor | null,
  db: AccessDb = getDb(),
): Promise<RepoAgentAccess | null> {
  if (!actor) return null;
  const userId = actor.user.id;
  const shared = UUID_PATTERN.test(idOrSlug) ? null : parseSharedAgentRef(idOrSlug);
  const where = UUID_PATTERN.test(idOrSlug)
    ? eq(schema.repoAgents.id, idOrSlug)
    : shared
      ? and(
          eq(schema.repoAgents.slug, shared.slug),
          eq(
            schema.repoAgents.ownerId,
            sql`(SELECT ${schema.users.id} FROM ${schema.users} WHERE ${schema.users.email} = ${shared.ownerEmail})`,
          ),
        )
      : and(eq(schema.repoAgents.slug, idOrSlug), eq(schema.repoAgents.ownerId, userId));
  const [agent] = await db
    .select()
    .from(schema.repoAgents)
    .where(
      and(
        where,
        sql`omr_account_open(${schema.repoAgents.ownerId})`,
        sql`omr_account_open(${userId}::uuid)`,
      ),
    )
    .limit(1);
  if (!agent) return null;
  const shares =
    agent.ownerId === userId
      ? []
      : await db
          .select({
            subjectType: schema.agentShares.subjectType,
            promptAccess: schema.agentShares.promptAccess,
            memoryAccess: schema.agentShares.memoryAccess,
          })
          .from(schema.agentShares)
          .where(and(eq(schema.agentShares.agentId, agent.id), sharesReaching(userId)));
  const [recipient] =
    agent.ownerId === userId
      ? []
      : await db
          .select({
            acceptedVersion: schema.agentRecipients.acceptedVersion,
            followUpdates: schema.agentRecipients.followUpdates,
          })
          .from(schema.agentRecipients)
          .where(
            and(
              eq(schema.agentRecipients.agentId, agent.id),
              eq(schema.agentRecipients.userId, userId),
            ),
          )
          .limit(1);
  const org = (await orgStandings(userId, [agent.organizationId], db)).get(agent.organizationId);
  const decided = decideAgentAccess(
    agent,
    userId,
    shares,
    recipient ?? null,
    ceilingOf(actor),
    org ?? 'outsider',
  );
  return decided ? { agent, ...decided } : null;
}

/**
 * Why a bare slug found nothing, when the answer is "it is shared with you
 * under someone else's name". Only agents the caller can already reach are
 * named, so this discloses nothing.
 */
async function missingRepoAgent(
  idOrSlug: string,
  actor: Actor | null,
  db: AccessDb,
): Promise<string> {
  const plain = 'Agent not found';
  if (!actor || UUID_PATTERN.test(idOrSlug) || parseSharedAgentRef(idOrSlug)) return plain;
  const rows = await db
    .select({ email: schema.users.email })
    .from(schema.repoAgents)
    .innerJoin(schema.users, eq(schema.users.id, schema.repoAgents.ownerId))
    .where(
      and(
        eq(schema.repoAgents.slug, idOrSlug),
        // Only an agent the caller can reach is named, so the organization term applies here too.
        inArray(schema.repoAgents.id, reachableAgentQuery(actor.user.id, db)),
        sql`${schema.repoAgents.ownerId} <> ${actor.user.id}`,
      ),
    )
    .limit(5);
  if (rows.length === 0) return plain;
  const refs = rows.map((row) => sharedAgentRef(row.email, idOrSlug));
  return `You have no agent called '${idOrSlug}'. Shared with you: ${refs.join(', ')} — name it that way, or by its id.`;
}

const AGENT_NEED_SCOPE: Record<AgentNeed, AccessNeed> = {
  read: 'read',
  'memory-read': 'read',
  prompt: 'write',
  memory: 'write',
  manage: 'manage',
};

/**
 * Loads an agent and asserts what the caller needs of it, or throws. Not found
 * and not permitted-to-see are both 404: an agent id is as much a disclosure as
 * a radar id. The scope refusal comes before the permission refusal, for the
 * reason `requireRadar` gives.
 */
export async function requireRepoAgent(
  idOrSlug: string,
  actor: Actor | null,
  need: AgentNeed = 'read',
  db: AccessDb = getDb(),
): Promise<RepoAgentAccess> {
  const access = await getRepoAgentAccess(idOrSlug, actor, db);
  if (!access) throw notFound(await missingRepoAgent(idOrSlug, actor, db));
  assertScope(access.ceiling, AGENT_NEED_SCOPE[need], actor);
  switch (need) {
    case 'prompt':
      if (access.prompt !== 'edit')
        throw forbidden('You can use this agent but not change its prompt or tool profiles.');
      break;
    case 'memory-read':
      if (access.memory === 'none')
        throw forbidden(
          'This agent’s memory is not shared with you. You can run it with its prompt only.',
        );
      break;
    case 'memory':
      if (access.memory !== 'edit')
        throw forbidden(
          access.memory === 'none'
            ? 'This agent’s memory is not shared with you.'
            : 'You can read this agent’s memory but not change it.',
        );
      break;
    case 'manage':
      if (!access.canManage) throw forbidden('Only the agent’s owner can do that.');
      break;
    case 'read':
      break;
  }
  return access;
}

/** Guest proof exists only inside the support service; never resolved by auth middleware. */
declare const guestSupportBrand: unique symbol;
export interface GuestSupportAccess {
  readonly access: RadarAccess;
  readonly actor: Actor & { kind: 'guest' };
  readonly [guestSupportBrand]: true;
}
export async function requireGuestSupportQueue(
  db: AccessDb = getDb(),
): Promise<GuestSupportAccess> {
  const config = env();
  const unavailable = () =>
    new ApiError(
      503,
      'support_unavailable',
      'Support intake is temporarily unavailable. Keep your text and try again.',
    );
  if (!config.SUPPORT_RADAR_ID || !config.SUPPORT_OWNER_ID) throw unavailable();
  const [found] = await db
    .select({ radar: schema.radars, owner: schema.users })
    .from(schema.radars)
    .innerJoin(schema.users, eq(schema.users.id, schema.radars.ownerId))
    .where(
      and(
        eq(schema.radars.id, config.SUPPORT_RADAR_ID),
        eq(schema.radars.ownerId, config.SUPPORT_OWNER_ID),
        eq(schema.users.state, 'active'),
        sql`omr_account_open(${schema.users.id})`,
        sql`omr_account_open(${schema.radars.ownerId})`,
        eq(schema.users.isAdmin, true),
        eq(schema.radars.visibility, 'private'),
        eq(schema.radars.template, 'helpdesk'),
        eq(schema.radars.kind, 'standard'),
        // The queue is the operator's. Capture-only and deliberately open to people outside
        // any organization, but not once its owner has left the organization it lives in.
        orgAllows(schema.radars.organizationId, schema.radars.ownerId, 'owner'),
      ),
    )
    .for('share');
  if (!found) throw unavailable();
  return {
    actor: { kind: 'guest', user: found.owner },
    access: {
      radar: found.radar,
      role: null,
      directRole: null,
      topicRole: null,
      via: null,
      viaPublicLink: false,
      topic: null,
      topicVisible: false,
      ceiling: 'owner',
      canRead: false,
      canWrite: true,
      canManage: false,
    },
  } as GuestSupportAccess;
}

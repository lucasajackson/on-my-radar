/**
 * Bearer-token authentication for agents.
 *
 * Two token families reach the same place. Personal access tokens (`omr_pat_…`)
 * are pasted into a local agent's config; OAuth access tokens are minted by this
 * app's own authorization server for remote MCP clients. Both resolve to a real
 * user and inherit *at most* that user's permissions — an agent can never see or
 * do more than the person who connected it.
 *
 * ## The scope is a ceiling, and it is resolved here
 *
 * Each family carries a scope string; this file turns it into the `RadarRole`
 * ceiling the actor acts under, and `services/access.ts` applies it as a `min`
 * over the access its human already has.
 *
 * The two families answer "what was consented to" differently, and the
 * difference is deliberate — `drizzle/0014_token_scopes.sql` carries the long
 * version:
 *
 * - **A PAT's scope is enforceable from the moment 0014 ran.** Every existing
 *   row was backfilled to the three ordinary radar scopes, because that is what a PAT has always
 *   been able to do. Nothing narrows silently.
 * - **An OAuth grant's scope is enforceable only when `scope_consented`.** A
 *   grant made before this landed carries a string that was never displayed to
 *   anybody and never enforced; treating it as a limit now would withdraw
 *   `radars:manage` from live connections on the strength of a number the user
 *   never saw. Those grants act at the full ceiling until the client
 *   re-authorizes, at which point the consent screen names the scopes and the
 *   flag goes true.
 *
 * A token whose scope string names nothing this server grants is not a valid
 * token: it authenticates nobody rather than authenticating at some floor.
 *
 * ## State first, then scope
 *
 * Both queries require `users.state = 'active'`. A token belonging to a
 * suspended or never-approved account **does not resolve at all** — it is not an
 * actor with a small ceiling, it is not an actor.
 *
 * The ordering is the point. A scope check on a token belonging to a suspended
 * account is enforcement layered on a principal that should not have
 * authenticated, and every route would have to remember to ask. This is the same
 * rule suspension has always applied to sessions, reached a different way:
 * `revokeAllSessions` deletes session rows, which cannot work here because a PAT
 * has to survive an unsuspension — the human deliberately connected that agent,
 * and making them reconnect every one after a lapse is worse than the
 * alternative. So the state is read **fresh on every request**, exactly as
 * `mayBypassWaitlist` reads the admin bit, and suspension takes effect on the
 * next call rather than on the next token expiry.
 *
 * Before this, suspending an account killed its browser sessions immediately and
 * left its PAT and OAuth tokens working indefinitely — and two routes
 * (`/api/blips/:id/comments`, `/api/attachments/:id`) take the actor without
 * going through `requireActor`, so nothing downstream caught it either.
 */
import { and, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  ceilingFor,
  parseScopes,
  parseVoiceGrants,
  DEFAULT_TOKEN_SCOPES,
  type RadarRole,
  type TokenScope,
  type Voice,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { API_TOKEN_PREFIX, hashSecret } from './crypto.js';
import type { Actor, ActorAgent, ActorConnection } from '../http.js';
import type { UserRow } from './accounts.js';
import { orgHonours, orgStanding, type OrgStanding } from '../services/access.js';

export interface BearerActor {
  user: UserRow;
  tokenId: string;
  /** What this token was granted, canonicalised and filtered to what we grant. */
  scopes: readonly TokenScope[];
  /** The strongest role `scopes` confers. Never null — see `withScopes`. */
  ceiling: RadarRole;
  /** The persona this connection speaks as, when it carries one. */
  agent?: ActorAgent;
  /** Present exactly when `agent` is. */
  voice?: { granted: readonly Voice[]; default: Voice };
  /** Set when the token's agent was archived or deleted: reads only, see `personaOf`. */
  retiredAgent?: string;
  /**
   * The agent the credential was minted for, whatever its state. Its radar scope binds the
   * connection even while it is archived or its owner has lost the org it needs: a retired
   * agent's token is narrowed to `viewer`, never widened to every radar.
   */
  radarFence?: readonly string[];
  /**
   * The stable identity of the connection, as opposed to the credential row.
   * A PAT is its own id; an OAuth grant is its client id, because the
   * access-token row rotates on every refresh and anything keyed on it would
   * die within the hour (DESIGN §24). Agent Repo load sessions bind to this.
   */
  connection: ActorConnection;
}

/**
 * A row from `agents`, as joined beside a token.
 *
 * Left-joined, so every field is nullable: most tokens carry no persona, and a
 * token whose persona was retired or deleted still authenticates.
 */
interface JoinedAgent {
  id: string | null;
  ownerId: string | null;
  name: string | null;
  handle: string | null;
  retiredAt: Date | null;
  /** Where the token's human stands in the agent's organization (`orgStanding`). */
  org: OrgStanding;
}

/**
 * The persona half of a resolved token, and the one rule that governs it:
 * **no agent means no voice at all.**
 *
 * That rule is what makes this migration behaviourally invisible. Every token
 * issued before personas existed carries `agent_id IS NULL`, so it resolves with
 * no `agent` and no `voice`, so `authorshipOf` writes `agent_id = NULL,
 * agent_voice = NULL` — byte for byte what it already wrote. There is no
 * "legacy grant" to reason about, because a voice with nothing to speak as is
 * not a grant, it is a category error.
 *
 * A retired persona is the opposite case: a token minted for an agent that has
 * since been archived must stop WRITING, not quietly carry on as the human
 * (which is what returning `{}` did — every write landed under the person's own
 * name, from a credential the person had only ever handed to that agent). The
 * connection still authenticates, so reads keep working and every refusal can
 * say why; `retiredAgent` caps its ceiling at `viewer` (`withScopes`).
 *
 * `null` here means "this credential is corrupt, do not authenticate it": a
 * token naming an agent that belongs to somebody else. That cannot happen
 * through any mint path in this application, which is exactly why it is worth
 * refusing rather than silently ignoring — if it ever appears, something wrote
 * a principal into a credential and the safe answer is that nobody is holding it.
 */
function personaOf(
  user: UserRow,
  agent: JoinedAgent | null,
  grants: { granted: readonly Voice[]; default: Voice } | null,
  bound = false,
): {
  agent?: ActorAgent;
  voice?: { granted: readonly Voice[]; default: Voice };
  retiredAgent?: string;
} | null {
  // `agent_id` is nulled when its agent is deleted; `agent_bound` is the durable
  // fact that this credential was minted for one, so it stays restricted.
  if (!agent?.id || !agent.ownerId)
    return bound ? { retiredAgent: 'an agent that has since been deleted' } : {};
  if (agent.ownerId !== user.id) return null;
  // An owner who has lost the membership a team-org agent needs no longer holds it, and
  // neither does a credential minted for it: the persona is withdrawn the way an archived
  // one is, and the connection reads as the person with no voice to write in.
  if (!orgHonours(agent.org, 'owner'))
    return {
      retiredAgent: `"${agent.name ?? 'an agent'}", which your organization no longer lets you run`,
    };
  if (agent.retiredAt !== null)
    return { retiredAgent: `"${agent.name ?? 'an agent'}", which has been archived` };
  // Belt and braces over the CHECK: `default_voice = ANY (voice_grants)` is
  // enforced by the database for PATs, and derived for OAuth. A default outside
  // its own grant would be a voice nobody consented to, so it collapses to the
  // narrower of the two rather than being trusted.
  const granted = grants?.granted.length ? grants.granted : (['principal'] as const);
  const fallback: Voice = 'principal';
  const preferred = grants?.default ?? fallback;
  return {
    agent: {
      agentId: agent.id,
      ownerId: agent.ownerId,
      name: agent.name ?? 'Agent',
      handle: agent.handle ?? 'agent',
    },
    voice: {
      granted,
      default: granted.includes(preferred) ? preferred : (granted[0] as Voice),
    },
  };
}

/**
 * Attach a resolved ceiling, or refuse the token.
 *
 * A scope string that survives parsing as the empty set means the holder asked
 * for nothing this server grants. Handing that back as an actor with a floor of
 * `viewer` would be inventing a grant nobody made, so the token simply does not
 * authenticate.
 */
function withScopes(
  user: UserRow,
  tokenId: string,
  scopes: readonly TokenScope[],
  persona: {
    agent?: ActorAgent;
    voice?: { granted: readonly Voice[]; default: Voice };
    retiredAgent?: string;
  } | null,
  connection: ActorConnection,
): BearerActor | null {
  const granted = ceilingFor(scopes);
  if (granted === null) return null;
  // A credential naming somebody else's persona is not a smaller actor; it is
  // not an actor. Same shape as an empty scope set above.
  if (persona === null) return null;
  // Read-only while its agent is archived.
  const ceiling: RadarRole = persona.retiredAgent ? 'viewer' : granted;
  return { user, tokenId, scopes, ceiling, ...persona, connection };
}

/**
 * The agents whose radar scope binds this connection: the one its credential was minted for,
 * and every agent this credential has ever loaded (`connection_agent_fences`, written by
 * `load_agent`). Whether a given agent is limited is read live, in `fenceCaps`.
 *
 * A credential that loaded a limited agent stays limited for its life, reads and writes alike,
 * because a read carries no agent and the credential is all there is to bind. The record is
 * the credential's, not the load session's: that idles out and is deleted when an agent is
 * revoked, and neither may widen anything. It lifts only when the owner sets the agent to
 * `all`. The hard guarantee is for credentials minted for the agent: a person's own sign-in
 * can skip `load_agent` and read what they can read, which is their access and not the agent's.
 */
async function fencedBy(agentId: string | null | undefined, actor: BearerActor | null) {
  if (!actor) return null;
  const rows = await getDb()
    .select({ agentId: schema.connectionAgentFences.agentId, scope: schema.agents.radarScope })
    .from(schema.connectionAgentFences)
    .leftJoin(schema.agents, eq(schema.agents.id, schema.connectionAgentFences.agentId))
    .where(
      and(
        eq(schema.connectionAgentFences.userId, actor.user.id),
        eq(schema.connectionAgentFences.connectionKind, actor.connection.kind),
        eq(schema.connectionAgentFences.connectionId, actor.connection.id),
      ),
    );
  // Limited by an agent that has since been deleted: the limit can no longer be read, and
  // "no limit" is the wrong answer to that. Refuse the credential.
  if (rows.some((row) => row.agentId === null)) return null;
  const ids = [
    ...new Set([
      ...(agentId ? [agentId] : []),
      ...rows.flatMap((row) => (row.agentId && row.scope === 'selected' ? [row.agentId] : [])),
    ]),
  ];
  return ids.length ? { ...actor, radarFence: ids } : actor;
}

/**
 * `last_used_at` is for a person asking "is this token still in use?", which a minute's
 * precision answers as well as a millisecond's. Writing it on every request made every
 * call by one token an UPDATE of the same row, in the same hot path as the authentication.
 */
const LAST_USED_RESOLUTION_MS = 60_000;
const staleUse = (last: Date | null, now: Date) =>
  last === null || now.getTime() - last.getTime() > LAST_USED_RESOLUTION_MS;
const staleBefore = (now: Date) => new Date(now.getTime() - LAST_USED_RESOLUTION_MS);

export async function resolveBearerToken(token: string): Promise<BearerActor | null> {
  return token.startsWith(API_TOKEN_PREFIX)
    ? resolveApiToken(eq(schema.apiTokens.tokenHash, hashSecret(token)))
    : resolveOAuthAccessToken(eq(schema.oauthTokens.accessTokenHash, hashSecret(token)));
}

/** Recheck a previously authenticated bearer after an awaited bounded read, using the same live predicates. */
export async function refreshBearerActor(actor: Actor): Promise<BearerActor | null> {
  if (!actor.tokenId || !actor.connection) return null;
  if (actor.connection.kind === 'pat') {
    if (actor.connection.id !== actor.tokenId) return null;
    return resolveApiToken(
      sql`${schema.apiTokens.id} = ${actor.tokenId} AND ${schema.apiTokens.userId} = ${actor.user.id}`,
    );
  }
  return resolveOAuthAccessToken(
    sql`${schema.oauthTokens.id} = ${actor.tokenId} AND ${schema.oauthTokens.userId} = ${actor.user.id} AND ${schema.oauthTokens.clientId} = ${actor.connection.id}`,
  );
}

async function resolveApiToken(match: SQL): Promise<BearerActor | null> {
  const now = new Date();
  const rows = await getDb()
    .select({
      token: schema.apiTokens,
      user: schema.users,
      agent: {
        id: schema.agents.id,
        ownerId: schema.agents.ownerId,
        name: schema.agents.name,
        handle: schema.agents.slug,
        retiredAt: schema.agents.archivedAt,
      },
      orgKind: schema.organizations.kind,
      orgRole: schema.memberships.role,
    })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    // Left, not inner: a token with no persona is the common case and a token
    // whose persona was retired must keep authenticating.
    .leftJoin(schema.agents, eq(schema.agents.id, schema.apiTokens.agentId))
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.agents.organizationId))
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.orgId, schema.agents.organizationId),
        eq(schema.memberships.userId, schema.apiTokens.userId),
        isNull(schema.memberships.deactivatedAt),
      ),
    )
    .where(
      and(
        match,
        isNull(schema.apiTokens.revokedAt),
        or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now)),
        // State first. A suspended account's agent is not a smaller actor, it is
        // not an actor — and this is the only place that can be true for every
        // route at once.
        eq(schema.users.state, 'active'),
        sql`omr_account_open(${schema.users.id})`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (staleUse(row.token.lastUsedAt, now))
    void getDb()
      .update(schema.apiTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(schema.apiTokens.id, row.token.id),
          or(
            isNull(schema.apiTokens.lastUsedAt),
            lt(schema.apiTokens.lastUsedAt, staleBefore(now)),
          ),
        ),
      )
      .catch(() => undefined);

  const resolved = withScopes(
    row.user,
    row.token.id,
    parseScopes(row.token.scope),
    personaOf(
      row.user,
      row.agent
        ? { ...row.agent, org: orgStanding(row.orgKind ?? null, row.orgRole ?? null) }
        : null,
      {
        granted: row.token.voiceGrants,
        default: row.token.defaultVoice,
      },
      row.token.agentBound,
    ),
    { kind: 'pat', id: row.token.id, label: row.token.name },
  );
  return await fencedBy(row.agent?.id, resolved);
}

async function resolveOAuthAccessToken(match: SQL): Promise<BearerActor | null> {
  const now = new Date();
  const rows = await getDb()
    .select({
      token: schema.oauthTokens,
      clientName: schema.oauthClients.clientName,
      user: schema.users,
      agent: {
        id: schema.agents.id,
        ownerId: schema.agents.ownerId,
        name: schema.agents.name,
        handle: schema.agents.slug,
        retiredAt: schema.agents.archivedAt,
      },
      orgKind: schema.organizations.kind,
      orgRole: schema.memberships.role,
    })
    .from(schema.oauthTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.oauthTokens.userId))
    .leftJoin(schema.agents, eq(schema.agents.id, schema.oauthTokens.agentId))
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.agents.organizationId))
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.orgId, schema.agents.organizationId),
        eq(schema.memberships.userId, schema.oauthTokens.userId),
        isNull(schema.memberships.deactivatedAt),
      ),
    )
    .leftJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthTokens.clientId))
    .where(
      and(
        match,
        isNull(schema.oauthTokens.revokedAt),
        gt(schema.oauthTokens.expiresAt, now),
        eq(schema.users.state, 'active'),
        sql`omr_account_open(${schema.users.id})`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (staleUse(row.token.lastUsedAt, now))
    void getDb()
      .update(schema.oauthTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(schema.oauthTokens.id, row.token.id),
          or(
            isNull(schema.oauthTokens.lastUsedAt),
            lt(schema.oauthTokens.lastUsedAt, staleBefore(now)),
          ),
        ),
      )
      .catch(() => undefined);

  // A grant made before scopes were enforced was never shown to anybody, so
  // there is no consent in it to apply. It keeps ordinary radar access only.
  const scopes = row.token.scopeConsented ? parseScopes(row.token.scope) : DEFAULT_TOKEN_SCOPES;
  /*
   * Voices ride `scope` for OAuth because that is already the grant channel and
   * the consent screen already renders it — one string, one screen, one record
   * of what was agreed to.
   *
   * `parseVoiceGrants` answers `null` when the string names no voice at all, and
   * that is read as **principal only** rather than as "both", which is the
   * opposite of what an earlier draft proposed. The reasoning changed because
   * the case it was protecting turned out not to exist: a grant that names no
   * voice also carries no agent (nothing before 0015 could), so it resolves with
   * no persona and the voice is never consulted. What is left is a grant that
   * somehow has an agent and no consented voice, and for that the narrow reading
   * is the only defensible one — a persona nobody named a voice for should not
   * be handed the more consequential of the two.
   */
  const granted: Voice[] = parseVoiceGrants(row.token.scope) ?? ['principal'];
  const resolved = withScopes(
    row.user,
    row.token.id,
    scopes,
    personaOf(
      row.user,
      row.agent
        ? { ...row.agent, org: orgStanding(row.orgKind ?? null, row.orgRole ?? null) }
        : null,
      {
        granted,
        // Own-voice is the default wherever it was granted: speaking as the human
        // is the more consequential mode and should be the one somebody chose.
        default: granted.includes('persona') ? 'persona' : 'principal',
      },
      row.token.agentBound,
    ),
    { kind: 'oauth', id: row.token.clientId, label: row.clientName ?? row.token.clientId },
  );
  return await fencedBy(row.agent?.id, resolved);
}

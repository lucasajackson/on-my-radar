/**
 * Agents as identities — the name an agent writes under, the voice it writes
 * in, and the person who cosigns it.
 *
 * v1 had personas (a name) and Agent Repo agents (a prompt and a memory) as two
 * things; v2 folded them into one (`drizzle/0038`, docs/AGENT_REPO.md §V2.5).
 * Everything the persona design made true still is:
 *
 * ## The voice decides what is rendered, never what is recorded
 *
 * An agent can never act except on behalf of a human, so every agent-borne
 * write already has a human behind it — the **cosigner**, whose connection ran
 * the agent. `author_id` (the cosigner) and `agent_id` (the agent) are both
 * written every time, in both voices; the voice decides only which name leads
 * the byline. A mis-granted voice can put the wrong name in the larger type
 * over a record that is still true, and nothing worse.
 *
 * ## An agent id is never an argument
 *
 * `agent_id` comes from a **server-issued binding** and from nothing else:
 * either the connection's credential (a token minted for the agent, an OAuth
 * grant whose consent named it — `auth/bearer.ts`), or a **load session** the
 * same connection opened with `load_agent` (`writeAsAgent` below). No request
 * body or tool argument names an agent on a write, so a person cannot author
 * under an agent they cannot run, and one connection can still be different
 * agents in different chats. `persona.test.ts` asserts the write sites by grep.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AGENT_REPO, VOICE_BY_AS, type AgentDto, type Voice } from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { badRequest, conflict, forbidden, notFound, type Actor } from '../http.js';
import { getRepoAgentAccess, orgAllows, reachableAgentQuery } from './access.js';
import { SESSION_CONNECTION_REFUSAL } from './agent-memory.js';

export type AgentRow = typeof schema.agents.$inferSelect;

/** An agent as a byline shows it. `owner`/`viewable` are filled where a viewer is known. */
export function agentDto(
  row: AgentRow,
  extra: { owner?: { id: string; name: string | null } | null; viewable?: boolean } = {},
): AgentDto {
  return {
    id: row.id,
    name: row.name,
    handle: row.slug,
    retired: row.archivedAt !== null,
    ...(extra.owner !== undefined ? { owner: extra.owner } : {}),
    ...(extra.viewable !== undefined ? { viewable: extra.viewable } : {}),
  };
}

/** A person's own agents, archived included when asked — the "writes as" lists. */
export async function listAgents(
  actor: Actor,
  options: { includeArchived?: boolean } = {},
): Promise<AgentRow[]> {
  return getDb()
    .select()
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.ownerId, actor.user.id),
        // Owned and still reachable as an owner: a credential cannot be bound to the rest.
        orgAllows(schema.agents.organizationId, actor.user.id, 'owner'),
        options.includeArchived ? undefined : isNull(schema.agents.archivedAt),
      ),
    )
    .orderBy(schema.agents.name);
}

/**
 * Every live agent belonging to any of these people — the read behind the
 * mention directory. Archived ones are excluded here rather than at each call
 * site: an archived agent resolves no handle and receives no notification.
 */
export async function liveAgentsOf(
  ownerIds: string[],
  db: Pick<Db, 'select'> = getDb(),
): Promise<Array<AgentRow & { handle: string }>> {
  if (ownerIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(inArray(schema.agents.ownerId, ownerIds), isNull(schema.agents.archivedAt)));
  return rows.map((row) => ({ ...row, handle: row.slug }));
}

/**
 * The caller's own live agent, or a refusal — used where a credential is bound
 * to an agent (minting a token, approving a consent). Scoped by owner in the
 * query: somebody else's agent is "not found", never "forbidden".
 */
export async function requireOwnLiveAgent(actor: Actor, agentId: string): Promise<AgentRow> {
  // Ownership as `decideAgentAccess` reads it, so an owner who has lost the membership an
  // agent in a team org needs cannot attach a new credential to it.
  const access = await getRepoAgentAccess(agentId, actor);
  if (!access?.owner) throw notFound('Agent not found');
  const row = access.agent;
  if (row.archivedAt !== null) {
    throw conflict(`@${row.slug} is archived and cannot be attached to a new connection.`);
  }
  return row;
}

/**
 * A person at a screen. Not every `kind: 'user'` actor is one: a session token presented as a
 * bearer, or to /mcp, is a credential an agent could hold. Only the signed-in cookie is a person,
 * as for `assertBrowserOwner` (ADR-0031). Gates that are for people (prompts, claims, other
 * agents' comments) all ask this one question.
 */
export function isPersonAtScreen(actor: Actor): boolean {
  return actor.kind === 'user' && actor.viaCookie === true && actor.invocation !== 'mcp';
}

/**
 * The person for writes that are theirs to make (a claim they hold, their own comments): the
 * browser, or the native app's own session token from a human sign-in. Never a PAT, an OAuth grant,
 * a `cli` session or anything on /mcp. S1b's prompt and profile rule stays on `isPersonAtScreen`.
 */
export function isHumanSession(actor: Actor): boolean {
  return (
    isPersonAtScreen(actor) ||
    (actor.kind === 'user' && actor.appSession === true && actor.invocation !== 'mcp')
  );
}

/* ----------------------------- write as an agent ---------------------------- */

/**
 * The actor a write runs as when it names a load session: the same person and
 * connection, now carrying the session's agent.
 *
 * The session is a server-issued binding, checked in full before anything is
 * written — this person, **this connection**, not idle, an agent they can still
 * reach and have accepted, not archived. It is how one claude.ai grant is
 * `architect` in one chat and `merchandiser` in another: identity follows the
 * load, not the credential. Anyone an agent is shared with may write under its
 * name (the owner's decision, §V2.5): the byline always names the cosigner, so
 * nobody can be made to look like they wrote something they did not.
 *
 * No session → the actor unchanged (its credential's agent, if any, else the
 * person). A person in the browser never writes as an agent: a person typing is
 * the person.
 */
export async function writeAsAgent(
  actor: Actor,
  sessionId: string | null | undefined,
): Promise<Actor> {
  if (!sessionId) return actor;
  // A session token presented to /mcp is a connection like a PAT; a person in the browser is not.
  if (actor.kind === 'user' && actor.invocation !== 'mcp') {
    throw badRequest('A session binds an agent’s connection, not a person in the browser.');
  }
  const connection =
    actor.connection ??
    (actor.kind === 'user'
      ? { kind: 'session' as const, id: actor.sessionId ?? 'web', label: 'On My Radar' }
      : undefined);
  const [session] = await getDb()
    .select()
    .from(schema.repoAgentSessions)
    .where(eq(schema.repoAgentSessions.id, sessionId))
    .limit(1);
  if (
    !session ||
    !connection ||
    session.userId !== actor.user.id ||
    session.connectionKind !== connection.kind ||
    session.connectionId !== connection.id
  ) {
    throw badRequest(SESSION_CONNECTION_REFUSAL);
  }
  if (session.lastSeenAt.getTime() < Date.now() - AGENT_REPO.sessionIdleDays * 86_400_000) {
    throw badRequest('That session has expired. Call load_agent again for a fresh one.');
  }
  const access = await getRepoAgentAccess(session.agentId, actor);
  if (!access)
    throw badRequest('The agent that session was opened for is no longer shared with you.');
  if (access.agent.archivedAt) throw conflict(`'${access.agent.slug}' is archived.`);
  if (!access.owner && !access.recipient) {
    throw forbidden(`Accept '${access.agent.slug}' in On My Radar before running it.`);
  }
  void getDb()
    .update(schema.repoAgentSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.repoAgentSessions.id, session.id))
    .catch(() => undefined);
  // The actor is an AGENT actor whatever carried it — a PAT, an OAuth grant, or a session token
  // on /mcp — never the person: `viaCookie` and the web `sessionId` are what mark a human, and
  // every writer that asks "is this a person?" reads them (client replies, claims, ...).
  const {
    viaCookie: _viaCookie,
    appSession: _appSession,
    sessionId: _sessionId,
    ...carried
  } = actor;
  return {
    ...carried,
    kind: 'agent',
    agent: {
      agentId: access.agent.id,
      name: access.agent.name,
      handle: access.agent.slug,
      ownerId: access.agent.ownerId,
    },
    voice: sessionVoice(actor),
    // The limits only accumulate: loading a wider agent must not shed a narrower one's, and
    // the agent the session runs is held to its own radars as well (`access.ts` `fenceCaps`).
    radarFence: [...new Set([...(actor.radarFence ?? []), access.agent.id])],
  };
}

/**
 * The voices a session-bound write may use: both, narrowed to what the
 * connection itself was granted. A connection with no persona of its own has no
 * voice grant to narrow, so a session gives it both — itself or the person —
 * with the agent's own voice as the default, because that is what loading an
 * agent means. One that was minted for a persona carries the range its human
 * granted (`actor.voice.granted`), and a session cannot widen it: an agent-voice
 * only token must not be able to write `as: 'me'` just by loading an agent.
 */
function sessionVoice(actor: Actor): NonNullable<Actor['voice']> {
  const all: readonly Voice[] = ['persona', 'principal'];
  const granted = actor.voice ? all.filter((v) => actor.voice?.granted.includes(v)) : all;
  const usable = granted.length > 0 ? granted : (['principal'] as const);
  return {
    granted: usable,
    default: usable.includes('persona') ? 'persona' : (usable[0] as Voice),
  };
}

/* -------------------------------- the voice ------------------------------ */

/**
 * Which name this write is rendered under, given what the call asked for. A
 * call that asks for nothing gets the connection's default; a call that asks
 * for a voice it was not granted is refused, loudly — never silently
 * downgraded. A browser session has no voice and returns `null`.
 */
export function resolveVoice(actor: Actor, requested?: 'me' | 'agent' | null): Voice | null {
  if (!actor.agent || !actor.voice) {
    if (requested === 'agent') {
      throw forbidden(
        'This connection is not running an agent, so it cannot write under one. ' +
          'Call load_agent and pass the session it returns, or use a token minted for the agent.',
      );
    }
    return null;
  }
  if (!requested) return actor.voice.default;
  const wanted = VOICE_BY_AS[requested];
  if (!actor.voice.granted.includes(wanted)) {
    throw forbidden(
      wanted === 'principal'
        ? `This connection was granted "${actor.agent.name}"’s own voice only, so it cannot write under your name. Reconnect and grant it if you want that.`
        : `This connection was not granted "${actor.agent.name}"’s own voice, so it can only write under your name.`,
    );
  }
  return wanted;
}

/**
 * What goes in the two authorship columns. The **only** place `agent_id` is
 * derived on a write path, and it reads from the actor and nothing else.
 */
export function authorshipOf(
  actor: Actor,
  requested?: 'me' | 'agent' | null,
): { agentId: string | null; agentVoice: Voice | null } {
  const voice = resolveVoice(actor, requested);
  if (!actor.agent || voice === null) return { agentId: null, agentVoice: null };
  return { agentId: actor.agent.agentId, agentVoice: voice };
}

/* ------------------------------- hydration ------------------------------- */

/**
 * Agents for a page of rows, in one round trip. Archived agents are included:
 * this renders what an agent already wrote, and archiving stops the future,
 * not the past. With a viewer, each carries its owner (for the byline's hover
 * card) and whether the viewer can open it — a byline must never become a way
 * to discover an agent's page.
 */
export async function agentsByIds(
  ids: string[],
  viewerId?: string | null,
): Promise<Map<string, AgentDto>> {
  const out = new Map<string, AgentDto>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return out;
  const rows = await getDb()
    .select({ agent: schema.agents, ownerName: schema.users.name })
    .from(schema.agents)
    .innerJoin(schema.users, eq(schema.users.id, schema.agents.ownerId))
    .where(inArray(schema.agents.id, wanted));
  const viewable = viewerId
    ? new Set(
        (
          await getDb()
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(
              and(
                inArray(schema.agents.id, wanted),
                sql`${schema.agents.id} IN (${reachableAgentQuery(viewerId)})`,
              ),
            )
        ).map((r) => r.id),
      )
    : new Set<string>();
  for (const { agent, ownerName } of rows) {
    out.set(
      agent.id,
      agentDto(
        agent,
        !viewerId
          ? { viewable: false }
          : { owner: { id: agent.ownerId, name: ownerName }, viewable: viewable.has(agent.id) },
      ),
    );
  }
  return out;
}

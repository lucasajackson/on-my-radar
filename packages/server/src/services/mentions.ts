/**
 * @mentions — turning `@ada` in a body into the account it meant.
 *
 * The gap this closes is the one docs/DESIGN.md named as the biggest remaining
 * one in participation: comments were plain markdown, so there was no way to
 * address one person, and therefore no way to reach somebody who was neither the
 * blip's author nor already in the thread short of turning the whole radar up to
 * `all`.
 *
 * ## Resolved at write time, stored beside the body
 *
 * The body itself is never rewritten — `@ada` stays `@ada`. It is the person's
 * words, it round-trips through `update_blip` over MCP, and a canonical token
 * like `@[Ada](omr:user:uuid)` would make the stored text something nobody
 * typed. What is stored instead is the *resolution*: one row per (source,
 * person) in `mentions`.
 *
 * Three cases decide this, and parsing at render time loses all three:
 *
 *   * **A renamed account.** The row holds an id, so the handle written in March
 *     renders as whatever they are called today.
 *   * **A deleted account.** The row cascades away and the handle degrades to
 *     plain text, rather than printing a name that resolves to nobody.
 *   * **An edited body.** The rows are the record of who has already been told,
 *     so `reconcile` can notify the newly added and stay silent about the rest.
 *     Without them an edit must either re-notify everybody or nobody.
 *
 * ## Resolution cannot widen access, by construction
 *
 * Candidates come from `radarReaders` — the owner, direct members, and a
 * cascading topic's members. That is the same set `requireRadar` admits, so the
 * parser is incapable of naming somebody who cannot already read the radar. A
 * handle matching nobody in that set simply does not resolve. There is no branch
 * to get wrong and no check to forget: pulling in somebody new is a *share*, and
 * the composer says so rather than doing it quietly.
 *
 * ## Ambiguity resolves to nothing
 *
 * Two people on one radar can answer to `@ada`. Guessing between them would send
 * somebody's words to the wrong person, so an ambiguous handle resolves to
 * neither and renders as text. The composer's picker inserts the fuller handle
 * — `@ada.lovelace` — which disambiguates, and typing a name that is genuinely
 * ambiguous is rare on a set this small.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  agentMentionHandlesFor,
  extractMentions,
  mentionHandlesFor,
  mentionKey,
  type MentionDto,
  type RadarAgentDto,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { radarReaders, type RadarReader, type RadarRow } from './access.js';
import { liveAgentsOf } from './agents.js';

/** Where a mention hangs. Exactly one, enforced by `mentions_one_source`. */
export type MentionSource = { blipId: string } | { commentId: string };

/** What to print for somebody. Never their address — see `MentionDto`. */
export function displayNameFor(user: { name: string | null; email: string }): string {
  return user.name?.trim() || (user.email.split('@')[0] ?? user.email);
}

/**
 * A principal a handle can resolve to: a person, or somebody's agent.
 *
 * `ownerId` is on both, and that is the field that does the work. A mention has
 * to end up in somebody's *unread queue*, and `notifications.user_id` stays NOT
 * NULL and stays a human even when the queue belongs to an agent — see the
 * migration on why making it nullable would silently break coalescing. So the
 * owner is carried from resolution all the way to fan-out rather than looked up
 * again where it is needed.
 *
 * For a person, `ownerId` is simply their own id. Writing it that way means the
 * fan-out has one shape rather than a branch.
 */
export interface MentionTarget {
  /** Set when a person was named. Exactly one of this and `agentId`. */
  userId: string | null;
  /** Set when an agent was named. */
  agentId: string | null;
  /** Whose queue holds it: the person, or the agent's owner. */
  ownerId: string;
  name: string;
  /** The canonical handle. `aliases` carries the others it answers to. */
  handle: string;
  aliases: string[];
}

/** A stable key for set arithmetic across the two kinds of principal. */
function targetKey(target: Pick<MentionTarget, 'userId' | 'agentId'>): string {
  return target.userId ? `u:${target.userId}` : `a:${target.agentId ?? ''}`;
}

function targetForUser(reader: RadarReader): MentionTarget {
  const handles = mentionHandlesFor(reader);
  return {
    userId: reader.id,
    agentId: null,
    ownerId: reader.id,
    name: displayNameFor(reader),
    handle: handles[0] ?? mentionKey(reader.email),
    aliases: handles.slice(1),
  };
}

/**
 * The handles a radar's readers answer to, as a lookup.
 *
 * A handle claimed by two people maps to `null` rather than to either of them.
 * Storing the collision instead of dropping it is deliberate: the caller needs
 * to be able to tell "nobody is called that" from "two people are", because only
 * the second one is worth explaining to whoever typed it.
 */
export async function mentionDirectory(
  radar: RadarRow,
  db: Pick<Db, 'select' | 'selectDistinct'> = getDb(),
): Promise<Map<string, MentionTarget | null>> {
  const readers = await radarReaders(radar, db);
  const byId = new Map(readers.map((reader) => [reader.id, reader]));
  // Every live agent of everybody who can read the radar. Retired ones are
  // excluded inside `liveAgentsOf`, so a withdrawn handle stops resolving in
  // exactly one place rather than in each caller.
  const agents = await liveAgentsOf(
    readers.map((reader) => reader.id),
    db,
  );

  const directory = new Map<string, MentionTarget | null>();
  const add = (target: MentionTarget) => {
    for (const handle of [target.handle, ...target.aliases]) {
      // `has` rather than `get`, so a handle already shot down by an earlier
      // collision is not revived by a third person claiming it.
      directory.set(handle, directory.has(handle) ? null : target);
    }
  };

  for (const reader of readers) add(targetForUser(reader));

  /*
    Agents share one namespace with people rather than getting their own, and
    that is deliberate: `@ada` must not mean a person on one radar and an agent
    on another. Two people's agents both answering to `claude` therefore collide
    and resolve to nobody, exactly as two people called Ada already do — and the
    owner-qualified form (`@ada.claude`) never collides, so there is always a
    way to say which.

    **Resolution still cannot widen access, by the same construction as before.**
    The candidate set is derived from `radarReaders`, so an agent is a candidate
    only when its owner can already read the radar; and what the agent may then
    do there is bounded by that same access, clamped further by its token. A
    mention is proof the access exists, never a grant of it.
  */
  for (const agent of agents) {
    const owner = byId.get(agent.ownerId);
    if (!owner) continue;
    const handles = agentMentionHandlesFor(agent, owner);
    if (handles.length === 0) continue;
    add({
      userId: null,
      agentId: agent.id,
      ownerId: agent.ownerId,
      name: agent.name,
      handle: handles[0] as string,
      aliases: handles.slice(1),
    });
  }

  return directory;
}

/**
 * The agents addressable on a radar, for the composer's picker and for
 * `list_radar_members`.
 *
 * Built from the same two helpers `mentionDirectory` uses, so what the picker
 * offers and what the parser resolves are drawn from one set. The alternative —
 * a second query shaped for the UI — is exactly how a composer comes to suggest
 * a handle the server then declines to resolve.
 */
export async function radarAgents(radar: RadarRow): Promise<RadarAgentDto[]> {
  const readers = await radarReaders(radar);
  const byId = new Map(readers.map((reader) => [reader.id, reader]));
  const agents = await liveAgentsOf(readers.map((reader) => reader.id));

  const out: RadarAgentDto[] = [];
  for (const agent of agents) {
    const owner = byId.get(agent.ownerId);
    if (!owner) continue;
    const handles = agentMentionHandlesFor(agent, owner);
    if (handles.length === 0) continue;
    out.push({
      id: agent.id,
      name: agent.name,
      handle: handles[0] as string,
      handles,
      ownerName: displayNameFor(owner),
    });
  }
  return out;
}

export interface ResolvedMentions {
  /** One entry per handle that named exactly one principal on this radar. */
  resolved: { handle: string; target: MentionTarget }[];
  /** Handles nobody on the radar answers to. The composer explains these. */
  unknown: string[];
  /** Handles two or more readers answer to. Deliberately resolved to nobody. */
  ambiguous: string[];
}

/** Parses a body and resolves every handle in it against who can read the radar. */
export async function resolveMentions(
  radar: RadarRow,
  body: string,
  db: Pick<Db, 'select' | 'selectDistinct'> = getDb(),
): Promise<ResolvedMentions> {
  const handles = extractMentions(body);
  if (handles.length === 0) return { resolved: [], unknown: [], ambiguous: [] };

  const directory = await mentionDirectory(radar, db);
  const out: ResolvedMentions = { resolved: [], unknown: [], ambiguous: [] };
  for (const handle of handles) {
    if (!directory.has(handle)) {
      out.unknown.push(handle);
      continue;
    }
    const target = directory.get(handle) ?? null;
    if (target === null) out.ambiguous.push(handle);
    else out.resolved.push({ handle, target });
  }
  return out;
}

function sourceClause(source: MentionSource) {
  return 'blipId' in source
    ? eq(schema.mentions.blipId, source.blipId)
    : eq(schema.mentions.commentId, source.commentId);
}

/**
 * Brings the stored mentions for one body in line with what it now says, and
 * reports **only the people newly addressed**.
 *
 * That return value is the whole reason this is a reconcile rather than a
 * delete-and-reinsert. Editing a comment to fix a typo must not ping everybody
 * in it a second time; adding one name to it must ping exactly that one person.
 * The rows already there are the record of who has been told.
 *
 * Removing a mention deletes its row and notifies nobody of the removal. A
 * notification already sent cannot be recalled — the same honest limitation
 * §8 records for revoked access — and "you are no longer mentioned" is a message
 * this application sends nowhere else.
 */
export async function reconcileMentions(
  radar: RadarRow,
  source: MentionSource,
  body: string,
  /** Never notified about their own words, so never returned as newly addressed. */
  authorId: string | null,
  /**
   * The persona that wrote this, when one did.
   *
   * Its own mentions are suppressed for the same reason the author's are: an
   * agent naming itself in text it is writing should not queue itself a
   * notification about its own sentence. Separate from `authorId` because on an
   * agent-borne write `authorId` is the *human*, so the human's own mention is
   * suppressed and the agent's would not be without this.
   */
  authorAgentId: string | null = null,
  db: Pick<Db, 'select' | 'selectDistinct' | 'insert' | 'delete'> = getDb(),
): Promise<{
  mentioned: MentionTarget[];
  newlyMentioned: MentionTarget[];
  unknown: string[];
  ambiguous: string[];
}> {
  const { resolved, unknown, ambiguous } = await resolveMentions(radar, body, db);

  const existing = await db
    .select({ userId: schema.mentions.userId, agentId: schema.mentions.agentId })
    .from(schema.mentions)
    .where(sourceClause(source));
  const before = new Set(existing.map(targetKey));

  const wanted = new Map(resolved.map((entry) => [targetKey(entry.target), entry.target]));

  const goneUsers = existing
    .filter((row) => row.userId !== null && !wanted.has(targetKey(row)))
    .map((row) => row.userId as string);
  const goneAgents = existing
    .filter((row) => row.agentId !== null && !wanted.has(targetKey(row)))
    .map((row) => row.agentId as string);
  // Two deletes rather than one over a union, because the two columns are
  // separately indexed and a single `OR` across them plans badly on the one
  // table this runs against on every save.
  if (goneUsers.length > 0) {
    await db
      .delete(schema.mentions)
      .where(and(sourceClause(source), inArray(schema.mentions.userId, goneUsers)));
  }
  if (goneAgents.length > 0) {
    await db
      .delete(schema.mentions)
      .where(and(sourceClause(source), inArray(schema.mentions.agentId, goneAgents)));
  }

  const added = [...wanted.values()].filter((target) => !before.has(targetKey(target)));
  if (added.length > 0) {
    await db
      .insert(schema.mentions)
      .values(
        added.map((target) => ({
          radarId: radar.id,
          blipId: 'blipId' in source ? source.blipId : null,
          commentId: 'commentId' in source ? source.commentId : null,
          userId: target.userId,
          agentId: target.agentId,
        })),
      )
      // Two saves racing on the same body would otherwise collide on the partial
      // unique index and turn a successful edit into a 500. The row is the same
      // either way, so the loser has nothing to do.
      //
      // For an agent mention the index doing the arbitrating is
      // `mentions_blip_agent_idx` / `mentions_comment_agent_idx`, added in 0015.
      // Without them `user_id` is NULL on these rows, NULLs do not conflict in a
      // unique index, and this clause would quietly stop deduplicating anything
      // — one extra row and one extra notification per save.
      .onConflictDoNothing();
  }

  return {
    mentioned: [...wanted.values()],
    newlyMentioned: added.filter(
      (target) =>
        !(target.userId !== null && target.userId === authorId) &&
        !(target.agentId !== null && target.agentId === authorAgentId),
    ),
    unknown,
    ambiguous,
  };
}

/**
 * The stored mentions for a page of blips or comments, in one query rather than
 * one per row — the same shape as `commentCounts`, and for the same reason.
 */
export async function mentionsFor(
  kind: 'blip' | 'comment',
  ids: string[],
): Promise<Map<string, MentionDto[]>> {
  const out = new Map<string, MentionDto[]>();
  if (ids.length === 0) return out;

  const column = kind === 'blip' ? schema.mentions.blipId : schema.mentions.commentId;
  const db = getDb();

  const [userRows, agentRows] = await Promise.all([
    db
      .select({
        sourceId: column,
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.mentions)
      .innerJoin(schema.users, eq(schema.users.id, schema.mentions.userId))
      .where(inArray(column, ids)),
    // The agent's own row plus its owner's, because the owner is what makes the
    // qualified handle. Inner joins throughout: a row whose principal is gone
    // has cascaded away, and one whose owner is gone cannot exist.
    db
      .select({
        sourceId: column,
        agentId: schema.agents.id,
        handle: schema.agents.slug,
        name: schema.agents.name,
        ownerName: schema.users.name,
        ownerEmail: schema.users.email,
      })
      .from(schema.mentions)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.mentions.agentId))
      .innerJoin(schema.users, eq(schema.users.id, schema.agents.ownerId))
      .where(inArray(column, ids)),
  ]);

  const push = (sourceId: string | null, dto: MentionDto) => {
    if (!sourceId) return;
    const list = out.get(sourceId) ?? [];
    list.push(dto);
    out.set(sourceId, list);
  };

  for (const row of userRows) {
    // The handle is recomputed from the account rather than stored, so a renamed
    // person's mention renders under their new handle as well as their new name.
    // The body still says what it always said; this is the resolution.
    push(row.sourceId, {
      handle: mentionKey(row.email.split('@')[0] ?? ''),
      userId: row.userId,
      name: displayNameFor(row),
    });
  }

  for (const row of agentRows) {
    const handles = agentMentionHandlesFor(row, {
      email: row.ownerEmail,
      name: row.ownerName,
    });
    push(row.sourceId, {
      handle: handles[0] ?? row.handle,
      // Blank, not absent: this DTO's `userId` is "the person this named", and
      // no person was named. `agentId` carries the principal instead.
      userId: '',
      agentId: row.agentId,
      // Both forms, so whichever one was typed is the one that renders. The row
      // does not remember which was written — deliberately, so that a rename
      // re-renders — which is exactly why the renderer needs the whole set.
      aliases: handles.slice(1),
      name: row.name,
    });
  }

  return out;
}

/**
 * Drops the mentions that named somebody on a radar they can no longer read.
 *
 * Same disclosure rule as the notification sweep in `dropRadarNotifications`:
 * what is being removed is a pointer into content they have lost access to. The
 * words in the body are untouched — this table is the resolution, not the text —
 * so the handle simply stops resolving, which is exactly what it would do if it
 * had been typed today.
 */
export async function dropRadarMentions(userId: string, radarId: string): Promise<number> {
  /*
    **This person's agents go with them, in the same predicate.**

    An agent's reach is derived from its owner's, so the instant the owner loses
    a radar the agent has lost it too — but a `mentions` row already written is
    a pointer into content, and `listNotifications` scopes a persona's queue by
    `agent_id` without re-checking the radar. Left behind, the agent keeps a
    handle resolving into a conversation its human can no longer open.

    The design that preceded this asked for the agent leg to be added at each of
    the four revocation call sites, and named that as the change a three-way
    merge would most likely drop. It is one predicate here instead, inside the
    function every one of those sites already calls — so there is nothing for a
    call site to remember and nothing for a merge to lose. The sites themselves
    had already been consolidated to two (`removeMember` and `sweepLostRadar`),
    which is what made this possible.
  */
  const result = await getDb()
    .delete(schema.mentions)
    .where(
      and(
        eq(schema.mentions.radarId, radarId),
        or(
          eq(schema.mentions.userId, userId),
          inArray(
            schema.mentions.agentId,
            getDb()
              .select({ id: schema.agents.id })
              .from(schema.agents)
              .where(eq(schema.agents.ownerId, userId)),
          ),
        ),
      ),
    )
    .returning({ id: schema.mentions.id });
  return result.length;
}

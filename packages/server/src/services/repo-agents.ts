/**
 * The Agent Repo: agents (definitions and identities), their versioned prompts,
 * tool profiles, sharing, ownership transfer, import/export and checkout.
 * Memory lives in `agent-memory.ts`. `docs/AGENT_REPO.md` Part I is the design.
 *
 * Every function here is called identically by the REST routes and the MCP
 * tools, and every agent-facing refusal lives here — never in the tool router.
 * v2 made agents autonomous over their own prompt and memory, so the human-only
 * acts are the ones about *other people and credentials*: sharing, accepting a
 * share, following updates, transferring, locking the prompt, archiving,
 * deleting, minting a token, and putting a memory on a radar. Those go through
 * `assertHumanDecision`, so REST refuses them for a bearer connection exactly as
 * MCP does.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, lte, max, ne, sql } from 'drizzle-orm';
import {
  AGENT_REPO,
  HARNESSES,
  MEMORY_TYPE_KEYS,
  SHARE_PRESETS,
  briefNameSchema,
  connectInstructions,
  presetFor,
  profileSummary,
  renderCheckout,
  repoSlugFrom,
  resolveHarness,
  sharedAgentRef,
  validateProfileSettings,
  withoutUnapprovedWidening,
  withoutWideningValues,
  wideningValues,
  type ActivityInput,
  type ActivityItemDto,
  type ActivityKind,
  type ActivityPageDto,
  type AgentShareDto,
  type ApiTokenDto,
  type BriefBindingInput,
  type BriefDto,
  type HarnessVerdict,
  type BriefIndexEntryDto,
  type BriefOp,
  type BriefRevisionPageDto,
  type BriefRevisionsInput,
  type BriefStaleDto,
  type CheckoutDto,
  type CheckoutInput,
  type CreateRepoAgentInput,
  type ImportAgentInput,
  type MemoryAccess,
  type MemoryOp,
  type MemoryType,
  type OAuthGrantDto,
  type ProfileDto,
  type ProfileKey,
  type ProfileSettings,
  type PromptAccess,
  type PromptHistoryInput,
  type PromptHistoryPageDto,
  type PromptProposalDto,
  type PromptProposedDto,
  type PromptVersionDto,
  type RenameBriefInput,
  type RepoAgentDto,
  type SetProfileInput,
  type ShareAgentInput,
  type SharePreset,
  type UpdateBriefInput,
  type UpdatePromptInput,
  setAgentRadarsSchema,
  type SetAgentRadarsInput,
  type UpdateRepoAgentInput,
} from '@onmyradar/contract';
import { findUserByEmail } from '../auth/accounts.js';
import { getDb, schema, type Db } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests, type Actor } from '../http.js';
import {
  assertHumanDecision,
  decideAgentAccess,
  readableRadarIdsFor,
  orgStandings,
  reachableAgentQuery,
  unfencedReadableTopicQuery,
  requireRepoAgent,
  requireScope,
  requireTopic,
  topicsWithheld,
  type RepoAgentAccess,
  type RepoAgentRow,
} from './access.js';
import {
  assertAccepted,
  briefIndex,
  connectionOf,
  harnessVerdict,
  harnessVerdicts,
  pastPin,
  runningBriefs,
  insertImportedMemories,
  liveMemories,
  sessionForWrite,
  sourceOf,
} from './agent-memory.js';
import { staleForBriefs, staleFromRow } from './brief-bindings.js';
import { isPersonAtScreen, writeAsAgent } from './agents.js';
import { assertAgentCeiling, lockOwner } from './owner-lock.js';
import { decodeCursor, encodeCursor, isCursorInt, isCursorTimestamp } from './cursor.js';
import { recordAudit } from './audit.js';
import { createBlip } from './blips.js';
import { isUniqueViolation } from './slugs.js';
import { createToken, listGrants, listTokens, revokeAgentCredentials } from './tokens.js';
import { must } from '../errors.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Access = Omit<RepoAgentAccess, 'agent'>;

const idList = (ids: readonly string[]) =>
  sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;

/* ---------------------------------- DTOs ---------------------------------- */

async function hydrate(
  actor: Actor,
  rows: Array<{ agent: RepoAgentRow; access: Access }>,
): Promise<RepoAgentDto[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((r) => r.agent.id);

  const counts = await db
    .select({
      agentId: schema.repoAgentMemories.agentId,
      type: schema.repoAgentMemories.type,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.repoAgentMemories)
    .where(
      and(
        inArray(schema.repoAgentMemories.agentId, ids),
        isNull(schema.repoAgentMemories.forgottenAt),
      ),
    )
    .groupBy(schema.repoAgentMemories.agentId, schema.repoAgentMemories.type);

  // Raw `execute` hands timestamps back as the driver's strings, not Dates.
  const sessions = await db.execute<{
    agent_id: string;
    started_at: string;
    harness: string | null;
    client_label: string | null;
    user_id: string;
    cosigner: string | null;
  }>(sql`
    SELECT DISTINCT ON (s.agent_id) s.agent_id, s.started_at, s.harness, s.client_label, s.user_id, u.name AS cosigner
      FROM agent_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.agent_id IN ${idList(ids)}
     ORDER BY s.agent_id, s.started_at DESC
  `);

  // The bearing strip: when this agent's memory was written. Capped per agent
  // so a busy agent cannot make the list page heavy.
  const activity = await db.execute<{ agent_id: string; at: string }>(sql`
    SELECT agent_id, at FROM (
      SELECT m.agent_id, r.created_at AS at,
             row_number() OVER (PARTITION BY m.agent_id ORDER BY r.created_at DESC) AS n
      FROM agent_memory_revisions r
      JOIN agent_memories m ON m.id = r.memory_id
      WHERE m.agent_id IN ${idList(ids)} AND r.op IN ('create','update','append')
    ) t WHERE n <= 160 ORDER BY at ASC
  `);

  const profiles = await db
    .select()
    .from(schema.agentProfiles)
    .where(inArray(schema.agentProfiles.agentId, ids))
    .orderBy(asc(schema.agentProfiles.harness));

  const optedIn = new Set(
    (
      await db
        .select({ id: schema.agentLiveEditOptins.agentId })
        .from(schema.agentLiveEditOptins)
        .where(inArray(schema.agentLiveEditOptins.agentId, ids))
    ).map((r) => r.id),
  );

  const transfers = await db
    .select({ transfer: schema.agentTransfers, to: schema.users })
    .from(schema.agentTransfers)
    .innerJoin(schema.users, eq(schema.users.id, schema.agentTransfers.toUserId))
    .where(inArray(schema.agentTransfers.agentId, ids));

  // Shared agents whose briefs changed since this caller accepted them: a
  // brief travels with the prompt, so a change to one is an update to take.
  // Compared in Postgres, against the stored microsecond timestamps.
  const briefsMoved = await db.execute<{ agent_id: string }>(sql`
    SELECT DISTINCT b.agent_id FROM agent_briefs b
      JOIN agent_recipients ar ON ar.agent_id = b.agent_id AND ar.user_id = ${actor.user.id}::uuid
     WHERE b.agent_id IN ${idList(ids)} AND b.updated_at > ar.accepted_at
  `);

  const owners = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, [...new Set(rows.map((r) => r.agent.ownerId))]));

  /*
    The radars a limited agent was given, for its owner in a browser only: a recipient is
    not told which radars the owner chose, and an agent listing its siblings is not shown
    another agent's. A radar the caller can no longer read keeps its grant and loses its name.
  */
  const limitedOwn =
    actor.kind === 'user'
      ? rows.filter((r) => r.access.owner && r.agent.radarScope === 'selected')
      : [];
  const grantRows = limitedOwn.length
    ? await db
        .select({
          agentId: schema.agentRadarGrants.agentId,
          radarId: schema.agentRadarGrants.radarId,
          ceiling: schema.agentRadarGrants.ceiling,
          name: schema.radars.name,
        })
        .from(schema.agentRadarGrants)
        .innerJoin(schema.radars, eq(schema.radars.id, schema.agentRadarGrants.radarId))
        .where(
          inArray(
            schema.agentRadarGrants.agentId,
            limitedOwn.map((r) => r.agent.id),
          ),
        )
        .orderBy(asc(schema.radars.name))
    : [];
  const nameable = grantRows.length ? new Set(await readableRadarIdsFor(actor)) : new Set<string>();

  return rows.map(({ agent, access }) => {
    const memoryCounts = Object.fromEntries(MEMORY_TYPE_KEYS.map((k) => [k, 0])) as Record<
      MemoryType,
      number
    >;
    for (const c of counts) if (c.agentId === agent.id) memoryCounts[c.type] = c.n;
    const last = sessions.rows.find((s) => s.agent_id === agent.id);
    const owner = owners.find((o) => o.id === agent.ownerId);
    const own = access.owner;
    const transfer = transfers.find((t) => t.transfer.agentId === agent.id);
    const acceptedVersion = own ? null : (access.recipient?.acceptedVersion ?? null);
    const pinned = !own && access.recipient !== null && !access.recipient.followUpdates;
    const briefsUpdated = pinned && briefsMoved.rows.some((b) => b.agent_id === agent.id);
    return {
      id: agent.id,
      slug: agent.slug,
      handle: agent.slug,
      // The owner's address appears only on an agent shared with this caller —
      // somebody the owner chose to share with.
      ref: own || !owner ? agent.slug : sharedAgentRef(owner.email, agent.slug),
      name: agent.name,
      description: agent.description,
      owner: { id: agent.ownerId, name: owner?.name ?? null, email: owner?.email ?? null },
      role: own ? 'owner' : 'shared',
      access: {
        prompt: access.prompt,
        memory: access.memory,
        canManage: access.canManage,
        canWriteAs: true,
      },
      sharedPreset: own ? null : presetFor(access.prompt, access.memory),
      promptVersion: agent.promptVersion,
      acceptedVersion,
      followUpdates: access.recipient?.followUpdates ?? false,
      updateAvailable:
        pinned && (agent.promptVersion > (access.recipient?.acceptedVersion ?? 0) || briefsUpdated),
      briefsUpdated,
      awaitingAccept: !own && access.recipient === null,
      lockPrompt: agent.lockPrompt,
      agentEditsLive: optedIn.has(agent.id),
      primaryHarness: resolveHarness(agent.primaryHarness),
      profiles: profiles
        .filter((p) => p.agentId === agent.id)
        .map((p) => ({
          harness: p.harness as ProfileKey,
          ...profileSummary(p.harness as ProfileKey, p.settings),
        })),
      accent: agent.accent,
      radarScope: agent.radarScope,
      radarGrants: limitedOwn.some((r) => r.agent.id === agent.id)
        ? grantRows
            .filter((g) => g.agentId === agent.id)
            .map((g) => ({
              radarId: g.radarId,
              name: nameable.has(g.radarId) ? g.name : null,
              ceiling: g.ceiling,
            }))
        : null,
      memoryCounts,
      lastSession: last
        ? {
            startedAt: new Date(last.started_at).toISOString(),
            harness: last.harness,
            clientLabel: last.client_label,
            cosigner: { id: last.user_id, name: last.cosigner },
          }
        : null,
      memoryActivity: activity.rows
        .filter((a) => a.agent_id === agent.id)
        .map((a) => new Date(a.at).toISOString()),
      pendingTransfer: transfer
        ? own
          ? {
              direction: 'out',
              person: { id: transfer.to.id, name: transfer.to.name, email: transfer.to.email },
            }
          : transfer.to.id === actor.user.id && owner
            ? { direction: 'in', person: { id: owner.id, name: owner.name, email: owner.email } }
            : null
        : null,
      revision: agent.revision,
      archived: agent.archivedAt !== null,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    } satisfies RepoAgentDto;
  });
}

async function hydrateOne(actor: Actor, access: RepoAgentAccess): Promise<RepoAgentDto> {
  const { agent, ...rest } = access;
  const [dto] = await hydrate(actor, [{ agent, access: rest }]);
  return must(dto, 'the agent it just hydrated');
}

/** Re-read an agent's access after a change, and hydrate it. */
async function reloaded(actor: Actor, agentId: string): Promise<RepoAgentDto> {
  return hydrateOne(actor, await requireRepoAgent(agentId, actor, 'read'));
}

/* ------------------------------- definitions ------------------------------ */

/**
 * The caller's agents, own and shared, in one of three views. The union of
 * grants is computed in SQL for the list and handed row by row to the same
 * `decideAgentAccess` the lookup uses, so the list and the lookup cannot
 * disagree — the second-union trap the scopes work found by sabotage.
 */
export async function listRepoAgents(
  actor: Actor,
  options: { view?: 'mine' | 'shared' | 'archived' | undefined } = {},
): Promise<RepoAgentDto[]> {
  const userId = actor.user.id;
  const view = options.view ?? 'mine';
  const db = getDb();
  const agents = await db
    .select()
    .from(schema.repoAgents)
    .where(
      and(
        sql`${schema.repoAgents.id} IN (${reachableAgentQuery(userId)})`,
        view === 'mine' ? eq(schema.repoAgents.ownerId, userId) : undefined,
        view === 'shared' ? ne(schema.repoAgents.ownerId, userId) : undefined,
        view === 'archived'
          ? sql`${schema.repoAgents.archivedAt} IS NOT NULL`
          : isNull(schema.repoAgents.archivedAt),
      ),
    )
    .orderBy(asc(schema.repoAgents.name));
  if (agents.length === 0) return [];
  const sharedIds = agents.filter((a) => a.ownerId !== userId).map((a) => a.id);
  const shares = sharedIds.length
    ? await db.execute<{
        agent_id: string;
        subject_type: 'user' | 'topic';
        prompt_access: PromptAccess;
        memory_access: MemoryAccess;
      }>(sql`
        SELECT agent_id, subject_type, prompt_access, memory_access FROM agent_shares
         WHERE agent_id IN ${idList(sharedIds)}
           AND ((subject_type = 'user' AND subject_id = ${userId}::uuid)
             OR (subject_type = 'topic' AND subject_id IN (${unfencedReadableTopicQuery(userId)})))`)
    : { rows: [] };
  const recipients = sharedIds.length
    ? await db
        .select()
        .from(schema.agentRecipients)
        .where(
          and(
            inArray(schema.agentRecipients.agentId, sharedIds),
            eq(schema.agentRecipients.userId, userId),
          ),
        )
    : [];
  const ceiling = actor.ceiling ?? 'owner';
  const standings = await orgStandings(
    userId,
    agents.map((a) => a.organizationId),
  );
  const visible = agents.flatMap((agent) => {
    const recipient = recipients.find((r) => r.agentId === agent.id);
    const access = decideAgentAccess(
      agent,
      userId,
      shares.rows
        .filter((s) => s.agent_id === agent.id)
        .map((s) => ({
          subjectType: s.subject_type,
          promptAccess: s.prompt_access,
          memoryAccess: s.memory_access,
        })),
      recipient
        ? { acceptedVersion: recipient.acceptedVersion, followUpdates: recipient.followUpdates }
        : null,
      ceiling,
      standings.get(agent.organizationId) ?? 'outsider',
    );
    return access ? [{ agent, access }] : [];
  });
  return hydrate(actor, visible);
}

export async function getRepoAgent(actor: Actor, idOrSlug: string): Promise<RepoAgentDto> {
  return hydrateOne(actor, await requireRepoAgent(idOrSlug, actor, 'read'));
}

/** Whether a handle is free among the caller's own agents, and a free one near it. */
export async function handleAvailable(
  actor: Actor,
  raw: string,
): Promise<{ available: boolean; suggestion: string }> {
  const base = repoSlugFrom(raw) || 'agent';
  const taken = new Set(
    (
      await getDb()
        .select({ slug: schema.repoAgents.slug })
        .from(schema.repoAgents)
        .where(
          and(
            eq(schema.repoAgents.ownerId, actor.user.id),
            sql`${schema.repoAgents.slug} LIKE ${`${base.slice(0, 55)}%`}`,
          ),
        )
    ).map((r) => r.slug),
  );
  let suggestion = base;
  for (let n = 2; taken.has(suggestion); n += 1) suggestion = `${base.slice(0, 55)}-${n}`;
  return { available: raw === base && !taken.has(base), suggestion };
}

/**
 * Profiles from a create or import, validated against each tool's fields.
 *
 * `profiles` (and `profile` for the primary tool) are v2 input and strict: a
 * value the tool would not accept is a 400 naming it. v1's flat
 * `harnessConfig` is lenient, key by key: it is what every v1 export file
 * carries, v1 accepted free text (a Claude Code `color: teal`), and refusing
 * the whole import over one cosmetic value would strand the file. Invalid
 * cosmetic values are dropped; invalid tool restrictions refuse the import,
 * since dropping them would silently inherit a broader tool pool.
 */
function profileRowsFrom(input: {
  profiles?: Record<string, Record<string, string | boolean | null>> | undefined;
  harnessConfig?: Record<string, Record<string, string>> | undefined;
  primaryHarness?: string | undefined;
  profile?: Record<string, string | boolean | null> | undefined;
}): Array<{ harness: ProfileKey; settings: ProfileSettings }> {
  const keyOf = (raw: string): ProfileKey | null =>
    raw === 'default' ? 'default' : resolveHarness(raw);
  const rows = new Map<ProfileKey, ProfileSettings>();
  for (const [raw, settings] of Object.entries(input.harnessConfig ?? {})) {
    const harness = keyOf(raw);
    if (!harness) continue;
    const kept: ProfileSettings = {};
    for (const [key, value] of Object.entries(settings)) {
      const checked = validateProfileSettings(harness, { [key]: value });
      if (
        !checked.ok &&
        harness === 'claude-code' &&
        (key === 'tools' || key === 'disallowedTools')
      )
        throw badRequest(checked.message);
      if (checked.ok) Object.assign(kept, checked.value);
    }
    rows.set(harness, kept);
  }
  const strict: Record<string, Record<string, unknown>> = { ...(input.profiles ?? {}) };
  if (input.primaryHarness && input.profile) strict[input.primaryHarness] = input.profile;
  for (const [raw, settings] of Object.entries(strict)) {
    const harness = keyOf(raw);
    if (!harness) throw badRequest(`'${raw}' is not a tool a profile can be for.`);
    const checked = validateProfileSettings(harness, settings);
    if (!checked.ok) throw badRequest(checked.message);
    rows.set(harness, checked.value);
  }
  return [...rows].map(([harness, settings]) => ({ harness, settings }));
}

async function insertPromptVersion(
  tx: Pick<Db, 'insert'>,
  actor: Actor,
  agentId: string,
  values: {
    version: number;
    body: string;
    basedOn: number | null;
    note?: string | undefined;
    sessionId?: string | null | undefined;
    harness?: string | null | undefined;
    source?: 'human' | 'agent' | 'import';
    /** Set when the edit was accepted from a proposal: the proposal's, not the accepter's. */
    clientLabel?: string | null | undefined;
    authorId?: string | null | undefined;
    editorAgentId?: string | null | undefined;
  },
) {
  await tx.insert(schema.repoAgentPrompts).values({
    agentId,
    version: values.version,
    body: values.body,
    status: 'live',
    basedOn: values.basedOn,
    note: values.note ?? '',
    source: values.source ?? sourceOf(actor),
    clientLabel: values.clientLabel === undefined ? connectionOf(actor).label : values.clientLabel,
    harness: values.harness ?? null,
    authorId: values.authorId === undefined ? actor.user.id : values.authorId,
    sessionId: values.sessionId ?? null,
    editorAgentId: values.editorAgentId ?? null,
  });
}

async function createDefinition(
  tx: Tx,
  actor: Actor,
  input: CreateRepoAgentInput | ImportAgentInput,
  promptSource: 'human' | 'agent' | 'import',
): Promise<RepoAgentRow> {
  await lockOwner(tx, actor.user.id);
  await assertAgentCeiling(tx, actor.user.id);
  const primary = 'primaryHarness' in input ? input.primaryHarness : undefined;
  const profiles = profileRowsFrom({
    profiles: input.profiles,
    harnessConfig: input.harnessConfig,
    primaryHarness: primary,
    profile: 'profile' in input ? input.profile : undefined,
  });
  const slug = input.slug ?? (repoSlugFrom(input.name) || 'agent');
  const prompt = input.prompt?.trim() ? input.prompt : null;
  const [row] = await tx
    .insert(schema.repoAgents)
    .values({
      ownerId: actor.user.id,
      slug,
      name: input.name,
      description: input.description ?? '',
      accent: 'accent' in input ? (input.accent ?? null) : null,
      primaryHarness: primary ?? profiles.find((p) => p.harness !== 'default')?.harness ?? null,
      promptVersion: prompt ? 1 : 0,
    })
    .onConflictDoNothing({ target: [schema.repoAgents.ownerId, schema.repoAgents.slug] })
    .returning();
  if (!row) {
    throw conflict(
      `You already have an agent called '${slug}'. Pick another handle, or update that one.`,
    );
  }
  if (prompt) {
    await insertPromptVersion(tx, actor, row.id, {
      version: 1,
      body: prompt,
      basedOn: 0,
      source: promptSource,
    });
  }
  for (const profile of profiles) {
    let settings = profile.settings;
    let approvedWidening: Record<string, string> = {};
    const widening = profile.harness === 'default' ? {} : wideningValues(profile.harness, settings);
    if (Object.keys(widening).length > 0) {
      if (promptSource === 'import') {
        // An imported file is a document, not a decision: whatever it says about
        // acting without asking, nobody has approved it. Dropped, not refused, so
        // an export from an owner's agent still imports.
        settings = withoutWideningValues(profile.harness as never, settings).settings;
      } else if (mayApproveWidening(actor, actor.user.id)) {
        approvedWidening = widening;
      } else {
        throw wideningRefusal();
      }
    }
    await tx.insert(schema.agentProfiles).values({
      agentId: row.id,
      harness: profile.harness,
      settings,
      approvedWidening,
      updatedBy: actor.user.id,
    });
  }
  return row;
}

/**
 * Whether this caller may set a permission-widening value (`widens` in the
 * harness contract: Codex `danger-full-access`, `approval_policy=never`, Claude
 * Code `bypassPermissions`, …) on one of the agent owner's profiles.
 *
 * Only the owner, in a signed-in browser session. An agent connection (PAT,
 * OAuth, MCP) is refused even when it is the owner's own — a prompt-injected
 * agent must not be able to switch off its own sandbox — and so is anyone the
 * agent is merely shared with. Checkout renders a widening value only when this
 * decision was recorded (`agent_profiles.approved_widening`).
 */
function mayApproveWidening(actor: Actor, ownerId: string): boolean {
  return (
    actor.kind === 'user' &&
    actor.invocation !== 'mcp' &&
    Boolean(actor.sessionId) &&
    actor.user.id === ownerId
  );
}

function wideningRefusal() {
  return forbidden(
    'That profile lets the tool act without asking (a widened permission or sandbox). Only the ' +
      'agent’s owner can set that, signed in to On My Radar in a browser — not an agent, a ' +
      'token, or someone the agent is shared with. Remove the value, or ask the owner.',
  );
}

/**
 * A new agent. Allowed over MCP: it is inert until somebody chooses to load it,
 * and "build agents with Claude" is half of the ask. Archiving and deleting stay
 * a person's.
 */
export async function createRepoAgent(
  actor: Actor,
  input: CreateRepoAgentInput,
): Promise<RepoAgentDto> {
  await requireScope(actor, 'write', 'create an agent');
  const row = await getDb().transaction((tx) =>
    createDefinition(tx, actor, input, sourceOf(actor)),
  );
  await recordAudit(actor, 'repo_agent.create', 'repo_agent', row.id, { slug: row.slug });
  return reloaded(actor, row.id);
}

async function lockAgent(tx: Tx, id: string): Promise<RepoAgentRow> {
  const [row] = await tx
    .select()
    .from(schema.repoAgents)
    .where(eq(schema.repoAgents.id, id))
    .for('update')
    .limit(1);
  if (!row) throw notFound('Agent not found');
  return row;
}

/**
 * Change what an agent is called and how it presents. Anybody who can edit its
 * prompt may; changing its handle is the owner's, because the handle is how
 * people @-mention it and a rename breaks mentions written before.
 */
export async function updateRepoAgent(
  actor: Actor,
  idOrSlug: string,
  input: UpdateRepoAgentInput,
): Promise<RepoAgentDto> {
  const access = await requireRepoAgent(
    idOrSlug,
    actor,
    input.slug !== undefined ? 'manage' : 'prompt',
  );
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing it.');
  const legacy = input.harnessConfig ? profileRowsFrom({ harnessConfig: input.harnessConfig }) : [];
  // The old way to set profiles skipped the lock and the self-edit rule: an agent uses
  // `set_agent_profile`, which has both.
  if (legacy.length > 0 && !isPerson(actor))
    throw forbidden('An agent sets tool profiles with set_agent_profile, not update_agent.');
  const row = await getDb()
    .transaction(async (tx) => {
      const current = await lockAgent(tx, access.agent.id);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw conflict(
          `This agent changed since you read it (revision ${current.revision}, not ${input.expectedRevision}). Reload and retry.`,
        );
      }
      const [row] = await tx
        .update(schema.repoAgents)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.accent !== undefined ? { accent: input.accent } : {}),
          ...(input.primaryHarness !== undefined ? { primaryHarness: input.primaryHarness } : {}),
          revision: current.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.repoAgents.id, current.id))
        .returning();
      for (const profile of legacy)
        await upsertProfile(tx, actor, current, profile.harness, profile.settings);
      return must(row, 'the row it just wrote');
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err, 'agents_owner_slug_key'))
        throw conflict(`There is already an agent called '${input.slug ?? ''}'.`);
      throw err;
    });
  await recordAudit(actor, 'repo_agent.update', 'repo_agent', row.id, {
    fields: Object.keys(input).filter((k) => k !== 'expectedRevision'),
  });
  return reloaded(actor, row.id);
}

/**
 * Choose which radars an agent may reach (`all`, or `selected` with a ceiling on each).
 *
 * The owner's decision, made on a screen: an agent that could widen its own limit would not
 * be limited, so nothing here is reachable over a token, `update_agent` does not carry the
 * fields, and a recipient of a shared agent cannot change what its owner chose. Each radar
 * must be one the owner reads today (a 404 otherwise, so the call is no way to probe ids).
 * The set is replaced whole, in one transaction, and takes effect on the agent's next request.
 */
export async function setAgentRadars(
  actor: Actor,
  idOrSlug: string,
  input: SetAgentRadarsInput,
): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Choosing the radars an agent may reach is the owner’s decision, made in On My Radar.',
  );
  const { scope, grants } = setAgentRadarsSchema.parse(input);
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  const readable = new Set(await readableRadarIdsFor(actor));
  for (const g of grants) if (!readable.has(g.radarId)) throw notFound('Radar not found');
  await getDb().transaction(async (tx) => {
    const current = await lockAgent(tx, access.agent.id);
    // Ownership was checked before the lock; a transfer can land while we waited for it.
    if (current.ownerId !== actor.user.id) throw notFound('Agent not found');
    await tx.delete(schema.agentRadarGrants).where(eq(schema.agentRadarGrants.agentId, current.id));
    if (grants.length)
      await tx
        .insert(schema.agentRadarGrants)
        .values(
          grants.map((g) => ({ agentId: current.id, radarId: g.radarId, ceiling: g.ceiling })),
        );
    await tx
      .update(schema.repoAgents)
      .set({ radarScope: scope, revision: current.revision + 1, updatedAt: new Date() })
      .where(eq(schema.repoAgents.id, current.id));
  });
  await recordAudit(actor, 'repo_agent.radars', 'repo_agent', access.agent.id, {
    scope,
    grants: grants.map((g) => ({ radarId: g.radarId, ceiling: g.ceiling })),
  });
  return reloaded(actor, access.agent.id);
}

/** Agents can't change a locked prompt or its tool addenda; people with edit access still can. */
export async function setLocked(
  actor: Actor,
  idOrSlug: string,
  locked: boolean,
): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Locking an agent’s prompt is the owner’s decision, made in On My Radar.',
  );
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  await getDb()
    .update(schema.repoAgents)
    .set({ lockPrompt: locked, updatedAt: new Date() })
    .where(eq(schema.repoAgents.id, access.agent.id));
  await recordAudit(
    actor,
    locked ? 'repo_agent.lock' : 'repo_agent.unlock',
    'repo_agent',
    access.agent.id,
  );
  return reloaded(actor, access.agent.id);
}

/**
 * Let other agents' edits to this agent's prompt (and tool profiles) go live (ADR-0031). Off by
 * default: such an edit is then a proposal. The owner's decision, so no token reaches it, and the
 * flag is not a field of `update_agent`.
 */
export async function setAgentEditsLive(
  actor: Actor,
  idOrSlug: string,
  live: boolean,
): Promise<RepoAgentDto> {
  assertBrowserOwner(
    actor,
    'Letting other agents change this prompt live is the owner’s decision, made in On My Radar while signed in in a browser — not by an agent or a token.',
  );
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  // Under the agent's row lock, like every edit it gates: once a disable commits, an edit that was
  // queued behind it re-reads the flag and is held.
  await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    assertStillOwner(actor, agent);
    if (live)
      await tx
        .insert(schema.agentLiveEditOptins)
        .values({ agentId: agent.id })
        .onConflictDoNothing();
    else
      await tx
        .delete(schema.agentLiveEditOptins)
        .where(eq(schema.agentLiveEditOptins.agentId, agent.id));
    await tx
      .update(schema.repoAgents)
      .set({ updatedAt: new Date() })
      .where(eq(schema.repoAgents.id, agent.id));
  });
  await recordAudit(
    actor,
    live ? 'repo_agent.agent_edits_live' : 'repo_agent.agent_edits_held',
    'repo_agent',
    access.agent.id,
  );
  return reloaded(actor, access.agent.id);
}

/** Does the owner let other agents change this agent live? Read under the agent's row lock. */
async function agentOpenToEdits(tx: Tx, agentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.agentLiveEditOptins.agentId })
    .from(schema.agentLiveEditOptins)
    .where(eq(schema.agentLiveEditOptins.agentId, agentId))
    .limit(1);
  return row !== undefined;
}

/** A copy you own: name, prompt (the version you run), profiles and briefs. Never the memory. */
export async function duplicateAgent(actor: Actor, idOrSlug: string): Promise<RepoAgentDto> {
  await requireScope(actor, 'write', 'create an agent');
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  const { agent } = access;
  const version =
    access.recipient && !access.recipient.followUpdates
      ? access.recipient.acceptedVersion
      : agent.promptVersion;
  const [prompt] = version
    ? await getDb()
        .select({ body: schema.repoAgentPrompts.body })
        .from(schema.repoAgentPrompts)
        .where(
          and(
            eq(schema.repoAgentPrompts.agentId, agent.id),
            eq(schema.repoAgentPrompts.version, version),
          ),
        )
    : [];
  const profiles = await getDb()
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.agentId, agent.id));
  const briefs = await acceptedBriefs(access, actor.user.id);
  const { suggestion } = await handleAvailable(actor, `${agent.slug}-copy`);
  const row = await getDb().transaction(async (tx) => {
    const row = await createDefinition(
      tx,
      actor,
      {
        name: `${agent.name} (copy)`.slice(0, AGENT_REPO.nameLength),
        slug: suggestion,
        description: agent.description,
        ...(prompt?.body ? { prompt: prompt.body } : {}),
        ...(agent.primaryHarness ? { primaryHarness: agent.primaryHarness as never } : {}),
        accent: agent.accent,
      },
      sourceOf(actor),
    );
    for (const p of profiles) {
      // Widening values are the source owner's to give their own machines.
      // Copied only by the owner in a browser, who is then deciding it again for
      // the copy; anyone else gets the profile without them.
      const carries = access.owner && mayApproveWidening(actor, actor.user.id);
      const settings =
        p.harness === 'default' || carries
          ? p.settings
          : withoutWideningValues(p.harness as never, p.settings).settings;
      await tx.insert(schema.agentProfiles).values({
        agentId: row.id,
        harness: p.harness,
        settings,
        approvedWidening:
          carries && p.harness !== 'default' ? wideningValues(p.harness as never, p.settings) : {},
        addendum: p.addendum,
        updatedBy: actor.user.id,
      });
    }
    await insertBriefs(tx, actor, row.id, briefs, sourceOf(actor));
    return row;
  });
  await recordAudit(actor, 'repo_agent.duplicate', 'repo_agent', row.id, { from: agent.id });
  return reloaded(actor, row.id);
}

export async function setArchived(
  actor: Actor,
  idOrSlug: string,
  archived: boolean,
): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Archiving an agent takes it away from every device that loads it. Ask the user to do it in On My Radar.',
  );
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  await getDb()
    .update(schema.repoAgents)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.repoAgents.id, access.agent.id));
  await recordAudit(
    actor,
    archived ? 'repo_agent.archive' : 'repo_agent.unarchive',
    'repo_agent',
    access.agent.id,
  );
  return reloaded(actor, access.agent.id);
}

export async function deleteRepoAgent(actor: Actor, idOrSlug: string): Promise<void> {
  assertHumanDecision(
    actor,
    'Deleting an agent destroys its prompt history and every memory. Ask the user to do it in On My Radar.',
  );
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  await getDb().transaction(async (tx) => {
    // Deleting nulls `agent_id` on every credential minted for the agent (SET
    // NULL), which would hand each one the owner's full reach back. They die with
    // the agent instead; `agent_bound` (0087) keeps any that slip through — a raw
    // delete — read-only. Load sessions go with the row (ON DELETE CASCADE).
    const id = access.agent.id;
    await revokeAgentCredentials(tx, id);
    // A carrier of a limited agent was revoked above, inside the agent's lock. What is left
    // names an agent that never limited anybody; those rows go, and a row of a limited one
    // would be kept (as NULL) and refuse its credential, rather than let it go unrestricted.
    await tx.execute(sql`
      DELETE FROM connection_agent_fences f
       USING agents a
       WHERE f.agent_id = ${id}::uuid AND a.id = f.agent_id AND a.radar_scope <> 'selected'`);
    await tx.delete(schema.repoAgents).where(eq(schema.repoAgents.id, id));
  });
  await recordAudit(actor, 'repo_agent.delete', 'repo_agent', access.agent.id, {
    slug: access.agent.slug,
  });
}

/* --------------------------------- prompts -------------------------------- */

type PromptRow = typeof schema.repoAgentPrompts.$inferSelect;

function promptDto(
  row: Omit<PromptRow, 'agentId' | 'sessionId' | 'body' | 'editorAgentId'> & {
    body?: string;
    editorAgentId?: string | null;
  },
  authors: Map<string, string | null>,
  verdict: HarnessVerdict,
  editors: Map<string, string> = new Map(),
): PromptVersionDto {
  return {
    ...verdict,
    version: row.version,
    status: row.status,
    basedOn: row.basedOn,
    note: row.note,
    author: row.authorId ? { id: row.authorId, name: authors.get(row.authorId) ?? null } : null,
    editorAgent:
      row.editorAgentId && editors.has(row.editorAgentId)
        ? { id: row.editorAgentId, name: editors.get(row.editorAgentId) as string }
        : null,
    source: row.source,
    clientLabel: row.clientLabel,
    harness: row.harness,
    createdAt: row.createdAt.toISOString(),
    ...(row.body === undefined ? {} : { body: row.body }),
  };
}

async function promptAuthors(rows: Array<{ authorId: string | null }>) {
  const ids = [...new Set(rows.map((r) => r.authorId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map<string, string | null>();
  const users = await getDb()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Names of the agents that wrote these versions, when they said which. */
async function promptEditors(rows: Array<{ editorAgentId?: string | null }>) {
  const ids = [...new Set(rows.map((r) => r.editorAgentId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map<string, string>();
  const agents = await getDb()
    .select({ id: schema.repoAgents.id, name: schema.repoAgents.name })
    .from(schema.repoAgents)
    .where(inArray(schema.repoAgents.id, ids));
  return new Map(agents.map((a) => [a.id, a.name]));
}

/**
 * Refuse an agent (not a person) looping on a prompt. Its live edits and the proposals it has
 * made (unless the owner accepted them, which is already a live edit) share one daily bound.
 */
async function assertAgentMayEditPrompt(tx: Tx, actor: Actor, agent: RepoAgentRow): Promise<void> {
  if (isPerson(actor)) return;
  const [recent] = await tx
    .execute<{ n: number }>(
      sql`
    SELECT (SELECT count(*)::int FROM agent_prompts
             WHERE agent_id = ${agent.id}::uuid AND source = 'agent'
               AND created_at > now() - interval '1 day')
         + (SELECT count(*)::int FROM agent_prompt_proposals
             WHERE agent_id = ${agent.id}::uuid AND status <> 'accepted'
               AND created_at > now() - interval '1 day') AS n`,
    )
    .then((r) => r.rows);
  if ((recent?.n ?? 0) >= AGENT_REPO.agentPromptVersionsPerDay) {
    throw tooManyRequests(
      `Agents have written ${AGENT_REPO.agentPromptVersionsPerDay} versions or proposals for '${agent.slug}'’s prompt today. ` +
        'That is a bound on a loop, not a quota — stop and check with the person.',
      3600,
    );
  }
}

const isPerson = isPersonAtScreen;

/**
 * Who is making this edit, as far as the server can tell, the way `writeAsAgent` resolves a
 * session: the agent that session was opened for (which may be another agent than the one being
 * edited), else the agent the credential was minted for, else nobody. A person is never an
 * agent. `sessionForWrite` alone refuses a session opened for another agent, which left a
 * sibling's edit unidentified.
 */
async function resolveEditor(actor: Actor, target: RepoAgentRow, sessionId: string | undefined) {
  if (isPerson(actor)) {
    const session = sessionId ? await sessionForWrite(actor, target, sessionId) : null;
    return { session, editorId: null };
  }
  const as = await writeAsAgent(actor, sessionId);
  const [session] = sessionId
    ? await getDb()
        .select()
        .from(schema.repoAgentSessions)
        .where(eq(schema.repoAgentSessions.id, sessionId))
        .limit(1)
    : [];
  return { session: session ?? null, editorId: as.agent?.agentId ?? null };
}

/** The next version of the prompt, live: supersede the old one, record who, move the pointer. */
async function publishPrompt(
  tx: Tx,
  actor: Actor,
  agent: RepoAgentRow,
  values: Omit<Parameters<typeof insertPromptVersion>[3], 'version'>,
) {
  const [top] = await tx
    .select({ v: max(schema.repoAgentPrompts.version) })
    .from(schema.repoAgentPrompts)
    .where(eq(schema.repoAgentPrompts.agentId, agent.id));
  const version = (top?.v ?? 0) + 1;
  await tx
    .update(schema.repoAgentPrompts)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(schema.repoAgentPrompts.agentId, agent.id),
        eq(schema.repoAgentPrompts.status, 'live'),
      ),
    );
  await insertPromptVersion(tx, actor, agent.id, { ...values, version });
  await tx
    .update(schema.repoAgents)
    .set({ promptVersion: version, updatedAt: new Date() })
    .where(eq(schema.repoAgents.id, agent.id));
  const [row] = await tx
    .select()
    .from(schema.repoAgentPrompts)
    .where(
      and(
        eq(schema.repoAgentPrompts.agentId, agent.id),
        eq(schema.repoAgentPrompts.version, version),
      ),
    );
  return must(row, 'the row it just wrote');
}

function staleEdit(live: number, basedOn: number) {
  return conflict(
    `The live prompt is v${live}; this edit started from v${basedOn}. ` +
      'Read the live version and redo the edit against it.',
  );
}

/**
 * Edit the prompt (ADR-0031). A person's edit is live at once. An identified agent's edit to
 * ANOTHER agent's prompt (Lulu re-prompting HR) is live only when the owner opted that agent in
 * (`agentEditsLive`) and has not locked it, with a note in Activity naming both. Everything else
 * an agent does is a PROPOSAL, answered with `{ proposalId }`, and the live prompt does not move
 * until the owner accepts it: an agent editing its own prompt (one injected comment would become
 * a standing order), an edit from a connection that did not say which agent it is, an edit to an
 * agent that did not opt in, and any agent edit under the lock. Bounded by a daily count and by
 * three proposals waiting at once.
 *
 * Optimistic concurrency, the dashboard rule: `basedOn` must be the live version, checked under
 * a row lock, or the edit is a 409 — that is two devices not overwriting each other.
 */
export async function updatePrompt(
  actor: Actor,
  idOrSlug: string,
  input: UpdatePromptInput,
): Promise<PromptVersionDto | PromptProposedDto> {
  const access = await requireRepoAgent(idOrSlug, actor, 'prompt');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing its prompt.');
  const { session, editorId } = await resolveEditor(actor, access.agent, input.session);

  const result = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    await assertAgentMayEditPrompt(tx, actor, agent);
    if (input.basedOn !== agent.promptVersion) throw staleEdit(agent.promptVersion, input.basedOn);
    // Every condition is read now, under the row lock: a lock or a disable that committed while
    // this waited holds the edit.
    if (agent.archivedAt) throw conflict('Restore this agent before changing its prompt.');
    const held =
      !isPerson(actor) &&
      (editorId === null ||
        editorId === agent.id ||
        agent.lockPrompt ||
        !(await agentOpenToEdits(tx, agent.id)));
    if (held) {
      const [waiting] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.repoAgentPromptProposals)
        .where(
          and(
            eq(schema.repoAgentPromptProposals.agentId, agent.id),
            eq(schema.repoAgentPromptProposals.status, 'pending'),
          ),
        );
      if ((waiting?.n ?? 0) >= AGENT_REPO.promptProposalsPending) {
        throw tooManyRequests(
          `'${agent.slug}' already has ${AGENT_REPO.promptProposalsPending} prompt changes waiting for its owner. ` +
            'Stop and tell the person; they accept or reject them in On My Radar.',
          3600,
        );
      }
      const [proposal] = await tx
        .insert(schema.repoAgentPromptProposals)
        .values({
          agentId: agent.id,
          basedOn: input.basedOn,
          body: input.body,
          note: input.note ?? '',
          editorAgentId: editorId,
          authorId: actor.user.id,
          sessionId: session?.id ?? null,
          harness: session?.harness ?? null,
          clientLabel: connectionOf(actor).label,
        })
        .returning({ id: schema.repoAgentPromptProposals.id });
      return { proposalId: must(proposal, 'the proposal it just wrote').id };
    }
    return publishPrompt(tx, actor, agent, {
      body: input.body,
      basedOn: input.basedOn,
      note: input.note,
      source: isPerson(actor) ? 'human' : 'agent',
      sessionId: session?.id ?? null,
      harness: session?.harness ?? null,
      editorAgentId: editorId,
    });
  });
  if ('proposalId' in result) {
    await recordAudit(actor, 'repo_agent.prompt.propose', 'repo_agent', access.agent.id, {
      proposal: result.proposalId,
      editor: editorId,
    });
    return result;
  }
  await recordAudit(actor, 'repo_agent.prompt.live', 'repo_agent', access.agent.id, {
    version: result.version,
    byAgent: !isPerson(actor),
    editor: editorId,
  });
  const { body: _body, ...meta } = result;
  return promptDto(
    meta,
    await promptAuthors([result]),
    await harnessVerdict(result),
    await promptEditors([result]),
  );
}

/* ---------------------------- prompt proposals ---------------------------- */

/**
 * Accepting or rejecting a held prompt change, and letting other agents edit live, are the
 * owner's decisions, made in a browser. The signed-in cookie, not "a user-kind actor": a session token presented as a bearer, or one used
 * over /mcp, is a credential an agent could hold (the C2 lesson, `releaseComment`).
 */
function assertBrowserOwner(actor: Actor, message: string) {
  assertHumanDecision(actor, message);
  if (!actor.viaCookie || actor.invocation === 'mcp') throw forbidden(message);
}

function assertOwnerReview(actor: Actor) {
  assertBrowserOwner(
    actor,
    'Accepting or rejecting a prompt change is the owner’s review, done in On My Radar while signed in in a browser — not by an agent or a token.',
  );
}

/** Ownership was checked before the lock; a transfer can land while this waited for it. */
function assertStillOwner(actor: Actor, agent: RepoAgentRow) {
  if (agent.ownerId !== actor.user.id) throw notFound('Agent not found');
}

type ProposalRow = typeof schema.repoAgentPromptProposals.$inferSelect;

async function lockedPendingProposal(tx: Tx, agentId: string, proposalId: string) {
  const [row] = await tx
    .select()
    .from(schema.repoAgentPromptProposals)
    .where(
      and(
        eq(schema.repoAgentPromptProposals.id, proposalId),
        eq(schema.repoAgentPromptProposals.agentId, agentId),
      ),
    )
    .for('update');
  if (!row) throw notFound('Proposal not found');
  if (row.status !== 'pending') throw conflict(`That change was already ${row.status}.`);
  return row;
}

/** The changes waiting for the owner's review, oldest first, with their bodies. */
export async function listPromptProposals(
  actor: Actor,
  idOrSlug: string,
): Promise<PromptProposalDto[]> {
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'prompt');
  const t = schema.repoAgentPromptProposals;
  const rows = await getDb()
    .select()
    .from(t)
    .where(and(eq(t.agentId, agent.id), eq(t.status, 'pending')))
    .orderBy(asc(t.createdAt));
  const authors = await promptAuthors(rows);
  const editors = rows.some((r) => r.editorAgentId)
    ? await getDb()
        .select({ id: schema.repoAgents.id, name: schema.repoAgents.name })
        .from(schema.repoAgents)
        .where(
          inArray(
            schema.repoAgents.id,
            rows.map((r) => r.editorAgentId).filter((id): id is string => Boolean(id)),
          ),
        )
    : [];
  return rows.map((r: ProposalRow) => ({
    id: r.id,
    basedOn: r.basedOn,
    stale: r.basedOn !== agent.promptVersion,
    body: r.body,
    note: r.note,
    author: r.authorId ? { id: r.authorId, name: authors.get(r.authorId) ?? null } : null,
    editorAgent: editors.find((e) => e.id === r.editorAgentId) ?? null,
    harness: r.harness,
    clientLabel: r.clientLabel,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Make a held change the live prompt: version N+1, under the same row lock every edit takes. */
export async function acceptPromptProposal(
  actor: Actor,
  idOrSlug: string,
  proposalId: string,
): Promise<PromptVersionDto> {
  assertOwnerReview(actor);
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  const created = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    assertStillOwner(actor, agent);
    const proposal = await lockedPendingProposal(tx, agent.id, proposalId);
    if (proposal.basedOn !== agent.promptVersion)
      throw staleEdit(agent.promptVersion, proposal.basedOn);
    const row = await publishPrompt(tx, actor, agent, {
      body: proposal.body,
      basedOn: proposal.basedOn,
      note: proposal.note,
      source: 'agent',
      sessionId: proposal.sessionId,
      harness: proposal.harness,
      clientLabel: proposal.clientLabel,
      authorId: proposal.authorId,
      editorAgentId: proposal.editorAgentId,
    });
    await tx
      .update(schema.repoAgentPromptProposals)
      .set({
        status: 'accepted',
        decidedBy: actor.user.id,
        decidedAt: new Date(),
        version: row.version,
      })
      .where(eq(schema.repoAgentPromptProposals.id, proposal.id));
    return row;
  });
  await recordAudit(actor, 'repo_agent.prompt.accept', 'repo_agent', access.agent.id, {
    proposal: proposalId,
    version: created.version,
  });
  return promptDto(
    created,
    await promptAuthors([created]),
    await harnessVerdict(created),
    await promptEditors([created]),
  );
}

export async function rejectPromptProposal(
  actor: Actor,
  idOrSlug: string,
  proposalId: string,
): Promise<void> {
  assertOwnerReview(actor);
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    assertStillOwner(actor, agent);
    const proposal = await lockedPendingProposal(tx, agent.id, proposalId);
    await tx
      .update(schema.repoAgentPromptProposals)
      .set({ status: 'rejected', decidedBy: actor.user.id, decidedAt: new Date() })
      .where(eq(schema.repoAgentPromptProposals.id, proposal.id));
  });
  await recordAudit(actor, 'repo_agent.prompt.reject', 'repo_agent', access.agent.id, {
    proposal: proposalId,
  });
}

/**
 * An agent's prompt history, newest first, a page at a time and without the
 * bodies. Keyset on `version`, which is unique per agent and an integer.
 */
export async function listPromptVersions(
  actor: Actor,
  idOrSlug: string,
  input: PromptHistoryInput = {},
): Promise<PromptHistoryPageDto> {
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'read');
  const limit = input.limit ?? AGENT_REPO.promptHistoryPage;
  let before: number | null = null;
  if (input.cursor) {
    const parsed = decodeCursor(input.cursor);
    const version = parsed?.['version'];
    if (!isCursorInt(version)) throw badRequest('Invalid cursor');
    before = version;
  }
  const t = schema.repoAgentPrompts;
  const rows = await getDb()
    .select({
      version: t.version,
      status: t.status,
      basedOn: t.basedOn,
      note: t.note,
      authorId: t.authorId,
      editorAgentId: t.editorAgentId,
      source: t.source,
      clientLabel: t.clientLabel,
      harness: t.harness,
      sessionId: t.sessionId,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(eq(t.agentId, agent.id), before === null ? undefined : lt(t.version, before)))
    .orderBy(desc(t.version))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const authors = await promptAuthors(page);
  const editors = await promptEditors(page);
  const verdicts = await harnessVerdicts(page);
  const last = page.at(-1);
  return {
    versions: page.map((row, i) => promptDto(row, authors, verdicts[i] as HarnessVerdict, editors)),
    nextCursor: rows.length > limit && last ? encodeCursor({ version: last.version }) : null,
  };
}

/**
 * One version with its body. Absent `version` means the one the caller runs:
 * live for the owner and followers, the accepted one for a pinned recipient.
 */
export async function getPromptVersion(
  actor: Actor,
  idOrSlug: string,
  version?: number,
): Promise<PromptVersionDto> {
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  const { agent } = access;
  const pinned =
    access.recipient && !access.recipient.followUpdates ? access.recipient.acceptedVersion : null;
  const wanted = version ?? pinned ?? agent.promptVersion;
  if (pastPin(actor, wanted, pinned)) {
    throw forbidden(
      `You run v${pinned ?? 0} of '${agent.slug}', the version you accepted. v${wanted} is newer: the person can review it and take the update in On My Radar.`,
    );
  }
  const [row] = await getDb()
    .select()
    .from(schema.repoAgentPrompts)
    .where(
      and(
        eq(schema.repoAgentPrompts.agentId, agent.id),
        eq(schema.repoAgentPrompts.version, wanted),
      ),
    )
    .limit(1);
  if (!row)
    throw notFound(wanted === 0 ? 'This agent has no prompt yet' : `No prompt version ${wanted}`);
  return promptDto(
    row,
    await promptAuthors([row]),
    await harnessVerdict(row),
    await promptEditors([row]),
  );
}

/* ------------------------------ tool profiles ----------------------------- */

type ProfileRow = typeof schema.agentProfiles.$inferSelect;

async function profileDto(row: ProfileRow): Promise<ProfileDto> {
  const authors = await promptAuthors([{ authorId: row.updatedBy }]);
  const harness = row.harness as ProfileKey;
  return {
    harness,
    settings: row.settings,
    addendum: row.addendum,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy
      ? { id: row.updatedBy, name: authors.get(row.updatedBy) ?? null }
      : null,
    ...profileSummary(harness, row.settings),
  };
}

export async function listProfiles(actor: Actor, idOrSlug: string): Promise<ProfileDto[]> {
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'read');
  const rows = await getDb()
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.agentId, agent.id))
    .orderBy(asc(schema.agentProfiles.harness));
  return Promise.all(rows.map(profileDto));
}

async function upsertProfile(
  tx: Tx,
  actor: Actor,
  agent: Pick<RepoAgentRow, 'id' | 'ownerId'>,
  harness: ProfileKey,
  settings: ProfileSettings,
  addendum?: string,
  expectedRevision?: number,
): Promise<ProfileRow> {
  const agentId = agent.id;
  // The guard. `settings` replaces the stored object wholesale, so the approval
  // is replaced with it: a value is approved exactly when the owner's browser
  // session saved it, and a save by anyone else can carry none.
  const widening = harness === 'default' ? {} : wideningValues(harness, settings);
  if (Object.keys(widening).length > 0 && !mayApproveWidening(actor, agent.ownerId)) {
    throw wideningRefusal();
  }
  const approvedWidening = widening;
  const [current] = await tx
    .select()
    .from(schema.agentProfiles)
    .where(
      and(eq(schema.agentProfiles.agentId, agentId), eq(schema.agentProfiles.harness, harness)),
    )
    .for('update')
    .limit(1);
  if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
    throw conflict(
      `This profile changed since you read it (revision ${current.revision}, not ${expectedRevision}). Reload and retry.`,
    );
  }
  if (current) {
    const [row] = await tx
      .update(schema.agentProfiles)
      .set({
        settings,
        approvedWidening,
        ...(addendum !== undefined ? { addendum } : {}),
        revision: current.revision + 1,
        updatedBy: actor.user.id,
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.agentProfiles.agentId, agentId), eq(schema.agentProfiles.harness, harness)),
      )
      .returning();
    return must(row, 'the profile it just wrote');
  }
  const [row] = await tx
    .insert(schema.agentProfiles)
    .values({
      agentId,
      harness,
      settings,
      approvedWidening,
      addendum: addendum ?? '',
      updatedBy: actor.user.id,
    })
    .returning();
  return must(row, 'the profile it just wrote');
}

/**
 * An agent's tool profile is part of its prompt (its addendum is loaded with it) and can widen
 * what its tool may do, so an agent never sets its own, and one that did not say which agent it
 * is (no load session) is not trusted with another's. A person is not refused here. What the
 * owner can change at any moment (the lock, the opt-in) is read under the row lock, by
 * `assertProfileOpenToAgents`. Briefs are unchanged.
 */
async function refuseUnsafeProfileEdit(actor: Actor, agent: RepoAgentRow, session?: string) {
  if (isPerson(actor)) return;
  const { editorId } = await resolveEditor(actor, agent, session);
  if (editorId === agent.id)
    throw forbidden(
      `An agent can’t change its own tool profile: '${agent.slug}' would be setting what its tools may do. Ask the person to change it in On My Radar.`,
    );
  if (editorId === null)
    throw forbidden(
      'Say which agent is changing this tool profile: pass the session load_agent returned. An agent can’t change its own tool profile.',
    );
}

/**
 * Another agent changes a profile only on an agent that is neither locked (its addenda are
 * instructions like the prompt) nor closed to live edits by its owner (ADR-0031). Called under
 * the agent's row lock, so a lock or a disable that committed while the write queued still wins.
 */
async function assertProfileOpenToAgents(tx: Tx, actor: Actor, agent: RepoAgentRow) {
  if (isPerson(actor)) return;
  if (agent.archivedAt) throw conflict('Restore this agent before changing it.');
  if (agent.lockPrompt)
    throw forbidden(`'${agent.slug}'’s prompt is locked, and a tool profile is part of it.`);
  if (!(await agentOpenToEdits(tx, agent.id)))
    throw forbidden(
      `'${agent.slug}' does not let other agents change it live, and a tool profile is part of it. Ask the person to change it in On My Radar.`,
    );
}

/**
 * Create or replace one tool's profile. Part of the prompt for access: prompt
 * edit changes it, and a locked prompt locks its addenda against agents too —
 * an addendum is instructions like the prompt is.
 */
export async function setProfile(
  actor: Actor,
  idOrSlug: string,
  rawHarness: string,
  input: SetProfileInput,
): Promise<ProfileDto> {
  const harness: ProfileKey | null =
    rawHarness === 'default' ? 'default' : resolveHarness(rawHarness);
  if (!harness) throw badRequest(`'${rawHarness}' is not a tool a profile can be for.`);
  const access = await requireRepoAgent(idOrSlug, actor, 'prompt');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing it.');
  const checked = validateProfileSettings(harness, input.settings);
  if (!checked.ok) throw badRequest(checked.message);
  await refuseUnsafeProfileEdit(actor, access.agent, input.session);
  const row = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    await assertProfileOpenToAgents(tx, actor, agent);
    return upsertProfile(
      tx,
      actor,
      agent,
      harness,
      checked.value,
      input.addendum,
      input.expectedRevision,
    );
  });
  await recordAudit(actor, 'repo_agent.profile', 'repo_agent', access.agent.id, { harness });
  return profileDto(row);
}

export async function removeProfile(
  actor: Actor,
  idOrSlug: string,
  rawHarness: string,
  session?: string,
): Promise<void> {
  const harness: ProfileKey | null =
    rawHarness === 'default' ? 'default' : resolveHarness(rawHarness);
  if (!harness) throw badRequest(`'${rawHarness}' is not a tool a profile can be for.`);
  const access = await requireRepoAgent(idOrSlug, actor, 'prompt');
  await refuseUnsafeProfileEdit(actor, access.agent, session);
  const removed = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    await assertProfileOpenToAgents(tx, actor, agent);
    return tx
      .delete(schema.agentProfiles)
      .where(
        and(eq(schema.agentProfiles.agentId, agent.id), eq(schema.agentProfiles.harness, harness)),
      )
      .returning({ harness: schema.agentProfiles.harness });
  });
  if (removed.length === 0) throw notFound('No profile for that tool');
  await recordAudit(actor, 'repo_agent.profile.remove', 'repo_agent', access.agent.id, { harness });
}

/* ---------------------------------- briefs -------------------------------- */

/*
  A brief is the third layer of an agent, beside its prompt and its memory: the
  facts about the product it works on. On My Radar is their source of truth
  (blip 2e15ad9d). For access a brief is part of the prompt — reading one needs
  what reading the prompt needs, writing one needs prompt edit, the owner's lock
  stops agents writing them, and a recipient runs what they accepted
  (`briefIndex`). A brief of another agent is read by naming that agent: access
  is the person's, so qa-reviewer reads commander's brief exactly when the
  person running it could read commander.
*/

type BriefRow = typeof schema.agentBriefs.$inferSelect;
type BriefRevisionRow = typeof schema.agentBriefRevisions.$inferSelect;

/** A brief's name, checked here so every transport gets the same sentence. */
function briefName(raw: string): string {
  const parsed = briefNameSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`'${raw}' is not a brief name: lower-case letters, digits and hyphens.`);
  }
  return parsed.data;
}

async function briefDto(revision: BriefRevisionRow, brief: BriefRow): Promise<BriefDto> {
  const authors = await promptAuthors([revision]);
  const stale = await staleForBriefs([brief]);
  return {
    ...(await harnessVerdict(revision)),
    name: brief.name,
    description: revision.description,
    revision: revision.revision,
    updatedAt: revision.createdAt.toISOString(),
    newerRevision: brief.revision > revision.revision ? brief.revision : null,
    stale: stale.get(brief.id) ?? null,
    body: revision.body,
    note: revision.note,
    source: revision.source,
    author: revision.authorId
      ? { id: revision.authorId, name: authors.get(revision.authorId) ?? null }
      : null,
    harness: revision.harness,
    clientLabel: revision.clientLabel,
  };
}

/** One brief's current row, or the 404 every transport words the same way. */
async function briefRow(
  db: Pick<Db, 'select'>,
  agent: Pick<RepoAgentRow, 'id' | 'slug'>,
  name: string,
): Promise<BriefRow> {
  const [brief] = await db
    .select()
    .from(schema.agentBriefs)
    .where(and(eq(schema.agentBriefs.agentId, agent.id), eq(schema.agentBriefs.name, name)))
    .limit(1);
  if (!brief) throw notFound(`'${agent.slug}' has no brief called '${name}'.`);
  return brief;
}

/**
 * The revision of one brief the caller runs, and the pin it is held at — null
 * for the owner and for a recipient who follows. A brief added since a pinned
 * recipient accepted does not exist for their connection; the person may still
 * reach it by number (or through its history) to review it.
 */
async function runningRevision(
  actor: Actor,
  access: RepoAgentAccess,
  name: string,
  byDefault: boolean,
): Promise<{ running: BriefIndexEntryDto | undefined; pinned: number | null }> {
  const [running] = await briefIndex(access, actor.user.id, name);
  if (!running && (byDefault || actor.kind !== 'user')) {
    throw notFound(
      `'${name}' was added to '${access.agent.slug}' after you accepted it. The person can review it and take the update in On My Radar.`,
    );
  }
  const pinned =
    running && access.recipient && !access.recipient.followUpdates ? running.revision : null;
  return { running, pinned };
}

/** The agent's briefs as the caller runs them, without bodies. */
export async function listBriefs(actor: Actor, idOrSlug: string): Promise<BriefIndexEntryDto[]> {
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertAccepted(access);
  return briefIndex(access, actor.user.id);
}

/**
 * One brief with its body: the revision the caller runs (live, or as it stood
 * when a pinned recipient accepted), or another `revision` by number. A pinned
 * recipient's connection gets nothing past the pin — no newer revision and no
 * brief added since (`pastPin`); the person may read them to review.
 */
export async function getBrief(
  actor: Actor,
  idOrSlug: string,
  rawName: string,
  revision?: number,
): Promise<BriefDto> {
  const name = briefName(rawName);
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertAccepted(access);
  const { agent } = access;
  const db = getDb();
  const brief = await briefRow(db, agent, name);
  const { running, pinned } = await runningRevision(actor, access, name, revision === undefined);
  const wanted = revision ?? must(running, 'the running revision').revision;
  if (pastPin(actor, wanted, pinned)) {
    throw forbidden(
      `You run r${pinned ?? 0} of '${name}', as it stood when you accepted '${agent.slug}'. r${wanted} is newer: the person can review it and take the update in On My Radar.`,
    );
  }
  const [row] = await db
    .select()
    .from(schema.agentBriefRevisions)
    .where(
      and(
        eq(schema.agentBriefRevisions.briefId, brief.id),
        eq(schema.agentBriefRevisions.revision, wanted),
      ),
    )
    .limit(1);
  if (!row) throw notFound(`'${name}' has no revision ${wanted}.`);
  return briefDto(row, brief);
}

/** Brief writes are 'human' only from a person (the cookie), as prompt edits are. */
const briefSource = (actor: Actor): 'human' | 'agent' => (isPerson(actor) ? 'human' : 'agent');

/** Refuse an agent (not a person) writing a brief of a locked agent, or looping. */
async function assertAgentMayEditBrief(tx: Tx, actor: Actor, agent: RepoAgentRow): Promise<void> {
  if (isPerson(actor)) return;
  if (agent.lockPrompt) {
    throw forbidden(
      `'${agent.slug}'’s prompt is locked, and its briefs with it: agents can’t change them. Suggest the change to the person instead.`,
    );
  }
  // Renames count with revisions: the bound is on an agent changing briefs in
  // a loop, whichever way it changes them.
  const recent = await tx.execute<{ n: number }>(sql`
    SELECT ((SELECT count(*) FROM agent_brief_revisions r
              JOIN agent_briefs b ON b.id = r.brief_id
             WHERE b.agent_id = ${agent.id}::uuid AND r.source = 'agent'
               AND r.created_at > now() - interval '1 day')
         + (SELECT count(*) FROM agent_brief_events e
             WHERE e.agent_id = ${agent.id}::uuid AND e.source = 'agent'
               AND e.created_at > now() - interval '1 day'))::int AS n`);
  if ((recent.rows[0]?.n ?? 0) >= AGENT_REPO.agentBriefRevisionsPerDay) {
    throw tooManyRequests(
      `Agents have changed briefs ${AGENT_REPO.agentBriefRevisionsPerDay} times for '${agent.slug}' today. ` +
        'That is a bound on a loop, not a quota — stop and check with the person.',
      3600,
    );
  }
}

async function insertBriefRevision(
  tx: Pick<Db, 'insert'>,
  actor: Actor,
  brief: BriefRow,
  values: {
    note?: string | undefined;
    session?: { id: string; harness: string | null; clientLabel: string | null } | null;
  } = {},
): Promise<BriefRevisionRow> {
  const [row] = await tx
    .insert(schema.agentBriefRevisions)
    .values({
      briefId: brief.id,
      revision: brief.revision,
      description: brief.description,
      body: brief.body,
      note: values.note ?? '',
      source: brief.source,
      authorId: actor.user.id,
      sessionId: values.session?.id ?? null,
      clientLabel: values.session?.clientLabel ?? connectionOf(actor).label,
      harness: values.session?.harness ?? null,
      // The brief's `updated_at` is `now()` in the same transaction, so the two
      // are one instant — what the recipient pin compares against.
      createdAt: sql`now()`,
    })
    .returning();
  return must(row, 'the revision it just wrote');
}

/**
 * Create or update one brief. Without `expectedRevision` it creates, and a name
 * that exists is a 409 naming its revision; with one it updates, and a stale
 * revision is a 409 carrying the current body to merge — the memory rule, so
 * two devices never overwrite each other. Every refusal lands before the first
 * write: the agent row is locked first, which also serialises the count
 * against `briefsPerAgent`.
 */
export async function updateBrief(
  actor: Actor,
  idOrSlug: string,
  rawName: string,
  input: UpdateBriefInput,
): Promise<{ brief: BriefDto; created: boolean }> {
  const name = briefName(rawName);
  const access = await requireRepoAgent(idOrSlug, actor, 'prompt');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing its briefs.');
  // A connection writes inside a load session of *this* agent, as memory does,
  // so every agent-written revision names its tool and session. A brief of
  // another agent is changed from a session of that agent.
  const session = await sessionForWrite(actor, access.agent, input.session);
  const source = briefSource(actor);

  const result = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    await assertAgentMayEditBrief(tx, actor, agent);
    const [existing] = await tx
      .select()
      .from(schema.agentBriefs)
      .where(and(eq(schema.agentBriefs.agentId, agent.id), eq(schema.agentBriefs.name, name)))
      .limit(1);

    if (!existing) {
      if (input.expectedRevision !== undefined) {
        throw notFound(
          `'${agent.slug}' has no brief called '${name}'. Leave out expectedRevision to create it.`,
        );
      }
      if (!input.description) throw badRequest('A new brief needs a one-line description.');
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.agentBriefs)
        .where(eq(schema.agentBriefs.agentId, agent.id));
      if ((count?.n ?? 0) >= AGENT_REPO.briefsPerAgent) {
        throw conflict(
          `'${agent.slug}' already has ${AGENT_REPO.briefsPerAgent} briefs. Fold this into one of them.`,
        );
      }
      const [row] = await tx
        .insert(schema.agentBriefs)
        .values({
          agentId: agent.id,
          name,
          description: input.description,
          body: input.body,
          source,
          authorId: actor.user.id,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .returning();
      const brief = must(row, 'the brief it just wrote');
      return {
        brief,
        revision: await insertBriefRevision(tx, actor, brief, { note: input.note, session }),
        created: true,
      };
    }

    if (input.expectedRevision === undefined) {
      throw conflict(
        `A brief called '${name}' already exists at revision ${existing.revision}. ` +
          `Read it with get_agent_brief and update it with expectedRevision ${existing.revision}.`,
      );
    }
    if (input.expectedRevision !== existing.revision) {
      throw conflict(
        `Brief '${name}' is at revision ${existing.revision}, not ${input.expectedRevision}. ` +
          `Merge your change into its current body and retry with expectedRevision ${existing.revision}.\n\n` +
          `--- current body (r${existing.revision}) ---\n${existing.body}`,
      );
    }
    const [row] = await tx
      .update(schema.agentBriefs)
      .set({
        body: input.body,
        description: input.description ?? existing.description,
        revision: existing.revision + 1,
        source,
        authorId: actor.user.id,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.agentBriefs.id, existing.id))
      .returning();
    const brief = must(row, 'the brief it just wrote');
    return {
      brief,
      revision: await insertBriefRevision(tx, actor, brief, { note: input.note, session }),
      created: false,
    };
  });

  await recordAudit(
    actor,
    result.created ? 'repo_agent.brief.create' : 'repo_agent.brief.update',
    'repo_agent',
    access.agent.id,
    { brief: name, revision: result.brief.revision, session: session?.id ?? null },
  );
  return {
    brief: await briefDto(result.revision, result.brief),
    created: result.created,
  };
}

/**
 * One brief's revisions, newest first, without bodies — its history. A pinned
 * recipient's connection sees nothing past the revision it runs, exactly as
 * `getBrief` refuses it one by number; the person sees them all, because
 * reviewing what they would update to is what the pin is for.
 */
export async function listBriefRevisions(
  actor: Actor,
  idOrSlug: string,
  rawName: string,
  input: BriefRevisionsInput,
): Promise<BriefRevisionPageDto> {
  const name = briefName(rawName);
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertAccepted(access);
  const db = getDb();
  const brief = await briefRow(db, access.agent, name);
  const { pinned } = await runningRevision(actor, access, name, false);
  const ceiling = actor.kind !== 'user' ? pinned : null;
  let before: number | null = null;
  if (input.cursor) {
    const revision = decodeCursor(input.cursor)?.['revision'];
    if (!isCursorInt(revision)) throw badRequest('Invalid cursor');
    before = revision;
  }
  const rows = await db
    .select()
    .from(schema.agentBriefRevisions)
    .where(
      and(
        eq(schema.agentBriefRevisions.briefId, brief.id),
        before === null ? undefined : lt(schema.agentBriefRevisions.revision, before),
        ceiling === null ? undefined : lte(schema.agentBriefRevisions.revision, ceiling),
      ),
    )
    .orderBy(desc(schema.agentBriefRevisions.revision))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const authors = await promptAuthors(page);
  const verdicts = await harnessVerdicts(page);
  const last = page.at(-1);
  return {
    revisions: page.map((r, i) => ({
      ...(verdicts[i] as HarnessVerdict),
      revision: r.revision,
      description: r.description,
      note: r.note,
      source: r.source,
      author: r.authorId ? { id: r.authorId, name: authors.get(r.authorId) ?? null } : null,
      harness: r.harness,
      clientLabel: r.clientLabel,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > input.limit && last ? encodeCursor({ revision: last.revision }) : null,
  };
}

/**
 * Rename a brief. Its revisions follow it — they belong to the brief, not the
 * name — and nothing it says changes, so no revision is written and nobody
 * pinned is told there is an update: the rename is an event in Activity. It
 * reaches everyone at once, a pinned recipient included, because the name is
 * the brief's and not any revision's. Writing rules are an edit's: prompt
 * edit, a load session of this agent for a connection, the owner's lock, the
 * agents' daily bound.
 */
export async function renameBrief(
  actor: Actor,
  idOrSlug: string,
  rawName: string,
  input: RenameBriefInput,
): Promise<BriefIndexEntryDto> {
  const name = briefName(rawName);
  const newName = briefName(input.newName);
  const access = await requireRepoAgent(idOrSlug, actor, 'prompt');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing its briefs.');
  const session = await sessionForWrite(actor, access.agent, input.session);
  const renamed = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    await assertAgentMayEditBrief(tx, actor, agent);
    const existing = await briefRow(tx, agent, name);
    if (newName === name) throw badRequest(`The brief is already called '${name}'.`);
    const [taken] = await tx
      .select({ id: schema.agentBriefs.id })
      .from(schema.agentBriefs)
      .where(and(eq(schema.agentBriefs.agentId, agent.id), eq(schema.agentBriefs.name, newName)))
      .limit(1);
    if (taken) {
      throw conflict(
        `'${agent.slug}' already has a brief called '${newName}'. Choose another name.`,
      );
    }
    const [row] = await tx
      .update(schema.agentBriefs)
      .set({ name: newName })
      .where(eq(schema.agentBriefs.id, existing.id))
      .returning();
    await tx.insert(schema.agentBriefEvents).values({
      agentId: agent.id,
      op: 'rename',
      name: newName,
      previousName: name,
      revision: existing.revision,
      source: briefSource(actor),
      authorId: actor.user.id,
      sessionId: session?.id ?? null,
      clientLabel: session?.clientLabel ?? connectionOf(actor).label,
      harness: session?.harness ?? null,
    });
    await recordAudit(
      actor,
      'repo_agent.brief.rename',
      'repo_agent',
      agent.id,
      { brief: newName, from: name, session: session?.id ?? null },
      tx,
    );
    return must(row, 'the brief it just renamed');
  });
  return {
    name: renamed.name,
    description: renamed.description,
    revision: renamed.revision,
    updatedAt: renamed.updatedAt.toISOString(),
    newerRevision: null,
    stale: (await staleForBriefs([renamed])).get(renamed.id) ?? null,
  };
}

/**
 * Bind a brief to a path in a GitLab project, or change the binding (§V2.17).
 * The worker then measures how far that path has moved since the brief's
 * revision and, when the binding asks and the server allows, mirrors the brief
 * there by merge request.
 *
 * Human-only and the owner's alone: a binding decides where this server's
 * GitLab credentials are pointed and what a merge request in someone's
 * repository says, which is a decision about credentials, not about the
 * brief's words. And only an administrator's agent may be bound — the tokens
 * are the operator's, so a binding by anyone else would read a private project
 * with somebody else's credential. Refused before the first write.
 */
export async function setBriefBinding(
  actor: Actor,
  idOrSlug: string,
  rawName: string,
  input: BriefBindingInput,
): Promise<BriefStaleDto> {
  assertHumanDecision(
    actor,
    'Binding a brief to a repository points this server’s GitLab credentials at it. Ask the person to bind it on the agent’s Briefs tab in On My Radar.',
  );
  const name = briefName(rawName);
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing its briefs.');
  if (!actor.user.isAdmin) {
    throw forbidden(
      'Repository checks use this server’s GitLab tokens, so only its administrators can bind a brief to a repository.',
    );
  }
  const { brief, row } = await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    const brief = await briefRow(tx, agent, name);
    const [existing] = await tx
      .select()
      .from(schema.agentBriefBindings)
      .where(eq(schema.agentBriefBindings.briefId, brief.id))
      .limit(1);
    const moved =
      !existing ||
      existing.project !== input.project ||
      existing.path !== input.path ||
      existing.ref !== input.ref;
    // A binding pointed somewhere new starts from nothing: what was observed
    // at the old place says nothing about the new one.
    const reset = moved
      ? {
          checkedAt: null,
          checkedRevision: null,
          checkState: null,
          checkError: null,
          commitsBehind: null,
          behindCapped: false,
          landedRevision: null,
          driftKind: null,
          driftSha: null,
          driftTitle: null,
          driftAt: null,
          driftUrl: null,
          mirrorRevision: null,
          mirrorState: null,
          mirrorError: null,
          mirrorMrUrl: null,
        }
      : {};
    const values = {
      project: input.project,
      path: input.path,
      ref: input.ref,
      mirror: input.mirror,
      updatedAt: sql`now()`,
      ...reset,
    };
    const [row] = existing
      ? await tx
          .update(schema.agentBriefBindings)
          .set(values)
          .where(eq(schema.agentBriefBindings.briefId, brief.id))
          .returning()
      : await tx
          .insert(schema.agentBriefBindings)
          .values({ briefId: brief.id, createdBy: actor.user.id, ...values })
          .returning();
    await recordAudit(
      actor,
      existing ? 'repo_agent.brief.rebind' : 'repo_agent.brief.bind',
      'repo_agent',
      agent.id,
      {
        brief: name,
        project: input.project,
        path: input.path,
        ref: input.ref,
        mirror: input.mirror,
      },
      tx,
    );
    return { brief, row: must(row, 'the binding it just wrote') };
  });
  return staleFromRow(row, brief.revision);
}

/** Unbind a brief: no more checks, no more mirroring. Nothing in the repository changes. */
export async function removeBriefBinding(
  actor: Actor,
  idOrSlug: string,
  rawName: string,
): Promise<void> {
  assertHumanDecision(
    actor,
    'Unbinding a brief is the person’s decision. Ask them to do it on the agent’s Briefs tab in On My Radar.',
  );
  const name = briefName(rawName);
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing its briefs.');
  await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    const brief = await briefRow(tx, agent, name);
    const gone = await tx
      .delete(schema.agentBriefBindings)
      .where(eq(schema.agentBriefBindings.briefId, brief.id))
      .returning({ id: schema.agentBriefBindings.briefId });
    if (gone.length === 0) throw notFound(`'${name}' is not bound to a repository.`);
    await recordAudit(
      actor,
      'repo_agent.brief.unbind',
      'repo_agent',
      agent.id,
      { brief: name },
      tx,
    );
  });
}

/**
 * Delete a brief and every revision of it. Irreversible, so a person's act on
 * a real screen and never a connection's — refused here, in the service, so no
 * transport can reach it with an agent's credential — and the owner's alone,
 * as deleting the agent is. It goes for everyone the agent is shared with at
 * once, a pinned recipient included: there is no revision left to pin to. What
 * remains is the event in Activity and the audit row.
 */
export async function deleteBrief(actor: Actor, idOrSlug: string, rawName: string): Promise<void> {
  assertHumanDecision(
    actor,
    'Deleting a brief destroys every revision of it, for everyone the agent is shared with. Ask the person to delete it on the agent’s Briefs tab in On My Radar.',
  );
  const name = briefName(rawName);
  const access = await requireRepoAgent(idOrSlug, actor, 'manage');
  if (access.agent.archivedAt) throw conflict('Restore this agent before changing its briefs.');
  await getDb().transaction(async (tx) => {
    const agent = await lockAgent(tx, access.agent.id);
    await assertAgentMayEditBrief(tx, actor, agent);
    const existing = await briefRow(tx, agent, name);
    await tx.delete(schema.agentBriefs).where(eq(schema.agentBriefs.id, existing.id));
    await tx.insert(schema.agentBriefEvents).values({
      agentId: agent.id,
      op: 'delete',
      name,
      revision: existing.revision,
      source: briefSource(actor),
      authorId: actor.user.id,
      clientLabel: connectionOf(actor).label,
    });
    await recordAudit(
      actor,
      'repo_agent.brief.delete',
      'repo_agent',
      agent.id,
      { brief: name, revision: existing.revision },
      tx,
    );
  });
}

/** The briefs the caller runs, with bodies, for export and duplicate; none before accepting. */
async function acceptedBriefs(
  access: RepoAgentAccess,
  userId: string,
): Promise<ImportAgentInput['briefs']> {
  if (!access.owner && !access.recipient) return [];
  return (await runningBriefs(access, userId, { body: true })).map((b) => ({
    name: b.name,
    description: b.description,
    body: must(b.body, 'the body it asked for'),
  }));
}

/** Import and duplicate, inside their transaction: each brief at revision 1. */
async function insertBriefs(
  tx: Tx,
  actor: Actor,
  agentId: string,
  briefs: ImportAgentInput['briefs'],
  source: 'human' | 'agent' | 'import',
): Promise<number> {
  for (const b of briefs) {
    const [row] = await tx
      .insert(schema.agentBriefs)
      .values({
        agentId,
        name: b.name,
        description: b.description,
        body: b.body,
        source,
        authorId: actor.user.id,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .returning();
    await insertBriefRevision(tx, actor, must(row, 'the brief it just imported'));
  }
  return briefs.length;
}

/* --------------------------------- sharing -------------------------------- */

function levelsFrom(input: {
  preset?: SharePreset | undefined;
  prompt?: PromptAccess | undefined;
  memory?: MemoryAccess | undefined;
}): {
  prompt: PromptAccess;
  memory: MemoryAccess;
} {
  if (input.preset)
    return {
      prompt: SHARE_PRESETS[input.preset].prompt,
      memory: SHARE_PRESETS[input.preset].memory,
    };
  return { prompt: input.prompt ?? 'view', memory: input.memory ?? 'none' };
}

export async function listShares(actor: Actor, idOrSlug: string): Promise<AgentShareDto[]> {
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  const db = getDb();
  // A connection limited to selected radars reaches no topic, so a share with one is not
  // listed to it: not the topic's id, its name or how many people are in it.
  const noTopics = await topicsWithheld(actor);
  const shares = await db
    .select()
    .from(schema.agentShares)
    .where(
      and(
        eq(schema.agentShares.agentId, agent.id),
        noTopics ? eq(schema.agentShares.subjectType, 'user') : undefined,
      ),
    )
    .orderBy(asc(schema.agentShares.createdAt));
  const userIds = shares.filter((s) => s.subjectType === 'user').map((s) => s.subjectId);
  const topicIds = shares.filter((s) => s.subjectType === 'topic').map((s) => s.subjectId);
  const users = userIds.length
    ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const topics = topicIds.length
    ? await db.execute<{ id: string; name: string; members: number }>(sql`
        SELECT t.id, t.name,
               (SELECT count(*)::int FROM topic_members m WHERE m.topic_id = t.id) + 1 AS members
          FROM topics t WHERE t.id IN ${idList(topicIds)}`)
    : { rows: [] };
  const recipients = userIds.length
    ? await db
        .select()
        .from(schema.agentRecipients)
        .where(
          and(
            eq(schema.agentRecipients.agentId, agent.id),
            inArray(schema.agentRecipients.userId, userIds),
          ),
        )
    : [];
  return shares.map((s) => {
    const user = users.find((u) => u.id === s.subjectId);
    const topic = topics.rows.find((t) => t.id === s.subjectId);
    return {
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      label:
        s.subjectType === 'user'
          ? (user?.name ?? user?.email ?? 'Someone')
          : `Array: ${topic?.name ?? '—'}`,
      email: user?.email ?? null,
      prompt: s.promptAccess,
      memory: s.memoryAccess,
      preset: presetFor(s.promptAccess, s.memoryAccess),
      acceptedVersion: recipients.find((r) => r.userId === s.subjectId)?.acceptedVersion ?? null,
      memberCount: s.subjectType === 'topic' ? (topic?.members ?? 0) : null,
      createdAt: s.createdAt.toISOString(),
    };
  });
}

/**
 * Share with a person who already has an account, or with a topic you can
 * read. Human-only and owner-only: who runs your agent — and whose memory
 * edits load into your sessions — is a person's decision. A share reaching
 * someone is not yet running on their machine: they read it and accept first.
 */
export async function shareAgent(
  actor: Actor,
  idOrSlug: string,
  input: ShareAgentInput,
): Promise<AgentShareDto> {
  assertHumanDecision(
    actor,
    'Sharing an agent is a person’s decision. Ask the user to share it in On My Radar.',
  );
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  const levels = levelsFrom(input);
  let subjectType: 'user' | 'topic';
  let subjectId: string;
  if (input.email) {
    const user = await findUserByEmail(input.email);
    if (!user || user.state !== 'active') {
      throw notFound('There is no active On My Radar account with that address.');
    }
    if (user.id === agent.ownerId) throw badRequest('You already own this agent.');
    subjectType = 'user';
    subjectId = user.id;
  } else {
    const { topic } = await requireTopic(must(input.topicId, 'an array id'), actor, 'read');
    subjectType = 'topic';
    subjectId = topic.id;
  }
  await getDb()
    .insert(schema.agentShares)
    .values({
      agentId: agent.id,
      subjectType,
      subjectId,
      promptAccess: levels.prompt,
      memoryAccess: levels.memory,
      createdBy: actor.user.id,
    })
    .onConflictDoUpdate({
      target: [
        schema.agentShares.agentId,
        schema.agentShares.subjectType,
        schema.agentShares.subjectId,
      ],
      set: { promptAccess: levels.prompt, memoryAccess: levels.memory },
    });
  await recordAudit(actor, 'repo_agent.share', 'repo_agent', agent.id, {
    subjectType,
    subjectId,
    ...levels,
  });
  const shares = await listShares(actor, agent.id);
  return must(
    shares.find((s) => s.subjectType === subjectType && s.subjectId === subjectId),
    'the share it just wrote',
  );
}

export async function updateShare(
  actor: Actor,
  idOrSlug: string,
  subjectType: string,
  subjectId: string,
  input: {
    preset?: SharePreset | undefined;
    prompt?: PromptAccess | undefined;
    memory?: MemoryAccess | undefined;
  },
): Promise<AgentShareDto> {
  assertHumanDecision(actor, 'Changing what someone can do with an agent is a person’s decision.');
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  const levels = levelsFrom(input);
  const updated = await getDb()
    .update(schema.agentShares)
    .set({ promptAccess: levels.prompt, memoryAccess: levels.memory })
    .where(
      and(
        eq(schema.agentShares.agentId, agent.id),
        eq(schema.agentShares.subjectType, subjectType as 'user' | 'topic'),
        eq(schema.agentShares.subjectId, subjectId),
      ),
    )
    .returning();
  if (updated.length === 0) throw notFound('No such share');
  await recordAudit(actor, 'repo_agent.share.update', 'repo_agent', agent.id, {
    subjectType,
    subjectId,
    ...levels,
  });
  return must(
    (await listShares(actor, agent.id)).find((s) => s.subjectId === subjectId),
    'the share',
  );
}

/** Forget pins of people no share reaches any more, so a later share asks them to accept again. */
async function dropOrphanRecipients(agentId: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM agent_recipients r
     WHERE r.agent_id = ${agentId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM agent_shares s
          WHERE s.agent_id = r.agent_id
            AND ((s.subject_type = 'user' AND s.subject_id = r.user_id)
              OR (s.subject_type = 'topic' AND s.subject_id IN (
                    SELECT id FROM topics WHERE owner_id = r.user_id
                    UNION SELECT topic_id FROM topic_members WHERE user_id = r.user_id))))`);
}

export async function unshareAgent(
  actor: Actor,
  idOrSlug: string,
  subjectType: string,
  subjectId: string,
): Promise<void> {
  assertHumanDecision(actor, 'Changing who can run an agent is a person’s decision.');
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  const removed = await getDb()
    .delete(schema.agentShares)
    .where(
      and(
        eq(schema.agentShares.agentId, agent.id),
        eq(schema.agentShares.subjectType, subjectType as 'user' | 'topic'),
        eq(schema.agentShares.subjectId, subjectId),
      ),
    )
    .returning({ id: schema.agentShares.subjectId });
  if (removed.length === 0) throw notFound('No such share');
  await dropOrphanRecipients(agent.id);
  await recordAudit(actor, 'repo_agent.unshare', 'repo_agent', agent.id, {
    subjectType,
    subjectId,
  });
}

function assertRecipient(access: RepoAgentAccess): void {
  if (access.owner) throw badRequest('You own this agent; there is nothing to accept.');
}

/** A recipient accepts a share: they have read it, and pin the version they read. */
export async function acceptShare(actor: Actor, idOrSlug: string): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Accepting an agent someone shared is a person’s decision, made after reading it.',
  );
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertRecipient(access);
  await getDb()
    .insert(schema.agentRecipients)
    .values({
      agentId: access.agent.id,
      userId: actor.user.id,
      acceptedVersion: access.agent.promptVersion,
    })
    .onConflictDoUpdate({
      target: [schema.agentRecipients.agentId, schema.agentRecipients.userId],
      set: { acceptedVersion: access.agent.promptVersion, acceptedAt: sql`now()` },
    });
  await recordAudit(actor, 'repo_agent.accept', 'repo_agent', access.agent.id, {
    version: access.agent.promptVersion,
  });
  return reloaded(actor, access.agent.id);
}

/** A recipient takes the owner's latest version. */
export async function takeUpdate(actor: Actor, idOrSlug: string): Promise<RepoAgentDto> {
  assertHumanDecision(actor, 'Taking a newer version of a shared agent is a person’s decision.');
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertRecipient(access);
  if (!access.recipient) throw conflict('Accept this agent first.');
  await getDb()
    .update(schema.agentRecipients)
    .set({ acceptedVersion: access.agent.promptVersion, acceptedAt: sql`now()` })
    .where(
      and(
        eq(schema.agentRecipients.agentId, access.agent.id),
        eq(schema.agentRecipients.userId, actor.user.id),
      ),
    );
  await recordAudit(actor, 'repo_agent.update_taken', 'repo_agent', access.agent.id, {
    version: access.agent.promptVersion,
  });
  return reloaded(actor, access.agent.id);
}

/** A recipient chooses whether the owner's changes reach them without asking. */
export async function setFollow(
  actor: Actor,
  idOrSlug: string,
  follow: boolean,
): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Whether someone else’s changes reach your tools unasked is your decision.',
  );
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertRecipient(access);
  if (!access.recipient) throw conflict('Accept this agent first.');
  await getDb()
    .update(schema.agentRecipients)
    .set({
      followUpdates: follow,
      // Stopping following pins what is live now — the prompt and the briefs.
      ...(follow ? {} : { acceptedVersion: access.agent.promptVersion, acceptedAt: sql`now()` }),
    })
    .where(
      and(
        eq(schema.agentRecipients.agentId, access.agent.id),
        eq(schema.agentRecipients.userId, actor.user.id),
      ),
    );
  await recordAudit(
    actor,
    follow ? 'repo_agent.follow' : 'repo_agent.unfollow',
    'repo_agent',
    access.agent.id,
  );
  return reloaded(actor, access.agent.id);
}

/** A recipient leaves: their direct share goes, and their pin with it. */
export async function leaveShare(actor: Actor, idOrSlug: string): Promise<void> {
  assertHumanDecision(actor, 'Leaving a shared agent is a person’s decision.');
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  assertRecipient(access);
  await getDb()
    .delete(schema.agentShares)
    .where(
      and(
        eq(schema.agentShares.agentId, access.agent.id),
        eq(schema.agentShares.subjectType, 'user'),
        eq(schema.agentShares.subjectId, actor.user.id),
      ),
    );
  await getDb()
    .delete(schema.agentRecipients)
    .where(
      and(
        eq(schema.agentRecipients.agentId, access.agent.id),
        eq(schema.agentRecipients.userId, actor.user.id),
      ),
    );
  await recordAudit(actor, 'repo_agent.leave', 'repo_agent', access.agent.id);
}

/* ------------------------------- ownership ------------------------------- */

export async function offerTransfer(
  actor: Actor,
  idOrSlug: string,
  email: string,
): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Handing an agent to someone else is the owner’s decision, made in On My Radar.',
  );
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  const user = await findUserByEmail(email);
  if (!user || user.state !== 'active')
    throw notFound('There is no active On My Radar account with that address.');
  if (user.id === agent.ownerId) throw badRequest('You already own this agent.');
  await getDb().transaction(async (tx) => {
    // The earlier access read may predate acceptance by another person. Fence
    // the write with the same agent row lock used by acceptance, before offering.
    const current = await lockAgent(tx, agent.id);
    if (current.ownerId !== actor.user.id) throw notFound('Agent not found');
    await tx
      .insert(schema.agentTransfers)
      .values({ agentId: current.id, toUserId: user.id, createdBy: actor.user.id })
      .onConflictDoUpdate({
        target: schema.agentTransfers.agentId,
        set: { toUserId: user.id, createdBy: actor.user.id, createdAt: new Date() },
      });
  });
  await recordAudit(actor, 'repo_agent.transfer.offer', 'repo_agent', agent.id, { to: user.id });
  return reloaded(actor, agent.id);
}

export async function cancelTransfer(actor: Actor, idOrSlug: string): Promise<RepoAgentDto> {
  assertHumanDecision(actor, 'Only the owner can withdraw a transfer, in On My Radar.');
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  await getDb().transaction(async (tx) => {
    const current = await lockAgent(tx, agent.id);
    if (current.ownerId !== actor.user.id) throw notFound('Agent not found');
    await tx.delete(schema.agentTransfers).where(eq(schema.agentTransfers.agentId, current.id));
  });
  await recordAudit(actor, 'repo_agent.transfer.cancel', 'repo_agent', agent.id);
  return reloaded(actor, agent.id);
}

async function pendingTransferTo(actor: Actor, agentId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.agentTransfers)
    .where(
      and(
        eq(schema.agentTransfers.agentId, agentId),
        eq(schema.agentTransfers.toUserId, actor.user.id),
      ),
    )
    .limit(1);
  // Offered to somebody else, or not at all: not found, like any agent you cannot see.
  if (!row) throw notFound('Agent not found');
  return row;
}

/**
 * The recipient accepts ownership. One transaction: the owner moves; the
 * agent's unread mentions move to the new owner's queue; credentials the old
 * owner bound to it fall back to the old owner's own voice (they keep working
 * — a token bound to somebody else's agent would otherwise stop authenticating
 * at all); the new owner's share and pin go, since owning supersedes them. The
 * old owner keeps nothing unless the new owner shares it back.
 */
export async function acceptTransfer(actor: Actor, agentId: string): Promise<RepoAgentDto> {
  assertHumanDecision(
    actor,
    'Taking ownership of an agent is a person’s decision, made in On My Radar.',
  );
  await pendingTransferTo(actor, agentId);
  await getDb()
    .transaction(async (tx) => {
      // Creation and incoming transfers take the recipient lock before any agent row lock.
      await lockOwner(tx, actor.user.id);
      const agent = await lockAgent(tx, agentId);
      const [transfer] = await tx
        .select()
        .from(schema.agentTransfers)
        .where(
          and(
            eq(schema.agentTransfers.agentId, agent.id),
            eq(schema.agentTransfers.toUserId, actor.user.id),
            eq(schema.agentTransfers.createdBy, agent.ownerId),
          ),
        )
        .for('update');
      if (!transfer) throw notFound('Agent not found');
      await assertAgentCeiling(tx, actor.user.id);
      await tx
        .update(schema.repoAgents)
        .set({ ownerId: actor.user.id, revision: agent.revision + 1, updatedAt: new Date() })
        .where(eq(schema.repoAgents.id, agent.id));
      await tx
        .update(schema.notifications)
        .set({ userId: actor.user.id })
        .where(
          and(eq(schema.notifications.agentId, agent.id), isNull(schema.notifications.readAt)),
        );
      // Every credential minted for the agent, and every session opened on it, was
      // the old owner's consent to speak as it. They end here: unbinding them
      // would turn each into an ordinary credential acting as the old owner, and
      // leaving them bound would let the old owner keep speaking as an agent that
      // is no longer theirs. If the new owner shares the agent back, the old owner
      // opens new sessions and mints new credentials under that share.
      const now = new Date();
      await tx
        .update(schema.apiTokens)
        .set({ revokedAt: now })
        .where(and(eq(schema.apiTokens.agentId, agent.id), isNull(schema.apiTokens.revokedAt)));
      await tx
        .update(schema.oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(schema.oauthTokens.agentId, agent.id), isNull(schema.oauthTokens.revokedAt)));
      await tx
        .update(schema.oauthCodes)
        .set({ consumedAt: now })
        .where(and(eq(schema.oauthCodes.agentId, agent.id), isNull(schema.oauthCodes.consumedAt)));
      await tx
        .delete(schema.repoAgentSessions)
        .where(eq(schema.repoAgentSessions.agentId, agent.id));
      await tx
        .delete(schema.agentShares)
        .where(
          and(
            eq(schema.agentShares.agentId, agent.id),
            eq(schema.agentShares.subjectType, 'user'),
            eq(schema.agentShares.subjectId, actor.user.id),
          ),
        );
      await tx
        .delete(schema.agentRecipients)
        .where(
          and(
            eq(schema.agentRecipients.agentId, agent.id),
            eq(schema.agentRecipients.userId, actor.user.id),
          ),
        );
      await tx.delete(schema.agentTransfers).where(eq(schema.agentTransfers.agentId, agent.id));
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err, 'agents_owner_slug_key'))
        throw conflict(
          'You already have an agent with this handle. Rename one of them, then accept again.',
        );
      throw err;
    });
  await recordAudit(actor, 'repo_agent.transfer.accept', 'repo_agent', agentId);
  return reloaded(actor, agentId);
}

export async function declineTransfer(actor: Actor, agentId: string): Promise<void> {
  assertHumanDecision(actor, 'Declining an agent offered to you is a person’s decision.');
  await pendingTransferTo(actor, agentId);
  await getDb().delete(schema.agentTransfers).where(eq(schema.agentTransfers.agentId, agentId));
  await recordAudit(actor, 'repo_agent.transfer.decline', 'repo_agent', agentId);
}

/* ------------------------------- connections ------------------------------ */

/**
 * The machines and apps that write as this agent: tokens and OAuth grants bound
 * to it. Credentials are inventory of somebody's access, so this is the owner's
 * and a person's (the route is session-only as well).
 */
export async function agentConnections(
  actor: Actor,
  idOrSlug: string,
): Promise<{ tokens: ApiTokenDto[]; grants: OAuthGrantDto[]; mcp: { url: string } }> {
  assertHumanDecision(actor, 'Credentials are managed in On My Radar while signed in.');
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  const [tokens, grants] = await Promise.all([listTokens(actor), listGrants(actor)]);
  return {
    tokens: tokens.filter((t) => t.agent?.id === agent.id),
    grants: grants.filter((g) => g.agent?.id === agent.id),
    mcp: { url: `${env().PUBLIC_URL}/mcp` },
  };
}

export async function mintAgentToken(
  actor: Actor,
  idOrSlug: string,
  name: string,
  expiresInDays?: number | null,
): Promise<ApiTokenDto> {
  assertHumanDecision(actor, 'Minting a token is done in On My Radar while signed in.');
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'manage');
  return createToken(actor, {
    name,
    agentId: agent.id,
    voices: ['persona'],
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
  });
}

/* -------------------------------- activity -------------------------------- */

/**
 * What happened to an agent, newest first: sessions (with what they wrote),
 * prompt versions, memory edits by people, shares. Computed from the rows that
 * already record all of it — there is no activity table to drift. One UNION
 * (its columns named once, on the alias: a UNION takes its names from the
 * first branch, which is whichever kind the filter left first)
 * ordered on `(at, key)` with a keyset cursor rendered by Postgres, so a page
 * boundary names a row exactly.
 */
/** "Brief commander r4", "Brief commander added" — one line, before who did it. */
function briefSummary(
  brief: NonNullable<ActivityItemDto['brief']>,
  revision: number | null,
): string {
  switch (brief.op) {
    case 'create':
      return `Brief ${brief.name} added`;
    case 'update':
      return `Brief ${brief.name} r${revision ?? ''}`;
    case 'rename':
      return `Brief ${brief.previousName ?? ''} renamed to ${brief.name}`;
    case 'delete':
      return `Brief ${brief.name} deleted`;
  }
}

/**
 * One Activity line for a prompt version or a held proposal. `editor` is the name of ANOTHER agent
 * that made the edit, so the line names both: "HR’s prompt v4 edited by Lulu".
 */
function promptSummary(
  r: { version: number | null; by_agent: boolean; name: string | null; op: string | null },
  target: string,
  tool: string | null,
): string {
  const via = tool ? ` in ${tool}` : '';
  const by = r.name ? `${r.name}${via}` : `the agent${via}`;
  if (r.op === 'pending') return `Prompt change proposed by ${by}, waiting for the owner`;
  if (r.op === 'rejected') return `Prompt change proposed by ${by}, rejected`;
  if (r.op === 'accepted')
    return `Prompt change proposed by ${by}, accepted as v${r.version ?? ''}`;
  if (r.name) return `${target}’s prompt v${r.version ?? ''} edited by ${by}`;
  return `Prompt v${r.version ?? ''}${r.by_agent ? ` by ${by}` : ''}`;
}

export async function agentActivity(
  actor: Actor,
  idOrSlug: string,
  input: ActivityInput,
): Promise<ActivityPageDto> {
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  const { agent } = access;
  const kinds: ActivityKind[] =
    input.kind === 'all'
      ? ['session', 'prompt', 'brief', 'memory', 'share']
      : input.kind === 'sessions'
        ? ['session']
        : input.kind === 'sharing'
          ? ['share']
          : input.kind === 'briefs'
            ? ['brief']
            : [input.kind];
  // A connection limited to selected radars reaches no topic: shares with one are left out.
  const noTopics = await topicsWithheld(actor);
  const memoryVisible = access.memory !== 'none';
  // Briefs follow the load_agent gate, as listing them does: not before accepting.
  const briefsVisible = access.owner || access.recipient !== null;
  let cursor: { at: string; key: string } | null = null;
  if (input.cursor) {
    const parsed = decodeCursor(input.cursor);
    if (!parsed || !isCursorTimestamp(parsed['at']) || typeof parsed['key'] !== 'string')
      throw badRequest('Invalid cursor');
    cursor = { at: parsed['at'], key: parsed['key'] };
  }
  const parts: ReturnType<typeof sql>[] = [];
  if (kinds.includes('session'))
    parts.push(sql`SELECT 'session' AS kind, s.started_at AS at, 's:' || s.id AS key, s.id AS ref,
      s.user_id AS cosigner, true AS by_agent, s.harness, s.client_label, s.workspace,
      NULL::int AS version, NULL::text AS note, NULL::text AS name, NULL::text AS op
      FROM agent_sessions s WHERE s.agent_id = ${agent.id}::uuid`);
  if (kinds.includes('prompt'))
    // `name` is the agent that edited, when it was ANOTHER one; `op` is a held proposal's status.
    parts.push(sql`SELECT 'prompt', p.created_at, 'p:' || p.version, p.session_id,
      p.author_id, p.source = 'agent', p.harness, p.client_label, NULL,
      p.version, p.note, e.name, NULL
      FROM agent_prompts p LEFT JOIN agents e ON e.id = p.editor_agent_id AND e.id <> p.agent_id
      WHERE p.agent_id = ${agent.id}::uuid AND p.status <> 'declined'
      UNION ALL
      SELECT 'prompt', q.created_at, 'q:' || q.id, q.session_id,
      q.author_id, true, q.harness, q.client_label, NULL,
      q.version, q.note, e.name, q.status
      FROM agent_prompt_proposals q LEFT JOIN agents e ON e.id = q.editor_agent_id AND e.id <> q.agent_id
      WHERE q.agent_id = ${agent.id}::uuid`);
  /*
    A brief's story: one row per revision, plus the renames and deletes, which
    write no revision (agent_brief_events, migration 0040). A revision row has
    no name of its own, so it carries the brief's current one; the rename event
    says what it was called before, in the `note` column.
  */
  if (kinds.includes('brief') && briefsVisible)
    parts.push(sql`SELECT 'brief', r.created_at, 'b:' || r.brief_id || ':' || r.revision, r.session_id,
      r.author_id, r.source = 'agent', r.harness, r.client_label, NULL,
      r.revision, r.note, b.name, CASE WHEN r.revision = 1 THEN 'create' ELSE 'update' END
      FROM agent_brief_revisions r JOIN agent_briefs b ON b.id = r.brief_id
      WHERE b.agent_id = ${agent.id}::uuid
      UNION ALL
      SELECT 'brief', e.created_at, 'e:' || e.id, e.session_id,
      e.author_id, e.source = 'agent', e.harness, e.client_label, NULL,
      e.revision, e.previous_name, e.name, e.op
      FROM agent_brief_events e WHERE e.agent_id = ${agent.id}::uuid`);
  if (kinds.includes('memory') && memoryVisible)
    parts.push(sql`SELECT 'memory', r.created_at, 'm:' || r.seq, r.session_id,
      r.author_id, false, r.harness, r.client_label, NULL,
      NULL, NULL, m.name, r.op
      FROM agent_memory_revisions r JOIN agent_memories m ON m.id = r.memory_id
      WHERE m.agent_id = ${agent.id}::uuid AND r.session_id IS NULL`);
  if (kinds.includes('share') && access.owner)
    parts.push(sql`SELECT 'share', sh.created_at, 'h:' || sh.subject_type || sh.subject_id, NULL::uuid,
      sh.created_by, false, NULL, NULL, NULL, NULL,
      sh.prompt_access || '/' || sh.memory_access,
      COALESCE((SELECT coalesce(u.name, u.email) FROM users u WHERE sh.subject_type = 'user' AND u.id = sh.subject_id),
               (SELECT 'array ' || t.name FROM topics t WHERE sh.subject_type = 'topic' AND t.id = sh.subject_id)),
      NULL
      FROM agent_shares sh WHERE sh.agent_id = ${agent.id}::uuid
       ${noTopics ? sql`AND sh.subject_type = 'user'` : sql``}`);
  if (parts.length === 0) return { items: [], nextCursor: null };
  const union = sql.join(parts, sql` UNION ALL `);
  const rows = await getDb().execute<{
    kind: ActivityKind;
    at: string;
    at_text: string;
    key: string;
    ref: string | null;
    cosigner: string | null;
    by_agent: boolean;
    harness: string | null;
    client_label: string | null;
    workspace: string | null;
    version: number | null;
    note: string | null;
    name: string | null;
    op: MemoryOp | BriefOp | 'pending' | 'accepted' | 'rejected' | null;
  }>(sql`
    SELECT a.*, a.at::text AS at_text
      FROM (${union}) AS a(kind, at, key, ref, cosigner, by_agent, harness, client_label, workspace, version, note, name, op)
     ${cursor ? sql`WHERE (a.at, a.key) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``}
     ORDER BY a.at DESC, a.key DESC
     LIMIT ${input.limit + 1}`);
  const page = rows.rows.slice(0, input.limit);
  const sessionIds = page.filter((r) => r.kind === 'session' && r.ref).map((r) => r.ref as string);
  const changes =
    sessionIds.length && memoryVisible
      ? await getDb().execute<{ session_id: string; op: MemoryOp; name: string }>(sql`
        SELECT r.session_id, r.op, m.name FROM agent_memory_revisions r
          JOIN agent_memories m ON m.id = r.memory_id
         WHERE r.session_id IN ${idList(sessionIds)} ORDER BY r.seq`)
      : { rows: [] };
  const people = await promptAuthors(page.map((r) => ({ authorId: r.cosigner })));
  const verdicts = await harnessVerdicts(
    page.map((r) => ({ sessionId: r.ref, harness: r.harness })),
  );
  const items: ActivityItemDto[] = page.map((r, n) => {
    const brief =
      r.kind === 'brief'
        ? {
            name: r.name ?? '',
            op: r.op as BriefOp,
            previousName: r.op === 'rename' ? r.note : null,
          }
        : null;
    const memoryChanges = changes.rows
      .filter((c) => r.kind === 'session' && c.session_id === r.ref)
      .map((c) => ({ op: c.op, name: c.name }))
      .slice(0, 50);
    const resolved = r.harness ? resolveHarness(r.harness) : null;
    const tool = resolved ? HARNESSES[resolved].short : r.harness;
    const summary =
      r.kind === 'session'
        ? // The tool, client and workspace are fields of their own and the SPA shows
          // them; the summary adds only what they do not say.
          memoryChanges.length
          ? `${memoryChanges.length} memory ${memoryChanges.length === 1 ? 'change' : 'changes'}`
          : 'nothing written'
        : r.kind === 'prompt'
          ? promptSummary(r, agent.name, tool)
          : brief
            ? `${briefSummary(brief, r.version)}${r.by_agent ? ` by the agent${tool ? ` in ${tool}` : ''}` : ''}`
            : r.kind === 'memory'
              ? `${r.op ?? 'changed'} ${r.name ?? ''}`
              : `Shared with ${r.name ?? 'someone'} (${presetFor(...((r.note ?? 'view/none').split('/') as [PromptAccess, MemoryAccess]))})`;
    return {
      ...(verdicts[n] as HarnessVerdict),
      kind: r.kind,
      at: new Date(r.at).toISOString(),
      cosigner: r.cosigner ? { id: r.cosigner, name: people.get(r.cosigner) ?? null } : null,
      byAgent: r.by_agent,
      harness: r.harness,
      clientLabel: r.client_label,
      workspace: r.workspace,
      summary,
      version: r.version,
      note: r.kind === 'prompt' || (brief && brief.op !== 'rename') ? r.note || null : null,
      memoryChanges,
      brief,
      ...(r.kind === 'prompt'
        ? {
            proposal:
              r.op === 'pending' || r.op === 'accepted' || r.op === 'rejected' ? r.op : null,
            editor: r.name,
          }
        : {}),
    };
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.rows.length > input.limit && last
        ? encodeCursor({ at: last.at_text, key: last.key })
        : null,
  };
}

/* ----------------------------- import / export ---------------------------- */

export async function importAgent(actor: Actor, input: ImportAgentInput): Promise<RepoAgentDto> {
  await requireScope(actor, 'write', 'import an agent');
  for (const [kind, names] of [
    ['memories', input.memories.map((m) => m.name)],
    ['briefs', input.briefs.map((b) => b.name)],
  ] as const) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) throw badRequest(`Two ${kind} in this import are called '${name}'.`);
      seen.add(name);
    }
  }
  const { row, imported, briefs } = await getDb().transaction(async (tx) => {
    const row = await createDefinition(tx, actor, input, 'import');
    const imported = await insertImportedMemories(tx, actor, row.id, input.memories);
    const briefs = await insertBriefs(tx, actor, row.id, input.briefs, 'import');
    return { row, imported, briefs };
  });
  await recordAudit(actor, 'repo_agent.import', 'repo_agent', row.id, {
    slug: row.slug,
    memories: imported,
    briefs,
  });
  return reloaded(actor, row.id);
}

export async function exportAgent(actor: Actor, idOrSlug: string): Promise<ImportAgentInput> {
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  const { agent } = access;
  const prompt = agent.promptVersion ? await getPromptVersion(actor, agent.id) : null;
  const memories = access.memory === 'none' ? [] : await liveMemories(agent.id);
  const profiles = await getDb()
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.agentId, agent.id));
  // The briefs the caller runs, as the prompt is the version they run — none
  // before a recipient accepts, as memory is left out when it is not shared.
  const briefs = await acceptedBriefs(access, actor.user.id);
  return {
    name: agent.name,
    slug: agent.slug,
    description: agent.description,
    ...(prompt?.body ? { prompt: prompt.body } : {}),
    profiles: Object.fromEntries(profiles.map((p) => [p.harness, p.settings])),
    memories: memories.map((m) => ({
      name: m.name,
      type: m.type,
      description: m.description,
      body: m.body,
    })),
    briefs,
  };
}

/* --------------------------------- checkout ------------------------------- */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The file operations that bootstrap an agent in a workspace, for one tool,
 * rendered from that tool's profile. Pure rendering from `packages/contract`,
 * so the MCP tool, this REST route and the SPA produce identical bytes. No
 * credential is ever part of it. Two things are withheld and said so: values a
 * tool does not accept (a v1 import may carry them), and — for anyone but the
 * owner — values that let a tool act without asking.
 */
export async function checkoutAgent(
  actor: Actor,
  idOrSlug: string,
  input: CheckoutInput,
): Promise<CheckoutDto> {
  const access = await requireRepoAgent(idOrSlug, actor, 'read');
  const { agent } = access;
  if (agent.archivedAt) throw conflict(`'${agent.slug}' is archived.`);
  if (!access.owner && !access.recipient) {
    throw forbidden(`Accept '${agent.slug}' in On My Radar before checking it out.`);
  }
  if (input.pin !== undefined) await getPromptVersion(actor, agent.id, input.pin);
  const [profile] = await getDb()
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.agentId, agent.id),
        eq(schema.agentProfiles.harness, input.harness),
      ),
    )
    .limit(1);
  const withheld: string[] = [];
  let settings: ProfileSettings = {};
  if (profile) {
    const valid: ProfileSettings = {};
    for (const [key, value] of Object.entries(profile.settings)) {
      const checked = validateProfileSettings(input.harness, { [key]: value });
      if (
        !checked.ok &&
        input.harness === 'claude-code' &&
        (key === 'tools' || key === 'disallowedTools')
      )
        throw conflict(`Repair the saved Claude Code profile before checkout. ${checked.message}`);
      if (checked.ok) Object.assign(valid, checked.value);
      else
        withheld.push(
          `${key}: ${String(value)} — not a value ${HARNESSES[input.harness].label} accepts`,
        );
    }
    settings = valid;
    // A widening value is written only when the owner approved exactly that value
    // from a browser session (`approved_widening`) — for the owner's own machines
    // as much as anyone's, because a profile an agent or collaborator could write
    // must not become `danger-full-access` on a disk. Everyone but the owner never
    // gets one, approved or not. Profiles saved before the approval was recorded
    // have none and are stripped here until the owner saves them again.
    const approved = access.owner ? profile.approvedWidening : {};
    const stripped = withoutUnapprovedWidening(input.harness, settings, approved);
    settings = stripped.settings;
    withheld.push(
      ...stripped.stripped.map((s) =>
        access.owner
          ? `${s} — not applied: the owner has not approved it from a browser session. Open the profile in On My Radar and save it to approve`
          : `${s} — only applied on the owner’s machines`,
      ),
    );
  }
  let snapshot;
  if (input.snapshot) {
    const prompt = agent.promptVersion ? await getPromptVersion(actor, agent.id) : null;
    snapshot = {
      promptVersion: prompt?.version ?? 0,
      prompt: prompt?.body ?? '',
      memories:
        access.memory === 'none'
          ? []
          : (await liveMemories(agent.id)).map((m) => ({
              name: m.name,
              type: m.type,
              description: m.description,
              body: m.body,
            })),
      // The briefs it runs — as it stood when a pinned recipient accepted —
      // so an offline agent has the facts its prompt points at.
      briefs: (await runningBriefs(access, actor.user.id, { body: true })).map((b) => ({
        name: b.name,
        description: b.description,
        revision: b.revision,
        body: must(b.body, 'the body it asked for'),
      })),
      generatedAt: new Date().toISOString(),
    };
  }
  const mcpUrl = `${env().PUBLIC_URL}/mcp`;
  const rendered = renderCheckout({
    agent: { id: agent.id, slug: agent.slug, description: agent.description },
    mcpUrl,
    harness: input.harness,
    mode: input.mode,
    settings,
    applyProjectSettings: input.applyProjectSettings,
    pin: input.pin,
    snapshot,
  });
  // Audited when a connection asks — a device about to write files — not for
  // the SPA's preview, which re-renders on every tool clicked through.
  if (actor.kind !== 'user') {
    await recordAudit(actor, 'repo_agent.checkout', 'repo_agent', agent.id, {
      harness: input.harness,
      mode: input.mode,
      snapshot: input.snapshot,
    });
  }
  return {
    ...rendered,
    operations: rendered.operations.map((op) =>
      'content' in op ? { ...op, sha256: sha256(op.content) } : op,
    ),
    connect: connectInstructions(input.harness, mcpUrl),
    profile: profile ? { harness: input.harness, settings } : null,
    withheld,
  };
}

/* ---------------------------------- bridges ------------------------------- */

/**
 * A person copies a memory onto a radar as a blip. One direction, one copy,
 * human-only: agents already have `create_blip`, and a memory reaching a radar
 * is exactly the fan-out (mentions, tags, unfurl) memories are kept out of
 * until a person decides otherwise.
 */
export async function promoteMemoryToBlip(
  actor: Actor,
  idOrSlug: string,
  memoryId: string,
  radarId: string,
) {
  assertHumanDecision(actor, 'Putting a memory on a radar is a person’s decision.');
  const { agent } = await requireRepoAgent(idOrSlug, actor, 'memory-read');
  const [memory] = await getDb()
    .select()
    .from(schema.repoAgentMemories)
    .where(
      and(
        eq(schema.repoAgentMemories.id, memoryId),
        eq(schema.repoAgentMemories.agentId, agent.id),
      ),
    )
    .limit(1);
  if (!memory) throw notFound('Memory not found');
  const blip = await createBlip(actor, radarId, {
    body: `# ${memory.description}\n\n${memory.body}`,
  });
  await recordAudit(actor, 'repo_agent.memory.promote', 'repo_agent_memory', memory.id, {
    radarId,
    blipId: blip.id,
  });
  return blip;
}

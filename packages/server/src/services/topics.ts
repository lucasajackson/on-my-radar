/**
 * Topics: a container for radars, with its own sharing.
 *
 * The two rules this file exists to hold up, both taken straight from the ask:
 *
 * 1. **Sharing a topic does not share its radars.** A topic grant conveys the
 *    grouping and nothing else. A member sees the topic's name and the radars
 *    inside it *they can already reach* — never a radar they hold no grant on,
 *    because a radar's name is content and listing it would leak it.
 * 2. **Cascading is opt-in, and it is a computed overlay.** `setCascade` flips
 *    one boolean. It writes no `radar_members` rows going on and deletes none
 *    coming off, so no direct grant is ever overwritten or stranded and the
 *    switch is exactly reversible. `services/access.ts` reads the flag at
 *    authorization time; `drizzle/0005_topics.sql` carries the long argument.
 *
 * Everything mutating here needs `manage`, which is the topic's owner. See
 * `TOPIC_ROLES` for why a second person cannot be given that.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_RADAR_ACCENT,
  DEFAULT_RADAR_GLYPH,
  isRadarAccent,
  isRadarGlyph,
  LIMITS,
  normalizeEmail,
  roleAtLeast,
  type CreateTopicInput,
  type TopicDto,
  type TopicMemberDto,
  type TopicRole,
  type TopicSummaryDto,
  type UpdateTopicInput,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, ceilingOf, conflict, forbidden, notFound, type Actor } from '../http.js';
import {
  radarsReachableOnlyViaTopic,
  assertHumanDecision,
  readableRadarIdsFor,
  topicsWithheld,
  requireRadar,
  requireScope,
  requireTopic,
  unfencedReadableTopicQuery,
  type TopicAccess,
  type TopicRow,
} from './access.js';
import { recordAudit } from './audit.js';
import { withUniqueSlug } from './slugs.js';
import { topicSharedMessage } from './mail.js';
import { assertMayInvite, invitationBypassFor, inviteUrl, mayBypassWaitlist } from './invites.js';
import { activateUser } from '../auth/accounts.js';
import {
  dropRadarNotifications,
  dropTopicNotifications,
  enqueueNotificationEvent,
} from './notifications.js';
import { dropRadarMentions } from './mentions.js';
import { enqueue, drainOne } from './outbox.js';

export function toTopicSummary(topic: TopicRow): TopicSummaryDto {
  return {
    id: topic.id,
    slug: topic.slug,
    name: topic.name,
    accent: isRadarAccent(topic.accent) ? topic.accent : DEFAULT_RADAR_ACCENT,
    // Guarded like the accent: the column has no CHECK, so a glyph a later build
    // added reaches this one as a string it has never heard of.
    glyph: isRadarGlyph(topic.glyph) ? topic.glyph : DEFAULT_RADAR_GLYPH,
    cascade: topic.cascade,
  };
}

type OwnerSummary = { id: string; name: string | null; email: string } | null;

async function ownerSummary(ownerId: string): Promise<OwnerSummary> {
  const rows = await getDb()
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  return rows[0] ?? null;
}

interface TopicStats {
  radarCount: number;
  memberCount: number;
}

/**
 * `radarCount` is **what the caller can read**, not what the topic holds.
 *
 * A topic member who has been handed no radars sees 0 even when the topic has
 * five, because reporting five would tell them five things exist that they
 * cannot open — and a radar's name is content. Same reasoning as the
 * 404-not-403 rule: do not confirm the existence of what somebody cannot reach.
 */
async function statsFor(
  topicIds: string[],
  readableRadars: Set<string>,
): Promise<Map<string, TopicStats>> {
  const stats = new Map<string, TopicStats>();
  if (topicIds.length === 0) return stats;
  for (const id of topicIds) stats.set(id, { radarCount: 0, memberCount: 1 });

  const radarRows = await getDb()
    .select({ topicId: schema.radars.topicId, id: schema.radars.id })
    .from(schema.radars)
    .where(and(inArray(schema.radars.topicId, topicIds), eq(schema.radars.archived, false)));
  for (const row of radarRows) {
    if (!row.topicId || !readableRadars.has(row.id)) continue;
    const entry = stats.get(row.topicId);
    if (entry) entry.radarCount += 1;
  }

  const memberRows = await getDb()
    .select({ topicId: schema.topicMembers.topicId, count: sql<number>`count(*)::int` })
    .from(schema.topicMembers)
    .where(inArray(schema.topicMembers.topicId, topicIds))
    .groupBy(schema.topicMembers.topicId);
  // +1 for the owner, who has no topic_members row.
  for (const row of memberRows) {
    const entry = stats.get(row.topicId);
    if (entry) entry.memberCount = row.count + 1;
  }
  return stats;
}

function toTopicDto(
  access: Pick<TopicAccess, 'topic' | 'role' | 'canRead' | 'canWrite' | 'canManage'>,
  stats: TopicStats,
  owner: OwnerSummary,
): TopicDto {
  const { topic } = access;
  return {
    ...toTopicSummary(topic),
    tagline: topic.tagline,
    description: topic.description,
    cascade: topic.cascade,
    archived: topic.archived,
    position: topic.position,
    ownerId: topic.ownerId,
    owner,
    radarCount: stats.radarCount,
    memberCount: stats.memberCount,
    createdAt: topic.createdAt.toISOString(),
    updatedAt: topic.updatedAt.toISOString(),
    access: {
      role: access.role,
      canRead: access.canRead,
      canWrite: access.canWrite,
      canManage: access.canManage,
    },
  };
}

/** Every topic the caller owns or holds a grant on, in display order. */
export async function listTopics(
  actor: Actor,
  options: { includeArchived?: boolean } = {},
): Promise<TopicDto[]> {
  // An agent limited to selected radars reaches no topic (`getTopicAccess`).
  if (await topicsWithheld(actor)) return [];
  const db = getDb();
  const rows = await db
    .select({
      topic: schema.topics,
      memberRole: schema.topicMembers.role,
      owner: { id: schema.users.id, name: schema.users.name, email: schema.users.email },
    })
    .from(schema.topics)
    .leftJoin(
      schema.topicMembers,
      and(
        eq(schema.topicMembers.topicId, schema.topics.id),
        eq(schema.topicMembers.userId, actor.user.id),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.topics.ownerId))
    .where(
      and(
        // The one definition of the topics a person reaches, organization term included.
        inArray(schema.topics.id, unfencedReadableTopicQuery(actor.user.id)),
        options.includeArchived ? undefined : eq(schema.topics.archived, false),
      ),
    )
    .orderBy(asc(schema.topics.position), asc(schema.topics.name));

  const readable = new Set(await readableRadarIdsFor(actor));
  const stats = await statsFor(
    rows.map((r) => r.topic.id),
    readable,
  );
  const empty: TopicStats = { radarCount: 0, memberCount: 1 };
  // The same cap `decideTopic` applies, because this list computes the two
  // booleans itself rather than going through `getTopicAccess`. A list that
  // says `canManage` on a topic the connection cannot manage is a divergence
  // between the sidebar and the thing the sidebar's buttons call.
  const ceiling = ceilingOf(actor);

  return rows.map((row) => {
    const role: TopicRole | 'owner' =
      row.topic.ownerId === actor.user.id ? 'owner' : (row.memberRole ?? 'viewer');
    return toTopicDto(
      {
        topic: row.topic,
        role,
        canRead: true,
        canWrite: roleAtLeast(ceiling, 'editor') && role !== 'viewer',
        canManage: roleAtLeast(ceiling, 'owner') && role === 'owner',
      },
      stats.get(row.topic.id) ?? empty,
      row.owner,
    );
  });
}

export async function getTopicDto(access: TopicAccess, actor: Actor): Promise<TopicDto> {
  const readable = new Set(await readableRadarIdsFor(actor));
  const stats = await statsFor([access.topic.id], readable);
  return toTopicDto(
    access,
    stats.get(access.topic.id) ?? { radarCount: 0, memberCount: 1 },
    await ownerSummary(access.topic.ownerId),
  );
}

export async function createTopic(actor: Actor, input: CreateTopicInput): Promise<TopicDto> {
  // Nothing to clamp yet — see the same note on `createRadar`.
  await requireScope(actor, 'write', 'create an array');
  const [topic] = await withUniqueSlug(input.name, 'topics_owner_slug_key', (slug) =>
    getDb()
      .insert(schema.topics)
      .values({
        ownerId: actor.user.id,
        slug,
        name: input.name,
        tagline: input.tagline ?? null,
        description: input.description ?? null,
        accent: input.accent ?? DEFAULT_RADAR_ACCENT,
        glyph: input.glyph ?? DEFAULT_RADAR_GLYPH,
      })
      .returning(),
  );
  if (!topic) throw new Error('topic insert returned no row');

  await recordAudit(actor, 'topic.create', 'topic', topic.id, { name: topic.name });
  return toTopicDto(
    { topic, role: 'owner', canRead: true, canWrite: true, canManage: true },
    { radarCount: 0, memberCount: 1 },
    await ownerSummary(topic.ownerId),
  );
}

/** Presentation only. The cascade switch is `setCascade`, deliberately. */
export async function updateTopic(
  actor: Actor,
  topicId: string,
  input: UpdateTopicInput,
): Promise<TopicDto> {
  const access = await requireTopic(topicId, actor, 'manage');

  const patch: Partial<typeof schema.topics.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    patch.name = input.name;
  }
  if (input.tagline !== undefined) patch.tagline = input.tagline;
  if (input.description !== undefined) patch.description = input.description;
  if (input.accent !== undefined) patch.accent = input.accent;
  if (input.glyph !== undefined) patch.glyph = input.glyph;
  if (input.archived !== undefined) patch.archived = input.archived;
  if (input.position !== undefined) patch.position = input.position;

  const write = (slug?: string) =>
    getDb()
      .update(schema.topics)
      .set({ ...patch, ...(slug ? { slug } : {}) })
      .where(eq(schema.topics.id, access.topic.id))
      .returning();
  const [updated] =
    input.name === undefined
      ? await write()
      : await withUniqueSlug(input.name, 'topics_owner_slug_key', write);
  if (!updated) throw notFound('Array not found');

  await recordAudit(actor, 'topic.update', 'topic', updated.id, { fields: Object.keys(input) });
  return getTopicDto({ ...access, topic: updated }, actor);
}

/**
 * Deleting a topic never deletes a radar.
 *
 * `radars.topic_id` is ON DELETE SET NULL, so the radars fall out of the topic
 * and keep every direct grant they had. That is the state most radars in this
 * database are already in, so there is nothing special about it — which is the
 * point: a topic is an organising device that can be removed without taking
 * content or access with it.
 */
export async function deleteTopic(actor: Actor, topicId: string): Promise<{ radarsFreed: number }> {
  const access = await requireTopic(topicId, actor, 'manage');

  // Sweep first, while the membership rows still exist to derive from: anybody
  // who reached a radar only through this cascade is about to stop being able
  // to, and their notifications carry snapshot excerpts of it.
  if (access.topic.cascade) await sweepCascadedNotifications(access.topic, { all: true });

  const freed = await getDb()
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .where(eq(schema.radars.topicId, access.topic.id));

  await getDb().delete(schema.topics).where(eq(schema.topics.id, access.topic.id));
  await recordAudit(actor, 'topic.delete', 'topic', access.topic.id, {
    name: access.topic.name,
    radarsFreed: freed.length,
  });
  return { radarsFreed: freed.length };
}

/* -------------------------------- cascade -------------------------------- */

/**
 * Turn cascading on or off.
 *
 * **On**: every current topic member gains their `CASCADE_GRANTS` role on every
 * radar in the topic, immediately and by computation. Nothing is written to
 * `radar_members`, so a radar's own member list is untouched — the two grants
 * union rather than one overwriting the other — and radars added to the topic
 * later are covered with no stale state to reconcile. Existing members are told,
 * because this is an access change and access changes always tell people.
 *
 * **Off**: the cascaded access disappears completely and immediately, and every
 * direct grant survives untouched. Notifications for radars a person reached
 * only through the cascade are swept, for the same reason `removeMember` sweeps
 * them: a notification carries a snapshot excerpt, so leaving it behind hands
 * somebody a readable copy of something they can no longer open.
 *
 * There is deliberately no notification for switching it off. Removing a radar
 * member does not send one either, and "your access was taken away" is a message
 * this application does not send anywhere — it would be the only one.
 */
export async function setCascade(
  actor: Actor,
  topicId: string,
  cascade: boolean,
): Promise<TopicDto> {
  const access = await requireTopic(topicId, actor, 'manage');
  if (access.topic.cascade === cascade) return getTopicDto(access, actor);

  /*
    Refused for an agent in both directions, and refused *here* rather than by
    there being no MCP tool for it.

    "No tool exists" was the whole enforcement until now, and it is not
    enforcement: `PUT /api/topics/:id/cascade` took an agent's bearer token like
    any other. Turning it on converts every array membership into access to every
    radar in the array, including radars filed into it later — chain it with two
    more ordinary calls and a stranger is reading a private radar. Turning it off
    silently strips access from collaborators, and "an agent revoked my access"
    is as bad as "an agent granted it".

    Neither direction is organising, and the screen at /topic/:id exists
    precisely because this switch needs its consequence stated in live numbers
    before anybody touches it.
  */
  assertHumanDecision(
    actor,
    cascade
      ? `Turning the cascade on for "${access.topic.name}" would hand every member of it ` +
          'access to every radar in it, including radars added later. That is the widest ' +
          'single access change in this application and it is not something an agent may ' +
          'do — ask the user to do it on the array screen, which says what it will grant ' +
          'and to whom.'
      : `Turning the cascade off for "${access.topic.name}" would take access away from ` +
          'everybody who reaches its radars only through it. An agent revoking access is ' +
          'as bad as an agent granting it — ask the user to do it on the array screen.',
  );

  let notificationJob: string | undefined;
  const updated = await getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.topics)
      .set({ cascade, updatedAt: new Date() })
      .where(eq(schema.topics.id, access.topic.id))
      .returning();
    if (!updated) throw notFound('Array not found');
    if (cascade) {
      const members = await tx
        .select({ userId: schema.topicMembers.userId })
        .from(schema.topicMembers)
        .where(eq(schema.topicMembers.topicId, updated.id));
      const radars = await tx
        .select({ id: schema.radars.id })
        .from(schema.radars)
        .where(eq(schema.radars.topicId, updated.id));
      if (members.length > 0)
        notificationJob = await enqueueNotificationEvent(tx, {
          type: 'topic-cascade',
          actor,
          topicId: updated.id,
          recipientIds: members.map((member) => member.userId),
          radarCount: radars.length,
        });
    }
    return updated;
  });
  if (notificationJob) await drainOne(notificationJob);
  /*
    Swept after the flag has flipped, not before. What is swept is decided by
    membership rows, which the flip does not touch, so the answer is the same
    either way — but swept first, a failed flip left everyone's notifications
    gone with their access intact, and anything written between the sweep and
    the flip survived it. After the flip no new event names them.
  */
  if (!cascade) await sweepCascadedNotifications(updated, { all: true });

  const radarIds = await topicRadarIds(updated.id);
  await recordAudit(
    actor,
    cascade ? 'topic.cascade_on' : 'topic.cascade_off',
    'topic',
    updated.id,
    {
      name: updated.name,
      radars: radarIds.length,
    },
  );

  return getTopicDto({ ...access, topic: updated }, actor);
}

async function topicRadarIds(topicId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .where(
      and(
        eq(schema.radars.topicId, topicId),
        // Only radars the topic's owner owns are granted through it (see access.ts).
        sql`${schema.radars.ownerId} = (SELECT owner_id FROM topics WHERE id = ${topicId})`,
      ),
    );
  return rows.map((r) => r.id);
}

async function memberUserIds(topicId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ userId: schema.topicMembers.userId })
    .from(schema.topicMembers)
    .where(eq(schema.topicMembers.topicId, topicId));
  return rows.map((r) => r.userId);
}

/**
 * Everything one person is left holding on a radar they can no longer read.
 *
 * The two sweeps are always run together and there is one place that says so.
 * A notification carries a snapshot excerpt of the content; a mention keeps a
 * handle resolving to somebody the authorization layer would no longer admit —
 * `radarReaders` is what `reconcileMentions` draws candidates from, so a
 * mention that survives revocation is the member list and the blip disagreeing.
 */
async function sweepLostRadar(userId: string, radarId: string): Promise<void> {
  await dropRadarNotifications(userId, radarId);
  await dropRadarMentions(userId, radarId);
}

/**
 * Delete what a loss of cascaded access makes unreadable.
 *
 * `who` is either every member of the topic (the cascade is going away for all
 * of them) or one person (their grant is being revoked). In both cases only
 * radars they reach *solely* through the topic are swept — somebody with their
 * own grant on a radar keeps both the access and everything that hangs off it.
 */
async function sweepCascadedNotifications(
  topic: TopicRow,
  who: { all: true } | { userId: string },
): Promise<void> {
  const userIds = 'all' in who ? await memberUserIds(topic.id) : [who.userId];
  for (const userId of userIds) {
    const lost = await radarsReachableOnlyViaTopic(topic.id, userId);
    for (const radarId of lost) await sweepLostRadar(userId, radarId);
  }
}

/* ------------------------------ radar membership ------------------------- */

/**
 * Put a radar into a topic, or take it out with `topicId: null`.
 *
 * **Granting needs both sides; revoking needs either.** Adding requires `manage`
 * on the radar *and* `manage` on the topic, which in practice means owning both.
 * That is deliberately strict: if a topic editor could drop their own radar into
 * somebody else's cascading topic, that radar's access would from then on be
 * controlled by whoever owns the topic — the radar's owner would have handed
 * away control of their own sharing as a side effect of filing something.
 *
 * It also keeps a useful invariant true: every radar in a topic is owned by that
 * topic's owner, which is what lets `getRadarAccess` skip a topic-owner branch
 * entirely.
 *
 * Removal needs `manage` on only one of the two, because either party should be
 * able to withdraw from the arrangement without the other's cooperation.
 */
/**
 * Two kinds of radar are never in a topic, and both are refused here as well as
 * by a CHECK constraint.
 *
 * The constraint is the backstop; this is the part that produces a sentence a
 * person — or an agent over MCP, which will absolutely try both — can act on. A
 * silent no-op and a silent success are each worse than a refusal that says why.
 *
 * - **The drop box** is the per-account holding bay for things with no home yet.
 *   It is a per-user singleton with its own provisioning path, and grouping it
 *   would make a private inbox shareable through a side door: one cascade toggle
 *   two screens away would hand every topic member somebody's unsorted pile of
 *   appointments and reminders.
 * - **A smart radar** is a saved query, not a container. It owns no blips, and
 *   what it resolves to is governed by the *reader's* access to each matching
 *   blip's home radar. Putting one in a topic would imply a membership it does
 *   not have, and leaves no good answer to what a topic grant means over a
 *   result set spanning radars the grantee may not be able to read. It must not
 *   change what a smart radar resolves — so it does not belong in one.
 */
export function assertRadarMayJoinTopic(
  radar: { isDropBox: boolean; kind: string; name: string },
  topicId: string | null,
): void {
  if (topicId === null) return;
  if (radar.isDropBox) {
    throw badRequest(
      'The drop box cannot go in a topic. It is the per-account holding bay for things ' +
        'with no home yet, and putting it in an array would make a private inbox shareable ' +
        'through the cascade switch. Move the blips into a real radar and put that in the topic.',
    );
  }
  if (radar.kind === 'smart') {
    throw badRequest(
      `"${radar.name}" is a smart radar — a saved tag search, not a container. It holds no ` +
        'blips of its own and what it finds depends on who is looking, so it cannot be ' +
        'grouped or shared through an array. Put the radars it searches into the array instead.',
    );
  }
}

export async function setRadarTopic(
  actor: Actor,
  radarId: string,
  topicId: string | null,
  patch: Partial<typeof schema.radars.$inferInsert> = {},
): Promise<{ radarId: string; topicId: string | null }> {
  const radar = await requireRadar(radarId, actor, 'manage');
  assertRadarMayJoinTopic(radar.radar, topicId);

  if (topicId === null) {
    // Withdrawing. `manage` on the radar is enough — see the note above.
    const previous = radar.radar.topicId;
    if (previous) {
      const topic = await loadTopicRow(previous);
      if (topic?.cascade) await sweepRadarCascadeNotifications(topic, radar.radar.id);
    }
    await updateRadarPlacement(radar.radar.id, null, patch, getDb());
    await recordAudit(actor, 'topic.remove_radar', 'radar', radar.radar.id, { topicId: previous });
    return { radarId: radar.radar.id, topicId: null };
  }

  const topic = await requireTopic(topicId, actor, 'manage');

  /*
    An array's cascade grants its members access to every radar in it, so the
    person who controls the array's membership must be the person who controls
    the radar. `manage` on both sides is not that: a co-owner of a radar holds
    `manage` on it, can create an array of their own and file the radar there —
    and when the owner later removes them, they still own the array, and can add
    anyone to it. `access.ts` assumes topic owner == radar owner; this is the
    place that makes it so.
  */
  if (topic.topic.ownerId !== radar.radar.ownerId) {
    throw forbidden(
      `"${radar.radar.name}" belongs to somebody else, so it can only go in an array its ` +
        'owner owns. An array shares everything in it with the array’s members, and that ' +
        'is the radar owner’s decision to make.',
    );
  }

  // A topic grants within its own organization only (`access.ts` ignores a cascade that
  // crosses one), so a filing that would cross is refused rather than left to do nothing.
  if (topic.topic.organizationId !== radar.radar.organizationId) {
    throw badRequest(
      `"${radar.radar.name}" and "${topic.topic.name}" belong to different organizations. ` +
        'A radar can only go in an array of the organization it is in.',
    );
  }

  // Filing a radar into a cascading topic that other people are already in hands
  // it to them the instant it lands. That is a sharing decision, not an
  // organising one — and it was fenced only in the MCP tool, so
  // `PUT /api/radars/:id/topic` walked straight past it.
  //
  // A cascading topic with no other members grants nobody anything, so filing
  // into it stays organising and stays an agent's job.
  if (topic.topic.cascade) {
    const others = (await memberUserIds(topic.topic.id)).filter((id) => id !== topic.topic.ownerId);
    if (others.length > 0) {
      assertHumanDecision(
        actor,
        `"${topic.topic.name}" cascades and has ${others.length} other ` +
          `member${others.length === 1 ? '' : 's'}, so filing a radar into it would ` +
          'immediately give them access to it. That is a sharing decision rather than an ' +
          'organising one — ask the user to do it from the array screen.',
      );
    }
  }

  const previousTopicId = radar.radar.topicId;
  await getDb().transaction(async (tx) => {
    /*
      The count and the placement are one step, serialised per array: counted
      apart, two radars filed at once into an array one short of the limit both
      saw room. NO KEY UPDATE rather than UPDATE, so it does not hold up
      somebody being added to the array (a foreign key takes KEY SHARE).
    */
    await tx
      .select({ id: schema.topics.id })
      .from(schema.topics)
      .where(eq(schema.topics.id, topic.topic.id))
      .for('no key update');
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.radars)
      .where(eq(schema.radars.topicId, topic.topic.id));
    if ((count?.n ?? 0) >= LIMITS.radarsPerTopic && radar.radar.topicId !== topic.topic.id) {
      throw conflict(`An array holds at most ${LIMITS.radarsPerTopic} radars.`);
    }

    /*
    A move out of a cascading topic revokes access just as surely as a
    withdrawal does, and this branch did not sweep at all — so moving a radar
    from one array to another left the first array's members holding
    notifications, and mentions, for a radar they can no longer open. The
    withdrawal branch above has always swept; the two directions are the same
    event seen from different ends.

    Before the update, because `radarsReachableOnlyViaTopic` asks which radars
    are *in* the array — after the write there would be nothing to find, which
    is the same ordering trap as reading attachment keys after a delete.
  */
    if (previousTopicId && previousTopicId !== topic.topic.id) {
      const previousTopic = await loadTopicRow(previousTopicId);
      if (previousTopic?.cascade) {
        const keep = topic.topic.cascade
          ? new Set(await memberUserIds(topic.topic.id))
          : new Set<string>();
        await sweepRadarCascadeNotifications(previousTopic, radar.radar.id, keep);
      }
    }

    await updateRadarPlacement(radar.radar.id, topic.topic.id, patch, tx);
  });
  await recordAudit(actor, 'topic.add_radar', 'radar', radar.radar.id, {
    topicId: topic.topic.id,
    cascade: topic.topic.cascade,
    ...(previousTopicId ? { movedFrom: previousTopicId } : {}),
  });
  return { radarId: radar.radar.id, topicId: topic.topic.id };
}

/**
 * Take a radar out of any topic its owner does not own.
 *
 * Called when somebody who held `manage` on the radar loses it (removal, or a
 * co-owner demoted). They may have filed the radar into a topic of their own;
 * that topic's cascade would otherwise keep granting its members — and anyone
 * the former co-owner adds later — access to a radar they no longer control.
 * The cascade notifications are swept first (the radar is still in the topic
 * then), the same ordering `setRadarTopic` keeps on a withdrawal.
 *
 * Idempotent: a radar in no topic, or in its owner's own, is left alone.
 */
export async function detachRadarFromForeignTopic(
  actor: Actor,
  radarId: string,
  db: Pick<Db, 'select' | 'update'> = getDb(),
): Promise<boolean> {
  const [radar] = await db
    .select({
      id: schema.radars.id,
      ownerId: schema.radars.ownerId,
      topicId: schema.radars.topicId,
    })
    .from(schema.radars)
    .where(eq(schema.radars.id, radarId))
    .limit(1);
  if (!radar?.topicId) return false;
  const topic = await loadTopicRow(radar.topicId);
  if (!topic || topic.ownerId === radar.ownerId) return false;
  if (topic.cascade) await sweepRadarCascadeNotifications(topic, radar.id);
  // Guarded on the topic still being the one inspected, so a concurrent legitimate
  // move is not undone.
  const detached = await db
    .update(schema.radars)
    .set({ topicId: null, updatedAt: new Date() })
    .where(and(eq(schema.radars.id, radar.id), eq(schema.radars.topicId, topic.id)))
    .returning({ id: schema.radars.id });
  if (detached.length === 0) return false;
  await recordAudit(actor, 'topic.remove_radar', 'radar', radar.id, {
    topicId: topic.id,
    reason: 'topic owner is not the radar owner',
  });
  return true;
}

/**
 * Rename and placement stay one UPDATE, including when the slug collides. Each
 * attempt is its own (sub)transaction, so a colliding slug rolls back to it and
 * the next candidate can be tried inside a caller's transaction.
 */
async function updateRadarPlacement(
  radarId: string,
  topicId: string | null,
  patch: Partial<typeof schema.radars.$inferInsert>,
  db: Pick<Db, 'transaction'>,
) {
  const write = (slug?: string) =>
    db.transaction((attempt) =>
      attempt
        .update(schema.radars)
        .set({ ...patch, ...(slug ? { slug } : {}), topicId, updatedAt: new Date() })
        .where(eq(schema.radars.id, radarId)),
    );
  if (patch.name === undefined) await write();
  else await withUniqueSlug(patch.name, 'radars_owner_slug_key', write);
}

async function loadTopicRow(topicId: string): Promise<TopicRow | null> {
  const rows = await getDb()
    .select()
    .from(schema.topics)
    .where(eq(schema.topics.id, topicId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One radar leaving a cascading topic: sweep it for everyone who only had it
 * that way — and who is not about to get it back.
 *
 * `keep` is the destination's membership when the radar is being *moved*
 * rather than withdrawn. Somebody who cascades on both topics loses nothing by
 * the move, and sweeping them would delete a notification about something they
 * can still open — a smaller fault than the leak, but a fault, and the sort
 * that reads as data loss.
 */
async function sweepRadarCascadeNotifications(
  topic: TopicRow,
  radarId: string,
  keep: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const userId of await memberUserIds(topic.id)) {
    if (keep.has(userId)) continue;
    const lost = await radarsReachableOnlyViaTopic(topic.id, userId);
    if (lost.includes(radarId)) await sweepLostRadar(userId, radarId);
  }
}

/** Radars in this topic that the caller can read, for the topic page. */
export async function topicRadarIdsFor(topicId: string, readable: Set<string>): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .where(and(eq(schema.radars.topicId, topicId), eq(schema.radars.archived, false)));
  return rows.filter((r) => readable.has(r.id)).map((r) => r.id);
}

/* ------------------------------- membership ------------------------------ */

export async function listTopicMembers(access: TopicAccess): Promise<TopicMemberDto[]> {
  const db = getDb();
  const owner = await ownerSummary(access.topic.ownerId);
  const members = await db
    .select({
      userId: schema.topicMembers.userId,
      role: schema.topicMembers.role,
      createdAt: schema.topicMembers.createdAt,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.topicMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.topicMembers.userId))
    .where(eq(schema.topicMembers.topicId, access.topic.id));

  const invites = await db
    .select()
    .from(schema.topicInvites)
    .where(
      and(eq(schema.topicInvites.topicId, access.topic.id), isNull(schema.topicInvites.acceptedAt)),
    );

  return [
    ...(owner
      ? [
          {
            userId: owner.id,
            email: owner.email,
            name: owner.name,
            role: 'owner' as const,
            pending: false,
            createdAt: access.topic.createdAt.toISOString(),
          },
        ]
      : []),
    ...members.map((m) => ({
      userId: m.userId,
      email: m.email,
      name: m.name,
      role: m.role,
      pending: false,
      createdAt: m.createdAt.toISOString(),
    })),
    ...invites.map((i) => ({
      userId: '',
      email: i.email,
      name: null,
      role: i.role,
      pending: true,
      createdAt: i.createdAt.toISOString(),
    })),
  ];
}

export interface TopicShareResult {
  status: 'added' | 'invited' | 'updated';
  email: string;
  role: TopicRole;
  /**
   * How many radars this grant actually hands over. **Zero unless the topic
   * cascades** — which is the entire point of the feature, and worth returning
   * so a caller (an agent especially) can say what it just did rather than
   * guessing.
   */
  radarsGranted: number;
  /**
   * True when this share also let a waitlisted account into the app. Only an
   * admin's share can do that; see `shareRadar`, which carries the same field
   * for the same reason.
   */
  approved: boolean;
  /** The invitation link, on the `invited` branch only. See `ShareResult`. */
  inviteUrl: string | null;
}

/**
 * Share a topic with an address, whether or not it has an account yet.
 *
 * The email and the notification are raised here rather than in the route, for
 * the reason `shareRadar` gives: telling the recipient is part of what sharing
 * *means*, so it belongs on the one code path both transports run.
 */
export async function shareTopic(
  actor: Actor,
  topicId: string,
  email: string,
  role: TopicRole,
): Promise<TopicShareResult> {
  const access = await requireTopic(topicId, actor, 'manage');

  // On a topic that does not cascade a grant conveys the grouping and no radar
  // at all, which is strictly weaker than `share_radar` — refusing that would be
  // theatre. On a cascading topic it hands over every radar in the topic
  // including ones that do not exist yet, which is wider than anything a
  // connection may grant. The refusal lands exactly where the act changes class.
  //
  // This lived in the MCP tool wrapper, so `POST /api/topics/:id/members` did
  // not honour it.
  if (access.topic.cascade) {
    assertHumanDecision(
      actor,
      `"${access.topic.name}" cascades, so a grant on it hands over every radar in the ` +
        'array — including radars added to it in future. That is wider than anything this ' +
        'connection may grant. Share the individual radars instead, or ask the user to ' +
        'share the array from its own screen.',
    );
  }

  const normalized = normalizeEmail(email);
  const db = getDb();

  if (normalized === actor.user.email) throw badRequest('You already own this array');

  const radarCount = access.topic.cascade ? (await topicRadarIds(access.topic.id)).length : 0;

  const [existingUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalized))
    .limit(1);

  if (!existingUser) {
    assertMayInvite(actor);
    // `onConflictDoUpdate` against the partial unique index, exactly as
    // `shareRadar` does and for the same reason: re-sharing a pending
    // invitation at a higher role must not be silently swallowed.
    let mailJob: string | undefined;
    const invite = await db.transaction(async (tx) => {
      const [invite] = await tx
        .insert(schema.topicInvites)
        .values({ topicId: access.topic.id, email: normalized, role, invitedBy: actor.user.id })
        .onConflictDoUpdate({
          target: [schema.topicInvites.topicId, schema.topicInvites.email],
          targetWhere: isNull(schema.topicInvites.acceptedAt),
          set: { role, invitedBy: actor.user.id },
        })
        .returning();
      if (!invite) throw conflict('That invitation could not be written');

      mailJob = await enqueue(tx, 'email', {
        ...topicSharedMessage(
          normalized,
          access.topic.name,
          actor.user.name ?? actor.user.email,
          {
            hasAccount: false,
            link: inviteUrl('topic', invite.id, invite.createdAt),
            skipsWaitlist: await invitationBypassFor(normalized, tx),
          },
          radarCount,
        ),
      });
      return invite;
    });
    if (mailJob) void drainOne(mailJob).catch(() => undefined);
    await recordAudit(actor, 'topic.invite', 'topic', access.topic.id, { email: normalized, role });
    return {
      status: 'invited',
      email: normalized,
      role,
      radarsGranted: radarCount,
      approved: false,
      inviteUrl: inviteUrl('topic', invite.id, invite.createdAt),
    };
  }

  if (existingUser.id === access.topic.ownerId) {
    throw badRequest('That person already owns this array');
  }

  // An admin sharing with somebody already on the waitlist is the same decision
  // as an admin approving them. See `shareRadar`.
  const approved =
    mayBypassWaitlist(actor) && (await activateUser(actor, existingUser, 'invitation'));

  const [existing] = await db
    .select({ role: schema.topicMembers.role })
    .from(schema.topicMembers)
    .where(
      and(
        eq(schema.topicMembers.topicId, access.topic.id),
        eq(schema.topicMembers.userId, existingUser.id),
      ),
    )
    .limit(1);

  let notificationJob: string | undefined;
  let mailJob: string | undefined;
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.topicMembers)
      .values({
        topicId: access.topic.id,
        userId: existingUser.id,
        role,
        invitedBy: actor.user.id,
      })
      .onConflictDoUpdate({
        target: [schema.topicMembers.topicId, schema.topicMembers.userId],
        set: { role },
      });
    if (!existing) {
      notificationJob = await enqueueNotificationEvent(tx, {
        type: 'topic-share',
        actor,
        topicId: access.topic.id,
        recipientId: existingUser.id,
        radarCount,
      });
      mailJob = await enqueue(tx, 'email', {
        ...topicSharedMessage(
          normalized,
          access.topic.name,
          actor.user.name ?? actor.user.email,
          {
            hasAccount: true,
            link: `${env().APP_URL}/array/${access.topic.id}`,
            skipsWaitlist: false,
          },
          radarCount,
        ),
      });
    }
  });
  if (notificationJob) await drainOne(notificationJob);
  if (mailJob) void drainOne(mailJob).catch(() => undefined);
  await recordAudit(actor, 'topic.share', 'topic', access.topic.id, { email: normalized, role });
  return {
    status: existing ? 'updated' : 'added',
    email: normalized,
    role,
    radarsGranted: radarCount,
    approved,
    inviteUrl: null,
  };
}

export async function removeTopicMember(
  actor: Actor,
  topicId: string,
  userId: string,
): Promise<void> {
  const access = await requireTopic(topicId, actor, 'manage');
  if (userId === access.topic.ownerId) throw conflict('The owner cannot be removed');

  // Sweep while the membership still exists to derive the lost radars from.
  if (access.topic.cascade) await sweepCascadedNotifications(access.topic, { userId });

  await getDb()
    .delete(schema.topicMembers)
    .where(
      and(eq(schema.topicMembers.topicId, access.topic.id), eq(schema.topicMembers.userId, userId)),
    );
  await dropTopicNotifications(userId, access.topic.id);
  await recordAudit(actor, 'topic.unshare', 'topic', access.topic.id, { userId });
}

export async function revokeTopicInvite(
  actor: Actor,
  topicId: string,
  email: string,
): Promise<void> {
  const access = await requireTopic(topicId, actor, 'manage');
  await getDb()
    .delete(schema.topicInvites)
    .where(
      and(
        eq(schema.topicInvites.topicId, access.topic.id),
        eq(schema.topicInvites.email, normalizeEmail(email)),
        isNull(schema.topicInvites.acceptedAt),
      ),
    );
  await recordAudit(actor, 'topic.revoke_invite', 'topic', access.topic.id, { email });
}

/**
 * Claim topic invitations addressed to this account, on first sign-in.
 *
 * Called alongside the radar-invite claim so a person who was handed a topic
 * before they had an account finds it waiting.
 */
export async function claimTopicInvites(userId: string, email: string): Promise<number> {
  const db = getDb();
  const invites = await db
    .select()
    .from(schema.topicInvites)
    .where(and(eq(schema.topicInvites.email, email), isNull(schema.topicInvites.acceptedAt)));
  if (invites.length === 0) return 0;

  for (const invite of invites) {
    await db
      .insert(schema.topicMembers)
      .values({
        topicId: invite.topicId,
        userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      })
      // Most-permissive wins, for the reasons spelled out at the radar twin of
      // this in `auth/accounts.ts`: `onConflictDoNothing` was safe only through
      // an unstated invariant in `shareTopic`, and taking the stronger of the
      // two roles cannot demote anybody however the collision arose.
      .onConflictDoUpdate({
        target: [schema.topicMembers.topicId, schema.topicMembers.userId],
        set: {
          role: sql`CASE WHEN array_position(ARRAY['viewer','editor']::text[], excluded.role)
                            > array_position(ARRAY['viewer','editor']::text[], ${schema.topicMembers.role})
                       THEN excluded.role ELSE ${schema.topicMembers.role} END`,
        },
      });
    await db
      .update(schema.topicInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(schema.topicInvites.id, invite.id));
  }
  return invites.length;
}

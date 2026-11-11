import { notificationAllowed, notificationPreferences } from './notification-preferences.js';
import { queuePushDeliveries } from './push-delivery.js';
/**
 * Notifications.
 *
 * The loop this closes: comments and reactions shipped silent, so a shared
 * radar had no way to pull anybody back to it. Collaboration was one-way. This
 * is the thing that makes it two.
 *
 * Three rules shape everything here.
 *
 * **1. Notify about things aimed at you, not about things you can see.** A
 * stream that cries wolf is muted once and then never read again, at which point
 * it is worse than nothing. So the default is "somebody acted on something of
 * yours" — a comment on your blip or in your thread, a mark on your blip, a
 * radar handed to you, an inbound webhook delivery on a radar you own. Every
 * blip anybody captures is available, but only by opting a radar up to `all`.
 *
 * **2. Coalescing is decided by the database.** Ten reactions on one blip is one
 * notification, and that is enforced by a partial unique index on
 * `(user_id, group_key) WHERE read_at IS NULL` rather than by a read-then-write
 * in here that two simultaneous events could interleave inside. Same argument as
 * the reaction toggle's primary key. Reading a notification closes the window,
 * so the next event starts a fresh row: "you dealt with that one, this is new".
 *
 * **3. Fan-out never fails the thing that caused it.** Every entry point is
 * wrapped, exactly like `recordAudit` — a notification that could not be written
 * must never turn a successful comment into a 500. The transports (email, push)
 * are fire-and-forget on top of that.
 *
 * Recipients are always re-derived from live membership, never from who was
 * involved historically. Somebody whose share was revoked stops being notified
 * immediately, and — since a notification carries an excerpt of the content —
 * that is a disclosure rule, not a tidiness one.
 */
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  DEFAULT_RADAR_NOTIFY_LEVEL,
  isNotificationKind,
  isRadarNotifyLevel,
  NOTIFICATION_PHRASES,
  NOTIFICATIONS,
  type ListNotificationsQuery,
  type NotificationBox,
  type MarkNotificationsReadInput,
  type NotificationCountsDto,
  type NotificationDto,
  type NotificationKind,
  type NotificationPageDto,
  type PendingProposalDto,
  type NotificationPrincipalDto,
  type NotificationRadarDto,
  type RadarAccent,
  type RadarGlyph,
  type RadarNotifyLevel,
  type UpdateNotificationSettingsInput,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { badRequest, type Actor } from '../http.js';
import { logger } from '../logger.js';
import { DECISION_LIVE, readDecisionRequestsFor } from './decision-live.js';
import { enqueue, drainOne, registerOutboxHandler } from './outbox.js';
import { decodeCursor, encodeCursor, isCursorTimestamp, isCursorUuid } from './cursor.js';
import { env, mailConfigured } from '../env.js';
import { notificationMessage, sendMail } from './mail.js';

import {
  assertHumanDecision,
  fenceCaps,
  radarReaders,
  readableRadarIdsFor,
  readableRadarQuery,
  readableTopicQuery,
  topicReaders,
  requireScopeWithinGrants,
  type RadarRow,
  type TopicRow,
} from './access.js';
import type { MentionTarget } from './mentions.js';
import { textValue } from '../text-value.js';

type NotificationRow = typeof schema.notifications.$inferSelect;
type BlipRow = typeof schema.blips.$inferSelect;
type Authorship = Pick<BlipRow, 'authorId' | 'agentId' | 'agentVoice'>;

/** Only committed authorship, never the connection's current default voice. */
function contentActorKey(actor: Actor, source: Authorship): string {
  return source.agentVoice === 'persona' &&
    source.agentId === actor.agent?.agentId &&
    source.authorId === actor.user.id
    ? `agent:${source.agentId}`
    : `human:${actor.user.id}`;
}

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                  */
/* -------------------------------------------------------------------------- */

/** One line of plain text out of a markdown body, for a snapshot. */
function condense(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const flat = value
    .replace(/```[\s\S]*?```/g, ' ')
    // A link keeps its text; plain parentheses and colons are the writer's, so they stay.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a blip is called in a sentence. Falls back to its own words. */
function blipSubject(blip: Pick<BlipRow, 'title' | 'body' | 'url'>): string {
  return (
    condense(blip.title, NOTIFICATIONS.subjectChars) ??
    condense(blip.body, NOTIFICATIONS.subjectChars) ??
    condense(blip.url, NOTIFICATIONS.subjectChars) ??
    'a blip'
  );
}

/* -------------------------------------------------------------------------- */
/* Recipients                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everyone who can currently read a radar, with the level they have chosen.
 *
 * Live membership, every time. A prior commenter whose access was revoked must
 * drop out of the fan-out immediately — the notification would otherwise carry
 * an excerpt of a conversation they can no longer read.
 *
 * Suspended and pending accounts are excluded here rather than at delivery: a
 * suspended account has had every session revoked, and queueing mail for it
 * would be the one path still talking to somebody who has been shut out.
 */
async function audience(radar: RadarRow): Promise<Map<string, RadarNotifyLevel>> {
  // Who can read it is an access question, so it is answered in exactly one
  // place. This used to be a second, narrower query here that joined only the
  // owner and the direct members — written before topics existed and never
  // widened when they landed, so **a person reaching a radar through a cascading
  // topic received no notifications about it at all**: not a comment on their
  // blip, not a reply in their thread, nothing. Deriving the audience from
  // `radarReaders` is what stops the two answers drifting apart again.
  const readers = await radarReaders(radar);
  if (readers.length === 0) return new Map();

  const prefs = await getDb()
    .select({
      userId: schema.radarNotificationPrefs.userId,
      level: schema.radarNotificationPrefs.level,
    })
    .from(schema.radarNotificationPrefs)
    .where(
      and(
        eq(schema.radarNotificationPrefs.radarId, radar.id),
        inArray(
          schema.radarNotificationPrefs.userId,
          readers.map((r) => r.id),
        ),
      ),
    );
  const chosen = new Map(prefs.map((row) => [row.userId, row.level]));

  const out = new Map<string, RadarNotifyLevel>();
  for (const reader of readers) {
    const level = chosen.get(reader.id);
    // An unrecognised stored level degrades to the default rather than muting
    // somebody by accident — the same rule as an unknown lane or reaction.
    out.set(reader.id, isRadarNotifyLevel(level) ? level : DEFAULT_RADAR_NOTIFY_LEVEL);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One addressee of one notification.
 *
 * `userId` is **always a human**, even when the queue belongs to an agent —
 * `notifications.user_id` stays NOT NULL and stays the agent's owner, because
 * coalescing is a partial unique index on `(user_id, group_key)` and a NULL
 * there would mean agent rows never conflict, so folding would silently stop
 * working for agents while the index went on looking correct. See the migration.
 */
export interface Recipient {
  userId: string;
  /** Set when this is an agent's queue rather than its owner's own. */
  agentId: string | null;
}

/** Most entry points address people, so this is the common shape. */
function people(userIds: string[]): Recipient[] {
  return userIds.map((userId) => ({ userId, agentId: null }));
}

interface FanOut {
  eventJobId?: string | undefined;
  kind: NotificationKind;
  /**
   * Who caused it. The whole actor rather than an id, because the self-filter
   * below has to compare *principals* and an agent-borne act has two.
   */
  actor: Actor;
  /**
   * Exactly one of `radar` and `topic` is set. Every kind but the two topic
   * ones happens *on a radar*; a topic share and a cascade change happen on the
   * container and have no radar to point at.
   */
  radar?: RadarRow | null;
  topic?: TopicRow | null;
  blipId?: string | null;
  groupKey: string;
  subject: string | null;
  excerpt: string | null;
  recipients: Recipient[];
  /** A stored persona-voice comment is the agent speaking to its human cosigner. */
  agentCommentCosignerId?: string | null;
  actorKey?: string;
}

/**
 * A recipient key that distinguishes the two principals behind one act.
 *
 * `agent:<id>:mention:comment:<id>` for an agent's queue, the bare key for a
 * person's. Namespacing rather than a new conflict arbiter is what lets both
 * keep using the existing partial unique index: the two key spaces can never
 * meet, so a fold in one can never touch the other.
 */
function groupKeyFor(recipient: Recipient, groupKey: string): string {
  return recipient.agentId ? `agent:${recipient.agentId}:${groupKey}` : groupKey;
}

/**
 * Is this notification addressed to the very principal that caused it?
 *
 * The old rule was `id !== event.actorId`, keyed on the user alone, and it is
 * **wrong the moment an agent has an identity** — in the single most likely way
 * anybody will use this feature. A person mentioning their own `@claude` produces a
 * recipient whose `userId` is that person's, because that is whose queue holds it, so
 * the old filter dropped it. `@claude` in their own radar would have reached
 * nothing, silently, with no error anywhere.
 *
 * Pairwise, the rule reads the way it is meant: suppress when the addressee *is*
 * the actor.
 *
 *   * A row addressed to a person is suppressed when that person acted —
 *     including when they acted through their agent, because an agent-borne
 *     capture is still the human's act. "Do not interrupt me about my own drop
 *     box" stays true. A webhook is external delivery rather than the human's
 *     act, even though authorization attributes it to that human.
 *   * A row addressed to an agent is suppressed only when **that** agent acted.
 *     Its owner writing to it is not it writing to itself.
 */
/**
 * Did this arrive from outside rather than being the human's own act?
 *
 * True for a webhook delivery (a radar webhook, inbound email, a feed) and for
 * an integration (the W&W portal: a client's request or reply). Both are
 * attributed to the owner for authorization and audit, and the owner did
 * neither. **The one copy of this question in this file**: a test fails if
 * a second test of the actor's kind against 'webhook' appears, because that copy is
 * the one that drifts — an integration missing from `notifyBlip` meant a new
 * client request never reached the product owner (`docs/HELPDESK.md` §3.3).
 */
export function isExternalDelivery(actor: Pick<Actor, 'kind'>): boolean {
  return actor.kind === 'webhook' || actor.kind === 'integration' || actor.kind === 'guest';
}

function isSelfAddressed(recipient: Recipient, actor: Actor): boolean {
  // External capture is attributed to its owner for authorization and audit,
  // but the owner did not perform the delivery. This includes inbound email.
  if (isExternalDelivery(actor) && recipient.agentId === null) return false;
  return recipient.agentId === null
    ? recipient.userId === actor.user.id
    : recipient.agentId === actor.agent?.agentId;
}

/**
 * The one write path.
 *
 * The upsert is a single statement so that folding cannot race: `ON CONFLICT
 * (user_id, group_key) WHERE read_at IS NULL` names the partial unique index
 * from the migration, and `xmax = 0` in the RETURNING tells us whether this row
 * was inserted or folded into — which is what decides whether anything is sent.
 * A folded event deliberately sends nothing: that is the whole point of
 * coalescing, and it is also what stops a busy thread emitting an email per
 * remark.
 *
 * `actor_ids` accumulates distinct people, most recent first, capped. `count`
 * is incremented on every event and never decremented — a reaction taken back
 * does not un-happen.
 */
async function fanOut(event: FanOut): Promise<void> {
  const actorKey = event.actorKey ?? `human:${event.actor.user.id}`;
  const seen = new Set<string>();
  const candidates = event.recipients.filter((recipient) => {
    const key = `${recipient.userId}:${recipient.agentId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // `due` is addressed to you by you, by design. `reply_pending` is usually
    // your own agent's draft, and an agent-borne act counts as yours for the
    // self-filter — which would leave the one person who can release it never
    // told it exists. Both are about something only you can act on.
    // `decision` is an agent asking its own owner, whom the filter would otherwise count as the
    // asker: the whole point is that the person it is waiting on is told.
    return (
      event.kind === 'due' ||
      event.kind === 'reply_pending' ||
      event.kind === 'decision' ||
      (event.kind === 'comment' &&
        recipient.agentId === null &&
        recipient.userId === event.agentCommentCosignerId) ||
      !isSelfAddressed(recipient, event.actor)
    );
  });
  if (candidates.length === 0) return;

  const db = getDb();

  /*
   * Only active accounts, decided here rather than at each entry point.
   *
   * Suspension revokes every session immediately — that is the rule — and email
   * and push are the two paths that still reach somebody after their sessions
   * are gone. Most kinds arrive already filtered because they derive their
   * recipients from `audience`, and so from `radarReaders`, which requires
   * `users.state = 'active'`. But the ones that do not go through a radar
   * audience carried raw ids: `notifyShare` takes whoever `shareRadar` resolved
   * from an email address, and the topic kinds take `memberUserIds`, a bare
   * select over `topic_members`. So sharing a radar or a cascading topic with a
   * suspended account still sent them mail and a push banner.
   *
   * Putting the filter on the single write path means no present or future
   * entry point can bypass it, which is the same argument as authorization
   * living only in `requireRadar`. It also skips the row itself, not merely the
   * delivery: a notification a suspended person cannot read is not something to
   * keep for them, and a reinstated account should not be handed a backlog of
   * everything that happened while they were shut out.
   */
  const active = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(
          schema.users.id,
          candidates.map((r) => r.userId),
        ),
        eq(schema.users.state, 'active'),
      ),
    );
  const live = new Set(active.map((row) => row.id));
  // An agent's row is filtered by its *owner's* state, which is the whole of
  // an agent's liveness: it acts only through a live token held by a live
  // human, so a suspended owner silences their agents by the same rule and in
  // the same place, with nothing extra to remember.
  const recipients = candidates.filter((r) => live.has(r.userId));
  const [firstRecipient] = recipients;
  if (!firstRecipient) return;
  const jobs: string[] = [];
  await db.transaction(async (tx) => {
    // Serialize due creation against edit/unsubscribe, then check the current
    // schedule again inside the commit that creates the notification.
    if (event.kind === 'due' && event.blipId) {
      const [blip] = await tx
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.id, event.blipId))
        .for('update');
      if (!blip || blip.radarId !== event.radar?.id || ['done', 'dropped'].includes(blip.state))
        return;
      const [reminder] = await tx
        .select()
        .from(schema.blipReminders)
        .where(
          and(
            eq(schema.blipReminders.blipId, blip.id),
            eq(schema.blipReminders.userId, firstRecipient.userId),
          ),
        )
        .for('update');
      if (
        !reminder?.enabled ||
        !reminder.queuedAt ||
        !reminder.reminderAt ||
        reminder.revision !== blip.dueRevision ||
        event.groupKey !== `due:${blip.id}:${reminder.userId}:${reminder.revision}` ||
        Date.now() - reminder.reminderAt.getTime() > 3_600_000
      )
        return;
    }
    if (event.eventJobId) {
      const [job] = await tx
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.id, event.eventJobId))
        .for('update');
      // The completion marker and the fanout share one commit. A worker that
      // dies before deleting its job cannot fold this event a second time.
      if (!job || job.payload['notificationEventDone'] === true) return;
    }
    for (const recipient of recipients) {
      const userId = recipient.userId;
      const groupKey = groupKeyFor(recipient, event.groupKey);
      // Raw SQL rather than Drizzle's insert builder: `ON CONFLICT ... WHERE` is
      // how a *partial* unique index is named as the conflict arbiter, and that
      // predicate is the whole coalescing rule. Nothing else can express it.
      const result = await tx.execute<RawNotificationRow>(sql`
      INSERT INTO notifications
        (user_id, agent_id, kind, radar_id, topic_id, blip_id, group_key, count,
         actor_ids, actor_keys, attributed_event_count, subject, excerpt)
      VALUES (
        ${userId}::uuid, ${recipient.agentId}::uuid,
        ${event.kind}, ${event.radar?.id ?? null}::uuid,
        ${event.topic?.id ?? null}::uuid,
        ${event.blipId ?? null}::uuid, ${groupKey}, 1,
        ARRAY[${event.actor.user.id}::uuid], ARRAY[${actorKey}::text], 1,
        ${event.subject}, ${event.excerpt}
      )
      ON CONFLICT (user_id, group_key) WHERE read_at IS NULL DO UPDATE SET
        count      = notifications.count + 1,
        -- Increment even when this principal already appears in actor_keys.
        -- Old writers only increment count, exposing unattributed events.
        attributed_event_count = notifications.attributed_event_count + 1,
        actor_keys = (
          ARRAY[${actorKey}::text] || array_remove(notifications.actor_keys, ${actorKey}::text)
        )[1:${sql.raw(String(NOTIFICATIONS.maxActors))}],
        -- Most recent first, distinct, capped. Somebody who acts twice moves to
        -- the front of the sentence rather than appearing in it twice.
        actor_ids  = (
          ARRAY[${event.actor.user.id}::uuid]
          || array_remove(notifications.actor_ids, ${event.actor.user.id}::uuid)
        )[1:${sql.raw(String(NOTIFICATIONS.maxActors))}],
        -- The newest event's words are the ones worth showing. The subject only
        -- moves when there is one, so a group whose blip has gone keeps its name.
        subject    = COALESCE(EXCLUDED.subject, notifications.subject),
        excerpt    = EXCLUDED.excerpt,
        blip_id    = EXCLUDED.blip_id,
        -- Folding un-SEES a row: something new happened, so it should draw the
        -- eye again even though the line was already on screen. It cannot
        -- un-READ one — a read row is excluded by the index predicate above,
        -- which is exactly what makes a fresh row start after you deal with it.
        seen_at    = NULL,
        updated_at = now()
      RETURNING *, (xmax = 0) AS inserted
    `);

      const raw = result.rows[0];
      if (raw && event.kind === 'due' && event.blipId)
        await tx
          .update(schema.blipReminders)
          .set({ triggeredAt: new Date() })
          .where(
            and(
              eq(schema.blipReminders.blipId, event.blipId),
              eq(schema.blipReminders.userId, userId),
              eq(schema.blipReminders.revision, Number(event.groupKey.split(':').at(-1))),
            ),
          );
      // Only a genuinely new row is delivered anywhere. A fold sending nothing is
      // the entire point of coalescing — it is also what stops a live thread
      // emitting one email per remark with no scheduler involved.
      if (raw?.inserted) jobs.push(await enqueue(tx, 'notification', { notificationId: raw.id }));
    }
    if (event.eventJobId) {
      await tx
        .update(schema.outbox)
        .set({
          payload: sql`${schema.outbox.payload} || '{"notificationEventDone":true}'::jsonb`,
        })
        .where(eq(schema.outbox.id, event.eventJobId));
    }
  });
  // Kicks run after commit; durable rows remain for the worker if a kick is lost.
  for (const job of jobs) void drainOne(job).catch(() => undefined);
}

/**
 * The outbox re-reads the row rather than carrying it: state must be current
 * at delivery time, not enqueue time. Two consequences are deliberate. A row
 * deleted before delivery — a member removed, taking their notifications with
 * them — silently cancels the email and the push, which is exactly what
 * removing them means. And a re-run past the lease re-checks `emailed_at` and
 * `pushed_at`, so the duplicate a lease overrun permits is a re-attempt of an
 * UNSTAMPED transport, never a second copy of a stamped one.
 */
registerOutboxHandler('notification', async (payload) => {
  const id = textValue(payload['notificationId']);
  if (!id) return;
  const [row] = await getDb()
    .select()
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.id, id), notificationAccess(sql`${schema.notifications.userId}`)),
    )
    .limit(1);
  if (!row) return;
  await deliver(row);
});

/**
 * `db.execute` hands back raw pg rows, which are snake_case — Drizzle's column
 * mapping only applies to its own query builders. Converting here keeps every
 * consumer working in the camelCase row type the rest of the file uses.
 */
export interface RawNotificationRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  agent_id: string | null;
  kind: NotificationKind;
  radar_id: string | null;
  topic_id: string | null;
  blip_id: string | null;
  group_key: string;
  count: number;
  actor_ids: string[];
  actor_keys: string[];
  attributed_event_count: number;
  subject: string | null;
  excerpt: string | null;
  /*
    Strings, not Dates, and that is not a typo.

    Drizzle's node-postgres driver installs its own type parsers and hands
    timestamps back as raw strings from `db.execute`, converting to `Date` only
    inside its query builders. Declaring these as `Date` made the compiler agree
    with an assumption the runtime does not hold, and `fromRaw` passed the
    strings straight into a `NotificationRow` — where the first `.toISOString()`
    threw. That call is in `hydrate`, which `deliver` uses, so **every email and
    every push failed** into the `catch` in `deliver` and was logged as a warning
    rather than surfacing. The notification stream was unaffected, because it
    reads through the query builder — which is precisely why the failure was
    invisible from the UI.
  */
  seen_at: string | null;
  read_at: string | null;
  emailed_at: string | null;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
  inserted: boolean;
}

/** `null` in, `null` out; anything else becomes the Date the row type promises. */
function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * Exported as a test seam. The bug it now guards against was invisible from
 * every public entry point — the stream reads through the query builder and was
 * always correct, while the delivery path took the raw row and died inside a
 * `catch` that only logged.
 */
export function fromRaw(raw: RawNotificationRow): NotificationRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    agentId: raw.agent_id,
    kind: raw.kind,
    radarId: raw.radar_id,
    topicId: raw.topic_id,
    blipId: raw.blip_id,
    groupKey: raw.group_key,
    count: raw.count,
    actorIds: raw.actor_ids,
    actorKeys: raw.actor_keys,
    attributedEventCount: raw.attributed_event_count,
    subject: raw.subject,
    excerpt: raw.excerpt,
    seenAt: toDate(raw.seen_at),
    readAt: toDate(raw.read_at),
    emailedAt: toDate(raw.emailed_at),
    pushedAt: toDate(raw.pushed_at),
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
  };
}

/**
 * Email and push for one newly created notification.
 *
 * Deliberately triggered by row *creation* rather than on a timer. That is what
 * makes a digest unnecessary: the coalescing key already folds a burst into one
 * row, so a burst is one email, and the next one cannot arrive until the person
 * has read this one and closed the window. No scheduler, no worker, and no
 * second process to keep alive on a single replica.
 */
async function deliver(row: NotificationRow): Promise<void> {
  /*
    An agent has no mailbox and no browser.

    Notifying one means an unread queue drained on connect — which
    `list_notifications` already is — and nothing else. Emailing its owner would
    be the wrong sentence to the wrong principal, and pushing a banner would put
    the agent's business on the human's phone. So this returns before either
    transport, and before the settings read, because there is nothing here that
    any setting could switch on.
  */
  if (row.agentId !== null) return;

  // Three boundaries, not one.
  //
  // This used to be a single `try` spanning the settings read, `hydrate`, the
  // user lookup and both transports, ending in one `logger.warn`. That shape is
  // what turned a type mismatch in `fromRaw` into a total, silent outage of
  // every email and every push: one throw anywhere, one warning line, and the
  // notification stream — which reads through the query builder and was always
  // fine — showed nothing wrong. The *cause* was fixed; the shape was not, so
  // any new throw reproduced the same outage. Now a failure in one transport
  // cannot hide a failure in the other, and neither can hide a failure in the
  // work they share.
  let dto: NotificationDto | undefined;
  let emailEnabled = true;
  let pushEnabled = true;
  try {
    // Absence is the default: no settings row means both transports are on.
    // Push is asked the same whole question as email — account switch, the
    // kind's own switch, a muted radar — so a kind somebody turned off for push
    // no longer queues a receipt per device only to cancel each one at send.
    emailEnabled = (await notificationAllowed(row.userId, row.kind, row.radarId, 'email')).allowed;
    pushEnabled = (await notificationAllowed(row.userId, row.kind, row.radarId, 'push')).allowed;

    [dto] = await hydrate([row]);
  } catch (err) {
    // `error`, not `warn`: this is the failure that takes out both transports
    // at once, and the sentence has to say so rather than reading like one
    // dropped email.
    logger.error(
      { err, notificationId: row.id, userId: row.userId },
      'notification not delivered by any transport — could not read settings or render it',
    );
    throw err;
  }
  if (!dto) return;
  const failures: unknown[] = [];

  if (pushEnabled && row.pushedAt === null) {
    try {
      await queuePushDeliveries(row);
    } catch (error) {
      failures.push(error);
    }
  }

  if (emailEnabled && mailConfigured(env()) && row.emailedAt === null) {
    try {
      const [user] = await getDb()
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, row.userId))
        .limit(1);
      if (user) {
        // Awaited, and stamped only on success.
        //
        // `sendMailQuietly` is fire-and-forget, so `stampEmailed` ran on the
        // line after it and `emailed_at` recorded *intent* — it was set for
        // every notification whose email Resend then rejected. A column that
        // means "we meant to" is worse than no column, because it reads like
        // evidence. It now means the message was accepted, which makes
        // `emailed_at IS NULL` on a recent unread row an answerable question
        // rather than a guess.
        //
        // Nothing is waiting on this: `fanOut` calls `deliver` with `void`, so
        // awaiting here costs the caller nothing and buys a true stamp.
        await sendMail(
          notificationMessage(user.email, dto.title, dto.excerpt, notificationHref(dto)),
        );
        await stampEmailed(row.id);
      }
    } catch (err) {
      logger.error(
        { err, notificationId: row.id, userId: row.userId },
        'notification email failed — emailed_at left unset',
      );
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Notification delivery incomplete');
}

async function stampEmailed(id: string): Promise<void> {
  await getDb()
    .update(schema.notifications)
    .set({ emailedAt: new Date() })
    .where(eq(schema.notifications.id, id));
}

/**
 * Where a notification points. Deep-links to the blip when there still is one.
 *
 * `native` keeps the array page at `/topic/`: the shipped iOS app routes a push by
 * its path and does not know `/array/` until its own release (the web redirects
 * `/topic/` either way).
 */
function notificationHref(dto: NotificationDto, native = false): string {
  const base = env().APP_URL;
  if (dto.radar && dto.blipId) return `${base}/radar/${dto.radar.id}?blip=${dto.blipId}`;
  if (dto.radar) return `${base}/radar/${dto.radar.id}`;
  if (dto.topic) return `${base}/${native ? 'topic' : 'array'}/${dto.topic.id}`;
  return `${base}/notifications`;
}

/**
 * Every entry point below is wrapped in this. A notification is a courtesy on
 * top of an action that already succeeded; it must never be the reason the
 * action reports failure. Identical rule to `recordAudit`.
 */
async function quietly(what: string, fn: () => Promise<void>, eventJobId?: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (eventJobId) throw err;
    logger.warn({ err, what }, 'notification fan-out failed');
  }
}

/* -------------------------------------------------------------------------- */
/* Entry points — one per event the application can actually produce           */
/* -------------------------------------------------------------------------- */

/**
 * Somebody commented.
 *
 * Recipients are the blip's author plus everyone already in the thread — the
 * "conversation you are in" rule, which is the only one that cannot cry wolf —
 * widened to the whole radar for anybody who set it to `all`.
 */
export async function notifyComment(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  comment: Pick<
    typeof schema.blipComments.$inferSelect,
    'body' | 'authorId' | 'agentId' | 'agentVoice'
  >,
  /**
   * People already told about this same comment by name. A mention is the
   * stronger sentence, so it wins and this one stays quiet — otherwise being
   * addressed in a reply to your own blip would arrive twice, from one act.
   */
  mentioned: string[] = [],
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'comment',
    async () => {
      const levels = await audience(radar);
      const addressed = new Set(mentioned);

      const priorAuthors = await getDb()
        .selectDistinct({ authorId: schema.blipComments.authorId })
        .from(schema.blipComments)
        .where(eq(schema.blipComments.blipId, blip.id));

      const involved = new Set<string>();
      if (blip.authorId) involved.add(blip.authorId);
      for (const row of priorAuthors) if (row.authorId) involved.add(row.authorId);

      const recipients: string[] = [];
      for (const [userId, level] of levels) {
        if (level === 'none') continue;
        if (addressed.has(userId)) continue;
        if (level === 'all' || involved.has(userId)) recipients.push(userId);
      }

      await fanOut({
        eventJobId,
        kind: 'comment',
        actorKey: contentActorKey(actor, comment),
        // The persisted voice is authoritative: a token's default can differ
        // from the voice selected for this particular reply. Principal voice
        // remains the person's own act; persona voice is another participant.
        agentCommentCosignerId:
          comment.agentVoice === 'persona' &&
          comment.agentId === actor.agent?.agentId &&
          comment.authorId === actor.user.id
            ? comment.authorId
            : null,
        actor,
        radar,
        blipId: blip.id,
        groupKey: `comment:${blip.id}`,
        subject: blipSubject(blip),
        excerpt: condense(comment.body, NOTIFICATIONS.excerptChars),
        recipients: people(recipients),
      });
    },
    eventJobId,
  );
}

/**
 * Somebody put a mark on a blip.
 *
 * Only the author, and only when a mark went *on*. Taking one back is not an
 * event anybody needs to hear about, and `all` deliberately does not widen this
 * one: a reaction to somebody else's blip is not your business, and reactions
 * are the cheapest act in the application, so they are the likeliest to flood.
 */
/**
 * Somebody addressed you by name.
 *
 * The only kind that reaches a person who is neither the blip's author nor
 * already in the thread — which is the whole gap it exists to close — and the
 * only kind that deliberately **never coalesces**.
 *
 * ## Why it does not coalesce
 *
 * Coalescing is right when the events are interchangeable: ten reactions on one
 * blip is one fact, and "ten people reacted" says all of it. A mention is not a
 * fact about a blip, it is an *address* — somebody chose you and wrote something
 * for you to read. Folding two into "mentioned you 2 times" throws away which
 * two, so the notification stops being actionable and becomes a prompt to go
 * hunting. The group key therefore names the comment (or the blip), which is
 * unique per source and so can never conflict with another.
 *
 * The thing coalescing usually protects against — a burst of noise — is handled
 * a level up instead: `reconcileMentions` returns only the *newly* addressed, so
 * re-saving a body notifies nobody a second time, and `LIMITS.mentionsPerBody`
 * bounds one body's fan-out.
 *
 * ## Why it respects a muted radar
 *
 * `level === 'none'` wins, and that is a decision rather than an oversight. This
 * is the highest-signal event the application has, so there is a real case for
 * letting it through — but a mute that a colleague can defeat by typing your
 * name is not a mute, and the level's own hint promises silence. The one thing
 * that still gets through `none` is an access change, which is not activity.
 *
 * Recipients are passed in already resolved, and resolution drew them from
 * `radarReaders` — so this cannot notify somebody who is unable to open what
 * they were named in, no matter what was typed.
 */
export async function notifyMention(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  /** Null when the mention is in the blip's own body rather than in a reply. */
  commentId: string | null,
  body: string,
  mentioned: MentionTarget[],
  eventJobId?: string,
  source: Authorship = blip,
): Promise<void> {
  if (mentioned.length === 0) return;
  await quietly(
    'mention',
    async () => {
      const levels = await audience(radar);
      const recipients: Recipient[] = [];
      for (const target of mentioned) {
        /*
        An agent's audibility is its owner's, and the owner's level governs both.

        That is the honest reading of the level rather than a shortcut. `none`
        means "do not interrupt me about this radar", and an agent's queue is
        drained by the same person's tooling — a mute a colleague can defeat by
        addressing your agent instead of you is not a mute. It also keeps the
        existing rule intact: absent means access was revoked between the body
        being written and this running, and live membership wins.
      */
        const level = levels.get(target.ownerId);
        if (level === undefined || level === 'none') continue;
        recipients.push({ userId: target.ownerId, agentId: target.agentId });
      }

      await fanOut({
        eventJobId,
        kind: 'mention',
        actorKey: contentActorKey(actor, source),
        actor,
        radar,
        blipId: blip.id,
        // Unique per source, so this key can never fold into an existing row.
        // `groupKeyFor` namespaces an agent's copy, so naming both a person and
        // their agent in one comment produces two rows that cannot fold together.
        groupKey: commentId ? `mention:comment:${commentId}` : `mention:blip:${blip.id}`,
        subject: blipSubject(blip),
        excerpt: condense(body, NOTIFICATIONS.excerptChars),
        recipients,
      });
    },
    eventJobId,
  );
}

export async function notifyReaction(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  eventJobId?: string,
): Promise<void> {
  const authorId = blip.authorId;
  if (!authorId || authorId === actor.user.id) return;
  await quietly(
    'reaction',
    async () => {
      const levels = await audience(radar);
      const level = levels.get(authorId);
      if (level === undefined || level === 'none') return;

      await fanOut({
        eventJobId,
        kind: 'reaction',
        actor,
        radar,
        blipId: blip.id,
        groupKey: `reaction:${blip.id}`,
        subject: blipSubject(blip),
        excerpt: null,
        recipients: people([authorId]),
      });
    },
    eventJobId,
  );
}

/**
 * A radar was shared with somebody.
 *
 * The one kind that ignores the per-radar level, because there cannot be one
 * yet and because this is an access change rather than activity — it is the
 * message that tells you the radar exists at all.
 */
export async function notifyShare(
  actor: Actor,
  radar: RadarRow,
  recipientId: string,
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'share',
    async () => {
      await fanOut({
        eventJobId,
        kind: 'share',
        actor,
        radar,
        blipId: null,
        groupKey: `share:${radar.id}`,
        subject: radar.name,
        excerpt: condense(radar.tagline, NOTIFICATIONS.excerptChars),
        recipients: people([recipientId]),
      });
    },
    eventJobId,
  );
}

/**
 * A topic was shared with somebody.
 *
 * Its own kind rather than `share` at a different scope, for two reasons that
 * are really one: a topic notification has no radar to point at, and the
 * sentence a person needs to read is genuinely different. "Ada shared the topic
 * I Am Well Foundation with you" and "Ada shared Kanban with you" mean different
 * things — the first may hand over nothing at all — and collapsing them would
 * make the stream lie about what access somebody just got.
 *
 * Deliberately **one notification, not one per radar**, even when the topic
 * cascades. One act by one person is one line; enumerating the radars would turn
 * a single share into N notifications and is exactly how a stream gets muted.
 * The radar count rides in the excerpt instead.
 *
 * Ignores the per-radar level for the same reason `notifyShare` does: this is an
 * access change rather than activity, and it is the message that tells somebody
 * the topic exists at all.
 */
export async function notifyTopicShare(
  actor: Actor,
  topic: TopicRow,
  recipientId: string,
  radarCount: number,
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'topic_share',
    async () => {
      await fanOut({
        eventJobId,
        kind: 'topic_share',
        actor,
        topic,
        blipId: null,
        groupKey: `topic_share:${topic.id}`,
        subject: topic.name,
        excerpt:
          radarCount > 0
            ? `Comes with ${radarCount} radar${radarCount === 1 ? '' : 's'}.`
            : 'Radars in it are shared separately.',
        recipients: people([recipientId]),
      });
    },
    eventJobId,
  );
}

/**
 * Cascading was switched **on** for a topic somebody is already in.
 *
 * This is the one moment where access widens without anybody being shared
 * anything, so it is the one that most needs saying out loud: a person who was
 * given a grouping last month suddenly has read or write access to every radar
 * in it. Silence here is exactly the leak the cascade design is otherwise built
 * to avoid, and the audit log is not something a person reads.
 *
 * Its own group key, so it can never fold into the `topic_share` line that
 * granted the topic in the first place — those are two different sentences and
 * folding them would print the wrong one.
 *
 * There is deliberately no counterpart for switching it **off**. Removing a
 * radar member does not notify either, and "your access was taken away" is a
 * message this application sends nowhere else; adding it here would make it the
 * only one. The access simply stops, immediately, and the notifications that
 * carried excerpts of it are swept.
 */
export async function notifyTopicCascade(
  actor: Actor,
  topic: TopicRow,
  recipientIds: string[],
  radarCount: number,
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'topic_cascade',
    async () => {
      await fanOut({
        eventJobId,
        kind: 'topic_cascade',
        actor,
        topic,
        blipId: null,
        groupKey: `topic_cascade:${topic.id}`,
        subject: topic.name,
        excerpt: `You can now reach ${radarCount} radar${radarCount === 1 ? '' : 's'} in it.`,
        recipients: people(recipientIds),
      });
    },
    eventJobId,
  );
}

/**
 * A blip landed in a radar.
 *
 * The carve-out that makes this kind worth having: at the default level nobody
 * hears about a blip a *person* captured — capture is the primary action, and a
 * shared radar between two active people would otherwise emit one of these per
 * thought. A **webhook** delivery is different. It arrives from outside with
 * nobody watching, which is the whole reason webhooks exist, so the radar's
 * owner and the webhook's creator are told by default. Anyone who actually
 * wants every blip sets the radar to `all`.
 */
export async function notifyBlip(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'blip',
    async () => {
      const viaWebhook = isExternalDelivery(actor);
      const [email] = await getDb()
        .select({ id: schema.blipEmails.blipId })
        .from(schema.blipEmails)
        .where(eq(schema.blipEmails.blipId, blip.id));
      const levels = await audience(radar);

      const recipients: string[] = [];
      for (const [userId, level] of levels) {
        if (level === 'none') continue;
        if (level === 'all') {
          recipients.push(userId);
          continue;
        }
        // `involved` for a new blip means "this arrived from outside and it is
        // your radar" — the owner, and whoever wired the webhook up.
        if (viaWebhook && (userId === radar.ownerId || userId === actor.user.id)) {
          recipients.push(userId);
        }
      }

      await fanOut({
        eventJobId,
        kind: email ? 'email_received' : 'blip',
        actorKey: contentActorKey(actor, blip),
        actor,
        radar,
        blipId: blip.id,
        // Grouped by radar rather than by blip: twelve form submissions are "12
        // new blips in Contact Form", not twelve lines.
        groupKey: email ? `email_received:${blip.id}` : `blip:${radar.id}`,
        subject: radar.name,
        // `||`, not `??`: a bare-link capture stores an empty body, and the link
        // is then the only thing worth showing.
        excerpt: condense(blip.title || blip.body || blip.url, NOTIFICATIONS.excerptChars),
        recipients: people(recipients),
      });
    },
    eventJobId,
  );
}

/**
 * A reply to a client waits for the radar owner's review (`docs/HELPDESK.md`
 * §7.2).
 *
 * Only the owner: the release is theirs alone, so telling anybody else would be
 * a notification nobody receiving it can act on. Folded per radar — five drafts
 * from one triage pass are one line, "5 replies wait for your review" — and the
 * blip it points at is the newest. A muted radar (`none`) stays muted, for the
 * reason a mention respects it; the drafts are still on the cards, labelled.
 */
export async function notifyReplyPending(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  replyBody: string,
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'reply_pending',
    async () => {
      const levels = await audience(radar);
      const level = levels.get(radar.ownerId);
      if (level === undefined || level === 'none') return;
      await fanOut({
        eventJobId,
        kind: 'reply_pending',
        actor,
        radar,
        blipId: blip.id,
        groupKey: `reply_pending:${radar.id}`,
        subject: radar.name,
        excerpt: condense(replyBody, NOTIFICATIONS.excerptChars),
        recipients: people([radar.ownerId]),
      });
    },
    eventJobId,
  );
}

/**
 * A save of the charter took the words an ADR amends (`services/charter.ts`).
 *
 * Told to the ADR's author only: they are the person who can re-anchor it, dismiss it or reject
 * the ADR, and the person who made the save has the orphan list in their own response (the actor
 * filter in `fanOut` drops them when they are the same person, an agent of theirs included).
 * Folded per radar while unread, so a morning of edits that strands five amendments is one line,
 * and a muted radar stays muted.
 */
export async function notifyCharterOrphaned(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  recipientId: string,
  quote: string,
  eventJobId?: string,
): Promise<void> {
  await quietly(
    'charter_orphaned',
    async () => {
      const level = (await audience(radar)).get(recipientId);
      if (level === undefined || level === 'none') return;
      await fanOut({
        eventJobId,
        kind: 'charter_orphaned',
        actor,
        radar,
        blipId: blip.id,
        groupKey: `charter_orphaned:${radar.id}`,
        subject: radar.name,
        excerpt: condense(quote, NOTIFICATIONS.excerptChars),
        recipients: people([recipientId]),
      });
    },
    eventJobId,
  );
}

/**
 * A person was asked to decide something on a card (`decision`, to the addressee), or answered
 * (`decision_answered`, to whoever asked: an agent's own queue, else the person).
 *
 * Re-read at delivery, so a request answered, deleted or overtaken since is not announced. The
 * ask respects a muted radar like a mention does; the answer is told regardless, because it is the
 * reply to the asker's own question.
 */
async function notifyDecision(
  actor: Actor,
  radar: RadarRow,
  blip: BlipRow,
  requestId: string,
  answered: boolean,
  eventJobId: string,
): Promise<void> {
  await quietly(
    answered ? 'decision_answered' : 'decision',
    async () => {
      const [request] = await getDb()
        .select()
        .from(schema.decisionRequests)
        .where(
          and(
            eq(schema.decisionRequests.id, requestId),
            eq(schema.decisionRequests.blipId, blip.id),
            eq(schema.decisionRequests.radarId, radar.id),
          ),
        );
      if (!request) return;
      // Nothing is created for a recipient who can no longer read the request where it was asked.
      const recipientId = answered ? request.requesterUserId : request.addresseeUserId;
      if (
        !recipientId ||
        (await readDecisionRequestsFor(recipientId, eq(schema.decisionRequests.id, request.id)))
          .length === 0
      )
        return;
      if (answered) {
        if (request.status !== 'answered' || !request.requesterUserId) return;
        await fanOut({
          eventJobId,
          kind: 'decision_answered',
          actor,
          radar,
          blipId: blip.id,
          groupKey: `decision_answered:${request.id}`,
          subject: blipSubject(blip),
          excerpt: condense(request.answer, NOTIFICATIONS.excerptChars),
          recipients: [{ userId: request.requesterUserId, agentId: request.requesterAgentId }],
        });
        return;
      }
      if (request.status !== 'open' || !request.addresseeUserId) return;
      const level = (await audience(radar)).get(request.addresseeUserId);
      if (level === undefined || level === 'none') return;
      await fanOut({
        eventJobId,
        kind: 'decision',
        actor,
        ...(actor.agent ? { actorKey: `agent:${actor.agent.agentId}` } : {}),
        radar,
        blipId: blip.id,
        groupKey: `decision:${request.id}`,
        subject: blipSubject(blip),
        excerpt: condense(request.context, NOTIFICATIONS.excerptChars),
        recipients: people([request.addresseeUserId]),
      });
    },
    eventJobId,
  );
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

interface Cursor {
  createdAt: string;
  id: string;
}

/**
 * Timestamps travel as **Postgres text, never as a JS Date** — the same rule
 * `services/blips.ts` and `services/comments.ts` already carry, and this is the
 * third place in the family.
 *
 * `timestamptz` holds microseconds; a JS `Date` holds milliseconds and drops the
 * remaining three digits without complaint. A cursor built from
 * `Date.toISOString()` therefore names an instant *fractionally before* the row
 * it came from, and this stream compares with `<` — so it is the **skip**
 * direction, the quiet one: any row whose timestamp falls inside that
 * sub-millisecond gap is never served and leaves nothing behind to notice, while
 * still existing, still unread, and still counting toward the badge.
 *
 * It is reachable in production because `fanOut` issues one `db.execute` per
 * recipient — separate transactions, separate `now()` — so any burst puts two
 * rows inside one millisecond. Rendering the value with `::text` and handing it
 * straight back is lossless in both directions and leaves the ORDER BY
 * untouched, so the index still serves the stream.
 */
function encodeNotificationCursor(createdAt: string, id: string): string {
  return encodeCursor({ createdAt, id });
}

/**
 * The shared envelope (`services/cursor.ts`), then the two keys this keyset
 * casts in SQL. Both are checked for shape as well as type: a cursor is
 * unsigned, and `{"createdAt":"soon","id":"x"}` used to reach
 * `::timestamptz` / `::uuid` and come back a 500.
 */
function decodeNotificationCursor(raw: string): Cursor | null {
  const parsed = decodeCursor(raw);
  if (!parsed) return null;
  const { createdAt, id } = parsed;
  if (!isCursorTimestamp(createdAt) || !isCursorUuid(id)) return null;
  return { createdAt, id };
}

/**
 * The rendered sentence.
 *
 * Assembled server-side rather than in the client for the same reason
 * `canDelete` is: one phrasing, one place. It also means an agent reading this
 * over MCP gets the sentence a person would see instead of a bag of ids it has
 * to narrate for itself.
 */
function renderTitle(row: NotificationRow, actors: NotificationPrincipalDto[]): string {
  if (row.kind === 'subscription_failed')
    return `Outbound delivery paused: ${row.subject ?? 'subscription'}`;
  if (row.kind === 'email_received') return `New email in ${row.subject ?? 'your radar'}`;
  if (row.kind === 'due') return `${row.subject ?? 'A blip'} is due`;
  if (row.kind === 'charter_orphaned') {
    const pair = NOTIFICATION_PHRASES.charter_orphaned;
    return (row.count > 1 ? pair.many : pair.one)
      .replace('{n}', String(row.count))
      .replace('{subject}', quoted(row.subject));
  }
  if (row.kind === 'reply_pending') {
    const pair = NOTIFICATION_PHRASES.reply_pending;
    return (row.count > 1 ? pair.many : pair.one)
      .replace('{n}', String(row.count))
      .replace('{subject}', quoted(row.subject));
  }
  const names = actors.map((a) =>
    a.kind === 'agent' ? `${a.displayName} (agent)` : a.displayName,
  );
  const [first, second] = names;
  const who =
    first === undefined
      ? 'Someone'
      : second === undefined
        ? first
        : names.length === 2
          ? `${first} and ${second}`
          : `${first} and other participants`;

  // An unknown stored kind renders as a neutral line rather than throwing —
  // the same degradation rule as an unknown lane or reaction.
  if (!isNotificationKind(row.kind)) {
    return `${who} did something on ${row.subject ?? 'a radar'}`;
  }

  const pair = NOTIFICATION_PHRASES[row.kind];
  const unattributed = row.attributedEventCount < row.count;
  // Mixed legacy events cannot all be attributed to the known principals.
  // State the known action, then the total as events, never a people count.
  const phrase = !unattributed && row.count > 1 ? pair.many : pair.one;
  return `${who} ${phrase
    .replace('{n}', String(row.count))
    .replace(
      '{subject}',
      quoted(row.subject),
    )}${unattributed ? ` · ${row.count} event${row.count === 1 ? '' : 's'}, including unattributed earlier activity` : ''}`;
}

function quoted(subject: string | null): string {
  return subject ? `“${subject}”` : 'it';
}

/**
 * Rows to DTOs: the radars and the actors for a whole page in two round trips
 * rather than two per row.
 */
async function hydrate(
  rows: NotificationRow[],
  /** The reading connection's radar limit, when it has one (`fenceOf`). */
  fence: readonly string[] | null = null,
): Promise<NotificationDto[]> {
  if (rows.length === 0) return [];
  const db = getDb();

  const radarIds = [...new Set(rows.map((r) => r.radarId).filter((v): v is string => v !== null))];
  const topicIds = [...new Set(rows.map((r) => r.topicId).filter((v): v is string => v !== null))];
  const actorIds = [...new Set(rows.flatMap((r) => r.actorIds))];
  const principalHumanIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.actorKeys.filter((key) => key.startsWith('human:')).map((key) => key.slice(6)),
      ),
    ),
  ];
  const principalAgentIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.actorKeys.filter((key) => key.startsWith('agent:')).map((key) => key.slice(6)),
      ),
    ),
  ];
  const allHumanIds = [...new Set([...actorIds, ...principalHumanIds])];

  const [radarRows, topicRows, actorRows, agentRows] = await Promise.all([
    radarIds.length > 0
      ? db
          .select({
            id: schema.radars.id,
            name: schema.radars.name,
            accent: schema.radars.accent,
            glyph: schema.radars.glyph,
          })
          .from(schema.radars)
          .where(inArray(schema.radars.id, radarIds))
      : Promise.resolve([]),
    topicIds.length > 0
      ? db
          .select({
            id: schema.topics.id,
            slug: schema.topics.slug,
            name: schema.topics.name,
          })
          .from(schema.topics)
          .where(inArray(schema.topics.id, topicIds))
      : Promise.resolve([]),
    allHumanIds.length > 0
      ? db
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, allHumanIds))
      : Promise.resolve([]),
    principalAgentIds.length > 0
      ? db
          .select({ id: schema.agents.id, name: schema.agents.name })
          .from(schema.agents)
          .where(inArray(schema.agents.id, principalAgentIds))
      : Promise.resolve([]),
  ]);

  const radars = new Map(
    radarRows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        accent: r.accent as RadarAccent,
        glyph: r.glyph as RadarGlyph,
      } satisfies NotificationRadarDto,
    ]),
  );
  const topics = new Map(topicRows.map((t) => [t.id, t]));
  const actors = new Map(actorRows.map((a) => [a.id, a]));
  const agents = new Map(agentRows.map((a) => [a.id, a]));

  const decisions = await decisionsOf(rows, fence);

  return rows.map((row) => {
    // Order is preserved from the stored array (most recent first); an actor
    // whose account has since been deleted simply drops out of the sentence.
    const named = row.actorIds
      .map((id) => actors.get(id))
      .filter((a): a is { id: string; name: string | null; email: string } => a !== undefined);
    const principals: NotificationPrincipalDto[] = row.actorKeys.map((key) => {
      const id = key.slice(6);
      if (key.startsWith('agent:'))
        return { kind: 'agent', id, displayName: agents.get(id)?.name ?? 'Former agent' };
      const person = actors.get(id);
      return {
        kind: 'human',
        id,
        displayName: person
          ? (person.name ?? person.email.split('@')[0] ?? 'Someone')
          : 'Former participant',
      };
    });

    const decision = decisions.get(row.id);
    // A decision the recipient may not see (`readDecisionRequestsFor`) shows no words at all: not
    // the excerpt, not the card's title in the sentence, not a link.
    const hidden = isDecisionKind(row.kind) && !decision;
    return {
      id: row.id,
      kind: row.kind,
      title: hidden ? 'A decision on a card you can no longer see' : renderTitle(row, principals),
      excerpt: hidden ? null : row.excerpt,
      count: row.count,
      actors: named,
      principals,
      hasUnattributedEvents: row.attributedEventCount < row.count,
      radar: row.radarId && !hidden ? (radars.get(row.radarId) ?? null) : null,
      topic: row.topicId ? (topics.get(row.topicId) ?? null) : null,
      blipId: hidden ? null : row.blipId,
      read: row.readAt !== null,
      seen: row.seenAt !== null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(decision ? { decision } : {}),
    };
  });
}

/**
 * The words of the requests that decision notifications are about, only where the recipient may see
 * them (`readDecisionRequestsFor`: the rule). A notification with no entry here shows no text.
 */
async function decisionsOf(
  rows: NotificationRow[],
  fence: readonly string[] | null,
): Promise<Map<string, NonNullable<NotificationDto['decision']>>> {
  const wanted = new Map<string, { userId: string; requestId: string }>();
  for (const row of rows) {
    const id = /(?:^|:)decision(?:_answered)?:([0-9a-f-]{36})$/.exec(row.groupKey)?.[1];
    if (id && isDecisionKind(row.kind)) wanted.set(row.id, { userId: row.userId, requestId: id });
  }
  const out = new Map<string, NonNullable<NotificationDto['decision']>>();
  for (const userId of new Set([...wanted.values()].map((w) => w.userId))) {
    const mine = [...wanted].filter(([, w]) => w.userId === userId);
    const found = await readDecisionRequestsFor(
      userId,
      inArray(schema.decisionRequests.id, [...new Set(mine.map(([, w]) => w.requestId))]),
      fence,
    );
    const byId = new Map(found.map((r) => [r.id, r]));
    for (const [notificationId, w] of mine) {
      const r = byId.get(w.requestId);
      if (r)
        out.set(notificationId, {
          requestId: r.id,
          context: r.context,
          question: r.question,
          answer: r.answer,
        });
    }
  }
  return out;
}

const isDecisionKind = (kind: string) => kind === 'decision' || kind === 'decision_answered';

/**
 * The stream, newest first.
 *
 * Keyset-paginated on `(created_at, id)` with a row-value comparison matching
 * the ORDER BY exactly — the same total-cursor rule as the blip stream. Note
 * that this sorts on `created_at` and not `updated_at`: a folding event moves
 * `updated_at`, and a mutable sort key makes the keyset non-total, which would
 * let a notification duplicate or vanish mid-scroll. The cost is that a folded
 * event grows a row's count in place rather than jumping it to the top; the
 * count and the un-seen flag are what draw the eye instead.
 */
/**
 * Whose queue this caller is reading.
 *
 * Keyed on `actor.agent` and deliberately **not** on `actor.kind`. A plain
 * personal access token with no persona attached is `kind: 'agent'` and has
 * always read its human's own queue; keying on the kind would move every one of
 * those to an empty queue overnight, which is a behaviour change wearing the
 * costume of a feature.
 *
 * So: a persona-bearing connection sees its own queue and only its own, and
 * everything else — a browser session, a webhook, an unnamed token — sees the
 * human's. A human never finds their agent's unread items mixed into theirs,
 * which is what stops the badge counting somebody else's mail.
 *
 * An MCP caller that names a load `session` arrives here already run through `writeAsAgent`, so
 * `actor.agent` is the loaded agent and this is that agent's queue (pinned in agent-repo.test.ts).
 */
function queueOf(actor: Actor): SQL {
  return actor.agent
    ? eq(schema.notifications.agentId, actor.agent.agentId)
    : isNull(schema.notifications.agentId);
}

/**
 * A snapshot is content, so cleanup cannot be its authorization boundary.
 * A fan-out can finish after a revocation sweep, and retries can outlive a
 * suspension. Check current grants in the same statement that reads the row.
 */
function notificationAccess(userId: string | SQL, fence: readonly string[] | null = null): SQL {
  return (
    and(
      sql`EXISTS (SELECT 1 FROM ${schema.users} WHERE ${schema.users.id} = ${userId} AND ${schema.users.state} = 'active' AND omr_account_open(${schema.users.id}))`,
      or(
        isNull(schema.notifications.radarId),
        inArray(schema.notifications.radarId, readableRadarQuery(userId)),
      ),
      or(
        isNull(schema.notifications.topicId),
        inArray(schema.notifications.topicId, readableTopicQuery(userId)),
      ),
      // A decision shows only while its request is open and live (not answered, moved, overtaken,
      // or on a radar that turned comments off): hidden at read time, the row is kept.
      or(
        ne(schema.notifications.kind, 'decision'),
        sql`EXISTS (SELECT 1 FROM decision_requests dr JOIN blips b ON b.id = dr.blip_id JOIN radars r ON r.id = b.radar_id WHERE dr.blip_id = ${schema.notifications.blipId} AND ${schema.notifications.groupKey} = 'decision:' || dr.id::text AND ${DECISION_LIVE})`,
      ),
      // An agent limited to selected radars: only those radars' notifications, and none of a
      // topic's (it reaches no topics). `fence` is `fenceCaps`' answer for this caller.
      fence
        ? and(
            isNull(schema.notifications.topicId),
            or(
              isNull(schema.notifications.radarId),
              fence.length ? inArray(schema.notifications.radarId, [...fence]) : sql`false`,
            ),
          )
        : undefined,
      // `and` is only undefined with no arguments; fail closed if that changes.
    ) ?? sql`false`
  );
}

/**
 * What waits on the person: an open decision request, or a mention by a person (a `human:`
 * principal, or a legacy row that recorded none, which may well be one). Everything else is an
 * agent or the system reporting.
 */
function needsYou(): SQL {
  const n = schema.notifications;
  return or(
    eq(n.kind, 'decision'),
    and(
      eq(n.kind, 'mention'),
      or(
        sql`cardinality(${n.actorKeys}) = 0`,
        sql`EXISTS (SELECT 1 FROM unnest(${n.actorKeys}) AS k WHERE k LIKE 'human:%')`,
      ),
    ),
  ) as SQL;
}

const inBox = (box: NotificationBox): SQL => (box === 'needs_you' ? needsYou() : not(needsYou()));

/** The radars an agent-limited caller is held to, or null when they are not. */
async function fenceOf(actor: Actor): Promise<string[] | null> {
  const caps = await fenceCaps(actor);
  return caps ? [...caps.keys()] : null;
}

/**
 * Prompt changes waiting on the caller as OWNER. Computed, never stored: accept or reject empties
 * it with no row to clean up. Only a human queue has it; an agent session never sees its own.
 */
async function pendingProposals(actor: Actor): Promise<PendingProposalDto[]> {
  const p = schema.repoAgentPromptProposals;
  const editor = alias(schema.agents, 'editor');
  const rows = await getDb()
    .select({
      id: p.id,
      agentId: schema.agents.id,
      agentName: schema.agents.name,
      editorName: editor.name,
      note: p.note,
      createdAt: p.createdAt,
    })
    .from(p)
    .innerJoin(schema.agents, eq(schema.agents.id, p.agentId))
    .leftJoin(editor, and(eq(editor.id, p.editorAgentId), ne(editor.id, p.agentId)))
    .where(
      and(
        eq(schema.agents.ownerId, actor.user.id),
        isNull(schema.agents.archivedAt),
        eq(p.status, 'pending'),
      ),
    )
    .orderBy(asc(p.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function listNotifications(
  actor: Actor,
  query: ListNotificationsQuery = {},
): Promise<NotificationPageDto> {
  const limit = Math.min(query.limit ?? NOTIFICATIONS.pageSize, NOTIFICATIONS.maxPageSize);

  const fence = await fenceOf(actor);
  const clauses: SQL[] = [
    eq(schema.notifications.userId, actor.user.id),
    queueOf(actor),
    notificationAccess(actor.user.id, fence),
  ];
  if (query.unreadOnly) clauses.push(isNull(schema.notifications.readAt));
  if (query.radarId) clauses.push(eq(schema.notifications.radarId, query.radarId));
  if (query.kind) clauses.push(eq(schema.notifications.kind, query.kind));
  if (query.box) clauses.push(inBox(query.box));

  const cursor = query.cursor ? decodeNotificationCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw badRequest('Invalid cursor');
  if (cursor) {
    clauses.push(
      sql`(${schema.notifications.createdAt}, ${schema.notifications.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await getDb()
    .select({
      ...getTableColumns(schema.notifications),
      // See `encodeNotificationCursor`: the cursor is built from this, never from the Date.
      createdAtText: sql<string>`${schema.notifications.createdAt}::text`,
    })
    .from(schema.notifications)
    .where(and(...clauses))
    .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await hydrate(page, fence),
    nextCursor:
      rows.length > limit && last ? encodeNotificationCursor(last.createdAtText, last.id) : null,
    ...(!actor.agent && !query.cursor && query.box !== 'agents_reported'
      ? { pendingProposals: await pendingProposals(actor) }
      : {}),
  };
}

/**
 * Unread totals in one round trip: the sidebar badge, the per-radar badges and
 * the ping, which would otherwise be three queries fired on every render.
 */
export async function notificationCounts(
  actor: Actor,
  box?: NotificationBox,
): Promise<NotificationCountsDto> {
  const fence = await fenceOf(actor);
  const rows = await getDb()
    .select({
      radarId: schema.notifications.radarId,
      total: sql<number>`count(*)::int`,
      unseen: sql<number>`count(*) FILTER (WHERE ${schema.notifications.seenAt} IS NULL)::int`,
    })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, actor.user.id),
        queueOf(actor),
        notificationAccess(actor.user.id, fence),
        isNull(schema.notifications.readAt),
        box ? inBox(box) : undefined,
      ),
    )
    .groupBy(schema.notifications.radarId);

  const byRadar: Record<string, number> = {};
  let total = 0;
  let unseen = 0;
  for (const row of rows) {
    total += row.total;
    unseen += row.unseen;
    if (row.radarId) byRadar[row.radarId] = row.total;
  }
  // Proposals count toward the bell (not `unseen`: they have no seen state, so they would ping forever).
  const proposals =
    !actor.agent && box !== 'agents_reported' ? (await pendingProposals(actor)).length : 0;
  return { total: total + proposals, unseen, byRadar, ...(proposals ? { proposals } : {}) };
}

/* -------------------------------------------------------------------------- */
/* Writing state                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Mark read — or, with `read: false`, put one back.
 *
 * Every branch is scoped by `user_id` first. A notification id is not a secret,
 * but it is also not a capability: reading somebody else's is not a thing this
 * function can be asked to do, because the WHERE clause cannot express it.
 */
export async function markRead(
  actor: Actor,
  input: MarkNotificationsReadInput,
): Promise<{ updated: number }> {
  // Your own notification state, so there is no radar for the clamp to narrow.
  // Still a write: a connection granted `radars:read` silently clearing
  // somebody's badge is exactly the surprise read-only is supposed to prevent.
  requireScopeWithinGrants(actor, 'write', 'mark notifications read');
  const read = input.read ?? true;
  // Scoped to the caller's own queue as well as their own account, so a persona
  // cannot clear its human's badge and a human cannot clear their agent's.
  const clauses: SQL[] = [
    eq(schema.notifications.userId, actor.user.id),
    queueOf(actor),
    notificationAccess(actor.user.id, await fenceOf(actor)),
  ];

  if (input.ids) clauses.push(inArray(schema.notifications.id, input.ids));
  if (input.radarId) clauses.push(eq(schema.notifications.radarId, input.radarId));
  // Only touch rows that need it, so `updated` is a truthful number and the
  // index stays free of pointless churn.
  clauses.push(read ? isNull(schema.notifications.readAt) : sql`read_at IS NOT NULL`);

  const rows = await getDb()
    .update(schema.notifications)
    .set(
      read
        ? { readAt: new Date(), seenAt: new Date(), updatedAt: new Date() }
        : { readAt: null, updatedAt: new Date() },
    )
    .where(and(...clauses))
    .returning({ id: schema.notifications.id });

  return { updated: rows.length };
}

/**
 * The list has been displayed.
 *
 * Seen is not read. Opening the panel stops the ping — you have looked — without
 * claiming you have dealt with anything, which is why the badge keeps its count
 * until you actually do.
 */
export async function markSeen(actor: Actor): Promise<{ updated: number }> {
  requireScopeWithinGrants(actor, 'write', 'mark notifications seen');
  const fence = await fenceOf(actor);
  const rows = await getDb()
    .update(schema.notifications)
    .set({ seenAt: new Date() })
    .where(
      and(
        eq(schema.notifications.userId, actor.user.id),
        queueOf(actor),
        notificationAccess(actor.user.id, fence),
        isNull(schema.notifications.seenAt),
      ),
    )
    .returning({ id: schema.notifications.id });
  return { updated: rows.length };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export async function getSettings(actor: Actor) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.userNotificationSettings)
    .where(eq(schema.userNotificationSettings.userId, actor.user.id))
    .limit(1);

  // Every radar the caller can read, with whatever they chose for it. Radars
  // with no row show the default rather than being absent, so the screen is a
  // complete picture instead of a list of exceptions.
  //
  // Readability is an access question, so — exactly as in `audience` above —
  // it is answered by `readableRadarIds` rather than by a second, narrower
  // join written here. This *was* that second join: owner plus direct
  // `radar_members`, the same un-widened shape `audience` was fixed out of. The
  // two halves then disagreed in the worst possible direction. Fan-out is
  // cascade-aware, so somebody reaching a radar through a cascading topic
  // *receives* its notifications; enumeration was cascade-blind, so that radar
  // never appeared on this screen and **no level control was ever rendered for
  // it**. Added to a cascading topic of twenty radars, you were notified by all
  // twenty and could mute none. The write path was always fine — `setRadarLevel`
  // goes through `requireRadar` — so this was purely a missing control.
  const readableIds = await readableRadarIdsFor(actor);
  const radars = readableIds.length
    ? await db
        .select({
          id: schema.radars.id,
          name: schema.radars.name,
          accent: schema.radars.accent,
          glyph: schema.radars.glyph,
          level: schema.radarNotificationPrefs.level,
        })
        .from(schema.radars)
        .leftJoin(
          schema.radarNotificationPrefs,
          and(
            eq(schema.radarNotificationPrefs.radarId, schema.radars.id),
            eq(schema.radarNotificationPrefs.userId, actor.user.id),
          ),
        )
        .where(and(eq(schema.radars.archived, false), inArray(schema.radars.id, readableIds)))
        .orderBy(schema.radars.name)
    : [];

  return {
    previewEnabled: row?.previewEnabled ?? true,
    kindPreferences: notificationPreferences(row?.kindPreferences),
    emailEnabled: row?.emailEnabled ?? true,
    pushEnabled: row?.pushEnabled ?? true,
    radars: radars.map((r) => ({
      id: r.id,
      name: r.name,
      accent: r.accent as RadarAccent,
      glyph: r.glyph as RadarGlyph,
      level: isRadarNotifyLevel(r.level) ? r.level : DEFAULT_RADAR_NOTIFY_LEVEL,
    })),
  };
}

export async function updateSettings(
  actor: Actor,
  input: UpdateNotificationSettingsInput,
): Promise<void> {
  // Same promise, same hole: an agent quietly turning somebody's email off is
  // exactly what the consent screen exists to prevent — an agent must not be
  // able to make itself the only thing that knows something happened.
  assertHumanDecision(
    actor,
    'Notification settings are a person’s control over being interrupted, and changing ' +
      'them is not something an agent may do. Ask the user to change them in ' +
      'Settings → Notifications.',
  );
  // Upsert rather than update: absence is the default, so the first change is
  // also the first row.
  await getDb()
    .insert(schema.userNotificationSettings)
    .values({
      userId: actor.user.id,
      emailEnabled: input.emailEnabled ?? true,
      pushEnabled: input.pushEnabled ?? true,
      previewEnabled: input.previewEnabled ?? true,
      kindPreferences: input.kindPreferences ?? {},
    })
    .onConflictDoUpdate({
      target: schema.userNotificationSettings.userId,
      set: {
        ...(input.emailEnabled === undefined ? {} : { emailEnabled: input.emailEnabled }),
        ...(input.pushEnabled === undefined ? {} : { pushEnabled: input.pushEnabled }),
        ...(input.previewEnabled === undefined ? {} : { previewEnabled: input.previewEnabled }),
        ...(input.kindPreferences === undefined
          ? {}
          : {
              kindPreferences: sql`COALESCE((SELECT jsonb_object_agg(key, COALESCE(${schema.userNotificationSettings.kindPreferences}->key,'{}'::jsonb) || value) FROM jsonb_each(${JSON.stringify(input.kindPreferences)}::jsonb)), '{}'::jsonb) || (${schema.userNotificationSettings.kindPreferences} - ARRAY(SELECT jsonb_object_keys(${JSON.stringify(input.kindPreferences)}::jsonb)))`,
            }),
        updatedAt: new Date(),
      },
    });
}

/**
 * How loud one radar is, for this person.
 *
 * The caller must be able to read the radar — checked by the route through
 * `requireRadar`, like everything else — but nothing here needs `manage`: this
 * is a statement about your own attention, not about the radar.
 */
export async function setRadarLevel(
  actor: Actor,
  radarId: string,
  level: RadarNotifyLevel,
): Promise<void> {
  // A person's control over being interrupted, and `docs/MCP.md` promises
  // outright that an agent cannot touch it. That promise was kept by there
  // being no MCP tool, which left `PUT /api/radars/:id/notifications` open.
  assertHumanDecision(
    actor,
    'How loud a radar is is a setting about being interrupted, and changing it is not ' +
      'something an agent may do. Ask the user to change it on the radar’s own screen.',
  );
  await getDb()
    .insert(schema.radarNotificationPrefs)
    .values({ userId: actor.user.id, radarId, level })
    .onConflictDoUpdate({
      target: [schema.radarNotificationPrefs.userId, schema.radarNotificationPrefs.radarId],
      set: { level, updatedAt: new Date() },
    });
}

/**
 * Somebody's access to a radar has been taken away.
 *
 * Their outstanding notifications for it go with it. Re-deriving recipients on
 * every event (see `audience`) already stops *new* ones, but a notification
 * carries a snapshot excerpt of the content — so leaving the ones already
 * written would mean a removed member keeps a readable copy of remarks from a
 * radar they can no longer open. That is the same reasoning as suspension
 * revoking every session immediately rather than waiting for a cookie to
 * expire: the moment access ends, it ends.
 *
 * Read ones go too. They are just as legible as the unread ones, and there is
 * nothing left to act on.
 */
export async function dropRadarNotifications(userId: string, radarId: string): Promise<number> {
  /*
    **Their agents' rows go too, and the predicate says so here rather than at
    each call site.**

    An agent's queue row carries `user_id = <the owner>`, so this function's
    original predicate already caught them — which is worth stating, because it
    means the disclosure hole the design worried about does not exist on this
    side. It is stated explicitly anyway: the equality is what makes it true, and
    the next person to reach for `agent_id IS NULL` here to "only sweep the
    person's own" would open it. `services/mentions.ts` carries the same note for
    the half where the leg genuinely had to be added.
  */
  const rows = await getDb()
    .delete(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.radarId, radarId)))
    .returning({ id: schema.notifications.id });
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything this person was told about one topic, gone.
 *
 * The counterpart to `dropRadarNotifications`, and the same disclosure rule: a
 * notification carries a snapshot of what happened, so leaving one behind after
 * a grant is revoked hands somebody a readable record of something they can no
 * longer open. Re-deriving recipients stops new ones; this deals with the ones
 * already written.
 */
export async function dropTopicNotifications(userId: string, topicId: string): Promise<number> {
  const deleted = await getDb()
    .delete(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.topicId, topicId)))
    .returning({ id: schema.notifications.id });
  return deleted.length;
}

/** Bounded worker sweep. Unread notifications never expire. */
export async function purgeOldNotifications(batchSize = 500): Promise<number> {
  const cutoff = new Date(Date.now() - NOTIFICATIONS.retentionDays * 24 * 60 * 60 * 1000);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000)
    throw new Error('Invalid notification retention batch size');
  const rows = await getDb().execute(sql`
    WITH picked AS (
      SELECT id FROM notifications WHERE read_at < ${cutoff}
      ORDER BY read_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM notifications AS target USING picked WHERE target.id = picked.id
  `);
  return rows.rowCount ?? 0;
}

/** Durable intent, inserted by the transaction that creates its source event. */
export type NotificationEvent = { actor: Actor } & (
  | { type: 'blip'; radarId: string; blipId: string }
  | {
      type: 'due';
      radarId: string;
      blipId: string;
      recipientId: string;
      revision: number;
      reminderAt: string;
    }
  | { type: 'reaction'; radarId: string; blipId: string }
  | {
      type: 'comment';
      radarId: string;
      blipId: string;
      commentId: string;
      body: string;
      mentioned: string[];
    }
  | {
      type: 'mention';
      radarId: string;
      blipId: string;
      commentId: string | null;
      body: string;
      mentioned: MentionTarget[];
    }
  | { type: 'share'; radarId: string; recipientId: string }
  | { type: 'reply-pending'; radarId: string; blipId: string; commentId: string }
  // A save took the words an ADR amends; the ADR's author (`recipientId`) is told.
  // `blipIds` is every ADR of the author's that lost its words in the save (`blipId` is the first);
  // an event queued before it existed has only `blipId`.
  | {
      type: 'charter-orphaned';
      radarId: string;
      blipId: string;
      blipIds?: string[];
      recipientId: string;
    }
  | { type: 'topic-share'; topicId: string; recipientId: string; radarCount: number }
  | { type: 'topic-cascade'; topicId: string; recipientIds: string[]; radarCount: number }
);

/** The actor, as a queued event carries it: ids only, reloaded when the job runs. */
const queuedActor = (actor: Actor) => ({
  user: { id: actor.user.id },
  kind: actor.kind,
  ...(actor.agent ? { agent: { agentId: actor.agent.agentId } } : {}),
});

export function enqueueNotificationEvent(
  dbc: Pick<Db, 'insert'>,
  event: NotificationEvent,
): Promise<string> {
  const { actor, ...source } = event;
  // Bodies are reloaded on delivery; retain no obsolete excerpt in the queue.
  const payload: Record<string, unknown> = { ...source };
  delete payload['body'];
  return enqueue(dbc, 'notification-event', { ...payload, actor: queuedActor(actor) });
}

/**
 * A decision request was asked (`decision`, to the addressee) or answered (`decision-answered`, to
 * whoever asked). Its own outbox kind, because a pod from before this existed claims every
 * `notification-event` job and would fail on a payload it has no branch for.
 */
export function enqueueDecisionEvent(
  dbc: Pick<Db, 'insert'>,
  event: {
    actor: Actor;
    type: 'decision' | 'decision-answered';
    radarId: string;
    blipId: string;
    requestId: string;
  },
): Promise<string> {
  const { actor, ...source } = event;
  return enqueue(dbc, 'decision-event', { ...source, actor: queuedActor(actor) });
}

type QueuedActor = ReturnType<typeof queuedActor>;

/**
 * Attribution is a snapshot of the actor, never a credential reused by a worker: identities are
 * reloaded, so retired personas and suspended users stay quiet. Null means say nothing.
 */
async function reloadActor(queued: QueuedActor): Promise<Actor | null> {
  const db = getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, queued.user.id));
  if (!user || user.state !== 'active') return null;
  const actor: Actor = { user, kind: queued.kind };
  if (queued.agent) {
    const [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, queued.agent.agentId));
    // Archived agents stay quiet. Ownership is not checked: a shared agent's
    // writes are cosigned by whoever ran it, who need not be its owner.
    if (!agent || agent.archivedAt) return null;
    actor.agent = {
      agentId: agent.id,
      ownerId: agent.ownerId,
      name: agent.name,
      handle: agent.slug,
    };
  }
  return actor;
}

registerOutboxHandler('decision-event', async (payload, job) => {
  if (payload['notificationEventDone'] === true) return;
  const event = payload as unknown as {
    actor: QueuedActor;
    type: 'decision' | 'decision-answered';
    radarId: string;
    blipId: string;
    requestId: string;
  };
  const actor = await reloadActor(event.actor);
  if (!actor) return;
  const db = getDb();
  const [radar] = await db.select().from(schema.radars).where(eq(schema.radars.id, event.radarId));
  const [blip] = await db.select().from(schema.blips).where(eq(schema.blips.id, event.blipId));
  // A card deleted or moved since is not announced under a stale radar's audience.
  if (!radar || radar.archived || !blip || blip.radarId !== radar.id) return;
  await notifyDecision(
    actor,
    radar,
    blip,
    event.requestId,
    event.type === 'decision-answered',
    job.id,
  );
});

registerOutboxHandler('notification-event', async (payload, job) => {
  if (payload['notificationEventDone'] === true) return;
  const event = payload as unknown as NotificationEvent;
  const db = getDb();
  const actor = await reloadActor(event.actor);
  if (!actor) return;

  if (event.type === 'topic-share' || event.type === 'topic-cascade') {
    const [topic] = await db
      .select()
      .from(schema.topics)
      .where(eq(schema.topics.id, event.topicId));
    if (!topic) return;
    // Still able to read the topic: a share to somebody the topic's organization does not
    // honour is not announced, since the announcement names the topic.
    const live = await topicReaders(
      topic.id,
      event.type === 'topic-share' ? [event.recipientId] : event.recipientIds,
      db,
    );
    if (event.type === 'topic-share') {
      if (live.has(event.recipientId))
        await notifyTopicShare(actor, topic, event.recipientId, event.radarCount, job.id);
    } else if (topic.cascade) {
      await notifyTopicCascade(
        actor,
        topic,
        event.recipientIds.filter((id) => live.has(id)),
        event.radarCount,
        job.id,
      );
    }
    return;
  }

  const [radar] = await db.select().from(schema.radars).where(eq(schema.radars.id, event.radarId));
  if (!radar || radar.archived) return;
  if (event.type === 'share') {
    if ((await radarReaders(radar)).some((reader) => reader.id === event.recipientId)) {
      await notifyShare(actor, radar, event.recipientId, job.id);
    }
    return;
  }
  if (event.type === 'charter-orphaned') {
    // Told if any of the author's ADRs is still orphaned when the job runs: one healed, dismissed
    // or deleted since the save does not hide the others. The first still-orphaned one is the
    // notification's blip.
    const ids = event.blipIds?.length ? event.blipIds : [event.blipId];
    const [orphan] = await db
      .select({ adr: schema.charterAnchors.subjectId, quote: schema.charterAnchors.quote })
      .from(schema.charterAnchors)
      .innerJoin(schema.blips, eq(schema.blips.id, schema.charterAnchors.subjectId))
      .where(
        and(
          inArray(schema.charterAnchors.subjectId, ids),
          eq(schema.charterAnchors.state, 'orphaned'),
          eq(schema.blips.radarId, radar.id),
        ),
      )
      .orderBy(schema.charterAnchors.createdAt, schema.charterAnchors.id)
      .limit(1);
    if (!orphan) return;
    const [adr] = await db.select().from(schema.blips).where(eq(schema.blips.id, orphan.adr));
    if (adr)
      await notifyCharterOrphaned(actor, radar, adr, event.recipientId, orphan.quote, job.id);
    return;
  }
  const [blip] = await db.select().from(schema.blips).where(eq(schema.blips.id, event.blipId));
  // Deletion or a move can overtake the job. Never publish an excerpt
  // under a stale radar's audience or an identifier whose source is now gone.
  if (!blip || blip.radarId !== radar.id) return;
  if (event.type === 'due') {
    const [reminder] = await db
      .select()
      .from(schema.blipReminders)
      .where(
        and(
          eq(schema.blipReminders.blipId, blip.id),
          eq(schema.blipReminders.userId, event.recipientId),
        ),
      );
    if (
      !reminder ||
      !reminder.enabled ||
      !reminder.queuedAt ||
      !reminder.reminderAt ||
      reminder.reminderAt.toISOString() !== event.reminderAt ||
      reminder.revision !== event.revision ||
      blip.dueRevision !== event.revision ||
      ['done', 'dropped'].includes(blip.state) ||
      Date.now() - Date.parse(event.reminderAt) > 3_600_000
    )
      return;
    const levels = await audience(radar);
    if (!levels.has(event.recipientId) || levels.get(event.recipientId) === 'none') return;
    await fanOut({
      eventJobId: job.id,
      kind: 'due',
      actor,
      radar,
      blipId: blip.id,
      groupKey: `due:${blip.id}:${event.recipientId}:${event.revision}`,
      subject: blipSubject(blip),
      excerpt: null,
      recipients: people([event.recipientId]),
    });
    return;
  }
  if (event.type === 'blip') await notifyBlip(actor, radar, blip, job.id);
  else if (event.type === 'reaction') await notifyReaction(actor, radar, blip, job.id);
  else if (event.type === 'reply-pending') {
    // Still pending when the job runs: a reply released or deleted in the
    // meantime is nothing to review, and its words are not repeated anywhere.
    const [comment] = await db
      .select()
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, event.commentId));
    if (
      !comment ||
      comment.blipId !== blip.id ||
      comment.radarId !== radar.id ||
      comment.visibility !== 'client_pending'
    )
      return;
    await notifyReplyPending(actor, radar, blip, comment.body, job.id);
  } else {
    let body = blip.body;
    let storedComment: typeof schema.blipComments.$inferSelect | undefined;
    if (event.commentId) {
      const [comment] = await db
        .select()
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, event.commentId));
      if (!comment || comment.blipId !== blip.id || comment.radarId !== radar.id) return;
      storedComment = comment;
      body = comment.body;
    }
    if (event.type === 'comment') {
      if (!storedComment) return;
      await notifyComment(actor, radar, blip, storedComment, event.mentioned, job.id);
    } else {
      const current = await db
        .select()
        .from(schema.mentions)
        .where(
          event.commentId
            ? eq(schema.mentions.commentId, event.commentId)
            : eq(schema.mentions.blipId, blip.id),
        );
      const mentioned = event.mentioned.filter((target) =>
        current.some((row) =>
          target.agentId ? row.agentId === target.agentId : row.userId === target.ownerId,
        ),
      );
      await notifyMention(
        actor,
        radar,
        blip,
        event.commentId,
        body,
        mentioned,
        job.id,
        storedComment ?? blip,
      );
    }
  }
});

/** A fresh authorized payload for one queued attempt; never reuse a queued excerpt. */
export async function pushNotificationContext(id: string) {
  const [row] = await getDb()
    .select()
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.id, id), notificationAccess(sql`${schema.notifications.userId}`)),
    );
  if (!row || row.agentId || row.readAt) return null;
  if (row.blipId) {
    const [blip] = await getDb().select().from(schema.blips).where(eq(schema.blips.id, row.blipId));
    if (!blip || blip.radarId !== row.radarId) return null;
    if (row.kind === 'due') {
      const [reminder] = await getDb()
        .select()
        .from(schema.blipReminders)
        .where(
          and(
            eq(schema.blipReminders.blipId, blip.id),
            eq(schema.blipReminders.userId, row.userId),
          ),
        );
      if (
        !reminder ||
        !reminder.enabled ||
        reminder.revision !== blip.dueRevision ||
        row.groupKey !== `due:${blip.id}:${row.userId}:${reminder.revision}` ||
        ['done', 'dropped'].includes(blip.state)
      )
        return null;
    }
  } else if (
    ['due', 'email_received', 'comment', 'mention', 'reaction', 'reply_pending'].includes(row.kind)
  )
    return null;
  if (row.radarId) {
    const [radar] = await getDb()
      .select({ archived: schema.radars.archived })
      .from(schema.radars)
      .where(eq(schema.radars.id, row.radarId));
    if (!radar || radar.archived) return null;
  }
  const policy = await notificationAllowed(row.userId, row.kind, row.radarId, 'push');
  if (!policy.allowed) return null;
  const [dto] = await hydrate([row]);
  if (!dto) return null;
  return {
    row,
    payload: {
      title: policy.preview ? dto.title : 'On My Radar',
      body: policy.preview ? (dto.excerpt ?? '') : 'You have new activity.',
      tag: row.id,
      url: notificationHref(dto, true),
      notificationId: row.id,
      recipientUserId: row.userId,
      kind: row.kind,
      radarId: row.radarId,
      blipId: row.blipId,
      topicId: row.topicId,
    },
  };
}

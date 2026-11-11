/**
 * Events to the client portal (`docs/HELPDESK.md` §5.4, T6, T11).
 *
 * ## Ids only
 *
 * An event says *which* request, radar or reply changed and one of five words
 * for what happened. It never carries a requester, an account, a status, a
 * title or an external ref: the portal fetches through the projection
 * (`services/helpdesk.ts`), where its account scope is enforced, so the
 * projection exists in exactly one place and a forged, misrouted or leaked
 * event discloses nothing.
 *
 * ## The log is durable; push is a hint
 *
 * Triggers append every event in the same transaction as the change it reports
 * (`drizzle/0047`), so an event cannot survive a rollback and a change cannot
 * commit without its event. The portal reads the log two ways:
 *
 * - **Pull**, `GET /api/v1/helpdesk/events?after=`: ascending by `(xid, seq)`,
 *   and only below the snapshot watermark, `pg_snapshot_xmin`. `seq` alone is
 *   allocated at INSERT rather than COMMIT, so a reader could see seq 11
 *   committed while seq 10's transaction is still open, advance past 10 and
 *   never return it. Every row below the watermark belongs to a finished
 *   transaction, and every transaction still open or not yet begun has an xid at
 *   or above it, so a cursor at `(xid, seq)` never passes a row that can still
 *   appear. The cost is that a long transaction anywhere *delays* events; it
 *   never loses one. `watermarkLagSeconds` makes a stuck watermark visible.
 * - **Push**, one signed POST per event to the integration's receiver, from
 *   `integration_deliveries`. Exhausting the retries **pauses and buffers**:
 *   the rows stay, new events keep queueing, the owner is told, and resuming
 *   sends everything oldest first. Generic subscriptions discard on pause; the
 *   portal cannot afford to (§5.4).
 *
 * Push and pull overlap by design, so the portal dedupes on the durable event
 * `id` under a unique constraint in its own database (§5.4, "What the portal
 * must do"). The watermark makes pull complete; the id makes it idempotent.
 *
 * ## Re-checked on the way out
 *
 * Each event is projected for the integration at the moment it is read or
 * delivered: a request event whose request has since left that integration's
 * reach is shown as `request.removed`, with no reply id. The exits are reported
 * by their own `request.removed` events too, so this is a second fence, read
 * through `requireHelpdeskRadar` like every other portal read rather than a
 * second copy of the rule.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  HELPDESK_EVENT_LIMITS,
  isHelpdeskEventKind,
  type HelpdeskEventDto,
  type HelpdeskEventKind,
  type HelpdeskEventsQuery,
  type IntegrationDeliveriesDto,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, conflict, notFound, type Actor } from '../http.js';
import { logger } from '../logger.js';
import { assertHumanDecision, requireHelpdeskRadar, requireScope } from './access.js';
import { recordAudit } from './audit.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  publicRequest,
  UnsafeOutboundUrlError,
  unsafeUrlMessage,
  vetPublicUrl,
} from './public-request.js';
import {
  decryptSubscriptionSecret,
  encryptSubscriptionSecret,
  signSubscription,
} from './subscription-signing.js';

type IntegrationActor = Actor & { integrationId: string };
type IntegrationRow = typeof schema.integrations.$inferSelect;

/** Six tries spanning 5h36m, as a subscription's. Then delivery pauses and buffers. */
export const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_SECONDS = [60, 300, 1800, 7200, 10800];

const NOT_FOUND = 'Integration not found';
const RECEIVER_REFUSAL =
  'Where the portal receives events, and the secret that signs them, are set by the ' +
  'account owner in a signed-in browser: open Settings → Connections.';
const RESUME_REFUSAL =
  'Resuming or testing delivery to a client portal is done by the account owner in a ' +
  'signed-in browser: open Settings → Connections. An agent may pause it.';

/* --------------------------------- cursor ---------------------------------- */

interface EventCursor {
  xid: string;
  seq: string;
}

/**
 * The two keys' own ranges, checked before either reaches SQL: an xid8 is an
 * unsigned 64-bit integer (at most 20 digits), a seq a signed bigint (at most
 * 19 digits and 2^63 - 1). Anything else is a malformed cursor, a 400 — never
 * a cast Postgres refuses, which was a 500 (qa-reviewer, slice 4).
 */
const XID_MAX = 2n ** 64n - 1n;
const SEQ_MAX = 2n ** 63n - 1n;

function inRange(value: unknown, digits: number, max: bigint): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^\\d{1,${digits}}$`).test(value) &&
    BigInt(value) <= max
  );
}

function eventCursor(xid: string, seq: string): string {
  return encodeCursor({ x: xid, s: seq });
}

function readEventCursor(raw: string): EventCursor {
  const cursor = decodeCursor(raw);
  const xid = cursor?.['x'];
  const seq = cursor?.['s'];
  if (!inRange(xid, 20, XID_MAX) || !inRange(seq, 19, SEQ_MAX)) throw badRequest('Invalid cursor');
  return { xid, seq };
}

/* -------------------------------- projection ------------------------------- */

type EventRow = {
  seq: string;
  xid: string;
  id: string;
  integration_id: string;
  event: string;
  request_id: string | null;
  radar_id: string | null;
  reply_id: string | null;
  occurred_at: Date | string;
};

const REQUEST_EVENTS_IN_SCOPE: ReadonlySet<HelpdeskEventKind> = new Set([
  'request.status_changed',
  'request.reply',
  'request.reply_retracted',
]);

/**
 * Which of these events' requests the integration still reaches: the radar
 * passes `requireHelpdeskRadar` for it now, the request is still on that
 * radar, and it was filed through this integration (§3.5).
 */
async function requestsInScope(actor: IntegrationActor, rows: EventRow[]): Promise<Set<string>> {
  const asked = rows.filter(
    (row) =>
      isHelpdeskEventKind(row.event) &&
      REQUEST_EVENTS_IN_SCOPE.has(row.event) &&
      row.request_id &&
      row.radar_id,
  );
  const inScope = new Set<string>();
  if (asked.length === 0) return inScope;
  const reachable = new Set<string>();
  for (const radarId of new Set(asked.map((row) => row.radar_id ?? ''))) {
    try {
      await requireHelpdeskRadar(radarId, actor);
      reachable.add(radarId);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  const requestIds = [...new Set(asked.map((row) => row.request_id ?? ''))];
  const requests = await getDb()
    .select({
      id: schema.helpdeskRequests.blipId,
      integrationId: schema.helpdeskRequests.integrationId,
      radarId: schema.blips.radarId,
    })
    .from(schema.helpdeskRequests)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.helpdeskRequests.blipId))
    .where(inArray(schema.helpdeskRequests.blipId, requestIds));
  const where = new Map(requests.map((r) => [r.id, r]));
  for (const row of asked) {
    const request = where.get(row.request_id ?? '');
    if (
      request &&
      request.integrationId === actor.integrationId &&
      request.radarId === row.radar_id &&
      reachable.has(row.radar_id)
    )
      inScope.add(row.seq);
  }
  return inScope;
}

function toDto(row: EventRow, inScope: Set<string>): HelpdeskEventDto {
  const event: HelpdeskEventKind = isHelpdeskEventKind(row.event) ? row.event : 'request.removed';
  const left = REQUEST_EVENTS_IN_SCOPE.has(event) && !inScope.has(row.seq);
  const occurred = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
  return {
    id: row.id,
    cursor: eventCursor(row.xid, row.seq),
    event: left ? 'request.removed' : event,
    occurredAt: occurred.toISOString(),
    integrationId: row.integration_id,
    requestId: row.request_id,
    radarId: row.radar_id,
    replyId: left ? null : row.reply_id,
  };
}

async function project(actor: IntegrationActor, rows: EventRow[]): Promise<HelpdeskEventDto[]> {
  const inScope = await requestsInScope(actor, rows);
  return rows.map((row) => toDto(row, inScope));
}

/* ---------------------------------- pull ----------------------------------- */

/**
 * The reconcile feed: this integration's events after `after`, ascending by
 * `(xid, seq)`, only below the snapshot watermark. Ids only, so no requester
 * scope is needed. Both statements run in one read-only REPEATABLE READ
 * transaction, so the page and the lag are read against the same snapshot.
 */
export async function listHelpdeskEvents(
  actor: IntegrationActor,
  query: HelpdeskEventsQuery,
): Promise<{ items: HelpdeskEventDto[]; nextAfter: string | null; watermarkLagSeconds: number }> {
  const after = query.after ? readEventCursor(query.after) : null;
  const limit = query.limit ?? HELPDESK_EVENT_LIMITS.page;
  const { rows, lag } = await getDb().transaction(
    async (tx) => {
      const page = await tx.execute<EventRow>(sql`
        SELECT e.seq::text AS seq, e.xid::text AS xid, e.id, e.integration_id, e.event,
               e.request_id, e.radar_id, e.reply_id, e.occurred_at
          FROM integration_events e
         WHERE e.integration_id = ${actor.integrationId}::uuid
           AND e.xid < pg_snapshot_xmin(pg_current_snapshot())
           ${after ? sql`AND (e.xid, e.seq) > (${after.xid}::xid8, ${after.seq}::bigint)` : sql``}
         ORDER BY e.xid, e.seq
         LIMIT ${limit}`);
      // Committed events held back by an older open transaction: how long the
      // oldest of them has waited.
      const held = await tx.execute<{ lag: number | string | null }>(sql`
        SELECT EXTRACT(EPOCH FROM now() - min(e.occurred_at))::float8 AS lag
          FROM integration_events e
         WHERE e.integration_id = ${actor.integrationId}::uuid
           AND e.xid >= pg_snapshot_xmin(pg_current_snapshot())`);
      return { rows: page.rows, lag: Number(held.rows[0]?.lag ?? 0) };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const items = await project(actor, rows);
  const last = items[items.length - 1];
  return {
    items,
    nextAfter: last ? last.cursor : (query.after ?? null),
    watermarkLagSeconds: Math.max(0, Math.round(lag)),
  };
}

/* ---------------------------------- push ----------------------------------- */

function integrationActor(row: IntegrationRow, user: typeof schema.users.$inferSelect) {
  return {
    user,
    kind: 'integration' as const,
    integrationId: row.id,
    ceiling: 'editor' as const,
  };
}

/**
 * Deliver one due event. No network happens while a transaction is open, and
 * the lease survives a lost process (a claimed row is retried a minute later),
 * as subscriptions do. A paused integration's events wait, except a test ping,
 * which is how a person checks the receiver before resuming.
 */
export async function drainIntegrationDeliveries(): Promise<number> {
  const claimed = await getDb().execute<{
    event_seq: string;
    integration_id: string;
    attempts: number;
  }>(sql`
    WITH picked AS (
      SELECT d.event_seq
        FROM integration_deliveries d
        JOIN integrations i ON i.id = d.integration_id
        JOIN integration_events e ON e.seq = d.event_seq
       WHERE d.run_after <= now()
         AND (i.delivery_paused_at IS NULL OR e.event = 'integration.test')
       ORDER BY d.run_after, e.xid, e.seq
       LIMIT 1
         FOR UPDATE OF d SKIP LOCKED)
    UPDATE integration_deliveries d
       SET attempts = d.attempts + 1, run_after = now() + interval '1 minute'
      FROM picked
     WHERE d.event_seq = picked.event_seq
    RETURNING d.event_seq::text AS event_seq, d.integration_id, d.attempts`);
  const job = claimed.rows[0];
  if (!job) return 0;

  const [found] = await getDb()
    .select({ integration: schema.integrations, user: schema.users })
    .from(schema.integrations)
    .innerJoin(schema.users, eq(schema.users.id, schema.integrations.ownerId))
    .where(eq(schema.integrations.id, job.integration_id));
  const events = await getDb().execute<EventRow>(sql`
    SELECT e.seq::text AS seq, e.xid::text AS xid, e.id, e.integration_id, e.event,
           e.request_id, e.radar_id, e.reply_id, e.occurred_at
      FROM integration_events e WHERE e.seq = ${job.event_seq}::bigint`);
  const row = events.rows[0];
  // Revoked, its owner no longer active, or the receiver removed: nothing is
  // delivered (§3.4 "Revoke"). The event stays in the log.
  if (
    !found ||
    !row ||
    found.integration.revokedAt ||
    found.user.state !== 'active' ||
    !found.integration.deliveryUrl ||
    !found.integration.deliverySecretCiphertext
  ) {
    await getDb()
      .delete(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.eventSeq, Number(job.event_seq)));
    return 1;
  }
  const { integration, user } = found;
  const [payload] = await project(integrationActor(integration, user), [row]);
  if (!payload) throw new Error('an event projected to nothing');

  let status: number | null = null;
  let error: string | null = null;
  try {
    const raw = JSON.stringify(payload);
    const response = await publicRequest(new URL(integration.deliveryUrl ?? ''), {
      httpsOnly: true,
      method: 'POST',
      body: Buffer.from(raw),
      timeoutMs: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-OMR-Signature': signSubscription(
          decryptSubscriptionSecret(integration.deliverySecretCiphertext ?? ''),
          raw,
        ),
        'X-OMR-Event-Id': payload.id,
        'X-OMR-Delivery-Attempt': String(job.attempts),
      },
    });
    status = response.status;
    if (status < 200 || status >= 300) error = `Receiver returned HTTP ${status}`;
  } catch {
    // A network error can carry a URL with credentials in its query string.
    error = 'Delivery failed: connection, public-address validation, signing or 10-second timeout.';
  }

  const isTest = payload.event === 'integration.test';
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, integration.id))
      .for('update');
    if (!current) return;
    // A stale lease may have sent a duplicate, but cannot overwrite a newer result.
    const [lease] = await tx
      .select()
      .from(schema.integrationDeliveries)
      .where(
        and(
          eq(schema.integrationDeliveries.eventSeq, Number(job.event_seq)),
          eq(schema.integrationDeliveries.attempts, job.attempts),
        ),
      )
      .for('update');
    if (!lease) return;
    await tx.insert(schema.integrationDeliveryAttempts).values({
      integrationId: current.id,
      eventId: payload.id,
      event: payload.event,
      attempt: job.attempts,
      status,
      error,
    });
    await tx.execute(sql`
      DELETE FROM integration_delivery_attempts
       WHERE integration_id = ${current.id}::uuid AND id IN (
         SELECT id FROM integration_delivery_attempts WHERE integration_id = ${current.id}::uuid
          ORDER BY created_at DESC, id DESC OFFSET ${HELPDESK_EVENT_LIMITS.history})`);
    await tx
      .update(schema.integrations)
      .set({ deliveryLastError: error })
      .where(eq(schema.integrations.id, current.id));

    if (!error) {
      await tx
        .delete(schema.integrationDeliveries)
        .where(eq(schema.integrationDeliveries.eventSeq, lease.eventSeq));
      // A receiver that answers a test ping is a receiver that works: resume,
      // and send what was buffered, oldest first (§5.4).
      if (isTest && current.deliveryPausedAt) await resumeIn(tx, current.id);
    } else if (isTest) {
      // One attempt: the result is in the history, which is what a test is for.
      await tx
        .delete(schema.integrationDeliveries)
        .where(eq(schema.integrationDeliveries.eventSeq, lease.eventSeq));
    } else if (job.attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Pause and buffer. This row goes back to the head of the queue with
      // its count reset, so a resume sends it first.
      await tx
        .update(schema.integrationDeliveries)
        .set({ attempts: 0, runAfter: sql`now()` })
        .where(eq(schema.integrationDeliveries.eventSeq, lease.eventSeq));
      if (!current.deliveryPausedAt) {
        await tx
          .update(schema.integrations)
          .set({ deliveryPausedAt: sql`now()` })
          .where(eq(schema.integrations.id, current.id));
        await tx.insert(schema.notifications).values({
          userId: current.ownerId,
          kind: 'subscription_failed',
          groupKey: `integration:${current.id}:${randomUUID()}`,
          subject: current.name,
          excerpt:
            'Client portal delivery paused after six failed attempts. New events are kept and ' +
            'will be sent when you resume. Check Settings → Connections.',
        });
      }
    } else {
      await tx
        .update(schema.integrationDeliveries)
        .set({
          runAfter: new Date(Date.now() + (RETRY_SECONDS[job.attempts - 1] ?? 10_800) * 1000),
        })
        .where(eq(schema.integrationDeliveries.eventSeq, lease.eventSeq));
    }
  });
  return 1;
}

/** Clear the pause and put every buffered event back in the queue, due now. */
async function resumeIn(tx: Pick<Db, 'update'>, integrationId: string): Promise<void> {
  await tx
    .update(schema.integrations)
    .set({ deliveryPausedAt: null, deliveryLastError: null })
    .where(eq(schema.integrations.id, integrationId));
  await tx
    .update(schema.integrationDeliveries)
    .set({ attempts: 0, runAfter: sql`now()` })
    .where(eq(schema.integrationDeliveries.integrationId, integrationId));
}

let kicking = false;
/**
 * Drain now, in this process, rather than at the worker's next tick. Best
 * effort; the routes call it after a resume or a test so the owner sees the
 * result at once. The services never call it, so a test drains by hand.
 */
export function kickIntegrationDeliveries(): void {
  if (kicking) return;
  kicking = true;
  void (async () => {
    while (await drainIntegrationDeliveries()) {
      /* Drain due work; retries wait for the worker. */
    }
  })()
    .catch((err: unknown) => logger.error({ err }, 'integration delivery drain failed'))
    .finally(() => {
      kicking = false;
    });
}

/** Worker sweep: events past retention (§5.4: 30 days, then the portal resyncs by listing). */
export async function purgeExpiredIntegrationEvents(batchSize = 1_000): Promise<number> {
  const result = await getDb().execute(sql`
    DELETE FROM integration_events WHERE seq IN (
      SELECT seq FROM integration_events
       WHERE occurred_at < now() - make_interval(hours => ${HELPDESK_EVENT_LIMITS.retentionHours})
       LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)`);
  return result.rowCount ?? 0;
}

/* ------------------------------ the owner's side ---------------------------- */

async function ownIntegration(actor: Actor, integrationId: string): Promise<IntegrationRow> {
  const [row] = await getDb()
    .select()
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.id, integrationId),
        eq(schema.integrations.ownerId, actor.user.id),
      ),
    )
    .limit(1);
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

function newDeliverySecret(): string {
  return `omr_whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Where the portal receives events. Human-only: an outbound secret, like a
 * subscription's (DESIGN §34). A public https URL, vetted now for a legible
 * answer and again on every attempt. The signing secret is minted the first
 * time and kept when only the URL changes; it is returned once, when minted.
 * `null` removes the receiver and drops anything queued for it (the log stays
 * for pull).
 */
export async function setIntegrationDelivery(
  actor: Actor,
  integrationId: string,
  url: string | null,
): Promise<{ secret?: string }> {
  assertHumanDecision(actor, RECEIVER_REFUSAL);
  const existing = await ownIntegration(actor, integrationId);
  if (existing.revokedAt) throw conflict('This integration is revoked. Connect a new one instead.');
  if (url === null) {
    await getDb().transaction(async (tx) => {
      await tx
        .update(schema.integrations)
        .set({
          deliveryUrl: null,
          deliverySecretCiphertext: null,
          deliveryPausedAt: null,
          deliveryLastError: null,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.integrations.id, existing.id));
      await tx
        .delete(schema.integrationDeliveries)
        .where(eq(schema.integrationDeliveries.integrationId, existing.id));
    });
    await recordAudit(actor, 'integration.delivery_remove', 'integration', existing.id, {});
    return {};
  }
  const target = new URL(url);
  await vetPublicUrl(target, { httpsOnly: true }).catch((err: unknown) => {
    throw err instanceof UnsafeOutboundUrlError ? badRequest(unsafeUrlMessage(target, err)) : err;
  });
  const secret = existing.deliverySecretCiphertext ? undefined : newDeliverySecret();
  await getDb()
    .update(schema.integrations)
    .set({
      deliveryUrl: target.toString(),
      ...(secret ? { deliverySecretCiphertext: encryptSubscriptionSecret(secret) } : {}),
      deliveryLastError: null,
      updatedAt: sql`now()`,
    })
    .where(eq(schema.integrations.id, existing.id));
  await recordAudit(actor, 'integration.delivery_set', 'integration', existing.id, {
    host: target.host,
  });
  return secret ? { secret } : {};
}

/** A new signing secret, shown once. OMR signs with it alone from now (§3.4). */
export async function rotateIntegrationDeliverySecret(
  actor: Actor,
  integrationId: string,
): Promise<{ secret: string }> {
  assertHumanDecision(actor, RECEIVER_REFUSAL);
  const existing = await ownIntegration(actor, integrationId);
  if (existing.revokedAt) throw conflict('This integration is revoked. Connect a new one instead.');
  if (!existing.deliveryUrl) throw badRequest('Set where the portal receives events first.');
  const secret = newDeliverySecret();
  await getDb()
    .update(schema.integrations)
    .set({ deliverySecretCiphertext: encryptSubscriptionSecret(secret), updatedAt: sql`now()` })
    .where(eq(schema.integrations.id, existing.id));
  await recordAudit(actor, 'integration.delivery_rotate', 'integration', existing.id, {});
  return { secret };
}

/**
 * Stop pushing. Events keep being logged and queued, and the portal can still
 * pull them. The safe direction, so an agent may do it (§3.4).
 */
export async function pauseIntegrationDelivery(actor: Actor, integrationId: string): Promise<void> {
  await requireScope(actor, 'write', 'pause delivery to a client portal');
  const existing = await ownIntegration(actor, integrationId);
  await getDb()
    .update(schema.integrations)
    .set({ deliveryPausedAt: sql`COALESCE(delivery_paused_at, now())` })
    .where(eq(schema.integrations.id, existing.id));
  await recordAudit(actor, 'integration.delivery_pause', 'integration', existing.id, {});
}

/** Push again, from the oldest buffered event. Human-only. */
export async function resumeIntegrationDelivery(
  actor: Actor,
  integrationId: string,
): Promise<void> {
  assertHumanDecision(actor, RESUME_REFUSAL);
  const existing = await ownIntegration(actor, integrationId);
  if (existing.revokedAt) throw conflict('This integration is revoked. Connect a new one instead.');
  await getDb().transaction((tx) => resumeIn(tx, existing.id));
  await recordAudit(actor, 'integration.delivery_resume', 'integration', existing.id, {});
}

/**
 * Send an `integration.test` event now, even while paused. If the receiver
 * answers 2xx, delivery resumes. One outstanding test at a time. Human-only,
 * because a success resumes.
 */
export async function testIntegrationDelivery(actor: Actor, integrationId: string): Promise<void> {
  assertHumanDecision(actor, RESUME_REFUSAL);
  const existing = await ownIntegration(actor, integrationId);
  if (existing.revokedAt) throw conflict('This integration is revoked. Connect a new one instead.');
  if (!existing.deliveryUrl) throw badRequest('Set where the portal receives events first.');
  await getDb().transaction(async (tx) => {
    await tx
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, existing.id))
      .for('update');
    const pending = await tx.execute(sql`
      SELECT 1 FROM integration_deliveries d
        JOIN integration_events e ON e.seq = d.event_seq
       WHERE d.integration_id = ${existing.id}::uuid AND e.event = 'integration.test'
       LIMIT 1`);
    if (pending.rows.length > 0)
      throw badRequest('A test is already on its way. Check the delivery history shortly.');
    await tx.execute(
      sql`SELECT omr_integration_emit(${existing.id}::uuid, 'integration.test', NULL, NULL, NULL)`,
    );
  });
  await recordAudit(actor, 'integration.delivery_test', 'integration', existing.id, {});
}

/** The receiver's state and the last attempts. Agents may read it (§3.4). */
export async function listIntegrationDeliveries(
  actor: Actor,
  integrationId: string,
): Promise<IntegrationDeliveriesDto> {
  await requireScope(actor, 'read', 'read a client portal’s delivery history');
  const existing = await ownIntegration(actor, integrationId);
  const pending = await pendingDeliveries([existing.id]);
  const attempts = await getDb()
    .select()
    .from(schema.integrationDeliveryAttempts)
    .where(eq(schema.integrationDeliveryAttempts.integrationId, existing.id))
    .orderBy(
      desc(schema.integrationDeliveryAttempts.createdAt),
      desc(schema.integrationDeliveryAttempts.id),
    )
    .limit(HELPDESK_EVENT_LIMITS.history);
  return {
    delivery: deliveryOf(existing, pending.get(existing.id) ?? 0),
    attempts: attempts.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      event: isHelpdeskEventKind(row.event) ? row.event : 'request.removed',
      attempt: row.attempt,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** How many events wait for each integration's receiver. */
export async function pendingDeliveries(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select({
      integrationId: schema.integrationDeliveries.integrationId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.integrationDeliveries)
    .where(inArray(schema.integrationDeliveries.integrationId, ids))
    .groupBy(schema.integrationDeliveries.integrationId);
  for (const row of rows) out.set(row.integrationId, row.count);
  return out;
}

export function deliveryOf(
  row: IntegrationRow,
  pending: number,
): IntegrationDeliveriesDto['delivery'] {
  if (!row.deliveryUrl) return null;
  return {
    url: row.deliveryUrl,
    pausedAt: row.deliveryPausedAt?.toISOString() ?? null,
    lastError: row.deliveryLastError,
    pending,
  };
}

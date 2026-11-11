import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  createSubscriptionSchema,
  type CreateSubscriptionInput,
  type SubscriptionDeliveryDto,
  type SubscriptionDto,
  type SubscriptionEvent,
  type SubscriptionPayload,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, notFound, type Actor } from '../http.js';
import { assertHumanDecision, requireRadar } from './access.js';
import { recordAudit } from './audit.js';
import {
  publicRequest,
  UnsafeOutboundUrlError,
  unsafeUrlMessage,
  vetPublicUrl,
} from './public-request.js';
import {
  encryptSubscriptionSecret,
  decryptSubscriptionSecret,
  signSubscription,
} from './subscription-signing.js';
import { logger } from '../logger.js';

type Subscription = typeof schema.radarSubscriptions.$inferSelect;
type Blip = typeof schema.blips.$inferSelect;
type EventDb = Pick<Db, 'select' | 'insert'>;
const MAX_ATTEMPTS = 6;
// Six tries spanning 5h36m. Exhaustion pauses the endpoint and alerts its creator.
const RETRY_SECONDS = [60, 300, 1800, 7200, 10800];
function dto(row: Subscription, secret?: string): SubscriptionDto {
  return {
    id: row.id,
    radarId: row.radarId,
    name: row.name,
    url: row.url,
    events: row.events as SubscriptionEvent[],
    enabled: row.enabled,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    ...(secret ? { secret } : {}),
  };
}
/*
 * Every query below keys on `access.radar.id`, never on the identifier the
 * caller passed: `requireRadar` also accepts a slug, which is not a uuid and
 * made each of these a 500 for an owner who used one.
 */
async function own(actor: Actor, radarId: string, id: string): Promise<Subscription> {
  const access = await requireRadar(radarId, actor, 'manage');
  const [row] = await getDb()
    .select()
    .from(schema.radarSubscriptions)
    .where(
      and(
        eq(schema.radarSubscriptions.id, id),
        eq(schema.radarSubscriptions.radarId, access.radar.id),
      ),
    );
  if (!row) throw notFound('Subscription not found');
  return row;
}
export async function listSubscriptions(actor: Actor, radarId: string): Promise<SubscriptionDto[]> {
  const access = await requireRadar(radarId, actor, 'manage');
  return (
    await getDb()
      .select()
      .from(schema.radarSubscriptions)
      .where(eq(schema.radarSubscriptions.radarId, access.radar.id))
      .orderBy(schema.radarSubscriptions.createdAt)
  ).map((r) => dto(r));
}
export async function createSubscription(
  actor: Actor,
  radarId: string,
  input: CreateSubscriptionInput,
): Promise<SubscriptionDto> {
  assertHumanDecision(actor, 'Create outbound credentials from radar settings.');
  const access = await requireRadar(radarId, actor, 'manage');
  if (access.radar.kind === 'smart')
    throw badRequest('Subscribe to the radar that holds the blips.');
  const parsed = createSubscriptionSchema.safeParse(input);
  if (!parsed.success)
    throw badRequest('Choose a public HTTPS URL and at least one supported event.');
  // Refused now rather than discovered at the first delivery. The delivery path
  // still vets every attempt; this is the early, legible answer.
  const target = new URL(parsed.data.url);
  await vetPublicUrl(target, { httpsOnly: true }).catch((err: unknown) => {
    throw err instanceof UnsafeOutboundUrlError ? badRequest(unsafeUrlMessage(target, err)) : err;
  });
  const secret = `omr_whsec_${randomBytes(32).toString('base64url')}`;
  const row = await getDb().transaction(async (tx) => {
    // Serialize the per-radar bound with other subscription creates.
    await tx
      .select({ id: schema.radars.id })
      .from(schema.radars)
      .where(eq(schema.radars.id, access.radar.id))
      .for('update');
    const existing = await tx
      .select({ id: schema.radarSubscriptions.id })
      .from(schema.radarSubscriptions)
      .where(eq(schema.radarSubscriptions.radarId, access.radar.id));
    if (existing.length >= 20)
      throw badRequest('A radar can have up to 20 outbound subscriptions.');
    const [row] = await tx
      .insert(schema.radarSubscriptions)
      .values({
        ...parsed.data,
        radarId: access.radar.id,
        createdBy: actor.user.id,
        secretCiphertext: encryptSubscriptionSecret(secret),
      })
      .returning();
    if (!row) throw new Error('subscription insert returned no row');
    await recordAudit(
      actor,
      'subscription.create',
      'subscription',
      row.id,
      { radarId: access.radar.id },
      tx,
    );
    return row;
  });
  return dto(row, secret);
}
export async function updateSubscription(
  actor: Actor,
  radarId: string,
  id: string,
  enabled: boolean,
): Promise<SubscriptionDto> {
  assertHumanDecision(actor, 'Manage outbound delivery from radar settings.');
  const row = await own(actor, radarId, id);
  // Resuming never transfers the credential to the current manager.
  const [updated] = await getDb()
    .update(schema.radarSubscriptions)
    .set({ enabled, lastError: enabled ? null : row.lastError })
    .where(eq(schema.radarSubscriptions.id, id))
    .returning();
  if (!updated) throw notFound('Subscription not found');
  await recordAudit(actor, 'subscription.update', 'subscription', id, { enabled });
  return dto(updated);
}
export async function rotateSubscription(
  actor: Actor,
  radarId: string,
  id: string,
): Promise<SubscriptionDto> {
  assertHumanDecision(actor, 'Rotate outbound credentials from radar settings.');
  await own(actor, radarId, id);
  const secret = `omr_whsec_${randomBytes(32).toString('base64url')}`;
  const [row] = await getDb()
    .update(schema.radarSubscriptions)
    .set({ secretCiphertext: encryptSubscriptionSecret(secret) })
    .where(eq(schema.radarSubscriptions.id, id))
    .returning();
  if (!row) throw notFound('Subscription not found');
  await recordAudit(actor, 'subscription.rotate', 'subscription', id, {});
  return dto(row, secret);
}
export async function deleteSubscription(actor: Actor, radarId: string, id: string): Promise<void> {
  const row = await own(actor, radarId, id);
  await getDb().delete(schema.radarSubscriptions).where(eq(schema.radarSubscriptions.id, id));
  await recordAudit(actor, 'subscription.delete', 'subscription', id, { radarId: row.radarId });
}
export async function listSubscriptionDeliveries(
  actor: Actor,
  radarId: string,
  id: string,
): Promise<SubscriptionDeliveryDto[]> {
  await own(actor, radarId, id);
  const rows = await getDb()
    .select()
    .from(schema.subscriptionAttempts)
    .where(eq(schema.subscriptionAttempts.subscriptionId, id))
    .orderBy(desc(schema.subscriptionAttempts.createdAt), desc(schema.subscriptionAttempts.id))
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    event: row.event,
    attempt: row.attempt,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }));
}
function envelope(
  actor: Actor,
  radar: { id: string; name: string },
  event: SubscriptionPayload['event'],
): SubscriptionPayload {
  return {
    id: `evt_${randomUUID()}`,
    event,
    occurredAt: new Date().toISOString(),
    radar: { id: radar.id, name: radar.name },
    actor: {
      kind: actor.kind,
      id: actor.user.id,
      name: actor.user.name,
      agentId: actor.agent?.agentId ?? null,
    },
    blip: null,
    changes: null,
    comment: null,
  };
}
function snapshot(blip: Blip): Record<string, unknown> {
  return {
    id: blip.id,
    radarId: blip.radarId,
    kind: blip.kind,
    state: blip.state,
    status: blip.status,
    title: blip.title,
    body: blip.body,
    emailNotes: blip.emailNotes,
    tags: blip.tags,
    url: blip.url,
    dueAt: blip.dueAt?.toISOString() ?? null,
    pinned: blip.pinned,
    supersedesId: blip.supersedesId,
    createdAt: blip.createdAt.toISOString(),
    updatedAt: blip.updatedAt.toISOString(),
  };
}
/** Called inside the content transaction: an event cannot survive a rollback. */
export async function enqueueSubscriptionEvent(
  db: EventDb,
  actor: Actor,
  radar: { id: string; name: string },
  event: SubscriptionEvent,
  blip: Blip,
  before?: Blip,
  comment?: typeof schema.blipComments.$inferSelect,
): Promise<void> {
  const payload = envelope(actor, radar, event);
  payload.blip = snapshot(blip);
  if (before) {
    const previous = snapshot(before);
    payload.changes = {};
    for (const key of Object.keys(payload.blip)) {
      if (key === 'updatedAt' || key === 'createdAt') continue;
      if (JSON.stringify(previous[key]) !== JSON.stringify(payload.blip[key]))
        payload.changes[key] = { from: previous[key], to: payload.blip[key] };
    }
    if (Object.keys(payload.changes).length === 0) return;
  }
  if (comment)
    payload.comment = {
      id: comment.id,
      blipId: comment.blipId,
      body: comment.body,
      parentId: comment.parentId,
      // So the owner's own receivers can tell an internal note from a reply to
      // a client (docs/HELPDESK.md §7.5). The body is still sent, as it always
      // has been: a generic subscription is the owner's own pipe, and the
      // client portal is never one.
      visibility: comment.visibility,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
    };
  const rows = await db
    .select()
    .from(schema.radarSubscriptions)
    .where(
      and(
        eq(schema.radarSubscriptions.radarId, radar.id),
        eq(schema.radarSubscriptions.enabled, true),
      ),
    );
  for (const row of rows) {
    if (row.events.includes(event))
      await db.insert(schema.subscriptionDeliveries).values({ subscriptionId: row.id, payload });
  }
}
export async function testSubscription(actor: Actor, radarId: string, id: string): Promise<void> {
  assertHumanDecision(actor, 'Send test deliveries from radar settings.');
  const row = await own(actor, radarId, id);
  if (!row.enabled) throw badRequest('Resume this subscription before testing it.');
  const access = await requireRadar(radarId, actor, 'manage');
  // One outstanding ping at a time, serialized against other pings.
  await getDb().transaction(async (tx) => {
    await tx
      .select()
      .from(schema.radarSubscriptions)
      .where(eq(schema.radarSubscriptions.id, id))
      .for('update');
    const pending = await tx
      .select({ id: schema.subscriptionDeliveries.id })
      .from(schema.subscriptionDeliveries)
      .where(eq(schema.subscriptionDeliveries.subscriptionId, id))
      .limit(1);
    if (pending.length)
      throw badRequest('A delivery is already pending. Check delivery history shortly.');
    await tx
      .insert(schema.subscriptionDeliveries)
      .values({ subscriptionId: id, payload: envelope(actor, access.radar, 'subscription.test') });
  });
  kickSubscriptionDeliveries();
}

/** No network happens while a database transaction is open. Leases survive process loss. */
export async function drainSubscriptionDeliveries(): Promise<number> {
  const claimed = await getDb().execute<{
    id: string;
    subscription_id: string;
    payload: SubscriptionPayload;
    attempts: number;
  }>(sql`
    WITH picked AS (SELECT id FROM subscription_deliveries WHERE run_after <= now()
      ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE subscription_deliveries d SET attempts=d.attempts+1, run_after=now()+interval '1 minute'
    FROM picked WHERE d.id=picked.id RETURNING d.*`);
  const job = claimed.rows[0];
  if (!job) return 0;
  const [row] = await getDb()
    .select({ subscription: schema.radarSubscriptions, user: schema.users })
    .from(schema.radarSubscriptions)
    .innerJoin(schema.users, eq(schema.users.id, schema.radarSubscriptions.createdBy))
    .where(eq(schema.radarSubscriptions.id, job.subscription_id));
  let allowed = Boolean(row?.subscription.enabled && row.user.state === 'active');
  if (row && allowed) {
    try {
      await requireRadar(
        row.subscription.radarId,
        { user: row.user, kind: 'webhook', webhookId: row.subscription.id },
        'write',
      );
      const blipId = job.payload.blip?.['id'];
      if (typeof blipId === 'string') {
        const [current] = await getDb()
          .select({ radarId: schema.blips.radarId })
          .from(schema.blips)
          .where(eq(schema.blips.id, blipId));
        if (
          current &&
          current.radarId !== row.subscription.radarId &&
          job.payload.event !== 'blip.deleted'
        )
          allowed = false;
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404))
        allowed = false;
      else throw error;
    }
  }
  if (!allowed || !row) {
    await getDb()
      .delete(schema.subscriptionDeliveries)
      .where(eq(schema.subscriptionDeliveries.id, job.id));
    return 1;
  }
  let status: number | null = null;
  let error: string | null = null;
  try {
    const raw = JSON.stringify(job.payload);
    const response = await publicRequest(new URL(row.subscription.url), {
      httpsOnly: true,
      method: 'POST',
      body: Buffer.from(raw),
      timeoutMs: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-OMR-Signature': signSubscription(
          decryptSubscriptionSecret(row.subscription.secretCiphertext),
          raw,
        ),
        'X-OMR-Event-Id': job.payload.id,
        'X-OMR-Delivery-Attempt': String(job.attempts),
      },
    });
    status = response.status;
    if (status < 200 || status >= 300) error = `Receiver returned HTTP ${status}`;
  } catch {
    // Network errors can contain URLs with credentials in their query string.
    error = 'Delivery failed: connection, public-address validation, signing or 10-second timeout.';
  }
  await getDb().transaction(async (tx) => {
    const [subscription] = await tx
      .select()
      .from(schema.radarSubscriptions)
      .where(eq(schema.radarSubscriptions.id, job.subscription_id))
      .for('update');
    if (!subscription) return;
    // A stale lease may have sent a duplicate, but cannot overwrite a newer result.
    const [current] = await tx
      .select()
      .from(schema.subscriptionDeliveries)
      .where(
        and(
          eq(schema.subscriptionDeliveries.id, job.id),
          eq(schema.subscriptionDeliveries.attempts, job.attempts),
        ),
      )
      .for('update');
    if (!current) return;
    await tx.insert(schema.subscriptionAttempts).values({
      subscriptionId: subscription.id,
      eventId: job.payload.id,
      event: job.payload.event,
      attempt: job.attempts,
      status,
      error,
    });
    await tx.execute(sql`DELETE FROM subscription_attempts WHERE subscription_id=${subscription.id}::uuid AND id IN
      (SELECT id FROM subscription_attempts WHERE subscription_id=${subscription.id}::uuid ORDER BY created_at DESC,id DESC OFFSET 100)`);
    await tx
      .update(schema.radarSubscriptions)
      .set({ lastError: error })
      .where(eq(schema.radarSubscriptions.id, subscription.id));
    if (!error)
      await tx
        .delete(schema.subscriptionDeliveries)
        .where(eq(schema.subscriptionDeliveries.id, job.id));
    else if (job.attempts >= MAX_ATTEMPTS) {
      await tx
        .update(schema.radarSubscriptions)
        .set({ enabled: false })
        .where(eq(schema.radarSubscriptions.id, subscription.id));
      await tx
        .delete(schema.subscriptionDeliveries)
        .where(eq(schema.subscriptionDeliveries.subscriptionId, subscription.id));
      if (subscription.enabled)
        await tx.insert(schema.notifications).values({
          userId: subscription.createdBy,
          radarId: subscription.radarId,
          kind: 'subscription_failed',
          groupKey: `subscription:${subscription.id}:${randomUUID()}`,
          subject: subscription.name,
          excerpt:
            'Outbound delivery paused after six failed attempts. Check Webhooks in radar settings, then resume.',
        });
    } else
      await tx
        .update(schema.subscriptionDeliveries)
        .set({ runAfter: new Date(Date.now() + (RETRY_SECONDS[job.attempts - 1] ?? 10800) * 1000) })
        .where(eq(schema.subscriptionDeliveries.id, job.id));
  });
  return 1;
}
let kicking = false;
export function kickSubscriptionDeliveries(): void {
  if (kicking) return;
  kicking = true;
  void (async () => {
    while (await drainSubscriptionDeliveries()) {
      /* Drain due work; retries wait for the worker. */
    }
  })()
    .catch((err: unknown) => logger.error({ err }, 'outbound subscription drain failed'))
    .finally(() => {
      kicking = false;
    });
}

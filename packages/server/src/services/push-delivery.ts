import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';
import { enqueue, registerOutboxHandler } from './outbox.js';
import { apnsConfigured, sendApns } from './apns.js';
import { pushConfigured, sendWebPush } from './push.js';
import { pushNotificationContext } from './notifications.js';

export async function queuePushDeliveries(
  notification: typeof schema.notifications.$inferSelect,
): Promise<void> {
  if (notification.agentId || notification.pushedAt) return;
  if (!pushConfigured() && !apnsConfigured('sandbox') && !apnsConfigured('production')) return;
  let expiresAt = new Date(notification.createdAt.getTime() + 86_400_000);
  if (notification.kind === 'due' && notification.blipId) {
    const [reminder] = await getDb()
      .select()
      .from(schema.blipReminders)
      .where(
        and(
          eq(schema.blipReminders.blipId, notification.blipId),
          eq(schema.blipReminders.userId, notification.userId),
        ),
      );
    if (!reminder?.reminderAt) return;
    expiresAt = new Date(reminder.reminderAt.getTime() + 3_600_000);
  }
  if (expiresAt.getTime() <= Date.now()) return;
  await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notification.id))
      .for('update');
    if (!row || row.pushedAt) return;
    const sessions = tx
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(eq(schema.sessions.userId, row.userId), gt(schema.sessions.expiresAt, new Date())),
      );
    const [native, web] = await Promise.all([
      tx
        .select()
        .from(schema.pushDevices)
        .where(
          and(
            eq(schema.pushDevices.userId, row.userId),
            isNull(schema.pushDevices.disabledAt),
            inArray(schema.pushDevices.sessionId, sessions),
            lte(schema.pushDevices.registeredAt, row.createdAt),
          ),
        ),
      tx
        .select()
        .from(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.userId, row.userId),
            isNull(schema.pushSubscriptions.disabledAt),
            isNotNull(schema.pushSubscriptions.sessionId),
            inArray(schema.pushSubscriptions.sessionId, sessions),
            lte(schema.pushSubscriptions.registeredAt, row.createdAt),
          ),
        ),
    ]);
    const destinations = [
      ...native
        .filter((d) => apnsConfigured(d.environment))
        .map((d) => ({ kind: 'apns' as const, device: d })),
      ...web.filter(() => pushConfigured()).map((d) => ({ kind: 'web' as const, device: d })),
    ];
    for (const { kind, device } of destinations.slice(0, 20)) {
      const [receipt] = await tx
        .insert(schema.pushDeliveries)
        .values({
          notificationId: row.id,
          destinationKind: kind,
          destinationId: device.id,
          generation: device.generation,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.pushDeliveries.id });
      if (receipt)
        await enqueue(tx, 'push', { deliveryId: receipt.id, expiresAt: expiresAt.toISOString() });
    }
  });
}

registerOutboxHandler('push', async (payload, job) => {
  const id = typeof payload['deliveryId'] === 'string' ? payload['deliveryId'] : '';
  if (!id) return;
  const db = getDb();
  const [receipt] = await db
    .update(schema.pushDeliveries)
    .set({
      leaseUntil: new Date(Date.now() + 30_000),
      attempts: sql`${schema.pushDeliveries.attempts}+1`,
    })
    .where(
      and(
        eq(schema.pushDeliveries.id, id),
        eq(schema.pushDeliveries.state, 'pending'),
        sql`(${schema.pushDeliveries.leaseUntil} IS NULL OR ${schema.pushDeliveries.leaseUntil}<now())`,
      ),
    )
    .returning();
  if (!receipt) {
    const [existing] = await db
      .select()
      .from(schema.pushDeliveries)
      .where(eq(schema.pushDeliveries.id, id));
    if (existing?.state === 'pending') throw new Error('push_delivery_busy');
    return;
  }
  const ownsAttempt = and(
    eq(schema.pushDeliveries.id, id),
    eq(schema.pushDeliveries.attempts, receipt.attempts),
    eq(schema.pushDeliveries.state, 'pending'),
  );
  const finish = async (state: 'accepted' | 'cancelled' | 'failed', code: string | null = null) => {
    const updated = await db
      .update(schema.pushDeliveries)
      .set({ state, lastError: code, completedAt: new Date(), leaseUntil: null })
      .where(ownsAttempt)
      .returning({ id: schema.pushDeliveries.id });
    return updated.length > 0;
  };
  if (receipt.expiresAt.getTime() <= Date.now()) {
    await finish('cancelled', 'expired');
    return;
  }
  try {
    const context = await pushNotificationContext(receipt.notificationId);
    if (!context) {
      await finish('cancelled', 'no_longer_allowed');
      return;
    }
    const table =
      receipt.destinationKind === 'apns' ? schema.pushDevices : schema.pushSubscriptions;
    const [device] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, receipt.destinationId),
          eq(table.generation, receipt.generation),
          eq(table.userId, context.row.userId),
        ),
      );
    if (!device?.sessionId || device.disabledAt) {
      await finish('cancelled', 'device_changed');
      return;
    }
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, device.sessionId),
          eq(schema.sessions.userId, context.row.userId),
          gt(schema.sessions.expiresAt, new Date()),
        ),
      );
    if (!session) {
      await finish('cancelled', 'session_expired');
      return;
    }
    const outcome =
      'token' in device
        ? await sendApns(device, context.payload, receipt.expiresAt)
        : await sendWebPush(device, context.payload, receipt.expiresAt);
    if (outcome.state === 'accepted') {
      if (!(await finish('accepted'))) return;
      await db
        .update(table)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(table.id, device.id), eq(table.generation, receipt.generation)));
      await db
        .update(schema.notifications)
        .set({ pushedAt: new Date() })
        .where(eq(schema.notifications.id, receipt.notificationId));
    } else if (outcome.state === 'invalid') {
      if (!(await finish('cancelled', outcome.code))) return;
      if (!outcome.invalidBefore || outcome.invalidBefore >= device.registeredAt.getTime())
        await db
          .delete(table)
          .where(and(eq(table.id, device.id), eq(table.generation, receipt.generation)));
    } else {
      if (job.attempts >= 8) {
        await finish('failed', outcome.code);
        return;
      }
      await db
        .update(schema.pushDeliveries)
        .set({ lastError: outcome.code, leaseUntil: null })
        .where(ownsAttempt);
      throw Object.assign(new Error(outcome.code), { retryAfterMs: outcome.retryAfterMs });
    }
  } catch (error) {
    await db
      .update(schema.pushDeliveries)
      .set({
        leaseUntil: null,
        ...(job.attempts >= 8
          ? { state: 'failed' as const, lastError: 'delivery_error', completedAt: new Date() }
          : {}),
      })
      .where(ownsAttempt);
    throw error;
  }
});

export async function purgePushDeliveries(): Promise<void> {
  await getDb().execute(
    sql`WITH picked AS (SELECT d.id FROM push_deliveries d WHERE d.expires_at<now()-interval '30 days' AND (d.lease_until IS NULL OR d.lease_until<now()) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.kind='push' AND o.payload->>'deliveryId'=d.id::text) ORDER BY d.expires_at,d.id LIMIT 500) DELETE FROM push_deliveries d USING picked WHERE d.id=picked.id`,
  );
  await getDb().execute(
    sql`WITH picked AS (SELECT id FROM push_subscriptions WHERE session_id IS NULL AND registered_at<now()-interval '30 days' LIMIT 500) DELETE FROM push_subscriptions s USING picked WHERE s.id=picked.id`,
  );
}

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BlipReminderDto, SetReminderInput } from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { badRequest, notFound, type Actor } from '../http.js';
import { assertHumanDecision, readableRadarQuery, requireRadar } from './access.js';
import { enqueueNotificationEvent } from './notifications.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Caller already holds the blip lock. Scheduling follows effective state. */
export async function syncBlipReminders(tx: Tx, blipId: string): Promise<void> {
  await tx.execute(sql`UPDATE blip_reminders r SET
    revision=b.due_revision, triggered_at=NULL, queued_at=NULL,
    reminder_at=CASE WHEN r.enabled AND b.state NOT IN ('done','dropped') AND NOT d.archived AND b.due_at IS NOT NULL
      AND b.due_at-make_interval(mins=>r.lead_minutes)>now()
      THEN b.due_at-make_interval(mins=>r.lead_minutes) ELSE NULL END
    FROM blips b JOIN radars d ON d.id=b.radar_id WHERE r.blip_id=b.id AND b.id=${blipId}::uuid`);
}
function dto(
  row: typeof schema.blipReminders.$inferSelect,
  blip: typeof schema.blips.$inferSelect,
  archived: boolean,
): BlipReminderDto {
  if (!blip.dueAt)
    return {
      leadMinutes: row.leadMinutes,
      reminderAt: null,
      status: 'paused',
      reason: 'no_due_date',
    };
  const at = new Date(blip.dueAt.getTime() - row.leadMinutes * 60_000);
  if (['done', 'dropped'].includes(blip.state))
    return {
      leadMinutes: row.leadMinutes,
      reminderAt: at.toISOString(),
      status: 'paused',
      reason: 'completed',
    };
  if (archived)
    return {
      leadMinutes: row.leadMinutes,
      reminderAt: at.toISOString(),
      status: 'paused',
      reason: 'radar_archived',
    };
  if (row.triggeredAt && row.revision === blip.dueRevision)
    return {
      leadMinutes: row.leadMinutes,
      reminderAt: at.toISOString(),
      status: 'triggered',
      reason: null,
    };
  if (!row.reminderAt || at.getTime() <= Date.now())
    return {
      leadMinutes: row.leadMinutes,
      reminderAt: at.toISOString(),
      status: 'expired',
      reason: 'past_time',
    };
  return {
    leadMinutes: row.leadMinutes,
    reminderAt: at.toISOString(),
    status: 'scheduled',
    reason: null,
  };
}
export async function remindersFor(
  blips: Array<typeof schema.blips.$inferSelect>,
  userId: string | null,
): Promise<Map<string, BlipReminderDto>> {
  if (!userId || !blips.length) return new Map();
  const rows = await getDb()
    .select({ reminder: schema.blipReminders, archived: schema.radars.archived })
    .from(schema.blipReminders)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.blipReminders.blipId))
    .innerJoin(schema.radars, eq(schema.radars.id, schema.blips.radarId))
    .where(
      and(
        eq(schema.blipReminders.userId, userId),
        eq(schema.blipReminders.enabled, true),
        inArray(
          schema.blipReminders.blipId,
          blips.map((b) => b.id),
        ),
      ),
    );
  const byId = new Map(blips.map((b) => [b.id, b]));
  return new Map(
    rows.flatMap((r) => {
      const blip = byId.get(r.reminder.blipId);
      return blip ? [[r.reminder.blipId, dto(r.reminder, blip, r.archived)] as const] : [];
    }),
  );
}
export async function getReminder(actor: Actor, blipId: string): Promise<BlipReminderDto | null> {
  const [blip] = await getDb().select().from(schema.blips).where(eq(schema.blips.id, blipId));
  if (!blip) throw notFound('Blip not found');
  await requireRadar(blip.radarId, actor, 'read');
  return (await remindersFor([blip], actor.user.id)).get(blip.id) ?? null;
}
export async function setReminder(
  actor: Actor,
  blipId: string,
  input: SetReminderInput | null,
): Promise<BlipReminderDto | null> {
  assertHumanDecision(
    actor,
    'A personal reminder controls your attention. Set it yourself in the blip’s reminder controls.',
  );
  if (!actor.sessionId) throw badRequest('A signed-in session is required to manage reminders.');
  await getDb().transaction(async (tx) => {
    const [blip] = await tx
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .for('update');
    if (!blip) throw notFound('Blip not found');
    await requireRadar(blip.radarId, actor, 'read', tx);
    if (!input) {
      await tx
        .update(schema.blipReminders)
        .set({ enabled: false, reminderAt: null })
        .where(
          and(
            eq(schema.blipReminders.blipId, blipId),
            eq(schema.blipReminders.userId, actor.user.id),
          ),
        );
      return;
    }
    if (!blip.dueAt) throw badRequest('Set a due date before choosing a reminder.');
    const [existing] = await tx
      .select()
      .from(schema.blipReminders)
      .where(
        and(
          eq(schema.blipReminders.blipId, blipId),
          eq(schema.blipReminders.userId, actor.user.id),
        ),
      );
    if (
      existing?.enabled &&
      existing.revision === blip.dueRevision &&
      existing.leadMinutes === input.leadMinutes
    )
      return;
    if ((existing?.triggeredAt || existing?.queuedAt) && existing.revision === blip.dueRevision) {
      if (!existing.enabled || existing.leadMinutes !== input.leadMinutes)
        throw badRequest(
          'This due date has already triggered its reminder. Change the due date to schedule another.',
        );
      return;
    }
    await tx
      .insert(schema.blipReminders)
      .values({
        blipId,
        userId: actor.user.id,
        leadMinutes: input.leadMinutes,
        revision: blip.dueRevision,
      })
      .onConflictDoUpdate({
        target: [schema.blipReminders.blipId, schema.blipReminders.userId],
        set: {
          enabled: true,
          leadMinutes: input.leadMinutes,
          revision: blip.dueRevision,
          triggeredAt: null,
          queuedAt: null,
        },
      });
    // Re-scheduling only this person must not reset another person's fired state.
    await tx.execute(
      sql`UPDATE blip_reminders SET reminder_at=CASE WHEN ${blip.state} NOT IN ('done','dropped') AND ${blip.dueAt}::timestamptz-make_interval(mins=>lead_minutes)>now() THEN ${blip.dueAt}::timestamptz-make_interval(mins=>lead_minutes) ELSE NULL END WHERE blip_id=${blip.id}::uuid AND user_id=${actor.user.id}::uuid`,
    );
  });
  return input ? getReminder(actor, blipId) : null;
}

/** Same lock order as edits: blip first, then personal reminder rows. */
export async function sweepDueReminders(): Promise<number> {
  return getDb().transaction(async (tx) => {
    const picked = await tx.execute<{ id: string }>(
      sql`SELECT b.id FROM blips b WHERE b.id IN (SELECT r.blip_id FROM blip_reminders r WHERE r.enabled AND r.queued_at IS NULL AND r.reminder_at<=now() ORDER BY r.reminder_at LIMIT 200) ORDER BY b.id LIMIT 50 FOR UPDATE OF b SKIP LOCKED`,
    );
    let count = 0;
    for (const { id } of picked.rows) {
      const [blip] = await tx.select().from(schema.blips).where(eq(schema.blips.id, id));
      // Locked by the SELECT above, and radar_id is a foreign key; skipped
      // rather than asserted, so one inconsistent row cannot stop the sweep.
      if (!blip) continue;
      const [radar] = await tx
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.id, blip.radarId));
      if (!radar) continue;
      const reminders = await tx
        .select()
        .from(schema.blipReminders)
        .where(
          and(
            eq(schema.blipReminders.blipId, id),
            sql`${schema.blipReminders.queuedAt} IS NULL AND ${schema.blipReminders.reminderAt}<=now()`,
          ),
        )
        .for('update');
      for (const reminder of reminders) {
        const [user] = await tx
          .select()
          .from(schema.users)
          .where(and(eq(schema.users.id, reminder.userId), eq(schema.users.state, 'active')));
        const readable = await tx
          .select({ id: schema.radars.id })
          .from(schema.radars)
          .where(
            and(
              eq(schema.radars.id, radar.id),
              inArray(schema.radars.id, readableRadarQuery(reminder.userId)),
            ),
          );
        const key = and(
          eq(schema.blipReminders.blipId, id),
          eq(schema.blipReminders.userId, reminder.userId),
        );
        if (!user || !readable.length) {
          await tx.delete(schema.blipReminders).where(key);
          continue;
        }
        if (
          radar.archived ||
          ['done', 'dropped'].includes(blip.state) ||
          reminder.revision !== blip.dueRevision ||
          !blip.dueAt
        ) {
          await tx.update(schema.blipReminders).set({ reminderAt: null }).where(key);
          continue;
        }
        // Selected by reminder_at <= now(), so never null here; the type cannot
        // say so. A null is treated like a stale reminder: cleared, not sent.
        const reminderAt = reminder.reminderAt;
        if (!reminderAt || Date.now() - reminderAt.getTime() > 3_600_000) {
          await tx.update(schema.blipReminders).set({ reminderAt: null }).where(key);
          continue;
        }
        await tx.update(schema.blipReminders).set({ queuedAt: new Date() }).where(key);
        await enqueueNotificationEvent(tx, {
          type: 'due',
          actor: { kind: 'user', user },
          radarId: radar.id,
          blipId: id,
          recipientId: user.id,
          revision: reminder.revision,
          reminderAt: reminderAt.toISOString(),
        });
        count++;
      }
    }
    return count;
  });
}

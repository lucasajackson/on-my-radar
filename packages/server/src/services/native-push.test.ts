import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { loadEnv, setEnvForTesting } from '../env.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import type * as Apns from './apns.js';
vi.mock('./apns.js', async (original) => ({
  ...(await original<typeof Apns>()),
  sendApns: vi.fn(),
}));
import { sendApns } from './apns.js';
import {
  registerNativePush,
  registerBrowserPush,
  pushDeviceSettings,
  removePushDevice,
} from './push-devices.js';
import { createRadar, updateRadar } from './radars.js';
import { createBlip, getBlip, updateBlip } from './blips.js';
import { createSession, revokeSession } from '../auth/session.js';
import { createApp } from '../app.js';
import { getReminder, setReminder, sweepDueReminders } from './reminders.js';
import { getSettings, listNotifications, updateSettings } from './notifications.js';
import { queuePushDeliveries, purgePushDeliveries } from './push-delivery.js';
import { drainOne, enqueue } from './outbox.js';
import { must } from '../errors.js';

describe.skipIf(!process.env['DATABASE_URL'])(
  'native push and reminders (isolated PostgreSQL)',
  () => {
    const database = `omr_native_push_${randomUUID().replaceAll('-', '')}`;
    let admin: pg.Pool;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(must(process.env['DATABASE_URL']));
      url.pathname = `/${database}`;
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: url.toString(),
          SESSION_SECRET: 'native-test-only-session-secret-not-production',
          APNS_TEAM_ID: '6BUHQ4F5AN',
          APNS_PRODUCTION_KEY_ID: 'ABCDEFGHIJ',
          APNS_PRODUCTION_PRIVATE_KEY: 'test-only-key',
          RESEND_API_KEY: undefined,
        }),
      );
      await runMigrations();
      await runMigrations();
    }, 30_000);
    afterAll(async () => {
      await closeDb();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    });
    beforeEach(() => vi.mocked(sendApns).mockReset().mockResolvedValue({ state: 'accepted' }));
    async function fixture(client: 'ios' | 'web' = 'ios') {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${randomUUID()}@example.test`, state: 'active' })
        .returning();
      const session = await createSession(must(user), { client });
      const [stored] = await getDb()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, must(user).id));
      const actor: Actor = { kind: 'user', user: must(user), sessionId: must(stored).id };
      const radar = await createRadar(actor, { name: `Push ${randomUUID()}` });
      const input = {
        platform: 'apns' as const,
        environment: 'production' as const,
        token: randomUUID().replaceAll('-', '').repeat(2),
        installationId: randomUUID(),
      };
      return { actor, radar, input, session };
    }
    async function notification(f: Awaited<ReturnType<typeof fixture>>) {
      const [n] = await getDb()
        .insert(schema.notifications)
        .values({
          userId: f.actor.user.id,
          kind: 'share',
          radarId: f.radar.id,
          groupKey: `test:${randomUUID()}`,
          subject: 'Shared radar',
        })
        .returning();
      return must(n);
    }
    async function runPushJobs(notificationId: string) {
      const jobs = await getDb().execute<{ id: string }>(
        sql`SELECT o.id FROM outbox o JOIN push_deliveries d ON d.id::text=o.payload->>'deliveryId' WHERE o.kind='push' AND d.notification_id=${notificationId}::uuid`,
      );
      for (const job of jobs.rows) {
        await getDb()
          .update(schema.outbox)
          .set({ runAfter: new Date(0) })
          .where(eq(schema.outbox.id, job.id));
        await drainOne(job.id);
      }
    }
    it('registers through real native HTTP, is idempotent, rejects agents and cascades session revocation', async () => {
      const f = await fixture();
      const app = createApp();
      const response = await app.request('/api/v1/notifications/push', {
        method: 'POST',
        headers: { authorization: `Bearer ${f.session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(f.input),
      });
      expect(response.status).toBe(201);
      const first = (await response.json()) as { id: string };
      expect(await registerNativePush(f.actor, f.input)).toEqual(first);
      await expect(registerNativePush({ ...f.actor, kind: 'agent' }, f.input)).rejects.toThrow();
      await revokeSession(must(f.actor.sessionId));
      expect(
        await getDb().select().from(schema.pushDevices).where(eq(schema.pushDevices.id, first.id)),
      ).toHaveLength(0);
    });
    it('requires explicit enable for cross-account browser rebind and reports server binding', async () => {
      const f = await fixture('web');
      const other = await fixture('web');
      const input = {
        endpoint: `https://push.example.test/${randomUUID()}`,
        keys: { p256dh: 'test', auth: 'test' },
      };
      const original = await registerBrowserPush(f.actor, input);
      await expect(
        registerBrowserPush(other.actor, { ...input, rebindExisting: true }),
      ).rejects.toThrow(/explicitly/);
      expect((await pushDeviceSettings(f.actor, undefined, original.id)).browserBinding).toBe(
        'active',
      );
      await registerBrowserPush(other.actor, input);
      expect((await pushDeviceSettings(f.actor, undefined, original.id)).browserBinding).toBe(
        'not_registered',
      );
    });
    it('keeps remote Disconnect disabled across automatic token refresh until explicit Enable', async () => {
      const f = await fixture();
      const device = await registerNativePush(f.actor, f.input);
      await removePushDevice(f.actor, device.id);
      await expect(registerNativePush(f.actor, f.input)).rejects.toMatchObject({
        status: 409,
        code: 'push_device_disabled',
      });
      await expect(
        registerNativePush(f.actor, { ...f.input, token: 'f'.repeat(64) }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await pushDeviceSettings(f.actor)).devices[0]).toMatchObject({ disabled: true });
      await registerNativePush(f.actor, { ...f.input, activate: true });
      expect((await pushDeviceSettings(f.actor)).devices[0]).toMatchObject({ disabled: false });
      const web = await fixture('web');
      const input = {
        endpoint: `https://push.test/${randomUUID()}`,
        keys: { auth: 'a', p256dh: 'b' },
      };
      const browser = await registerBrowserPush(web.actor, input);
      await removePushDevice(web.actor, browser.id);
      await expect(
        registerBrowserPush(web.actor, { ...input, rebindExisting: true }),
      ).rejects.toMatchObject({ status: 409 });
      await registerBrowserPush(web.actor, input);
      expect((await pushDeviceSettings(web.actor, undefined, browser.id)).browserBinding).toBe(
        'active',
      );
    });
    it('preserves device identity across token rotation and fences a concurrent remote Disconnect', async () => {
      const f = await fixture();
      const device = await registerNativePush(f.actor, f.input);
      const rotated = {
        ...f.input,
        token: 'B'.repeat(64),
        installationId: f.input.installationId.toUpperCase(),
      };
      expect(await registerNativePush(f.actor, rotated)).toEqual(device);
      await Promise.allSettled([
        registerNativePush(f.actor, { ...rotated, token: 'c'.repeat(64) }),
        removePushDevice(f.actor, device.id),
      ]);
      const [row] = await getDb()
        .select()
        .from(schema.pushDevices)
        .where(eq(schema.pushDevices.id, device.id));
      expect(row?.disabledAt).not.toBeNull();
      await expect(registerNativePush(f.actor, rotated)).rejects.toMatchObject({ status: 409 });
      expect(
        (await pushDeviceSettings(f.actor, undefined, randomUUID())).devices.every(
          (d) => !d.current,
        ),
      ).toBe(true);
    });
    it('bounds authenticated registration churn without losing a valid device', async () => {
      const f = await fixture();
      const first = await registerNativePush(f.actor, f.input);
      await getDb()
        .update(schema.sessions)
        .set({ pushRegistrationCount: 120 })
        .where(eq(schema.sessions.id, must(f.actor.sessionId)));
      await expect(registerNativePush(f.actor, f.input)).rejects.toMatchObject({ status: 429 });
      expect((await pushDeviceSettings(f.actor)).devices[0]?.id).toBe(first.id);
    });
    it('retries only failed devices and retains valid tokens during provider outages', async () => {
      const f = await fixture();
      await registerNativePush(f.actor, f.input);
      await registerNativePush(f.actor, {
        ...f.input,
        token: 'a'.repeat(64),
        installationId: randomUUID(),
      });
      const n = await notification(f);
      await queuePushDeliveries(n);
      vi.mocked(sendApns)
        .mockResolvedValueOnce({ state: 'accepted' })
        .mockResolvedValueOnce({ state: 'retry', code: 'ServiceUnavailable' });
      await runPushJobs(n.id);
      expect(vi.mocked(sendApns)).toHaveBeenCalledTimes(2);
      await runPushJobs(n.id);
      expect(vi.mocked(sendApns)).toHaveBeenCalledTimes(3);
      expect(
        await getDb()
          .select()
          .from(schema.pushDevices)
          .where(eq(schema.pushDevices.userId, f.actor.user.id)),
      ).toHaveLength(2);
      expect(
        (
          await getDb()
            .select()
            .from(schema.pushDeliveries)
            .where(eq(schema.pushDeliveries.notificationId, n.id))
        ).every((r) => r.state === 'accepted'),
      ).toBe(true);
    });
    it('rechecks preferences and access before delayed delivery without leaking payloads', async () => {
      const f = await fixture();
      await registerNativePush(f.actor, f.input);
      const n = await notification(f);
      await queuePushDeliveries(n);
      await updateSettings(f.actor, { pushEnabled: false });
      await runPushJobs(n.id);
      expect(sendApns).not.toHaveBeenCalled();
      await updateSettings(f.actor, { pushEnabled: true, previewEnabled: false });
      const second = await notification(f);
      await queuePushDeliveries(second);
      await runPushJobs(second.id);
      expect(vi.mocked(sendApns).mock.calls[0]?.[1]).toMatchObject({
        title: 'On My Radar',
        body: 'You have new activity.',
        recipientUserId: f.actor.user.id,
      });
    });
    it('queues no device receipts for a kind whose push is switched off', async () => {
      const f = await fixture();
      await registerNativePush(f.actor, f.input);
      await updateSettings(f.actor, { kindPreferences: { share: { push: false } } });
      const n = await notification(f);
      await drainOne(await enqueue(getDb(), 'notification', { notificationId: n.id }));
      expect(
        await getDb()
          .select()
          .from(schema.pushDeliveries)
          .where(eq(schema.pushDeliveries.notificationId, n.id)),
      ).toHaveLength(0);
      expect(sendApns).not.toHaveBeenCalled();
    });
    it('merges sparse kind/channel preferences without resetting other choices', async () => {
      const f = await fixture();
      await updateSettings(f.actor, {
        kindPreferences: { mention: { push: false, email: false }, comment: { email: false } },
      });
      await updateSettings(f.actor, { kindPreferences: { mention: { email: true } } });
      expect((await getSettings(f.actor)).kindPreferences).toMatchObject({
        mention: { push: false, email: true },
        comment: { push: true, email: false },
        email_received: { push: true, email: false },
        due: { push: true, email: false },
      });
    });
    it('reschedules subscribed reminders on due edits and cancels on completion/supersession', async () => {
      const f = await fixture();
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      const blip = await createBlip(f.actor, f.radar.id, { body: 'due', dueAt });
      await setReminder(f.actor, blip.id, { leadMinutes: 60 });
      expect(await getReminder(f.actor, blip.id)).toMatchObject({
        status: 'scheduled',
        reminderAt: new Date(Date.parse(dueAt) - 3_600_000).toISOString(),
      });
      const next = new Date(Date.parse(dueAt) + 86_400_000).toISOString();
      await updateBlip(f.actor, blip.id, { dueAt: next });
      expect((await getReminder(f.actor, blip.id))?.reminderAt).toBe(
        new Date(Date.parse(next) - 3_600_000).toISOString(),
      );
      await updateBlip(f.actor, blip.id, { state: 'done' });
      expect(await getReminder(f.actor, blip.id)).toMatchObject({
        status: 'paused',
        reason: 'completed',
      });
      await updateBlip(f.actor, blip.id, { state: 'active' });
      expect((await getReminder(f.actor, blip.id))?.status).toBe('scheduled');
      await expect(
        setReminder({ ...f.actor, kind: 'agent' }, blip.id, { leadMinutes: 0 }),
      ).rejects.toThrow();
      expect((await getBlip(blip.id, f.actor)).dueAt).toBe(next);
    });
    it('competing sweeps create one logical reminder and past expiry is not marked triggered', async () => {
      const f = await fixture();
      const blip = await createBlip(f.actor, f.radar.id, {
        body: 'Reminder',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await setReminder(f.actor, blip.id, { leadMinutes: 0 });
      await getDb()
        .update(schema.blipReminders)
        .set({ reminderAt: new Date(Date.now() - 1000) })
        .where(eq(schema.blipReminders.blipId, blip.id));
      await Promise.all([sweepDueReminders(), sweepDueReminders()]);
      const jobs = await getDb()
        .select()
        .from(schema.outbox)
        .where(
          sql`kind='notification-event' AND payload->>'type'='due' AND payload->>'blipId'=${blip.id}`,
        );
      expect(jobs).toHaveLength(1);
      await drainOne(must(jobs[0]).id);
      expect((await listNotifications(f.actor)).items.filter((n) => n.kind === 'due')).toHaveLength(
        1,
      );
      await setReminder(f.actor, blip.id, { leadMinutes: 0 });
      expect((await getReminder(f.actor, blip.id))?.status).toBe('triggered');
      await expect(setReminder(f.actor, blip.id, { leadMinutes: 60 })).rejects.toThrow(
        /already triggered/,
      );
      await setReminder(f.actor, blip.id, null);
      expect(await getReminder(f.actor, blip.id)).toBeNull();
      await expect(setReminder(f.actor, blip.id, { leadMinutes: 0 })).rejects.toThrow(
        /already triggered/,
      );
      const old = await createBlip(f.actor, f.radar.id, {
        body: 'Expired',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await setReminder(f.actor, old.id, { leadMinutes: 0 });
      await getDb()
        .update(schema.blipReminders)
        .set({ reminderAt: new Date(Date.now() - 7_200_000) })
        .where(eq(schema.blipReminders.blipId, old.id));
      await sweepDueReminders();
      expect((await getReminder(f.actor, old.id))?.status).toBe('expired');
    });
    it('keeps accepted receipts while old jobs exist, then retires without recreating work', async () => {
      const f = await fixture();
      await registerNativePush(f.actor, f.input);
      const n = await notification(f);
      await queuePushDeliveries(n);
      await getDb()
        .update(schema.pushDeliveries)
        .set({ state: 'accepted', expiresAt: new Date(Date.now() - 32 * 86_400_000) })
        .where(eq(schema.pushDeliveries.notificationId, n.id));
      await purgePushDeliveries();
      expect(
        await getDb()
          .select()
          .from(schema.pushDeliveries)
          .where(eq(schema.pushDeliveries.notificationId, n.id)),
      ).toHaveLength(1);
      await runPushJobs(n.id);
      await purgePushDeliveries();
      expect(
        await getDb()
          .select()
          .from(schema.pushDeliveries)
          .where(eq(schema.pushDeliveries.notificationId, n.id)),
      ).toHaveLength(0);
      expect(sendApns).not.toHaveBeenCalled();
    });
    it('does not invalidate a replacement registration after an older in-flight failure', async () => {
      const f = await fixture();
      const first = await registerNativePush(f.actor, f.input);
      const n = await notification(f);
      await queuePushDeliveries(n);
      let replacement = '';
      vi.mocked(sendApns).mockImplementationOnce(async () => {
        replacement = (
          await registerNativePush(f.actor, {
            ...f.input,
            token: randomUUID().replaceAll('-', '').repeat(2),
          })
        ).id;
        return { state: 'invalid', code: 'Unregistered' };
      });
      await runPushJobs(n.id);
      expect(replacement).toBe(first.id);
      expect(
        await getDb()
          .select()
          .from(schema.pushDevices)
          .where(eq(schema.pushDevices.id, replacement)),
      ).toHaveLength(1);
    });
    it('a stale delivery attempt cannot finish another attempt or delete its outbox job', async () => {
      const f = await fixture();
      await registerNativePush(f.actor, f.input);
      const n = await notification(f);
      await queuePushDeliveries(n);
      const [receipt] = await getDb()
        .select()
        .from(schema.pushDeliveries)
        .where(eq(schema.pushDeliveries.notificationId, n.id));
      vi.mocked(sendApns).mockImplementationOnce(async () => {
        await getDb()
          .update(schema.pushDeliveries)
          .set({ attempts: sql`attempts+1`, leaseUntil: new Date(Date.now() + 30_000) })
          .where(eq(schema.pushDeliveries.id, must(receipt).id));
        await getDb().execute(
          sql`UPDATE outbox SET attempts=attempts+1 WHERE kind='push' AND payload->>'deliveryId'=${must(receipt).id}`,
        );
        return { state: 'accepted' };
      });
      await runPushJobs(n.id);
      const [after] = await getDb()
        .select()
        .from(schema.pushDeliveries)
        .where(eq(schema.pushDeliveries.id, must(receipt).id));
      expect(after).toMatchObject({ state: 'pending', attempts: 2 });
      expect(after?.leaseUntil).not.toBeNull();
      expect(
        (
          await getDb().select().from(schema.notifications).where(eq(schema.notifications.id, n.id))
        )[0]?.pushedAt,
      ).toBeNull();
      expect(
        (
          await getDb().execute(
            sql`SELECT id FROM outbox WHERE kind='push' AND payload->>'deliveryId'=${must(receipt).id}`,
          )
        ).rows,
      ).toHaveLength(1);
    });
    it('checks live access again after the delivery was queued', async () => {
      const owner = await fixture();
      const reader = await fixture();
      await getDb()
        .insert(schema.radarMembers)
        .values({ radarId: owner.radar.id, userId: reader.actor.user.id, role: 'viewer' });
      await registerNativePush(reader.actor, reader.input);
      const [n] = await getDb()
        .insert(schema.notifications)
        .values({
          userId: reader.actor.user.id,
          kind: 'share',
          radarId: owner.radar.id,
          groupKey: randomUUID(),
        })
        .returning();
      await queuePushDeliveries(must(n));
      await getDb()
        .delete(schema.radarMembers)
        .where(eq(schema.radarMembers.radarId, owner.radar.id));
      await runPushJobs(must(n).id);
      expect(sendApns).not.toHaveBeenCalled();
    });
    it('preserves paused consent on archive and reschedules on restore, with supersession cancelling the predecessor', async () => {
      const f = await fixture();
      const radar = await createRadar(f.actor, {
        name: 'Decision reminder',
        template: 'decisions',
      });
      const blip = await createBlip(f.actor, radar.id, {
        body: 'Original',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await setReminder(f.actor, blip.id, { leadMinutes: 0 });
      await updateRadar(f.actor, radar.id, { archived: true });
      expect((await getReminder(f.actor, blip.id))?.reason).toBe('radar_archived');
      await updateRadar(f.actor, radar.id, { archived: false });
      expect((await getReminder(f.actor, blip.id))?.status).toBe('scheduled');
      await createBlip(f.actor, radar.id, { body: 'Replacement', supersedes: blip.id });
      expect((await getReminder(f.actor, blip.id))?.reason).toBe('completed');
    });
    it('enforces reminder read scope and human-only mutations over HTTP', async () => {
      const f = await fixture();
      const stranger = await fixture();
      const app = createApp();
      const b = await createBlip(f.actor, f.radar.id, {
        body: 'Private due',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const response = await app.request(`/api/v1/blips/${b.id}/reminder`, {
        headers: { authorization: `Bearer ${stranger.session.token}` },
      });
      expect(response.status).toBe(404);
      const saved = await app.request(`/api/v1/blips/${b.id}/reminder`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${f.session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ leadMinutes: 0 }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        reminder: { leadMinutes: 0, status: 'scheduled' },
      });
      const removed = await app.request(`/api/v1/blips/${b.id}/reminder`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${f.session.token}` },
      });
      expect(removed.status).toBe(204);
      expect(await getReminder(f.actor, b.id)).toBeNull();
    });
  },
);

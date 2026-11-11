import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool, closeDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { env, loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import type * as StorageModule from './storage.js';
import { createApp } from '../app.js';
import { createRadar, ensureDropBox } from './radars.js';
import { listNotifications } from './notifications.js';
import { drainDue } from './outbox.js';
import {
  recordEmailAuthenticationFailure,
  cleanupDeletedRadarEmailUploads,
  authorizeEmailDelivery,
  claimEmailCaptureIdentity,
  cleanupEmailReceipts,
  finalizeEmailDelivery,
  getRadarEmailCapture,
  updateRadarEmailCapture,
} from './inbound-email.js';

vi.mock('./storage.js', async (original) => ({
  ...(await original<typeof StorageModule>()),
  headObject: vi.fn(),
}));
import { headObject } from './storage.js';
import { must } from '../errors.js';
const secret = 'email-test-secret-not-for-any-production-use';
describe.skipIf(!process.env['DATABASE_URL'])('email capture (isolated postgres)', () => {
  const database = `omr_email_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let owner: Actor;
  let radarId: string;
  let recipient: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: secret,
        EMAIL_INGEST_SECRET: secret,
        EMAIL_CAPTURE_DOMAIN: 'onmyradar.io',
        EMAIL_CAPTURE_ENABLED: 'true',
      }),
    );
    await runMigrations();
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: 'owner@example.test', state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    radarId = (await createRadar(owner, { name: 'Reading list' })).id;
    await claimEmailCaptureIdentity(owner, 'reader');
    recipient = must(
      (await updateRadarEmailCapture(owner, radarId, { enabled: true, allowedSenders: [] }))
        .address,
    );
  });
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });
  const delivery = () => ({
    id: randomUUID().replaceAll('-', '').repeat(2),
    recipient,
    sender: 'owner@example.test',
    body: 'Captured by email',
    files: [],
  });
  it('atomically creates and enables the default inbox on first username claim', async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: 'new-inbox@example.test', state: 'active' })
      .returning();
    const actor: Actor = { user: must(user), kind: 'user' };
    // A pre-existing ordinary radar may already occupy the desired inbox slug.
    await createRadar(actor, { name: 'Drop Box' });
    await Promise.all([
      claimEmailCaptureIdentity(actor, 'newinbox'),
      claimEmailCaptureIdentity(actor, 'newinbox'),
    ]);
    const boxes = await getDb()
      .select()
      .from(schema.radars)
      .where(eq(schema.radars.ownerId, must(user).id));
    const dropBox = must(boxes.find((radar) => radar.isDropBox));
    expect(boxes.filter((radar) => radar.isDropBox)).toHaveLength(1);
    expect(dropBox.slug).toBe('drop-box-2');
    expect(await getRadarEmailCapture(actor, dropBox.id)).toMatchObject({
      enabled: true,
      address: 'newinbox@onmyradar.io',
      allowedSenders: ['new-inbox@example.test'],
    });
    await updateRadarEmailCapture(actor, dropBox.id, { enabled: false, allowedSenders: [] });
    await claimEmailCaptureIdentity(actor, 'newinbox');
    expect((await getRadarEmailCapture(actor, dropBox.id)).enabled).toBe(false);
  });
  it('repairs legacy missing inbox sources without re-enabling explicit opt-outs', async () => {
    const [missing, disabled] = await getDb()
      .insert(schema.users)
      .values([
        { email: 'legacy-missing@example.test', state: 'active' },
        { email: 'legacy-disabled@example.test', state: 'active' },
      ])
      .returning();
    const missingActor: Actor = { user: must(missing), kind: 'user' };
    const disabledActor: Actor = { user: must(disabled), kind: 'user' };
    // Simulate pre-fix identities without using the now-atomic claim service.
    await getDb()
      .insert(schema.emailCaptureIdentities)
      .values([
        { userId: must(missing).id, username: 'legacy-missing' },
        { userId: must(disabled).id, username: 'legacy-disabled' },
      ]);
    await createRadar(missingActor, { name: 'Drop Box' });
    const disabledBox = await ensureDropBox(disabledActor);
    await updateRadarEmailCapture(disabledActor, disabledBox.id, {
      enabled: false,
      allowedSenders: ['friend@example.test'],
    });
    const migration = await readFile(
      new URL('../../drizzle/0024_initialize_email_drop_boxes.sql', import.meta.url),
      'utf8',
    );
    await getPool().query(migration);
    await getPool().query(migration);
    const repairedBox = await ensureDropBox(missingActor);
    expect(repairedBox.slug).toBe('drop-box-2');
    expect(await getRadarEmailCapture(missingActor, repairedBox.id)).toMatchObject({
      enabled: true,
      allowedSenders: ['legacy-missing@example.test'],
    });
    expect(await getRadarEmailCapture(disabledActor, disabledBox.id)).toMatchObject({
      enabled: false,
      allowedSenders: ['legacy-disabled@example.test', 'friend@example.test'],
    });
  });
  it('maps bounded authentication reasons to helpful source diagnostics', async () => {
    await recordEmailAuthenticationFailure(recipient, 'dkim_domain_mismatch');
    expect((await getRadarEmailCapture(owner, radarId)).lastError).toContain(
      'signature does not match',
    );
    await recordEmailAuthenticationFailure(recipient, 'dkim_unsigned_headers');
    expect((await getRadarEmailCapture(owner, radarId)).lastError).toContain(
      'include sender and formatting headers',
    );
  });
  it('issues readable stable addresses and exact default sender settings', async () => {
    expect(recipient).toBe('reader+reading-list@onmyradar.io');
    expect((await getRadarEmailCapture(owner, radarId)).allowedSenders).toEqual([
      'owner@example.test',
    ]);
    await expect(
      updateRadarEmailCapture(owner, radarId, { enabled: true, allowedSenders: ['*@example.com'] }),
    ).rejects.toThrow();
    await expect(claimEmailCaptureIdentity(owner, 'another')).rejects.toThrow(/permanent/);
    await expect(
      claimEmailCaptureIdentity({ ...owner, kind: 'agent' }, 'reader'),
    ).rejects.toThrow();
  });
  it('captures a concurrent retry exactly once', async () => {
    const input = delivery();
    await authorizeEmailDelivery(input);
    await Promise.all(Array.from({ length: 8 }, () => finalizeEmailDelivery(input.id)));
    const [receipt] = await getDb()
      .select()
      .from(schema.emailCaptureReceipts)
      .where(eq(schema.emailCaptureReceipts.id, input.id));
    expect(receipt?.blipId).toBeTruthy();
    expect(receipt?.body).toBe('');
    const blips = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.radarId, radarId));
    expect(blips).toHaveLength(1);
    // Email capture defers delivery so provider latency cannot hold SMTP open.
    await drainDue(10);
    expect((await listNotifications(owner)).items).toMatchObject([
      { kind: 'email_received', radar: { id: radarId }, blipId: must(receipt).blipId, count: 1 },
    ]);
  });
  it('rejects unlisted senders and another username without issuing storage keys', async () => {
    await expect(
      authorizeEmailDelivery({ ...delivery(), sender: 'stranger@example.test' }),
    ).rejects.toThrow(/not approved/);
    await expect(
      authorizeEmailDelivery({ ...delivery(), recipient: 'other+reading-list@onmyradar.io' }),
    ).rejects.toThrow(/unavailable/);
  });
  it('rechecks disabled settings at finalize', async () => {
    const input = delivery();
    await authorizeEmailDelivery(input);
    await updateRadarEmailCapture(owner, radarId, { enabled: false, allowedSenders: [] });
    await expect(finalizeEmailDelivery(input.id)).rejects.toThrow(/no longer authorized/);
    await updateRadarEmailCapture(owner, radarId, { enabled: true, allowedSenders: [] });
  });
  it('rechecks sender permission after slow attachment validation', async () => {
    const input = {
      ...delivery(),
      files: [{ filename: 'slow.txt', contentType: 'text/plain', size: 10 }],
    };
    await authorizeEmailDelivery(input);
    vi.mocked(headObject).mockImplementationOnce(async () => {
      await updateRadarEmailCapture(owner, radarId, { enabled: false, allowedSenders: [] });
      return { size: 10, contentType: 'text/plain' };
    });
    await expect(finalizeEmailDelivery(input.id)).rejects.toThrow(/no longer authorized/);
    const [receipt] = await getDb()
      .select()
      .from(schema.emailCaptureReceipts)
      .where(eq(schema.emailCaptureReceipts.id, input.id));
    expect(receipt?.completedAt).toBeNull();
    await updateRadarEmailCapture(owner, radarId, { enabled: true, allowedSenders: [] });
  });
  it('rejects admin configuration of another owner and honors the global kill switch', async () => {
    const [adminUser] = await getDb()
      .insert(schema.users)
      .values({ email: 'admin@example.test', state: 'active', isAdmin: true })
      .returning();
    await expect(
      getRadarEmailCapture({ user: must(adminUser), kind: 'user' }, radarId),
    ).rejects.toThrow(/Radar not found|Only the radar owner/);
    const current = env();
    setEnvForTesting({ ...current, EMAIL_CAPTURE_ENABLED: false });
    await expect(authorizeEmailDelivery(delivery())).rejects.toThrow(/not available/);
    setEnvForTesting(current);
  });
  it('charges only unique deliveries and enforces the database rate ceiling', async () => {
    await getDb()
      .update(schema.radarEmailCapture)
      .set({ windowCount: 99, windowStartedAt: new Date() })
      .where(eq(schema.radarEmailCapture.radarId, radarId));
    const input = delivery();
    await authorizeEmailDelivery(input);
    await authorizeEmailDelivery(input);
    await expect(authorizeEmailDelivery(delivery())).rejects.toThrow(/daily email limit/);
    await getDb()
      .update(schema.radarEmailCapture)
      .set({ windowCount: 0 })
      .where(eq(schema.radarEmailCapture.radarId, radarId));
  });
  it('retires abandoned file keys through the durable cleanup queue', async () => {
    const input = delivery();
    await authorizeEmailDelivery({
      ...input,
      files: [{ filename: 'note.txt', contentType: 'text/plain', size: 10 }],
    });
    await getDb()
      .update(schema.emailCaptureReceipts)
      .set({ createdAt: new Date(Date.now() - 2 * 86400000) })
      .where(eq(schema.emailCaptureReceipts.id, input.id));
    expect(await cleanupEmailReceipts()).toBe(1);
    const jobs = await getDb()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.kind, 'object-cleanup'));
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]?.payload)).toContain(input.id);
  });
  it('exposes a fixed authentication diagnostic without trusting mail content', async () => {
    await recordEmailAuthenticationFailure(recipient);
    expect((await getRadarEmailCapture(owner, radarId)).lastError).toContain(
      'sender could not be authenticated',
    );
    await recordEmailAuthenticationFailure('unknown@onmyradar.io');
  });
  it('reports a claimed identity before allocating a new radar alias', async () => {
    const radar = await createRadar(owner, { name: 'New source' });
    const settings = await getRadarEmailCapture(owner, radar.id);
    expect(settings.identityConfigured).toBe(true);
    expect(settings.address).toBeNull();
    const enabled = await updateRadarEmailCapture(owner, radar.id, {
      enabled: true,
      allowedSenders: [],
    });
    expect(enabled.address).toBe('reader+new-source@onmyradar.io');
  });
  it('queues late upload cleanup only after its radar has disappeared', async () => {
    const radar = await createRadar(owner, { name: 'Late email upload' });
    const keys = [`radars/${radar.id}/late/proof.txt`];
    const before = await getDb()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.kind, 'object-cleanup'));
    await cleanupDeletedRadarEmailUploads(keys);
    expect(
      await getDb().select().from(schema.outbox).where(eq(schema.outbox.kind, 'object-cleanup')),
    ).toHaveLength(before.length);
    await getDb().delete(schema.radars).where(eq(schema.radars.id, radar.id));
    await cleanupDeletedRadarEmailUploads(keys);
    const after = await getDb()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.kind, 'object-cleanup'));
    expect(after).toHaveLength(before.length + 1);
    expect(after.some((job) => JSON.stringify(job.payload).includes(must(keys[0])))).toBe(true);
  });
  it('rejects obsolete JSON ingress routes', async () => {
    for (const action of ['authorize', 'finalize', 'failure']) {
      expect(
        (await createApp().request(`/hooks/email-capture/${action}`, { method: 'POST' })).status,
      ).toBe(404);
    }
  });
});

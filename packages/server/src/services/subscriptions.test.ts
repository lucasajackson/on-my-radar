import pg from 'pg';
import { loadEnv, setEnvForTesting } from '../env.js';
import type * as PublicRequestModule from './public-request.js';
import type * as SubscriptionService from './subscriptions.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { SUBSCRIPTION_EVENTS } from '@onmyradar/contract';
import {
  signSubscription,
  verifySubscription,
  encryptSubscriptionSecret,
  decryptSubscriptionSecret,
} from './subscription-signing.js';
import { publicRequest } from './public-request.js';
import type { Actor } from '../http.js';
import { must } from '../errors.js';

vi.mock('./public-request.js', async (original) => ({
  ...(await original<typeof PublicRequestModule>()),
  publicRequest: vi.fn(),
}));
// Drive the queue explicitly so retries, claims and rollback can be asserted.
vi.mock('./subscriptions.js', async (original) => ({
  ...(await original<typeof SubscriptionService>()),
  kickSubscriptionDeliveries: vi.fn(),
}));
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe('outbound signing', () => {
  it('authenticates exact bytes, rejects rotation, replay, future and malformed signatures', () => {
    const signature = signSubscription('a-secret', '{"a":1}', 1000);
    expect(verifySubscription('a-secret', '{"a":1}', signature, 1000)).toBe(true);
    expect(verifySubscription('a-secret', '{ "a":1}', signature, 1000)).toBe(false);
    expect(verifySubscription('rotated', '{"a":1}', signature, 1000)).toBe(false);
    expect(verifySubscription('a-secret', '{"a":1}', signature, 1301)).toBe(false);
    expect(verifySubscription('a-secret', '{"a":1}', signature, 699)).toBe(false);
    for (const bad of ['', 't=1000,v1=a', 't=no,v1=ab', `${signature},t=1000`])
      expect(verifySubscription('a-secret', '{"a":1}', bad, 1000)).toBe(false);
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('outbound subscriptions (Postgres)', async () => {
  const { getDb, schema, closeDb } = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { createRadar, setVisibility } = await import('./radars.js');
  const { createBlip, updateBlip, deleteBlip, listBlips } = await import('./blips.js');
  const { createComment } = await import('./comments.js');
  const {
    createSubscription,
    listSubscriptions,
    rotateSubscription,
    deleteSubscription,
    drainSubscriptionDeliveries,
    enqueueSubscriptionEvent,
    listSubscriptionDeliveries,
    updateSubscription,
  } = await import('./subscriptions.js');
  let owner: Actor;
  let radarId: string;
  const databaseUrl = must(process.env['DATABASE_URL']);
  const scratchName = `omr_subscription_${process.pid}_${Date.now().toString(36)}`;
  let admin: pg.Pool | undefined;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    const target = new URL(databaseUrl);
    target.pathname = `/${scratchName}`;
    setEnvForTesting(loadEnv({ ...process.env, DATABASE_URL: target.toString() }));
    await runMigrations();
  }, 30000);
  beforeEach(async () => {
    vi.mocked(publicRequest).mockReset().mockResolvedValue({ status: 204, headers: {}, body: '' });
    const [user] = await getDb()
      .insert(schema.users)
      .values({
        email: `outbound-${randomUUID()}@example.test`,
        state: 'active',
        name: 'Test owner',
      })
      .returning();
    owner = { user: must(user), kind: 'user' };
    radarId = (await createRadar(owner, { name: 'Workshop Jobs', template: 'kanban' })).id;
  });
  afterAll(async () => {
    await closeDb();
    setEnvForTesting(null);
    await admin?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await admin?.end();
  });
  const subscribe = () =>
    createSubscription(owner, radarId, {
      name: 'Portal',
      url: 'https://receiver.example/events',
      events: [...SUBSCRIPTION_EVENTS],
    });
  async function drainAll() {
    for (let i = 0; i < 100 && (await drainSubscriptionDeliveries()); i++);
  }
  async function queued(id: string) {
    return getDb()
      .select()
      .from(schema.subscriptionDeliveries)
      .where(eq(schema.subscriptionDeliveries.subscriptionId, id));
  }
  it('returns secrets once, stores authenticated ciphertext and refuses agent credentials', async () => {
    const sub = await subscribe();
    const [stored] = await getDb()
      .select()
      .from(schema.radarSubscriptions)
      .where(eq(schema.radarSubscriptions.id, sub.id));
    expect(must(stored).secretCiphertext).not.toContain(must(sub.secret));
    expect(decryptSubscriptionSecret(must(stored).secretCiphertext)).toBe(sub.secret);
    expect(JSON.stringify(await listSubscriptions(owner, radarId))).not.toContain(must(sub.secret));
    const encrypted = encryptSubscriptionSecret('example');
    expect(decryptSubscriptionSecret(encrypted)).toBe('example');
    const parts = encrypted.split('.');
    parts[1] = Buffer.alloc(16).toString('base64url');
    expect(() => decryptSubscriptionSecret(parts.join('.'))).toThrow();
    const rotated = await rotateSubscription(owner, radarId, sub.id);
    expect(rotated.secret).not.toBe(sub.secret);
    expect(
      verifySubscription(must(sub.secret), '{}', signSubscription(must(rotated.secret), '{}')),
    ).toBe(false);
    await expect(
      createSubscription({ ...owner, kind: 'agent' }, radarId, {
        name: 'Agent',
        url: sub.url,
        events: ['blip.updated'],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      rotateSubscription({ ...owner, kind: 'agent' }, radarId, sub.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createSubscription(owner, radarId, {
        name: 'Bad',
        url: 'http://localhost/',
        events: ['blip.updated'],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await deleteSubscription({ ...owner, kind: 'agent' }, radarId, sub.id);
    expect(await listSubscriptions(owner, radarId)).toEqual([]);
  });
  it('refuses a private or internal URL when it is saved, saying why', async () => {
    for (const url of [
      'https://10.1.2.3/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest',
      'https://onmyradar.svc.cluster.local/hook',
    ]) {
      await expect(
        createSubscription(owner, radarId, { name: 'Internal', url, events: ['blip.created'] }),
        url,
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/private or internal address/) as unknown,
      });
    }
    expect(await listSubscriptions(owner, radarId)).toEqual([]);
  });

  it('manages subscriptions by the radar’s public slug as well as its id', async () => {
    // `requireRadar` accepts a public slug, and its owner still manages it.
    const slug = must((await setVisibility(owner, radarId, 'public')).publicSlug);
    expect(slug).not.toBe(radarId);
    const sub = await createSubscription(owner, slug, {
      name: 'By slug',
      url: 'https://receiver.example/slug',
      events: ['blip.created'],
    });
    expect(sub.radarId).toBe(radarId);
    expect((await listSubscriptions(owner, slug)).map((s) => s.id)).toEqual([sub.id]);
    await deleteSubscription(owner, slug, sub.id);
    expect(await listSubscriptions(owner, radarId)).toEqual([]);
  });

  it('queues one event for a lane/state move, omits no-op saves and sends signed snapshots', async () => {
    const sub = await subscribe();
    const blip = await createBlip(owner, radarId, { title: 'Print order', status: 'todo' });
    const updated = await updateBlip(owner, blip.id, { status: 'doing' });
    await updateBlip(owner, blip.id, { status: 'doing' });
    const jobs = await queued(sub.id);
    const event = must(jobs.find((j) => j.payload.event === 'blip.updated')).payload;
    expect(jobs).toHaveLength(2);
    expect(event.changes).toMatchObject({
      status: { from: 'todo', to: 'doing' },
      state: { from: blip.state, to: 'active' },
    });
    expect(must(event.blip)['updatedAt']).toBe(updated.updatedAt);
    await drainAll();
    expect(publicRequest).toHaveBeenCalledTimes(2);
    for (const [, options] of vi.mocked(publicRequest).mock.calls) {
      const raw = must(must(options).body).toString();
      const headers = must(must(options).headers);
      expect(verifySubscription(must(sub.secret), raw, must(headers['X-OMR-Signature']))).toBe(
        true,
      );
      expect(headers['X-OMR-Event-Id']).toBe((JSON.parse(raw) as { id: string }).id);
      expect(must(options).timeoutMs).toBe(10000);
    }
  });
  it('preserves agent identity, comments and deletion snapshots', async () => {
    const sub = await subscribe();
    const [agent] = await getDb()
      .insert(schema.agents)
      .values({
        ownerId: owner.user.id,
        name: 'Portal',
        slug: `portal-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const actor: Actor = {
      ...owner,
      kind: 'agent',
      agent: {
        agentId: must(agent).id,
        ownerId: owner.user.id,
        name: 'Portal',
        handle: must(agent).slug,
      },
    };
    const blip = await createBlip(owner, radarId, { title: 'Order' });
    await updateBlip(actor, blip.id, { state: 'done' });
    await createComment(actor, blip.id, { body: 'Customer reply' });
    await deleteBlip(owner, blip.id);
    const jobs = await queued(sub.id);
    expect(jobs.map((j) => j.payload.event).sort()).toEqual(
      ['blip.created', 'blip.deleted', 'blip.updated', 'comment.created'].sort(),
    );
    expect(must(jobs.find((j) => j.payload.event === 'blip.updated')).payload.actor).toMatchObject({
      kind: 'agent',
      agentId: must(agent).id,
    });
    expect(
      must(jobs.find((j) => j.payload.event === 'comment.created')).payload.comment,
    ).toMatchObject({
      body: 'Customer reply',
    });
    await drainAll();
    expect(await listSubscriptionDeliveries(owner, radarId, sub.id)).toHaveLength(4);
  });
  it('retries with stable ids, fresh signatures and bounded backoff, then pauses and notifies', async () => {
    const sub = await subscribe();
    await createBlip(owner, radarId, { title: 'Retry' });
    vi.mocked(publicRequest).mockResolvedValue({ status: 500, headers: {}, body: '' });
    const [initial] = await queued(sub.id);
    for (let attempt = 1; attempt <= 6; attempt++) {
      await getDb()
        .update(schema.subscriptionDeliveries)
        .set({ runAfter: new Date(0) })
        .where(eq(schema.subscriptionDeliveries.subscriptionId, sub.id));
      await drainSubscriptionDeliveries();
      const pending = await queued(sub.id);
      if (attempt < 6) {
        expect(must(pending[0]).runAfter.getTime()).toBeGreaterThan(Date.now() + 55000);
        expect(must(pending[0]).payload.id).toBe(must(initial).payload.id);
      } else expect(pending).toEqual([]);
    }
    const history = await listSubscriptionDeliveries(owner, radarId, sub.id);
    expect(history).toHaveLength(6);
    expect(history.every((d) => d.status === 500)).toBe(true);
    expect(history.map((d) => d.attempt).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(must((await listSubscriptions(owner, radarId))[0]).enabled).toBe(false);
    const notices = await getDb()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, owner.user.id));
    expect(notices.some((n) => n.kind === 'subscription_failed')).toBe(true);
    await updateSubscription(owner, radarId, sub.id, true);
    expect(must((await listSubscriptions(owner, radarId))[0]).enabled).toBe(true);
  });
  it('stops delivery on suspension, loss of write access, and cascades radar deletion', async () => {
    const sub = await subscribe();
    await createBlip(owner, radarId, { title: 'Suspended' });
    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.id, owner.user.id));
    await drainAll();
    expect(publicRequest).not.toHaveBeenCalled();
    await getDb()
      .update(schema.users)
      .set({ state: 'active' })
      .where(eq(schema.users.id, owner.user.id));
    await createBlip(owner, radarId, { title: 'Revoked' });
    const [other] = await getDb()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, state: 'active' })
      .returning();
    await getDb()
      .update(schema.radars)
      .set({ ownerId: must(other).id })
      .where(eq(schema.radars.id, radarId));
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId, userId: owner.user.id, role: 'viewer' });
    await drainAll();
    expect(publicRequest).not.toHaveBeenCalled();
    await getDb().delete(schema.radars).where(eq(schema.radars.id, radarId));
    expect(await queued(sub.id)).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(schema.radarSubscriptions)
        .where(eq(schema.radarSubscriptions.id, sub.id)),
    ).toEqual([]);
  });
  it('rolls events back with content, filters events, and claims each delivery once', async () => {
    const sub = await createSubscription(owner, radarId, {
      name: 'Updates',
      url: 'https://receiver.example/events',
      events: ['blip.updated'],
    });
    const blip = await createBlip(owner, radarId, { title: 'Before' });
    expect(await queued(sub.id)).toEqual([]);
    const [before] = await getDb().select().from(schema.blips).where(eq(schema.blips.id, blip.id));
    await expect(
      getDb().transaction(async (tx) => {
        const [after] = await tx
          .update(schema.blips)
          .set({ title: 'Rolled back' })
          .where(eq(schema.blips.id, blip.id))
          .returning();
        await enqueueSubscriptionEvent(
          tx,
          owner,
          { id: radarId, name: 'Test' },
          'blip.updated',
          must(after),
          before,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await queued(sub.id)).toEqual([]);
    await updateBlip(owner, blip.id, { title: 'After' });
    await Promise.all([drainSubscriptionDeliveries(), drainSubscriptionDeliveries()]);
    expect(publicRequest).toHaveBeenCalledTimes(1);
  });
  it('signs a retry with the rotated secret and recovers from a connection failure', async () => {
    const sub = await subscribe();
    await createBlip(owner, radarId, { title: 'Rotation retry' });
    vi.mocked(publicRequest).mockRejectedValueOnce(new Error('timeout'));
    await drainSubscriptionDeliveries();
    const rotated = await rotateSubscription(owner, radarId, sub.id);
    await getDb()
      .update(schema.subscriptionDeliveries)
      .set({ runAfter: new Date(0) })
      .where(eq(schema.subscriptionDeliveries.subscriptionId, sub.id));
    await drainSubscriptionDeliveries();
    const [, options] = must(vi.mocked(publicRequest).mock.calls.at(-1));
    const raw = must(must(options).body).toString();
    const headers = must(must(options).headers);
    expect(headers['X-OMR-Delivery-Attempt']).toBe('2');
    expect(verifySubscription(must(rotated.secret), raw, must(headers['X-OMR-Signature']))).toBe(
      true,
    );
    expect(verifySubscription(must(sub.secret), raw, must(headers['X-OMR-Signature']))).toBe(false);
    expect(await queued(sub.id)).toEqual([]);
    expect((await listSubscriptionDeliveries(owner, radarId, sub.id)).map((a) => a.status)).toEqual(
      [204, null],
    );
  });
  it('keeps cross-radar move snapshots within their original access boundary', async () => {
    const source = await subscribe();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const other: Actor = { user: must(user), kind: 'user' };
    const target = await createRadar(other, { name: 'Destination' });
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: target.id, userId: owner.user.id, role: 'editor' });
    const destination = await createSubscription(other, target.id, {
      name: 'Destination receiver',
      url: 'https://receiver.example/events',
      events: [...SUBSCRIPTION_EVENTS],
    });
    const blip = await createBlip(owner, radarId, { body: 'Private original' });
    await updateBlip(owner, blip.id, { radarId: target.id, body: 'Shared replacement' });
    const outgoing = await queued(source.id);
    const incoming = await queued(destination.id);
    expect(
      must(must(outgoing.find((j) => j.payload.event === 'blip.deleted')).payload.blip)['body'],
    ).toBe('Private original');
    expect(incoming).toHaveLength(1);
    expect(must(incoming[0]).payload.event).toBe('blip.created');
    expect(JSON.stringify(incoming)).not.toContain('Private original');
    await drainAll();
    // The old queued create is suppressed once the blip has left the radar.
    expect(publicRequest).toHaveBeenCalledTimes(2);
  });
  it('cascades pending events and attempt history when the radar is removed', async () => {
    const sub = await subscribe();
    await createBlip(owner, radarId, { title: 'Delivered' });
    await drainAll();
    await createBlip(owner, radarId, { title: 'Pending' });
    expect(await queued(sub.id)).toHaveLength(1);
    expect(await listSubscriptionDeliveries(owner, radarId, sub.id)).toHaveLength(1);
    await getDb().delete(schema.radars).where(eq(schema.radars.id, radarId));
    expect(await queued(sub.id)).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(schema.subscriptionAttempts)
        .where(eq(schema.subscriptionAttempts.subscriptionId, sub.id)),
    ).toEqual([]);
  });
  it('pages updatedSince chronologically with a microsecond-safe cursor, independent of pins and lanes', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n++)
      ids.push((await createBlip(owner, radarId, { title: String(n), pinned: n === 2 })).id);
    for (let n = 0; n < ids.length; n++)
      await getDb().execute(
        sql`UPDATE blips SET updated_at=${`2026-09-20T12:00:00.00000${n + 1}Z`}::timestamptz WHERE id=${ids[n]}::uuid`,
      );
    const query = {
      sort: 'updated' as const,
      updatedSince: '2026-09-20T12:00:00.000000Z',
      limit: 1,
    };
    const first = await listBlips([radarId], query);
    const second = await listBlips([radarId], { ...query, cursor: must(first.nextCursor) });
    const third = await listBlips([radarId], { ...query, cursor: must(second.nextCursor) });
    expect([must(first.items[0]).id, must(second.items[0]).id, must(third.items[0]).id]).toEqual(
      ids,
    );
    expect(third.nextCursor).toBeNull();
    expect(
      (await listBlips([radarId], { updatedSince: '2026-09-20T12:00:00.000003Z' })).items,
    ).toEqual([]);
  });
});

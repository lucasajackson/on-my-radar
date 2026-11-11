import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadEnv, setEnvForTesting } from '../env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type * as PublicRequestModule from './public-request.js';
import type * as OutboxModule from './outbox.js';
import { closeDb, getDb, getPool, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor, AppEnv } from '../http.js';
import { createRadar, createSmartRadar, deleteRadar, ensureDropBox } from './radars.js';
import { createBlip, deleteBlip } from './blips.js';
import {
  createFeed,
  deleteFeed,
  feedCutoff,
  listFeeds,
  pollDueFeed,
  pollFeed,
  purgeRemovedFeeds,
  updateFeed,
} from './rss.js';
import { rssRouter } from '../routes/rss.js';
import { radarRoutes } from '../routes/radars.js';
import { must } from '../errors.js';

const transport = vi.hoisted(() => vi.fn<typeof PublicRequestModule.publicRequest>());
vi.mock('./public-request.js', async (original) => ({
  ...(await original<typeof PublicRequestModule>()),
  publicRequest: transport,
}));
vi.mock('./outbox.js', async (original) => ({
  ...(await original<typeof OutboxModule>()),
  drainOne: async () => undefined,
}));
function xml(items: Array<{ id: string; date?: string }>) {
  return `<rss><channel><title>Test feed</title>${items.map((i) => `<item><guid>${i.id}</guid><title>Article ${i.id}</title><description>Read this</description>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
}
function response(body: string) {
  return { status: 200, headers: { etag: 'version-one' }, body };
}
process.env['SESSION_SECRET'] ??= 'rss-test-secret-not-used-in-production';

describe.skipIf(!process.env['DATABASE_URL'])('feed capture (real PostgreSQL)', () => {
  let actor: Actor;
  let radarId: string;
  const database = `omr_rss_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    setEnvForTesting(loadEnv({ ...process.env, DATABASE_URL: url.toString() }));
    await runMigrations();
  }, 30_000);
  beforeEach(async () => {
    transport.mockReset();
    await getDb().delete(schema.outbox);
    await getDb().update(schema.radarFeeds).set({ enabled: false });
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `rss-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    actor = { user: must(user), kind: 'user' };
    radarId = (await createRadar(actor, { name: 'Feed reading' })).id;
  });
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });
  async function countBlips(id = radarId) {
    return must(
      (
        await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.blips)
          .where(eq(schema.blips.radarId, id))
      )[0],
    ).count;
  }
  it('protects the Drop Box through both service and HTTP without deleting its contents', async () => {
    const dropBox = await ensureDropBox(actor);
    const blip = await createBlip(actor, dropBox.id, { body: 'Keep this' });
    await expect(deleteRadar(actor, dropBox.id)).rejects.toThrow(/permanent inbox/);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('actor', actor);
      await next();
    });
    app.route('/api/radars', radarRoutes);
    expect((await app.request(`/api/radars/${dropBox.id}`, { method: 'DELETE' })).status).toBe(400);
    expect(await countBlips(dropBox.id)).toBe(1);
    expect(
      (await getDb().select().from(schema.blips).where(eq(schema.blips.id, blip.id)))[0],
    ).toBeDefined();
    await deleteRadar(actor, radarId);
    expect(
      (await getDb().select().from(schema.radars).where(eq(schema.radars.id, radarId))).length,
    ).toBe(0);
  });
  it('refuses a feed on a private or internal address when it is added', async () => {
    await expect(
      createFeed(actor, radarId, { url: 'http://192.168.1.10/feed.xml', lookback: 'forever' }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/192\.168\.1\.10 is a private or internal address/) as unknown,
    });
  });
  it('never writes a private feed credential into the blips it imports', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/private.atom?token=hunter2-secret',
      lookback: 'forever',
    });
    transport.mockResolvedValue(response(xml([{ id: 'private-one' }])));
    await pollFeed(feed.id);
    const [capture] = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.radarId, radarId));
    expect(capture?.body).toContain('Imported from RSS feed: https://feed.test/private.atom');
    expect(capture?.body).not.toContain('hunter2');
  });
  it('deduplicates simultaneous polls, deleted blips, and remove/re-add of the same source', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/rss#ignored',
      lookback: 'forever',
    });
    transport.mockResolvedValue(response(xml([{ id: 'one' }, { id: 'two' }])));
    await Promise.all([pollFeed(feed.id), pollFeed(feed.id)]);
    expect(await countBlips()).toBe(2);
    const captures = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.radarId, radarId));
    expect(
      captures.every((blip) => blip.body.includes('Imported from RSS feed: https://feed.test/rss')),
    ).toBe(true);
    const events = await getDb()
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.kind, 'notification-event'), sql`payload->>'radarId' = ${radarId}`),
      );
    expect(events).toHaveLength(2);
    expect(
      events.every((event) => (event.payload['actor'] as { kind: string }).kind === 'user'),
    ).toBe(true);
    const [blip] = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.radarId, radarId));
    await deleteBlip(actor, must(blip).id);
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(1);
    await deleteFeed(actor, radarId, feed.id);
    expect(await listFeeds(actor, radarId)).toEqual([]);
    const restored = await createFeed(actor, radarId, {
      url: 'https://feed.test/rss',
      lookback: 'forever',
    });
    expect(restored.id).toBe(feed.id);
    await pollFeed(restored.id);
    expect(await countBlips()).toBe(1);
    expect(must((await listFeeds(actor, radarId))[0]).itemCount).toBe(2);
  });
  it('rolls marker and capture back together when a capture hook fails', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/rollback',
      lookback: 'forever',
    });
    await expect(
      createBlip(
        actor,
        radarId,
        { body: 'No partial write' },
        {
          beforeInsert: async (tx) => {
            await tx.insert(schema.feedItems).values({ feedId: feed.id, itemHash: 'a'.repeat(64) });
          },
          afterInsert: async () => {
            throw new Error('abort capture');
          },
        },
      ),
    ).rejects.toThrow('abort capture');
    expect(await countBlips()).toBe(0);
    expect(
      await getDb().select().from(schema.feedItems).where(eq(schema.feedItems.feedId, feed.id)),
    ).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(schema.outbox)
        .where(sql`payload->>'radarId' = ${radarId}`),
    ).toEqual([]);
  });
  it('keeps a fixed lookback cutoff, supports widening, and resumes history beyond 500 entries', async () => {
    // A poll has two budgets: 500 captures and 20 s of wall clock. This test is
    // about the first, so it holds the clock still. Unpinned, a loaded runner
    // spent 20 s on ~466 captures and the time budget stopped the poll first
    // (CI job 33410: "expected 467 to be 501"). The time budget has its own test.
    const pinned = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await resumesHistoryBeyondTheCaptureBudget();
    } finally {
      pinned.mockRestore();
    }
    // Held still, all 500 captures always run, so the timeout must cover the
    // slowest runner's full batch: 36 s with a 30 ms insert delay, past 30 s.
  }, 90_000);
  async function resumesHistoryBeyondTheCaptureBudget() {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/history',
      lookback: 'day',
    });
    const entries = [
      { id: 'old', date: '2000-01-01' },
      { id: 'unknown' },
      { id: 'today', date: new Date().toISOString() },
    ];
    transport.mockResolvedValue(response(xml(entries)));
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(1);
    await updateFeed(actor, radarId, feed.id, { lookback: 'forever' });
    transport.mockResolvedValue(
      response(
        xml([...entries, ...Array.from({ length: 501 }, (_, i) => ({ id: `backlog-${i}` }))]),
      ),
    );
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(501);
    const [continuation] = await getDb()
      .select()
      .from(schema.radarFeeds)
      .where(eq(schema.radarFeeds.id, feed.id));
    expect(must(continuation).etag).toBeNull();
    expect(must(continuation).nextPollAt.getTime() - Date.now()).toBeLessThanOrEqual(30_000);
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(504);
    const [complete] = await getDb()
      .select()
      .from(schema.radarFeeds)
      .where(eq(schema.radarFeeds.id, feed.id));
    expect(must(complete).etag).toBe('version-one');
    expect(must(must(transport.mock.calls.at(-1))[1]).headers?.['if-none-match']).toBeUndefined();
  }
  it('stops starting captures after 20 s of work and leaves the rest as a continuation', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/slow',
      lookback: 'forever',
    });
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: `slow-${i}` }));
    transport.mockResolvedValue(response(xml(entries)));
    // Every reading of the clock costs a second: the 20 s budget runs out long
    // before the 500-capture one, whatever the machine's real speed.
    let now = Date.now();
    const slow = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000));
    try {
      await pollFeed(feed.id);
      const partial = await countBlips();
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(entries.length);
      const [row] = await getDb()
        .select()
        .from(schema.radarFeeds)
        .where(eq(schema.radarFeeds.id, feed.id));
      expect(must(row).etag).toBeNull();
      expect(must(row).nextPollAt.getTime() - now).toBeLessThanOrEqual(30_000);
    } finally {
      slow.mockRestore();
    }
    const pinned = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await pollFeed(feed.id);
    } finally {
      pinned.mockRestore();
    }
    expect(await countBlips()).toBe(entries.length);
  });
  it('does not capture after a pause or suspension during fetch and retains a readable failure', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/pause',
      lookback: 'forever',
    });
    transport.mockImplementationOnce(async () => {
      await updateFeed(actor, radarId, feed.id, { enabled: false });
      return response(xml([{ id: 'one' }]));
    });
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(0);
    await updateFeed(actor, radarId, feed.id, { enabled: true });
    transport.mockImplementationOnce(async () => {
      await getDb()
        .update(schema.users)
        .set({ state: 'suspended' })
        .where(eq(schema.users.id, actor.user.id));
      return response(xml([{ id: 'one' }]));
    });
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(0);
    const [row] = await getDb()
      .select()
      .from(schema.radarFeeds)
      .where(eq(schema.radarFeeds.id, feed.id));
    expect(must(row).lastError).toMatch(/not active/);
    expect(must(row).failures).toBe(1);
  });
  it('enforces ownership, standard-radar targets and concurrent source quotas', async () => {
    const smart = await createSmartRadar(actor, { name: 'Smart', filter: { tags: ['test'] } });
    await expect(
      createFeed(actor, smart.id, { url: 'https://x.test', lookback: 'forever' }),
    ).rejects.toThrow(/smart/);
    const result = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        createFeed(actor, radarId, { url: `https://feed.test/${i}`, lookback: 'week' }),
      ),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const [stranger] = await getDb()
      .insert(schema.users)
      .values({ email: `stranger-${randomUUID()}@test.test`, state: 'active' })
      .returning();
    await expect(listFeeds({ user: must(stranger), kind: 'user' }, radarId)).rejects.toMatchObject({
      status: 404,
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('actor', actor);
      await next();
    });
    app.route('/api/radars', rssRouter);
    const invalid = await app.request(`/api/radars/${radarId}/feeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'not a valid URL', lookback: 'forever' }),
    });
    expect(invalid.status).toBe(400);
    const invalidId = await app.request(`/api/radars/${radarId}/feeds/not-an-id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(invalidId.status).toBe(400);
  });
  it('a queued update cannot resurrect a concurrently removed source', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/remove-race',
      lookback: 'forever',
    });
    const locker = await getPool().connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM radar_feeds WHERE id = $1 FOR UPDATE', [feed.id]);
    async function waitForBlocked(count: number) {
      for (let i = 0; i < 100; i++) {
        const result = await getPool().query<{
          count: number;
        }>(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'update "radar_feeds"%'`);
        if ((result.rows[0]?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Expected competing feed updates to wait for row lock');
    }
    try {
      const removed = deleteFeed(actor, radarId, feed.id);
      await waitForBlocked(1);
      const updated = updateFeed(actor, radarId, feed.id, { enabled: true }).then(
        () => null,
        (err: unknown) => err,
      );
      await waitForBlocked(2);
      await locker.query('COMMIT');
      await removed;
      expect(await updated).toMatchObject({ status: 404 });
      expect(await listFeeds(actor, radarId)).toEqual([]);
      // Defense in depth against a historical or manually inconsistent row.
      await getDb()
        .update(schema.radarFeeds)
        .set({ enabled: true })
        .where(eq(schema.radarFeeds.id, feed.id));
      await pollFeed(feed.id);
      expect(await pollDueFeed()).toBe(0);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
  it('does not import into an archived radar, including an archive during fetch', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/archive',
      lookback: 'forever',
    });
    transport.mockImplementationOnce(async () => {
      await getDb()
        .update(schema.radars)
        .set({ archived: true })
        .where(eq(schema.radars.id, radarId));
      return response(xml([{ id: 'one' }]));
    });
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(0);
    expect(must((await listFeeds(actor, radarId))[0]).lastError).toMatch(/archived/);
    transport.mockClear();
    await pollFeed(feed.id);
    expect(transport).not.toHaveBeenCalled();
  });
  it('leaves feeds due while delivery backlog exceeds the capture threshold', async () => {
    await createFeed(actor, radarId, {
      url: 'https://feed.test/backpressure',
      lookback: 'forever',
    });
    await getDb()
      .insert(schema.outbox)
      .values(Array.from({ length: 1000 }, () => ({ kind: 'notification', payload: {} })));
    expect(await pollDueFeed()).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
  it('is not paused by a pile of jobs no process can run', async () => {
    await createFeed(actor, radarId, { url: 'https://feed.test/unrunnable', lookback: 'forever' });
    await getDb()
      .insert(schema.outbox)
      .values(Array.from({ length: 1000 }, () => ({ kind: 'retired-kind', payload: {} })));
    transport.mockResolvedValue(response(xml([{ id: 'polled' }])));
    expect(await pollDueFeed()).toBe(1);
    expect(await countBlips()).toBe(1);
  });
  it('stops capturing at shutdown and leaves the rest as a released continuation', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/shutdown',
      lookback: 'forever',
    });
    transport.mockResolvedValue(response(xml([{ id: 'a' }, { id: 'b' }])));
    const stop = new AbortController();
    stop.abort();
    await pollFeed(feed.id, stop.signal);
    expect(await countBlips()).toBe(0);
    const [row] = await getDb()
      .select()
      .from(schema.radarFeeds)
      .where(eq(schema.radarFeeds.id, feed.id));
    expect(row?.leasedUntil).toBeNull();
    expect(row?.etag).toBeNull();
    expect(must(row).nextPollAt.getTime() - Date.now()).toBeLessThanOrEqual(30_000);
  });
  it('bounds add/remove churn and retires removed sources, tombstones and all', async () => {
    const removedAt = sql`now() - interval '1 day'`;
    await getDb()
      .insert(schema.radarFeeds)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          radarId,
          createdBy: actor.user.id,
          url: `https://feed.test/churn-${i}`,
          lookback: 'forever' as const,
          enabled: false,
          removedAt,
        })),
      );
    await expect(
      createFeed(actor, radarId, { url: 'https://feed.test/one-more', lookback: 'forever' }),
    ).rejects.toThrow(/removed too many recently/);
    // Restoring a removed source reuses its row, so it is never refused.
    const restored = await createFeed(actor, radarId, {
      url: 'https://feed.test/churn-0',
      lookback: 'forever',
    });
    await getDb()
      .insert(schema.feedItems)
      .values({ feedId: restored.id, itemHash: 'kept'.padEnd(64, '0') });
    const [old] = await getDb()
      .select()
      .from(schema.radarFeeds)
      .where(eq(schema.radarFeeds.url, 'https://feed.test/churn-1'));
    await getDb()
      .insert(schema.feedItems)
      .values({ feedId: must(old).id, itemHash: 'x'.repeat(64) });
    await getDb()
      .update(schema.radarFeeds)
      .set({ removedAt: sql`now() - interval '31 days'` })
      .where(
        sql`${schema.radarFeeds.url} LIKE 'https://feed.test/churn-%' AND removed_at IS NOT NULL`,
      );

    expect(await purgeRemovedFeeds()).toBe(99);
    expect(
      await getDb()
        .select()
        .from(schema.feedItems)
        .where(eq(schema.feedItems.feedId, must(old).id)),
    ).toHaveLength(0);
    expect(
      await getDb().select().from(schema.feedItems).where(eq(schema.feedItems.feedId, restored.id)),
    ).toHaveLength(1);
    await expect(
      createFeed(actor, radarId, { url: 'https://feed.test/one-more', lookback: 'forever' }),
    ).resolves.toMatchObject({ url: 'https://feed.test/one-more' });
  });
  it('sends cache validators after completion and handles 304 without recapturing', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/cached',
      lookback: 'forever',
    });
    transport.mockResolvedValueOnce(response(xml([{ id: 'one' }])));
    await pollFeed(feed.id);
    transport.mockResolvedValueOnce({ status: 304, headers: {}, body: '' });
    await pollFeed(feed.id);
    expect(must(must(transport.mock.calls[1])[1]?.headers)['if-none-match']).toBe('version-one');
    expect(await countBlips()).toBe(1);
    expect(must((await listFeeds(actor, radarId))[0]).lastError).toBeNull();
  });
  it('uses the guarded transport for every redirect and reports oversized/invalid feeds', async () => {
    const feed = await createFeed(actor, radarId, {
      url: 'https://feed.test/redirect',
      lookback: 'forever',
    });
    transport
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'http://127.0.0.1/private' },
        body: '',
      })
      .mockImplementationOnce(async (url, options) =>
        (await vi.importActual<typeof PublicRequestModule>('./public-request.js')).publicRequest(
          url,
          options,
        ),
      );
    await pollFeed(feed.id);
    expect(await countBlips()).toBe(0);
    expect(
      must(
        (
          await getDb().select().from(schema.radarFeeds).where(eq(schema.radarFeeds.id, feed.id))
        )[0],
      ).lastError,
    ).toBeTruthy();
    transport.mockResolvedValue(response('x'.repeat(2 * 1024 * 1024 + 1)));
    await pollFeed(feed.id);
    expect(
      must(
        (
          await getDb().select().from(schema.radarFeeds).where(eq(schema.radarFeeds.id, feed.id))
        )[0],
      ).lastError,
    ).toMatch(/2 MiB/);
    expect(
      await getDb()
        .select()
        .from(schema.feedItems)
        .where(and(eq(schema.feedItems.feedId, feed.id))),
    ).toEqual([]);
  });
});
it('defines lookback windows without a moving repeated cutoff', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  expect(feedCutoff('forever', now)).toBeNull();
  for (const [kind, days] of [
    ['day', 1],
    ['week', 7],
    ['month', 30],
    ['year', 365],
  ] as const)
    expect(now.getTime() - must(feedCutoff(kind, now)).getTime()).toBe(days * 86_400_000);
});

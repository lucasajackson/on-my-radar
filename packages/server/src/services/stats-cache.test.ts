/**
 * Whole-radar aggregates: reused per radar, sent with the first page only, and the
 * architecture read refuses to load an unbounded radar.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serve } from '@hono/node-server';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { httpTransport } from '../mcp/test-client.js';
import { readArchitecture } from './architecture.js';
import { createBlip, deleteBlip } from './blips.js';
import { createRadar, listRadars } from './radars.js';
import {
  cachedForRadar,
  clearStatsCacheForTesting,
  invalidateRadarStats,
  invalidateRadarStatsSoon,
} from './stats-cache.js';
import { TOKEN_SCOPES } from '@onmyradar/contract';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe('cachedForRadar', () => {
  beforeEach(() => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
        STATS_CACHE_TTL_MS: '30000',
      }),
    );
    clearStatsCacheForTesting();
  });

  it('shares one load between concurrent callers and reuses it inside the TTL', async () => {
    const load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 7;
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cachedForRadar('r1', 'stats', load)),
    );
    expect(results).toEqual(Array.from({ length: 10 }, () => 7));
    expect(load).toHaveBeenCalledTimes(1);
    await cachedForRadar('r1', 'stats', load, Date.now() + 29_000);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedForRadar('r1', 'stats', load, Date.now() + 31_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves the old value at once after the TTL while one refresh runs in the background', async () => {
    let n = 0;
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const load = vi.fn(async () => {
      n += 1;
      if (n > 1) await slow;
      return n;
    });
    expect(await cachedForRadar('swr', 'stats', load)).toBe(1);
    const later = Date.now() + 31_000;
    // Past the TTL: the old value comes back without waiting, and only one refresh starts.
    expect(await cachedForRadar('swr', 'stats', load, later)).toBe(1);
    expect(await cachedForRadar('swr', 'stats', load, later + 10)).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(await cachedForRadar('swr', 'stats', load)).toBe(2);
    // Far past the stale window a reader waits for a fresh value instead.
    expect(await cachedForRadar('swr', 'stats', load, Date.now() + 600_000)).toBe(3);
  });

  it('a refresh that keeps failing cannot extend a stale value past its limit', async () => {
    let calls = 0;
    let broken = false;
    const load = vi.fn(async () => {
      calls += 1;
      if (broken) throw new Error('database unavailable');
      return calls;
    });
    const t0 = Date.now();
    expect(await cachedForRadar('stuck', 'stats', load, t0)).toBe(1);
    broken = true;
    // Past the TTL: the old value is served while a refresh runs, and fails.
    expect(await cachedForRadar('stuck', 'stats', load, t0 + 31_000)).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    // A failed refresh is retried after a pause, not on every read, and still serves the old value.
    expect(await cachedForRadar('stuck', 'stats', load, t0 + 32_000)).toBe(1);
    expect(await cachedForRadar('stuck', 'stats', load, t0 + 40_000)).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    // Five TTLs after the last good load the stale value is gone: the caller gets the failure,
    // not a number that has been wrong for minutes.
    await expect(cachedForRadar('stuck', 'stats', load, t0 + 151_000)).rejects.toThrow(
      'database unavailable',
    );
    broken = false;
    expect(await cachedForRadar('stuck', 'stats', load, t0 + 152_000)).toBeGreaterThan(1);
  });

  it('a refresh that was in flight when the radar changed does not overwrite the fresh value', async () => {
    const t0 = Date.now();
    let release: (n: number) => void = () => undefined;
    const slow = new Promise<number>((r) => {
      release = r;
    });
    expect(await cachedForRadar('r-race', 'stats', async () => 9, t0)).toBe(9);
    // Past the TTL: the old value is served and a background refresh starts. It has read 10 and
    // is still on its way to the cache.
    expect(await cachedForRadar('r-race', 'stats', () => slow, t0 + 31_000)).toBe(9);
    // The radar changes: the entry is dropped, and the next read loads the new truth, 11.
    invalidateRadarStats('r-race');
    expect(await cachedForRadar('r-race', 'stats', async () => 11, t0 + 32_000)).toBe(11);
    // The late refresh lands. It must not put 10 over 11.
    release(10);
    await new Promise((r) => setTimeout(r, 10));
    expect(
      await cachedForRadar(
        'r-race',
        'stats',
        async () => {
          throw new Error('should be served from the cache');
        },
        t0 + 33_000,
      ),
    ).toBe(11);
  });

  it('does not keep a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(1);
    await expect(cachedForRadar('r2', 'stats', load)).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 5));
    await expect(cachedForRadar('r2', 'stats', load)).resolves.toBe(1);
  });

  it('an agent write drops the radar at once, then at most once per window for a burst', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const load = async () => ++n;
      await cachedForRadar('r1', 'stats', load);
      invalidateRadarStatsSoon('r1'); // quiet period: immediate
      expect(await cachedForRadar('r1', 'stats', load)).toBe(2);
      for (let i = 0; i < 5; i++) invalidateRadarStatsSoon('r1'); // burst: one trailing drop
      expect(await cachedForRadar('r1', 'stats', load)).toBe(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await cachedForRadar('r1', 'stats', load)).toBe(3);
      expect(await cachedForRadar('r1', 'stats', load)).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is off at TTL 0', async () => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
        STATS_CACHE_TTL_MS: '0',
      }),
    );
    const load = vi.fn().mockResolvedValue(1);
    await cachedForRadar('r3', 'stats', load);
    await cachedForRadar('r3', 'stats', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!hasDatabase)('radar stats against postgres', () => {
  let owner: Actor;
  let reader: Actor;
  let radarId: string;
  let base: string;
  let listener: ReturnType<typeof serve>;
  let client: Client;

  const useEnv = (patch: Record<string, string> = {}) =>
    setEnvForTesting(loadEnv({ ...process.env, STATS_CACHE_TTL_MS: '30000', ...patch }));

  beforeAll(async () => {
    useEnv();
    await runMigrations();
    const users = await getDb()
      .insert(schema.users)
      .values(
        ['o', 'r'].map((n) => ({
          email: `${n}-${randomUUID()}@example.test`,
          name: n,
          state: 'active' as const,
        })),
      )
      .returning();
    owner = { user: must(users[0]), kind: 'user' };
    reader = { user: must(users[1]), kind: 'user' };
    radarId = (await createRadar(owner, { name: `stats-${randomUUID()}`, template: 'stream' })).id;
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId, userId: reader.user.id, role: 'viewer' });
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'stats-client',
        userId: owner.user.id,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
    client = new Client({ name: 'stats-test', version: '0' });
    await client.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
      }),
    );
  }, 60_000);
  beforeEach(() => {
    clearStatsCacheForTesting();
    useEnv();
  });
  afterEach(() => useEnv());
  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await closeDb();
  });

  it('list_radars reuses counts across callers, and a local write moves them at once', async () => {
    for (let i = 0; i < 3; i++) await createBlip(owner, radarId, { body: `seed ${i}` });
    const first = must((await listRadars(reader)).find((r) => r.id === radarId));
    expect(first.blipCount).toBe(3);
    // A write that bypasses the service (as another replica's would) is not seen inside the TTL...
    await getDb().execute(
      sql`INSERT INTO blips (radar_id, author_id, body) VALUES (${radarId}::uuid, ${owner.user.id}::uuid, 'sneaky')`,
    );
    expect(must((await listRadars(owner)).find((r) => r.id === radarId)).blipCount).toBe(3);
    // ...but one made through this process is, and with it the count is exact again.
    await createBlip(owner, radarId, { body: 'visible' });
    expect(must((await listRadars(reader)).find((r) => r.id === radarId)).blipCount).toBe(5);
    const [gone] = (
      await getDb().execute<{ id: string }>(
        sql`SELECT id FROM blips WHERE radar_id = ${radarId}::uuid AND body = 'sneaky'`,
      )
    ).rows;
    await deleteBlip(owner, must(gone).id);
    expect(must((await listRadars(owner)).find((r) => r.id === radarId)).blipCount).toBe(4);
  });

  it('an agent write moves the count at once; a second one inside the window waits for the trailing drop', async () => {
    const before = must((await listRadars(owner)).find((r) => r.id === radarId)).blipCount;
    const connection = { kind: 'pat' as const, id: randomUUID(), label: 'test' };
    const agent = { ...owner, kind: 'agent' as const, connection };
    await createBlip(agent, radarId, { body: 'by an agent' });
    expect(must((await listRadars(owner)).find((r) => r.id === radarId)).blipCount).toBe(
      before + 1,
    );
    await createBlip(agent, radarId, { body: 'by an agent, again' });
    expect(must((await listRadars(owner)).find((r) => r.id === radarId)).blipCount).toBe(
      before + 1,
    );
    await vi.waitFor(
      async () =>
        expect(must((await listRadars(owner)).find((r) => r.id === radarId)).blipCount).toBe(
          before + 2,
        ),
      { timeout: 4_000, interval: 250 },
    );
  });

  it('read_radar sends tallies with the first page only', async () => {
    for (let i = 0; i < 4; i++) await createBlip(owner, radarId, { body: `page #t${i}` });
    const text = async (args: Record<string, unknown>) => {
      const res = (await client.callTool({ name: 'read_radar', arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(must(res.content[0]).text) as {
        tags?: unknown;
        states?: unknown;
        lanes: Array<{ count?: number }>;
        nextCursor: string | null;
        note?: string;
      };
    };
    const one = await text({ radarId, limit: 2 });
    expect(one.tags).toBeDefined();
    expect(one.states).toBeDefined();
    expect(one.lanes.every((l) => l.count !== undefined)).toBe(true);
    expect(one.nextCursor).toBeTruthy();
    const two = await text({ radarId, limit: 2, cursor: one.nextCursor });
    expect(two.tags).toBeUndefined();
    expect(two.states).toBeUndefined();
    expect(two.lanes.every((l) => l.count === undefined)).toBe(true);
    expect(two.note).toMatch(/first page only/);
  });

  it('refuses to load an architecture radar past ARCHITECTURE_MAX_BLIPS, with a clear error', async () => {
    useEnv({ ARCHITECTURE_MAX_BLIPS: '100' });
    const arch = await createRadar(owner, {
      name: `arch-${randomUUID()}`,
      template: 'architecture',
    });
    await getDb().execute(sql`
      INSERT INTO blips (radar_id, author_id, body, status, title)
      SELECT ${arch.id}::uuid, ${owner.user.id}::uuid, 'x', 'proposed', 'ADR ' || g
        FROM generate_series(1, 100) g`);
    expect((await readArchitecture(owner, arch.id, { view: 'source' })).adrs).toHaveLength(100);
    await getDb().execute(sql`
      INSERT INTO blips (radar_id, author_id, body, status, title)
      VALUES (${arch.id}::uuid, ${owner.user.id}::uuid, 'x', 'proposed', 'one too many')`);
    await expect(readArchitecture(owner, arch.id, { view: 'source' })).rejects.toMatchObject({
      status: 422,
      code: 'architecture_too_large',
    });
  });
});

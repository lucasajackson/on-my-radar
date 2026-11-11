/** Relative search windows belong to a traversal, not each page's wall clock. */
import pg from 'pg';
import { cursorSchema } from '@onmyradar/contract';
import { decodeCursor, encodeCursor } from './cursor.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createRadar } from './radars.js';
import { searchBlips } from './search.js';
import { must } from '../errors.js';

describe.skipIf(!process.env['DATABASE_URL'])('relative search pagination clock', () => {
  const database = `omr_relative_cursor_${Date.now()}`;
  let admin: pg.Pool;
  let actor: Actor;

  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'relative-cursor-test-secret-not-used-in-production',
      }),
    );
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: 'owner@relative-cursor.test', state: 'active' })
      .returning();
    actor = { user: must(user), kind: 'user' };
  }, 30_000);

  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('validates anchored cursor fields and query context while upgrading old cursors', async () => {
    const radar = await createRadar(actor, { name: 'Cursor validation' });
    await getDb()
      .insert(schema.blips)
      .values([1, 2, 3].map((index) => ({ radarId: radar.id, body: `Cursor check ${index}` })));
    const input = { q: `in:${radar.id} touched:7d`, limit: 1 };
    const first = await searchBlips(actor, input);
    expect(cursorSchema.safeParse(first.nextCursor).success).toBe(true);
    const decoded = must(decodeCursor(must(first.nextCursor)));
    for (const patch of [
      { searchAt: 'not-a-date' },
      { searchAt: '2026-02-31T00:00:00.000Z' },
      { searchKey: undefined },
      { searchAt: new Date(0).toISOString() },
    ]) {
      await expect(
        searchBlips(actor, { ...input, cursor: encodeCursor({ ...decoded, ...patch }) }),
      ).rejects.toThrow(/cursor|context/i);
    }
    await expect(
      searchBlips(actor, {
        ...input,
        q: `in:${radar.id} touched:8d`,
        cursor: must(first.nextCursor),
      }),
    ).rejects.toThrow(/context changed/i);
    const { searchAt: _at, searchKey: _key, ...legacy } = decoded;
    const second = await searchBlips(actor, { ...input, cursor: encodeCursor(legacy) });
    expect(second.items).toHaveLength(1);
    expect(decodeCursor(must(second.nextCursor))?.['searchAt']).toBeTypeOf('string');
    expect(decodeCursor(must(second.nextCursor))?.['searchKey']).toMatch(/^[a-f0-9]{64}$/);
  });

  for (const prefer of [false, true]) {
    for (const field of ['after', 'touched', 'before', 'stale']) {
      it(`anchors ${field}:7d across a day between pages${prefer ? ' with radar priority' : ''}`, async () => {
        const now = new Date();
        const atDaysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
        const radar = await createRadar(actor, { name: `${field} window ${String(prefer)}` });
        const recent = field === 'after' || field === 'touched';
        const fixtures = recent
          ? [
              { age: 1, pinned: true, body: 'First page' },
              { age: 6.5, pinned: false, body: 'Original second match' },
            ]
          : [
              { age: 10, pinned: true, body: 'First page' },
              { age: 12, pinned: false, body: 'Original second match' },
              { age: 6.5, pinned: false, body: 'Not in the original window' },
            ];
        const rows = await getDb()
          .insert(schema.blips)
          .values(
            fixtures.map((row) => ({
              radarId: radar.id,
              body: row.body,
              pinned: row.pinned,
              createdAt: atDaysAgo(row.age),
              updatedAt: atDaysAgo(row.age),
            })),
          )
          .returning({ id: schema.blips.id });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
        const input = {
          q: `in:${radar.id} ${field}:7d`,
          ...(prefer ? { preferRadarId: radar.id } : {}),
          limit: 1,
        };
        const first = await searchBlips(actor, input);
        expect(first.items.map((item) => item.id)).toEqual([must(rows[0]).id]);
        expect(first.nextCursor).not.toBeNull();
        vi.setSystemTime(new Date(now.getTime() + 86_400_000));
        const second = await searchBlips(actor, { ...input, cursor: must(first.nextCursor) });
        expect(second.items.map((item) => item.id)).toEqual([must(rows[1]).id]);
        expect(second.filters).toEqual(first.filters);
        expect(second.nextCursor).toBeNull();
      });
    }
  }
});

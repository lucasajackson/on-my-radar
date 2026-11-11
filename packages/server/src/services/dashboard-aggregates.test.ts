import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from './blips.js';
import { aggregateDashboardQuery } from './dashboard-aggregates.js';
import { createRadar, removeMember, shareRadar } from './radars.js';
import { searchBlips } from './search.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';
import { must } from '../errors.js';

describe.skipIf(!process.env['DATABASE_URL'])('exact dashboard aggregates', () => {
  const database = `omr_dashboard_aggregates_${Date.now()}`;
  let admin: pg.Pool;
  let owner: Actor;
  let other: Actor;

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
        SESSION_SECRET: 'dashboard-aggregates-test-secret-not-used-in-production',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const actors: Actor[] = [];
    for (const label of ['owner', 'other']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@dashboard-aggregates.test`, state: 'active' })
        .returning();
      actors.push({ user: must(user), kind: 'user' });
    }
    [owner, other] = actors as [Actor, Actor];
  }, 30_000);

  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('counts the full matching set beyond the page limit without returning bodies for a tile', async () => {
    const radar = await createRadar(owner, { name: 'Many captures' });
    await getDb()
      .insert(schema.blips)
      .values(
        Array.from({ length: 125 }, (_, index) => ({
          radarId: radar.id,
          authorId: owner.user.id,
          body: `Full count fixture ${index}`,
          tags: index < 120 ? ['count-fixture'] : ['excluded'],
        })),
      );
    const query = `in:${radar.id} tag:count-fixture`;
    const tile = await aggregateDashboardQuery(owner, { query, display: 'count', limit: 1 });
    expect(tile.total).toBe(120);
    expect(tile.items).toEqual([]);
    expect(tile.nextCursor).toBeNull();
    const list = await aggregateDashboardQuery(owner, { query, limit: 5 });
    expect(list.total).toBe(120);
    expect(list.items).toHaveLength(5);
    expect(list.nextCursor).not.toBeNull();
  });

  it('returns a list cursor that keeps its relative window when continued through Search', async () => {
    const now = new Date();
    const radar = await createRadar(owner, { name: 'Dashboard cursor continuation' });
    const fixtures = [1, 6.5].map((days) => ({
      radarId: radar.id,
      body: `Window match ${days}`,
      createdAt: new Date(now.getTime() - days * 86_400_000),
      updatedAt: new Date(now.getTime() - days * 86_400_000),
    }));
    const rows = await getDb().insert(schema.blips).values(fixtures).returning();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      const query = `in:${radar.id} touched:7d`;
      const first = await aggregateDashboardQuery(owner, { query, limit: 1 });
      expect(first.total).toBe(2);
      expect(first.items.map((row) => row.id)).toEqual([must(rows[0]).id]);
      expect(first.nextCursor).not.toBeNull();
      vi.setSystemTime(new Date(now.getTime() + 86_400_000));
      const next = await searchBlips(owner, { q: query, limit: 1, cursor: must(first.nextCursor) });
      expect(next.items.map((row) => row.id)).toEqual([must(rows[1]).id]);
      expect(next.filters).toEqual(first.filters);
    } finally {
      vi.useRealTimers();
    }
  });

  it('groups only the authorized matching rows, with subtotals independent of visible rows', async () => {
    const a = await createRadar(owner, { name: 'Subtotal one' });
    const b = await createRadar(other, { name: 'Subtotal shared' });
    const secret = await createRadar(other, { name: 'Subtotal secret' });
    await shareRadar(other, b.id, owner.user.email, 'viewer');
    for (const [actor, radarId, quantity] of [
      [owner, a.id, 3],
      [other, b.id, 2],
      [other, secret.id, 7],
    ] as const) {
      for (let index = 0; index < quantity; index++) {
        await createBlip(actor, radarId, { body: `Group result ${index} #subtotals` });
      }
    }
    const result = await aggregateDashboardQuery(owner, {
      query: 'tag:subtotals',
      groupByRadar: true,
      limit: 1,
    });
    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(1);
    expect(result.radarGroups).toEqual([
      { radarId: a.id, name: a.name, total: 3 },
      { radarId: b.id, name: b.name, total: 2 },
    ]);
    await removeMember(other, b.id, owner.user.id);
    const revoked = await aggregateDashboardQuery(owner, {
      query: 'tag:subtotals',
      display: 'count',
      groupByRadar: true,
    });
    expect(revoked.total).toBe(3);
    expect(revoked.radarGroups?.map((group) => group.radarId)).toEqual([a.id]);
    const noMatch = await aggregateDashboardQuery(owner, {
      query: `in:${secret.id}`,
      display: 'lanes',
    });
    expect(noMatch.unresolved).toBe(true);
    expect(noMatch.total).toBe(0);
    expect(noMatch.laneGroups).toEqual([]);
    expect(JSON.stringify(noMatch)).not.toContain(secret.name);
  });

  it('shares search predicates for negation, OR, body links and activity filters', async () => {
    const radar = await createRadar(owner, { name: 'Predicate parity' });
    await createBlip(owner, radar.id, { body: 'Investigate https://example.com/docs #bug' });
    await createBlip(owner, radar.id, {
      body: 'Clean up https://example.com/old #techdebt #archived',
    });
    await createBlip(owner, radar.id, { body: 'No outbound reference #bug' });
    const query = `in:${radar.id} tag:bug|techdebt -tag:archived has:link touched:7d`;
    const list = await searchBlips(owner, { q: query, limit: 50 });
    const aggregate = await aggregateDashboardQuery(owner, { query, display: 'count' });
    expect(list.problems).toEqual([]);
    expect(list.items).toHaveLength(1);
    expect(aggregate.total).toBe(list.items.length);
    // Separate calls resolve relative dates at their own instants. The field
    // meaning and raw tokens match; their millisecond cutoffs need not.
    expect(aggregate.filters.map(({ field, raw, resolved }) => ({ field, raw, resolved }))).toEqual(
      list.filters.map(({ field, raw, resolved }) => ({ field, raw, resolved })),
    );
    expect(aggregate.radarsSearched).toBe(list.radarsSearched);
  });

  it('topic membership and access changes flow into aggregates on every read', async () => {
    const topic = await createTopic(other, { name: 'Aggregate projects' });
    await setCascade(other, topic.id, true);
    await shareTopic(other, topic.id, owner.user.email, 'viewer');
    const first = await createRadar(other, { name: 'First topic project', topicId: topic.id });
    const second = await createRadar(other, { name: 'Later topic project' });
    await createBlip(other, first.id, { body: 'First capture' });
    await createBlip(other, second.id, { body: 'Later capture' });
    const query = `topic:"${topic.name}"`;
    expect((await aggregateDashboardQuery(owner, { query, display: 'count' })).total).toBe(1);
    await setRadarTopic(other, second.id, topic.id);
    expect((await aggregateDashboardQuery(owner, { query, display: 'count' })).total).toBe(2);
    await setCascade(other, topic.id, false);
    expect((await aggregateDashboardQuery(owner, { query, display: 'count' })).total).toBe(0);
  });

  it('preserves board lane vocabulary, zero lanes, and unassigned historical rows', async () => {
    const board = await createRadar(owner, { name: 'Lane distribution', template: 'kanban' });
    await createBlip(owner, board.id, { body: 'Waiting', status: 'backlog' });
    await createBlip(owner, board.id, { body: 'Working', status: 'doing' });
    await getDb()
      .insert(schema.blips)
      .values({ radarId: board.id, authorId: owner.user.id, body: 'Legacy unassigned' });
    const result = await aggregateDashboardQuery(owner, {
      query: `in:${board.id}`,
      display: 'lanes',
      groupByRadar: true,
    });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(3);
    expect(result.laneGroups?.map((lane) => [lane.status, lane.label, lane.total])).toEqual([
      ['backlog', 'Backlog', 1],
      ['todo', 'To do', 0],
      ['doing', 'In progress', 1],
      ['blocked', 'Blocked', 0],
      ['done', 'Done', 0],
      [null, 'No lane', 1],
    ]);
    expect(result.radarGroups?.[0]?.total).toBe(3);
    expect(result.laneGroups?.reduce((sum, lane) => sum + lane.total, 0)).toBe(result.total);
  });

  it('does not seed unrelated visible boards into a topic distribution', async () => {
    const topic = await createTopic(owner, { name: 'Distribution project' });
    const included = await createRadar(owner, {
      name: 'Included board',
      template: 'kanban',
      topicId: topic.id,
    });
    const unrelated = await createRadar(owner, { name: 'Unrelated board', template: 'kanban' });
    await createBlip(owner, included.id, { body: 'Included project work' });
    await createBlip(owner, unrelated.id, { body: 'Another project' });
    const result = await aggregateDashboardQuery(owner, {
      query: `topic:${topic.id}`,
      display: 'lanes',
    });
    expect(result.total).toBe(1);
    expect(new Set(result.laneGroups?.map((lane) => lane.radarId))).toEqual(new Set([included.id]));
    expect(result.laneGroups?.find((lane) => lane.status === 'done')?.total).toBe(0);
    const empty = await aggregateDashboardQuery(owner, {
      query: `topic:${topic.id} tag:unmatched`,
      display: 'lanes',
    });
    expect(empty.total).toBe(0);
    expect(empty.laneGroups).toEqual([]);
  });

  it('labels custom lanes from the source radar and keeps their configured order', async () => {
    const board = await createRadar(owner, {
      name: 'Custom lane vocabulary',
      template: 'kanban',
      templateConfig: {
        lanes: [
          { id: 'review', label: 'Peer review', state: 'active' },
          { id: 'delivered', label: 'Delivered', state: 'done', terminal: true },
        ],
        defaultStatus: 'review',
      },
    });
    await createBlip(owner, board.id, { body: 'Review this change' });
    const result = await aggregateDashboardQuery(owner, {
      query: `in:${board.id}`,
      display: 'lanes',
    });
    expect(result.laneGroups?.map((lane) => [lane.status, lane.label, lane.total])).toEqual([
      ['review', 'Peer review', 1],
      ['delivered', 'Delivered', 0],
    ]);
  });

  it('counts UTC capture buckets with zero days, an explicit bounded range and no future spill', async () => {
    const radar = await createRadar(owner, { name: 'Capture calendar' });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const times = [0, -1, -1, -6, -7, 1].map((offset) => {
      const time = new Date(today);
      time.setUTCDate(time.getUTCDate() + offset);
      return time;
    });
    await getDb()
      .insert(schema.blips)
      .values(times.map((createdAt) => ({ radarId: radar.id, body: 'A capture', createdAt })));
    const result = await aggregateDashboardQuery(owner, {
      query: `in:${radar.id}`,
      display: 'activity',
      activityDays: 7,
    });
    expect(result.total).toBe(6);
    expect(result.items).toEqual([]);
    expect(result.activity).toHaveLength(7);
    expect(result.activity?.map((day) => day.count)).toEqual([1, 0, 0, 0, 0, 2, 1]);
    expect(result.activity?.at(-1)?.date).toBe(today.toISOString().slice(0, 10));
    expect(result.activityRange?.timezone).toBe('UTC');
    expect(result.activityRange?.from).toBe(must(times[3]).toISOString());
    expect(result.activityRange?.to).toBe(must(times[5]).toISOString());
    const filtered = await aggregateDashboardQuery(owner, {
      query: `in:${radar.id} before:${today.toISOString().slice(0, 10)}`,
      display: 'activity',
      activityDays: 7,
    });
    expect(filtered.total).toBe(4);
    expect(filtered.activity?.at(-1)?.count).toBe(0);
    expect(filtered.activity?.reduce((sum, day) => sum + day.count, 0)).toBe(3);
  });

  it('shows archived matches unless the same query explicitly excludes them', async () => {
    const radar = await createRadar(owner, { name: 'Archive totals', template: 'kanban' });
    const blip = await createBlip(owner, radar.id, { body: 'Old finished work', status: 'done' });
    await getDb()
      .update(schema.blips)
      .set({
        createdAt: sql`now() - interval '90 days'`,
        updatedAt: sql`now() - interval '90 days'`,
      })
      .where(eq(schema.blips.id, blip.id));
    expect(
      (await aggregateDashboardQuery(owner, { query: `in:${radar.id}`, display: 'count' })).total,
    ).toBe(1);
    expect(
      (await aggregateDashboardQuery(owner, { query: `in:${radar.id} is:live`, display: 'count' }))
        .total,
    ).toBe(0);
    expect(
      (
        await aggregateDashboardQuery(owner, {
          query: `in:${radar.id} is:archived`,
          display: 'count',
        })
      ).total,
    ).toBe(1);
  });

  it('keeps malformed and unresolved filters explicit, and bounds requested chart windows', async () => {
    const malformed = await aggregateDashboardQuery(owner, {
      query: 'touched:bananas',
      display: 'count',
    });
    expect(malformed.problems.length).toBeGreaterThan(0);
    expect(malformed.total).toBe(0);
    const unresolved = await aggregateDashboardQuery(owner, {
      query: 'in:"There is no such radar"',
      display: 'activity',
      activityDays: 7,
    });
    expect(unresolved.unresolved).toBe(true);
    expect(unresolved.total).toBe(0);
    expect(unresolved.activity).toHaveLength(7);
    expect(unresolved.activity?.every((day) => day.count === 0)).toBe(true);
    await expect(
      aggregateDashboardQuery(owner, { query: '', display: 'activity', activityDays: 999 as 7 }),
    ).rejects.toThrow();
  });
});

import { cursorSchema, type SearchResultDto } from '@onmyradar/contract';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { getDb, closeDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor, AppEnv } from '../http.js';
import { searchRoutes } from '../routes/search.js';
import { createRadar, createSmartRadar } from './radars.js';
import { createBlip } from './blips.js';
import { searchBlips } from './search.js';
import { must } from '../errors.js';

describe.skipIf(!process.env['DATABASE_URL'])('exact search scope (isolated postgres)', () => {
  const database = `omr_searchscope_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let owner: Actor;
  let privateRadar: string;
  let primary: string;
  let other: string;
  let smart: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'isolated-search-scope-test-secret',
      }),
    );
    await runMigrations();
    const users = await getDb()
      .insert(schema.users)
      .values([
        { email: 'scope-owner@example.test', state: 'active' },
        { email: 'scope-stranger@example.test', state: 'active' },
      ])
      .returning();
    owner = { kind: 'user', user: must(users[0]) };
    const stranger: Actor = { kind: 'user', user: must(users[1]) };
    primary = (await createRadar(owner, { name: 'Primary scope' })).id;
    other = (await createRadar(owner, { name: 'Other scope' })).id;
    privateRadar = (await createRadar(stranger, { name: 'Private scope' })).id;
    await createBlip(owner, primary, { body: 'Scopeproof first #keep' });
    await createBlip(owner, primary, { body: 'Scopeproof second #skip' });
    await createBlip(owner, other, { body: 'Scopeproof elsewhere #keep' });
    await createBlip(stranger, privateRadar, { body: 'Scopeproof private #keep' });
    smart = (
      await createSmartRadar(owner, {
        name: 'Saved scope',
        filter: { radarIds: [primary], tags: ['keep'], match: 'all' },
      })
    ).id;
  });
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });
  function app(actor: Actor | null = owner) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      if (actor) c.set('actor', actor);
      await next();
    });
    app.route('/api/search', searchRoutes);
    return app;
  }
  it('accepts exact physical scope through the HTTP query schema and honors preview limits', async () => {
    const response = await app().request(`/api/search?q=scopeproof&radarId=${primary}&limit=1`);
    expect(response.status).toBe(200);
    const first = (await response.json()) as SearchResultDto;
    expect(first.items).toHaveLength(1);
    expect(must(first.items[0]).radarId).toBe(primary);
    expect(first.nextCursor).toBeTruthy();
    const next = await app().request(
      `/api/search?q=scopeproof&radarId=${primary}&limit=1&cursor=${must(first.nextCursor, 'first.nextCursor')}`,
    );
    const second = (await next.json()) as SearchResultDto;
    expect(second.items).toHaveLength(1);
    expect(must(second.items[0]).radarId).toBe(primary);
    expect(must(second.items[0]).id).not.toBe(must(first.items[0]).id);
  });
  it('intersects smart saved filters and subsequent in tokens without widening scope', async () => {
    const response = await app().request(`/api/search?q=scopeproof&radarId=${smart}&limit=5`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as SearchResultDto;
    expect(result.items).toHaveLength(1);
    expect(must(result.items[0]).radarId).toBe(primary);
    expect(must(result.items[0]).tags).toContain('keep');
    expect(must(result.filters[0]).resolved).toBe(true);
    expect(
      (await searchBlips(owner, { q: `scopeproof in:${other}`, radarId: smart })).items,
    ).toHaveLength(0);
  });
  it('preserves explicit MCP scope precedence over a competing input scope', async () => {
    const result = await searchBlips(
      owner,
      { q: 'scopeproof', radarId: other },
      { radarId: primary },
    );
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.radarId === primary)).toBe(true);
    await expect(
      searchBlips(owner, { q: 'scopeproof', radarId: primary }, { radarId: privateRadar }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('requires an active actor and returns404 for unreadable or nonexistent radar scopes', async () => {
    for (const radarId of [privateRadar, randomUUID()])
      expect((await app().request(`/api/search?q=scopeproof&radarId=${radarId}`)).status).toBe(404);
    expect((await app(null).request('/api/search?q=scopeproof')).status).toBe(401);
    expect(
      (
        await app({ ...owner, user: { ...owner.user, state: 'suspended' } }).request(
          '/api/search?q=scopeproof',
        )
      ).status,
    ).toBe(403);
    expect((await app().request('/api/search?q=scopeproof&radarId=not-a-uuid')).status).toBe(400);
  });
  it('prefers current-radar matches over a stronger external match without restricting results', async () => {
    const current = await createRadar(owner, { name: 'Preferred physical' });
    const elsewhere = await createRadar(owner, { name: 'Preferred elsewhere' });
    const local = await createBlip(owner, current.id, { body: 'A quiet priorityproof mention' });
    const external = await createBlip(owner, elsewhere.id, {
      body: 'priorityproof',
      title: 'priorityproof',
    });
    expect(must((await searchBlips(owner, { q: 'priorityproof' })).items[0]).id).toBe(external.id);
    const response = await app().request(
      `/api/search?q=priorityproof&preferRadarId=${current.id}&limit=5`,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as SearchResultDto;
    expect(result.items.map((item) => item.id)).toEqual([local.id, external.id]);
    expect(result.preferredRadar).toEqual({ id: current.id, name: current.name });
    expect(result.preferredBlipIds).toEqual([local.id]);
    const constrained = await searchBlips(owner, {
      q: 'priorityproof',
      radarId: elsewhere.id,
      preferRadarId: current.id,
    });
    expect(constrained.items.map((item) => item.id)).toEqual([external.id]);
    expect(constrained.preferredBlipIds).toEqual([]);
  });
  it('prioritizes only actual smart saved-filter matches while retaining other accessible matches', async () => {
    const response = await app().request(`/api/search?q=scopeproof&preferRadarId=${smart}&limit=5`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as SearchResultDto;
    expect(result.items).toHaveLength(3);
    expect(result.preferredBlipIds).toHaveLength(1);
    const first = must(result.items[0]);
    expect(first.radarId).toBe(primary);
    expect(first.tags).toContain('keep');
    expect(result.preferredBlipIds).toEqual([first.id]);
    expect(result.items.some((item) => item.radarId === other)).toBe(true);
    expect(result.items.some((item) => item.tags.includes('skip'))).toBe(true);
    const empty = await createSmartRadar(owner, {
      name: 'Empty preferred query',
      filter: { tags: ['absent-preference-tag'], match: 'all' },
    });
    const fallback = await searchBlips(owner, { q: 'scopeproof', preferRadarId: empty.id });
    expect(fallback.items).toHaveLength(3);
    expect(fallback.preferredBlipIds).toEqual([]);
  });
  it('pages across priority boundaries without duplicate or missing rows for relevance and recent order', async () => {
    const current = await createRadar(owner, { name: 'Paged preference' });
    const elsewhere = await createRadar(owner, { name: 'Paged elsewhere' });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const blip = await createBlip(owner, i < 3 ? current.id : elsewhere.id, {
        body: 'pagingpriorityproof #pagingpriorityproof',
      });
      ids.push(blip.id);
      await getDb()
        .update(schema.blips)
        .set({
          createdAt: sql`'2026-09-19T12:00:00Z'::timestamptz + ${i} * interval '1 microsecond'`,
          pinned: i === 4,
        })
        .where(eq(schema.blips.id, blip.id));
    }
    for (const q of ['pagingpriorityproof', 'tag:pagingpriorityproof']) {
      const full = await searchBlips(owner, { q, preferRadarId: current.id, limit: 50 });
      expect(full.items).toHaveLength(7);
      const collected: string[] = [];
      let cursor: string | undefined;
      const preferred: string[] = [];
      do {
        const page = await searchBlips(owner, {
          q,
          preferRadarId: current.id,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...page.items.map((item) => item.id));
        preferred.push(...(page.preferredBlipIds ?? []));
        cursor = page.nextCursor ?? undefined;
        if (cursor) expect(cursorSchema.safeParse(cursor).success).toBe(true);
        expect(collected.length).toBeLessThanOrEqual(7);
      } while (cursor);
      expect(collected).toEqual(full.items.map((item) => item.id));
      expect(new Set(collected).size).toBe(7);
      expect(new Set(collected)).toEqual(new Set(ids));
      expect(preferred).toEqual(full.preferredBlipIds);
      expect(collected.slice(0, 3).every((id) => preferred.includes(id))).toBe(true);
    }
  });
  it('binds priority cursors to their context and preserves old unprioritized paging', async () => {
    const first = await searchBlips(owner, { q: 'scopeproof', preferRadarId: primary, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    for (const input of [
      { q: 'scopeproof', preferRadarId: other },
      { q: 'scopeproof tag:keep', preferRadarId: primary },
      { q: 'scopeproof' },
    ])
      await expect(
        searchBlips(owner, { ...input, cursor: must(first.nextCursor) }),
      ).rejects.toMatchObject({ status: 400 });
    const legacy = await searchBlips(owner, { q: 'scopeproof', limit: 1 });
    expect(
      (await searchBlips(owner, { q: 'scopeproof', cursor: must(legacy.nextCursor), limit: 1 }))
        .items,
    ).toHaveLength(1);
    await expect(
      searchBlips(owner, {
        q: 'scopeproof',
        preferRadarId: primary,
        cursor: must(legacy.nextCursor),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const smartFirst = await searchBlips(owner, {
      q: 'scopeproof',
      preferRadarId: smart,
      limit: 1,
    });
    await getDb()
      .update(schema.radars)
      .set({ filter: { radarIds: [primary], tags: ['skip'], match: 'all' } })
      .where(eq(schema.radars.id, smart));
    await expect(
      searchBlips(owner, {
        q: 'scopeproof',
        preferRadarId: smart,
        cursor: must(smartFirst.nextCursor),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('refuses unreadable, nonexistent and malformed preference identifiers without revealing metadata', async () => {
    for (const preferRadarId of [privateRadar, randomUUID()])
      expect(
        (await app().request(`/api/search?q=scopeproof&preferRadarId=${preferRadarId}`)).status,
      ).toBe(404);
    expect((await app().request('/api/search?q=scopeproof&preferRadarId=not-a-uuid')).status).toBe(
      400,
    );
  });
});

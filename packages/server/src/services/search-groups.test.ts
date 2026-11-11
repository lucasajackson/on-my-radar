import { LIMITS } from '@onmyradar/contract';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { getDb, closeDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createRadar, createSmartRadar } from './radars.js';
import { createBlip } from './blips.js';
import { createComment } from './comments.js';
import { createTopic, setRadarTopic, shareTopic } from './topics.js';
import { searchBlips } from './search.js';
import { must } from '../errors.js';

describe.skipIf(!process.env['DATABASE_URL'])(
  'structured filter groups (isolated postgres)',
  () => {
    const database = `omr_searchgroups_${randomUUID().replaceAll('-', '')}`;
    let admin: pg.Pool;
    let owner: Actor;
    let stranger: Actor;
    let primary: string;
    let other: string;
    let hidden: string;
    let bug: string;
    let debt: string;
    let both: string;
    let plain: string;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(must(process.env['DATABASE_URL']));
      url.pathname = `/${database}`;
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: url.toString(),
          SESSION_SECRET: 'isolated-query-group-secret-not-production',
        }),
      );
      await runMigrations();
      const users = await getDb()
        .insert(schema.users)
        .values([
          { email: 'owner@query-groups.test', state: 'active' },
          { email: 'stranger@query-groups.test', state: 'active' },
        ])
        .returning();
      owner = { kind: 'user', user: must(users[0]) };
      stranger = { kind: 'user', user: must(users[1]) };
      primary = (await createRadar(owner, { name: 'Engineering', commentsEnabled: true })).id;
      other = (await createRadar(owner, { name: 'Elsewhere' })).id;
      hidden = (await createRadar(stranger, { name: 'Secret engineering' })).id;
      bug = (await createBlip(owner, primary, { body: 'groupproof bug #bug', state: 'active' })).id;
      debt = (
        await createBlip(owner, primary, { body: 'groupproof debt #techdebt', state: 'later' })
      ).id;
      both = (
        await createBlip(owner, other, { body: 'groupproof both #bug #techdebt', state: 'done' })
      ).id;
      plain = (await createBlip(owner, other, { body: 'groupproof plain' })).id;
      await createBlip(stranger, hidden, { body: 'groupproof hidden #bug' });
    });
    afterAll(async () => {
      await closeDb();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    });
    async function ids(q: string) {
      return new Set((await searchBlips(owner, { q })).items.map((row) => row.id));
    }

    it('combines pipe alternatives, conjunction and negative groups while retaining repeated legacy unions', async () => {
      expect(await ids('groupproof tag:bug|techdebt')).toEqual(new Set([bug, debt, both]));
      expect(await ids('groupproof tag:bug tag:techdebt')).toEqual(new Set([both]));
      expect(await ids('groupproof -tag:bug|techdebt')).toEqual(new Set([plain]));
      expect(await ids('groupproof tag:bug|techdebt not:tag:techdebt')).toEqual(new Set([bug]));
      expect(await ids(`groupproof in:${primary}|${other} -in:${other}`)).toEqual(
        new Set([bug, debt]),
      );
      expect(await ids(`groupproof in:${primary} in:${other}`)).toEqual(
        new Set([bug, debt, both, plain]),
      );
      expect(await ids('groupproof is:active is:later')).toEqual(new Set([bug, debt]));
      expect(await ids('groupproof is:active|pinned')).toEqual(new Set([bug]));
      const interpretation = await searchBlips(owner, { q: 'groupproof is:pinned is:unpinned' });
      expect(interpretation.items).toHaveLength(4);
      expect(interpretation.combinationRules?.join(' ')).toContain('last positive token');
    });

    it('applies the ninth in: token instead of silently dropping it', async () => {
      const names: string[] = [];
      for (let index = 0; index < 9; index++)
        names.push((await createRadar(owner, { name: `Ninth ${index}` })).id);
      const ninth = await createBlip(owner, must(names[8]), { body: 'ninthfilterproof' });
      const result = await searchBlips(owner, {
        q: 'ninthfilterproof ' + names.map((id) => `in:${id}`).join(' '),
      });
      expect(result.problems).toEqual([]);
      expect(result.items.map((row) => row.id)).toEqual([ninth.id]);
      expect(result.filters).toHaveLength(9);
    });

    it('refuses malformed filters and excess tokens rather than returning an unfiltered match set', async () => {
      for (const q of [
        'groupproof is:nonsense',
        'groupproof tag:bug||techdebt',
        'groupproof not:nope:value',
        `groupproof ${Array(LIMITS.searchFiltersPerField + 1)
          .fill(`in:${primary}`)
          .join(' ')}`,
      ]) {
        const result = await searchBlips(owner, { q });
        expect(result.items, q).toEqual([]);
        expect(result.unresolved, q).toBe(true);
        expect(result.problems.length).toBeGreaterThan(0);
      }
      for (const prefix of ['in:', '-in:', 'not:in:']) {
        const absent = await searchBlips(owner, {
          q: `groupproof ${prefix}00000000-0000-0000-0000-000000000001`,
        });
        const privateResult = await searchBlips(owner, { q: `groupproof ${prefix}${hidden}` });
        expect(privateResult.items).toEqual([]);
        expect(privateResult.unresolved).toBe(true);
        expect(privateResult.problems[0]?.message.replace(hidden, 'ID')).toBe(
          absent.problems[0]?.message.replace('00000000-0000-0000-0000-000000000001', 'ID'),
        );
      }
    });

    it('evaluates topic membership dynamically and cannot use a visible topic to widen radar access', async () => {
      const topic = await createTopic(stranger, { name: 'Shared topic' });
      await setRadarTopic(stranger, hidden, topic.id);
      await shareTopic(stranger, topic.id, owner.user.email, 'viewer');
      expect(await ids(`groupproof topic:${topic.id}`)).toEqual(new Set());
      const ownedTopic = await createTopic(owner, { name: 'Dynamic work' });
      await setRadarTopic(owner, primary, ownedTopic.id);
      expect(await ids(`groupproof topic:${ownedTopic.id}`)).toEqual(new Set([bug, debt]));
      expect(
        (await searchBlips(owner, { q: `groupproof topic:${ownedTopic.id}` })).radarsSearched,
      ).toBe(1);
      await setRadarTopic(owner, other, ownedTopic.id);
      expect(await ids('groupproof topic:"Dynamic work"')).toEqual(
        new Set([bug, debt, both, plain]),
      );
      expect(await ids('groupproof array:"Dynamic work"')).toEqual(
        await ids('groupproof topic:"Dynamic work"'),
      );
      await setRadarTopic(owner, primary, null);
      expect(await ids(`groupproof -array:${ownedTopic.id}`)).toEqual(new Set([bug, debt]));
      expect(await ids(`groupproof -topic:${ownedTopic.id}`)).toEqual(new Set([bug, debt]));
      const privateTopic = await createTopic(stranger, { name: 'Private topic' });
      const result = await searchBlips(owner, { q: `groupproof -topic:${privateTopic.id}` });
      expect(result.unresolved).toBe(true);
      expect(result.items).toEqual([]);
    });

    it('has:link finds stored URLs and HTTP/mailto links embedded in prose and notes', async () => {
      const stored = await createBlip(owner, primary, { body: 'https://example.test/stored' });
      const prose = await createBlip(owner, primary, {
        body: 'Read [the guide](https://example.test/guide) before starting.',
      });
      const mailto = await createBlip(owner, primary, {
        body: 'Contact [editor](mailto:editor@example.test)',
      });
      const noLink = await createBlip(owner, primary, { body: 'No links in this paragraph.' });
      for (const body of [
        'Use https://) as the placeholder',
        'Example protocol is https://"',
        'The namespace xmailto:not-an-address',
      ])
        await createBlip(owner, primary, { body });
      const positives = await ids(`in:${primary} has:link`);
      expect(positives).toEqual(new Set([stored.id, prose.id, mailto.id]));
      expect((await ids(`in:${primary} -has:link`)).has(noLink.id)).toBe(true);
      expect((await ids(`in:${primary} -has:link`)).has(prose.id)).toBe(false);
    });

    it('touched and stale use edits and new comments instead of capture time, including complementary negation', async () => {
      const old = await createBlip(owner, primary, { body: 'activityproof untouched' });
      const edited = await createBlip(owner, primary, { body: 'activityproof edited' });
      const replied = await createBlip(owner, primary, { body: 'activityproof replied' });
      const cutoff = new Date(Date.now() - 40 * 86400_000);
      for (const blip of [old, edited, replied])
        await getDb()
          .update(schema.blips)
          .set({ createdAt: cutoff, updatedAt: cutoff })
          .where(eq(schema.blips.id, blip.id));
      await getDb()
        .update(schema.blips)
        .set({ updatedAt: new Date() })
        .where(eq(schema.blips.id, edited.id));
      await createComment(owner, replied.id, { body: 'Fresh activity' });
      expect(await ids('activityproof touched:7d')).toEqual(new Set([edited.id, replied.id]));
      expect(await ids('activityproof stale:30d')).toEqual(new Set([old.id]));
      expect(await ids('activityproof -touched:7d')).toEqual(new Set([old.id]));
      expect(await ids('activityproof -stale:30d')).toEqual(new Set([edited.id, replied.id]));
      expect(await ids('activityproof after:7d')).toEqual(new Set());
    });

    it('keeps smart intersections, negative author NULL semantics and priority pagination intact', async () => {
      const smart = await createSmartRadar(owner, {
        name: 'Scoped query groups',
        filter: { tags: ['bug'], radarIds: [primary] },
      });
      const result = await searchBlips(owner, {
        q: 'groupproof tag:bug|techdebt -tag:techdebt',
        radarId: smart.id,
      });
      expect(result.items.map((row) => row.id)).toEqual([bug]);
      // The creator is fixed (0095); the escape setting is how a fixture orphans one.
      await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('omr.blip_reauthor', 'on', true)`);
        await tx.update(schema.blips).set({ authorId: null }).where(eq(schema.blips.id, plain));
      });
      expect(await ids(`groupproof -from:${owner.user.id}`)).toEqual(new Set([plain]));
      const first = await searchBlips(owner, {
        q: 'groupproof -tag:absent',
        preferRadarId: primary,
        limit: 1,
      });
      const all = [must(first.items[0]).id];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await searchBlips(owner, {
          q: 'groupproof -tag:absent',
          preferRadarId: primary,
          limit: 1,
          cursor,
        });
        all.push(...page.items.map((row) => row.id));
        cursor = page.nextCursor;
      }
      expect(new Set(all)).toEqual(new Set([bug, debt, both, plain]));
      expect(all).toHaveLength(4);
      await expect(
        searchBlips(owner, {
          q: 'groupproof tag:absent',
          preferRadarId: primary,
          cursor: must(first.nextCursor),
        }),
      ).rejects.toThrow(/context changed/i);
      // An impossible typed value is bound as data, not interpolated into a SQL predicate.
      expect(await ids("groupproof -tag:';DROP_TABLE_blips;--")).toEqual(
        new Set([bug, debt, both, plain]),
      );
      expect((await getDb().execute(sql`SELECT count(*) FROM blips`)).rowCount).toBe(1);
    });
  },
);

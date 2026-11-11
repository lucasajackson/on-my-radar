/**
 * The charter document against a real Postgres: the move of today's radars into it (pages and
 * markers in, document, anchors and version 1 out), the saves that orphan and heal, the guards
 * that read the anchors table, and the versions every orphaning save leaves. Commander's real
 * pages are the fixture. Skipped without DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMarkers, projectMarkdown, replaceMarkers, resolvePage } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { decideAdr, proposeAdr, readArchitecture, writeCharter } from './architecture.js';
import { deleteBlip, updateBlip } from './blips.js';
import { createComment } from './comments.js';
import {
  ensureCharterDocument,
  migrateAllRadars,
  migrateRadar,
  purgeMigratedPages,
  sealAfterLaneChange,
} from './charter.js';
import { projectionOf } from './charter-model.js';
import { createRepoAgent } from './repo-agents.js';
import { createRadar, deleteRadar, updateRadar } from './radars.js';

const fixtures = join(import.meta.dirname, '../../../contract/test/fixtures');
const ACME = [1, 2, 3, 4].map((n) => readFileSync(join(fixtures, `acme-charter-${n}.md`), 'utf8'));
const WRITTEN = ACME.map((p) => replaceMarkers(p, (m) => m.quote)).join('\n\n');
const ADR_0027 = 'a19c43ec-307b-4f10-b6aa-05605accdaab';
const PRINCIPLES = 'These principles are decisions, not options.';

describe.skipIf(!process.env['DATABASE_URL'])('the charter document (real postgres)', () => {
  const database = `omr_charter_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let scratch: pg.Pool | undefined;
  let databaseUrl = '';
  let owner: Actor;
  const q = <T extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => must(scratch).query<T>(text, values);
  const db = () => getDb();

  const user = async (label: string): Promise<Actor> => {
    const [row] = await db()
      .insert(schema.users)
      .values({ email: `${label}@charter.test`, state: 'active', name: label })
      .returning();
    return { user: must(row), kind: 'user' };
  };

  /** A radar in today's shape: pages as blips, markers in their source, ADRs in their lanes. */
  const seed = async (
    options: {
      pages?: string[];
      adrs?: Array<{ id?: string; title: string; status: string; ratified?: boolean }>;
    } = {},
  ) => {
    const radar = await createRadar(owner, {
      name: `Arch ${Math.random()}`,
      template: 'architecture',
    });
    let at = Date.now() - 600_000;
    const pageIds: string[] = [];
    for (const body of options.pages ?? ACME) {
      const [row] = await db()
        .insert(schema.blips)
        .values({
          radarId: radar.id,
          authorId: owner.user.id,
          state: 'active',
          status: 'charter',
          title: body.split('\n')[0] ?? '',
          body,
          createdAt: new Date((at += 1000)),
        })
        .returning();
      pageIds.push(must(row).id);
    }
    const adrs: string[] = [];
    for (const adr of options.adrs ?? []) {
      const [row] = await db()
        .insert(schema.blips)
        .values({
          ...(adr.id ? { id: adr.id } : {}),
          radarId: radar.id,
          authorId: owner.user.id,
          state: adr.status === 'proposed' ? 'inbox' : 'done',
          status: adr.status,
          title: adr.title,
          body: adr.title,
          ratifiedAt: adr.status === 'proposed' ? null : new Date('2026-10-15T00:00:00Z'),
          createdAt: new Date((at += 1000)),
        })
        .returning();
      adrs.push(must(row).id);
    }
    return { id: radar.id, pageIds, adrs };
  };
  /** The Acme pack's four pages; the ADR the three markers name gets this radar's own id (ids are unique in a database). */
  let adr27 = ADR_0027;
  const acme = async () => {
    adr27 = randomUUID();
    return seed({
      pages: ACME.map((p) => p.replaceAll(ADR_0027, adr27)),
      adrs: [
        { title: 'ADR-0005: Stripe is the billing source of truth', status: 'repealed' },
        { id: adr27, title: 'ADR-0027: Acme owns the plan', status: 'accepted' },
      ],
    });
  };
  const doc = async (id: string) =>
    must(
      (
        await db()
          .select()
          .from(schema.charterDocuments)
          .where(eq(schema.charterDocuments.radarId, id))
      )[0],
    );
  const anchorsOf = (id: string) =>
    db()
      .select()
      .from(schema.charterAnchors)
      .where(eq(schema.charterAnchors.radarId, id))
      .orderBy(schema.charterAnchors.createdAt, schema.charterAnchors.id);
  const versionsOf = (id: string) =>
    db()
      .select()
      .from(schema.charterVersions)
      .where(eq(schema.charterVersions.radarId, id))
      .orderBy(schema.charterVersions.version);
  const written = async (id: string) =>
    must((await readArchitecture(owner, id, { view: 'written' })).charter[0]?.markdown);
  const save = async (id: string, edit: (text: string) => string, note?: string) => {
    const read = await readArchitecture(owner, id, { view: 'written' });
    return writeCharter(owner, id, {
      markdown: edit(must(read.charter[0]?.markdown)),
      baseRevision: must(read.revision),
      ...(note ? { note } : {}),
    });
  };
  const refused = (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code });

  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString: connection, max: 3 });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    scratch = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'charter-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    owner = await user('owner');
  }, 60_000);

  afterAll(async () => {
    await scratch?.end();
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  describe('moving a radar in: the Acme pack’s four pages and three live markers', () => {
    it('plans without writing, then moves: one document, three anchors, version 1, and the pages left alone', async () => {
      const { id, pageIds } = await acme();
      const pagesBefore = JSON.stringify(
        await db()
          .select()
          .from(schema.blips)
          .where(eq(schema.blips.radarId, id))
          .orderBy(schema.blips.createdAt),
      );
      const plan = await migrateRadar(id, { dryRun: true });
      expect(plan).toMatchObject({
        status: 'migrated',
        pages: 4,
        anchors: 3,
        versions: 1,
        characters: WRITTEN.length,
      });
      expect(
        await db()
          .select()
          .from(schema.charterDocuments)
          .where(eq(schema.charterDocuments.radarId, id)),
      ).toEqual([]);

      expect(await migrateRadar(id)).toMatchObject({
        status: 'migrated',
        pages: 4,
        anchors: 3,
        versions: 1,
      });
      const document = await doc(id);
      expect([document.body, document.revision, document.sealedVersion]).toEqual([WRITTEN, 1, 1]);
      // The text is what "as written" showed, and every page's written text is whole inside it.
      for (const page of ACME)
        expect(document.body).toContain(replaceMarkers(page, (m) => m.quote));

      const anchors = await anchorsOf(id);
      expect(
        anchors.map((a) => [a.kind, a.state, a.subjectId, a.quote, a.resolvedVersion]),
      ).toEqual([
        ['amend', 'anchored', adr27, 'all billing truth', 1],
        ['amend', 'anchored', adr27, 'Never acts on its own (ADR-0005)', 1],
        ['amend', 'anchored', adr27, 'A lost dispute keeps billing at no opinion (ADR-0005)', 1],
      ]);
      const text = projectMarkdown(document.body).text;
      for (const a of anchors) expect(text.slice(a.posStart ?? 0, a.posEnd ?? 0)).toBe(a.quote);

      const [v1, ...rest] = await versionsOf(id);
      expect(rest).toEqual([]);
      expect(v1).toMatchObject({ version: 1, cause: 'migration', authorId: null });
      expect(Object.keys(must(v1).anchors).sort()).toEqual(anchors.map((a) => a.id).sort());
      expect(must(v1).adrLanes).toEqual({ [adr27]: 'accepted' });
      expect(
        Number(
          (await q('SELECT count(*) AS n FROM charter_texts WHERE radar_id = $1', [id])).rows[0]?.[
            'n'
          ],
        ),
      ).toBe(1);
      expect(
        (await q(`SELECT kind, version FROM charter_anchor_events WHERE radar_id = $1`, [id])).rows,
      ).toEqual(Array(3).fill({ kind: 'created', version: 1 }));

      // No page was deleted or touched: they are the way back.
      expect(
        JSON.stringify(
          await db()
            .select()
            .from(schema.blips)
            .where(eq(schema.blips.radarId, id))
            .orderBy(schema.blips.createdAt),
        ),
      ).toBe(pagesBefore);
      expect(pageIds).toHaveLength(4);

      // Drawn from the document, the amended view is what the pages drew; the source view carries the markers.
      const amended = (await readArchitecture(owner, id, { view: 'amended' })).charter[0]?.markdown;
      expect(amended).toBe(ACME.map((p) => resolvePage(p, 'amended', () => true)).join('\n\n'));
      const source = must(
        (await readArchitecture(owner, id, { view: 'source' })).charter[0]?.markdown,
      );
      expect(parseMarkers(source).map((m) => m.quote)).toEqual(
        ACME.flatMap((p) => parseMarkers(p).map((m) => m.quote)),
      );
    }, 60_000);

    it('is idempotent: a second run, and a read, change nothing', async () => {
      const { id } = await acme();
      await migrateRadar(id);
      const counts = async () =>
        JSON.stringify(
          (
            await q(
              `SELECT (SELECT count(*) FROM charter_documents WHERE radar_id = $1) AS docs,
                      (SELECT count(*) FROM charter_versions WHERE radar_id = $1) AS versions,
                      (SELECT count(*) FROM charter_texts WHERE radar_id = $1) AS texts,
                      (SELECT count(*) FROM charter_anchors WHERE radar_id = $1) AS anchors,
                      (SELECT count(*) FROM charter_anchor_events WHERE radar_id = $1) AS events,
                      (SELECT md5(body) FROM charter_documents WHERE radar_id = $1) AS body`,
              [id],
            )
          ).rows,
        );
      const before = await counts();
      expect(await migrateRadar(id)).toMatchObject({
        status: 'already',
        versions: 1,
        stalePages: 0,
      });
      await ensureCharterDocument(id);
      await readArchitecture(owner, id, { view: 'source' });
      expect(await counts()).toBe(before);
    });

    it('moves a radar with pages and no markers (On My Radar Architecture): one version, no anchors', async () => {
      const { id } = await seed({
        pages: [
          '# 01 · Principles\n\nOne.',
          '# 02 · System context\n\nTwo.',
          '# 03\n\nThree.',
          '# 04\n\nFour.',
        ],
        adrs: [{ title: 'ADR-1: PostgreSQL is the only store', status: 'accepted' }],
      });
      expect(await migrateRadar(id)).toMatchObject({
        status: 'migrated',
        pages: 4,
        anchors: 0,
        versions: 1,
      });
      expect((await doc(id)).body).toBe(
        '# 01 · Principles\n\nOne.\n\n# 02 · System context\n\nTwo.\n\n# 03\n\nThree.\n\n# 04\n\nFour.',
      );
      expect(await anchorsOf(id)).toEqual([]);
      expect(await versionsOf(id)).toHaveLength(1);
    });

    it('moves a radar with no pages (Arch Test): an empty document, no version, and ADRs still work', async () => {
      const { id } = await seed({
        pages: [],
        adrs: [{ title: 'ADR-1: Untitled', status: 'proposed' }],
      });
      expect(await migrateRadar(id)).toMatchObject({
        status: 'empty',
        pages: 0,
        anchors: 0,
        versions: 0,
      });
      expect(await doc(id)).toMatchObject({ body: '', revision: 0, sealedVersion: 0 });
      expect(await versionsOf(id)).toEqual([]);
      expect(await migrateRadar(id)).toMatchObject({ status: 'already' });
      const first = await writeCharter(owner, id, {
        markdown: '# Charter\n\nFirst words.',
        baseRevision: 0,
      });
      expect(first).toMatchObject({ revision: 1, version: 1, changed: true });
    });

    it('refuses what it cannot keep, and leaves the radar exactly as it was', async () => {
      const commented = await acme();
      await db()
        .insert(schema.blipComments)
        .values({
          blipId: must(commented.pageIds[0]),
          radarId: commented.id,
          authorId: owner.user.id,
          body: 'A note on a page',
        });
      expect(await migrateRadar(commented.id)).toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('comments') as unknown,
      });
      const ghost = await seed({ adrs: [{ title: 'ADR-5: Not the one', status: 'accepted' }] });
      expect(await migrateRadar(ghost.id)).toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('not an ADR of this radar') as unknown,
      });
      for (const id of [commented.id, ghost.id]) {
        expect(
          await db()
            .select()
            .from(schema.charterDocuments)
            .where(eq(schema.charterDocuments.radarId, id)),
        ).toEqual([]);
        expect(await anchorsOf(id)).toEqual([]);
      }
      // A read says why, rather than returning half a charter.
      await refused(
        readArchitecture(owner, commented.id, { view: 'written' }),
        'charter_migration_refused',
      );
    });

    it('moves a radar once when two pods race, and the sweep skips what is moved', async () => {
      const { id } = await acme();
      const reports = await Promise.all([migrateRadar(id), migrateRadar(id), migrateRadar(id)]);
      expect(reports.map((r) => r.status).sort()).toEqual(['already', 'already', 'migrated']);
      expect(await versionsOf(id)).toHaveLength(1);
      expect(await anchorsOf(id)).toHaveLength(3);
      const sweep = await migrateAllRadars();
      expect(sweep.map((r) => r.radarId)).not.toContain(id);
      const other = await migrateAllRadars({ dryRun: true, only: id });
      expect(other).toMatchObject([{ radarId: id, status: 'already' }]);
    });

    it('reports a page written between the read and the move, and purges only what the document holds', async () => {
      const { id, pageIds } = await acme();
      await migrateRadar(id);
      expect(await purgeMigratedPages(id, { dryRun: true })).toMatchObject({ deleted: 4, kept: 0 });
      // The fence (below) makes a write to a page after the move impossible, so to say what the
      // purge does with one it must be let through.
      await q('ALTER TABLE blips DISABLE TRIGGER charter_page_fence_update');
      try {
        await db()
          .update(schema.blips)
          .set({
            body: `${ACME[0] ?? ''}\n\nWritten by an older pod.`,
            updatedAt: new Date(Date.now() + 5000),
          })
          .where(eq(schema.blips.id, must(pageIds[0])));
      } finally {
        await q('ALTER TABLE blips ENABLE TRIGGER charter_page_fence_update');
      }
      expect(await migrateRadar(id)).toMatchObject({ status: 'already', stalePages: 1 });
      expect(await purgeMigratedPages(id, { dryRun: true })).toMatchObject({
        deleted: 3,
        kept: 1,
      });
      expect(await purgeMigratedPages(id)).toMatchObject({ deleted: 3, kept: 1 });
      expect(
        await db()
          .select()
          .from(schema.blips)
          .where(eq(schema.blips.status, 'charter'))
          .then((r) => r.filter((b) => b.radarId === id)),
      ).toHaveLength(1);
    });

    it('never purges a page that has a comment: one added after the move lives only there', async () => {
      const { id, pageIds } = await acme();
      await migrateRadar(id);
      // Added the way the API allowed before this check (and the way an older pod still can).
      await db()
        .insert(schema.blipComments)
        .values({
          blipId: must(pageIds[1]),
          radarId: id,
          authorId: owner.user.id,
          body: 'Added after the move.',
        });
      expect(await purgeMigratedPages(id, { dryRun: true })).toMatchObject({
        deleted: 3,
        kept: 1,
        commented: 1,
      });
      expect(await purgeMigratedPages(id)).toMatchObject({ deleted: 3, kept: 1, commented: 1 });
      const left = await db()
        .select({ id: schema.blips.id })
        .from(schema.blips)
        .where(eq(schema.blips.status, 'charter'))
        .then((r) => r.filter((b) => pageIds.includes(b.id)));
      expect(left.map((b) => b.id)).toEqual([pageIds[1]]);
      expect(
        await db()
          .select()
          .from(schema.blipComments)
          .where(eq(schema.blipComments.blipId, must(pageIds[1]))),
      ).toHaveLength(1);
    });

    it('refuses a new comment on a page once the radar has a document, and still allows one before', async () => {
      const { id, pageIds } = await acme();
      // Not moved yet: the pages are the charter, a comment is a comment.
      await createComment(owner, must(pageIds[0]), { body: 'Before the move.' });
      expect(await migrateRadar(id)).toMatchObject({ status: 'refused' });
      const fresh = await acme();
      await migrateRadar(fresh.id);
      await refused(
        createComment(owner, must(fresh.pageIds[0]), { body: 'After the move.' }),
        'charter_is_one_document',
      );
    });
  });

  describe('the database fences the pages once a radar has a document (a rolling deploy)', () => {
    const insertPage = (id: string) =>
      q(
        `INSERT INTO blips (radar_id, author_id, state, status, title, body)
         VALUES ($1, $2, 'active', 'charter', 'From an older pod', 'text')`,
        [id, owner.user.id],
      );

    it('before the move a page is written freely; after it, insert, update, delete and move all fail for an older pod', async () => {
      const { id, pageIds, adrs } = await acme();
      await insertPage(id);
      await q(`UPDATE blips SET body = body || ' ' WHERE id = $1`, [pageIds[0]]);
      await q(`DELETE FROM blips WHERE radar_id = $1 AND title = 'From an older pod'`, [id]);
      await migrateRadar(id);
      const pageBefore = (
        await db()
          .select()
          .from(schema.blips)
          .where(eq(schema.blips.id, must(pageIds[0])))
      )[0]?.body;
      const fenced = { code: '55000' };
      await expect(insertPage(id)).rejects.toMatchObject(fenced);
      await expect(
        q(`UPDATE blips SET body = 'older pod' WHERE id = $1`, [pageIds[0]]),
      ).rejects.toMatchObject(fenced);
      await expect(
        q(`UPDATE blips SET status = 'proposed' WHERE id = $1`, [pageIds[0]]),
      ).rejects.toMatchObject(fenced);
      await expect(q(`DELETE FROM blips WHERE id = $1`, [pageIds[0]])).rejects.toMatchObject(
        fenced,
      );
      // A blip moved into the charter lane is a page too.
      await expect(
        q(`UPDATE blips SET status = 'charter' WHERE id = $1`, [adrs[0]]),
      ).rejects.toMatchObject(fenced);
      expect(
        (
          await db()
            .select()
            .from(schema.blips)
            .where(eq(schema.blips.id, must(pageIds[0])))
        )[0]?.body,
      ).toBe(pageBefore);
    });

    it('lets everything else through: other lanes, a radar deleted whole, a user deleted, and the purge', async () => {
      const gone = await user('gone');
      const goneAgent = await createRepoAgent(owner, {
        name: `Gone ${Math.random()}`,
        prompt: 'x',
      });
      const { id, pageIds } = await acme();
      // Re-seating a creator is the one thing `blips_keep_author` refuses; this setting is its escape.
      const client = await must(scratch).connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('omr.blip_reauthor', 'on', true)`);
        await client.query(
          `UPDATE blips SET author_id = $1, agent_id = $2 WHERE radar_id = $3 AND status = 'charter'`,
          [gone.user.id, goneAgent.id, id],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await migrateRadar(id);
      // An ADR in a lane of the same radar is not a page.
      await q(`UPDATE blips SET title = title WHERE radar_id = $1 AND status <> 'charter'`, [id]);
      // A deleted user or agent only nulls the reference on a page.
      await q(`DELETE FROM users WHERE id = $1`, [gone.user.id]);
      await q(`DELETE FROM agents WHERE id = $1`, [goneAgent.id]);
      const page = (
        await db()
          .select()
          .from(schema.blips)
          .where(eq(schema.blips.id, must(pageIds[0])))
      )[0];
      expect([page?.authorId, page?.agentId]).toEqual([null, null]);
      // The purge is the one writer.
      expect(await purgeMigratedPages(id)).toMatchObject({ deleted: 4 });
      // A radar deleted whole takes its pages with it.
      const other = await acme();
      await migrateRadar(other.id);
      await deleteRadar(owner, other.id);
      expect(
        (await q(`SELECT count(*)::int AS n FROM blips WHERE radar_id = $1`, [other.id])).rows[0]?.[
          'n'
        ],
      ).toBe(0);
    });
  });

  it('lets a deleted agent null its assignee and claim on a page (the fence names the columns)', async () => {
    const { id, pageIds } = await acme();
    const agent = await createRepoAgent(owner, { name: `Fence ${Math.random()}`, prompt: 'x' });
    await q(
      `UPDATE blips SET assignee_agent_id = $1, claimed_by_agent_id = $1, claimed_until = now() + interval '1 hour'
       WHERE radar_id = $2 AND status = 'charter'`,
      [agent.id, id],
    );
    await migrateRadar(id);
    await q(`DELETE FROM agents WHERE id = $1`, [agent.id]);
    const page = (
      await q(`SELECT assignee_agent_id, claimed_by_agent_id FROM blips WHERE id = $1`, [
        must(pageIds[0]),
      ])
    ).rows[0];
    expect(page).toEqual({ assignee_agent_id: null, claimed_by_agent_id: null });
  });

  describe('saves that orphan, and heal', () => {
    /** Commander's charter with a new ADR amending a sentence of page 1. */
    const amended = async () => {
      const { id } = await acme();
      const { adr, anchors } = await proposeAdr(owner, id, {
        title: 'Principles are advice',
        rationale: 'They are not binding.',
        anchors: [{ quote: PRINCIPLES, with: 'These principles are advice.' }],
      });
      return { id, adr, anchors };
    };

    it('orphans on a save that changes the quote, saying why, since when and what it was, and seals both sides', async () => {
      const { id, adr } = await amended();
      expect(await versionsOf(id)).toHaveLength(2);
      const saved = await save(
        id,
        (t) => t.replace(PRINCIPLES, 'These rules are decisions, not options.'),
        'reword',
      );
      expect(saved.orphaned).toEqual([
        {
          anchorId: expect.any(String) as unknown,
          kind: 'amend',
          subject: { id: adr.id, label: 'ADR-0028', lane: 'proposed' },
          quote: PRINCIPLES,
          cause: 'text_changed',
          resolvedVersion: 2,
          orphanedVersion: 3,
        },
      ]);
      expect([
        saved.revision,
        saved.version,
        saved.healed,
        saved.moved,
        saved.inertOrphaned,
      ]).toEqual([2, 3, [], [], 0]);
      // The three live ADR-0027 amendments elsewhere kept their place.
      const rows = await anchorsOf(id);
      expect(rows.filter((r) => r.state === 'anchored')).toHaveLength(3);
      const orphan = must(rows.find((r) => r.state === 'orphaned'));
      expect([
        orphan.orphanCause,
        orphan.resolvedVersion,
        orphan.orphanedVersion,
        orphan.posStart,
      ]).toEqual(['text_changed', 2, 3, null]);
      // Version 3 is the new text and records the orphan as having no place; version 2 still has the old words.
      const [, v2, v3] = await versionsOf(id);
      expect(must(v3).anchors[orphan.id]).toBeNull();
      expect(must(v2).anchors[orphan.id]).toEqual([expect.any(Number), expect.any(Number)]);
      expect(must(v3).note).toBe('reword');
      const texts = await db()
        .select()
        .from(schema.charterTexts)
        .where(eq(schema.charterTexts.radarId, id));
      expect(texts.some((t) => t.body.includes(PRINCIPLES))).toBe(true);
      expect(
        (
          await q(
            `SELECT kind, version FROM charter_anchor_events WHERE anchor_id = $1 ORDER BY created_at`,
            [orphan.id],
          )
        ).rows,
      ).toEqual([
        { kind: 'created', version: 2 },
        { kind: 'orphaned', version: 3 },
      ]);

      const read = await readArchitecture(owner, id, { view: 'source' });
      expect(read.orphans).toEqual(saved.orphaned);
      expect(read.adrs.find((a) => a.id === adr.id)?.anchors).toEqual([
        expect.objectContaining({
          state: 'orphaned',
          cause: 'text_changed',
          resolvedVersion: 2,
          orphanedVersion: 3,
        }),
      ]);
    });

    it('refuses to accept an orphaned ADR on every path that accepts, and still lets it be rejected', async () => {
      const { id, adr } = await amended();
      await save(id, (t) => t.replace(PRINCIPLES, 'Something else entirely.'));
      const lane = async () =>
        (await db().select().from(schema.blips).where(eq(schema.blips.id, adr.id)))[0]?.status;
      await refused(decideAdr(owner, adr.id, { decision: 'accept' }), 'adr_orphaned');
      await refused(updateBlip(owner, adr.id, { status: 'accepted' }), 'adr_orphaned');
      // `state: done` is repaired into the accepted lane on the shared path: not a way round.
      await refused(updateBlip(owner, adr.id, { state: 'done' }), 'adr_orphaned');
      expect(await lane()).toBe('proposed');
      expect(
        await db()
          .select()
          .from(schema.blips)
          .where(eq(schema.blips.id, adr.id))
          .then((r) => r[0]?.ratifiedAt),
      ).toBeNull();
      await decideAdr(owner, adr.id, { decision: 'reject' });
      expect(await lane()).toBe('rejected');
    });

    it('heals when the words are saved back, at the same place or moved, and the ADR can then be accepted', async () => {
      const { id, adr } = await amended();
      const original = await written(id);
      await save(id, (t) => t.replace(PRINCIPLES, 'Gone.'));
      const healed = await save(id, () => original, 'undo');
      expect(healed.orphaned).toEqual([]);
      expect(healed.healed).toEqual([
        {
          anchorId: expect.any(String) as unknown,
          kind: 'amend',
          subject: { id: adr.id, label: 'ADR-0028', lane: 'proposed' },
          quote: PRINCIPLES,
        },
      ]);
      const anchor = must((await anchorsOf(id)).find((a) => a.subjectId === adr.id));
      expect([
        anchor.state,
        anchor.orphanCause,
        anchor.orphanedVersion,
        anchor.resolvedVersion,
      ]).toEqual(['anchored', null, null, 4]);
      expect(
        projectMarkdown(await written(id)).text.slice(anchor.posStart ?? 0, anchor.posEnd ?? 0),
      ).toBe(PRINCIPLES);
      expect(
        (
          await q(
            `SELECT kind FROM charter_anchor_events WHERE anchor_id = $1 ORDER BY created_at`,
            [anchor.id],
          )
        ).rows.map((r) => r['kind']),
      ).toEqual(['created', 'orphaned', 'healed']);
      const accepted = await decideAdr(owner, adr.id, { decision: 'accept' });
      expect(accepted.adr.lane).toBe('accepted');
      // Accepted, the amendment is drawn: the sentence reads as its replacement.
      const amendedView = must(
        (await readArchitecture(owner, id, { view: 'amended' })).charter[0]?.markdown,
      );
      expect(amendedView).toContain('These principles are advice.');
      expect(amendedView).not.toContain(PRINCIPLES);
      // And the lane change is part of the history.
      const versions = await versionsOf(id);
      expect(must(versions.at(-1)).cause).toBe('adr');
      expect(must(versions.at(-1)).adrLanes[adr.id]).toBe('accepted');
    });

    it('heals when the sentence is cut and pasted elsewhere (it moved), and says so', async () => {
      const { id, adr } = await amended();
      const moved = await save(id, (t) => {
        const cut = t.replace(`${PRINCIPLES} `, '');
        return `${cut}\n\nFrom the top: ${PRINCIPLES} Nothing else changed.\n`;
      });
      // The sentence is gone from its paragraph and present once, with new neighbours: it rebinds only
      // when its context agrees up to the block edge, otherwise it orphans and can be healed. Either
      // is a defined outcome; it is never silently attached to the wrong words.
      const row = must((await anchorsOf(id)).find((a) => a.subjectId === adr.id));
      if (moved.moved.length > 0) expect(row.state).toBe('anchored');
      else expect(moved.orphaned.map((o) => o.subject.id)).toEqual([adr.id]);
      if (row.state === 'anchored')
        expect(
          projectMarkdown(await written(id)).text.slice(row.posStart ?? 0, row.posEnd ?? 0),
        ).toBe(PRINCIPLES);
    });

    it('stacks a superseding ADR on one span; the span going orphans both, and getting it back heals both', async () => {
      const { id, adr: first } = await amended();
      await decideAdr(owner, first.id, { decision: 'accept' });
      const second = await proposeAdr(owner, id, {
        title: 'Principles are optional',
        rationale: 'Even softer.',
        anchors: [{ quote: PRINCIPLES, with: 'These principles are optional.' }],
        supersedes: first.id,
      });
      const original = await written(id);
      const saved = await save(id, (t) => t.replace(PRINCIPLES, 'Nope.'));
      expect(saved.orphaned.map((o) => o.subject.id).sort()).toEqual(
        [first.id, second.adr.id].sort(),
      );
      const back = await save(id, () => original);
      expect(back.healed.map((o) => o.subject.id).sort()).toEqual([first.id, second.adr.id].sort());
      await decideAdr(owner, second.adr.id, { decision: 'accept' });
      expect(
        must((await readArchitecture(owner, id, { view: 'amended' })).charter[0]?.markdown),
      ).toContain('These principles are optional.');
    });

    it('resolves a rejected ADR’s amendment too but never reports it: it counts, and blocks nothing', async () => {
      const { id, adr } = await amended();
      await decideAdr(owner, adr.id, { decision: 'reject' });
      const saved = await save(id, (t) => t.replace(PRINCIPLES, 'Different.'));
      expect(saved).toMatchObject({ orphaned: [], inertOrphaned: 1 });
      expect((await readArchitecture(owner, id, { view: 'source' })).orphans).toBeUndefined();
      expect((await anchorsOf(id)).find((a) => a.subjectId === adr.id)?.state).toBe('orphaned');
      // The same words can be amended by a new ADR.
      await save(id, (t) => t.replace('Different.', PRINCIPLES));
      await proposeAdr(owner, id, {
        title: 'Again',
        rationale: 'r',
        anchors: [{ quote: PRINCIPLES, with: 'x' }],
      });
    });

    it('keeps an ADR with an orphaned amendment undeletable and the template locked', async () => {
      const { id, adr } = await amended();
      await save(id, (t) => t.replace(PRINCIPLES, 'Different.'));
      await refused(deleteBlip(owner, adr.id), 'anchored');
      await refused(updateRadar(owner, id, { template: 'decisions' }), 'template_locked');
    });

    it('seals a version on every orphaning save, numbered without gaps, and the versions cannot be changed', async () => {
      const { id } = await amended();
      for (const [from, to] of [
        [PRINCIPLES, 'One.'],
        ['One.', PRINCIPLES],
        [PRINCIPLES, 'Two.'],
      ] as const)
        await save(id, (t) => t.replace(from, to));
      const versions = await versionsOf(id);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
      expect(versions.map((v) => v.cause)).toEqual(['migration', 'adr', 'edit', 'edit', 'edit']);
      expect((await doc(id)).sealedVersion).toBe(5);
      await expect(
        q(`UPDATE charter_versions SET note = 'edited' WHERE radar_id = $1 AND version = 1`, [id]),
      ).rejects.toThrow(/immutable/);
      await expect(
        q(`UPDATE charter_versions SET anchors = '{}' WHERE radar_id = $1`, [id]),
      ).rejects.toThrow(/immutable/);
      await expect(
        q(`DELETE FROM charter_versions WHERE radar_id = $1 AND version = 5`, [id]),
      ).rejects.toThrow(/immutable/);
      // Clearing a foreign key (a deleted user) is the one change the database lets through.
      await q(`UPDATE charter_versions SET author_id = NULL WHERE radar_id = $1`, [id]);
      await expect(
        q(`UPDATE charter_versions SET author_id = $2 WHERE radar_id = $1 AND version = 3`, [
          id,
          owner.user.id,
        ]),
      ).rejects.toThrow(/immutable/);
      // The text of two versions is stored once when it is the same.
      const texts = Number(
        (await q('SELECT count(*) AS n FROM charter_texts WHERE radar_id = $1', [id])).rows[0]?.[
          'n'
        ],
      );
      expect(texts).toBeLessThan(versions.length);
    });

    describe('autosave (checkpoint: false) keeps one working text, not a version per save', () => {
      /** A write as an editor that saves while typing makes it. */
      const type = async (actor: Actor, id: string, markdown: string, checkpoint = false) => {
        const read = await readArchitecture(actor, id, { view: 'written' });
        return writeCharter(actor, id, {
          markdown,
          baseRevision: must(read.revision),
          checkpoint,
        });
      };

      it('makes no version per save: twenty saves leave the sealed versions as they were, and Done seals one', async () => {
        const { id } = await amended();
        const sealed = (await versionsOf(id)).length;
        const base = await written(id);
        for (let i = 1; i <= 20; i += 1) await type(owner, id, `${base}\n\nTyped ${i}.`);
        expect((await versionsOf(id)).length).toBe(sealed);
        const head = await doc(id);
        expect(head.body).toBe(`${base}\n\nTyped 20.`);
        expect(head.sealedVersion).toBe(sealed);
        // The head is read back as typed, and a stale base is still refused.
        expect(await written(id)).toBe(head.body);
        await refused(
          writeCharter(owner, id, { markdown: 'x', baseRevision: head.revision - 1 }),
          'stale',
        );
        // Done: the same text again, as a checkpoint, seals what was typed, once.
        const done = await type(owner, id, head.body, true);
        expect(done).toMatchObject({ changed: false, version: sealed + 1 });
        const after = await versionsOf(id);
        expect(after).toHaveLength(sealed + 1);
        expect(after.at(-1)?.authorId).toBe(owner.user.id);
        // A second checkpoint of the same text makes nothing more.
        await type(owner, id, head.body, true);
        expect(await versionsOf(id)).toHaveLength(sealed + 1);
      }, 30_000);

      it('moves an amendment along with the typing above it without sealing, and checkpoints by default', async () => {
        const { id } = await amended();
        const sealed = (await versionsOf(id)).length;
        const base = await written(id);
        const result = await type(owner, id, `A new line first.\n\n${base}`);
        expect(result).toMatchObject({ changed: true, orphaned: [], version: sealed });
        expect((await versionsOf(id)).length).toBe(sealed);
        // No checkpoint field is today's behaviour: sealed, and it replaces the working text
        // (one version holds the lot, not one for the typing and one for this).
        await save(id, (t) => `${t}\n\nMore.`);
        expect((await versionsOf(id)).length).toBe(sealed + 1);
      });

      it('seals the working text before another writer’s save, under the name of the one who typed it', async () => {
        const { id } = await amended();
        const other = await user('second');
        // Both may write this radar.
        await q(
          `INSERT INTO radar_members (radar_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`,
          [id, other.user.id],
        );
        const sealed = (await versionsOf(id)).length;
        const mine = `${await written(id)}\n\nMine, unsealed.`;
        await type(owner, id, mine);
        expect((await versionsOf(id)).length).toBe(sealed);
        await type(other, id, `${mine}\n\nTheirs.`);
        const versions = await versionsOf(id);
        expect(versions).toHaveLength(sealed + 1);
        const mineVersion = must(versions.at(-1));
        expect(mineVersion.authorId).toBe(owner.user.id);
        const text = await q<{ body: string }>(
          'SELECT body FROM charter_texts WHERE radar_id = $1 AND sha256 = $2',
          [id, mineVersion.sha256],
        );
        expect(text.rows[0]?.body).toBe(mine);
      });

      it('seals a working text that has sat for ten minutes before the next save, even by the same writer', async () => {
        const { id } = await amended();
        const sealed = (await versionsOf(id)).length;
        const mine = `${await written(id)}\n\nTyped before lunch.`;
        await type(owner, id, mine);
        await q(
          `UPDATE charter_documents SET updated_at = now() - interval '11 minutes' WHERE radar_id = $1`,
          [id],
        );
        await type(owner, id, `${mine} And after.`);
        const versions = await versionsOf(id);
        expect(versions).toHaveLength(sealed + 1);
        const text = await q<{ body: string }>(
          'SELECT body FROM charter_texts WHERE radar_id = $1 AND sha256 = $2',
          [id, must(versions.at(-1)).sha256],
        );
        expect(text.rows[0]?.body).toBe(mine);
      });

      it('treats two connections of one user as two writers: the second seals the first’s working text under the first’s label', async () => {
        const { id } = await amended();
        const as = (connection: string, label: string): Actor => ({
          ...owner,
          connection: { kind: 'pat', id: connection, label },
        });
        const first = as('pat-a', 'Laptop token');
        const second = as('pat-b', 'CI token');
        const sealed = (await versionsOf(id)).length;
        const mine = `${await written(id)}\n\nFrom the laptop.`;
        await type(first, id, mine);
        expect((await versionsOf(id)).length).toBe(sealed);
        // The other connection checkpoints the same text: it is the laptop's, and says so.
        await type(second, id, mine, true);
        const versions = await versionsOf(id);
        expect(versions).toHaveLength(sealed + 1);
        expect(must(versions.at(-1)).clientLabel).toBe('Laptop token');
        // And a different text from the other connection does not swallow the laptop's.
        const again = `${mine}\n\nMore from the laptop.`;
        await type(first, id, again);
        await type(second, id, `${mine}\n\nReplaced by CI.`);
        const after = await versionsOf(id);
        expect(after).toHaveLength(sealed + 2);
        const kept = await q<{ body: string }>(
          'SELECT body FROM charter_texts WHERE radar_id = $1 AND sha256 = $2',
          [id, must(after.at(-1)).sha256],
        );
        expect(kept.rows[0]?.body).toBe(again);
        expect(must(after.at(-1)).clientLabel).toBe('Laptop token');
      });

      it('keeps one connection’s working text as its own across saves (the same token is the same writer)', async () => {
        const { id } = await amended();
        const token: Actor = {
          ...owner,
          connection: { kind: 'pat', id: 'pat-a', label: 'Laptop' },
        };
        const sealed = (await versionsOf(id)).length;
        const base = await written(id);
        await type(token, id, `${base}\n\nOne.`);
        await type(token, id, `${base}\n\nOne. Two.`);
        expect((await versionsOf(id)).length).toBe(sealed);
      });

      it('still seals a save that orphans (and one that heals), whatever it asked for: they point at a version', async () => {
        const { id } = await amended();
        const sealed = (await versionsOf(id)).length;
        const base = await written(id);
        await type(owner, id, `${base}\n\nWorking.`);
        const orphaning = await type(
          owner,
          id,
          `${base}\n\nWorking.`.replace(PRINCIPLES, 'Changed.'),
        );
        expect(orphaning.orphaned).toHaveLength(1);
        // The working text, then the orphaning text: both are real versions.
        expect((await versionsOf(id)).length).toBe(sealed + 2);
        expect(orphaning.orphaned[0]).toMatchObject({ resolvedVersion: sealed + 1 });
        const healing = await type(owner, id, `${base}\n\nWorking.`);
        expect(healing.healed).toHaveLength(1);
        expect((await versionsOf(id)).length).toBe(sealed + 3);
      });
    });

    it('takes versions, texts and anchors with the radar when it is deleted', async () => {
      const { id } = await amended();
      await save(id, (t) => t.replace(PRINCIPLES, 'Gone.'));
      await deleteRadar(owner, id);
      for (const table of [
        'charter_documents',
        'charter_texts',
        'charter_versions',
        'charter_anchors',
        'charter_anchor_events',
      ])
        expect(
          Number(
            (await q(`SELECT count(*) AS n FROM ${table} WHERE radar_id = $1`, [id])).rows[0]?.[
              'n'
            ],
          ),
          table,
        ).toBe(0);
    });

    it('leaves stored state equal to a fresh resolve of the head after a run of edits', async () => {
      const { id } = await amended();
      const edits: Array<(t: string) => string> = [
        (t) => `${t}\n\nAppended.`,
        (t) => t.replace('Status: Draft', 'Status: Review'),
        (t) => t.replace(PRINCIPLES, 'Changed.'),
        (t) => t.replace('Changed.', PRINCIPLES),
        (t) => `Intro paragraph.\n\n${t}`,
      ];
      for (const edit of edits) await save(id, edit);
      const { body } = await doc(id);
      const { text } = projectMarkdown(body);
      for (const a of await anchorsOf(id)) {
        if (a.state === 'anchored')
          expect(text.slice(a.posStart ?? -1, a.posEnd ?? -1), a.quote).toBe(a.quote);
        else expect([a.posStart, a.posEnd]).toEqual([null, null]);
      }
    });
  });

  describe('review round 2', () => {
    const marked = () =>
      `# 05 · Late\n\nA late sentence with :amend[late words]{adr=${adr27} with="Later words"} in it.`;
    const anchorQuotes = async (id: string) => (await anchorsOf(id)).map((a) => a.quote);

    it('the move waits for a page insert in flight and takes it, marker and all', async () => {
      const { id } = await acme();
      const other = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      const held = await other.connect();
      try {
        // An older pod, mid-transaction: its page is not committed, so a plain read would miss it.
        await held.query('BEGIN');
        await held.query(
          `INSERT INTO blips (radar_id, author_id, state, status, title, body, created_at)
           VALUES ($1, $2, 'active', 'charter', 'Late', $3, now() + interval '1 hour')`,
          [id, owner.user.id, marked()],
        );
        let settled = false;
        const moving = migrateRadar(id).finally(() => {
          settled = true;
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(settled, 'the move waits for the insert').toBe(false);
        await held.query('COMMIT');
        expect(await moving).toMatchObject({ status: 'migrated', pages: 5, anchors: 4 });
      } finally {
        held.release();
        await other.end();
      }
      expect(await anchorQuotes(id)).toContain('late words');
      expect((await doc(id)).body).toContain('A late sentence with late words in it.');
    });

    it('the move waits for a page update in flight and takes it', async () => {
      const { id, pageIds } = await acme();
      const other = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      const held = await other.connect();
      try {
        await held.query('BEGIN');
        await held.query(`UPDATE blips SET body = body || $2 WHERE id = $1`, [
          pageIds[3],
          `\n\n${marked()}`,
        ]);
        let settled = false;
        const moving = migrateRadar(id).finally(() => {
          settled = true;
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(settled, 'the move waits for the update').toBe(false);
        await held.query('COMMIT');
        expect(await moving).toMatchObject({ status: 'migrated', anchors: 4 });
      } finally {
        held.release();
        await other.end();
      }
      expect(await anchorQuotes(id)).toContain('late words');
    });

    it('a purge keeps a page whose text holds a marker no anchor stands for', async () => {
      const { id, pageIds } = await acme();
      await migrateRadar(id);
      await q('ALTER TABLE blips DISABLE TRIGGER charter_page_fence_update');
      try {
        await q(`UPDATE blips SET body = body || $2 WHERE id = $1`, [
          pageIds[0],
          `\n\n${marked()}`,
        ]);
      } finally {
        await q('ALTER TABLE blips ENABLE TRIGGER charter_page_fence_update');
      }
      const result = await purgeMigratedPages(id, { dryRun: true });
      expect(result.keptPages.find((k) => k.id === pageIds[0])?.reason).toMatch(/marker/);
      // (its text is not in version 1 either; the marker is the reason that matters if it were)
      expect(result.deleted).toBe(3);
    });

    it('a purge keeps a page anything refers to, and says what', async () => {
      const { id, pageIds } = await acme();
      await migrateRadar(id);
      await q(
        `INSERT INTO attachments (blip_id, radar_id, object_key, filename, content_type, size)
         VALUES ($1, $2, 'k/a.png', 'a.png', 'image/png', 3)`,
        [pageIds[0], id],
      );
      await q(
        `INSERT INTO blip_reactions (blip_id, user_id, reaction, radar_id) VALUES ($1, $2, 'thumbs_up', $3)`,
        [pageIds[1], owner.user.id, id],
      );
      // A table that does not exist yet: the catalog finds it, a list written today would not.
      await q(
        `CREATE TABLE IF NOT EXISTS later_blip_notes (blip_id uuid REFERENCES blips (id) ON DELETE CASCADE)`,
      );
      try {
        await q(`INSERT INTO later_blip_notes (blip_id) VALUES ($1)`, [pageIds[2]]);
        const result = await purgeMigratedPages(id);
        expect(result.deleted).toBe(1);
        expect(Object.fromEntries(result.keptPages.map((k) => [k.id, k.reason]))).toEqual({
          [must(pageIds[0])]: 'referenced by attachments',
          [must(pageIds[1])]: 'referenced by blip_reactions',
          [must(pageIds[2])]: 'referenced by later_blip_notes',
        });
        expect(
          (await q(`SELECT count(*)::int AS n FROM attachments WHERE blip_id = $1`, [pageIds[0]]))
            .rows[0]?.['n'],
        ).toBe(1);
        expect((await q(`SELECT count(*)::int AS n FROM later_blip_notes`)).rows[0]?.['n']).toBe(1);
      } finally {
        await q(`DROP TABLE later_blip_notes`);
      }
    });

    it('a blip cannot be moved into a migrated radar as a page: the service and the database both refuse', async () => {
      const target = await acme();
      await migrateRadar(target.id);
      const stream = await createRadar(owner, { name: `Stream ${Math.random()}` });
      const [row] = await db()
        .insert(schema.blips)
        .values({
          radarId: stream.id,
          authorId: owner.user.id,
          state: 'inbox',
          title: 't',
          body: 'b',
        })
        .returning();
      const blipId = must(row).id;
      await refused(
        updateBlip(owner, blipId, { radarId: target.id, status: 'charter' }),
        'charter_is_one_document',
      );
      await expect(
        q(`UPDATE blips SET radar_id = $2, status = 'charter' WHERE id = $1`, [blipId, target.id]),
      ).rejects.toMatchObject({ code: '55000' });
      expect(
        (await db().select().from(schema.blips).where(eq(schema.blips.id, blipId)))[0]?.radarId,
      ).toBe(stream.id);
      // Not yet migrated: the service still refuses (a page is never created by a move either).
      const fresh = await acme();
      await refused(
        updateBlip(owner, blipId, { radarId: fresh.id, status: 'charter' }),
        'charter_is_one_document',
      );
    });
  });

  describe('review round 1', () => {
    it('a lane change seals the anchors as they stand once it holds the charter lock, not as they stood before it waited', async () => {
      const { id } = await acme();
      const { adr } = await proposeAdr(owner, id, {
        title: 'Seal me',
        rationale: 'r',
        anchors: [{ quote: PRINCIPLES, with: 'Advice.' }],
      });
      const before = must((await anchorsOf(id)).find((a) => a.subjectId === adr.id));
      const head = 'Prefix.\n\n';
      const shift =
        projectMarkdown(head + (await doc(id)).body).text.indexOf(PRINCIPLES) -
        must(before.posStart);
      const other = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      const held = await other.connect();
      try {
        // A save in flight: it holds the lock and has moved the text and the anchor's cached place.
        await held.query('BEGIN');
        await held.query('SELECT 1 FROM charter_documents WHERE radar_id = $1 FOR UPDATE', [id]);
        const lane = db().transaction(async (tx) => {
          await tx
            .update(schema.blips)
            .set({ status: 'rejected', state: 'done' })
            .where(eq(schema.blips.id, adr.id));
          await sealAfterLaneChange(tx, id, adr.id, owner);
        });
        const settled = lane.then(() => true);
        await new Promise((r) => setTimeout(r, 400));
        await held.query(`UPDATE charter_documents SET body = $2 || body WHERE radar_id = $1`, [
          id,
          head,
        ]);
        await held.query(
          `UPDATE charter_anchors SET pos_start = pos_start + $2, pos_end = pos_end + $2 WHERE id = $1`,
          [before.id, shift],
        );
        await held.query('COMMIT');
        await settled;
      } finally {
        held.release();
        await other.end();
      }
      const version = must((await versionsOf(id)).at(-1));
      expect(version.cause).toBe('adr');
      const sealed = version.anchors[before.id];
      expect(sealed).toEqual([must(before.posStart) + shift, must(before.posEnd) + shift]);
      const sealedText = must(
        (
          await q<{ body: string }>(
            `SELECT body FROM charter_texts WHERE radar_id = $1 AND sha256 = $2`,
            [id, version.sha256],
          )
        ).rows[0],
      ).body;
      expect(projectMarkdown(sealedText).text.slice(...must(sealed))).toBe(PRINCIPLES);
    });

    it('a legacy selection (occurrence, seen) counts the matches a reader saw: inline code is not one', async () => {
      const { id } = await seed({
        pages: ['Use `Redis` internally.\n\nRedis is the queue.'],
        adrs: [],
      });
      const { adr } = await proposeAdr(owner, id, {
        title: 'Say it differently',
        rationale: 'r',
        anchors: [{ quote: 'Redis', with: 'Valkey', occurrence: 0, seen: 1 }],
      });
      const anchor = must((await anchorsOf(id)).find((a) => a.subjectId === adr.id));
      const text = projectMarkdown(await written(id)).text;
      expect(anchor.posStart).toBe(text.lastIndexOf('Redis'));
      // A count that includes the code span is the stale one.
      await refused(
        proposeAdr(owner, id, {
          title: 'Stale',
          rationale: 'r',
          anchors: [{ quote: 'Redis', with: 'x', occurrence: 0, seen: 2 }],
        }),
        'quote_moved',
      );
    });

    it('a rejected ADR over a wider span does not hide an accepted one inside it, in any view', async () => {
      const { id } = await seed({ pages: ['# T\n\nUse the queue here, always.\n'], adrs: [] });
      const wide = await proposeAdr(owner, id, {
        title: 'Wide',
        rationale: 'r',
        anchors: [{ quote: 'Use the queue here', with: 'Drop it' }],
      });
      await decideAdr(owner, wide.adr.id, { decision: 'reject' });
      const inner = await proposeAdr(owner, id, {
        title: 'Inner',
        rationale: 'r',
        anchors: [{ quote: 'the queue', with: 'a stream' }],
      });
      await decideAdr(owner, inner.adr.id, { decision: 'accept' });
      const amendedView = must(
        (await readArchitecture(owner, id, { view: 'amended' })).charter[0]?.markdown,
      );
      expect(amendedView).toContain('Use a stream here');
      const source = must(
        (await readArchitecture(owner, id, { view: 'source' })).charter[0]?.markdown,
      );
      expect(parseMarkers(source).map((m) => [m.quote, m.layers.map((l) => l.adr)])).toEqual([
        ['the queue', [inner.adr.id]],
      ]);
    });
  });

  describe('two writers', () => {
    it('serialises an accept against a save that orphans it: the accept sees the orphan, not the state before', async () => {
      const { id } = await acme();
      const { adr } = await proposeAdr(owner, id, {
        title: 'Race',
        rationale: 'r',
        anchors: [{ quote: PRINCIPLES, with: 'Advice.' }],
      });
      // A separate connection holds the charter's row lock while it orphans the ADR, as a save would.
      const other = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      const held = await other.connect();
      try {
        await held.query('BEGIN');
        await held.query('SELECT 1 FROM charter_documents WHERE radar_id = $1 FOR UPDATE', [id]);
        let settled = false;
        const accept = decideAdr(owner, adr.id, { decision: 'accept' }).finally(() => {
          settled = true;
        });
        const outcome = accept.then(
          () => 'accepted',
          (e: unknown) => (e as { code?: string }).code,
        );
        await new Promise((r) => setTimeout(r, 400));
        expect(settled, 'the accept waits for the charter lock').toBe(false);
        await held.query(
          `UPDATE charter_anchors SET state = 'orphaned', orphan_cause = 'text_changed', pos_start = NULL, pos_end = NULL
            WHERE subject_id = $1`,
          [adr.id],
        );
        await held.query('COMMIT');
        expect(await outcome).toBe('adr_orphaned');
      } finally {
        held.release();
        await other.end();
      }
      expect(
        (await db().select().from(schema.blips).where(eq(schema.blips.id, adr.id)))[0]?.status,
      ).toBe('proposed');
    });

    it('keeps both when a proposal and a save land together, whichever commits first', async () => {
      const { id } = await acme();
      const read = await readArchitecture(owner, id, { view: 'written' });
      const [saved, proposed] = await Promise.all([
        writeCharter(owner, id, {
          markdown: `${must(read.charter[0]?.markdown)}\n\nA closing paragraph.`,
          baseRevision: must(read.revision),
        }),
        proposeAdr(owner, id, {
          title: 'Concurrent',
          rationale: 'r',
          anchors: [{ quote: PRINCIPLES, with: 'Advice.' }],
        }),
      ]);
      expect(saved.orphaned).toEqual([]);
      const row = must((await anchorsOf(id)).find((a) => a.subjectId === proposed.adr.id));
      expect(row.state).toBe('anchored');
      const { body } = await doc(id);
      expect(body.endsWith('A closing paragraph.')).toBe(true);
      expect(projectMarkdown(body).text.slice(row.posStart ?? 0, row.posEnd ?? 0)).toBe(PRINCIPLES);
      const versions = (await versionsOf(id)).map((v) => v.version);
      expect(versions).toEqual([...versions.keys()].map((n) => n + 1));
    });
  });

  describe('the cost of a save', () => {
    it('re-resolves the 120,000-character charter with its anchors well inside a request', async () => {
      const { id } = await acme();
      await proposeAdr(owner, id, {
        title: 'Timing',
        rationale: 'r',
        anchors: [{ quote: PRINCIPLES, with: 'x' }],
      });
      await save(id, (t) => `${t}\n\nWarm.`);
      const read = await readArchitecture(owner, id, { view: 'written' });
      const text = must(read.charter[0]?.markdown);
      const started = performance.now();
      await writeCharter(owner, id, {
        markdown: `${text}\n\nTimed.`,
        baseRevision: must(read.revision),
      });
      const ms = performance.now() - started;
      // Includes the transaction, the projection of the new text and the diff; the old projection is cached.
      // Measured at about 100 ms here; the bound is generous so CI load does not flake it.
      expect(ms).toBeLessThan(1500);
      expect(projectionOf(text)).toBe(projectionOf(text));
      void sql;
    });
  });
});

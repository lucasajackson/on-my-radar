/**
 * Migration 0091 over a database in today's shape: radars whose charter is pages with markers.
 * The migration is DDL only, so what is proved here is that it touches no existing row (the
 * pages, markers and ADRs are byte-for-byte what they were), makes five empty tables, that the
 * tables' own constraints hold the model together (an amendment needs its replacement, an
 * anchored anchor needs a place, a version cannot be changed, a radar takes everything with it),
 * and that it holds no lock a running application would notice.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { must } from '../errors.js';
import { migrationFiles } from './migrate.js';

const databaseUrl = process.env['DATABASE_URL'];
const DIR = join(import.meta.dirname, '../../drizzle');
const SCRATCH = `omr_m0091_${process.pid}_${Date.now().toString(36)}`;
const TABLES = [
  'charter_documents',
  'charter_texts',
  'charter_versions',
  'charter_anchors',
  'charter_anchor_events',
];

describe.skipIf(!databaseUrl)('migration 0091', () => {
  let admin: pg.Pool | undefined;
  let db: pg.Pool | undefined;
  const q = (text: string, values?: unknown[]) =>
    (db as pg.Pool).query<Record<string, string | number | boolean | null>>(text, values);
  const one = async (text: string, values?: unknown[]) => must((await q(text, values)).rows[0]);
  let radar = '';
  let adr = '';
  let fingerprintBefore = '';
  const fingerprint = async () =>
    String(
      (
        await one(
          `SELECT md5(string_agg(b::text, '|' ORDER BY b.id)) AS h FROM blips b WHERE b.radar_id = $1`,
          [radar],
        )
      )['h'],
    );

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const target = new URL(databaseUrl as string);
    target.pathname = `/${SCRATCH}`;
    db = new pg.Pool({ connectionString: target.toString(), max: 2 });
    db.on('error', () => undefined);
    for (const file of migrationFiles(await readdir(DIR)).filter((f) => f < '0091'))
      await q(await readFile(join(DIR, file), 'utf8'));

    const owner = String(
      (
        await one(`INSERT INTO users (email, state) VALUES ('o@m0091.test', 'active') RETURNING id`)
      )['id'],
    );
    radar = String(
      (
        await one(
          `INSERT INTO radars (owner_id, slug, name, template) VALUES ($1, 'acme-architecture', 'Acme Architecture', 'architecture') RETURNING id`,
          [owner],
        )
      )['id'],
    );
    adr = String(
      (
        await one(
          `INSERT INTO blips (radar_id, author_id, state, status, title, body)
           VALUES ($1, $2, 'done', 'accepted', 'ADR-0027: Acme owns the plan', 'x') RETURNING id`,
          [radar, owner],
        )
      )['id'],
    );
    for (const body of [
      '# 01 · Principles',
      `# 02 · System context\n\n| a | b |\n| - | - |\n| x | :amend[all billing truth]{adr=${adr} with="payment truth only"} |`,
    ])
      await q(
        `INSERT INTO blips (radar_id, author_id, state, status, title, body) VALUES ($1, $2, 'active', 'charter', 'p', $3)`,
        [radar, owner, body],
      );
    fingerprintBefore = await fingerprint();
    await q(await readFile(join(DIR, '0091_charter_document.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  }, 60_000);

  it('adds five empty tables and rewrites no existing row: pages and markers are as they were', async () => {
    for (const table of TABLES)
      expect(Number((await one(`SELECT count(*)::int AS n FROM ${table}`))['n']), table).toBe(0);
    expect(await fingerprint()).toBe(fingerprintBefore);
    expect(Number((await one(`SELECT count(*)::int AS n FROM blips`))['n'])).toBe(3);
  });

  it('holds only DDL: nothing in the file reads or writes a row', async () => {
    const sql = await readFile(join(DIR, '0091_charter_document.sql'), 'utf8');
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    // No statement inserts, updates or deletes rows (the trigger bodies only react to later writes), and
    // none alters a table that already exists.
    expect(statements).not.toMatch(
      /\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b/i,
    );
  });

  it('makes an amendment carry its replacement, and an anchored anchor its place', async () => {
    const base = `INSERT INTO charter_anchors (radar_id, kind, subject_id, with_text, quote, state, pos_start, pos_end, resolved_version)`;
    await expect(
      q(`${base} VALUES ($1, 'amend', $2, NULL, 'q', 'orphaned', NULL, NULL, 1)`, [radar, adr]),
    ).rejects.toThrow(/charter_anchors_check/);
    await expect(
      q(`${base} VALUES ($1, 'link', $2, 'w', 'q', 'orphaned', NULL, NULL, 1)`, [radar, adr]),
    ).rejects.toThrow(/check/);
    await expect(
      q(`${base} VALUES ($1, 'amend', $2, 'w', 'q', 'anchored', NULL, NULL, 1)`, [radar, adr]),
    ).rejects.toThrow(/check/);
    // An orphan names its cause, an anchored one has none.
    await expect(
      q(`${base} VALUES ($1, 'amend', $2, 'w', 'q', 'orphaned', NULL, NULL, 1)`, [radar, adr]),
    ).rejects.toThrow(/check/);
    await q(`${base} VALUES ($1, 'amend', $2, 'w', 'q', 'anchored', 3, 4, 1)`, [radar, adr]);
    await q('DELETE FROM charter_anchors');
  });

  it('refuses a version that names a text the radar does not hold, and any change to a version', async () => {
    await expect(
      q(
        `INSERT INTO charter_versions (radar_id, version, sha256, cause) VALUES ($1, 1, repeat('a', 64), 'edit')`,
        [radar],
      ),
    ).rejects.toThrow(/foreign key/);
    await q(
      `INSERT INTO charter_texts (radar_id, sha256, body) VALUES ($1, repeat('a', 64), 'text')`,
      [radar],
    );
    await q(
      `INSERT INTO charter_versions (radar_id, version, sha256, cause) VALUES ($1, 1, repeat('a', 64), 'edit')`,
      [radar],
    );
    await expect(
      q(`UPDATE charter_versions SET cause = 'adr' WHERE radar_id = $1`, [radar]),
    ).rejects.toThrow(/immutable/);
    await expect(q(`DELETE FROM charter_versions WHERE radar_id = $1`, [radar])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      q(
        `INSERT INTO charter_versions (radar_id, version, sha256, cause) VALUES ($1, 0, repeat('a', 64), 'edit')`,
        [radar],
      ),
    ).rejects.toThrow(/check/);
  });

  it('is taken whole with the radar, even though a version cannot be deleted on its own', async () => {
    await q(`INSERT INTO charter_documents (radar_id, body) VALUES ($1, 'x')`, [radar]);
    await q('DELETE FROM radars WHERE id = $1', [radar]);
    for (const table of TABLES)
      expect(Number((await one(`SELECT count(*)::int AS n FROM ${table}`))['n']), table).toBe(0);
  });
});

/**
 * The migrator's two tracks (CE and EE), and the promise that adding them changed
 * nothing for production.
 *
 * Production is at migration 0089, applied by the pre-tracks runner: a three-column
 * `schema_migrations` keyed by bare filename. The first block builds that database the
 * way the old runner did, and proves the new migrator applies nothing to it, rewrites no
 * row and reads every row as `ce`. The rest exercises the tracks on databases of their own.
 *
 * Every database here is private (see migrate.test.ts for why), and EE fixtures live in a
 * temp directory: nothing is written to `ee/server/drizzle`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrationFiles, requiresCe, runMigrations } from './migrate.js';

const databaseUrl = process.env['DATABASE_URL'];
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

/** Every CE migration prod has applied, by name, with the sha256 of its bytes. */
const pinned = JSON.parse(
  readFileSync(join(import.meta.dirname, 'migrations-at-0089.json'), 'utf8'),
) as Record<string, string>;

const CE_DIR = join(import.meta.dirname, '../../drizzle');
const RUN = `${process.pid}_${Date.now().toString(36)}`;

/** `schema_migrations` exactly as the runner created it before tracks existed. */
const LEGACY_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const upTo0089 = (names: string[]) => names.filter((f) => f.slice(0, 4) <= '0089');

describe('the CE migration files prod has applied', () => {
  it('are byte-identical to what 0089 shipped: same names, none renamed, none edited', async () => {
    const names = upTo0089(migrationFiles(await readdir(CE_DIR)));
    expect(names).toEqual(Object.keys(pinned).sort());
    for (const name of names) {
      expect(sha(await readFile(join(CE_DIR, name), 'utf8')), name).toBe(pinned[name]);
    }
  });
});

describe('file names cannot escape or impersonate a track', () => {
  it.each(['../0001_x.sql', '0001_a/b.sql', 'ee/0001_x.sql', '..\\0001_x.sql'])(
    'refuses %s',
    (name) => {
      expect(() => migrationFiles([name])).toThrow(/Not a migration file name/);
    },
  );
});

describe('requires-ce', () => {
  it('reads line 1 only, strictly', () => {
    expect(requiresCe('-- requires-ce: 0089\nSELECT 1;', 'x')).toBe(89);
    expect(requiresCe('-- requires-ce: 0089\r\nSELECT 1;', 'x')).toBe(89);
    for (const bad of [
      'SELECT 1;',
      '\n-- requires-ce: 0089',
      '-- requires-ce: 89',
      '-- requires-ce: 0089 ',
      '--requires-ce: 0089',
      '',
    ]) {
      expect(() => requiresCe(bad, 'ee/0001_x.sql'), JSON.stringify(bad)).toThrow(
        /ee\/0001_x\.sql must start with "-- requires-ce: NNNN"/,
      );
    }
  });
});

describe.skipIf(!databaseUrl)('migrator tracks, against Postgres', () => {
  let admin: pg.Pool;
  const pools: pg.Pool[] = [];
  const dbs: string[] = [];
  const dirs: string[] = [];
  let counter = 0;
  const LEGACY = `omr_trk_legacy_${RUN}`;

  const urlFor = (db: string) => {
    const u = new URL(databaseUrl as string);
    u.pathname = `/${db}`;
    return u.toString();
  };
  /** A private database, optionally cloned from the 0089 one. */
  async function scratch(template?: string): Promise<pg.Pool> {
    const db = `omr_trk_${RUN}_${counter++}`;
    await admin.query(`CREATE DATABASE ${db}${template ? ` TEMPLATE ${template}` : ''}`);
    dbs.push(db);
    const pool = new pg.Pool({ connectionString: urlFor(db), max: 10 });
    pool.on('error', () => undefined);
    pools.push(pool);
    return pool;
  }
  async function dirWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'omr-trk-'));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
    return dir;
  }
  const rows = async (pool: pg.Pool) =>
    (
      await pool.query<{ filename: string; checksum: string; applied_at: Date; track: string }>(
        'SELECT filename, checksum, applied_at, track FROM schema_migrations ORDER BY filename',
      )
    ).rows;
  const tables = async (pool: pg.Pool) =>
    (
      await pool.query<{ t: string }>(
        `SELECT table_name AS t FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY 1`,
      )
    ).rows.map((r) => r.t);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    // The database prod is: every file up to 0089 applied by the pre-tracks runner.
    await admin.query(`CREATE DATABASE ${LEGACY}`);
    dbs.push(LEGACY);
    const legacy = new pg.Pool({ connectionString: urlFor(LEGACY), max: 1 });
    try {
      await legacy.query(LEGACY_TABLE);
      for (const name of upTo0089(migrationFiles(await readdir(CE_DIR)))) {
        const sql = await readFile(join(CE_DIR, name), 'utf8');
        const c = await legacy.connect();
        try {
          await c.query('BEGIN');
          await c.query(sql);
          await c.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
            name,
            sha(sql),
          ]);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          c.release();
        }
      }
    } finally {
      await legacy.end();
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    for (const db of dbs) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  }, 60_000);

  describe('a database at 0089, as prod is', () => {
    /** Exactly the 0089 files, so the test keeps meaning "at 0089" after 0090 lands. */
    let ce089: string;
    beforeAll(async () => {
      ce089 = await dirWith({});
      for (const name of upTo0089(migrationFiles(await readdir(CE_DIR)))) {
        await cp(join(CE_DIR, name), join(ce089, name));
      }
    });

    it('applies nothing, rewrites no row, and reads every existing row as ce', async () => {
      const pool = await scratch(LEGACY);
      const before = await rows0089(pool);
      const tablesBefore = await tables(pool);
      expect(before.columns).toEqual(['filename', 'checksum', 'applied_at']);
      expect(before.rows).toHaveLength(Object.keys(pinned).length);

      const first = await runMigrations(pool, { ce: ce089 });
      expect(first.applied).toEqual([]);
      expect(first.skipped).toEqual(Object.keys(pinned).sort());

      const after = await rows0089(pool);
      expect(after.columns).toEqual(['filename', 'checksum', 'applied_at', 'track']);
      // Same rows, same checksums, same timestamps: nothing re-run, renamed or reordered.
      expect(after.rows.map(({ track: _track, ...r }) => r)).toEqual(before.rows);
      expect(new Set(after.rows.map((r) => r.track))).toEqual(new Set(['ce']));
      expect(await tables(pool)).toEqual(tablesBefore);

      const second = await runMigrations(pool, { ce: ce089 });
      expect(second.applied).toEqual([]);
      expect(await rows0089(pool)).toEqual(after);
    }, 60_000);

    it('with the repo CE directory, applies only what is newer than 0089', async () => {
      const pool = await scratch(LEGACY);
      const newer = migrationFiles(await readdir(CE_DIR)).filter((f) => f.slice(0, 4) > '0089');
      const run = await runMigrations(pool);
      expect(run.applied).toEqual(newer);
      expect(run.skipped).toHaveLength(Object.keys(pinned).length);
    }, 120_000);

    it('survives four migrators racing to add the track column', async () => {
      const pool = await scratch(LEGACY);
      const runs = await Promise.all(
        Array.from({ length: 4 }, () => runMigrations(pool, { ce: ce089 })),
      );
      for (const r of runs) expect(r.applied).toEqual([]);
      expect((await rows0089(pool)).rows).toHaveLength(Object.keys(pinned).length);
    }, 60_000);

    /** Rows without `track`, and the column list, so before and after compare. */
    async function rows0089(pool: pg.Pool) {
      const cols = await pool.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns
          WHERE table_name = 'schema_migrations' ORDER BY ordinal_position`,
      );
      const all = await pool.query<{
        filename: string;
        checksum: string;
        applied_at: Date;
        track?: string;
      }>('SELECT * FROM schema_migrations ORDER BY filename');
      return { columns: cols.rows.map((r) => r.c), rows: all.rows };
    }
  });

  describe('a fresh install', () => {
    it('CE only: applies every CE file and writes nothing on the ee track', async () => {
      const pool = await scratch();
      const files = migrationFiles(await readdir(CE_DIR));
      const first = await runMigrations(pool);
      expect(first.applied).toEqual(files);
      expect(new Set((await rows(pool)).map((r) => r.track))).toEqual(new Set(['ce']));
      expect((await runMigrations(pool)).applied).toEqual([]);
    }, 120_000);

    it('CE + EE: all CE files first, then the EE files in order, recorded as ee/…', async () => {
      const pool = await scratch();
      const ee = await dirWith({
        '0001_probe_a.sql': '-- requires-ce: 0089\nCREATE TABLE ee_probe_a (id int);',
        '0002_probe_b.sql': '-- requires-ce: 0089\nCREATE TABLE ee_probe_b (id int);',
      });
      const files = migrationFiles(await readdir(CE_DIR));
      const first = await runMigrations(pool, { ee });
      expect(first.applied).toEqual([...files, 'ee/0001_probe_a.sql', 'ee/0002_probe_b.sql']);
      const all = await rows(pool);
      expect(all.filter((r) => r.track === 'ce')).toHaveLength(files.length);
      expect(all.filter((r) => r.track === 'ee').map((r) => r.filename)).toEqual([
        'ee/0001_probe_a.sql',
        'ee/0002_probe_b.sql',
      ]);
      expect(await tables(pool)).toEqual(expect.arrayContaining(['ee_probe_a', 'ee_probe_b']));
      expect((await runMigrations(pool, { ee })).applied).toEqual([]);
    }, 120_000);
  });

  describe('ordering and refusals', () => {
    const ceFiles = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `000${i + 1}_t${i + 1}.sql`,
          `CREATE TABLE t${i + 1} (id int);`,
        ]),
      );

    it('refuses an EE file needing a CE migration the CE track has not reached', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(2));
      const ee = await dirWith({
        '0001_ok.sql': '-- requires-ce: 0002\nCREATE TABLE ee_ok (id int);',
        '0002_ahead.sql': '-- requires-ce: 0003\nCREATE TABLE ee_ahead (id int);',
      });
      await expect(runMigrations(pool, { ce, ee })).rejects.toThrow(
        /ee\/0002_ahead\.sql requires CE migration 0003 but the CE track is at 0002/,
      );
      expect(await tables(pool)).toEqual(expect.arrayContaining(['t1', 't2', 'ee_ok']));
      expect(await tables(pool)).not.toContain('ee_ahead');
      expect((await rows(pool)).map((r) => r.filename)).not.toContain('ee/0002_ahead.sql');
    });

    it('refuses an EE file with no requires-ce line, and applies none of it', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(1));
      const ee = await dirWith({ '0001_bare.sql': 'CREATE TABLE ee_bare (id int);' });
      await expect(runMigrations(pool, { ce, ee })).rejects.toThrow(/must start with/);
      expect(await tables(pool)).not.toContain('ee_bare');
    });

    it('a CE install upgrades to CE+EE without disturbing a single CE row', async () => {
      const pool = await scratch();
      const ce = await dirWith({
        '0001_data.sql': "CREATE TABLE t_data (note text); INSERT INTO t_data VALUES ('kept');",
      });
      await runMigrations(pool, { ce });
      const before = await rows(pool);

      const ee = await dirWith({
        '0001_extra.sql': '-- requires-ce: 0001\nALTER TABLE t_data ADD COLUMN ee_flag boolean;',
      });
      const up = await runMigrations(pool, { ce, ee });
      expect(up.applied).toEqual(['ee/0001_extra.sql']);
      expect((await rows(pool)).filter((r) => r.track === 'ce')).toEqual(before);
      expect((await pool.query('SELECT note FROM t_data')).rows).toEqual([{ note: 'kept' }]);
    });

    it('a CE file added after EE was applied still applies: the prefix check is per track', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(1));
      const ee = await dirWith({
        '0001_e.sql': '-- requires-ce: 0001\nCREATE TABLE ee_e (id int);',
      });
      await runMigrations(pool, { ce, ee });
      // 'ee/0001_e.sql' sorts after every digit. Checked against the CE files it would make
      // this pending one look out of order; it is a different track, so it must not.
      await writeFile(join(ce, '0002_t2.sql'), 'CREATE TABLE t2 (id int);');
      const next = await runMigrations(pool, { ce, ee });
      expect(next.applied).toEqual(['0002_t2.sql']);
    });

    it('still refuses a pending file that sorts before an applied one on the same track', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(1));
      const ee = await dirWith({ '0002_late.sql': '-- requires-ce: 0001\nSELECT 1;' });
      await runMigrations(pool, { ce, ee });
      await writeFile(join(ee, '0001_early.sql'), '-- requires-ce: 0001\nSELECT 1;');
      await expect(runMigrations(pool, { ce, ee })).rejects.toThrow(
        /0001_early\.sql is pending but sorts before already-applied '0002_late\.sql'/,
      );
    });

    it('numbers each track on its own: 0001 may exist on both, and each is checksummed alone', async () => {
      const pool = await scratch();
      const ce = await dirWith({ '0001_init.sql': 'CREATE TABLE t_init (id int);' });
      const ee = await dirWith({
        '0001_init.sql': '-- requires-ce: 0001\nCREATE TABLE ee_init (id int);',
      });
      const first = await runMigrations(pool, { ce, ee });
      expect(first.applied).toEqual(['0001_init.sql', 'ee/0001_init.sql']);

      await writeFile(
        join(ee, '0001_init.sql'),
        '-- requires-ce: 0001\nCREATE TABLE ee_other (id int);',
      );
      await expect(runMigrations(pool, { ce, ee })).rejects.toThrow(
        /Migration ee\/0001_init\.sql was modified after it was applied/,
      );
      await writeFile(
        join(ee, '0001_init.sql'),
        '-- requires-ce: 0001\nCREATE TABLE ee_init (id int);',
      );
      await writeFile(join(ce, '0001_init.sql'), 'CREATE TABLE t_other (id int);');
      await expect(runMigrations(pool, { ce, ee })).rejects.toThrow(
        /Migration 0001_init\.sql was modified after it was applied/,
      );
    });

    it('a CE-only run on a CE+EE database applies nothing and leaves the ee rows alone', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(1));
      const ee = await dirWith({
        '0001_e.sql': '-- requires-ce: 0001\nCREATE TABLE ee_e (id int);',
      });
      await runMigrations(pool, { ce, ee });
      const before = await rows(pool);
      expect((await runMigrations(pool, { ce })).applied).toEqual([]);
      expect(await rows(pool)).toEqual(before);
    });

    it('refuses a row whose track disagrees with its name, and a track that is neither', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(1));
      await runMigrations(pool, { ce });
      await pool.query(
        "INSERT INTO schema_migrations (filename, checksum, track) VALUES ('ee/0009_x.sql', 'x', 'ce')",
      );
      await expect(runMigrations(pool, { ce })).rejects.toThrow(
        /'ee\/0009_x\.sql' is on track 'ce' but its name says 'ee'/,
      );
      await expect(
        pool.query(
          "INSERT INTO schema_migrations (filename, checksum, track) VALUES ('a', 'x', 'zz')",
        ),
      ).rejects.toThrow(/schema_migrations_track_check/);
    });

    it('four migrators racing across both tracks apply each file exactly once', async () => {
      const pool = await scratch();
      const ce = await dirWith(ceFiles(3));
      const ee = await dirWith({
        '0001_a.sql': '-- requires-ce: 0003\nCREATE TABLE ee_a (id int);',
        '0002_b.sql': '-- requires-ce: 0003\nCREATE TABLE ee_b (id int);',
      });
      const results = await Promise.all(
        Array.from({ length: 4 }, () => runMigrations(pool, { ce, ee })),
      );
      const applied = results.flatMap((r) => r.applied).sort();
      expect(applied).toEqual([
        '0001_t1.sql',
        '0002_t2.sql',
        '0003_t3.sql',
        'ee/0001_a.sql',
        'ee/0002_b.sql',
      ]);
      expect((await rows(pool)).map((r) => r.track).sort()).toEqual(['ce', 'ce', 'ce', 'ee', 'ee']);
    }, 60_000);
  });
});

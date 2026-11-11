/**
 * The migrator, against a real Postgres: its concurrency guarantee, and the
 * promise `schema.ts` makes about what exists once it has run.
 *
 * `check what is applied, then apply the rest` is a read-modify-write, so two
 * migrators that start together will both decide a file is unapplied unless
 * something serialises them. The loser then fails on what the winner already
 * created — `CREATE EXTENSION pgcrypto` collides on pg_extension_name_index,
 * `CREATE TABLE` on pg_type_typname_nsp_index.
 *
 * This is a production property, not a test-harness one: the app migrates at
 * boot under MIGRATE_ON_BOOT and deploys roll pods, so two pods booting
 * together race precisely here. It is asserted with real concurrent sessions
 * because an advisory lock is a database behaviour — a mock would only be
 * asserting that we called the function we wrote.
 *
 * **This suite migrates a database of its own.** The interesting half of the
 * assertion is a *cold start*: every file applied by exactly one of the four
 * migrators, everybody else skipping. That is only observable on a database
 * nothing has migrated yet — and every other suite here calls `runMigrations()`
 * in its own `beforeAll`, against the same DATABASE_URL, in a parallel worker.
 * Sharing it made this test a coin toss on which file reached the advisory lock
 * first; it failed roughly a third of cold runs. The advisory lock, the
 * concurrency and the SQL are all still real — only the database is private.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertAppliedPrefix, migrationFiles, runMigrations } from './migrate.js';
import { ALL_TABLE_NAMES } from './schema.js';
import { must } from '../errors.js';

const databaseUrl = process.env['DATABASE_URL'];
// The env is validated at boot and refuses a short secret; a suite that never
// signs anybody in still has to satisfy it.
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

/** A name no other worker will pick, and legal unquoted. */
const SCRATCH_DB = `omr_migrate_race_${process.pid}_${Date.now().toString(36)}`;

describe.skipIf(!databaseUrl)('the migrator', () => {
  let admin: pg.Pool | undefined;
  let scratch: pg.Pool | undefined;

  beforeAll(async () => {
    // Connected to the configured database purely to issue CREATE DATABASE;
    // nothing in this suite touches it otherwise.
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    const target = new URL(databaseUrl as string);
    target.pathname = `/${SCRATCH_DB}`;
    scratch = new pg.Pool({ connectionString: target.toString(), max: 10 });
    // The scratch database is dropped WITH (FORCE) in afterAll, which terminates
    // any socket still open on it. An idle-client error arrives on the pool, not
    // on a query, so without this handler that teardown surfaces as an uncaught
    // exception and fails a run whose assertions all passed.
    scratch.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await scratch?.end();
    // The scratch database must go even if an assertion failed, or a rerun
    // inherits a half-migrated one and the cold-start property evaporates again.
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  }, 60_000);

  it('survives four migrators racing from a cold start', async () => {
    const results = await Promise.all([
      runMigrations(scratch),
      runMigrations(scratch),
      runMigrations(scratch),
      runMigrations(scratch),
    ]);

    // Every one of them has to succeed. Before the advisory lock, three of
    // these four died on the winner's objects.
    expect(results).toHaveLength(4);

    // Each file is applied exactly once across the whole set, no matter which
    // migrator got there first; everyone else must have skipped it.
    const applied = results.flatMap((r) => r.applied);
    expect(new Set(applied).size).toBe(applied.length);

    const seen = [...new Set([...applied, ...results.flatMap((r) => r.skipped)])];
    expect(seen.length).toBeGreaterThan(0);
    for (const filename of seen) {
      const owners = results.filter((r) => r.applied.includes(filename));
      expect(owners).toHaveLength(1);
    }
  }, 60_000);

  it('is a no-op once applied, which is what makes MIGRATE_ON_BOOT safe', async () => {
    const again = await runMigrations(scratch);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
  }, 30_000);

  /**
   * The guarantee `schema.ts`'s header has claimed since it was written, and
   * which until now had nothing behind it: `ALL_TABLE_NAMES` had exactly one
   * occurrence in the tree — its own declaration.
   *
   * It earns its place because the SQL is the source of truth and `schema.ts`
   * only mirrors it *by hand*. Drizzle never touches the database at build time,
   * so a table declared in TypeScript and never created in SQL typechecks, lints
   * and builds; it fails at the first query against it, in production, on
   * whatever code path happens to reach it first. Asserted here rather than in a
   * service suite because this is the one file with a database nothing else has
   * migrated, so it is asserting the migrations and not the residue of another
   * suite's fixtures.
   *
   * Both directions, deliberately. The forward direction catches a declaration
   * with no migration; the reverse catches a migration with no declaration,
   * which is how a table comes to exist that no typed query can reach and that
   * nobody remembers to include in a backup or a purge.
   */
  it('creates every table schema.ts declares, and declares every table it creates', async () => {
    const { rows } = await must(scratch).query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    // The migrator's own bookkeeping, created by the migrator rather than by a
    // migration, and deliberately not a Drizzle table.
    const inDatabase = new Set(
      rows.map((r) => r.table_name).filter((n) => n !== 'schema_migrations'),
    );
    const declared = new Set<string>(ALL_TABLE_NAMES);

    const missing = [...declared].filter((t) => !inDatabase.has(t)).sort();
    expect(missing, 'declared in schema.ts but no migration creates it').toEqual([]);

    const undeclared = [...inDatabase].filter((t) => !declared.has(t)).sort();
    expect(undeclared, 'created by a migration but missing from ALL_TABLE_NAMES').toEqual([]);
  }, 30_000);

  it('releases the lock, so a later migrator is never blocked by an earlier one', async () => {
    // Scoped to this suite's own database. `pg_locks` is cluster-wide, and
    // advisory locks are per-database, so an unfiltered count also sees the
    // migrators the other suites are running against the shared DATABASE_URL in
    // parallel workers — which made this assert on other people's locks.
    const { rows } = await must(scratch).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks
        WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  /*
    The radar stream's ORDER BY and keyset, walked off an index rather than
    sorted. With sorting and scans priced out of reach, a plan that still
    contains a Sort is one no index can produce — which is what the stream was
    until 0034: every page a top-N sort over the whole radar. Written with the
    same keys, directions and row-value cursor `listBlips` uses; a sort key
    added there without extending the index fails here.
  */
  it('serves the radar stream from an index, cursor and all', async () => {
    const client = await must(scratch).connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_sort = off');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM blips
          WHERE radar_id = '00000000-0000-0000-0000-000000000001'
            AND (pinned, created_at, id)
              < (true, '2026-09-26 12:00:00+00', '00000000-0000-0000-0000-000000000002')
          ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 51`,
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('blips_radar_stream_idx');
      expect(plan).not.toMatch(/\bSort\b/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('migration file names', () => {
  it('refuses an iCloud conflict copy instead of applying it as a new migration', () => {
    expect(() =>
      migrationFiles(['0036_scrub_feed_credentials.sql', '0036_scrub_feed_credentials 2.sql']),
    ).toThrow(/'0036_scrub_feed_credentials 2\.sql'.*iCloud/);
  });

  it('orders the real ones and ignores what is not SQL', () => {
    expect(migrationFiles(['0010_b.sql', 'README.md', '0002_a.sql'])).toEqual([
      '0002_a.sql',
      '0010_b.sql',
    ]);
  });

  it('refuses two migrations sharing a number', () => {
    expect(() => migrationFiles(['0059_a.sql', '0059_b.sql'])).toThrow(
      /Duplicate migration number: '0059_a\.sql' and '0059_b\.sql'/,
    );
  });

  it('requires the applied set to be a prefix of the ordered files', () => {
    const files = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
    expect(() => assertAppliedPrefix(files, ['0001_a.sql'])).not.toThrow();
    expect(() => assertAppliedPrefix(files, files)).not.toThrow();
    expect(() => assertAppliedPrefix(files, ['0001_a.sql', '0003_c.sql'])).toThrow(
      /0002_b\.sql is pending but sorts before already-applied '0003_c\.sql'/,
    );
    expect(() =>
      assertAppliedPrefix(['0001_a.sql', '0002_b.sql'], ['0001_a.sql', '0009_gone.sql']),
    ).toThrow(/renumber 0002_b\.sql above 0009_gone\.sql/);
  });
});

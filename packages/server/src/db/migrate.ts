/**
 * Forward-only SQL migrator.
 *
 * Files in `packages/server/drizzle/*.sql` are applied in lexical order, each in
 * its own transaction, and recorded in `schema_migrations`. A file that has
 * already been applied is skipped; a file whose checksum changed after being
 * applied is a hard error, because silently re-running an edited migration is
 * how environments drift apart.
 *
 * The whole run is serialised by a session-level advisory lock. `checked, then
 * applied` is a read-modify-write against shared state, so without the lock two
 * migrators that start together both see a file unapplied and both run it — and
 * the loser dies on whatever the winner already created (`pgcrypto` already
 * exists, duplicate key in `pg_type`). That is not a hypothetical: the app runs
 * migrations at boot under MIGRATE_ON_BOOT and deploys are a rolling restart,
 * so any deploy that overlaps two booting pods races exactly this way. CI found
 * it first, with two test files migrating in parallel workers.
 *
 * **Two tracks.** The community edition (CE) files above are the `ce` track. The
 * enterprise edition (EE) adds files of its own on an `ee` track, in a directory
 * the EE build hands in; a CE-only build has none. Each track is numbered, ordered
 * and prefix-checked on its own, because one shared number space breaks the CE to
 * EE upgrade: a CE install that applied 0101 and 0103 would refuse an EE 0102.
 * A run applies pending CE files first, then pending EE files, under the one lock.
 *
 * `schema_migrations.track` is `ce` for every row written before tracks existed
 * and for every CE row since, keyed by its bare filename exactly as always. An EE
 * row is keyed `ee/<filename>`, so the two tracks can never collide on the primary
 * key, and an EE row can never be mistaken for a CE one: the migrator refuses a row
 * whose track disagrees with its prefix.
 *
 * Rules the tracks rest on (CI proves the first, once the EE build exists):
 *  1. CE SQL never names an EE object, so CE migrates without `ee/`.
 *  2. EE SQL creates EE-owned objects; anything it adds to a CE table is `ee_`-prefixed.
 *  3. A CE migration never drops or renames a column without a deprecation release first.
 * An EE file declares the newest CE migration it needs on line 1 (`-- requires-ce: 0089`)
 * and is refused until the CE track has reached it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { getPool } from './client.js';
import { env } from '../env.js';
import { errorMessage } from '../errors.js';
import { logger } from '../logger.js';

/** dist/db/migrate.js and src/db/migrate.ts both sit two levels under the package root. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

export type MigrationTrack = 'ce' | 'ee';

/** An EE row is recorded as `ee/<filename>`; a CE row as the bare filename it always was. */
const EE_PREFIX = 'ee/';
const trackOf = (recorded: string): MigrationTrack =>
  recorded.startsWith(EE_PREFIX) ? 'ee' : 'ce';

/** Directories to migrate from. `ee` is absent in a CE-only build, which then has no EE track. */
export interface MigrationDirs {
  ce?: string;
  ee?: string;
}

/**
 * Arbitrary but fixed: every migrator must pick the same number to exclude each
 * other, and it must not collide with an advisory lock taken anywhere else.
 * The others are transaction-scoped and keyed by hashing a namespaced string
 * (`oauth-grant:…`, `radar-settings:…`, `dashboards:…`); `hashtext` yields an
 * int4, which can never equal this, and `hashtextextended` a 64-bit value that
 * meets it with odds nobody needs to plan for.
 */
const MIGRATION_LOCK_KEY = 4_021_887_305_119_364n;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Names of the tables this image's own migrations create. A table in the database that is not
 * in this set came from a migration newer than the image (a rolling deploy, or an image-only
 * rollback), which this image cannot know how to classify.
 */
export function createdTables(sqlFiles: Iterable<string>): Set<string> {
  const tables = new Set<string>();
  const create =
    /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  const rename =
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?\S+\s+RENAME\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi;
  for (const file of sqlFiles) {
    const sql = file.replace(/--.*$/gm, '');
    for (const [, name = ''] of [...sql.matchAll(create), ...sql.matchAll(rename)])
      tables.add(name.toLowerCase());
  }
  return tables;
}

let imageTables: Promise<Set<string>> | undefined;
export function imageMigrationTables(dir = MIGRATIONS_DIR): Promise<Set<string>> {
  imageTables ??= readdir(dir).then(async (names) =>
    createdTables(
      await Promise.all(migrationFiles(names).map((f) => readFile(join(dir, f), 'utf8'))),
    ),
  );
  imageTables.catch(() => (imageTables = undefined));
  return imageTables;
}

/** Filenames as recorded in `schema_migrations`: CE files first, then `ee/…` ones. */
export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * `pool` exists so the concurrency test can race four migrators against a
 * database of its own. The property under test is a *cold start* — every file
 * applied by exactly one migrator — and that is only observable on a database
 * nothing else has already migrated. Sharing the app pool made it depend on
 * which test file reached the advisory lock first, which is a coin toss.
 * Production always takes the default.
 */
/**
 * The migration files in a directory listing, in order — or a refusal naming any
 * \`.sql\` file that is not shaped like a migration.
 *
 * iCloud Drive syncs \`~/Documents\`, and on a conflict it writes a copy beside
 * the original: \`0036_scrub_feed_credentials 2.sql\`. Every \`.sql\` used to be a
 * migration, so the copy would have been applied as a new one, a second time,
 * under a name nobody wrote. Found in a real checkout on 2026-09-26. Refusing is
 * loud where applying was silent; the fix is to delete the copy.
 */
export function migrationFiles(names: readonly string[]): string[] {
  const sql = names.filter((f) => f.endsWith('.sql'));
  const strays = sql.filter((f) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(f));
  if (strays.length > 0) {
    throw new Error(
      `Not a migration file name: ${strays.map((f) => `'${f}'`).join(', ')}. ` +
        'Migrations are NNNN_snake_case.sql; a "name 2.sql" is usually an iCloud conflict copy — delete it.',
    );
  }
  const sorted = sql.sort((a, b) => a.localeCompare(b, 'en'));
  const byNumber = new Map<string, string[]>();
  for (const f of sorted) byNumber.set(f.slice(0, 4), [...(byNumber.get(f.slice(0, 4)) ?? []), f]);
  const dupes = [...byNumber.values()].filter((group) => group.length > 1);
  if (dupes.length > 0) {
    throw new Error(
      `Duplicate migration number: ${dupes.map((g) => g.map((f) => `'${f}'`).join(' and ')).join('; ')}. ` +
        'Each migration needs its own NNNN prefix; renumber the unapplied one above the highest applied.',
    );
  }
  return sorted;
}

/**
 * Applied migrations must be a prefix of the ordered file list. A pending file
 * that sorts BEFORE an applied one was written on a branch that merged late; running
 * it now would apply schema out of order against a database that already moved on.
 */
export function assertAppliedPrefix(files: readonly string[], applied: Iterable<string>): void {
  const done = new Set(applied);
  const firstPending = files.find((f) => !done.has(f));
  if (!firstPending) return;
  const later = [...done]
    .filter((f) => f.localeCompare(firstPending, 'en') > 0)
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (later.length > 0) {
    throw new Error(
      `Migration ${firstPending} is pending but sorts before already-applied ${later
        .map((f) => `'${f}'`)
        .join(
          ', ',
        )}. Migrations must apply in order: renumber ${firstPending} above ${later.at(-1) ?? firstPending}.`,
    );
  }
}

export async function runMigrations(
  pool: Pool = getPool(),
  dirs: MigrationDirs = {},
): Promise<MigrationResult> {
  const ceDir = dirs.ce ?? MIGRATIONS_DIR;
  const tracks: TrackFiles[] = [
    { track: 'ce', dir: ceDir, files: migrationFiles(await readdir(ceDir)) },
  ];
  if (dirs.ee !== undefined) {
    tracks.push({ track: 'ee', dir: dirs.ee, files: migrationFiles(await readdir(dirs.ee)) });
  }

  // One connection for the entire run: the lock is session-level, so it lives
  // exactly as long as this client holds it, and is released even if the
  // process is killed mid-migration (the backend dies with the connection).
  const client: PoolClient = await pool.connect();

  try {
    // The pool's statement and idle-in-transaction limits are for request traffic.
    // A migrator waiting on another's advisory lock, or running a DDL that takes
    // a minute, is neither; its patience is bounded by `lock_timeout` below instead.
    await client.query('SET statement_timeout = 0');
    await client.query('SET idle_in_transaction_session_timeout = 0');
    const { rows: got } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MIGRATION_LOCK_KEY.toString()],
    );
    if (got[0]?.locked !== true) {
      logger.info('waiting for the migration lock held by another migrator');
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }

    try {
      return await applyMigrations(client, tracks);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()])
        .catch(() => undefined);
    }
  } finally {
    // Back to the pool's values: the session outlives this call.
    await client
      .query('RESET statement_timeout; RESET idle_in_transaction_session_timeout')
      .catch(() => undefined);
    client.release();
  }
}

/** Postgres `lock_not_available`: raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * One migration in its own transaction. A lock timeout (`lock_timeout`, see below) rolls
 * the attempt back and tries again, a bounded number of times; anything else fails at once.
 */
export async function applyWithLockRetry(
  client: PoolClient,
  filename: string,
  sql: string,
  sum: string,
  track: MigrationTrack = 'ce',
): Promise<void> {
  const lockTimeoutMs = env().MIGRATE_LOCK_TIMEOUT_MS;
  const retries = env().MIGRATE_LOCK_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query('BEGIN');
      // Not the advisory-lock wait (that is outside this transaction): this is a
      // table lock held by live traffic. Failing fast and trying again beats
      // queueing behind it, because while this DDL waits for its lock every
      // query on that table queues behind the DDL.
      await client.query(`SET LOCAL lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
      await client.query(sql);
      // A CE row is written exactly as it was before tracks existed; `track` defaults to 'ce'.
      await (track === 'ce'
        ? client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
            filename,
            sum,
          ])
        : client.query(
            'INSERT INTO schema_migrations (filename, checksum, track) VALUES ($1, $2, $3)',
            [filename, sum, track],
          ));
      await client.query('COMMIT');
      logger.info({ filename }, 'migration applied');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE && attempt < retries) {
        logger.warn(
          { filename, attempt: attempt + 1, retries },
          'migration lock timed out; retrying',
        );
        await sleep(Math.min(5_000, 250 * 2 ** attempt));
        continue;
      }
      throw new Error(`Migration ${filename} failed: ${errorMessage(err, 'no message')}`, {
        cause: err,
      });
    }
  }
}

interface TrackFiles {
  track: MigrationTrack;
  dir: string;
  files: string[];
}

/**
 * Line 1 of an EE migration: the newest CE migration it needs. Anything else on line 1
 * is a refusal, so a file that forgot its dependency cannot slip in.
 */
export function requiresCe(sql: string, filename: string): number {
  const match = /^-- requires-ce: (\d{4})\r?$/.exec(sql.split('\n', 1)[0] ?? '');
  if (!match) {
    throw new Error(
      `Migration ${filename} must start with "-- requires-ce: NNNN" naming the newest CE ` +
        'migration it needs.',
    );
  }
  return Number(match[1]);
}

/**
 * The actual work, with the lock already held — so the read of
 * `schema_migrations` below sees everything a migrator that went first
 * committed, and this run correctly skips it.
 */
async function applyMigrations(client: PoolClient, tracks: TrackFiles[]): Promise<MigrationResult> {
  await client.query(CREATE_TABLE);
  // Idempotent, and a no-op on every boot after the first. Existing rows read 'ce'.
  await client.query(
    `ALTER TABLE schema_migrations
       ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'ce' CHECK (track IN ('ce', 'ee'))`,
  );

  const { rows } = await client.query<{ filename: string; checksum: string; track: string }>(
    'SELECT filename, checksum, track FROM schema_migrations',
  );
  const previous = new Map(rows.map((r) => [r.filename, r.checksum]));
  for (const r of rows) {
    if (r.track !== trackOf(r.filename)) {
      throw new Error(
        `schema_migrations row '${r.filename}' is on track '${r.track}' but its name says ` +
          `'${trackOf(r.filename)}'. Refusing to migrate a database whose bookkeeping disagrees with itself.`,
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  // The newest CE migration present once the CE pass is done: what an EE file may require.
  let ceHead = 0;

  for (const { track, dir, files } of tracks) {
    const recorded = (name: string) => (track === 'ee' ? EE_PREFIX + name : name);
    // Each track's prefix is checked against its own rows only. Mixed together, an applied
    // `ee/…` row sorts after every digit and would make every pending CE file look out of order.
    assertAppliedPrefix(
      files,
      rows
        .filter((r) => r.track === track)
        .map((r) => (track === 'ee' ? r.filename.slice(EE_PREFIX.length) : r.filename)),
    );

    for (const file of files) {
      const filename = recorded(file);
      const sql = await readFile(join(dir, file), 'utf8');
      const sum = checksum(sql);
      const seen = previous.get(filename);

      if (seen) {
        if (seen !== sum) {
          throw new Error(
            `Migration ${filename} was modified after it was applied ` +
              `(recorded ${seen.slice(0, 12)}, file ${sum.slice(0, 12)}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped.push(filename);
        continue;
      }

      if (track === 'ee') {
        const needs = requiresCe(sql, filename);
        if (needs > ceHead) {
          throw new Error(
            `Migration ${filename} requires CE migration ${String(needs).padStart(4, '0')} ` +
              `but the CE track is at ${String(ceHead).padStart(4, '0')}.`,
          );
        }
      }

      await applyWithLockRetry(client, filename, sql, sum, track);
      applied.push(filename);
    }

    if (track === 'ce') {
      ceHead = Math.max(0, ...files.map((f) => Number(f.slice(0, 4))));
    }
  }

  return { applied, skipped };
}

/** `pnpm migrate` entrypoint. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  runMigrations()
    .then(async (result) => {
      logger.info(result, 'migrations complete');
      const { closeDb } = await import('./client.js');
      await closeDb();
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'migrations failed');
      process.exit(1);
    });
}

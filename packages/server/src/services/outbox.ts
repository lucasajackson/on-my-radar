/**
 * The outbox: asynchronous work becomes a row before it becomes an attempt.
 *
 * ## Why a table and not a queue service
 *
 * The database is already this codebase's arbiter for everything that must
 * survive a race or a crash, and asynchronous work is both. A broker would be a
 * second stateful system to run, secure, and reason about, bought to solve a
 * problem one indexed table solves at this scale. The ethos is the same one
 * that hand-rolled Web Push rather than adding a dependency.
 *
 * ## The lease, precisely
 *
 * A claim is one statement: pick due rows with `FOR UPDATE SKIP LOCKED`, push
 * their `run_after` forward by the lease, bump `attempts`, return them. The
 * row lock lives exactly as long as that statement — nothing pins a pool
 * connection while a handler fetches a slow remote page. A claimed job is
 * simply invisible to other drainers until its lease lapses; success deletes
 * it inside that window, failure reschedules it with backoff, and a claimer
 * that dies does nothing at all — the row resurfaces on its own. The one cost
 * is that a handler outliving its lease can run twice, so every handler must
 * tolerate a duplicate run; each is annotated with why it does.
 *
 * ## Dead letters
 *
 * A job that exhausted its attempts, that never finished within them (its
 * handler crashed the process or outlived every lease), or whose kind no
 * process has been able to run for a day is not deleted: it is parked at
 * `DEAD_LETTER_AT` with the reason in `last_error`, so it is never due, never
 * claimed and never counted as backlog, yet stays readable with `psql` for
 * `DEAD_LETTER_RETENTION_DAYS` before the worker's upkeep removes it.
 *
 * ## Two drains, one guarantee
 *
 * The web process gives every job it enqueues one immediate, best-effort kick,
 * so a single-pod deployment with no worker behaves exactly as the app always
 * has — same latency, same everything — and "no worker deployed" stays a
 * supported state rather than a broken one. The worker deployment is the
 * guarantee on top: it drains whatever the kick lost — a killed pod, a failed
 * first attempt, a backlog. Both paths run the same claim, and SKIP LOCKED
 * makes them safe together.
 */
import { sql } from 'drizzle-orm';
import { getDb, schema, type Db } from '../db/client.js';
import { logger } from '../logger.js';

export type OutboxKind =
  | 'unfurl'
  | 'notification'
  | 'notification-event'
  | 'decision-event'
  | 'email'
  | 'object-cleanup'
  | 'push';

export interface OutboxJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Invisible-after-claim window. A handler that may outrun this must say so. */
const LEASE_SECONDS = 300;
/** After this many claims a job is dead-lettered loudly instead of retried quietly. */
const MAX_ATTEMPTS = 8;
/**
 * Where a dead letter is parked: a real, far-future timestamp rather than
 * Postgres `infinity`, which a JS `Date` cannot represent.
 */
export const DEAD_LETTER_AT = '9999-12-31T00:00:00Z';
const DEAD_LETTER_RETENTION_DAYS = 30;
/** How long a kind nobody can run waits for a process that knows it. */
const UNKNOWN_KIND_GRACE_HOURS = 24;

function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
}

type Handler = (payload: Record<string, unknown>, job: OutboxJob) => Promise<void>;
const handlers = new Map<string, Handler>();

/**
 * Handlers are registered by the modules that own the work, so the queue knows
 * nothing about unfurling or mail and cannot grow a dependency cycle. Any
 * process that imports the service modules — the web app via its routes, the
 * worker explicitly — has the full registry.
 */
export function registerOutboxHandler(kind: OutboxKind, handler: Handler): void {
  handlers.set(kind, handler);
}

/**
 * `dbc` so a caller can enqueue inside its own transaction — work caused by a
 * write should become durable in the same commit as the write.
 */
export async function enqueue(
  dbc: Pick<Db, 'insert'>,
  kind: OutboxKind,
  payload: Record<string, unknown>,
): Promise<string> {
  const [row] = await dbc.insert(schema.outbox).values({ kind, payload }).returning({
    id: schema.outbox.id,
  });
  if (!row) throw new Error('outbox insert returned no row');
  return row.id;
}

/**
 * One claim statement; `leaseSeconds` is a parameter only so the test that
 * proves lease-lapse resurfacing does not have to wait five minutes.
 */
async function claim(limit: number, onlyId?: string, leaseSeconds = LEASE_SECONDS) {
  // Only kinds this process can actually run. During a rolling deploy an old
  // process never claims a kind it has never heard of — the row simply waits
  // for a process that knows it, instead of burning attempts on backoff. It
  // also means a process with an empty registry claims nothing at all.
  if (handlers.size === 0) return [];
  const result = await getDb().execute<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(sql`
    WITH picked AS (
      SELECT id, run_after AS due FROM outbox
      WHERE run_after <= now()
        AND kind IN (${registeredKinds()})
        ${onlyId ? sql`AND id = ${onlyId}` : sql``}
      ORDER BY run_after
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE outbox o
         SET attempts = o.attempts + 1,
             run_after = now() + make_interval(secs => ${leaseSeconds})
        FROM picked
       WHERE o.id = picked.id
      RETURNING o.id, o.kind, o.payload, o.attempts, picked.due
    )
    -- RETURNING has no order of its own (the join's heap scan decides it), and
    -- jobs for one card fold into one notification in run order.
    SELECT id, kind, payload, attempts FROM claimed ORDER BY due, id
  `);
  return result.rows;
}

async function complete(job: OutboxJob): Promise<void> {
  await getDb()
    .delete(schema.outbox)
    .where(sql`${schema.outbox.id} = ${job.id} AND ${schema.outbox.attempts} = ${job.attempts}`);
}

async function deadLetter(job: OutboxJob, reason: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE outbox
       SET last_error = ${`dead letter: ${reason}`.slice(0, 500)},
           run_after = ${DEAD_LETTER_AT}::timestamptz
     WHERE id = ${job.id} AND attempts = ${job.attempts}
  `);
}

async function fail(job: OutboxJob, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (job.attempts >= MAX_ATTEMPTS) {
    // Loud, and out of the queue. The honest record of what was and was not
    // delivered still lives on the rows the handlers stamp (`emailed_at`,
    // `pushed_at`, a preview that stays null); the dead letter is for whoever
    // is asking why.
    logger.error(
      { kind: job.kind, jobId: job.id, attempts: job.attempts, err },
      'outbox job exhausted its attempts and was dead-lettered',
    );
    await deadLetter(job, `exhausted ${job.attempts} attempts: ${message}`);
    return;
  }
  const requested =
    err instanceof Error && 'retryAfterMs' in err ? Number(err.retryAfterMs) / 1000 : 0;
  const delay = Math.max(
    backoffSeconds(job.attempts),
    Number.isFinite(requested) ? Math.min(3600, requested) : 0,
  );
  await getDb().execute(sql`
    UPDATE outbox
       SET last_error = ${message.slice(0, 500)},
           run_after = now() + make_interval(secs => ${delay})
     WHERE id = ${job.id} AND attempts = ${job.attempts}
  `);
}

async function run(job: OutboxJob): Promise<void> {
  // The claim counts an attempt before the handler starts, and `fail` is what
  // enforces the ceiling — so a job whose handler kills the process (an OOM on
  // one hostile payload) or outlives every lease never reaches `fail`. It
  // resurfaced forever, taking the worker down each time. Past the ceiling it
  // has provably never finished; it is dropped here without being run again.
  if (job.attempts > MAX_ATTEMPTS) {
    logger.error(
      { kind: job.kind, jobId: job.id, attempts: job.attempts },
      'outbox job never finished within its attempts and was dead-lettered unrun',
    );
    await deadLetter(
      job,
      'never finished: its handler outlived every lease or crashed the process',
    );
    return;
  }
  const handler = handlers.get(job.kind);
  if (!handler) {
    // Unreachable while claim() filters on registered kinds; kept because a
    // job that somehow arrives here unrunnable must back off, not vanish.
    await fail(job, new Error(`no handler registered for kind "${job.kind}"`));
    return;
  }
  try {
    await handler(job.payload, job);
    await complete(job);
  } catch (err) {
    logger.warn(
      { kind: job.kind, jobId: job.id, attempts: job.attempts, err },
      'outbox job failed',
    );
    await fail(job, err);
  }
}

/** The inline kick: claim exactly this job if it is still there and due. */
export async function drainOne(id: string): Promise<void> {
  const [job] = await claim(1, id);
  if (job) await run(job);
}

/**
 * The worker's unit of progress. Returns how many jobs it ran.
 *
 * `signal` is shutdown. Nothing is claimed once it has fired, a job already
 * running is left to finish, and every job claimed in this batch but not yet
 * started is handed straight back — due now, its attempt uncounted — rather
 * than sitting invisible for the rest of a five-minute lease while the next
 * pod starts up.
 */
export async function drainDue(
  limit = 5,
  leaseSeconds = LEASE_SECONDS,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 0;
  const jobs = await claim(limit, undefined, leaseSeconds);
  let ran = 0;
  for (const job of jobs) {
    if (signal?.aborted) {
      await release(jobs.slice(ran));
      break;
    }
    await run(job);
    ran += 1;
  }
  return ran;
}

async function release(jobs: OutboxJob[]): Promise<void> {
  for (const job of jobs)
    await getDb().execute(sql`
      UPDATE outbox SET run_after = now(), attempts = attempts - 1
       WHERE id = ${job.id} AND attempts = ${job.attempts}
    `);
}

function registeredKinds() {
  return sql.join(
    [...handlers.keys()].map((k) => sql`${k}`),
    sql`, `,
  );
}

/**
 * At least `threshold` jobs are due that this process could run.
 *
 * Only runnable kinds count: a pile of rows no deployed version knows how to
 * run is not work, and counting it used to pause feed polling indefinitely.
 * Dead letters are never due, so they do not count either.
 */
export async function dueBacklogAtLeast(threshold: number): Promise<boolean> {
  if (handlers.size === 0 || threshold < 1) return false;
  const result = await getDb().execute(sql`
    SELECT id FROM outbox
     WHERE run_after <= now() AND kind IN (${registeredKinds()})
     ORDER BY run_after
     LIMIT 1 OFFSET ${threshold - 1}
  `);
  return result.rows.length > 0;
}

/**
 * Worker upkeep for the queue itself: dead-letter jobs of a kind nothing has
 * been able to run for a day (a rolled-back release, a removed feature), and
 * delete dead letters past their retention. Only a process holding the full
 * registry may call this, which is why it is the worker's and not the web's.
 */
export async function sweepOutbox(
  batchSize = 500,
): Promise<{ deadLettered: number; purged: number }> {
  if (handlers.size === 0) return { deadLettered: 0, purged: 0 };
  const unknown = await getDb().execute(sql`
    WITH picked AS (
      SELECT id FROM outbox
       WHERE kind NOT IN (${registeredKinds()})
         AND created_at < now() - make_interval(hours => ${UNKNOWN_KIND_GRACE_HOURS})
         AND run_after < ${DEAD_LETTER_AT}::timestamptz
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox o
       SET run_after = ${DEAD_LETTER_AT}::timestamptz,
           last_error = 'dead letter: no process has a handler for kind "' || o.kind || '"'
      FROM picked WHERE o.id = picked.id
  `);
  const purged = await getDb().execute(sql`
    WITH picked AS (
      SELECT id FROM outbox
       WHERE run_after >= ${DEAD_LETTER_AT}::timestamptz
         AND created_at < now() - make_interval(days => ${DEAD_LETTER_RETENTION_DAYS})
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    )
    DELETE FROM outbox o USING picked WHERE o.id = picked.id
  `);
  const deadLettered = unknown.rowCount ?? 0;
  if (deadLettered > 0)
    logger.error({ deadLettered }, 'outbox jobs of an unknown kind were dead-lettered');
  return { deadLettered, purged: purged.rowCount ?? 0 };
}

/** Test seam: the registry is module state, and tests must not share it. */
export function resetOutboxHandlersForTesting(): void {
  handlers.clear();
}

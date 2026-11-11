import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { currentGate } from './request-gate.js';
import * as schema from './schema.js';

/**
 * Postgres returns bigint and numeric as strings by default so that precision is
 * never silently lost. The bigints read here are `attachments.size`, bounded by
 * the upload limit, and counters and sequences (`radar_webhooks.delivery_count`,
 * `audit_log.id`, `agent_memory_revisions.seq`) that will not pass 2^53 —
 * so parsing them to numbers is safe and keeps the DTOs honest. Aggregate counts
 * are cast to `int` in SQL rather than relying on this.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: Db | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env().DATABASE_URL,
      max: env().DB_POOL_MAX,
      idleTimeoutMillis: env().DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env().DB_POOL_CONNECT_TIMEOUT_MS,
      application_name: env().DB_APPLICATION_NAME,
      // Server-side, per connection. A runaway query is cancelled by Postgres
      // instead of holding a pool slot for a client that gave up long ago, and a
      // transaction abandoned mid-way releases its row locks. Longer jobs raise
      // their own transaction's limit with SET LOCAL (account export); the
      // migrator turns the statement limit off for its session.
      statement_timeout: env().DB_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: env().DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
    // Single statements made inside a request count against that request's
    // query cap (request-gate.ts). Transactions do not: `connect()` is untouched.
    const unbounded = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
      const gate = currentGate();
      // The callback form has no promise to wait on; nothing in this codebase uses it.
      if (!gate || typeof args[args.length - 1] === 'function') return unbounded(...args);
      return gate.run(() => unbounded(...args) as Promise<unknown>);
    };
    // An idle-client error is emitted on the pool, not on any query, so without
    // this handler a dropped backend takes the process down with an unhandled
    // 'error' event.
    pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
    // The pool's listener comes off a client while it is checked out. A
    // transaction held open across slow work (the mail fence sends inside one)
    // can be ended by Postgres meanwhile, and the connection then reports it as
    // an 'error' event with nothing listening: an uncaught exception. The
    // work that held the client sees the failure when it next uses it.
    pool.on('connect', (client) =>
      client.on('error', (err) => logger.error({ err }, 'postgres client error')),
    );
    let lastQueueWarning = 0;
    pool.on('acquire', () => {
      if ((pool?.waitingCount ?? 0) > 0 && Date.now() - lastQueueWarning > 60_000) {
        lastQueueWarning = Date.now();
        logger.warn({ databasePool: poolStatus() }, 'postgres pool has queued requests');
      }
    });
  }
  return pool;
}

export function getDb(): Db {
  db ??= drizzle(getPool(), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  if (readyClient) {
    const client = readyClient;
    readyClient = null;
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    await client.end().catch(() => undefined);
  }
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/** Operational pool counts, with no connection string or other credentials. */
export function poolStatus() {
  return {
    max: env().DB_POOL_MAX,
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
  };
}

/** Startup probe: through the shared pool, where a failure should stop the boot. */
export async function pingDb(): Promise<void> {
  await getPool().query('SELECT 1');
}

/*
 * Readiness has its own connection. On the shared pool a saturated pool queues
 * the probe behind real traffic, the probe times out, and the pod leaves the
 * endpoints exactly when it is busiest, which sheds its load onto the other
 * pods and takes them down in turn.
 *
 * One client, outside the pool, reconnected on demand. A ping that does not
 * answer in time on a connection that is still up means "busy", and is excused
 * by the last good answer for READY_STALE_MS; a connection error, or a stale
 * last-good, means the database is not there. Liveness never calls this.
 */
let readyClient: pg.Client | null = null;
let readyConnecting: Promise<pg.Client> | null = null;
let lastReadyOk = 0;

async function readyConnection(timeoutMs: number): Promise<pg.Client> {
  if (readyClient) return readyClient;
  readyConnecting ??= (async () => {
    const client = new pg.Client({
      connectionString: env().DATABASE_URL,
      application_name: `${env().DB_APPLICATION_NAME}-ready`,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      // Backstop for a connection that has silently died: no server-side error will ever arrive.
      query_timeout: timeoutMs + 1_000,
    });
    client.on('error', () => {
      if (readyClient === client) readyClient = null;
    });
    try {
      await client.connect();
    } catch (err) {
      // A client that never connected still owns whatever it opened; close it here so a
      // database that is down for an hour is not an hour of abandoned sockets.
      void client.end().catch(() => undefined);
      throw err;
    }
    readyClient = client;
    return client;
  })().finally(() => {
    readyConnecting = null;
  });
  return readyConnecting;
}

/** Readiness probe: cheap, off the shared pool, and it must actually touch the database. */
export async function pingDbForReadiness(now: () => number = Date.now): Promise<void> {
  const timeoutMs = env().READY_PING_TIMEOUT_MS;
  let used: pg.Client | null = null;
  try {
    used = await readyConnection(timeoutMs);
    await used.query('SELECT 1');
    lastReadyOk = now();
  } catch (err) {
    // Only a statement that ran out of time on a live connection is "busy".
    // Cannot-connect, refused, reset and auth failures all mean the database
    // is not reachable.
    const busy =
      err instanceof Error &&
      (err as { code?: string }).code === '57014' &&
      now() - lastReadyOk < env().READY_STALE_MS;
    if (!busy) {
      // Drop the connection this ping used, not whichever one is current: a concurrent ping
      // may already have replaced it with a healthy one.
      if (used && readyClient === used) readyClient = null;
      void used?.end().catch(() => undefined);
      throw err;
    }
  }
}

/** Test seam: forget the last good answer. */
export function resetReadinessForTesting(): void {
  lastReadyOk = 0;
}

export { schema };

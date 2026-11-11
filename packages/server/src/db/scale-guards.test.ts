/**
 * The scale guards on the database layer: readiness off the shared pool, the
 * per-request query cap, and the server-side timeouts on every pooled connection.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  getPool,
  pingDbForReadiness,
  poolStatus,
  resetReadinessForTesting,
} from './client.js';
import { applyWithLockRetry } from './migrate.js';
import { Semaphore, withRequestGate } from './request-gate.js';
import { healthRoutes } from '../routes/health.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';

const base = {
  SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
};

describe('env defaults', () => {
  it('has bounded defaults and rejects nonsense', () => {
    const e = loadEnv({ ...base, DATABASE_URL: 'postgresql://x/y' });
    expect(e.DB_STATEMENT_TIMEOUT_MS).toBe(5_000);
    expect(e.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(30_000);
    expect(e.REQUEST_QUERY_CONCURRENCY).toBe(4);
    expect(e.MIGRATE_LOCK_TIMEOUT_MS).toBe(3_000);
    expect(() =>
      loadEnv({ ...base, DATABASE_URL: 'postgresql://x/y', DB_STATEMENT_TIMEOUT_MS: '1' }),
    ).toThrow('Invalid environment');
  });
});

describe('Semaphore', () => {
  it('never runs more than its permits at once and drains in order', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(i);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('releases the slot when a task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(sem.run(() => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('liveness never touches the database', () => {
  it('answers /health/live with no database at all', async () => {
    setEnvForTesting(loadEnv({ ...base, DATABASE_URL: 'postgresql://127.0.0.1:1/none' }));
    const res = await healthRoutes.request('/live');
    expect(res.status).toBe(200);
    expect(poolStatus().total).toBe(0);
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('real postgres', () => {
  const useEnv = (patch: Record<string, string>) =>
    setEnvForTesting(loadEnv({ ...process.env, ...base, ...patch }));

  beforeAll(() => useEnv({ DB_POOL_MAX: '2', DB_POOL_CONNECT_TIMEOUT_MS: '300' }));
  afterEach(() => {
    vi.restoreAllMocks();
    useEnv({ DB_POOL_MAX: '2', DB_POOL_CONNECT_TIMEOUT_MS: '300' });
  });
  afterAll(closeDb);

  it('applies statement and idle-in-transaction timeouts to every pooled connection', async () => {
    useEnv({ DB_STATEMENT_TIMEOUT_MS: '1500', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '7000' });
    await closeDb();
    const rows = (
      await getPool().query<{ s: string; i: string }>(
        `SELECT current_setting('statement_timeout') AS s,
                current_setting('idle_in_transaction_session_timeout') AS i`,
      )
    ).rows;
    expect(must(rows[0])).toEqual({ s: '1500ms', i: '7s' });
    await expect(getPool().query('SELECT pg_sleep(3)')).rejects.toMatchObject({ code: '57014' });
    await closeDb();
  });

  it('readiness answers while the shared pool is completely saturated', async () => {
    resetReadinessForTesting();
    await closeDb();
    const held = await Promise.all([getPool().connect(), getPool().connect()]);
    try {
      const queued = getPool().connect();
      await expect(queued).rejects.toThrow(/timeout/);
      expect(poolStatus()).toMatchObject({ total: 2, idle: 0 });
      await expect(pingDbForReadiness()).resolves.toBeUndefined();
      const res = await healthRoutes.request('/ready');
      expect(res.status).toBe(200);
    } finally {
      for (const client of held) client.release();
    }
  });

  it('readiness never holds more than one connection: concurrent pings share it, a killed one is replaced', async () => {
    resetReadinessForTesting();
    await closeDb();
    // A name no other test file shares: the suites run in parallel against one database, and
    // this test must neither count nor terminate their readiness connections.
    const appName = `scale-ready-${randomUUID().slice(0, 8)}`;
    useEnv({ DB_POOL_MAX: '2', DB_POOL_CONNECT_TIMEOUT_MS: '300', DB_APPLICATION_NAME: appName });
    const readyName = `${appName}-ready`;
    const count = async () => {
      const admin = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await admin.connect();
      try {
        const { rows } = await admin.query<{ n: string }>(
          'SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1',
          [readyName],
        );
        return Number(must(rows[0]).n);
      } finally {
        await admin.end();
      }
    };
    await Promise.all(Array.from({ length: 30 }, () => pingDbForReadiness()));
    expect(await count()).toBe(1);
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await admin.connect();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [readyName],
    );
    await admin.end();
    // The next ping may see the dead connection; the one after reconnects. Never two alive.
    await pingDbForReadiness().catch(() => undefined);
    await pingDbForReadiness();
    await new Promise((r) => setTimeout(r, 200));
    expect(await count()).toBe(1);
    await closeDb();
    await new Promise((r) => setTimeout(r, 200));
    expect(await count()).toBe(0);
    useEnv({ DB_POOL_MAX: '2', DB_POOL_CONNECT_TIMEOUT_MS: '300' });
  });

  it('excuses a busy database for READY_STALE_MS, then reports unready', async () => {
    resetReadinessForTesting();
    let now = 1_000_000;
    await pingDbForReadiness(() => now);
    const timeout = () => Object.assign(new Error('canceling statement'), { code: '57014' });
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    spy.mockRejectedValueOnce(timeout());
    now += 5_000;
    await expect(pingDbForReadiness(() => now)).resolves.toBeUndefined();
    spy.mockRejectedValueOnce(timeout());
    now += 60_000;
    await expect(pingDbForReadiness(() => now)).rejects.toMatchObject({ code: '57014' });
  });

  it('reports unready when the database is gone, whatever the last good answer was', async () => {
    resetReadinessForTesting();
    await pingDbForReadiness();
    await closeDb();
    useEnv({ DATABASE_URL: 'postgresql://postgres@127.0.0.1:1/none' });
    await expect(pingDbForReadiness()).rejects.toThrow();
    expect((await healthRoutes.request('/ready')).status).toBe(503);
  });

  it('caps one request at REQUEST_QUERY_CONCURRENCY statements and leaves pool room for others', async () => {
    useEnv({ DB_POOL_MAX: '5', REQUEST_QUERY_CONCURRENCY: '2' });
    await closeDb();
    const pool = getPool();
    let peakTotal = 0;
    const sampler = setInterval(() => {
      peakTotal = Math.max(peakTotal, poolStatus().total - poolStatus().idle);
    }, 5);
    const started = Date.now();
    await withRequestGate(() =>
      Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.1)'))),
    );
    clearInterval(sampler);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(peakTotal).toBeLessThanOrEqual(2);
    // Outside a request there is no cap.
    const free = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT pg_sleep(0.1)')));
    expect(Date.now() - free).toBeLessThan(250);
    await closeDb();
  });

  describe('migrator lock timeout', () => {
    const table = `omr_lockprobe_${process.pid}`;
    let holder: pg.Client;
    let migrator: pg.Client;

    beforeAll(async () => {
      holder = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      migrator = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await holder.connect();
      await migrator.connect();
      await holder.query(`DROP TABLE IF EXISTS ${table}; CREATE TABLE ${table} (id int)`);
      await migrator.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
    });
    afterAll(async () => {
      await holder.query(`DROP TABLE IF EXISTS ${table}`);
      await migrator.query("DELETE FROM schema_migrations WHERE filename LIKE '9%_lockprobe%'");
      await holder.end();
      await migrator.end();
    });

    const apply = (name: string) =>
      applyWithLockRetry(
        migrator as unknown as pg.PoolClient,
        name,
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS c_${name.slice(0, 4)} int`,
        'sum',
      );

    it('retries a lock timeout and succeeds once the table is free', async () => {
      useEnv({ MIGRATE_LOCK_TIMEOUT_MS: '100', MIGRATE_LOCK_RETRIES: '6' });
      await holder.query(`BEGIN; LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      setTimeout(() => void holder.query('COMMIT'), 700);
      await apply('9001_lockprobe_retry.sql');
      const done = await migrator.query(
        "SELECT 1 FROM schema_migrations WHERE filename = '9001_lockprobe_retry.sql'",
      );
      expect(done.rowCount).toBe(1);
    });

    it('gives up after the bounded retries, leaving nothing recorded', async () => {
      useEnv({ MIGRATE_LOCK_TIMEOUT_MS: '100', MIGRATE_LOCK_RETRIES: '1' });
      await holder.query(`BEGIN; LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const started = Date.now();
      await expect(apply('9002_lockprobe_giveup.sql')).rejects.toThrow(/lock timeout/i);
      expect(Date.now() - started).toBeLessThan(2_000);
      await holder.query('ROLLBACK');
      const done = await migrator.query(
        "SELECT 1 FROM schema_migrations WHERE filename = '9002_lockprobe_giveup.sql'",
      );
      expect(done.rowCount).toBe(0);
    });
  });
});

describe('a database timeout is a retryable 503, not an opaque 500', () => {
  it('maps statement and lock timeouts, however deeply wrapped', async () => {
    const { errorBody } = await import('../http.js');
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    });
    expect(errorBody(wrapped)).toMatchObject({
      status: 503,
      body: { error: { code: 'database_busy' } },
    });
    expect(errorBody(Object.assign(new Error('x'), { code: '55P03' })).status).toBe(503);
    expect(errorBody(new Error('boom')).status).toBe(500);
  });

  it('a real statement_timeout on the pool surfaces as that 503', async () => {
    const { errorBody } = await import('../http.js');
    setEnvForTesting(loadEnv({ ...base, DATABASE_URL: process.env['DATABASE_URL'] ?? '' }));
    const err = await getPool()
      .query("SET statement_timeout = '50ms'; SELECT pg_sleep(1)")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(errorBody(err).status).toBe(503);
  });

  it('delete radar lifts the limit for its own transaction only', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', '60000', true)");
      expect((await client.query('SHOW statement_timeout')).rows[0]).toEqual({
        statement_timeout: '1min',
      });
      await client.query('COMMIT');
      expect((await client.query('SHOW statement_timeout')).rows[0]).toEqual({
        statement_timeout: '5s',
      });
    } finally {
      client.release();
    }
  });
});

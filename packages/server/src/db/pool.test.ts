import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, getPool, poolStatus } from './client.js';
import { logger } from '../logger.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';

const fixture = {
  DATABASE_URL: 'postgresql://not-connected/test',
  SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
};
it('validates bounded pool, body and shutdown settings', () => {
  expect(loadEnv(fixture).DB_POOL_MAX).toBe(10);
  for (const patch of [
    { DB_POOL_MAX: '0' },
    { DB_POOL_MAX: '101' },
    { DB_APPLICATION_NAME: '' },
    { HTTP_BODY_LIMIT_BYTES: '42' },
    { SHUTDOWN_DRAIN_MS: '10000', SHUTDOWN_TIMEOUT_MS: '10000' },
  ]) {
    expect(() => loadEnv({ ...fixture, ...patch })).toThrow('Invalid environment');
  }
});

describe.skipIf(!process.env['DATABASE_URL'])('bounded pool (real postgres)', () => {
  beforeAll(() =>
    setEnvForTesting(
      loadEnv({
        ...process.env,
        SESSION_SECRET: fixture.SESSION_SECRET,
        DB_POOL_MAX: '1',
        DB_POOL_CONNECT_TIMEOUT_MS: '100',
        DB_APPLICATION_NAME: 'onmyradar-audit-pool',
      }),
    ),
  );
  afterAll(closeDb);
  it('identifies itself and refuses queued work beyond the configured wait', async () => {
    const client = await getPool().connect();
    try {
      expect(
        must((await client.query<{ application_name: string }>('SHOW application_name')).rows[0])
          .application_name,
      ).toBe('onmyradar-audit-pool');
      expect(poolStatus()).toMatchObject({ max: 1, total: 1, idle: 0 });
      const pending = getPool().connect();
      expect(poolStatus().waiting).toBe(1);
      await expect(pending).rejects.toThrow(/timeout/);
    } finally {
      client.release();
    }
    expect(must((await getPool().query<{ n: number }>('SELECT 1 AS n')).rows[0]).n).toBe(1);
  });
});

describe.skipIf(!process.env['DATABASE_URL'])(
  'a transaction Postgres ends while work is under way',
  () => {
    beforeAll(() =>
      setEnvForTesting(
        loadEnv({
          ...process.env,
          SESSION_SECRET: fixture.SESSION_SECRET,
          DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1000',
        }),
      ),
    );
    afterAll(closeDb);

    it('is a failed call and a log line, never an uncaught exception', async () => {
      // The mail fence holds a transaction open while it talks to a relay. Postgres
      // ends a transaction left idle past its limit and the connection reports that
      // as an event on a checked-out client, which has no listener of the pool's.
      const uncaught: unknown[] = [];
      const record = (err: unknown) => uncaught.push(err);
      process.on('uncaughtException', record);
      const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          getDb().transaction(async (tx) => {
            await tx.execute(sql`SELECT 1`);
            await new Promise((resolve) => setTimeout(resolve, 1800));
          }),
        ).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(uncaught).toEqual([]);
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) as unknown }),
          'postgres client error',
        );
      } finally {
        process.off('uncaughtException', record);
        log.mockRestore();
      }
    });
  },
);

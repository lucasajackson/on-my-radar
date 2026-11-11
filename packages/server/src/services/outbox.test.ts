/**
 * The outbox's promises, each one exercised against a real database — a mock
 * queue would prove nothing, because every property here IS the database's
 * locking behaviour.
 *
 * The registry is swapped per test (`resetOutboxHandlersForTesting`), which is
 * safe because vitest isolates files into their own processes; nothing else in
 * this process needs the real handlers.
 *
 * The suite runs against a database of its own, created here — the pattern
 * `migrate.test.ts` established. The outbox is one global table, so a suite
 * that asserts "the queue is now empty" while sibling workers enqueue into a
 * shared database is asserting something about *them*. Isolation makes the
 * assertions mean what they say.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import {
  drainDue,
  dueBacklogAtLeast,
  enqueue,
  registerOutboxHandler,
  resetOutboxHandlersForTesting,
  sweepOutbox,
  type OutboxKind,
} from './outbox.js';
import { must } from '../errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

// A database of this suite's own, pointed at before anything touches the lazy
// pool. `getDb()` has not run yet at module scope, so redirecting the env here
// redirects everything after it.
if (hasDatabase) {
  const admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  const scratch = `omr_outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${scratch}`);
  await admin.end();
  const url = new URL(must(process.env['DATABASE_URL']));
  url.pathname = `/${scratch}`;
  setEnvForTesting(loadEnv({ ...process.env, DATABASE_URL: url.toString() }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasDatabase)('the outbox', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);

  beforeEach(async () => {
    resetOutboxHandlersForTesting();
    await getDb().delete(schema.outbox);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('runs a job once and deletes it', async () => {
    const calls: unknown[] = [];
    registerOutboxHandler('unfurl', async (p) => {
      calls.push(p);
    });
    await enqueue(getDb(), 'unfurl', { blipId: 'x', url: 'https://example.com' });

    expect(await drainDue(5)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await getDb().select().from(schema.outbox)).toHaveLength(0);
  });

  /**
   * Two drainers, one job, one run. The claim is `FOR UPDATE SKIP LOCKED`
   * pushing `run_after` forward, so the loser sees nothing due — asserted as a
   * count because the defect being fenced is that both ran.
   */
  it('never hands one job to two drainers', async () => {
    let runs = 0;
    registerOutboxHandler('unfurl', async () => {
      runs += 1;
      await sleep(200);
    });
    await enqueue(getDb(), 'unfurl', {});

    await Promise.all([drainDue(1), drainDue(1)]);
    expect(runs).toBe(1);
  });

  it('reschedules a failure with backoff and keeps the error', async () => {
    registerOutboxHandler('unfurl', async () => {
      throw new Error('remote said no');
    });
    await enqueue(getDb(), 'unfurl', {});

    expect(await drainDue(5)).toBe(1);

    const [row] = await getDb().select().from(schema.outbox);
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('remote said no');
    expect(must(row).runAfter.getTime()).toBeGreaterThan(Date.now());

    // Not due again yet — backoff means backoff.
    expect(await drainDue(5)).toBe(0);
  });

  /**
   * The durability claim itself: a claimer that dies completes nothing, and
   * the row simply resurfaces when its lease lapses. The "death" is a handler
   * that hangs until the test releases it; the lease is shrunk to a second so
   * the test does not wait five minutes for the truth.
   */
  it('resurfaces a job whose claimer died', async () => {
    let release: () => void = () => undefined;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerOutboxHandler('unfurl', () => hung);
    const id = await enqueue(getDb(), 'unfurl', {});

    // First claimer takes the job and never finishes. Not awaited — that is
    // the point. The claim itself is synchronous-enough to poll for.
    const doomed = drainDue(1, 1);
    await expect
      .poll(
        async () => {
          const [row] = await getDb()
            .select({ attempts: schema.outbox.attempts })
            .from(schema.outbox)
            .where(eq(schema.outbox.id, id));
          return row?.attempts;
        },
        { timeout: 5_000 },
      )
      .toBe(1);

    await sleep(1_100);

    let secondRun = 0;
    registerOutboxHandler('unfurl', async () => {
      secondRun += 1;
    });
    expect(await drainDue(1, 1)).toBe(1);
    expect(secondRun).toBe(1);
    expect(await getDb().select().from(schema.outbox)).toHaveLength(0);

    release();
    await doomed;
  });

  /**
   * The attempt ceiling has to hold for a job that never *fails* — one whose
   * handler takes the process down, so each claim ends in a restart rather than
   * in `fail`. Simulated by setting the counter to where eight such crashes
   * leave it; the ninth claim must drop it without handing it to the handler.
   */
  it('dead-letters a job whose claims never finished instead of running it forever', async () => {
    let runs = 0;
    registerOutboxHandler('unfurl', async () => {
      runs += 1;
    });
    const id = await enqueue(getDb(), 'unfurl', {});
    await getDb().update(schema.outbox).set({ attempts: 8 }).where(eq(schema.outbox.id, id));

    expect(await drainDue(5)).toBe(1);
    expect(runs).toBe(0);
    const [row] = await getDb().select().from(schema.outbox);
    expect(row?.lastError).toMatch(/^dead letter: never finished/);
    expect(must(row).runAfter.getUTCFullYear()).toBe(9999);
    expect(await drainDue(5)).toBe(0);
  });

  it('dead-letters a job that fails its last attempt, keeping the reason', async () => {
    registerOutboxHandler('unfurl', async () => {
      throw new Error('remote said no, again');
    });
    const id = await enqueue(getDb(), 'unfurl', {});
    await getDb().update(schema.outbox).set({ attempts: 7 }).where(eq(schema.outbox.id, id));

    expect(await drainDue(5)).toBe(1);
    const [row] = await getDb().select().from(schema.outbox);
    expect(row?.lastError).toBe('dead letter: exhausted 8 attempts: remote said no, again');
    expect(await dueBacklogAtLeast(1)).toBe(false);
  });

  /**
   * Feed polling yields to a delivery backlog. Rows nothing can run are not a
   * backlog: counting them paused polling for as long as they sat there.
   */
  it('counts only due jobs this process can run as backlog', async () => {
    registerOutboxHandler('unfurl', async () => undefined);
    await enqueue(getDb(), 'retired-kind' as OutboxKind, {});
    await enqueue(getDb(), 'retired-kind' as OutboxKind, {});
    expect(await dueBacklogAtLeast(1)).toBe(false);
    await enqueue(getDb(), 'unfurl', {});
    expect(await dueBacklogAtLeast(1)).toBe(true);
    expect(await dueBacklogAtLeast(2)).toBe(false);
  });

  it('dead-letters a kind nothing has run for a day, and purges old dead letters', async () => {
    registerOutboxHandler('unfurl', async () => undefined);
    const fresh = await enqueue(getDb(), 'newer-release-kind' as OutboxKind, {});
    const stale = await enqueue(getDb(), 'retired-kind' as OutboxKind, {});
    const ancient = await enqueue(getDb(), 'unfurl', {});
    await getDb()
      .update(schema.outbox)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(schema.outbox.id, stale));
    await getDb()
      .update(schema.outbox)
      .set({
        createdAt: sql`now() - interval '31 days'`,
        runAfter: new Date('9999-12-31T00:00:00Z'),
        lastError: 'dead letter: exhausted 8 attempts: gone',
      })
      .where(eq(schema.outbox.id, ancient));

    expect(await sweepOutbox()).toEqual({ deadLettered: 1, purged: 1 });
    const rows = new Map((await getDb().select().from(schema.outbox)).map((r) => [r.id, r]));
    expect(rows.has(ancient)).toBe(false);
    expect(rows.get(fresh)?.lastError).toBeNull();
    expect(rows.get(stale)?.lastError).toBe(
      'dead letter: no process has a handler for kind "retired-kind"',
    );
    expect(must(rows.get(stale)).runAfter.getUTCFullYear()).toBe(9999);
  });

  /**
   * Shutdown: the job in hand finishes, and the rest of the batch goes back to
   * the queue at once instead of hiding behind a five-minute lease.
   */
  /**
   * A batch runs in due order. `UPDATE ... FROM picked RETURNING` hands rows back
   * in whatever order the join produced, and two comments on one card are folded
   * into its notification in run order: "most recent first" was only as true as
   * that join (the identity phone check flaked on it).
   */
  it('runs a claimed batch in the order the jobs fell due', async () => {
    const ran: number[] = [];
    registerOutboxHandler('unfurl', async (payload) => {
      ran.push(Number(payload['n']));
    });
    // Inserted 0..4 but due 4..0, so heap order is the wrong order to run in.
    // Statistics from an empty table, as a quiet queue has: the claim join then
    // scans the heap as its outer side.
    await getDb().execute(sql`ANALYZE outbox`);
    const order = Array.from({ length: 5 }, (_, n) => 4 - n);
    for (const n of order.toReversed()) {
      const id = await enqueue(getDb(), 'unfurl', { n });
      await getDb().execute(
        sql`UPDATE outbox SET run_after = now() - make_interval(secs => ${n + 1}) WHERE id = ${id}`,
      );
    }
    expect(await drainDue(5)).toBe(5);
    expect(ran).toEqual(order);
  });

  it('hands unstarted jobs back when shutdown arrives mid-batch', async () => {
    const stop = new AbortController();
    const ran: string[] = [];
    registerOutboxHandler('unfurl', async (payload) => {
      ran.push(String(payload['n']));
      stop.abort();
    });
    for (const n of ['1', '2', '3']) {
      await enqueue(getDb(), 'unfurl', { n });
      await sleep(5);
    }

    expect(await drainDue(5, undefined, stop.signal)).toBe(1);
    expect(ran).toEqual(['1']);
    const left = await getDb().select().from(schema.outbox);
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.attempts === 0 && row.runAfter.getTime() <= Date.now())).toBe(
      true,
    );
    expect(await drainDue(5, undefined, stop.signal)).toBe(0);
  });

  /**
   * A kind this process has never heard of is never claimed — the row waits,
   * untouched, for a process that knows it. That is the rolling-deploy story:
   * an old worker does not burn a new job's attempts while its replacement
   * starts up. The positive twin (a registered kind IS claimed) is every other
   * test in this file.
   */
  it('never claims a kind it has no handler for', async () => {
    registerOutboxHandler('unfurl', async () => undefined);
    await enqueue(getDb(), 'brand-new-kind' as OutboxKind, {});
    expect(await drainDue(5)).toBe(0);
    const [row] = await getDb().select().from(schema.outbox);
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
  });
});

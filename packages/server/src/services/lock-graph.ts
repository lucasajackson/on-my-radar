/**
 * For tests that stage a race: how many backends are waiting, directly or one
 * step removed, on the locks a given backend holds.
 *
 * Scoped by the lock graph rather than by query text, because the suite runs
 * beside dozens of other files: counting every Lock-waiter whose text mentions
 * a table was satisfied by other files' waiters.
 *
 * **The snapshot is cleared first, and that is load-bearing.** The staging
 * client usually sits inside an open transaction (it is holding the lock), and
 * Postgres reads `pg_stat_activity` once per transaction and then serves that
 * copy until the transaction ends. Polled from such a client without
 * `pg_stat_clear_snapshot()`, the count never changes after the first read —
 * so a backend that arrived later was invisible, and a correct fix looked
 * like a timeout.
 *
 * Only tests import this; `src/index.ts` never reaches it.
 */
import type pg from 'pg';

export async function blockedBehind(client: pg.Client, blocker?: number): Promise<number> {
  await client.query('SELECT pg_stat_clear_snapshot()');
  const { rows } = await client.query<{ n: number }>(
    `WITH direct AS (
       SELECT pid FROM pg_stat_activity
       WHERE COALESCE($1::int, pg_backend_pid()) = ANY(pg_blocking_pids(pid))
     )
     SELECT ((SELECT count(*) FROM direct) + (
       SELECT count(*) FROM pg_stat_activity
       WHERE pg_blocking_pids(pid) && ARRAY(SELECT pid FROM direct)
     ))::int AS n`,
    [blocker ?? null],
  );
  return rows[0]?.n ?? 0;
}

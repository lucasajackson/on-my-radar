/**
 * Token buckets in Postgres, safe across replicas.
 *
 * A bucket holds up to `burst` tokens and refills at `perMinute / 60` per second;
 * a request spends one. The state is a row, and a charge is one statement
 * (refill by elapsed time, clamp, subtract) in the shape `chargeRateLimit`
 * (webhooks) and `chargeWindow` (login codes) already use: Postgres evaluates every
 * `SET` expression against the old row, so two replicas charging together cannot
 * both spend the same token.
 *
 * ## Leasing
 *
 * One write per request, per bucket, would put hundreds of single-row updates a second
 * on a tiny table and a pool slot under every request. So a replica takes `lease` tokens
 * at a time and spends them locally. The limit still holds across replicas, to within
 * `lease x replicas` requests, and `RATE_LIMIT_LEASE=1` makes it exact at the price of
 * a write per request. Unspent leased tokens are forfeited after `LEASE_TTL_MS`, so an idle
 * caller cannot bank more than one lease.
 *
 * That is the only process-local state here, and it is a cache of what the database
 * already granted: losing it (a restart) costs a caller at most one lease.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { env } from '../env.js';

export interface BucketSpec {
  perMinute: number;
  burst: number;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

const LEASE_TTL_MS = 5_000;
const MAX_LEASES = 5_000;
const leases = new Map<string, { tokens: number; expires: number }>();

function remember(key: string, tokens: number, expires: number): void {
  if (leases.size >= MAX_LEASES) {
    for (const [k, v] of leases) if (v.expires <= Date.now()) leases.delete(k);
    // Still full: forget the oldest insertions. A forgotten lease is only a lost token or two.
    for (const k of leases.keys()) {
      if (leases.size < MAX_LEASES) break;
      leases.delete(k);
    }
  }
  leases.set(key, { tokens, expires });
}

/** Test seam: drop every local lease. */
export function resetTokenBucketsForTesting(): void {
  leases.clear();
}

/**
 * Callers of one key go through a promise chain, one at a time: each spends a token from the
 * local lease if there is one, otherwise fetches a lease (holding its place in the line) and
 * spends one of it, or is refused. No caller succeeds without a token being taken for it, and
 * a crowd of first requests asks the database for a few leases in turn, not one each at once.
 */
const lines = new Map<string, Promise<void>>();

export function takeToken(
  key: string,
  spec: BucketSpec,
  now: number = Date.now(),
): Promise<TakeResult> {
  const result = (lines.get(key) ?? Promise.resolve()).then(() => takeInTurn(key, spec, now));
  // The next caller waits for this one to finish, however it ends.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  lines.set(key, tail);
  void tail.then(() => {
    if (lines.get(key) === tail) lines.delete(key);
  });
  return result;
}

async function takeInTurn(key: string, spec: BucketSpec, now: number): Promise<TakeResult> {
  const lease = leases.get(key);
  if (lease && lease.expires > now && lease.tokens >= 1) {
    lease.tokens -= 1;
    return { ok: true };
  }
  return fetchLease(key, spec, now);
}

async function fetchLease(key: string, spec: BucketSpec, now: number): Promise<TakeResult> {
  const want = Math.max(1, Math.min(env().RATE_LIMIT_LEASE, spec.burst));
  const ratePerSecond = spec.perMinute / 60;
  const available = sql`least(${spec.burst}::float8, b.tokens + greatest(0, extract(epoch FROM now() - b.refilled_at)) * ${ratePerSecond}::float8)`;
  const granted = sql`floor(least(${want}::float8, ${available}))`;
  const result = await getDb().execute<{ granted: number; tokens: number }>(sql`
    INSERT INTO rate_limit_buckets AS b (key, tokens, refilled_at, granted)
    VALUES (${key}, ${spec.burst}::float8 - ${want}::float8, now(), ${want}::int)
    ON CONFLICT (key) DO UPDATE
      SET granted = (${granted})::int,
          tokens = ${available} - ${granted},
          refilled_at = now()
    RETURNING granted, tokens`);
  const row = result.rows[0];
  if (!row) throw new Error('rate limit charge returned no row');
  if (row.granted >= 1) {
    // One token is spent by the caller that fetched; the rest are this process's lease.
    if (row.granted > 1) remember(key, row.granted - 1, now + LEASE_TTL_MS);
    return { ok: true };
  }
  // `tokens` is what the bucket holds now, below one; the next whole token is that far away.
  const seconds = Math.ceil((1 - row.tokens) / ratePerSecond);
  return { ok: false, retryAfterSeconds: Math.min(3600, Math.max(1, seconds)) };
}

/** Worker sweep: buckets untouched for an hour have refilled to full and carry no information. */
export async function purgeIdleBuckets(batchSize = 1_000): Promise<number> {
  const result = await getDb().execute(sql`
    WITH picked AS (
      SELECT key FROM rate_limit_buckets
       WHERE refilled_at < now() - interval '1 hour'
       LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM rate_limit_buckets t USING picked WHERE t.key = picked.key`);
  return result.rowCount ?? 0;
}

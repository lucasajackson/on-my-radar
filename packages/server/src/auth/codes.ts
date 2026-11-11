import { emailOpen } from '../services/account-lifecycle.js';
/**
 * Six-digit sign-in codes.
 *
 * The security model is deliberately not "the code is hard to guess" — it is
 * short-lived (10 min), single-use, attempt-capped (5 tries) and rate-limited
 * per address (6 per hour). Only the HMAC of the code is stored.
 *
 * Every code issued inside the window stays valid (mail can arrive late and out
 * of order, so a resend must not kill the codes already in flight), at most
 * `maxLive` at once. The guess budget belongs to the address: every live code
 * carries the same attempt count (a new code inherits it), so the five attempts
 * survive resends and evictions, and using any code retires them all. A guess
 * is compared against every live code, so the daily failure budget is reserved
 * before comparing, one unit per code. Issuing and verifying take one advisory lock per
 * address first, so the two can never lock rows against each other.
 *
 * Three of those four are properties of a *write*, not of a read, and that is
 * the thing to keep hold of when editing this file. `SELECT` the row, decide,
 * then `UPDATE ... WHERE id = $1` is the shape that quietly loses all three:
 * two requests that arrive together both read the same row, both decide they
 * are allowed, and both write. So every condition below lives in the `WHERE`
 * clause of the statement that acts on it, and every one of those statements
 * checks how many rows it actually changed. Node interleaves at each `await`,
 * so this was reachable on one replica and is more so on several. The ceiling
 * goes one step further than a guarded statement: it is charged against a
 * dedicated window row, webhook-style, so it is exact rather than merely
 * narrow.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { LOGIN_CODE, normalizeEmail, WAITLIST } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { hashSecret, newLoginCode, safeEqual } from './crypto.js';

/** Serialises issuing and verifying for one address; always the first lock taken. */
export const lockAddress = (tx: Pick<ReturnType<typeof getDb>, 'execute'>, email: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'login-code:' + email}, 0))`);

export interface IssuedCode {
  code: string;
  expiresAt: Date;
}

export class RateLimitedError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    /**
     * Which ceiling refused: one address's, the caller's network's, or the
     * verify-side lockout of an address (`locked`).
     */
    public readonly scope: 'address' | 'network' | 'locked' = 'address',
  ) {
    super(
      scope === 'network'
        ? 'Too many sign-in codes have been requested from your network. Try again later.'
        : scope === 'locked'
          ? 'Too many incorrect codes for this address. Try again later.'
          : 'Too many codes requested for this address. Try again shortly.',
    );
    this.name = 'RateLimitedError';
  }
}

/**
 * The ceiling, charged as one statement against a per-address window row.
 *
 * This is `radar_webhooks.window_*` again (`services/webhooks.ts`), and exact
 * for the same reason: both `CASE` arms read the pre-update row, so the reset
 * and the increment cannot disagree, and two charges arriving together
 * serialise on the row lock for exactly the duration of one statement — no
 * transaction to pin a pool connection, no lock that outlives the statement.
 * That last property is not a nicety: a blocking per-address lock would let the
 * mailbomb this limit exists to stop queue its requests on pinned connections
 * and starve the pool for everyone else.
 *
 * The window is fixed, not sliding — six in the hour measured from the first
 * request, worst case ~2x across a boundary — the same trade webhooks made,
 * because the job is stopping abuse, not metering fairly. What the row buys in
 * exchange is an exact count and an exact `Retry-After`, computed from
 * `window_started_at` instead of guessed.
 */
async function chargeWindow(
  table: 'login_code_limits' | 'login_code_network_limits',
  key: string,
): Promise<{ count: number; windowStartedAt: Date }> {
  // Two tables of the same shape (0018, 0035). The identifiers come from the
  // closed union above, never from a request.
  const t = sql.identifier(table);
  const column = sql.identifier(table === 'login_code_limits' ? 'email' : 'network');
  const result = await getDb().execute<{ window_count: number; window_started_at: Date }>(
    sql`INSERT INTO ${t} (${column}, window_started_at, window_count)
        VALUES (${key}, now(), 1)
        ON CONFLICT (${column}) DO UPDATE
        SET window_started_at = CASE
              WHEN ${t}.window_started_at < now() - interval '1 hour' THEN now()
              ELSE ${t}.window_started_at END,
            window_count = CASE
              WHEN ${t}.window_started_at < now() - interval '1 hour' THEN 1
              ELSE ${t}.window_count + 1 END
        RETURNING window_count, window_started_at`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('limit charge returned no row');
  return { count: row.window_count, windowStartedAt: new Date(row.window_started_at) };
}

/**
 * Charge the waitlist form's per-network window, answering the seconds until it
 * rolls when this caller is over the ceiling, or null when it may proceed.
 *
 * The same self-rolling window table the sign-in ceiling uses, under its own
 * `waitlist:` key space, so the two never spend each other's allowance.
 */
export async function chargeWaitlistNetwork(network: string): Promise<number | null> {
  const charge = await chargeWindow('login_code_network_limits', `waitlist:${network}`);
  return charge.count > WAITLIST.requestsPerNetworkPerHour
    ? retryAfter(charge.windowStartedAt)
    : null;
}

/**
 * Seconds until a window rolls. Clamped to the window's own length:
 * `window_started_at` is the DATABASE's clock and this subtraction uses the app
 * node's, and a database a second ahead otherwise yields a 3601.
 */
function retryAfter(windowStartedAt: Date): number {
  const retryMs = windowStartedAt.getTime() + 60 * 60 * 1000 - Date.now();
  return Math.min(3600, Math.max(1, Math.ceil(retryMs / 1000)));
}

/**
 * `network` is the caller's network (`networkOf(clientIp)`), or null when the
 * trusted edge header is absent — then only the per-address ceiling applies,
 * because there is nothing trustworthy to key a second one on.
 */
export async function issueLoginCode(
  email: string,
  requestIp: string | null,
  network: string | null = null,
): Promise<IssuedCode> {
  const normalized = normalizeEmail(email);
  const db = getDb();

  // The network is charged first, and a refusal there charges no address: a
  // caller spraying codes at other people's addresses must not also use up
  // those people's hourly allowance on the requests it was refused.
  if (network) {
    const byNetwork = await chargeWindow('login_code_network_limits', network);
    if (byNetwork.count > LOGIN_CODE.requestsPerNetworkPerHour) {
      throw new RateLimitedError(retryAfter(byNetwork.windowStartedAt), 'network');
    }
  }

  const charge = await chargeWindow('login_code_limits', normalized);
  if (charge.count > LOGIN_CODE.requestsPerHour) {
    // Exact, not the old flat 900: the window is a row, so the moment it rolls
    // is known. A refused request has written nothing to login_codes, so the
    // code somebody is mid-way through typing survives — holding down the
    // button must never lock a person out of their own account.
    throw new RateLimitedError(retryAfter(charge.windowStartedAt));
  }

  const code = newLoginCode();
  const expiresAt = new Date(Date.now() + LOGIN_CODE.ttlSeconds * 1000);
  if (!(await emailOpen(normalized))) return { code, expiresAt };
  await db.transaction(async (tx) => {
    // Only admitted requests reach this lock (at most six per address/hour).
    // The limit charge remains a separate, single statement so refused bursts
    // never queue transactions. Email delivery happens after this transaction
    // has released its connection.
    await lockAddress(tx, normalized);
    const liveCodes = and(
      eq(schema.loginCodes.email, normalized),
      isNull(schema.loginCodes.consumedAt),
      gt(schema.loginCodes.expiresAt, new Date()),
    );
    // Earlier codes stay valid and the new one inherits their failures, so a
    // resend never refunds the address's attempts; only the oldest beyond the
    // cap retire.
    const [carried] = await tx
      .select({ attempts: sql<number>`coalesce(max(${schema.loginCodes.attempts}), 0)::int` })
      .from(schema.loginCodes)
      .where(liveCodes);
    await tx.execute(
      sql`UPDATE login_codes SET consumed_at = now() WHERE id IN (
            SELECT id FROM login_codes
            WHERE email = ${normalized} AND consumed_at IS NULL AND expires_at > now()
            ORDER BY created_at DESC, id DESC OFFSET ${LOGIN_CODE.maxLive - 1})`,
    );

    await tx.insert(schema.loginCodes).values({
      email: normalized,
      codeHash: hashSecret(code),
      attempts: carried?.attempts ?? 0,
      expiresAt,
      requestIp,
    });
  });

  return { code, expiresAt };
}

/**
 * The verify side's two ceilings, charged in `login_verify_limits` by one
 * statement each, exactly as `chargeWindow` does for requests.
 *
 * - `network:<net>`: every verification from a network, any outcome, per hour.
 * - `address:<email>`: wrong guesses at a live code, per day. Reaching the cap
 *   sets `locked_until`, and a locked address refuses verification outright —
 *   the right code included — until it passes.
 *
 * The address is charged only for guesses (`mismatch`, and the fifth that
 * retires a code), never for "no live code": that is not a guess, and charging
 * it would let anybody who knows an address lock its owner out by posting
 * garbage at it. What remains is inherent — someone who holds a login challenge
 * for an address can spend its 20 — and is bounded by the six-an-hour request
 * ceiling that mints the challenge.
 */
async function chargeVerify(
  key: string,
  windowSeconds: number,
  lockAt: number | null,
  weight = 1,
  db: Pick<ReturnType<typeof getDb>, 'execute'> = getDb(),
): Promise<{ count: number; windowStartedAt: Date; lockedUntil: Date | null }> {
  const t = sql.identifier('login_verify_limits');
  const lock =
    lockAt === null
      ? sql`NULL`
      : sql`CASE WHEN (CASE WHEN ${t}.window_started_at < now() - ${windowSeconds} * interval '1 second'
                            THEN ${weight} ELSE ${t}.window_count + ${weight} END) >= ${lockAt}
                 THEN now() + ${windowSeconds} * interval '1 second'
                 ELSE NULL END`;
  const result = await db.execute<{
    window_count: number;
    window_started_at: Date;
    locked_until: Date | null;
  }>(
    sql`INSERT INTO ${t} (key, window_started_at, window_count, locked_until)
        VALUES (${key}, now(), ${weight}, ${lockAt !== null && lockAt <= weight ? sql`now() + ${windowSeconds} * interval '1 second'` : sql`NULL`})
        ON CONFLICT (key) DO UPDATE
        SET locked_until = ${lock},
            window_started_at = CASE
              WHEN ${t}.window_started_at < now() - ${windowSeconds} * interval '1 second' THEN now()
              ELSE ${t}.window_started_at END,
            window_count = CASE
              WHEN ${t}.window_started_at < now() - ${windowSeconds} * interval '1 second' THEN ${weight}
              ELSE ${t}.window_count + ${weight} END
        RETURNING window_count, window_started_at, locked_until`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('verify limit charge returned no row');
  return {
    count: row.window_count,
    windowStartedAt: new Date(row.window_started_at),
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
  };
}

/** Seconds until an address's verify lock lifts, or null when it is not locked. */
async function verifyLockRemaining(email: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ lockedUntil: schema.loginVerifyLimits.lockedUntil })
    .from(schema.loginVerifyLimits)
    .where(eq(schema.loginVerifyLimits.key, `address:${email}`))
    .limit(1);
  if (!row?.lockedUntil) return null;
  const ms = row.lockedUntil.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : null;
}

export type VerifyResult =
  { ok: true } | { ok: false; reason: 'expired' | 'not_found' | 'too_many_attempts' | 'mismatch' };

/**
 * Consumes the code on success. A wrong guess burns one of the five attempts,
 * and exhausting them retires the code rather than merely refusing the guess.
 */
export async function verifyLoginCode(
  email: string,
  code: string,
  /** The caller's network (`networkOf(clientIp)`), or null when the trusted header is absent. */
  network: string | null = null,
): Promise<VerifyResult> {
  const normalized = normalizeEmail(email);

  // Network first, and before the lock: a refusal here says nothing about the
  // address. Then the address lock, before the code is compared, so a locked
  // address cannot be walked by anyone — and cannot confirm a right guess.
  if (network) {
    const byNetwork = await chargeVerify(`network:${network}`, 3600, null);
    if (byNetwork.count > LOGIN_CODE.verifiesPerNetworkPerHour) {
      throw new RateLimitedError(retryAfter(byNetwork.windowStartedAt), 'network');
    }
  }
  const locked = await verifyLockRemaining(normalized);
  if (locked !== null) throw new RateLimitedError(locked, 'locked');

  const result = await compareLoginCode(normalized, code);
  if (result.ok) {
    // A sign-in that worked ends the address's run of failures.
    await getDb()
      .delete(schema.loginVerifyLimits)
      .where(eq(schema.loginVerifyLimits.key, `address:${normalized}`));
  }
  return result;
}

async function compareLoginCode(normalized: string, code: string): Promise<VerifyResult> {
  const db = getDb();
  const none: VerifyResult = { ok: false, reason: 'not_found' };

  if (!(await emailOpen(normalized))) return none;
  return db.transaction(async (tx): Promise<VerifyResult> => {
    await lockAddress(tx, normalized);
    // Lock every live code of the address, newest first. Concurrent guesses
    // queue here and re-read after the lock: a code retired by an earlier
    // guess no longer qualifies, so at most five guesses are ever compared per
    // address however many codes it holds, and the lock is held through the
    // comparison so a fifth wrong guess cannot burn a correct earlier one.
    const live = await tx
      .select()
      .from(schema.loginCodes)
      .where(
        and(
          eq(schema.loginCodes.email, normalized),
          isNull(schema.loginCodes.consumedAt),
          gt(schema.loginCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.loginCodes.createdAt), desc(schema.loginCodes.id))
      .for('update');
    if (live.length === 0) return none;

    // Reserve the daily budget before comparing, one unit per code compared,
    // and compare only as many (newest first) as the reservation covers. The
    // address lock makes this read-then-charge exact; the charge itself is the
    // usual single statement, on this transaction's connection.
    const key = `address:${normalized}`;
    const cap = LOGIN_CODE.verifyFailuresPerAddressPerDay;
    const [spent] = (
      await tx.execute<{ used: number }>(
        sql`SELECT CASE WHEN window_started_at < now() - interval '24 hours' THEN 0
                        ELSE window_count END AS used
            FROM login_verify_limits WHERE key = ${key}`,
      )
    ).rows;
    const granted = Math.min(live.length, cap - (spent?.used ?? 0));
    if (granted <= 0) return { ok: false, reason: 'too_many_attempts' };
    await chargeVerify(key, 24 * 3600, cap, granted, tx);

    const guess = hashSecret(code);
    const matches = live
      .slice(0, granted)
      .map((row) => safeEqual(row.codeHash, guess))
      .includes(true);
    // Every live code carries the address's failure count (issue copies it).
    const used = Math.max(...live.map((row) => row.attempts)) + 1;
    const exhausted = !matches && used >= LOGIN_CODE.maxAttempts;
    await tx
      .update(schema.loginCodes)
      .set({ attempts: sql`${schema.loginCodes.attempts} + 1` })
      .where(
        inArray(
          schema.loginCodes.id,
          live.map((row) => row.id),
        ),
      );
    if (matches || exhausted) {
      // A sign-in, or the fifth miss, retires every code the address holds.
      await tx
        .update(schema.loginCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(schema.loginCodes.email, normalized), isNull(schema.loginCodes.consumedAt)));
    }
    if (matches) return { ok: true };
    return { ok: false, reason: exhausted ? 'too_many_attempts' : 'mismatch' };
  });
}

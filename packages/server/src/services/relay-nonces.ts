/**
 * The inbound-email replay cache, in Postgres.
 *
 * The relay's HMAC binds timestamp, nonce, recipient and size but not the body (DKIM
 * authenticates that), so a captured header set could otherwise be replayed inside its
 * five-minute window with any other signed message of the same size. The relay mints a
 * fresh nonce for every attempt, so a nonce seen twice is never legitimate.
 *
 * This used to be a process-local `Map`, which is only correct with one API replica: at
 * three, a replay can land on a pod that never saw the nonce. `INSERT ... ON CONFLICT` makes
 * the database the arbiter. An expired row for the same nonce is taken over rather than
 * treated as a replay, so the table needs no sweep to stay correct; the sweep only keeps it small.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';

/** One second past the window, so the timestamp check has always closed first. */
const GRACE_MS = 1_000;

/** False for a replay. Call only after the signature has verified, so unsigned noise cannot fill it. */
export async function rememberRelayNonce(
  nonce: string,
  signedAtMs: number,
  windowMs: number,
): Promise<boolean> {
  const expiresAt = new Date(signedAtMs + windowMs + GRACE_MS);
  const result = await getDb().execute(sql`
    INSERT INTO email_relay_nonces AS n (nonce, expires_at)
    VALUES (${nonce}, ${expiresAt.toISOString()}::timestamptz)
    ON CONFLICT (nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at
      WHERE n.expires_at <= now()
    RETURNING nonce`);
  return result.rows.length > 0;
}

/** Worker sweep: nonces past their window. Bounded per run. */
export async function purgeExpiredRelayNonces(batchSize = 1_000): Promise<number> {
  const result = await getDb().execute(sql`
    WITH picked AS (
      SELECT nonce FROM email_relay_nonces
       WHERE expires_at < now()
       LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM email_relay_nonces t USING picked WHERE t.nonce = picked.nonce`);
  return result.rowCount ?? 0;
}

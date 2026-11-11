/** Bounded worker housekeeping; expiry is checked again while holding each row. */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { OAUTH_TOKEN_RETENTION_MS, REFRESH_TOKEN_TTL_MS } from './lifetimes.js';

/** A registration that never completed a flow. */
export const OAUTH_CLIENT_NEVER_USED_DAYS = 30;
/**
 * A client that did, and then went quiet. Long, because a connector coming
 * back from a break re-authorizes with the client_id it cached, and deleting
 * that id turns "sign in again" into "Unknown client".
 */
export const OAUTH_CLIENT_IDLE_DAYS = 180;

const TABLES = {
  guest_support_limits: {
    key: 'key',
    expired: sql`window_started_at < now() - interval '24 hours'`,
  },
  guest_support_capabilities: {
    key: 'id',
    expired: sql`expires_at < now() OR revoked_at IS NOT NULL`,
  },
  sessions: { key: 'id', expired: sql`expires_at < now()` },
  login_codes: { key: 'id', expired: sql`expires_at < now() - interval '1 day'` },
  oauth_codes: { key: 'id', expired: sql`expires_at < now() - interval '1 day'` },
  // One hour is active; a day of inactivity leaves ample room for in-flight issues.
  login_code_limits: { key: 'email', expired: sql`window_started_at < now() - interval '1 day'` },
  login_code_network_limits: {
    key: 'network',
    expired: sql`window_started_at < now() - interval '1 day'`,
  },
  login_verify_limits: {
    key: 'key',
    expired: sql`window_started_at < now() - interval '2 days' AND (locked_until IS NULL OR locked_until < now())`,
  },
  /*
   * A token row is kept until its refresh window plus a margin has passed, in
   * whatever state it is in: live, expired, rotated or revoked. Rotated and
   * revoked rows are the reuse evidence for a refresh token that stays
   * presentable for REFRESH_TOKEN_TTL_MS from `created_at`; deleting them after
   * a week (as this once did) let a stolen, retired token be replayed on day 8
   * as plain "not valid" with its successor still alive. Nothing here is live
   * past the window: the access token dies in an hour and the refresh token at
   * created_at + TTL, so no ordinary live row is ever eligible.
   */
  oauth_tokens: {
    key: 'id',
    expired: sql`created_at < now() - ${OAUTH_TOKEN_RETENTION_MS} * interval '1 millisecond'`,
  },
  /*
   * Registered OAuth clients (0035 carries the argument). Idle — never used
   * and registered over 30 days ago, or unused for 180 — AND holding nothing
   * live. Swept after tokens and codes above, so a grant that has only just
   * died is already gone by the time its client is judged.
   */
  oauth_clients: {
    key: 'id',
    expired: sql`(
      (last_used_at IS NULL AND created_at < now() - ${OAUTH_CLIENT_NEVER_USED_DAYS} * interval '1 day')
      OR last_used_at < now() - ${OAUTH_CLIENT_IDLE_DAYS} * interval '1 day'
    )
    AND NOT EXISTS (
      SELECT 1 FROM oauth_tokens t
      WHERE t.client_id = oauth_clients.client_id AND t.revoked_at IS NULL
        AND (t.expires_at > now() OR (
          t.refresh_token_hash IS NOT NULL
          AND t.created_at > now() - ${REFRESH_TOKEN_TTL_MS} * interval '1 millisecond'
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM oauth_codes o
      WHERE o.client_id = oauth_clients.client_id AND o.consumed_at IS NULL
        AND o.expires_at > now()
    )`,
  },
} as const satisfies Record<string, { key: string; expired: SQL }>;

export async function sweepAuthRetention(
  batchSize = 500,
): Promise<Record<keyof typeof TABLES, number>> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000)
    throw new Error('Invalid auth retention batch size');
  const result = {} as Record<keyof typeof TABLES, number>;
  for (const name of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
    const { key, expired } = TABLES[name];
    const table = sql.identifier(name);
    const column = sql.identifier(key);
    const removed = await getDb().execute(sql`
      WITH picked AS (
        SELECT ${column} FROM ${table} WHERE ${expired}
        LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${table} AS target USING picked
      WHERE target.${column} = picked.${column}
    `);
    result[name] = removed.rowCount ?? 0;
  }
  return result;
}

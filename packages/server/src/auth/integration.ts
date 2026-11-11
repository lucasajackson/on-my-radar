import { sql } from 'drizzle-orm';
/**
 * Resolving an `omr_int_` integration credential (`docs/HELPDESK.md` §3).
 *
 * The same "state first" rule as `bearer.ts`: a credential whose owner is not
 * active, that is revoked, or that has expired **does not resolve**. It is not
 * an actor with a small ceiling; it is nobody.
 *
 * Two hashes can match, and each keeps its own last-used time so the owner can
 * see which one the portal is still presenting during a rotation (§3.4):
 *
 * - the current token, until `expires_at` (90 days from mint or rotation,
 *   decision 6);
 * - the previous token, until `previous_expires_at` (at most 24 hours after
 *   the rotation; a CHECK holds that bound).
 *
 * Path binding is not here: `attachActor` only calls this on the helpdesk
 * routes. This file answers "who is this", never "where may they go".
 */
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';
import { hashSecret } from './crypto.js';
import type { UserRow } from './accounts.js';

export interface IntegrationActor {
  user: UserRow;
  integrationId: string;
  /** Which of the two hashes matched. */
  presented: 'current' | 'previous';
}

export async function resolveIntegrationToken(token: string): Promise<IntegrationActor | null> {
  const now = new Date();
  const hash = hashSecret(token);
  const rows = await getDb()
    .select({ integration: schema.integrations, user: schema.users })
    .from(schema.integrations)
    .innerJoin(schema.users, eq(schema.users.id, schema.integrations.ownerId))
    .where(
      and(
        isNull(schema.integrations.revokedAt),
        eq(schema.users.state, 'active'),
        sql`omr_account_open(${schema.users.id})`,
        or(
          and(eq(schema.integrations.tokenHash, hash), gt(schema.integrations.expiresAt, now)),
          and(
            eq(schema.integrations.previousHash, hash),
            gt(schema.integrations.previousExpiresAt, now),
          ),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const presented = row.integration.tokenHash === hash ? 'current' : 'previous';
  // Awaited, unlike a PAT's, so "which token is the portal presenting" is true
  // the moment the call returns; a failed timestamp still never turns an
  // authenticated call into a 500.
  await getDb()
    .update(schema.integrations)
    .set(presented === 'current' ? { tokenLastUsedAt: now } : { previousLastUsedAt: now })
    .where(eq(schema.integrations.id, row.integration.id))
    .catch(() => undefined);

  return { user: row.user, integrationId: row.integration.id, presented };
}

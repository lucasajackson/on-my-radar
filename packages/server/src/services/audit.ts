/** Append-only record of who did what. Never blocks the caller's request. */
import { getDb, schema, type Db } from '../db/client.js';
import { logger } from '../logger.js';
import type { Actor } from '../http.js';

/**
 * The audit row for an act, built in one place: `recordAudit` writes it fail-
 * open, and the one fail-closed caller (deleting a released helpdesk reply,
 * which must not happen without its record) inserts it inside its own
 * transaction.
 */
export function auditRow(
  actor: Actor | null,
  action: string,
  subjectType: string | null,
  subjectId: string | null,
  meta: Record<string, unknown> = {},
) {
  return {
    actorId: actor?.kind === 'guest' ? null : (actor?.user.id ?? null),
    agentId: actor?.agent?.agentId ?? null,
    actorKind: actor ? actor.kind : 'system',
    action,
    subjectType,
    subjectId,
    meta,
  } as const;
}

export async function recordAudit(
  actor: Actor | null,
  action: string,
  subjectType: string | null,
  subjectId: string | null,
  meta: Record<string, unknown> = {},
  /**
   * The caller's transaction, when the audit row must commit or roll back with
   * the write it records. The insert then runs in a **savepoint** of it.
   *
   * Failing open (below) is only true outside a transaction. Inside one, a
   * failed statement aborts the whole transaction: catching the error here
   * does not un-abort it, and Postgres answers the caller's eventual COMMIT
   * with a ROLLBACK that drizzle does not report. `createSubscription` would
   * then hand back a signing secret for a subscription that was never stored.
   * A savepoint confines the failure to the audit row.
   */
  tx?: Pick<Db, 'transaction'>,
): Promise<void> {
  const row = auditRow(actor, action, subjectType, subjectId, meta);
  try {
    if (tx)
      await tx.transaction(async (savepoint) => savepoint.insert(schema.auditLog).values(row));
    else await getDb().insert(schema.auditLog).values(row);
  } catch (err) {
    /*
     * Failing open is right: an audit failure must never turn a successful
     * write into a 500, exactly as a notification failure must not. `error` is
     * the level, though, not `warn`. This is an append-only accountability
     * record, and the row that did not get written is gone — there is no queue
     * and no retry. A `warn` sits in the same bucket as a rejected email and
     * gets skimmed past; the thing that just happened is that the log of who
     * did what now has a hole in it, permanently.
     *
     * Worth stating rather than rediscovering: `audit_log` has **no read path
     * anywhere in the product**. Nothing renders it, no route serves it, no MCP
     * tool exposes it. It is written faithfully and can only be read by opening
     * a psql session against production. Whether it should have one is a real
     * question — it is the table an owner would want when asking who removed a
     * member — but building it is a feature, not a bug fix, and this comment is
     * the flag rather than the start of it.
     */
    logger.error({ err, action }, 'audit write failed — this record is gone, not retried');
  }
}

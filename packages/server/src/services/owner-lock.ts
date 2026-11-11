/** Per-owner serialization for count-increasing writes, plus the agent ceiling. */
import { eq, sql } from 'drizzle-orm';
import { AGENT_REPO } from '@onmyradar/contract';
import { schema, type getDb } from '../db/client.js';
import { conflict } from '../http.js';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * Acquire before any agent or key row lock. The key is shared with older pods that still say
 * `quota-owner`, so the two serialize while a release rolls out; do not rename it.
 */
export async function lockOwner(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota-owner:${ownerId}`}, 0))`,
  );
}

/** Caller holds lockOwner through the ensuing insert/ownership update and commit. */
export async function assertAgentCeiling(tx: Tx, ownerId: string): Promise<void> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.repoAgents)
    .where(eq(schema.repoAgents.ownerId, ownerId));
  if ((row?.count ?? 0) >= AGENT_REPO.agentsPerOwner)
    throw conflict(`You already have ${AGENT_REPO.agentsPerOwner} agents. Delete one first.`);
}

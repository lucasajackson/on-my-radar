/**
 * Reactions on blips.
 *
 * A reaction is the cheapest possible response to somebody else's thought —
 * cheaper than a comment, which is the point. So the whole surface is one
 * atomic call, and the aggregation is done in SQL rather than by shipping
 * the rows: a blip with forty thumbs-up should cost one line in a payload, and
 * *who* reacted is not something the interface shows.
 *
 * The toggle is decided by the unique index `(blip_id, user_id, reaction,
 * agent_id)` (NULLS NOT DISTINCT), not by a read-then-write in here. Two clicks
 * that interleave cannot produce two rows, because the second insert is `ON
 * CONFLICT DO NOTHING` against an index that already holds the first. A mark an
 * agent puts on is the agent's (`agent_id`), beside its owner's own.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { BLIP_REACTIONS, isBlipReaction, type BlipReactionDto } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { badRequest, notFound, type Actor } from '../http.js';
import { requireParticipation } from './access.js';
import { writeAsAgent } from './agents.js';
import { recordAudit } from './audit.js';
import { enqueueNotificationEvent } from './notifications.js';
import { drainOne } from './outbox.js';

/**
 * Tallies for a page of blips, in two queries regardless of page size: one
 * GROUP BY for the counts, one indexed lookup for "did I react".
 *
 * A reaction whose key the registry no longer knows is dropped rather than
 * rendered as a broken mark — the same degradation rule as an unknown template
 * or an unknown lane.
 */
export async function reactionsFor(
  blipIds: string[],
  actorId: string | null,
  /** The agent whose "mine" this is; absent, the person's own. */
  agentId: string | null = null,
): Promise<Map<string, BlipReactionDto[]>> {
  const byBlip = new Map<string, BlipReactionDto[]>();
  if (blipIds.length === 0) return byBlip;
  const db = getDb();

  const counts = await db
    .select({
      blipId: schema.blipReactions.blipId,
      reaction: schema.blipReactions.reaction,
      count: sql<number>`count(*)::int`,
      agents: sql<
        string[]
      >`coalesce(array_agg(${schema.agents.name} order by ${schema.agents.name}) filter (where ${schema.agents.name} is not null), '{}')`,
    })
    .from(schema.blipReactions)
    .leftJoin(schema.agents, eq(schema.agents.id, schema.blipReactions.agentId))
    .where(inArray(schema.blipReactions.blipId, blipIds))
    .groupBy(schema.blipReactions.blipId, schema.blipReactions.reaction);

  const mine = actorId
    ? await db
        .select({
          blipId: schema.blipReactions.blipId,
          reaction: schema.blipReactions.reaction,
        })
        .from(schema.blipReactions)
        .where(
          and(
            inArray(schema.blipReactions.blipId, blipIds),
            eq(schema.blipReactions.userId, actorId),
            agentId
              ? eq(schema.blipReactions.agentId, agentId)
              : isNull(schema.blipReactions.agentId),
          ),
        )
    : [];
  const own = new Set(mine.map((r) => `${r.blipId}:${r.reaction}`));

  for (const row of counts) {
    if (!isBlipReaction(row.reaction)) continue;
    const list = byBlip.get(row.blipId) ?? [];
    list.push({
      reaction: row.reaction,
      emoji: BLIP_REACTIONS[row.reaction].emoji,
      label: BLIP_REACTIONS[row.reaction].label,
      count: row.count,
      ...(row.agents.length > 0 ? { agents: row.agents } : {}),
      mine: own.has(`${row.blipId}:${row.reaction}`),
    });
    byBlip.set(row.blipId, list);
  }

  // Registry order, not count order: the marks should sit in the same place on
  // every blip so the row is scannable rather than reshuffling as votes land.
  const order = Object.keys(BLIP_REACTIONS);
  for (const list of byBlip.values()) {
    list.sort((a, b) => order.indexOf(a.reaction) - order.indexOf(b.reaction));
  }
  return byBlip;
}

/**
 * Put one mark on, take it off, or toggle it. Returns the blip's full tally
 * afterwards, so a caller never has to make a second call to render the result
 * — and an agent gets to see what it just did.
 *
 * `on` is the idempotent form: `true` leaves the mark on however many times it
 * is sent, `false` leaves it off. A toggle (`on` absent) is a button's verb; an
 * agent that retried one after a timeout took back the mark it had just made.
 */
export async function setReaction(
  actor: Actor,
  blipId: string,
  reaction: string,
  on?: boolean,
  /** The `load_agent` session: the mark is that agent's, not its owner's. */
  session?: string | null,
): Promise<{ blipId: string; reacted: boolean; reactions: BlipReactionDto[] }> {
  if (!isBlipReaction(reaction)) {
    throw badRequest(
      `"${reaction}" is not a reaction. Use one of: ${Object.keys(BLIP_REACTIONS).join(', ')}.`,
    );
  }
  actor = await writeAsAgent(actor, session);
  const agentId = actor.agent?.agentId ?? null;
  const db = getDb();
  const rows = await db.select().from(schema.blips).where(eq(schema.blips.id, blipId)).limit(1);
  const blip = rows[0];
  if (!blip) throw notFound('Blip not found');

  await requireParticipation(blip.radarId, actor, 'reactions', db);

  const key = and(
    eq(schema.blipReactions.blipId, blip.id),
    eq(schema.blipReactions.userId, actor.user.id),
    eq(schema.blipReactions.reaction, reaction),
    agentId ? eq(schema.blipReactions.agentId, agentId) : isNull(schema.blipReactions.agentId),
  );

  let notificationJob: string | undefined;
  const reacted = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, blip.id))
      .for('update');
    if (!current) throw notFound('Blip not found');
    const access = await requireParticipation(current.radarId, actor, 'reactions', tx);

    if (on !== true) {
      const removed = await tx.delete(schema.blipReactions).where(key).returning();
      if (on === false || removed.length > 0) return false;
    }
    const inserted = await tx
      .insert(schema.blipReactions)
      .values({
        blipId: blip.id,
        userId: actor.user.id,
        reaction,
        agentId,
        radarId: current.radarId,
      })
      .onConflictDoNothing()
      .returning();
    // The unique index decides whether this call actually added a mark.
    // A concurrent loser must not produce a second notification for one mark.
    if (inserted.length > 0)
      notificationJob = await enqueueNotificationEvent(tx, {
        type: 'reaction',
        actor,
        radarId: access.radar.id,
        blipId: blip.id,
      });
    return true;
  });

  await recordAudit(actor, reacted ? 'reaction.add' : 'reaction.remove', 'blip', blip.id, {
    reaction,
    radarId: blip.radarId,
  });

  // Only when a mark goes ON. Taking one back is not an event anybody needs to
  // hear about, and notifying on both halves of a toggle would let one
  // indecisive click emit two.
  if (notificationJob) await drainOne(notificationJob);

  const tallies = await reactionsFor([blip.id], actor.user.id, agentId);
  return { blipId: blip.id, reacted, reactions: tallies.get(blip.id) ?? [] };
}

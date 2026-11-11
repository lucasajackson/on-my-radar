import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';
import { readableRadarQuery } from './access.js';

/**
 * A decision request that is still waiting on its addressee, as a predicate over
 * `decision_requests dr`, the blip it is on (`b`) and that blip's radar *now* (`r`).
 *
 * One definition for every reader (the card's panel, the cap, the notification list and badge, the
 * answer's claim), so "overtaken" cannot mean two things. It is read at the time, never stored:
 * the card moved to another radar (`dr.radar_id` is where it was asked), left the lane it was
 * asked in, the radar's template changed, or the radar turned comments off.
 */
export const DECISION_LIVE: SQL = sql.raw(
  `dr.status = 'open' AND dr.radar_id = b.radar_id AND dr.lane IS NOT DISTINCT FROM b.status ` +
    `AND dr.template = r.template AND r.comments_enabled`,
);

/**
 * THE RULE for showing a decision's words (context, question, answer) to a person, in one place.
 *
 * Read the request through this, in the SAME statement that reads its text, or do not show it:
 *   1. its card is still on the radar the request was asked on (`blips.radar_id = dr.radar_id`), and
 *   2. `userId` can read that radar now (`readableRadarQuery`, the predicate every radar read uses),
 *      evaluated here in SQL rather than trusted from an earlier check that a move or a revoked
 *      share can outrun (a card that went A to B to A passes any equality test made before).
 *   3. a caller reading for a limited agent's connection passes that agent's fence.
 * Both notification kinds go through it, for the payload and the excerpt alike. A caller that gets
 * no row says only "a decision on a card you can no longer see".
 */
export async function readDecisionRequestsFor(
  userId: string,
  where: SQL,
  fence: readonly string[] | null = null,
) {
  return getDb()
    .select({ request: schema.decisionRequests })
    .from(schema.decisionRequests)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.decisionRequests.blipId))
    .where(
      and(
        eq(schema.blips.radarId, schema.decisionRequests.radarId),
        inArray(schema.decisionRequests.radarId, readableRadarQuery(userId)),
        // A connection limited to selected radars (`fenceCaps`): only those, which the userId-based
        // set above knows nothing about. A caller with an actor passes its fence; the delivery
        // workers act for a recipient with no connection and pass none.
        fence
          ? fence.length
            ? inArray(schema.decisionRequests.radarId, [...fence])
            : sql`false`
          : undefined,
        where,
      ),
    )
    .then((rows) => rows.map((row) => row.request));
}

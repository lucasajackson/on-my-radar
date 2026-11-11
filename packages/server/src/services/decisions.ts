/**
 * Decision requests: an agent (or a person) asks a person to decide something on a card.
 *
 * Universal, like a comment: asking is gated by `requireParticipation(…, 'comments')`, and with
 * comments off new requests are refused and open ones are hidden at read time, never deleted.
 * What an answer *does* is declared by the radar's template (`decides`): there the options are the
 * outcome lanes and the answer moves the card through `updateBlip`, reusing ratification and
 * supersession. Elsewhere the options are free text and an answer changes nothing.
 *
 * Answering is a person's act (`assertHumanDecision`), the addressee's alone, and exists only on
 * REST: there is deliberately no MCP tool for it. Every read is fenced to the blip's *current*
 * radar in the same statement, so a card moved elsewhere takes no request with it.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  DECISIONS,
  decidesFor,
  type AnswerDecisionInput,
  type DecisionRequestDto,
  type RequestDecisionInput,
  type UpdateBlipInput,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, conflict, forbidden, notFound, type Actor } from '../http.js';
import {
  assertHumanDecision,
  getRadarAccess,
  radarReaders,
  requireParticipation,
  requireRadar,
  type RadarRow,
} from './access.js';
import { writeAsAgent } from './agents.js';
import { updateBlip } from './blips.js';
import { assertNotCharterPage } from './charter.js';
import { DECISION_LIVE } from './decision-live.js';
import { enqueueDecisionEvent } from './notifications.js';
import { drainOne } from './outbox.js';

type RequestRow = typeof schema.decisionRequests.$inferSelect;

/** One request as the caller sees it, given the blip's status and radar as they are now. */
function present(
  row: RequestRow,
  radar: Pick<RadarRow, 'template' | 'templateConfig'>,
  blipStatus: string | null,
  requestedBy: string | null,
  actor: Actor,
): DecisionRequestDto {
  const overtaken = row.lane !== blipStatus || row.template !== radar.template;
  const decides = !overtaken ? decidesFor(radar.template, radar.templateConfig) : null;
  const labelOf = new Map(decides?.outcomes.map((lane) => [lane.id, lane.label]));
  const status = row.status === 'answered' ? 'answered' : overtaken ? 'overtaken' : 'open';
  return {
    id: row.id,
    blipId: row.blipId,
    radarId: row.radarId,
    context: row.context,
    question: row.question,
    options: row.options.map((value) => ({ value, label: labelOf.get(value) ?? value })),
    decides: decides !== null,
    status,
    answer: row.answer,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    requestedBy,
    createdAt: row.createdAt.toISOString(),
    canAnswer: status === 'open' && row.addresseeUserId === actor.user.id,
  };
}

/** Ask a person to decide something on a card. */
export async function requestDecision(
  actor: Actor,
  blipId: string,
  input: RequestDecisionInput,
): Promise<DecisionRequestDto> {
  actor = await writeAsAgent(actor, input.session);
  const [peek] = await getDb()
    .select({ radarId: schema.blips.radarId })
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  if (!peek) throw notFound('Blip not found');
  await requireParticipation(peek.radarId, actor, 'comments');

  const jobs: string[] = [];
  const dto = await getDb().transaction(async (tx) => {
    const [blip] = await tx
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .for('update');
    if (!blip) throw notFound('Blip not found');
    await assertNotCharterPage(tx, blip);
    // Against the radar the card is on now, read under its lock, before the first write.
    const { radar } = await requireParticipation(blip.radarId, actor, 'comments', tx);
    const decides = decidesFor(radar.template, radar.templateConfig);
    if (decides && blip.status !== decides.from)
      throw conflict(
        `This card is no longer in "${decides.from}", so there is nothing left to decide.`,
      );
    const addresseeId = input.addresseeId ?? actor.user.id;
    if (
      addresseeId !== actor.user.id &&
      !(await radarReaders(radar, tx)).some((reader) => reader.id === addresseeId)
    )
      throw badRequest(
        'That person cannot open this radar, so they cannot be asked to decide here.',
      );
    // Where answering moves the card, it needs the write access the move needs (`updateBlip`).
    if (decides) {
      const [person] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, addresseeId))
        .limit(1);
      const reach = person
        ? await getRadarAccess(radar.id, { user: person, kind: 'user' }, tx)
        : null;
      if (!reach?.canWrite)
        throw badRequest(
          'That person can only view this radar. Answering here moves the card, which needs edit access, so they could not answer. Ask someone who can edit it.',
        );
    }

    // One requester's open requests are counted under a lock, so two at once cannot both pass.
    const agentId = actor.agent?.agentId ?? null;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`decision:${actor.user.id}:${agentId ?? ''}`}, 0))`,
    );
    const open = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM decision_requests dr
        JOIN blips b ON b.id = dr.blip_id
        JOIN radars r ON r.id = b.radar_id
       WHERE dr.requester_user_id = ${actor.user.id}
         AND dr.requester_agent_id IS NOT DISTINCT FROM ${agentId}::uuid
         AND ${DECISION_LIVE}`);
    if ((open.rows[0]?.n ?? 0) >= DECISIONS.openPerRequester)
      throw new ApiError(
        429,
        'too_many_open_requests',
        `You already have ${DECISIONS.openPerRequester} questions waiting on a person. Wait for answers before asking more.`,
      );

    const [row] = await tx
      .insert(schema.decisionRequests)
      .values({
        blipId: blip.id,
        radarId: blip.radarId,
        requesterUserId: actor.user.id,
        requesterAgentId: agentId,
        addresseeUserId: addresseeId,
        context: input.context,
        question: input.question,
        options: decides ? decides.outcomes.map((lane) => lane.id) : (input.options ?? []),
        template: radar.template,
        lane: blip.status,
      })
      .returning();
    if (!row) throw new Error('decision request insert returned no row');
    jobs.push(
      await enqueueDecisionEvent(tx, {
        type: 'decision',
        actor,
        radarId: blip.radarId,
        blipId: blip.id,
        requestId: row.id,
      }),
    );
    return present(row, radar, blip.status, actor.agent?.name ?? actor.user.name, actor);
  });
  // A bearer connection's fan-out is left to the worker, like a comment's.
  if (!actor.connection) for (const job of jobs) await drainOne(job);
  return dto;
}

/**
 * The requests on a card, newest first: every one still open and the latest 20 answered, and only
 * while the card is still on the radar they were asked on. `only` reads one request by id (the
 * answer's own response), whatever else the card carries.
 */
export async function listDecisionRequests(
  actor: Actor,
  blipId: string,
  only?: string,
): Promise<DecisionRequestDto[]> {
  const [peek] = await getDb()
    .select({ radarId: schema.blips.radarId })
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  if (!peek) throw notFound('Blip not found');
  const access = await requireRadar(peek.radarId, actor, 'read');
  // Reached through a public link: the radar is published read-only, with no questions on it.
  if (access.role === null || !access.radar.commentsEnabled) return [];
  const dr = schema.decisionRequests;
  const rows = await getDb()
    .select({
      request: dr,
      status: schema.blips.status,
      agentName: schema.agents.name,
      userName: schema.users.name,
    })
    .from(dr)
    .innerJoin(
      schema.blips,
      and(eq(schema.blips.id, dr.blipId), eq(schema.blips.radarId, dr.radarId)),
    )
    .leftJoin(schema.agents, eq(schema.agents.id, dr.requesterAgentId))
    .leftJoin(schema.users, eq(schema.users.id, dr.requesterUserId))
    .where(
      and(
        eq(dr.blipId, blipId),
        eq(schema.blips.radarId, access.radar.id),
        only
          ? eq(dr.id, only)
          : or(
              eq(dr.status, 'open'),
              sql`${dr.id} IN (SELECT q.id FROM decision_requests q JOIN blips qb ON qb.id = q.blip_id AND qb.radar_id = q.radar_id WHERE q.blip_id = ${blipId} AND q.status = 'answered' ORDER BY q.answered_at DESC LIMIT 20)`,
            ),
      ),
    )
    .orderBy(desc(dr.createdAt));
  return rows.map((r) =>
    present(r.request, access.radar, r.status, r.agentName ?? r.userName, actor),
  );
}

/** Answer a request: the addressee's own decision, on a real screen. */
export async function answerDecision(
  actor: Actor,
  blipId: string,
  requestId: string,
  input: AnswerDecisionInput,
): Promise<DecisionRequestDto> {
  assertHumanDecision(
    actor,
    'A question put to a person is answered by that person, in On My Radar.',
  );
  const [found] = await getDb()
    .select({
      request: schema.decisionRequests,
      blipRadarId: schema.blips.radarId,
      revision: schema.blips.revision,
    })
    .from(schema.decisionRequests)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.decisionRequests.blipId))
    .where(
      and(eq(schema.decisionRequests.id, requestId), eq(schema.decisionRequests.blipId, blipId)),
    )
    .limit(1);
  if (!found) throw notFound('Decision request not found');
  const { request } = found;
  // A radar the caller cannot read is a 404; the question itself is only the addressee's to answer.
  const { radar } = await requireRadar(found.blipRadarId, actor, 'read');
  if (request.addresseeUserId !== actor.user.id)
    throw forbidden('This question was put to someone else.');
  // What an answer does is read from the template the question was asked under, and only while
  // the radar still has it; an overtaken question falls through to the claim, which refuses it.
  const decides =
    request.template === radar.template ? decidesFor(radar.template, radar.templateConfig) : null;
  if (decides && !decides.outcomes.some((lane) => lane.id === input.answer))
    throw badRequest(`Answer with one of: ${decides.outcomes.map((lane) => lane.id).join(', ')}.`);

  /*
    The claim: one statement that wins only while the request is open and still live (same card,
    radar, lane and template; comments on). It runs first in the move's own transaction, so a
    lost race or a refused move leaves the request open.
  */
  const claim = async (tx: Pick<Db, 'execute' | 'insert'>): Promise<void> => {
    const claimed = await tx.execute<{ id: string }>(sql`
      UPDATE decision_requests dr
         SET status = 'answered', answer = ${input.answer},
             answered_by_user_id = ${actor.user.id}, answered_at = now()
        FROM blips b, radars r
       WHERE dr.id = ${requestId} AND b.id = dr.blip_id AND r.id = b.radar_id
         AND ${DECISION_LIVE}
       RETURNING dr.id`);
    if (claimed.rows.length === 0)
      throw conflict(
        'That question has already been answered, or the card has moved on since it was asked.',
      );
    // The answer is told to whoever asked, and the question stops waiting on the addressee.
    jobs.push(
      await enqueueDecisionEvent(tx, {
        type: 'decision-answered',
        actor,
        radarId: radar.id,
        blipId,
        requestId,
      }),
    );
    await tx.execute(sql`
      UPDATE notifications SET read_at = now()
       WHERE group_key = ${`decision:${requestId}`} AND read_at IS NULL`);
  };
  const jobs: string[] = [];
  if (decides) {
    // The card as it was when the question was read: a move that landed since refuses this one.
    const patch: UpdateBlipInput = { status: input.answer, expectedRevision: found.revision };
    await updateBlip(actor, blipId, patch, { arbitrate: claim });
  } else {
    await getDb().transaction(claim);
  }
  // A bearer connection's fan-out is left to the worker, like a comment's.
  if (!actor.connection) for (const job of jobs) await drainOne(job);
  const [done] = await listDecisionRequests(actor, blipId, requestId);
  if (!done) throw notFound('Decision request not found');
  return done;
}

/** Native intake: a browser session owns exactly its own requests, never a radar grant. */
import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  supportReplySchema,
  supportRequestSchema,
  templateFor,
  type SupportRequestInput,
  type SupportReplyInput,
  type SupportRequestDto,
  type SupportThreadDto,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, conflict, forbidden, notFound, type Actor } from '../http.js';
import { requireNativeSupport } from './access.js';
import { createBlip } from './blips.js';
import { clientStatusOf, shownAtSql } from './helpdesk-projection.js';
import { recordAudit } from './audit.js';
import { enqueueNotificationEvent } from './notifications.js';
import { enqueueSubscriptionEvent, kickSubscriptionDeliveries } from './subscriptions.js';
import { drainOne } from './outbox.js';
import { setEditor } from './blip-history.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const PAGE_SIZE = 50;
const missing = () => notFound('Support request not found');
/** Pending accounts may read their (empty) list, but only approved accounts post. */
function assertMayPost(requester: { state: string }) {
  if (requester.state !== 'active')
    throw forbidden(
      'Your account is waiting for approval. You can contact support once it is approved.',
    );
}
class Replay extends Error {
  constructor(readonly id: string) {
    super('replayed operation');
  }
}

async function scoped(tx: Tx, actor: Actor | undefined, id: string) {
  const proof = await requireNativeSupport(actor, tx);
  const [row] = await tx
    .select({
      blip: schema.blips,
      request: schema.helpdeskRequests,
      createdExact: sql<string>`${schema.blips.createdAt}::text`,
    })
    .from(schema.helpdeskRequests)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.helpdeskRequests.blipId))
    .where(
      and(
        eq(schema.blips.id, id),
        eq(schema.blips.radarId, proof.access.radar.id),
        eq(schema.helpdeskRequests.origin, 'support'),
        eq(schema.helpdeskRequests.nativeRequesterUserId, proof.requester.id),
      ),
    )
    .limit(1);
  if (!row) throw missing();
  return { ...row, proof };
}

function project(row: Awaited<ReturnType<typeof scoped>>): SupportRequestDto {
  if (!row.request.supportCategory) throw missing();
  return {
    id: row.blip.id,
    title: row.blip.title ?? '',
    body: row.blip.body,
    category: row.request.supportCategory,
    status: clientStatusOf(row.proof.access.radar, row.blip.status),
    createdAt: row.blip.createdAt.toISOString(),
  };
}

export async function listSupport(actor: Actor | undefined, after?: string) {
  return getDb().transaction(async (tx) => {
    const proof = await requireNativeSupport(actor, tx);
    const cursor = after ? await scoped(tx, actor, after) : null;
    const rows = await tx
      .select({
        blip: schema.blips,
        request: schema.helpdeskRequests,
        createdExact: sql<string>`${schema.blips.createdAt}::text`,
      })
      .from(schema.helpdeskRequests)
      .innerJoin(schema.blips, eq(schema.blips.id, schema.helpdeskRequests.blipId))
      .where(
        and(
          eq(schema.blips.radarId, proof.access.radar.id),
          eq(schema.helpdeskRequests.origin, 'support'),
          eq(schema.helpdeskRequests.nativeRequesterUserId, proof.requester.id),
          cursor
            ? sql`(${schema.blips.createdAt}, ${schema.blips.id}) > (${cursor.createdExact}::timestamptz, ${cursor.blip.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(schema.blips.createdAt), asc(schema.blips.id))
      .limit(PAGE_SIZE + 1);
    const picked = rows.slice(0, PAGE_SIZE);
    return {
      requests: picked.map((row) => project({ ...row, proof })),
      next: rows.length > PAGE_SIZE ? (picked.at(-1)?.blip.id ?? null) : null,
    };
  });
}

export async function getSupport(
  actor: Actor | undefined,
  id: string,
  after?: string,
): Promise<SupportThreadDto> {
  return getDb().transaction(async (tx) => {
    const row = await scoped(tx, actor, id);
    let cursor: { shown: string; id: string } | undefined;
    if (after) {
      const [comment] = await tx
        .select({ id: schema.blipComments.id, shown: sql<string>`(${shownAtSql})::text` })
        .from(schema.blipComments)
        .where(
          and(
            eq(schema.blipComments.id, after),
            eq(schema.blipComments.blipId, id),
            eq(schema.blipComments.visibility, 'client'),
          ),
        );
      if (!comment) throw missing();
      cursor = comment;
    }
    const comments = await tx
      .select()
      .from(schema.blipComments)
      .where(
        and(
          eq(schema.blipComments.blipId, id),
          eq(schema.blipComments.visibility, 'client'),
          cursor
            ? sql`(${shownAtSql}, ${schema.blipComments.id}) > (${cursor.shown}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(shownAtSql), asc(schema.blipComments.id))
      .limit(PAGE_SIZE + 1);
    const picked = comments.slice(0, PAGE_SIZE);
    return {
      request: project(row),
      replies: picked.map((comment) => ({
        id: comment.id,
        from: comment.externalAuthor ? 'you' : 'support',
        body: comment.body,
        createdAt: (comment.releasedAt ?? comment.createdAt).toISOString(),
      })),
      next: comments.length > PAGE_SIZE ? (picked.at(-1)?.id ?? null) : null,
    };
  });
}

async function operation(tx: Tx, userId: string, operationId: string, hash: string) {
  // Concurrent retries and different operations from one requester serialize: the
  // transaction-scoped lock is held until the insert commits, so count-then-insert is
  // atomic per requester (READ COMMITTED re-snapshots the count after the lock).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`support:${userId}`}, 0))`);
  const [seen] = await tx
    .select()
    .from(schema.supportOperations)
    .where(
      and(
        eq(schema.supportOperations.userId, userId),
        eq(schema.supportOperations.operationId, operationId),
      ),
    );
  if (seen) {
    if (seen.payloadHash !== hash)
      throw conflict('That operation reference was used for different text.');
    throw new Replay(seen.requestId);
  }
  const [window] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.supportOperations)
    .where(
      and(
        eq(schema.supportOperations.userId, userId),
        sql`${schema.supportOperations.createdAt} > now() - interval '1 hour'`,
      ),
    );
  if ((window?.count ?? 0) >= 10)
    throw new ApiError(
      429,
      'rate_limited',
      'You have sent several requests or replies. Try again in an hour.',
    );
}
function digest(kind: string, input: unknown) {
  return createHash('sha256').update(JSON.stringify({ kind, input })).digest('hex');
}

export async function createSupport(actor: Actor | undefined, raw: SupportRequestInput) {
  const input = supportRequestSchema.parse(raw);
  const proof = await requireNativeSupport(actor);
  if (!actor) throw new ApiError(401, 'unauthorized', 'Sign in to contact support.');
  assertMayPost(proof.requester);
  const hash = digest('request', input);
  let id: string;
  try {
    const lane = templateFor(
      proof.access.radar.template,
      proof.access.radar.templateConfig,
    ).statuses.find((status) => status.clientStatus === 'received');
    const blip = await createBlip(
      actor,
      proof.access.radar.id,
      { title: input.title, body: input.body, ...(lane ? { status: lane.id } : {}) },
      {
        nativeSupport: proof,
        authored: false,
        beforeInsert: async (tx) => {
          await operation(tx, proof.requester.id, input.operationId, hash);
        },
        afterInsert: async (tx, blipId) => {
          const current = await requireNativeSupport(actor, tx);
          assertMayPost(current.requester);
          await tx.insert(schema.helpdeskRequests).values({
            blipId,
            origin: 'support',
            nativeRequesterUserId: current.requester.id,
            supportCategory: input.category,
            requesterRef: current.requester.id,
            requesterAccountRef: current.requester.id,
            requesterName: current.requester.name ?? 'Requester',
            requesterEmail: current.requester.email,
          });
          await tx.insert(schema.supportOperations).values({
            userId: current.requester.id,
            operationId: input.operationId,
            payloadHash: hash,
            requestId: blipId,
          });
        },
      },
    );
    id = blip.id;
  } catch (error) {
    if (!(error instanceof Replay)) throw error;
    id = error.id;
  }
  return (await getSupport(actor, id)).request;
}

export async function replySupport(actor: Actor | undefined, id: string, raw: SupportReplyInput) {
  const input = supportReplySchema.parse(raw);
  const hash = digest(`reply:${id}`, input);
  const jobs: string[] = [];
  let commentId: string | undefined;
  try {
    await getDb().transaction(async (tx) => {
      const row = await scoped(tx, actor, id);
      assertMayPost(row.proof.requester);
      await operation(tx, row.proof.requester.id, input.operationId, hash);
      const [blip] = await tx
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.id, id))
        .for('update');
      if (!blip || blip.radarId !== row.proof.access.radar.id) throw missing();
      const [comment] = await tx
        .insert(schema.blipComments)
        .values({
          blipId: id,
          radarId: blip.radarId,
          authorId: null,
          body: input.body,
          visibility: 'client',
          externalAuthor: {
            via: 'support',
            ref: row.proof.requester.id,
            accountRef: row.proof.requester.id,
            name: row.proof.requester.name ?? 'Requester',
            email: row.proof.requester.email,
          },
        })
        .returning();
      const status = clientStatusOf(row.proof.access.radar, blip.status);
      const next = templateFor(
        row.proof.access.radar.template,
        row.proof.access.radar.templateConfig,
      ).statuses.find((lane) => lane.clientStatus === 'in_progress');
      if (next && (status === 'waiting_on_you' || status === 'resolved')) {
        if (actor) await setEditor(tx, actor.user.id, null);
        const [moved] = await tx
          .update(schema.blips)
          .set({ status: next.id, state: next.state, updatedAt: new Date() })
          .where(eq(schema.blips.id, id))
          .returning();
        if (moved && actor)
          await enqueueSubscriptionEvent(
            tx,
            actor,
            row.proof.access.radar,
            'blip.updated',
            moved,
            blip,
          );
      }
      await tx.insert(schema.supportOperations).values({
        userId: row.proof.requester.id,
        operationId: input.operationId,
        payloadHash: hash,
        requestId: id,
      });
      if (comment && actor) {
        commentId = comment.id;
        jobs.push(
          await enqueueNotificationEvent(tx, {
            type: 'comment',
            actor,
            radarId: blip.radarId,
            blipId: id,
            commentId: comment.id,
            body: input.body,
            mentioned: [],
          }),
        );
        await enqueueSubscriptionEvent(
          tx,
          actor,
          row.proof.access.radar,
          'comment.created',
          blip,
          undefined,
          comment,
        );
      }
    });
  } catch (error) {
    if (!(error instanceof Replay)) throw error;
  }
  if (commentId && actor) {
    await recordAudit(actor, 'comment.create', 'comment', commentId, {
      blipId: id,
      visibility: 'client',
    });
    kickSubscriptionDeliveries();
    for (const job of jobs) await drainOne(job);
  }
  return getSupport(actor, id);
}

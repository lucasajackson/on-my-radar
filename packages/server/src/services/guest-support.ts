/** A guest capability proves possession of one thread, never an account. */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  guestSupportRequestSchema,
  supportReplySchema,
  templateFor,
  type GuestSupportRequestInput,
  type SupportReplyInput,
  type GuestSupportThreadDto,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { conflict, notFound, tooManyRequests, type Actor } from '../http.js';
import { requireGuestSupportQueue, assertHumanDecision } from './access.js';
import { createBlip } from './blips.js';
import { clientStatusOf, shownAtSql } from './helpdesk-projection.js';
import { enqueueNotificationEvent } from './notifications.js';
import { enqueueSubscriptionEvent, kickSubscriptionDeliveries } from './subscriptions.js';
import { recordAudit } from './audit.js';
import { drainOne } from './outbox.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const PAGE = 50;
const unknown = () =>
  notFound('Support conversation unavailable. Use a saved recovery code or start a new request.');
const secret = () => randomBytes(32).toString('base64url');
export const guestSecretHash = (value: string) => createHash('sha256').update(value).digest('hex');
const validSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
class Replay extends Error {}

/** Fixed windows are atomic, bounded by network AND instance, and retain no raw IP. */
export async function chargeGuestSupport(key: string, maximum: number, seconds: number) {
  const result = await getDb().execute<{ count: number }>(sql`
    INSERT INTO guest_support_limits(key, window_started_at, count) VALUES (${key}, now(), 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN guest_support_limits.window_started_at <= now() - make_interval(secs => ${seconds}) THEN 1 ELSE LEAST(guest_support_limits.count + 1, ${maximum + 1}) END,
      window_started_at = CASE WHEN guest_support_limits.window_started_at <= now() - make_interval(secs => ${seconds}) THEN now() ELSE guest_support_limits.window_started_at END
    RETURNING count`);
  const row = result.rows[0];
  if (!row || row.count > maximum)
    throw tooManyRequests(
      'Support is receiving several requests. Keep your text and try again later.',
      seconds,
    );
}
/** Cheap existence probe so callers can refuse unknown tokens before charging shared limits. */
export async function guestCapabilityLive(token: string): Promise<boolean> {
  if (!validSecret(token)) return false;
  const [cap] = await getDb()
    .select({ id: schema.guestSupportCapabilities.id })
    .from(schema.guestSupportCapabilities)
    .where(
      and(
        eq(schema.guestSupportCapabilities.tokenHash, guestSecretHash(token)),
        sql`${schema.guestSupportCapabilities.revokedAt} IS NULL`,
        sql`${schema.guestSupportCapabilities.expiresAt} > now()`,
      ),
    );
  return Boolean(cap);
}
/**
 * Per-network buckets are charged FIRST so one source exhausts only its own allowance;
 * the global bucket is a backstop that only admitted traffic can spend.
 */
async function chargeNetworkThenGlobal(
  kind: string,
  network: string | null,
  perHour: number,
  perDay: number,
  globalPerHour: number,
) {
  if (network) {
    const source = guestSecretHash(network);
    await chargeGuestSupport(`${kind}:${source}`, perHour, 3600);
    await chargeGuestSupport(`${kind}-day:${source}`, perDay, 86400);
  }
  await chargeGuestSupport(`${kind}:global`, globalPerHour, 3600);
}
/** Writes across every link from one network; per-link limits alone let one IP mint many links. */
async function chargeGuestWrite(network: string | null) {
  if (!network) return;
  const source = guestSecretHash(network);
  await chargeGuestSupport(`write:${source}`, 30, 3600);
  await chargeGuestSupport(`write-day:${source}`, 100, 86400);
}
export async function startGuestSupport(network: string | null) {
  await chargeNetworkThenGlobal('network', network, 5, 20, 100);
  return getDb().transaction(async (tx) => {
    const proof = await requireGuestSupportQueue(tx);
    const token = secret();
    const recoveryCode = secret();
    const [created] = await tx
      .insert(schema.guestSupportCapabilities)
      .values({
        radarId: proof.access.radar.id,
        ownerId: proof.actor.user.id,
        tokenHash: guestSecretHash(token),
        recoveryHash: guestSecretHash(recoveryCode),
        expiresAt: sql`now() + interval '720 hours'`,
      })
      .returning();
    if (!created) throw new Error('Guest support capability insert failed');
    return { token, recoveryCode, expiresAt: created.expiresAt.toISOString() };
  });
}
async function scope(tx: Tx, token: string, recovery = false) {
  if (!validSecret(token)) throw unknown();
  const [cap] = await tx
    .select()
    .from(schema.guestSupportCapabilities)
    .where(
      and(
        eq(
          recovery
            ? schema.guestSupportCapabilities.recoveryHash
            : schema.guestSupportCapabilities.tokenHash,
          guestSecretHash(token),
        ),
        sql`${schema.guestSupportCapabilities.revokedAt} IS NULL`,
        sql`${schema.guestSupportCapabilities.expiresAt} > now()`,
      ),
    )
    .for('update');
  if (!cap) throw unknown();
  const proof = await requireGuestSupportQueue(tx);
  if (cap.radarId !== proof.access.radar.id || cap.ownerId !== proof.actor.user.id) throw unknown();
  return { cap, proof };
}
async function request(tx: Tx, capabilityId: string, radarId: string) {
  const [row] = await tx
    .select({ blip: schema.blips, request: schema.helpdeskRequests })
    .from(schema.helpdeskRequests)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.helpdeskRequests.blipId))
    .where(
      and(
        eq(schema.helpdeskRequests.guestCapabilityId, capabilityId),
        eq(schema.helpdeskRequests.origin, 'guest'),
        eq(schema.blips.radarId, radarId),
      ),
    );
  return row;
}
export async function getGuestSupport(
  token: string,
  after?: string,
): Promise<GuestSupportThreadDto> {
  return getDb().transaction(async (tx) => {
    const { cap, proof } = await scope(tx, token);
    const row = await request(tx, cap.id, proof.access.radar.id);
    if (!row) return { thread: null, expiresAt: cap.expiresAt.toISOString() };
    let cursor: { shown: string; id: string } | undefined;
    if (after) {
      const [found] = await tx
        .select({ id: schema.blipComments.id, shown: sql<string>`(${shownAtSql})::text` })
        .from(schema.blipComments)
        .where(
          and(
            eq(schema.blipComments.id, after),
            eq(schema.blipComments.blipId, row.blip.id),
            eq(schema.blipComments.visibility, 'client'),
          ),
        );
      if (!found) throw unknown();
      cursor = found;
    }
    const comments = await tx
      .select()
      .from(schema.blipComments)
      .where(
        and(
          eq(schema.blipComments.blipId, row.blip.id),
          eq(schema.blipComments.visibility, 'client'),
          cursor
            ? sql`(${shownAtSql}, ${schema.blipComments.id}) > (${cursor.shown}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(shownAtSql), asc(schema.blipComments.id))
      .limit(PAGE + 1);
    const picked = comments.slice(0, PAGE);
    if (!row.request.supportCategory) throw unknown();
    return {
      expiresAt: cap.expiresAt.toISOString(),
      thread: {
        request: {
          id: row.blip.id,
          category: row.request.supportCategory,
          title: row.blip.title ?? '',
          body: row.blip.body,
          status: clientStatusOf(proof.access.radar, row.blip.status),
          createdAt: row.blip.createdAt.toISOString(),
        },
        replies: picked.map((c) => ({
          id: c.id,
          from: c.externalAuthor ? 'you' : 'support',
          body: c.body,
          createdAt: (c.releasedAt ?? c.createdAt).toISOString(),
        })),
        next: comments.length > PAGE ? (picked.at(-1)?.id ?? null) : null,
      },
    };
  });
}
async function operation(tx: Tx, capabilityId: string, operationId: string, payload: unknown) {
  const hash = guestSecretHash(JSON.stringify(payload));
  const [old] = await tx
    .select()
    .from(schema.guestSupportOperations)
    .where(
      and(
        eq(schema.guestSupportOperations.capabilityId, capabilityId),
        eq(schema.guestSupportOperations.operationId, operationId),
      ),
    );
  if (old) {
    if (old.payloadHash !== hash)
      throw conflict('That operation reference was used for different text.');
    throw new Replay();
  }
  const [window] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.guestSupportOperations)
    .where(
      and(
        eq(schema.guestSupportOperations.capabilityId, capabilityId),
        sql`${schema.guestSupportOperations.createdAt} > now() - interval '1 hour'`,
      ),
    );
  if ((window?.count ?? 0) >= 10)
    throw tooManyRequests('Keep your reply and try again in an hour.', 3600);
  return hash;
}
export async function createGuestSupport(
  token: string,
  raw: GuestSupportRequestInput,
  network: string | null = null,
) {
  const input = guestSupportRequestSchema.parse(raw);
  await chargeGuestWrite(network);
  const initial = await getDb().transaction((tx) => scope(tx, token));
  const lane = templateFor(
    initial.proof.access.radar.template,
    initial.proof.access.radar.templateConfig,
  ).statuses.find((s) => s.clientStatus === 'received');
  try {
    await createBlip(
      initial.proof.actor,
      initial.proof.access.radar.id,
      { title: input.title, body: input.body, ...(lane ? { status: lane.id } : {}) },
      {
        guestSupport: initial.proof,
        authored: false,
        beforeInsert: async (tx) => {
          const current = await scope(tx, token);
          await operation(tx, current.cap.id, input.operationId, { kind: 'request', input });
          if (await request(tx, current.cap.id, current.cap.radarId))
            throw conflict(
              'This capability already has a request. Reply to that conversation instead.',
            );
        },
        afterInsert: async (tx, blipId) => {
          const current = await scope(tx, token);
          await tx.insert(schema.helpdeskRequests).values({
            blipId,
            origin: 'guest',
            guestCapabilityId: current.cap.id,
            supportCategory: input.category,
            requesterRef: current.cap.id,
            requesterAccountRef: current.cap.id,
            requesterName: 'Signed-out requester (identity unverified)',
            requesterEmail: input.email ?? '',
          });
          await tx.insert(schema.guestSupportOperations).values({
            capabilityId: current.cap.id,
            operationId: input.operationId,
            payloadHash: guestSecretHash(JSON.stringify({ kind: 'request', input })),
            requestId: blipId,
          });
        },
      },
    );
  } catch (error) {
    if (!(error instanceof Replay)) throw error;
  }
  return getGuestSupport(token);
}
export async function replyGuestSupport(
  token: string,
  raw: SupportReplyInput,
  network: string | null = null,
) {
  const input = supportReplySchema.parse(raw);
  await chargeGuestWrite(network);
  const jobs: string[] = [];
  try {
    await getDb().transaction(async (tx) => {
      const { cap, proof } = await scope(tx, token);
      const row = await request(tx, cap.id, cap.radarId);
      if (!row) throw unknown();
      const hash = await operation(tx, cap.id, input.operationId, { kind: 'reply', input });
      const [blip] = await tx
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.id, row.blip.id))
        .for('update');
      if (!blip) throw unknown();
      const [comment] = await tx
        .insert(schema.blipComments)
        .values({
          blipId: blip.id,
          radarId: cap.radarId,
          authorId: null,
          body: input.body,
          visibility: 'client',
          externalAuthor: {
            via: 'guest',
            ref: cap.id,
            accountRef: cap.id,
            name: row.request.requesterName,
            email: row.request.requesterEmail,
          },
        })
        .returning();
      const current = clientStatusOf(proof.access.radar, blip.status);
      const next = templateFor(
        proof.access.radar.template,
        proof.access.radar.templateConfig,
      ).statuses.find((l) => l.clientStatus === 'in_progress');
      if (next && (current === 'resolved' || current === 'waiting_on_you')) {
        // The client's reply moves it: they are no user, so no editor is recorded.
        const [moved] = await tx
          .update(schema.blips)
          .set({ status: next.id, state: next.state, updatedAt: new Date() })
          .where(eq(schema.blips.id, blip.id))
          .returning();
        if (moved)
          await enqueueSubscriptionEvent(
            tx,
            proof.actor,
            proof.access.radar,
            'blip.updated',
            moved,
            blip,
          );
      }
      await tx.insert(schema.guestSupportOperations).values({
        capabilityId: cap.id,
        operationId: input.operationId,
        payloadHash: hash,
        requestId: blip.id,
      });
      if (comment) {
        jobs.push(
          await enqueueNotificationEvent(tx, {
            type: 'comment',
            actor: proof.actor,
            radarId: cap.radarId,
            blipId: blip.id,
            commentId: comment.id,
            body: input.body,
            mentioned: [],
          }),
        );
        await enqueueSubscriptionEvent(
          tx,
          proof.actor,
          proof.access.radar,
          'comment.created',
          blip,
          undefined,
          comment,
        );
        await recordAudit(
          proof.actor,
          'comment.create',
          'comment',
          comment.id,
          { blipId: blip.id, visibility: 'client' },
          tx,
        );
      }
    });
  } catch (error) {
    if (!(error instanceof Replay)) throw error;
  }
  kickSubscriptionDeliveries();
  for (const job of jobs) await drainOne(job);
  return getGuestSupport(token);
}
export async function recoverGuestSupport(recoveryCode: string, network: string | null) {
  await chargeNetworkThenGlobal('recovery', network, 10, 30, 100);
  return getDb().transaction(async (tx) => {
    const { cap } = await scope(tx, recoveryCode, true);
    const token = secret();
    await tx
      .update(schema.guestSupportCapabilities)
      .set({ tokenHash: guestSecretHash(token) })
      .where(eq(schema.guestSupportCapabilities.id, cap.id));
    return { token, expiresAt: cap.expiresAt.toISOString() };
  });
}
export async function revokeGuestSupport(token: string) {
  await getDb().transaction(async (tx) => {
    const { cap } = await scope(tx, token);
    await tx
      .update(schema.guestSupportCapabilities)
      .set({ revokedAt: new Date() })
      .where(eq(schema.guestSupportCapabilities.id, cap.id));
  });
}
export async function revokeGuestSupportAsStaff(actor: Actor, requestId: string) {
  assertHumanDecision(actor, 'revoke a guest support link');
  await getDb().transaction(async (tx) => {
    const proof = await requireGuestSupportQueue(tx);
    if (actor.user.id !== proof.actor.user.id || actor.kind !== 'user' || !actor.sessionId)
      throw unknown();
    const [session] = await tx
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, actor.sessionId),
          eq(schema.sessions.userId, actor.user.id),
          sql`${schema.sessions.expiresAt} > now()`,
        ),
      );
    if (!session) throw unknown();
    const [row] = await tx
      .select()
      .from(schema.helpdeskRequests)
      .innerJoin(schema.blips, eq(schema.blips.id, schema.helpdeskRequests.blipId))
      .where(
        and(
          eq(schema.helpdeskRequests.blipId, requestId),
          eq(schema.helpdeskRequests.origin, 'guest'),
          eq(schema.blips.radarId, proof.access.radar.id),
        ),
      );
    const capId = row?.helpdesk_requests.guestCapabilityId;
    if (!capId) throw unknown();
    await tx
      .update(schema.guestSupportCapabilities)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.guestSupportCapabilities.id, capId),
          sql`${schema.guestSupportCapabilities.revokedAt} IS NULL`,
        ),
      );
    await recordAudit(actor, 'support.guest.revoke', 'blip', requestId, {}, tx);
  });
}

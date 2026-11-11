/**
 * The portal's view of a helpdesk: the client projection (`docs/HELPDESK.md` §5).
 *
 * Every function here takes an `integration` actor and reaches a radar only
 * through `requireHelpdeskRadar`. Nothing here is on MCP: the only caller class
 * is refused there (§3.3).
 *
 * ## Isolation is by integration and client account, on every call (T1)
 *
 * The radar is not the boundary; the portal's account is, within the
 * integration that filed the request. Every `/requests` call carries the
 * account it acts for (`X-OMR-Requester-Scope`), and a request filed under any
 * other account, or through any other integration, is a 404 identical to one
 * that does not exist. Account ids are the portal's own, so two portals (a
 * staging and a production one) enrolled on the same radar are two
 * namespaces: `acct-1` in one is not `acct-1` in the other. A request is filed
 * with the account the portal asserted, which must equal the scope, and a
 * trigger keeps it that way for life.
 *
 * ## The projection is a whitelist (T2)
 *
 * The DTOs below are built field by field from the blip, its request row and
 * its client-visible comments. Tags, triage state, the lane and its label,
 * pinning, email notes, internal and pending comments (and how many there
 * are), agent identity, author ids and the radar's name never appear because
 * nothing here reads them into a response. A canary test seeds each of them and
 * asserts it is absent from every response.
 *
 * ## Writes
 *
 * A request is a blip created through `createBlip` with the proof from
 * `requireHelpdeskRadar`, so it gets the lane, notifications, the owner's own
 * subscriptions and the audit row exactly as any capture does. A client's
 * reply is a `client` comment with no OMR author and the requester in
 * `external_author`. Both are idempotent per `Idempotency-Key` and limited per
 * client account (§5.1).
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  HELPDESK_LIMITS,
  NUL_REFUSAL,
  templateFor,
  type ClientStatus,
  type CreateHelpdeskReplyInput,
  type CreateHelpdeskRequestInput,
  type ExternalAuthor,
  type HelpdeskRadarDto,
  type HelpdeskRequestDto,
  type HelpdeskRequestSummaryDto,
  type HelpdeskThreadItemDto,
  type ListHelpdeskRequestsQuery,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, conflict, notFound, type Actor } from '../http.js';
import { requireHelpdeskRadar, type HelpdeskAccess } from './access.js';
import { recordAudit } from './audit.js';
import { createBlip } from './blips.js';
import { decodeCursor, encodeCursor, isCursorTimestamp, isCursorUuid } from './cursor.js';
import { clientHtml, clientStatusOf, shownAtSql, threadClocks } from './helpdesk-projection.js';
import { enqueueNotificationEvent } from './notifications.js';
import { drainOne } from './outbox.js';
import { enqueueSubscriptionEvent, kickSubscriptionDeliveries } from './subscriptions.js';

type IntegrationActor = Actor & { integrationId: string };
type BlipRow = typeof schema.blips.$inferSelect;
type RequestRow = typeof schema.helpdeskRequests.$inferSelect;
type CommentRow = typeof schema.blipComments.$inferSelect;

const REQUEST_NOT_FOUND = 'Request not found';

/* --------------------------------- limits --------------------------------- */

function rateLimited(message: string): ApiError {
  return new ApiError(429, 'rate_limited', message);
}

/**
 * Count this call against the integration's per-minute window, rolled and
 * counted in one statement as a webhook's is (`services/webhooks.ts`).
 */
export async function consumeIntegrationCall(integrationId: string): Promise<void> {
  const result = await getDb().execute<{ window_count: number }>(sql`
    UPDATE integrations
       SET window_started_at = CASE
             WHEN window_started_at < now() - interval '1 minute' THEN now()
             ELSE window_started_at END,
           window_count = CASE
             WHEN window_started_at < now() - interval '1 minute' THEN 1
             ELSE window_count + 1 END
     WHERE id = ${integrationId}::uuid
     RETURNING window_count`);
  const count = result.rows[0]?.window_count ?? 0;
  if (count > HELPDESK_LIMITS.integrationPerMinute) {
    throw rateLimited('Too many calls from this integration. Try again in a minute.');
  }
}

/** One write (a request or a reply) against this client account's hourly window. */
async function consumeScopeWrite(integrationId: string, scope: string): Promise<void> {
  const result = await getDb().execute<{ window_count: number }>(sql`
    INSERT INTO integration_scope_windows (integration_id, scope, window_started_at, window_count)
    VALUES (${integrationId}::uuid, ${scope}, now(), 1)
    ON CONFLICT (integration_id, scope) DO UPDATE SET
      window_started_at = CASE
        WHEN integration_scope_windows.window_started_at < now() - interval '1 hour' THEN now()
        ELSE integration_scope_windows.window_started_at END,
      window_count = CASE
        WHEN integration_scope_windows.window_started_at < now() - interval '1 hour' THEN 1
        ELSE integration_scope_windows.window_count + 1 END
    RETURNING window_count`);
  const count = result.rows[0]?.window_count ?? 0;
  if (count > HELPDESK_LIMITS.scopeWritesPerHour) {
    throw rateLimited('Too many requests and replies from this client account. Try again later.');
  }
}

/** The requester scope header, validated. Missing or malformed is a 400. */
export function requesterScope(raw: string | undefined): string {
  const scope = raw?.trim();
  if (!scope)
    throw badRequest('X-OMR-Requester-Scope is required: the portal account this call acts for.');
  if (scope.length > HELPDESK_LIMITS.ref) throw badRequest('X-OMR-Requester-Scope is too long.');
  if (scope.includes('\u0000')) throw badRequest(NUL_REFUSAL);
  return scope;
}

function assertRequesterInScope(requester: { accountRef: string }, scope: string): void {
  if (requester.accountRef !== scope) {
    throw badRequest('requester.accountRef must equal X-OMR-Requester-Scope.');
  }
}

/* ------------------------------ idempotency ------------------------------- */

export function validIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > HELPDESK_LIMITS.idempotencyKey) {
    throw badRequest(`Idempotency-Key must be 1–${HELPDESK_LIMITS.idempotencyKey} characters.`);
  }
  if (key.includes('\u0000')) throw badRequest(NUL_REFUSAL);
  return key;
}

function requestHash(route: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([route, body]), 'utf8')
    .digest('hex');
}

/** A key this integration already used, within the window. A different request under it is a 409. */
async function seenKey(
  integrationId: string,
  key: string,
  hash: string,
): Promise<{ resourceId: string } | null> {
  const [row] = await getDb()
    .select()
    .from(schema.integrationIdempotency)
    .where(
      and(
        eq(schema.integrationIdempotency.integrationId, integrationId),
        eq(schema.integrationIdempotency.key, key),
        sql`${schema.integrationIdempotency.createdAt} > now() - make_interval(hours => ${HELPDESK_LIMITS.idempotencyHours})`,
      ),
    );
  if (!row) return null;
  if (row.requestSha256 !== hash) {
    throw conflict('This Idempotency-Key was already used for a different request.');
  }
  return { resourceId: row.resourceId };
}

class KeyRace extends Error {}

/**
 * Record the key in the write's own transaction. A concurrent twin that got
 * there first makes the insert do nothing; this write then rolls back and the
 * caller replays the twin's result, so one key is one write however the two
 * calls interleave.
 */
async function rememberKey(
  tx: Pick<Db, 'execute'>,
  integrationId: string,
  key: string,
  hash: string,
  resourceId: string,
  status: number,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM integration_idempotency
     WHERE integration_id = ${integrationId}::uuid AND key = ${key}
       AND created_at <= now() - make_interval(hours => ${HELPDESK_LIMITS.idempotencyHours})`);
  const inserted = await tx.execute(sql`
    INSERT INTO integration_idempotency (integration_id, key, request_sha256, resource_id, status)
    VALUES (${integrationId}::uuid, ${key}, ${hash}, ${resourceId}::uuid, ${status})
    ON CONFLICT (integration_id, key) DO NOTHING
    RETURNING key`);
  if (inserted.rows.length === 0) throw new KeyRace();
}

/** Worker sweep: keys past their window. Bounded per run. */
export async function purgeExpiredIdempotencyKeys(batchSize = 1_000): Promise<number> {
  const result = await getDb().execute(sql`
    WITH picked AS (
      SELECT integration_id, key FROM integration_idempotency
       WHERE created_at < now() - make_interval(hours => ${HELPDESK_LIMITS.idempotencyHours})
       LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM integration_idempotency t USING picked
     WHERE t.integration_id = picked.integration_id AND t.key = picked.key`);
  return result.rowCount ?? 0;
}

/* -------------------------------- projection ------------------------------ */

function toSummary(
  blip: BlipRow,
  request: RequestRow,
  radar: HelpdeskAccess['access']['radar'],
  clock: { lastReplyAt: Date | null; awaitingClientSince: Date | null } | undefined,
): HelpdeskRequestSummaryDto {
  const lastReplyAt = clock?.lastReplyAt ?? null;
  const updatedAt = lastReplyAt && lastReplyAt > blip.createdAt ? lastReplyAt : blip.createdAt;
  return {
    id: blip.id,
    radarId: blip.radarId,
    // A portal request always has a title; a blank one is shown as the start of the body.
    title: blip.title ?? blip.body.slice(0, HELPDESK_LIMITS.title),
    clientStatus: clientStatusOf(radar, blip.status),
    requester: { ref: request.requesterRef, name: request.requesterName },
    createdAt: blip.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    lastReplyAt: lastReplyAt?.toISOString() ?? null,
    awaitingClientSince: clock?.awaitingClientSince?.toISOString() ?? null,
  };
}

function toRequest(
  blip: BlipRow,
  request: RequestRow,
  radar: HelpdeskAccess['access']['radar'],
  clock: { lastReplyAt: Date | null; awaitingClientSince: Date | null } | undefined,
): HelpdeskRequestDto {
  return {
    ...toSummary(blip, request, radar, clock),
    body: blip.body,
    bodyHtml: clientHtml(blip.body),
    attachments: [],
  };
}

function toThreadItem(row: CommentRow, staffName: string): HelpdeskThreadItemDto {
  const external = row.externalAuthor;
  return {
    id: row.id,
    from: external ? 'client' : 'staff',
    authorName: external ? external.name : staffName,
    body: row.body,
    bodyHtml: clientHtml(row.body),
    createdAt: (row.releasedAt ?? row.createdAt).toISOString(),
  };
}

/**
 * A request this integration may see under this scope, or a 404 that says
 * nothing about which test failed: no such blip, not a portal request, not on a
 * radar the integration reaches, or another account's.
 */
async function requestInScope(
  actor: IntegrationActor,
  requestId: string,
  scope: string,
  db: Pick<Db, 'select'> = getDb(),
): Promise<{ blip: BlipRow; request: RequestRow; helpdesk: HelpdeskAccess }> {
  const [row] = await db
    .select({ blip: schema.blips, request: schema.helpdeskRequests })
    .from(schema.helpdeskRequests)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.helpdeskRequests.blipId))
    .where(eq(schema.helpdeskRequests.blipId, requestId))
    .limit(1);
  if (!row) throw notFound(REQUEST_NOT_FOUND);
  // Filed through another integration: a staging portal and the production one
  // may both reach this radar, and their account ids are separate namespaces.
  if (row.request.integrationId !== actor.integrationId) throw notFound(REQUEST_NOT_FOUND);
  if (row.request.requesterAccountRef !== scope) throw notFound(REQUEST_NOT_FOUND);
  let helpdesk: HelpdeskAccess;
  try {
    helpdesk = await requireHelpdeskRadar(row.blip.radarId, actor, db as Db);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound(REQUEST_NOT_FOUND);
    throw err;
  }
  return { blip: row.blip, request: row.request, helpdesk };
}

/* ---------------------------------- reads --------------------------------- */

/**
 * The radars this integration reaches right now, for the portal admin's
 * picker. Each passes `requireHelpdeskRadar` today, not merely has a row.
 */
export async function listHelpdeskRadars(
  actor: IntegrationActor,
): Promise<{ integration: { id: string; name: string }; radars: HelpdeskRadarDto[] }> {
  const [integration] = await getDb()
    .select({ id: schema.integrations.id, name: schema.integrations.name })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, actor.integrationId));
  if (!integration) throw notFound('Integration not found');
  const enrolments = await getDb()
    .select()
    .from(schema.integrationRadars)
    .where(
      and(
        eq(schema.integrationRadars.integrationId, actor.integrationId),
        isNull(schema.integrationRadars.revokedAt),
      ),
    )
    .orderBy(asc(schema.integrationRadars.enrolledAt));
  const radars: HelpdeskRadarDto[] = [];
  for (const enrolment of enrolments) {
    try {
      const { access } = await requireHelpdeskRadar(enrolment.radarId, actor);
      radars.push({
        id: access.radar.id,
        name: access.radar.name,
        externalRef: enrolment.externalRef,
      });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  return { integration, radars };
}

/** A keyset cursor over (time, id), built in Postgres as text so microseconds survive. */
function readCursor(raw: string): { at: string; id: string } {
  const cursor = decodeCursor(raw);
  const at = cursor?.['at'];
  const id = cursor?.['id'];
  if (!isCursorTimestamp(at) || !isCursorUuid(id)) throw badRequest('Invalid cursor');
  return { at, id };
}

const lastClientReply = sql`(
  SELECT max(${shownAtSql}) FROM blip_comments
   WHERE blip_comments.blip_id = ${schema.blips.id} AND blip_comments.visibility = 'client'
)`;
const activityExpr = sql`GREATEST(${schema.blips.createdAt}, COALESCE(${lastClientReply}, ${schema.blips.createdAt}))`;

export async function listHelpdeskRequests(
  actor: IntegrationActor,
  radarId: string,
  scope: string,
  query: ListHelpdeskRequestsQuery,
): Promise<{ items: HelpdeskRequestSummaryDto[]; nextCursor: string | null }> {
  const helpdesk = await requireHelpdeskRadar(radarId, actor);
  const radar = helpdesk.access.radar;
  const limit = query.limit ?? HELPDESK_LIMITS.listPage;
  const clauses: SQL[] = [
    eq(schema.blips.radarId, radar.id),
    eq(schema.helpdeskRequests.integrationId, actor.integrationId),
    eq(schema.helpdeskRequests.requesterAccountRef, scope),
  ];
  if (query.status) {
    const wanted: ClientStatus = query.status;
    const lanes = templateFor(radar.template, radar.templateConfig)
      .statuses.filter((lane) => lane.clientStatus === wanted)
      .map((lane) => lane.id);
    const known = templateFor(radar.template, radar.templateConfig).statuses.map((l) => l.id);
    // `received` is also what a blip on no known lane shows (clientStatusOf).
    const parts: SQL[] = [];
    if (lanes.length > 0)
      parts.push(
        sql`${schema.blips.status} IN (${sql.join(
          lanes.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    if (wanted === 'received')
      parts.push(
        known.length > 0
          ? sql`(${schema.blips.status} IS NULL OR ${schema.blips.status} NOT IN (${sql.join(
              known.map((id) => sql`${id}`),
              sql`, `,
            )}))`
          : sql`TRUE`,
      );
    clauses.push(parts.length > 0 ? sql`(${sql.join(parts, sql` OR `)})` : sql`FALSE`);
  }
  if (query.cursor) {
    const cursor = readCursor(query.cursor);
    clauses.push(
      sql`(${activityExpr}, ${schema.blips.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await getDb()
    .select({
      blip: schema.blips,
      request: schema.helpdeskRequests,
      activity: sql<string>`(${activityExpr})::text`,
    })
    .from(schema.blips)
    .innerJoin(schema.helpdeskRequests, eq(schema.helpdeskRequests.blipId, schema.blips.id))
    .where(and(...clauses))
    .orderBy(desc(activityExpr), desc(schema.blips.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const clocks = await threadClocks(page.map((row) => row.blip.id));
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toSummary(row.blip, row.request, radar, clocks.get(row.blip.id))),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ at: last.activity, id: last.blip.id }) : null,
  };
}

export async function getHelpdeskRequest(
  actor: IntegrationActor,
  requestId: string,
  scope: string,
  cursorRaw?: string,
): Promise<{
  request: HelpdeskRequestDto;
  thread: { items: HelpdeskThreadItemDto[]; nextCursor: string | null };
}> {
  const { blip, request, helpdesk } = await requestInScope(actor, requestId, scope);
  const clauses: SQL[] = [
    eq(schema.blipComments.blipId, blip.id),
    // The whole of the thread's filter: internal notes and pending drafts are
    // not filtered out of a list, they are never selected.
    eq(schema.blipComments.visibility, 'client'),
  ];
  if (cursorRaw) {
    const cursor = readCursor(cursorRaw);
    clauses.push(
      sql`(${shownAtSql}, ${schema.blipComments.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await getDb()
    .select({ comment: schema.blipComments, at: sql<string>`(${shownAtSql})::text` })
    .from(schema.blipComments)
    .where(and(...clauses))
    .orderBy(asc(shownAtSql), asc(schema.blipComments.id))
    .limit(HELPDESK_LIMITS.threadPage + 1);
  const page = rows.slice(0, HELPDESK_LIMITS.threadPage);
  const last = page[page.length - 1];
  const clocks = await threadClocks([blip.id]);
  const staffName = helpdesk.integration.staffDisplayName;
  return {
    request: toRequest(blip, request, helpdesk.access.radar, clocks.get(blip.id)),
    thread: {
      items: page.map((row) => toThreadItem(row.comment, staffName)),
      nextCursor:
        rows.length > HELPDESK_LIMITS.threadPage && last
          ? encodeCursor({ at: last.at, id: last.comment.id })
          : null,
    },
  };
}

/* --------------------------------- writes --------------------------------- */

/** The lane a new request lands in: the first that tells the client "received". */
function intakeLane(radar: HelpdeskAccess['access']['radar']): string | undefined {
  const lanes = templateFor(radar.template, radar.templateConfig).statuses;
  return (lanes.find((lane) => lane.clientStatus === 'received') ?? lanes[0])?.id;
}

export async function createHelpdeskRequest(
  actor: IntegrationActor,
  radarId: string,
  scope: string,
  input: CreateHelpdeskRequestInput,
  idempotencyKey: string | null,
): Promise<HelpdeskRequestDto> {
  const helpdesk = await requireHelpdeskRadar(radarId, actor);
  assertRequesterInScope(input.requester, scope);
  const hash = requestHash(`POST /radars/${radarId}/requests`, input);
  if (idempotencyKey) {
    const seen = await seenKey(actor.integrationId, idempotencyKey, hash);
    if (seen) return (await getHelpdeskRequest(actor, seen.resourceId, scope)).request;
  }
  await consumeScopeWrite(actor.integrationId, scope);

  let blipId: string;
  try {
    const status = intakeLane(helpdesk.access.radar);
    const blip = await createBlip(
      actor,
      radarId,
      { title: input.title, body: input.body, ...(status ? { status } : {}) },
      {
        helpdesk,
        afterInsert: async (tx, id) => {
          // Re-decided inside the capture's transaction, after `createBlip`
          // key-share locked the radar: a template switch or an unenrolment
          // that committed since the first check refuses this write, and this
          // is still before COMMIT, so nothing is left behind.
          await requireHelpdeskRadar(radarId, actor, tx);
          await tx.insert(schema.helpdeskRequests).values({
            blipId: id,
            integrationId: actor.integrationId,
            requesterRef: input.requester.ref,
            requesterAccountRef: input.requester.accountRef,
            requesterName: input.requester.name,
            requesterEmail: input.requester.email,
          });
          if (idempotencyKey)
            await rememberKey(tx, actor.integrationId, idempotencyKey, hash, id, 201);
        },
      },
    );
    blipId = blip.id;
  } catch (err) {
    if (err instanceof KeyRace && idempotencyKey) {
      const seen = await seenKey(actor.integrationId, idempotencyKey, hash);
      if (seen) return (await getHelpdeskRequest(actor, seen.resourceId, scope)).request;
    }
    throw err;
  }
  return (await getHelpdeskRequest(actor, blipId, scope)).request;
}

/**
 * A client's reply: `client` visibility, no OMR author, the requester in
 * `external_author`. It never resolves an `@handle` (a client cannot address
 * staff by name inside OMR) and it is never editable by anyone (§7.3).
 *
 * The one status change a client causes (§6): a reply to a request in a lane
 * that tells them "waiting on you" moves it to the first lane that says "in
 * progress", in the same transaction, as `laneForState` repairs a lane.
 */
export async function createHelpdeskReply(
  actor: IntegrationActor,
  requestId: string,
  scope: string,
  input: CreateHelpdeskReplyInput,
  idempotencyKey: string | null,
): Promise<HelpdeskThreadItemDto> {
  const found = await requestInScope(actor, requestId, scope);
  assertRequesterInScope(input.requester, scope);
  const hash = requestHash(`POST /requests/${requestId}/replies`, input);
  const staffName = found.helpdesk.integration.staffDisplayName;
  const replay = async (commentId: string) => {
    const [row] = await getDb()
      .select()
      .from(schema.blipComments)
      .where(
        and(eq(schema.blipComments.id, commentId), eq(schema.blipComments.visibility, 'client')),
      );
    if (!row) throw notFound(REQUEST_NOT_FOUND);
    return toThreadItem(row, staffName);
  };
  if (idempotencyKey) {
    const seen = await seenKey(actor.integrationId, idempotencyKey, hash);
    if (seen) return replay(seen.resourceId);
  }
  if (!found.helpdesk.access.radar.commentsEnabled) {
    throw conflict('This helpdesk is not taking replies right now.');
  }
  await consumeScopeWrite(actor.integrationId, scope);

  const author: ExternalAuthor = {
    ref: input.requester.ref,
    accountRef: input.requester.accountRef,
    name: input.requester.name,
    email: input.requester.email,
  };
  const jobs: string[] = [];
  let created: CommentRow;
  try {
    created = await getDb().transaction(async (tx) => {
      const [blip] = await tx
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.id, found.blip.id))
        .for('update');
      // Moved or deleted since the read: refuse rather than reply into a
      // radar the decision was not made against.
      if (!blip || blip.radarId !== found.blip.radarId) throw notFound(REQUEST_NOT_FOUND);
      const helpdesk = await requireHelpdeskRadar(blip.radarId, actor, tx);
      const [comment] = await tx
        .insert(schema.blipComments)
        .values({
          blipId: blip.id,
          radarId: blip.radarId,
          authorId: null,
          body: input.body,
          visibility: 'client',
          externalAuthor: author,
          integrationId: actor.integrationId,
        })
        .returning();
      if (!comment) throw new Error('reply insert returned no row');

      const lanes = templateFor(
        helpdesk.access.radar.template,
        helpdesk.access.radar.templateConfig,
      ).statuses;
      const current = lanes.find((lane) => lane.id === blip.status);
      if (current?.clientStatus === 'waiting_on_you') {
        const next = lanes.find((lane) => lane.clientStatus === 'in_progress');
        if (next) {
          // The client's reply moves it: they are no user, so no editor is recorded.
          const [moved] = await tx
            .update(schema.blips)
            .set({ status: next.id, state: next.state, updatedAt: new Date() })
            .where(eq(schema.blips.id, blip.id))
            .returning();
          if (moved)
            await enqueueSubscriptionEvent(
              tx,
              actor,
              helpdesk.access.radar,
              'blip.updated',
              moved,
              blip,
            );
        }
      }

      jobs.push(
        await enqueueNotificationEvent(tx, {
          type: 'comment',
          actor,
          radarId: blip.radarId,
          blipId: blip.id,
          commentId: comment.id,
          body: input.body,
          mentioned: [],
        }),
      );
      await enqueueSubscriptionEvent(
        tx,
        actor,
        helpdesk.access.radar,
        'comment.created',
        blip,
        undefined,
        comment,
      );
      if (idempotencyKey)
        await rememberKey(tx, actor.integrationId, idempotencyKey, hash, comment.id, 201);
      return comment;
    });
  } catch (err) {
    if (err instanceof KeyRace && idempotencyKey) {
      const seen = await seenKey(actor.integrationId, idempotencyKey, hash);
      if (seen) return replay(seen.resourceId);
    }
    throw err;
  }
  kickSubscriptionDeliveries();
  await recordAudit(actor, 'comment.create', 'comment', created.id, {
    blipId: created.blipId,
    radarId: created.radarId,
    visibility: created.visibility,
    integrationId: actor.integrationId,
  });
  for (const job of jobs) await drainOne(job);
  return toThreadItem(created, staffName);
}

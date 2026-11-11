/**
 * `Idempotency-Key` for blip and comment creation, REST and MCP.
 *
 * An agent that times out on a create cannot know whether the write happened, and a blind
 * retry writes it twice. With a key, a retry returns the original result instead.
 *
 * The shape is the helpdesk's (`integration_idempotency`, services/helpdesk.ts): the key is
 * recorded in the write's own transaction with `ON CONFLICT DO NOTHING`; a concurrent twin
 * that lost makes its insert do nothing, rolls its whole write back, and replays the winner's
 * result. One key is one write however the two calls interleave, and there is never a key
 * without its resource or a resource without its key.
 *
 * What is stored is the id of what was created, not a copy of the response: a replay reads
 * the resource again (through the same access checks as any read), so it can never show a
 * caller something they may no longer see. If the resource has since been deleted the key is
 * spent and the retry is told so (409) instead of silently creating it a second time.
 *
 * Scope of a key: the person, plus the connection when there is one (a PAT's id, or an OAuth
 * client's id; never the access-token row, which rotates on refresh), plus the agent the call is
 * made as, so two agents of one person, on one connection or two, can both use "1" without
 * colliding. A key is bound to the request it first came
 * with: the same key on a different request is a 409. Keys live 24 hours.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { idempotencyKeySchema } from '@onmyradar/contract';
import { getDb, type Db } from '../db/client.js';
import { ApiError, badRequest, conflict, type Actor } from '../http.js';
import { countIdempotentReplay } from '../metrics.js';

export const IDEMPOTENCY_HOURS = 24;

export type IdempotencyScope =
  | 'blip.create'
  | 'comment.create'
  // Architecture writes (docs/MCP.md, `read_architecture`): the resource is the ADR, the element,
  // the anchor or, for a charter save, the radar.
  | 'adr.propose'
  | 'adr.decide'
  | 'element.upsert'
  | 'charter.write'
  | 'charter.link'
  | 'anchor.act';

export interface IdempotencySubject {
  userId: string;
  actorKey: string;
  key: string;
  scope: IdempotencyScope;
  hash: string;
}

/** The slot a recorded key occupies: one per person and connection, a shared one for sessions. */
function actorKeyOf(actor: Actor): string | null {
  // The loaded agent is part of who is calling (as `writerOf` has it): two agents that share a
  // connection by load sessions each have their own keys.
  if (actor.connection)
    return `${actor.connection.kind}:${actor.connection.id}${
      actor.agent ? `|${actor.agent.agentId}` : ''
    }`;
  if (actor.kind === 'user') return 'session';
  return null;
}

/**
 * The header and the body argument are one key; if both are present they must agree. Invalid
 * is a 400 rather than "ignored", because a caller who thinks it is protected and is not
 * is worse off than one who is told no.
 */
export function resolveIdempotencyKey(
  header: string | undefined,
  fromBody: string | undefined,
): string | undefined {
  const headerKey = header === undefined ? undefined : header.trim();
  if (headerKey !== undefined) {
    const parsed = idempotencyKeySchema.safeParse(headerKey);
    if (!parsed.success)
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid Idempotency-Key');
    if (fromBody !== undefined && fromBody !== parsed.data)
      throw badRequest('Idempotency-Key and idempotencyKey disagree.');
    return parsed.data;
  }
  return fromBody;
}

/** A request body with the `Idempotency-Key` header folded into its `idempotencyKey`. */
export function withHeaderKey<T extends { idempotencyKey?: string | undefined }>(
  header: string | undefined,
  body: T,
): T {
  const key = resolveIdempotencyKey(header, body.idempotencyKey);
  return key === undefined ? body : { ...body, idempotencyKey: key };
}

/**
 * A subject for this request, or null when keys do not apply (no key given, or an actor
 * kind with its own retry story such as a webhook or a portal integration).
 */
export function idempotencySubject(
  actor: Actor,
  scope: IdempotencyScope,
  target: string,
  key: string | undefined,
  payload: unknown,
): IdempotencySubject | null {
  if (!key) return null;
  const actorKey = actorKeyOf(actor);
  if (!actorKey) return null;
  return {
    userId: actor.user.id,
    actorKey,
    key,
    scope,
    hash: createHash('sha256')
      .update(JSON.stringify([scope, target, payload]), 'utf8')
      .digest('hex'),
  };
}

/** A key already used inside the window: what it created, or a 409 if this is another request. */
async function seen(subject: IdempotencySubject): Promise<string | null> {
  const { rows } = await getDb().execute<{
    resource_id: string;
    request_sha256: string;
    scope: string;
  }>(sql`
    SELECT resource_id, request_sha256, scope FROM request_idempotency
     WHERE user_id = ${subject.userId}::uuid AND actor_key = ${subject.actorKey} AND key = ${subject.key}
       AND created_at > now() - make_interval(hours => ${IDEMPOTENCY_HOURS})`);
  const row = rows[0];
  if (!row) return null;
  if (row.request_sha256 !== subject.hash || row.scope !== subject.scope)
    throw conflict('This idempotency key was already used for a different request.');
  return row.resource_id;
}

class KeyRace extends Error {}

/** Record the key in the write's own transaction. A twin that got there first aborts this write. */
async function remember(
  tx: Pick<Db, 'execute'>,
  subject: IdempotencySubject,
  resourceId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM request_idempotency
     WHERE user_id = ${subject.userId}::uuid AND actor_key = ${subject.actorKey} AND key = ${subject.key}
       AND created_at <= now() - make_interval(hours => ${IDEMPOTENCY_HOURS})`);
  const inserted = await tx.execute(sql`
    INSERT INTO request_idempotency (user_id, actor_key, key, scope, request_sha256, resource_id)
    VALUES (${subject.userId}::uuid, ${subject.actorKey}, ${subject.key}, ${subject.scope},
            ${subject.hash}, ${resourceId}::uuid)
    ON CONFLICT (user_id, actor_key, key) DO NOTHING
    RETURNING key`);
  if (inserted.rows.length === 0) throw new KeyRace();
}

/**
 * Runs `create` once per key. `create` receives `record`, which it must call inside the
 * write's transaction with the new resource's id; `replay` reads an existing resource by id.
 */
export async function withIdempotency<T>(
  subject: IdempotencySubject,
  create: (record: (tx: Pick<Db, 'execute'>, resourceId: string) => Promise<void>) => Promise<T>,
  replay: (resourceId: string) => Promise<T>,
  onReplay?: () => void,
): Promise<T> {
  const replayOf = async (resourceId: string): Promise<T> => {
    countIdempotentReplay(subject.scope);
    onReplay?.();
    try {
      return await replay(resourceId);
    } catch (err) {
      // Gone since: the key is spent, and writing it again would be the duplicate it exists to prevent.
      if (err instanceof ApiError && err.status === 404)
        throw conflict('What this idempotency key created no longer exists.');
      throw err;
    }
  };
  const first = await seen(subject);
  if (first) return replayOf(first);
  try {
    return await create((tx, resourceId) => remember(tx, subject, resourceId));
  } catch (err) {
    if (!(err instanceof KeyRace)) throw err;
    const twin = await seen(subject);
    if (twin) return replayOf(twin);
    throw err;
  }
}

/** Worker sweep: keys past their window. Bounded per run. */
export async function purgeExpiredRequestKeys(batchSize = 1_000): Promise<number> {
  const result = await getDb().execute(sql`
    WITH picked AS (
      SELECT user_id, actor_key, key FROM request_idempotency
       WHERE created_at < now() - make_interval(hours => ${IDEMPOTENCY_HOURS})
       LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM request_idempotency t USING picked
     WHERE t.user_id = picked.user_id AND t.actor_key = picked.actor_key AND t.key = picked.key`);
  return result.rowCount ?? 0;
}

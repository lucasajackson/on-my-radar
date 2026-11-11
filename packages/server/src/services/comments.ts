import { enqueueSubscriptionEvent, kickSubscriptionDeliveries } from './subscriptions.js';
/**
 * Comments on blips.
 *
 * The conversation *around* a thought, kept separate from the thought itself.
 * That separation is the whole design: a blip stays one person's captured idea
 * — editing it is still `write` access — while anyone the radar is shared with
 * can talk about it. `requireParticipation` in services/access.ts is where that
 * distinction is decided, and it is the only place.
 *
 * Ordering is oldest-first, which is the one place in this application that
 * runs the opposite way to everything else. A stream is a pile you scan from
 * the top; a conversation is a thing you read forwards. The keyset cursor is
 * therefore `>` on `(created_at, id)` rather than the stream's `<`.
 *
 * ## Threading, and what it does to that cursor
 *
 * A comment may answer another comment, exactly one level deep (see
 * `drizzle/0008_threads_and_mentions.sql` for why one and not more). A thread
 * therefore reads as: each top-level remark in time order, with its replies in
 * time order underneath it.
 *
 * That is expressible as a sort on four keys — the *parent's* position, then the
 * comment's own — and the keyset extends to match rather than being left behind:
 *
 *     (root_created_at, root_id, created_at, id)   ascending throughout
 *
 * where `root` is the parent when there is one and the comment itself when there
 * is not. Every key runs the same direction, so the row-value comparison is
 * valid; `id` is unique, so the tuple cannot tie; and a parent always sorts
 * before its own replies because a reply cannot be created before the thing it
 * answers.
 *
 * For a flat thread — every comment in the application before this change, and
 * every comment on every template but the discussion — `root` is the comment
 * itself and the whole thing collapses to `(created_at, id)`, byte for byte what
 * it was. A cursor issued before threading existed carries two fields and is
 * read as `(createdAt, id, createdAt, id)`, which is exactly right for the flat
 * thread it was issued against.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  AgentDto,
  BlipHolderDto,
  CommentDto,
  CommentVisibility,
  CreateCommentInput,
  ListCommentsQuery,
  MentionDto,
  PageDto,
  ReleaseCommentInput,
  UpdateCommentInput,
} from '@onmyradar/contract';
import { isClientFacingTemplate, roleAtLeast } from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { badRequest, conflict, forbidden, notFound, type Actor } from '../http.js';
import {
  assertHumanDecision,
  requireParticipation,
  requireRadar,
  requireScopeWithinGrants,
  type RadarAccess,
  type RadarRow,
} from './access.js';
import { agentsByIds, authorshipOf, isHumanSession, writeAsAgent } from './agents.js';
import { holders, setEditor } from './blip-history.js';
import { assertNotCharterPage } from './charter.js';
import { liveExpr } from './blips.js';
import { idempotencySubject, withIdempotency } from './idempotency.js';
import { auditRow, recordAudit } from './audit.js';
import { decodeCursor, encodeCursor, isCursorTimestamp, isCursorUuid } from './cursor.js';
import { mentionsFor, reconcileMentions, resolveMentions } from './mentions.js';
import { enqueueNotificationEvent } from './notifications.js';
import { drainOne } from './outbox.js';
import { isPublicOnly, narrowComment } from './redaction.js';

type CommentRow = typeof schema.blipComments.$inferSelect;
type Author = { id: string; name: string | null; email: string } | null;

/** The parent side of the thread ordering join. */
const parentComment = alias(schema.blipComments, 'parent_comment');

/** The comment's own position when it is top level, its parent's when it is not. */
const rootCreatedAt = sql`COALESCE(${parentComment.createdAt}, ${schema.blipComments.createdAt})`;
const rootId = sql`COALESCE(${parentComment.id}, ${schema.blipComments.id})`;

/* -------------------------------- cursors -------------------------------- */

interface ThreadCursor {
  rootCreatedAt: string;
  rootId: string;
  createdAt: string;
  id: string;
}

/**
 * A comment plus the position its *root* sorts at, with both timestamps kept as
 * **Postgres text rather than JS Dates**.
 *
 * That is not fussiness, it is the difference between a cursor that terminates
 * and one that does not. `timestamptz` holds microseconds
 * (`2026-08-27 02:23:52.639831+00`); a JS `Date` holds milliseconds and silently
 * drops the last three digits. A cursor built from `Date.toISOString()` therefore
 * names an instant fractionally *before* the row it was taken from — and since a
 * thread reads forwards with `>`, that row still satisfies the comparison and is
 * served again. Every page repeats its own last row, for ever.
 *
 * That was true of the flat cursor this file shipped with: paging a thread of
 * five comments two at a time yielded `c0,c1,c1,c2,c2,c3,c3,c4,c4,c4…`. Nobody
 * had noticed because the SPA only pages a thread past fifty comments. The
 * descending cursors elsewhere have the mirror image of the same defect and
 * *skip* rather than repeat, which is quieter and worse.
 *
 * Rendering the value with `::text` and handing it straight back is lossless in
 * both directions, needs no parsing on either side, and costs nothing.
 */
type CommentWithRoot = CommentRow & {
  rootCreatedAt: string;
  rootId: string;
  createdAtText: string;
};

function encodeThreadCursor(row: CommentWithRoot): string {
  return encodeCursor({
    rootCreatedAt: row.rootCreatedAt,
    rootId: row.rootId,
    createdAt: row.createdAtText,
    id: row.id,
  });
}

/**
 * The envelope — base64url, and the length ceiling both transports share — is
 * `services/cursor.ts`. Only the four keys of *this* keyset are read here.
 *
 * Worth knowing that this cursor is 247 characters, well past the 200 the
 * comment schema used to cap it at: threading added the root keys and the cap
 * was never revisited, so every thread longer than one page 400'd on page 2.
 * That is why there is no number in this file any more.
 */
function decodeThreadCursor(raw: string): ThreadCursor | null {
  const parsed = decodeCursor(raw);
  if (!parsed) return null;
  const createdAt = parsed['createdAt'];
  const id = parsed['id'];
  if (!isCursorTimestamp(createdAt) || !isCursorUuid(id)) return null;
  // A two-field cursor predates threading. Reading it as its own root is what
  // it always meant on the flat thread it was issued against.
  const root = parsed['rootCreatedAt'];
  const rootIdValue = parsed['rootId'];
  if (root !== undefined && !isCursorTimestamp(root)) return null;
  if (rootIdValue !== undefined && !isCursorUuid(rootIdValue)) return null;
  return {
    rootCreatedAt: root ?? createdAt,
    rootId: rootIdValue ?? id,
    createdAt,
    id,
  };
}

/* ---------------------------------- DTOs --------------------------------- */

/**
 * Who may delete this comment, decided here rather than by the caller comparing
 * ids. The rule is "its writer, or a person who owns the radar" — the second half is
 * moderation, and an owner has to be able to remove something said on their own
 * radar without deleting the blip under it.
 */
const NOT_YOUR_WORDS =
  'Written by another agent, or by the person themselves. Only its writer, or that person in the browser, can change it.';

/**
 * One writer, not one account: the owner and every agent they run share a user id, so the id alone
 * lets agent B rewrite agent A under A's byline. It passes for the person in the browser, or for
 * the agent that wrote it.
 */
function sameWriter(row: CommentRow, actor: Actor): boolean {
  if (row.authorId === null || row.authorId !== actor.user.id) return false;
  if (isHumanSession(actor)) return true;
  // A sessionless bearer is no agent and not the person, so it matches nothing: a human's words
  // (agentId null) are the person's alone.
  return row.agentId !== null && actor.agent?.agentId === row.agentId;
}

function canDelete(row: CommentRow, access: RadarAccess, actor: Actor | null): boolean {
  if (!actor) return false;
  // Deleting is a write whoever does it. The moderation half is already
  // clamped — `canManage` is computed under the token's ceiling — but the
  // author half compared ids alone, so a `radars:read` token could delete
  // every comment its human ever wrote. A connection needs `radars:write` to
  // delete even its own human's words, exactly as it does to write them.
  if (!roleAtLeast(access.ceiling, 'editor')) return false;
  if (sameWriter(row, actor)) return true;
  // Moderation is a person's: not an agent's, and not a sessionless token's.
  return access.canManage && isHumanSession(actor);
}

/* ------------------------------ visibility ------------------------------ */

/**
 * sha256 of a comment body, hex, over its UTF-8 bytes.
 *
 * Byte-for-byte the expression in the `blip_comments_released_body_unchanged`
 * CHECK (`encode(sha256(convert_to(body, 'UTF8')), 'hex')`), so the hash a
 * reviewer is shown, the one the release compares, and the one the database
 * holds a released body to are the same number. A test asserts the two agree.
 */
export function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Whether this radar has a client side at all. Read off the registry, never a template id. */
function hasClientSide(radar: RadarRow): boolean {
  return radar.kind === 'standard' && isClientFacingTemplate(radar.template);
}

const NO_CLIENT_SIDE =
  'Only a Helpdesk radar has a client side, so this can only be an internal comment. ' +
  'Leave visibility out (or send "internal").';

/**
 * The radar's owner, in person — the one writer whose reply to a client is
 * published as it is written.
 *
 * Decision 3 (Company Decisions blip a4f16ccc): no free text reaches a client
 * without the product owner's review. When they type a reply themselves, typing it *is* the
 * review. Everybody else — his own agents (kind `agent`, even writing as him),
 * a collaborator, a co-owner he shared the radar with — is reviewed by him.
 * `ownerId` rather than `role === 'owner'`: a co-owner holds the role but is
 * not the person whose decision this is, and the portal credential (slice 3)
 * acts as exactly this account.
 */
function publishesDirectly(actor: Actor, radar: RadarRow): boolean {
  return actor.kind === 'user' && radar.ownerId === actor.user.id;
}

/**
 * What a new comment becomes, decided before anything is written.
 *
 * `internal` unless `client` was asked for — the default is the safe one, on
 * every transport, and nothing infers a client reply from its wording. Asking
 * for `client` is refused off a client-facing radar and needs edit access (a
 * reply to a client speaks for the business, which a viewer joining the
 * conversation does not). Then the writer decides the outcome, not the request.
 */
function decideVisibility(
  actor: Actor,
  access: RadarAccess,
  wanted: CreateCommentInput['visibility'],
): { visibility: CommentVisibility; releasedAt: Date | null; releasedBy: string | null } {
  const none = { releasedAt: null, releasedBy: null };
  if (wanted !== 'client') return { visibility: 'internal', ...none };
  if (!hasClientSide(access.radar)) throw badRequest(NO_CLIENT_SIDE);
  if (!access.canWrite) {
    throw forbidden(
      'Writing to the client needs edit access to this radar. Add an internal note instead.',
    );
  }
  if (publishesDirectly(actor, access.radar)) {
    return { visibility: 'client', releasedAt: new Date(), releasedBy: actor.user.id };
  }
  return { visibility: 'client_pending', ...none };
}

function toCommentDto(
  row: CommentRow,
  author: Author,
  access: RadarAccess,
  actor: Actor | null,
  mentions: MentionDto[] = [],
  agent: AgentDto | null = null,
  editedBy?: BlipHolderDto | null,
): CommentDto {
  return {
    id: row.id,
    blipId: row.blipId,
    radarId: row.radarId,
    body: row.body,
    parentId: row.parentId,
    author,
    /*
      Beside the author, never instead of it — which is why `canDelete` above
      needs no change at all. `author_id` on an agent-written comment is the
      human, so "its author, or whoever owns the radar" already means what it
      always meant, and so does `updateComment`'s stricter authorship test.
      That is the payoff of recording both identities rather than choosing.
    */
    agent,
    voice: row.agentVoice ?? null,
    ...(editedBy ? { editedBy } : {}),
    canDelete: canDelete(row, access, actor),
    // Omitted rather than sent empty, like `commentCount` on a blip: a thread of
    // fifty remarks should not spend fifty keys saying nobody was addressed.
    ...(mentions.length > 0 ? { mentions } : {}),
    visibility: row.visibility,
    // The hash travels with a pending reply only: it is what a reviewer sends
    // back to release, and nothing else needs it.
    ...(row.visibility === 'client_pending'
      ? {
          bodySha256: bodySha256(row.body),
          // The same three facts `releaseComment` checks, so the button is
          // offered exactly where the release would be accepted.
          canRelease:
            actor?.kind === 'user' &&
            access.radar.ownerId === actor.user.id &&
            hasClientSide(access.radar),
        }
      : {}),
    ...(row.visibility === 'client' && row.releasedAt
      ? { releasedAt: row.releasedAt.toISOString() }
      : {}),
    // A client's own words through the portal (T3): no OMR author, and the
    // name the portal asserted, labelled as such.
    ...(row.externalAuthor
      ? {
          external: {
            via: row.externalAuthor.via ?? 'portal',
            requesterName: row.externalAuthor.name,
          },
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One round trip for the authors of a whole page, rather than one per comment. */
async function hydrate(
  rows: CommentRow[],
  access: RadarAccess,
  actor: Actor | null,
): Promise<CommentDto[]> {
  if (rows.length === 0) return [];
  const authorIds = [
    ...new Set(rows.map((r) => r.authorId).filter((v): v is string => v !== null)),
  ];
  const authorRows =
    authorIds.length > 0
      ? await getDb()
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, authorIds))
      : [];
  const authors = new Map(authorRows.map((a) => [a.id, a]));
  // One round trip for the whole page's mentions too, same as the authors.
  const mentions = await mentionsFor(
    'comment',
    rows.map((r) => r.id),
  );
  // The byline card's owner and link, for a signed-in viewer only (§V2.5).
  const agents = await agentsByIds(
    [...new Set(rows.map((r) => r.agentId).filter((v): v is string => v !== null))],
    actor?.user.id ?? undefined,
  );
  // Named only when someone other than the creator made the last edit.
  const edits = rows.filter(
    (r) =>
      (r.editedByUserId || r.editedByAgentId) &&
      (r.editedByUserId !== r.authorId || r.editedByAgentId !== r.agentId),
  );
  const named = await holders(
    edits.map((r) => ({ editor_user_id: r.editedByUserId, editor_agent_id: r.editedByAgentId })),
  );
  const edited = new Set(edits);
  return rows.map((row) =>
    toCommentDto(
      row,
      row.authorId ? (authors.get(row.authorId) ?? null) : null,
      access,
      actor,
      mentions.get(row.id) ?? [],
      row.agentId ? (agents.get(row.agentId) ?? null) : null,
      edited.has(row)
        ? named({ editor_user_id: row.editedByUserId, editor_agent_id: row.editedByAgentId })
        : null,
    ),
  );
}

/* --------------------------------- reads --------------------------------- */

/**
 * The blip, and the radar access that governs it. Throws 404 for either.
 *
 * `radarRef` is the identifier the caller *arrived by*, and it matters. A public
 * link grants access only when it is the identifier that was used — that is the
 * rule in `getRadarAccess`, and it means resolving a public radar by its uuid
 * yields no access at all. So a caller on the public surface has to hand the
 * slug down, or the thread on a published blip is unreachable for everyone.
 *
 * The cross-check below is what makes that safe: the radar the reference
 * resolved to must be the radar the blip actually lives on. Without it, a valid
 * public slug plus somebody else's private blip id would read that blip's
 * conversation.
 */
async function blipWithAccess(blipId: string, actor: Actor | null, radarRef?: string) {
  const rows = await getDb()
    .select()
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  const blip = rows[0];
  if (!blip) throw notFound('Blip not found');
  const access = await requireRadar(radarRef ?? blip.radarId, actor, 'read');
  if (access.radar.id !== blip.radarId) throw notFound('Blip not found');
  return { blip, access };
}

/**
 * A blip's thread.
 *
 * Reading a comment needs only read access to the radar — the toggle gates
 * *writing*, not history. Turning comments off on a radar that already has some
 * must not make the existing conversation vanish, which would read as data loss
 * rather than as a setting.
 */
export async function listComments(
  actor: Actor | null,
  blipId: string,
  query: ListCommentsQuery = {},
  /**
   * The identifier the caller reached the radar by — a `public_slug` when the
   * request arrived on the public surface, where there is no actor and the uuid
   * would grant nothing. Defaults to the blip's own radar id, which is what
   * every authenticated caller wants.
   */
  radarRef?: string,
): Promise<PageDto<CommentDto>> {
  const { access } = await blipWithAccess(blipId, actor, radarRef);
  if (isPublicOnly(access)) {
    const [live] = await getDb()
      .select({ id: schema.blips.id })
      .from(schema.blips)
      .where(and(eq(schema.blips.id, blipId), liveExpr))
      .limit(1);
    if (!live) throw notFound('Blip not found');
  }
  const limit = Math.min(query.limit ?? 50, 100);

  const clauses = [eq(schema.blipComments.blipId, blipId)];
  const cursor = query.cursor ? decodeThreadCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw badRequest('Invalid cursor');
  if (cursor) {
    // Forwards, unlike every other cursor in this application — see the file
    // header. The row-value comparison names every key of the ORDER BY, so the
    // keyset stays total and a comment landing mid-read cannot duplicate one.
    clauses.push(
      sql`(${rootCreatedAt}, ${rootId}, ${schema.blipComments.createdAt}, ${schema.blipComments.id}) > (${cursor.rootCreatedAt}::timestamptz, ${cursor.rootId}::uuid, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await getDb()
    .select({
      comment: schema.blipComments,
      // `::text` keeps Postgres's microseconds intact all the way to the cursor.
      rootCreatedAt: sql<string>`(${rootCreatedAt})::text`,
      rootId: sql<string>`${rootId}`,
      createdAtText: sql<string>`${schema.blipComments.createdAt}::text`,
    })
    .from(schema.blipComments)
    // A reply's parent is always top-level, so one hop resolves every root.
    .leftJoin(parentComment, eq(parentComment.id, schema.blipComments.parentId))
    .where(and(...clauses))
    .orderBy(
      sql`${rootCreatedAt} ASC`,
      sql`${rootId} ASC`,
      asc(schema.blipComments.createdAt),
      asc(schema.blipComments.id),
    )
    .limit(limit + 1);

  const withRoot: CommentWithRoot[] = rows.map((row) => ({
    ...row.comment,
    rootCreatedAt: row.rootCreatedAt,
    rootId: row.rootId,
    createdAtText: row.createdAtText,
  }));

  const page = withRoot.slice(0, limit);
  const last = page[page.length - 1];
  const items = await hydrate(page, access, actor);
  return {
    // Narrowed on the access rather than in the route, for the same reason
    // `radarStream` is: `radarRef` may be a `public_slug`, and a caller who got
    // in that way holds no role and must not be handed author addresses
    // whichever transport asked.
    items: isPublicOnly(access) ? items.map(narrowComment) : items,
    nextCursor: withRoot.length > limit && last ? encodeThreadCursor(last) : null,
  };
}

/** Comment counts for a page of blips, in one query rather than one per blip. */
export async function commentCounts(blipIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (blipIds.length === 0) return counts;
  const rows = await getDb()
    .select({ blipId: schema.blipComments.blipId, count: sql<number>`count(*)::int` })
    .from(schema.blipComments)
    .where(inArray(schema.blipComments.blipId, blipIds))
    .groupBy(schema.blipComments.blipId);
  for (const row of rows) counts.set(row.blipId, row.count);
  return counts;
}

/**
 * When each of these threads was last answered, in one query.
 *
 * The read-side twin of `lastActivityExpr` in `services/blips.ts`, which is the
 * same aggregate pushed into an ORDER BY. Both are computed from the comments
 * rather than read from a column on the blip, so the number a card prints and
 * the number the page was sorted by cannot disagree.
 *
 * A blip nobody has replied to is simply absent; the caller falls back to its
 * own `createdAt`, which is what the SQL's COALESCE does for the same row.
 */
export async function lastActivityFor(blipIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (blipIds.length === 0) return out;
  const rows = await getDb()
    .select({
      blipId: schema.blipComments.blipId,
      // A raw aggregate comes back as the driver's string, not a Date.
      last: sql<string>`MAX(${schema.blipComments.createdAt})`,
    })
    .from(schema.blipComments)
    .where(inArray(schema.blipComments.blipId, blipIds))
    .groupBy(schema.blipComments.blipId);
  for (const row of rows) out.set(row.blipId, new Date(row.last));
  return out;
}

/* --------------------------------- writes -------------------------------- */

export interface CommentOptions {
  /** Notification fan-out is left to the worker instead of running before the call returns. */
  deferDelivery?: boolean;
  /** Called when an `idempotencyKey` made this call a replay of an earlier one. */
  onReplay?: () => void;
}

/**
 * With `input.idempotencyKey` a retry returns the comment the first call made (see
 * `services/idempotency.ts`).
 */
export async function createComment(
  actor: Actor,
  blipId: string,
  input: CreateCommentInput,
  options: CommentOptions = {},
): Promise<CommentDto> {
  const { idempotencyKey, ...rest } = input;
  const subject = idempotencySubject(actor, 'comment.create', blipId, idempotencyKey, rest);
  if (!subject) return createCommentOnce(actor, blipId, input, options, null);
  return withIdempotency(
    subject,
    (record) => createCommentOnce(actor, blipId, input, options, record),
    (commentId) => replayComment(actor, commentId),
    options.onReplay,
  );
}

/** The comment an earlier call created, read back through the ordinary access check. */
async function replayComment(actor: Actor, commentId: string): Promise<CommentDto> {
  const [comment] = await getDb()
    .select()
    .from(schema.blipComments)
    .where(eq(schema.blipComments.id, commentId))
    .limit(1);
  if (!comment) throw notFound('Comment not found');
  const access = await requireParticipation(comment.radarId, actor, 'comments');
  const [dto] = await hydrate([comment], access, actor);
  if (!dto) throw notFound('Comment not found');
  // The replay answers what the first call did, so it names the same handles.
  const { unknown, ambiguous } = await resolveMentions(access.radar, comment.body);
  const unresolved = [...unknown, ...ambiguous];
  return unresolved.length > 0 ? { ...dto, unresolvedMentions: unresolved } : dto;
}

async function createCommentOnce(
  actor: Actor,
  blipId: string,
  input: CreateCommentInput,
  options: CommentOptions,
  record: ((tx: Pick<Db, 'execute'>, resourceId: string) => Promise<void>) | null,
): Promise<CommentDto> {
  // A load session names the agent this write is under (§V2.5); resolved here,
  // in the service, so REST and MCP bind it identically.
  actor = await writeAsAgent(actor, input.session);
  const rows = await getDb()
    .select()
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  const blip = rows[0];
  if (!blip) throw notFound('Blip not found');

  let access = await requireParticipation(blip.radarId, actor, 'comments');

  const notificationJobs: string[] = [];
  let parentId: string | null | undefined;
  let unresolved: string[] = [];
  const comment = await getDb().transaction(async (tx) => {
    const [blip] = await tx
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .for('update');
    if (!blip) throw notFound('Blip not found');
    await assertNotCharterPage(tx, blip);
    access = await requireParticipation(blip.radarId, actor, 'comments', tx);
    // Against the radar the blip is on *now*, read under the blip's lock, so a
    // move or a template switch cannot slip between the decision and the
    // insert. Before the first write, so a refusal is a refusal.
    const visibility = decideVisibility(actor, access, input.visibility);
    // Resolved inside the transaction and key-share locked, so a parent deleted
    // a moment earlier is a 404 here rather than a foreign-key failure — a 500 —
    // at the insert, and one deleted a moment later waits for this reply.
    parentId = await resolveParent(tx, blip.id, input.parentId);

    const [comment] = await tx
      .insert(schema.blipComments)
      .values({
        blipId: blip.id,
        // Denormalised deliberately; see the migration. Taken from the blip rather
        // than from the request so it can never disagree with where the blip is.
        radarId: blip.radarId,
        authorId: actor.user.id,
        // One expression, read from the actor and nothing else. See
        // `authorshipOf` — a tool argument selects a voice, never a principal.
        ...authorshipOf(actor, input.as),
        parentId,
        body: input.body,
        visibility: visibility.visibility,
        releasedAt: visibility.releasedAt,
        releasedBy: visibility.releasedBy,
        // Hashed from the value as stored, never from the request, so the
        // CHECK binding a released body to its hash holds by construction.
        releasedBodySha256: visibility.releasedAt ? bodySha256(input.body) : null,
      })
      .returning();
    if (!comment) throw new Error('comment insert returned no row');
    await record?.(tx, comment.id);
    if (comment.visibility === 'client_pending')
      notificationJobs.push(
        await enqueueNotificationEvent(tx, {
          type: 'reply-pending',
          actor,
          radarId: access.radar.id,
          blipId: blip.id,
          commentId: comment.id,
        }),
      );

    const { newlyMentioned, unknown, ambiguous } = await reconcileMentions(
      access.radar,
      { commentId: comment.id },
      input.body,
      actor.user.id,
      actor.agent?.agentId ?? null,
      tx,
    );
    unresolved = [...unknown, ...ambiguous];
    if (newlyMentioned.length > 0)
      notificationJobs.push(
        await enqueueNotificationEvent(tx, {
          type: 'mention',
          actor,
          radarId: access.radar.id,
          blipId: blip.id,
          commentId: comment.id,
          body: input.body,
          mentioned: newlyMentioned,
        }),
      );
    notificationJobs.push(
      await enqueueNotificationEvent(tx, {
        type: 'comment',
        actor,
        radarId: access.radar.id,
        blipId: blip.id,
        commentId: comment.id,
        body: input.body,
        mentioned: newlyMentioned
          .map((target) => target.userId)
          .filter((id): id is string => id !== null),
      }),
    );
    await enqueueSubscriptionEvent(
      tx,
      actor,
      access.radar,
      'comment.created',
      blip,
      undefined,
      comment,
    );
    return comment;
  });
  if (!options.deferDelivery) kickSubscriptionDeliveries();

  await recordAudit(actor, 'comment.create', 'comment', comment.id, {
    blipId: blip.id,
    radarId: blip.radarId,
    ...(parentId ? { parentId } : {}),
    ...(comment.visibility !== 'internal' ? { visibility: comment.visibility } : {}),
  });

  if (!options.deferDelivery) for (const job of notificationJobs) await drainOne(job);

  const [dto] = await hydrate([comment], access, actor);
  if (!dto) throw new Error('comment vanished after insert');
  return unresolved.length > 0 ? { ...dto, unresolvedMentions: unresolved } : dto;
}

/**
 * The comment a reply should actually hang from.
 *
 * Three rules, and only the first is a refusal:
 *
 * - A parent on a **different blip** does not resolve, and the refusal does not
 *   distinguish "no such comment" from "a comment somewhere you cannot see" —
 *   the same disclosure rule as `requireRadar` answering 404 rather than 403,
 *   and the same one `supersedes` follows across radars.
 * - A parent that is **itself a reply** is not an error. The thread is one level
 *   deep, so this re-parents to that reply's own parent: answering a nested
 *   reply lands you beside it rather than under it. Refusing instead would make
 *   the reply control on a nested reply do nothing, which is worse than the
 *   thing being prevented. The response carries where it actually landed, so
 *   nothing about this is hidden from the caller.
 * - No parent at all is a remark on the thread itself, which is what every
 *   comment in the application was before threading existed.
 */
async function resolveParent(
  tx: Pick<Db, 'select'>,
  blipId: string,
  requested: string | null | undefined,
): Promise<string | null> {
  if (!requested) return null;
  // The row the reply will reference is key-share locked, which is what the
  // insert's foreign key would take anyway — taken first, so the parent cannot
  // be deleted between being found and being pointed at.
  const find = async (id: string) =>
    (
      await tx
        .select({
          id: schema.blipComments.id,
          blipId: schema.blipComments.blipId,
          parentId: schema.blipComments.parentId,
        })
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, id))
        .limit(1)
        .for('key share')
    )[0];
  const parent = await find(requested);
  if (!parent || parent.blipId !== blipId) throw notFound('Comment not found');
  if (!parent.parentId) return parent.id;
  const root = await find(parent.parentId);
  if (!root || root.blipId !== blipId) throw notFound('Comment not found');
  return root.id;
}

/** Editing your own remark. Not moderation: an owner may delete, never rewrite. */
export async function updateComment(
  actor: Actor,
  commentId: string,
  input: UpdateCommentInput,
): Promise<CommentDto> {
  // A load session names the agent this write is under (§V2.5); resolved here,
  // in the service, so REST and MCP bind it identically.
  actor = await writeAsAgent(actor, input.session);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.blipComments)
    .where(eq(schema.blipComments.id, commentId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw notFound('Comment not found');

  let access = await requireParticipation(existing.radarId, actor, 'comments');
  if (!sameWriter(existing, actor)) {
    // Putting words in somebody's mouth is worse than removing them, so an
    // owner's moderation power stops short of the edit.
    if (existing.authorId !== actor.user.id) throw notFound('Comment not found');
    throw forbidden(NOT_YOUR_WORDS);
  }

  /*
    The creator is fixed (ADR-0028, `blip_comments_keep_author` in 0099): author, agent and voice
    are not written here. The editor is named for the trigger, which records it when the words
    change, and shown as `editedBy` when it is not the creator.
  */
  let mentionJob: string | undefined;
  const updated = await db.transaction(async (tx) => {
    // Moves lock the parent first. Use that order before touching its child row.
    const [blip] = await tx
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, existing.blipId))
      .for('update');
    if (!blip) throw notFound('Blip not found');
    access = await requireParticipation(blip.radarId, actor, 'comments', tx);
    /*
      Read again under the blip's lock, which `releaseComment` also takes: the
      copy read above may predate a release. A released reply is immutable —
      the client has been told, and the approval was for these exact words —
      so this is refused, and the CHECK in 0043 refuses the write regardless.
      A *pending* reply may still be edited by its author; its hash changes,
      and a release against the old one is then refused (§7.2).
    */
    const [current] = await tx
      .select({ visibility: schema.blipComments.visibility })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, existing.id))
      .for('update');
    if (!current) throw notFound('Comment not found');
    if (current.visibility === 'client') {
      throw conflict(
        'This reply has been released to the client and can no longer be edited. ' +
          'Delete it, or write another.',
      );
    }

    await setEditor(tx, actor.user.id, actor.agent?.agentId ?? null);
    const [updated] = await tx
      .update(schema.blipComments)
      .set({ body: input.body, updatedAt: new Date() })
      .where(eq(schema.blipComments.id, existing.id))
      .returning();
    if (!updated) throw notFound('Comment not found');

    const { newlyMentioned } = await reconcileMentions(
      access.radar,
      { commentId: updated.id },
      input.body,
      actor.user.id,
      actor.agent?.agentId ?? null,
      tx,
    );
    if (newlyMentioned.length > 0)
      mentionJob = await enqueueNotificationEvent(tx, {
        type: 'mention',
        actor,
        radarId: access.radar.id,
        blipId: updated.blipId,
        commentId: updated.id,
        body: input.body,
        mentioned: newlyMentioned,
      });
    return updated;
  });

  await recordAudit(actor, 'comment.update', 'comment', updated.id, { blipId: updated.blipId });

  if (mentionJob) await drainOne(mentionJob);

  const [dto] = await hydrate([updated], access, actor);
  if (!dto) throw new Error('comment vanished after update');
  return dto;
}

/**
 * Releasing a pending reply to the client (`docs/HELPDESK.md` §7.2).
 *
 * The one way a reply someone else wrote becomes client-visible, and three
 * things have to be true at once:
 *
 * - **A person, in a browser session** (`assertHumanDecision`). An agent can
 *   draft a reply but never publish one: that is decision 3, and it lives here
 *   in the service, so a bearer token on REST is refused exactly as it would be
 *   on MCP — where there is deliberately no tool for it at all.
 * - **The radar's owner.** Not a collaborator, not a co-owner: see
 *   `publishesDirectly`. Anyone else who can read the radar is told who can.
 * - **The text they reviewed.** `bodySha256` is what the review screen showed,
 *   compared with the stored body under the row lock `updateComment` also
 *   takes, so an edit landing between the review and the click voids the
 *   approval with a 409 rather than publishing words nobody approved. The hash
 *   is written with the release, and the CHECK in 0043 holds the body to it —
 *   at this write (a stale hash cannot be stored against a changed body) and
 *   for good afterwards.
 *
 * Discarding is not here: it is deleting the pending reply, which an agent may
 * do to its own draft and an owner may do as moderation — the safe direction,
 * like unenrolling a radar. Only publishing needs a person.
 */
export async function releaseComment(
  actor: Actor,
  commentId: string,
  input: ReleaseCommentInput,
): Promise<CommentDto> {
  assertHumanDecision(
    actor,
    'Releasing a reply to a client is the radar owner’s review, done in On My Radar while signed in. ' +
      'An agent can draft one (visibility "client") but never publish it.',
  );
  const { released, access } = await getDb().transaction(async (tx) => {
    const [peek] = await tx
      .select({ blipId: schema.blipComments.blipId })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, commentId))
      .limit(1);
    if (!peek) throw notFound('Comment not found');
    // The blip first, in the order `updateComment` and `deleteComment` take it.
    await tx
      .select({ id: schema.blips.id })
      .from(schema.blips)
      .where(eq(schema.blips.id, peek.blipId))
      .for('update');
    const [existing] = await tx
      .select()
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, commentId))
      .for('update');
    if (!existing) throw notFound('Comment not found');
    // A radar the caller cannot read is a 404, never a 403.
    const access = await requireRadar(existing.radarId, actor, 'read', tx);
    if (!hasClientSide(access.radar)) throw badRequest(NO_CLIENT_SIDE);
    if (access.radar.ownerId !== actor.user.id) {
      throw forbidden('Only the owner of this radar can release a reply to the client.');
    }
    if (existing.visibility === 'client') throw conflict('This reply is already released.');
    if (existing.visibility !== 'client_pending') {
      throw conflict(
        'This is an internal note. Notes are never turned into replies: write the reply to the client instead.',
      );
    }
    if (bodySha256(existing.body) !== input.bodySha256) {
      throw conflict('This reply changed after you reviewed it. Read it again, then release it.');
    }
    const [released] = await tx
      .update(schema.blipComments)
      .set({
        visibility: 'client',
        releasedAt: new Date(),
        releasedBy: actor.user.id,
        releasedBodySha256: input.bodySha256,
      })
      .where(eq(schema.blipComments.id, existing.id))
      .returning();
    if (!released) throw notFound('Comment not found');
    return { released, access };
  });
  await recordAudit(actor, 'comment.release', 'comment', released.id, {
    blipId: released.blipId,
    radarId: released.radarId,
    bodySha256: released.releasedBodySha256,
  });
  const [dto] = await hydrate([released], access, actor);
  if (!dto) throw new Error('comment vanished after release');
  return dto;
}

/**
 * Deleting a comment.
 *
 * Deliberately reachable when comments are *turned off*: an owner switching
 * them off is often doing it precisely to clear something up, and a rule that
 * locked the existing thread at that moment would be the opposite of what they
 * asked for. So this checks read access plus the author-or-owner rule, not
 * `requireParticipation`.
 */
export async function deleteComment(
  actor: Actor,
  commentId: string,
  options: { session?: string | undefined } = {},
): Promise<void> {
  actor = await writeAsAgent(actor, options.session);
  const deleted = await getDb().transaction(async (tx) => {
    const [peek] = await tx
      .select({ blipId: schema.blipComments.blipId })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, commentId))
      .limit(1);
    if (!peek) throw notFound('Comment not found');
    /*
      The blip first, as `updateBlip`'s move and `updateComment` lock it: a move
      re-points every comment's radar under that lock. Authorised against the
      radar read *after* it, the delete answers to where the comment is now —
      read before it, a moderator of the radar a thread had just left could
      still remove a remark from a radar they cannot open.
    */
    await tx
      .select({ id: schema.blips.id })
      .from(schema.blips)
      .where(eq(schema.blips.id, peek.blipId))
      .for('update');
    const [existing] = await tx
      .select()
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, commentId))
      .limit(1);
    if (!existing) throw notFound('Comment not found');
    const access = await requireRadar(existing.radarId, actor, 'read', tx);
    // After the read, so a comment on a radar the caller cannot see is still a
    // 404; before the author rule, so a read-only connection hears which scope
    // it lacks rather than a 404 about a comment it can plainly read.
    requireScopeWithinGrants(actor, 'write', 'delete a comment');
    if (!canDelete(existing, access, actor)) {
      throw existing.authorId === actor.user.id
        ? forbidden(NOT_YOUR_WORDS)
        : notFound('Comment not found');
    }
    /*
      A reply the client may have read leaves a record of what it said
      (qa-reviewer, slice 2). Written in this transaction and *not* through
      `recordAudit`'s fail-open savepoint: if the record cannot be written, the
      reply is not deleted. The approved hash travels with the text, so the
      record also proves the text is the one that was released.
    */
    if (existing.visibility === 'client') {
      await tx.insert(schema.auditLog).values(
        auditRow(actor, 'comment.delete', 'comment', existing.id, {
          blipId: existing.blipId,
          radarId: existing.radarId,
          visibility: existing.visibility,
          body: existing.body,
          releasedBodySha256: existing.releasedBodySha256,
          releasedAt: existing.releasedAt?.toISOString() ?? null,
          releasedBy: existing.releasedBy,
          ...(existing.externalAuthor ? { externalAuthor: existing.externalAuthor } : {}),
        }),
      );
    }
    await tx.delete(schema.blipComments).where(eq(schema.blipComments.id, existing.id));
    return existing;
  });
  if (deleted.visibility !== 'client')
    await recordAudit(actor, 'comment.delete', 'comment', deleted.id, {
      blipId: deleted.blipId,
      ...(deleted.visibility !== 'internal' ? { visibility: deleted.visibility } : {}),
    });
}

import { enqueueSubscriptionEvent, kickSubscriptionDeliveries } from './subscriptions.js';
import { remindersFor, syncBlipReminders } from './reminders.js';
import { idempotencySubject, withIdempotency } from './idempotency.js';
import { cachedForRadar, invalidateRadarStats, invalidateRadarStatsSoon } from './stats-cache.js';
/** Blip lifecycle: capture, stream, search, triage, move. */
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  archiveMoment,
  archiveWindow,
  archivesFor,
  assignableFor,
  ARCHIVABLE_STATES,
  ARCHITECTURE_ADR_LANES,
  ARCHIVING_TEMPLATE_IDS,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  deriveBlipKind,
  extractInlineTags,
  findStatus,
  firstUrl,
  headingTitle,
  laneForState,
  isElementLane,
  laneMoveAllowed,
  laneRank,
  LIMITS,
  ratifiedLane,
  normalizeTags,
  uniqueTags,
  orderFor,
  resolveStatus,
  soleUrl,
  statusesFor,
  supersededLane,
  templateFor,
  type AttachmentDto,
  type BlipDto,
  type BlipHolderDto,
  type ClaimBlipInput,
  type ExternalMarking,
  type BlipReactionDto,
  type BlipState,
  type CreateBlipInput,
  type ListBlipsQuery,
  type PageDto,
  type AgentDto,
  type MentionDto,
  type SearchHas,
  type SmartFilter,
  type StreamOrder,
  type TemplateSource,
  type UpdateBlipInput,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, conflict, notFound, type Actor } from '../http.js';
import { DEAD_LETTER_AT, enqueue, drainOne, registerOutboxHandler } from './outbox.js';
import {
  neverPublic,
  radarReaders,
  reachableAgentQuery,
  readableRadarIdsFor,
  requireRadar,
  type HelpdeskAccess,
  type NativeSupportAccess,
  type GuestSupportAccess,
  type RadarAccess,
  type RadarRow,
} from './access.js';
import { agentsByIds, authorshipOf, isHumanSession, writeAsAgent } from './agents.js';
import { historyFor, setEditor } from './blip-history.js';
import { recordAudit } from './audit.js';
import {
  decodeCursor,
  encodeCursor,
  isCursorInt,
  isCursorReal,
  isCursorTimestamp,
  isCursorUuid,
} from './cursor.js';
import { commentCounts, lastActivityFor } from './comments.js';
import { enqueueNotificationEvent, isExternalDelivery } from './notifications.js';
import { requestMarkings, threadClocks } from './helpdesk-projection.js';
import { mentionsFor, reconcileMentions } from './mentions.js';
import { reactionsFor } from './reactions.js';
import { isPublicOnly, narrowBlip } from './redaction.js';
import { assertUploadable, headObject, isIssuedAttachmentKey } from './storage.js';
import { cleanupStorageKeys } from './storage-cleanup.js';
import { emailSummary } from './email-summary.js';
import { unfurl } from './unfurl.js';
import {
  assertAdrAcceptable,
  assertCharterReady,
  assertNotCharterPage,
  charterIsOneDocument,
  lockCharter,
  sealAfterLaneChange,
} from './charter.js';
import { retryOnConflict } from '../errors.js';
import { rehomeAnchors } from './charter-ops.js';
import { asStored } from '../db/stored.js';
import { textValue } from '../text-value.js';

type BlipRow = typeof schema.blips.$inferSelect;
type AttachmentRow = typeof schema.attachments.$inferSelect;

/* -------------------------------- cursors -------------------------------- */

interface Cursor {
  pinned: boolean;
  createdAt: string;
  id: string;
  /**
   * The blip's lane position, for the two orders that sort by lane.
   *
   * Carried in the cursor rather than recomputed from the row, because the
   * keyset comparison has to name every key of the ORDER BY or it stops being
   * total. Absent from a cursor issued before lane ordering existed, and from
   * every cursor issued for capture order — 0 in both cases, which is exactly
   * what capture order compares against anyway.
   */
  rank: number;
  /**
   * When the thread was last answered, for `discussion` order only.
   *
   * The one key in this application that is **mutable**: a reply moves it. The
   * keyset stays total — every key runs the same direction and `id` cannot tie,
   * so a row that sits still can neither duplicate nor be skipped — but a thread
   * somebody answers mid-scroll genuinely moves and can be met twice or missed.
   * That is inherent to activity ordering rather than a defect here, and it is
   * the price of the thing that makes a forum a forum. Absent from every cursor
   * issued for any other order, where it falls back to `createdAt`.
   */
  activityAt: string;
  /**
   * The relevance score, for the `relevance` order only — and, like every other
   * timestamp here, **rendered by Postgres and handed straight back**.
   *
   * `ts_rank_cd` returns a `real`. Round-tripping one through a JavaScript
   * number and back is the float twin of the microsecond bug this file already
   * carries a warning about: the value that comes out is not always the value
   * that went in, and the comparison is `<`, so the boundary row is either
   * served twice or skipped in silence. Postgres renders a `real` with the
   * shortest text that reads back to the same bits, so `::text` out and `::real`
   * in is lossless — which is the only reason the keyset stays total.
   *
   * Absent from every cursor issued for any other order: '0' then, and unread.
   */
  score: string;
  /** Leading membership key for contextual search; the fingerprint binds its meaning. */
  priority?: 0 | 1;
  priorityKey?: string;
}

/**
 * Timestamps travel as **Postgres text, never as a JS Date**.
 *
 * `timestamptz` carries microseconds; a JS `Date` carries milliseconds and drops
 * the rest without complaint. A cursor built from `Date.toISOString()` therefore
 * names an instant fractionally before the row it came from, and these
 * comparisons are `<` — so any row whose timestamp falls in that sub-millisecond
 * gap is **silently skipped**. Two blips captured in the same millisecond is not
 * a hypothetical: a paste of several links, or a webhook burst, does it.
 *
 * The ascending twin of this bug in `services/comments.ts` repeats a row instead
 * of skipping one, which is how it was found — a skip leaves nothing behind to
 * notice. Rendering with `::text` and handing the value straight back is lossless
 * and leaves the ORDER BY untouched.
 */
function encodeStreamCursor(
  row: BlipRow,
  rank: number,
  createdAt: string,
  activityAt: string,
  score: string,
  priority?: { value: 0 | 1; key: string },
): string {
  return encodeCursor({
    pinned: row.pinned,
    createdAt,
    id: row.id,
    rank,
    activityAt,
    score,
    ...(priority ? { priority: priority.value, priorityKey: priority.key } : {}),
  });
}

/**
 * Decode legacy stream keys and optional contextual-search priority. Unchanged
 * searches keep accepting their old cursors; a newly prioritized search needs
 * a first page because an old cursor cannot describe its membership boundary.
 */
function decodeStreamCursor(raw: string): Cursor | null {
  const parsed = decodeCursor(raw) as Partial<Record<keyof Cursor, unknown>> | null;
  if (!parsed) return null;
  if (!isCursorTimestamp(parsed.createdAt) || !isCursorUuid(parsed.id)) return null;
  // Absent keys predate their sort order and are filled below; present ones are
  // cast in SQL and must be what the encoder wrote.
  if (parsed.rank !== undefined && !isCursorInt(parsed.rank)) return null;
  if (parsed.activityAt !== undefined && !isCursorTimestamp(parsed.activityAt)) return null;
  if (parsed.score !== undefined && !isCursorReal(parsed.score)) return null;
  if (parsed.priority !== undefined && parsed.priority !== 0 && parsed.priority !== 1) return null;
  if (
    parsed.priorityKey !== undefined &&
    (typeof parsed.priorityKey !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.priorityKey))
  )
    return null;
  return {
    pinned: parsed.pinned === true,
    createdAt: parsed.createdAt,
    id: parsed.id,
    rank: parsed.rank ?? 0,
    activityAt: parsed.activityAt ?? parsed.createdAt,
    score: parsed.score ?? '0',
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    ...(parsed.priorityKey !== undefined ? { priorityKey: parsed.priorityKey } : {}),
  };
}

/* ---------------------------------- DTOs --------------------------------- */

function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    width: row.width,
    height: row.height,
    href: `/api/attachments/${row.id}`,
  };
}

type AuthorRow = { id: string; name: string | null; email: string };
type AuthorSummary = AuthorRow | null;

function toBlipDto(
  row: BlipRow,
  attachments: AttachmentRow[],
  author: AuthorSummary,
  extras: {
    email?: BlipDto['email'];
    reminder?: BlipDto['reminder'];
    commentCount?: number;
    reactions?: BlipReactionDto[];
    supersededBy?: { id: string; title: string | null } | null;
    supersedesTitle?: string | null;
    lastActivityAt?: Date;
    /**
     * When this blip aged out, or null while it is live. Computed by `hydrate`
     * from the radar's window — see `archivedExpr` for the SQL half of the same
     * rule, and `archive.test.ts` for the assertion that pins them together.
     */
    archivedAt?: string | null;
    mentions?: MentionDto[];
    /** An unfurl for this blip is queued or running. */
    previewPending?: boolean;
    /**
     * The agent that captured this, when one did. Resolved by `hydrate` in one
     * round trip for the whole page, exactly like the author.
     *
     * `null` covers two different things and deliberately does not distinguish
     * them: a person typed it, or an agent typed it and the persona has since
     * been deleted along with its owner's account. `agentVoice` survives the
     * second case and is what tells them apart for anybody who needs to.
     */
    agent?: AgentDto | null;
    /** A client's request through the portal, and its ball-in-court clock (slice 3). */
    external?: ExternalMarking;
    awaitingClientSince?: Date | null;
    /** Who holds the card and the live claim, resolved by `hydrate` (omitted publicly). */
    assignee?: BlipHolderDto | undefined;
    claim?: (BlipHolderDto & { until: string }) | undefined;
    /** From the revision log, for signed-in readers (`historyFor`). */
    lastEditedBy?: BlipDto['lastEditedBy'];
    lastMovedBy?: BlipDto['lastMovedBy'];
  } = {},
): BlipDto {
  return {
    revision: row.revision,
    ...(extras.assignee ? { assignee: extras.assignee } : {}),
    ...(extras.claim ? { claim: extras.claim } : {}),
    ...(extras.lastEditedBy ? { lastEditedBy: extras.lastEditedBy } : {}),
    ...(extras.lastMovedBy ? { lastMovedBy: extras.lastMovedBy } : {}),
    ...(extras.external
      ? {
          external: extras.external,
          awaitingClientSince: extras.awaitingClientSince?.toISOString() ?? null,
        }
      : {}),
    id: row.id,
    dueAt: row.dueAt?.toISOString() ?? null,
    ...(extras.reminder !== undefined ? { reminder: extras.reminder } : {}),
    ...(extras.email ? { email: extras.email } : {}),
    radarId: row.radarId,
    kind: row.kind,
    state: row.state,
    status: row.status,
    supersedes: row.supersedesId,
    supersedesTitle: extras.supersedesTitle ?? null,
    supersededBy: extras.supersededBy ?? null,
    title: row.title,
    body: row.body,
    url: row.url,
    preview: row.preview ?? null,
    ...(extras.previewPending ? { previewPending: true as const } : {}),
    tags: row.tags,
    pinned: row.pinned,
    attachments: attachments.map(toAttachmentDto),
    commentCount: extras.commentCount ?? 0,
    // Falls back to the blip's own creation, which is what "nobody has replied"
    // means and what the ordering expression computes for the same row.
    lastActivityAt: (extras.lastActivityAt ?? row.createdAt).toISOString(),
    archivedAt: extras.archivedAt ?? null,
    reactions: extras.reactions ?? [],
    // Omitted rather than sent empty, like `commentCount` and `reactions`.
    ...(extras.mentions && extras.mentions.length > 0 ? { mentions: extras.mentions } : {}),
    author,
    // Both, always, in both voices. The voice decides which name the byline
    // leads with; it never decides what is recorded. See `services/agents.ts`.
    agent: extras.agent ?? null,
    voice: row.agentVoice ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One round trip per aggregate for a whole page, rather than N per blip.
 *
 * `viewerId` is what decides `mine` on each reaction. It is threaded through
 * every read path rather than fetched from ambient state, so the public routes —
 * which have no viewer — get honest counts with nothing marked as theirs.
 */
async function hydrate(
  rows: BlipRow[],
  viewerId: string | null = null,
  /** The agent reading, when it is one: its reactions, not its owner's, are `mine`. */
  agentId: string | null = null,
): Promise<BlipDto[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const blipIds = rows.map((r) => r.id);
  const authorIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.authorId, r.assigneeUserId, r.claimedByUserId])
        .filter((v): v is string => v !== null),
    ),
  ];

  const supersededIds = [
    ...new Set(rows.map((r) => r.supersedesId).filter((v): v is string => v !== null)),
  ];
  // Retired personas included: this read renders what an agent already wrote,
  // and withdrawing a name from future use does not erase it from the past.
  // With a viewer, each agent carries its owner and whether the viewer may open
  // it — the byline card. Without one (a public page) neither: owner ids never
  // appear on a public page.
  const agents = await agentsByIds(
    [
      ...new Set(
        rows
          .flatMap((r) => [r.agentId, r.assigneeAgentId, r.claimedByAgentId])
          .filter((v): v is string => v !== null),
      ),
    ],
    viewerId ?? undefined,
  );

  /*
    The radars this page came from, but only when some row on it could possibly
    have aged out. `archivedAt` is derived from the radar's template and window
    (see `archivedExpr`), and a page spanning forty radars — a search, a tag
    page, a smart radar — needs all of them; a page of live work needs none, so
    the usual case pays nothing at all.
  */
  const terminalRadarIds = [
    ...new Set(
      rows
        .filter((r) => (ARCHIVABLE_STATES as readonly string[]).includes(r.state))
        .map((r) => r.radarId),
    ),
  ];
  const windows = new Map<string, number>();
  if (terminalRadarIds.length > 0) {
    const radarRows = await db
      .select({
        id: schema.radars.id,
        template: schema.radars.template,
        archiveAfterDays: schema.radars.archiveAfterDays,
      })
      .from(schema.radars)
      .where(inArray(schema.radars.id, terminalRadarIds));
    for (const radar of radarRows) windows.set(radar.id, windowOf(radar));
  }
  const now = new Date();
  // Assignee and claim are read only where the radar's template is `assignable` (a stored one on
  // another template is ignored, not deleted), and never on a public page: user ids stay private.
  const heldRadarIds = viewerId
    ? [
        ...new Set(
          rows
            .filter((r) => r.assigneeUserId || r.assigneeAgentId || r.claimedUntil)
            .map((r) => r.radarId),
        ),
      ]
    : [];
  const assignableRadars = new Set<string>();
  if (heldRadarIds.length > 0) {
    const held = await db
      .select({ id: schema.radars.id, template: schema.radars.template })
      .from(schema.radars)
      .where(inArray(schema.radars.id, heldRadarIds));
    for (const radar of held) if (assignableFor(radar.template)) assignableRadars.add(radar.id);
  }

  const history = await historyFor(rows, viewerId);

  const [
    attachmentRows,
    authorRows,
    comments,
    reactions,
    replacements,
    replaced,
    activity,
    mentions,
    emailRows,
    reminderRows,
    pendingPreviews,
    markings,
  ] = await Promise.all([
    db.select().from(schema.attachments).where(inArray(schema.attachments.blipId, blipIds)),
    authorIds.length > 0
      ? db
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, authorIds))
      : Promise.resolve([] as AuthorRow[]),
    commentCounts(blipIds),
    reactionsFor(blipIds, viewerId, agentId),
    // "What replaced this?" — one query for the whole page, served by the
    // partial index. Doing it per card would be N queries; doing it in the
    // client would silently show nothing whenever the replacement landed on the
    // next page, which on a chronicle-ordered log is most of the time: the two
    // ends of a supersession sit in different lanes by construction.
    db
      .select({
        id: schema.blips.id,
        title: schema.blips.title,
        supersedesId: schema.blips.supersedesId,
      })
      .from(schema.blips)
      .where(inArray(schema.blips.supersedesId, blipIds)),
    // ...and "what did this replace?", for the readable half of the forward
    // link. Skipped entirely when nothing on the page replaces anything, which
    // is every page of every radar that is not a log.
    supersededIds.length > 0
      ? db
          .select({ id: schema.blips.id, title: schema.blips.title })
          .from(schema.blips)
          .where(inArray(schema.blips.id, supersededIds))
      : Promise.resolve([] as Array<{ id: string; title: string | null }>),
    // Computed rather than read off the blip — see `lastActivityExpr` for why
    // there is no `last_activity_at` column to read.
    lastActivityFor(blipIds),
    mentionsFor('blip', blipIds),
    db.select().from(schema.blipEmails).where(inArray(schema.blipEmails.blipId, blipIds)),
    remindersFor(rows, viewerId),
    previewsPending(rows),
    requestMarkings(blipIds),
  ]);
  // The clock is asked only about the requests on this page, which on most
  // pages is none.
  const clocks = await threadClocks(blipIds.filter((id) => markings.has(id)));

  const byBlip = new Map<string, AttachmentRow[]>();
  for (const row of attachmentRows) {
    const list = byBlip.get(row.blipId) ?? [];
    list.push(row);
    byBlip.set(row.blipId, list);
  }
  const emails = new Map(emailRows.map((row) => [row.blipId, row]));
  const emailFor = (blipId: string, notes: string) => {
    const email = emails.get(blipId);
    return email ? { email: emailSummary(email, notes) } : {};
  };
  const authors = new Map(authorRows.map((a) => [a.id, a]));
  // Last writer wins if two blips claim to replace the same one. Nothing stops
  // that — it is a judgement, not a constraint — and showing one pointer is
  // better than showing none.
  const replacedBy = new Map(
    replacements
      .filter((r): r is typeof r & { supersedesId: string } => r.supersedesId !== null)
      .map((r) => [r.supersedesId, { id: r.id, title: r.title }]),
  );
  const replacedTitles = new Map(replaced.map((r) => [r.id, r.title]));
  const holder = (userId: string | null, agentId: string | null): BlipHolderDto | undefined => {
    if (!userId && !agentId) return undefined;
    const person = userId ? authors.get(userId) : undefined;
    return {
      userId,
      agentId,
      name:
        (agentId ? agents.get(agentId)?.name : undefined) ?? person?.name ?? person?.email ?? null,
    };
  };

  return rows.map((row) =>
    toBlipDto(
      row,
      byBlip.get(row.id) ?? [],
      row.authorId ? (authors.get(row.authorId) ?? null) : null,
      {
        ...emailFor(row.id, row.emailNotes),
        ...(viewerId ? { reminder: reminderRows.get(row.id) ?? null } : {}),
        commentCount: comments.get(row.id) ?? 0,
        reactions: reactions.get(row.id) ?? [],
        supersededBy: replacedBy.get(row.id) ?? null,
        supersedesTitle: row.supersedesId ? (replacedTitles.get(row.supersedesId) ?? null) : null,
        lastActivityAt: activity.get(row.id) ?? row.createdAt,
        archivedAt: archivedAtOf(row, windows.get(row.radarId) ?? 0, activity.get(row.id), now),
        mentions: mentions.get(row.id) ?? [],
        previewPending: pendingPreviews.has(row.id),
        agent: row.agentId ? (agents.get(row.agentId) ?? null) : null,
        ...history.get(row.id),
        ...(assignableRadars.has(row.radarId)
          ? {
              assignee: holder(row.assigneeUserId, row.assigneeAgentId),
              claim:
                row.claimedUntil && row.claimedUntil > now
                  ? withUntil(holder(row.claimedByUserId, row.claimedByAgentId), row.claimedUntil)
                  : undefined,
            }
          : {}),
        ...withMarking(markings.get(row.id), clocks.get(row.id)?.awaitingClientSince ?? null),
      },
    ),
  );
}

function withUntil(holder: BlipHolderDto | undefined, until: Date) {
  return holder ? { ...holder, until: until.toISOString() } : undefined;
}

function withMarking(
  external: ExternalMarking | undefined,
  awaitingClientSince: Date | null,
): { external?: ExternalMarking; awaitingClientSince?: Date | null } {
  return external ? { external, awaitingClientSince } : {};
}

/**
 * Link blips on this page whose unfurl is still queued or running.
 *
 * Computed from the outbox rather than stored: a job is deleted when it
 * finishes (found a preview or not), so "a live unfurl job names this blip" is
 * exactly "the preview is not settled yet". Dead-lettered jobs are parked at
 * the far-future `run_after` and do not count — nothing will ever finish them.
 * Only rows that could be waiting are asked about, so a page with no bare link
 * pays nothing; the outbox holds only unfinished work and stays small.
 */
async function previewsPending(rows: BlipRow[]): Promise<Set<string>> {
  const waiting = rows.filter((row) => row.url && !row.preview).map((row) => row.id);
  if (waiting.length === 0) return new Set();
  const result = await getDb().execute<{ blip_id: string }>(sql`
    SELECT DISTINCT payload->>'blipId' AS blip_id FROM outbox
    WHERE kind = 'unfurl'
      AND payload->>'blipId' = ANY(${sql`ARRAY[${sql.join(
        waiting.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]`})
      AND run_after < ${DEAD_LETTER_AT}::timestamptz
  `);
  return new Set(result.rows.map((row) => row.blip_id));
}

/* --------------------------------- reads --------------------------------- */

/** `search` is a GENERATED column, absent from the drizzle table; name it in raw SQL. */
function textSearch(term: string): SQL {
  // `websearch_to_tsquery` accepts what a person actually types — quoted
  // phrases, OR, a leading minus — without ever raising a syntax error.
  return sql`${schema.blips}.search @@ websearch_to_tsquery('english', ${term})`;
}

function tagArray(tags: string[]): SQL {
  return sql`ARRAY[${sql.join(
    tags.map((tag) => sql`${tag}`),
    sql`, `,
  )}]::text[]`;
}

function filters(query: ListBlipsQuery): SQL[] {
  const clauses: SQL[] = [];
  if (query.state) clauses.push(eq(schema.blips.state, query.state));
  // Layered with `state`, not instead of it: asking for both is an intersection,
  // which is what "active, but only the ones still in the inbox" would mean.
  if (query.states?.length) clauses.push(inArray(schema.blips.state, query.states));
  if (query.kind) clauses.push(eq(schema.blips.kind, query.kind));
  if (query.status) clauses.push(eq(schema.blips.status, query.status));
  if (query.tag) {
    const tag = normalizeTags([query.tag])[0];
    if (tag) clauses.push(sql`${schema.blips.tags} @> ARRAY[${tag}]::text[]`);
  }
  if (query.q?.trim()) clauses.push(textSearch(query.q.trim()));
  return clauses;
}

/* ------------------------- the universal search --------------------------- */

/**
 * Everything the search grammar can ask for beyond what a radar's own filter bar
 * can, already resolved: `in:` and `from:` have been turned into ids by
 * `services/search.ts`, which is the only place authorization is decided.
 *
 * These arrive here as *data*, never as text. Nothing in this shape is
 * interpolated into SQL as a string — the ids are bound parameters and the
 * enum-ish values were validated by `parseSearchQuery` against closed sets.
 */
export type SearchPredicate =
  | { field: 'radar' | 'author' | 'topic' | 'template'; values: string[] }
  | {
      field: 'tag' | 'state' | 'kind' | 'after' | 'before' | 'touched' | 'stale';
      value: string;
    }
  | { field: 'has'; value: SearchHas }
  | { field: 'pinned' | 'archived'; value: boolean };

export interface SearchFilterGroup {
  /** All groups intersect; alternatives within a group are a union. */
  any: SearchPredicate[];
  negated: boolean;
}
export interface SearchFilters {
  groups: SearchFilterGroup[];
}

// Lexical URL presence, not a network check. Require a host/address start and a
// scheme boundary so protocol examples and xmailto: text are not links.
const BODY_LINK_PATTERN = String.raw`(^|[^[:alnum:]_])(https?://([[:alnum:]][[:alnum:].-]*|\[[0-9a-f:.]+\])|mailto:[[:alnum:]._%+-]+@[[:alnum:]][[:alnum:].-]*)`;

/** Unreachable for a typed caller; a value that arrives anyway matches nothing. */
function unknownHas(_value: never): SQL {
  return sql`FALSE`;
}

function searchPredicate(predicate: SearchPredicate): SQL {
  switch (predicate.field) {
    case 'radar':
      return inArray(schema.blips.radarId, predicate.values);
    case 'author':
      return inArray(schema.blips.authorId, predicate.values);
    case 'topic':
      return sql`${schema.blips.radarId} IN (SELECT ${schema.radars.id} FROM ${schema.radars} WHERE ${inArray(schema.radars.topicId, predicate.values)})`;
    case 'template':
      return sql`${schema.blips.radarId} IN (SELECT ${schema.radars.id} FROM ${schema.radars} WHERE ${inArray(schema.radars.template, predicate.values)})`;
    case 'tag':
      return sql`${schema.blips.tags} @> ARRAY[${predicate.value}]::text[]`;
    case 'state':
      return sql`${schema.blips.state} = ${predicate.value}`;
    case 'kind':
      return sql`${schema.blips.kind} = ${predicate.value}`;
    case 'pinned':
      return eq(schema.blips.pinned, predicate.value);
    case 'archived':
      return predicate.value ? archivedExpr : liveExpr;
    case 'has': {
      // Every value named, none as the fall-through: an unknown one used to
      // read as `comment` rather than as the mistake it was.
      const has = predicate.value;
      switch (has) {
        case 'link':
          return sql`(${schema.blips.url} IS NOT NULL OR ${schema.blips.body} ~* ${BODY_LINK_PATTERN} OR ${schema.blips.emailNotes} ~* ${BODY_LINK_PATTERN})`;
        case 'attachment':
          return sql`EXISTS (SELECT 1 FROM ${schema.attachments} WHERE ${schema.attachments.blipId} = ${schema.blips.id})`;
        case 'comment':
          return sql`EXISTS (SELECT 1 FROM ${schema.blipComments} WHERE ${schema.blipComments.blipId} = ${schema.blips.id})`;
        default:
          return unknownHas(has);
      }
    }
    case 'after':
      return sql`${schema.blips.createdAt} >= ${predicate.value}::timestamptz`;
    case 'before':
      return sql`${schema.blips.createdAt} < ${predicate.value}::timestamptz`;
    case 'touched':
      return sql`GREATEST(${schema.blips.updatedAt}, ${lastActivityExpr}) >= ${predicate.value}::timestamptz`;
    case 'stale':
      return sql`GREATEST(${schema.blips.updatedAt}, ${lastActivityExpr}) < ${predicate.value}::timestamptz`;
  }
}

function searchFilters(search: SearchFilters): SQL[] {
  return search.groups.map((group) => {
    const matches = or(...group.any.map(searchPredicate)) ?? sql`FALSE`;
    // A missing author/optional field is a non-match, including under negation.
    return group.negated ? sql`NOT COALESCE((${matches}), FALSE)` : matches;
  });
}

/** Shared pre-pagination WHERE for search pages and aggregate widgets. */
export function buildBlipFilterClauses(
  radarIds: string[],
  query: ListBlipsQuery,
  saved: SmartFilter | null = null,
  search?: SearchFilters,
): SQL[] {
  const clauses: SQL[] = [
    inArray(schema.blips.radarId, radarIds),
    ...(saved ? savedFilters(saved) : []),
    ...filters(query),
    ...(search ? searchFilters(search) : []),
  ];
  // Ordinary radar streams hide aged-out rows. Universal search/aggregates span them.
  if (!search && query.includeArchived !== true) clauses.push(liveExpr);
  return clauses;
}

/**
 * How well a row answers the words, for the relevance order.
 *
 * `ts_rank_cd` rather than `ts_rank`: cover density counts how close the matched
 * lexemes sit to each other, which is what makes a blip whose title *is* the
 * phrase beat one that happens to use both words four paragraphs apart. The
 * weights come from the GENERATED column — title A, tags B, url C, body D — so
 * the ranking honours the same judgement the schema already made about which
 * part of a blip is most itself.
 *
 * The array is `{D, C, B, A}`, which is the order Postgres reads it in.
 *
 * Weights alone were not enough: unnormalised, thirty long bodies that repeat
 * "rate limiter" each summed past a title that *is* "rate limiter design". So the
 * rank is squashed into [0, 1) (flags 1|32: damp by document length, then
 * x/(x+1)), and a row whose title holds every word of the query gets +1 on top.
 * Body rank can therefore never outweigh a title match, only order within one.
 * `term` is the parsed free text (filters already lifted out); `::real` keeps
 * the sum the same type the cursor compares it as.
 */
function scoreExpr(term: string): SQL {
  const tsq = sql`websearch_to_tsquery('english', ${term})`;
  /*
    A blip captured without a heading has a NULL title, yet reads as named by its
    first line. The boost reads that name by the rule `headingTitle` uses: the first
    non-blank line, heading marks off, and only when it is short enough to be a title
    (a longer one is a paragraph, and must not out-rank a real title; 255 is the
    most a Postgres regex repeat takes, a little under `LIMITS.blipTitle`). Row-wise on
    rows the GIN index already matched, so it never decides which rows are scanned.
  */
  const first = `^(?:#{1,6}[[:space:]]+)?([^\\n]{1,255})(?:\\n|$)`;
  const name = sql`coalesce(nullif(${schema.blips.title}, ''), substring(btrim(${schema.blips.body}, E' \n\t\r') from ${first}::text))`;
  return sql`(ts_rank_cd(ARRAY[0.1, 0.3, 0.6, 1.0], ${schema.blips}.search, ${tsq}, 33) + CASE WHEN to_tsvector('english', ${name}) @@ ${tsq} THEN 1 ELSE 0 END)::real`;
}

/**
 * The saved query behind a smart radar, as SQL.
 *
 * These are layered *under* whatever the caller also asked for, so filtering a
 * smart radar narrows it rather than escaping it.
 */
function savedFilters(saved: SmartFilter): SQL[] {
  const clauses: SQL[] = [];
  // A saved filter written by an older build may predate `tags` being required.
  const tags = normalizeTags([...(asStored(saved.tags) ?? [])]);
  if (tags.length > 0) {
    // `@>` is "has all of", `&&` is "has any of" — both served by blips_tags_idx.
    clauses.push(
      saved.match === 'all'
        ? sql`${schema.blips.tags} @> ${tagArray(tags)}`
        : sql`${schema.blips.tags} && ${tagArray(tags)}`,
    );
  }
  if (saved.states?.length) clauses.push(inArray(schema.blips.state, saved.states));
  if (saved.kinds?.length) clauses.push(inArray(schema.blips.kind, saved.kinds));
  if (saved.q?.trim()) clauses.push(textSearch(saved.q.trim()));
  return clauses;
}

/* --------------------------------- scope --------------------------------- */

/**
 * Which rows a radar's stream is made of.
 *
 * A standard radar is its own id and nothing else. A smart radar owns no rows at
 * all: it is a saved tag query, and it is resolved **against the caller's own
 * readable radars, never the owner's**.
 *
 * That is the whole security argument for smart radars. Two people looking at
 * the same shared smart radar legitimately see different blips, because each is
 * seeing their own material through the same lens. Resolving against the owner
 * would turn "share a smart radar" into "hand over read access to every private
 * radar I own that happens to carry the tag", which nobody would expect from a
 * saved search. It is also why a smart radar can never be made public: a public
 * reader has no readable radars, so the only non-empty answer would be somebody
 * else's — refused in `setVisibility` and again by a CHECK constraint.
 */
export interface BlipScope {
  radarIds: string[];
  saved: SmartFilter | null;
}

export async function resolveRadarScope(
  access: RadarAccess,
  actor: Actor | null,
): Promise<BlipScope> {
  if (access.radar.kind !== 'smart') return { radarIds: [access.radar.id], saved: null };
  if (!actor) return { radarIds: [], saved: null };

  const saved = access.radar.filter ?? null;
  let radarIds = await readableRadarIdsFor(actor);
  if (saved?.radarIds?.length) {
    // Intersect, never union: naming a radar in the filter can only narrow what
    // the caller could already read.
    const allowed = new Set(saved.radarIds);
    radarIds = radarIds.filter((id) => allowed.has(id));
  }
  // A smart radar holds no rows of its own, so including it (or any other smart
  // radar) in the IN list would only cost a scan.
  const smart = await getDb()
    .select({ id: schema.radars.id })
    .from(schema.radars)
    .where(and(inArray(schema.radars.id, radarIds), eq(schema.radars.kind, 'smart')));
  const exclude = new Set(smart.map((r) => r.id));
  return { radarIds: radarIds.filter((id) => !exclude.has(id)), saved };
}

/** The one entry point for "the blips of this radar", standard or smart. */
export async function radarStream(
  access: RadarAccess,
  actor: Actor | null,
  query: ListBlipsQuery,
): Promise<PageDto<BlipDto>> {
  const scope = await resolveRadarScope(access, actor);
  const page = await listBlips(
    scope.radarIds,
    isPublicOnly(access) ? { ...query, includeArchived: false } : query,
    scope.saved,
    actor?.user.id ?? null,
    // Smart or standard, the radar's own template decides the order.
    access.radar,
    { agentId: actor?.agent?.agentId ?? null },
  );
  // A caller holding only the public link gets the same narrowing the public
  // route applies, because it is the *access* that is public and not the route:
  // `/api/radars/<slug>/blips` and `read_radar` over MCP both land here, and
  // both used to answer with each author's address.
  if (!isPublicOnly(access)) return page;
  return { ...page, items: page.items.map(narrowBlip) };
}

/**
 * The lane rank of a row, as SQL: a CASE over `blips.status` built straight from
 * the template's declared lane order.
 *
 * `sign` is how a descending ORDER BY is made to read ascending. Row-value
 * keyset comparison only works when every key sorts the same way, so `chronicle`
 * — which wants lanes ascending and time descending — negates the rank and
 * sorts the whole tuple descending instead of mixing directions. `queue` wants
 * both ascending and needs no such trick.
 */
function rankExpr(lanes: readonly { id: string }[], sign: 1 | -1): SQL {
  const whens = lanes.map((lane, index) => sql`WHEN ${lane.id} THEN ${sign * index}::int`);
  return sql`(CASE ${schema.blips.status} ${sql.join(whens, sql` `)} ELSE ${sign * lanes.length}::int END)`;
}

/** The same number for a row already in hand, so the cursor agrees with the SQL. */
function rankOf(row: BlipRow, order: StreamOrder, template: TemplateSource | null): number {
  if (order === 'captured') return 0;
  const rank = laneRank(template?.template, row.status, template?.templateConfig);
  return order === 'chronicle' || order === 'discussion' ? -rank : rank;
}

/**
 * When a thread was last answered: its newest comment, or its own creation when
 * nobody has replied.
 *
 * **Computed, never stored.** A `blips.last_activity_at` column would have to be
 * maintained on comment insert *and* on comment delete *and* on a blip moving
 * radar, and the first time one of those paths forgot, a radar would sort itself
 * wrongly with nothing to say why. It is the same argument the schema already
 * makes for `blips.search` being GENERATED rather than trigger-maintained, and
 * for the topic cascade being read at authorization time rather than written
 * into `radar_members`: a derived value that is computed cannot drift from its
 * source.
 *
 * The cost is honest and bounded — a correlated subquery served by
 * `blip_comments_blip_idx`, on radars that hold tens to low hundreds of threads.
 * That is the same trade already taken knowingly for the CASE-based lane orders.
 */
const lastActivityExpr = sql`COALESCE((
  SELECT MAX(${schema.blipComments.createdAt})
  FROM ${schema.blipComments}
  WHERE ${schema.blipComments.blipId} = ${schema.blips.id}
), ${schema.blips.createdAt})`;

/* -------------------------------- the archive ---------------------------- */

/**
 * "This blip has aged out of its radar", as one SQL expression.
 *
 * **The single spelling of the rule.** Every place that hides the archive, shows
 * it, or counts it uses this expression — the stream's WHERE, the lane counts,
 * the state chips, the tag chips, the radar's blip count and `is:archived` in
 * the universal search. Two spellings of "archived" is how a lane header comes
 * to say a number the column underneath it disagrees with.
 *
 * Read it as the definition it is:
 *
 *  - the blip is finished (`done` or `dropped`) — unfinished work never ages out,
 *    however long it has sat there, because a stale Backlog is a fact about you
 *    and hiding it would be the app taking a view;
 *  - its radar is on a template that declares `archives` — built from the
 *    registry, so `templates.ts` stays the one place that question is answered;
 *  - that radar's window is on (`0` means never, NULL means take the default);
 *  - and nothing has happened to the row for that many days.
 *
 * "Nothing has happened" is `GREATEST(updated_at, lastActivity)`, and those two
 * are exactly the three resurrection triggers the design asks for. Editing bumps
 * `updated_at`. Moving a card bumps `updated_at`. Commenting moves
 * `lastActivity`. So **activity resurrects a blip as a consequence of the
 * definition, not as an event handler somebody has to remember to call** — which
 * is the whole reason there is no `blips.archived_at` column to keep in step.
 *
 * ## What it costs
 *
 * A correlated EXISTS on `radars` (a primary-key lookup) plus the same comment
 * subquery the discussion order already pays, and only ever on rows that are
 * already `done` or `dropped` — `blips_terminal_activity_idx` is the partial
 * index for exactly that set. On a template that does not archive the whole
 * expression is short-circuited by the `template IN (...)` test, so the hot
 * capture-order path on a stream, a microblog or a discussion is byte-for-byte
 * the query it was.
 */
export const archivedExpr: SQL = sql`(
  ${schema.blips.state} IN (${sql.join(
    ARCHIVABLE_STATES.map((state) => sql`${state}`),
    sql`, `,
  )})
  AND EXISTS (
    SELECT 1 FROM ${schema.radars} ar
    WHERE ar.id = ${schema.blips.radarId}
      AND ar.template IN (${sql.join(
        ARCHIVING_TEMPLATE_IDS.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND COALESCE(ar.archive_after_days, ${sql.raw(String(DEFAULT_ARCHIVE_AFTER_DAYS))}) > 0
      AND GREATEST(${schema.blips.updatedAt}, ${lastActivityExpr})
          + make_interval(days => COALESCE(ar.archive_after_days, ${sql.raw(
            String(DEFAULT_ARCHIVE_AFTER_DAYS),
          )}))
          <= now()
  )
)`;

/** The complement, spelled once so no caller writes `NOT (...)` for itself. */
export const liveExpr: SQL = sql`NOT ${archivedExpr}`;

/**
 * The window a radar actually applies, resolved off the registry and the row.
 *
 * The JS half of the rule above. It exists because the DTO has to carry
 * `archivedAt` — a client cannot evaluate a SQL expression — and the two are
 * pinned together by `archive.test.ts`, which asserts over a real database that
 * every blip the SQL hides is exactly a blip this reports as archived.
 */
function windowOf(radar: { template: string | null; archiveAfterDays: number | null }): number {
  return archiveWindow(archivesFor(radar.template), radar.archiveAfterDays);
}

/** `archivedAt` for one row, reported only once the moment has actually passed. */
function archivedAtOf(
  row: BlipRow,
  windowDays: number,
  lastActivityAt: Date | undefined,
  now: Date,
): string | null {
  const moment = archiveMoment({
    state: row.state,
    windowDays,
    updatedAt: row.updatedAt,
    lastActivityAt: lastActivityAt ?? null,
  });
  return moment && moment.getTime() <= now.getTime() ? moment.toISOString() : null;
}

/**
 * The stream, in whichever order the radar's template asks for, paginated by
 * keyset so that capturing a new blip mid-scroll cannot duplicate or skip a row
 * the way an OFFSET would.
 *
 * Three orders, and the reason they are not one:
 *
 *  - `captured` — pinned, then newest first. The hot path (every stream, every
 *    board, every microblog, every smart radar, every public page), served by
 *    `blips_radar_stream_idx (radar_id, pinned DESC, created_at DESC, id DESC)`:
 *    the ORDER BY walks the index and the cursor is an index condition, so a
 *    page reads one page of rows. Before 0034 it was a top-N sort over the whole
 *    radar — 213 ms a page at 270 000 blips, against 0.07 ms now. A new sort
 *    key here needs the index extended to match, or it silently goes back to
 *    sorting everything.
 *  - `queue` — lane order, then oldest first. A reading list is worked through
 *    from the front.
 *  - `chronicle` — lane order, then newest first. A log leads with what is live.
 *
 * The last two sort on a CASE expression and so cannot use an index at all;
 * they are declared by templates whose radars hold tens to low hundreds of
 * blips, which is the trade being made knowingly rather than by omission.
 */
export async function listBlips(
  radarIds: string[],
  query: ListBlipsQuery,
  saved: SmartFilter | null = null,
  /** Whose reactions count as `mine`. Null on the public routes, which have no viewer. */
  viewerId: string | null = null,
  /**
   * The radar whose lane order to read in — its template *and* whatever lane
   * vocabulary it has been given, because a radar with custom lanes sorts by
   * those and a cursor issued against the registry's would rank rows wrongly.
   * Passed as the pair rather than as a template id so the second half cannot be
   * forgotten at a call site.
   *
   * Null means capture order — which is what every cross-radar caller (the tag
   * page, `search_blips`) gets, because a lane order borrowed from one radar is
   * meaningless in another. A smart radar is not one: it has a template of its
   * own and is read in that order.
   */
  template: TemplateSource | null = null,
  /**
   * The universal search's extra predicates and its ordering.
   *
   * Bolted on here rather than given a query function of its own, and
   * deliberately: a second listing function would be a second cursor
   * implementation, a second hydrate, and a second place for the microsecond
   * bug to come back. `services/search.ts` composes the filters and calls this.
   */
  extra: {
    search?: SearchFilters;
    relevance?: boolean;
    /** Already authorized exact membership; a leading sort key, never a WHERE restriction. */
    priority?: BlipScope & { key: string };
    /** The reading agent, for `mine` on reactions (the same identity `setReaction` writes as). */
    agentId?: string | null;
  } = {},
): Promise<PageDto<BlipDto> & { preferredBlipIds?: string[] }> {
  if (radarIds.length === 0) return { items: [], nextCursor: null };

  if (query.sort === 'updated' || query.updatedSince) {
    const clauses = buildBlipFilterClauses(radarIds, query, saved, extra.search);
    if (query.updatedSince) {
      if (!Number.isFinite(Date.parse(query.updatedSince)))
        throw badRequest('Invalid updatedSince timestamp');
      clauses.push(sql`${schema.blips.updatedAt} > ${query.updatedSince}::timestamptz`);
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (
      query.cursor &&
      (!cursor ||
        cursor['sort'] !== 'updated' ||
        !isCursorTimestamp(cursor['updatedAt']) ||
        !isCursorUuid(cursor['id']) ||
        cursor['since'] !== (query.updatedSince ?? null))
    )
      throw badRequest('Invalid updated cursor');
    if (cursor)
      clauses.push(
        sql`(${schema.blips.updatedAt},${schema.blips.id}) > (${cursor['updatedAt']}::timestamptz,${cursor['id']}::uuid)`,
      );
    const limit = Math.min(query.limit ?? LIMITS.pageSize, LIMITS.maxPageSize);
    // Read the timestamp and row in the same statement, preserving PG microseconds.
    const rows = await getDb()
      .select({ blip: schema.blips, updatedAt: sql<string>`${schema.blips.updatedAt}::text` })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(sql`${schema.blips.updatedAt} ASC`, sql`${schema.blips.id} ASC`)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await hydrate(
        page.map((r) => r.blip),
        viewerId,
        extra.agentId ?? null,
      ),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              sort: 'updated',
              updatedAt: last.updatedAt,
              id: last.blip.id,
              since: query.updatedSince ?? null,
            })
          : null,
    };
  }

  const lanes = statusesFor(template?.template, template?.templateConfig);
  // A template can only sort by lane if it has lanes. Falling back rather than
  // throwing keeps a mis-declared registry entry from taking the radar down.
  const term = query.q?.trim() ?? '';
  /*
    Relevance is only ever asked for by the universal search, and only when there
    are words to be relevant to: `in:x is:done` has nothing to rank, so it falls
    back to capture order, which is both the right answer and the cheaper one.
  */
  const order: StreamOrder | 'relevance' =
    extra.relevance && term
      ? 'relevance'
      : lanes.length === 0
        ? 'captured'
        : orderFor(template?.template);

  const limit = Math.min(query.limit ?? LIMITS.pageSize, LIMITS.maxPageSize);
  const clauses = buildBlipFilterClauses(radarIds, query, saved, extra.search);

  const cursor = query.cursor ? decodeStreamCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw badRequest('Invalid cursor');
  if (
    cursor &&
    (extra.priority
      ? cursor.priorityKey !== extra.priority.key || cursor.priority === undefined
      : cursor.priorityKey !== undefined)
  ) {
    throw badRequest('Search context changed. Start again from the first page.');
  }
  let priority: SQL<number> | null = null;
  if (extra.priority) {
    const membership = extra.priority.radarIds.length
      ? (and(
          inArray(schema.blips.radarId, extra.priority.radarIds),
          ...(extra.priority.saved ? savedFilters(extra.priority.saved) : []),
        ) ?? sql`false`)
      : sql`false`;
    priority = sql<number>`CASE WHEN ${membership} THEN 1 ELSE 0 END`;
  }
  const preferredBlipIds = new Set<string>();

  const db = getDb();
  // Built once and used by both the ORDER BY and the cursor keys below, so the
  // number the cursor carries is by construction the number that was sorted
  // on. Two spellings of "the score" is how a keyset stops being total.
  const score = order === 'relevance' ? scoreExpr(term) : null;
  /*
    The boundary row's sort keys, rendered by Postgres in the same statement
    that sorted the page — so no precision is lost on the way into the cursor
    (see `encodeStreamCursor`), and there is no second read to race. A second
    SELECT of the last row used to find nothing if it was deleted in between,
    which ended the stream with rows left, and in discussion order could read an
    activity time newer than the one the page was sorted by.
  */
  const keys = {
    createdAtText: sql<string>`${schema.blips.createdAt}::text`,
    // Only `discussion` compares on this key; every other order carries the
    // creation time, which is what its cursor has always meant.
    activityAtText:
      order === 'discussion'
        ? sql<string>`(${lastActivityExpr})::text`
        : sql<string>`${schema.blips.createdAt}::text`,
    // Never recomputed in JavaScript — see the note on `Cursor.score`.
    scoreText: score ? sql<string>`(${score})::text` : sql<string>`'0'::text`,
  };
  type PageRow = {
    blip: BlipRow;
    createdAtText: string;
    activityAtText: string;
    scoreText: string;
  };
  let rows: PageRow[];

  if (priority) {
    // One leading membership key, then the same within-group order as global
    // search. The WHERE tuple and ORDER BY use every key in the same direction.
    if (cursor)
      clauses.push(
        score
          ? sql`(${priority},${score},${schema.blips.createdAt},${schema.blips.id}) < (${cursor.priority}::int,${cursor.score}::real,${cursor.createdAt}::timestamptz,${cursor.id}::uuid)`
          : sql`(${priority},${schema.blips.pinned},${schema.blips.createdAt},${schema.blips.id}) < (${cursor.priority}::int,${cursor.pinned},${cursor.createdAt}::timestamptz,${cursor.id}::uuid)`,
      );
    const selected = await db
      .select({ blip: schema.blips, ...keys, priority })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(
        sql`${priority} DESC`,
        score ? sql`${score} DESC` : desc(schema.blips.pinned),
        desc(schema.blips.createdAt),
        desc(schema.blips.id),
      )
      .limit(limit + 1);
    rows = selected.map(({ priority: membership, ...row }) => {
      if (membership === 1) preferredBlipIds.add(row.blip.id);
      return row;
    });
  } else if (order === 'relevance' && score) {
    /*
      Descending throughout, and `pinned` is deliberately **not** a key.

      A pin is a statement about one radar's own stream — "keep this at the top
      of *this* board" — and carrying it into a search across forty radars would
      float somebody's pinned shopping list above the exact phrase they typed.
      Dropping it costs nothing: (score, created_at, id) is still total, because
      `id` is the primary key and cannot tie.
    */
    if (cursor) {
      clauses.push(
        sql`(${score}, ${schema.blips.createdAt}, ${schema.blips.id}) < (${cursor.score}::real, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    rows = await db
      .select({ blip: schema.blips, ...keys })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(
        sql`${score} DESC`,
        sql`${schema.blips.createdAt} DESC`,
        sql`${schema.blips.id} DESC`,
      )
      .limit(limit + 1);
  } else if (order === 'queue') {
    // Ascending throughout, so `pinned DESC` is expressed as `NOT pinned ASC`.
    const rank = rankExpr(lanes, 1);
    if (cursor) {
      clauses.push(
        sql`(NOT ${schema.blips.pinned}, ${rank}, ${schema.blips.createdAt}, ${schema.blips.id}) > (${!cursor.pinned}, ${cursor.rank}::int, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    rows = await db
      .select({ blip: schema.blips, ...keys })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(
        sql`NOT ${schema.blips.pinned} ASC`,
        sql`${rank} ASC`,
        sql`${schema.blips.createdAt} ASC`,
        sql`${schema.blips.id} ASC`,
      )
      .limit(limit + 1);
  } else if (order === 'chronicle') {
    // Descending throughout; the rank is negated so lanes still read forwards.
    const rank = rankExpr(lanes, -1);
    if (cursor) {
      clauses.push(
        sql`(${schema.blips.pinned}, ${rank}, ${schema.blips.createdAt}, ${schema.blips.id}) < (${cursor.pinned}, ${cursor.rank}::int, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    rows = await db
      .select({ blip: schema.blips, ...keys })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(
        sql`${schema.blips.pinned} DESC`,
        sql`${rank} DESC`,
        sql`${schema.blips.createdAt} DESC`,
        sql`${schema.blips.id} DESC`,
      )
      .limit(limit + 1);
  } else if (order === 'discussion') {
    // Structurally `chronicle`, with the activity time standing in for the
    // creation time: descending throughout, rank negated so lanes read forwards.
    // What it buys is the one thing Wave never had — the thread somebody just
    // answered is the thread at the top of the page.
    const rank = rankExpr(lanes, -1);
    if (cursor) {
      clauses.push(
        sql`(${schema.blips.pinned}, ${rank}, ${lastActivityExpr}, ${schema.blips.id}) < (${cursor.pinned}, ${cursor.rank}::int, ${cursor.activityAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    rows = await db
      .select({ blip: schema.blips, ...keys })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(
        sql`${schema.blips.pinned} DESC`,
        sql`${rank} DESC`,
        sql`${lastActivityExpr} DESC`,
        sql`${schema.blips.id} DESC`,
      )
      .limit(limit + 1);
  } else {
    if (cursor) {
      // Row-value comparison matches the ORDER BY exactly, which is what makes
      // the keyset total: no two rows can tie on (pinned, created_at, id).
      clauses.push(
        sql`(${schema.blips.pinned}, ${schema.blips.createdAt}, ${schema.blips.id}) < (${cursor.pinned}, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    rows = await db
      .select({ blip: schema.blips, ...keys })
      .from(schema.blips)
      .where(and(...clauses))
      .orderBy(desc(schema.blips.pinned), desc(schema.blips.createdAt), desc(schema.blips.id))
      .limit(limit + 1);
  }

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeStreamCursor(
          last.blip,
          rankOf(last.blip, order === 'relevance' ? 'captured' : order, template),
          last.createdAtText,
          last.activityAtText,
          last.scoreText,
          extra.priority
            ? { value: preferredBlipIds.has(last.blip.id) ? 1 : 0, key: extra.priority.key }
            : undefined,
        )
      : null;

  return {
    items: await hydrate(
      page.map((row) => row.blip),
      viewerId,
      extra.agentId ?? null,
    ),
    nextCursor,
    ...(extra.priority
      ? {
          preferredBlipIds: page
            .filter((row) => preferredBlipIds.has(row.blip.id))
            .map((row) => row.blip.id),
        }
      : {}),
  };
}

export async function getBlip(blipId: string, actor: Actor | null): Promise<BlipDto> {
  const rows = await getDb()
    .select()
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Blip not found');
  await requireRadar(row.radarId, actor, 'read');
  const [dto] = await hydrate([row], actor?.user.id ?? null, actor?.agent?.agentId ?? null);
  if (!dto) throw notFound('Blip not found');
  return dto;
}

/* --------------------------------- writes -------------------------------- */

type CaptureTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Internal hooks keep ingress receipt claims in the same commit as the blip. */
export interface CaptureOptions {
  beforeInsert?: (tx: CaptureTransaction) => Promise<void>;
  afterInsert?: (tx: CaptureTransaction, blipId: string) => Promise<void>;
  /**
   * Runs straight after the blip row exists, before attachments or any other write that a
   * concurrent twin of this request could collide with (an attachment's object key is unique).
   * An `Idempotency-Key` is recorded here, so the loser of a race waits on the key and replays
   * the winner rather than failing on a later unique constraint.
   */
  arbitrate?: (tx: CaptureTransaction, blipId: string) => Promise<void>;
  /** Service-only: the title, decided inside the transaction (an Architecture ADR is numbered there). */
  titleFor?: (tx: CaptureTransaction) => Promise<string>;
  /** Durable outbox work is picked up by the worker instead of blocking a batch import or an agent's write. */
  deferDelivery?: boolean;
  /** Called when an `idempotencyKey` made this call a replay of an earlier one. */
  onReplay?: () => void;
  /**
   * The proof an integration may write here, from `requireHelpdeskRadar` — the
   * only way a portal request reaches this function, since `requireRadar`
   * refuses an integration outright. Taken instead of authorizing again, never
   * beside it.
   */
  helpdesk?: HelpdeskAccess;
  nativeSupport?: NativeSupportAccess;
  guestSupport?: GuestSupportAccess;
  /** Ingress may cancel attachment verification before capture commits. */
  signal?: AbortSignal | undefined;
  /**
   * Whether the body is the caller's own words. Stored on the blip as
   * `authored`, so a later move remembers it.
   *
   * True by default for a person or an agent writing, **false for a webhook
   * delivery** (inbound email, a radar webhook), and a feed import says false
   * explicitly because it captures as the feed's owner. Text somebody else
   * wrote:
   *
   * - **never addresses anybody** — an `@alice` in a feed item would otherwise
   *   notify Alice as if the radar's owner had called her in. The words stay;
   *   the handle does not resolve, now or when the blip is moved;
   * - **keeps its first `LIMITS.tagsPerBlip` hashtags** rather than refusing the
   *   capture. Refusing would lose an email or re-fail a feed item forever over
   *   somebody else's tagging; the rest stay readable in the body.
   */
  authored?: boolean;
  /**
   * Service-only (never in a request schema): file straight into a ratified
   * lane, stamping this as `ratified_at`. The architecture import uses it to
   * keep a repository's history; nothing else may enter a ratified lane but by
   * the move `decide_adr` makes.
   */
  ratifiedAt?: Date;
  /**
   * Service-only: file into an element lane (a boundary or a contract). Only
   * `upsert_boundary` and `upsert_contract` may; every other way in is refused.
   */
  element?: boolean;
  /**
   * The template the caller checked before writing architecture data. Re-checked
   * against the locked row, and it takes the shared settings lock (see `createBlip`).
   */
  requireTemplate?: string;
}

/**
 * Capture infers tags, links and kind; only a real Markdown heading becomes a title.
 *
 * With `input.idempotencyKey` a retry returns the blip the first call made (see
 * `services/idempotency.ts`); the key is recorded in the capture's own transaction.
 */
export async function createBlip(
  actor: Actor,
  radarId: string,
  input: CreateBlipInput,
  options: CaptureOptions = {},
): Promise<BlipDto> {
  const { idempotencyKey, ...rest } = input;
  const subject = idempotencySubject(actor, 'blip.create', radarId, idempotencyKey, rest);
  if (!subject) return createBlipOnce(actor, radarId, input, options);
  return withIdempotency(
    subject,
    (record) =>
      createBlipOnce(actor, radarId, input, {
        ...options,
        arbitrate: async (tx, blipId) => {
          await record(tx, blipId);
          await options.arbitrate?.(tx, blipId);
        },
      }),
    (blipId) => getBlip(blipId, actor),
    options.onReplay,
  );
}

async function createBlipOnce(
  actor: Actor,
  radarId: string,
  input: CreateBlipInput,
  options: CaptureOptions,
): Promise<BlipDto> {
  // A load session names the agent this write is under (§V2.5); resolved here,
  // in the service, so REST and MCP bind it identically.
  actor = await writeAsAgent(actor, input.session);
  if (
    options.nativeSupport &&
    (actor.kind !== 'user' ||
      actor.agent ||
      options.nativeSupport.requester.id !== actor.user.id ||
      options.helpdesk)
  )
    throw notFound('Radar not found');
  if (
    actor.kind === 'guest' &&
    (!options.guestSupport ||
      options.guestSupport.actor.user.id !== actor.user.id ||
      options.nativeSupport ||
      options.helpdesk ||
      actor.agent ||
      actor.connection ||
      actor.sessionId)
  )
    throw notFound('Radar not found');
  if (options.guestSupport && actor.kind !== 'guest') throw notFound('Radar not found');
  const proof = options.helpdesk ?? options.nativeSupport ?? options.guestSupport;
  const access = proof ? proof.access : await requireRadar(radarId, actor, 'write');
  if (proof && access.radar.id !== radarId) throw notFound('Radar not found');
  // A smart radar is a lens, not a container — it owns no rows, so there is
  // nowhere for this blip to go. Say where it should go instead.
  if (access.radar.kind === 'smart') {
    throw badRequest(
      `"${access.radar.name}" is a smart radar — a saved search, not a container. ` +
        'Capture into a real radar and tag it, and it will show up here.',
    );
  }
  const db = getDb();

  const body = (input.body ?? '').trim();
  // A body that is nothing but a URL *is* the link, so it must not also count as
  // text when deciding the kind — otherwise pasting a URL yields a 'note'.
  const bodyIsBareUrl = input.url == null && soleUrl(body) !== null;
  // A template can widen that rule. On a reading list the URL is the object and
  // the prose around it is your reason for saving it, so the link is pulled out
  // of a body that also carries text — and the blip is a link with a note, not a
  // note that mentions a link. Read off the registry, never off a template id:
  // the day a second template wants this it declares `capture.linkFirst` and
  // nothing here changes.
  const linkFirst = templateFor(access.radar.template).capture.linkFirst === true;
  const url = input.url ?? soleUrl(body) ?? (linkFirst ? firstUrl(body) : null);
  const attachments = input.attachments ?? [];

  // Text that arrived from outside — a webhook, inbound email, a client through
  // the portal — is never the owner's words, so it addresses nobody.
  const authored = options.authored ?? !isExternalDelivery(actor);
  const tags = blipTags([...(input.tags ?? []), ...extractInlineTags(body)], authored);
  const kind =
    input.kind ??
    deriveBlipKind({
      // `linkFirst` says the same thing `bodyIsBareUrl` says, one step further
      // out: on this template a body carrying a URL is a link whatever else is
      // in it. Without this the note would win the heuristic and the card would
      // lose its source facet — the same failure as the bare-URL bug, and it
      // would look identical.
      body: bodyIsBareUrl || (linkFirst && url && !input.url) ? '' : body,
      url,
      attachmentContentTypes: attachments.map((a) => a.contentType),
    });

  // Only an actual markdown heading becomes a title. Deriving one from the first
  // sentence of a long body just prints the same words twice.
  const title = input.title ?? headingTitle(body);

  // Refused here, before the storage round-trips, when the lane is plainly
  // wrong; decided for real inside the transaction, against the locked row.
  captureLane(access.radar, input);
  let supersedesId: string | null = null;

  // Every attachment is validated and HEADed *before* anything is written, so a
  // storage failure refuses the capture instead of committing a blip whose
  // files then quietly are not there.
  const attachmentRows =
    attachments.length > 0
      ? await resolveAttachments(access.radar.id, attachments, options.signal)
      : [];

  // One transaction, because a blip and its attachments are one thing somebody
  // captured. Unwrapped, a failure on the second half left a blip with its
  // images missing and a request reporting 400 — so the person retried, and
  // every retry orphaned another. There is no I/O inside here: the S3
  // round-trips already happened above.
  /*
    Both authorship columns, decided in one place and read from the actor alone.

    `authorshipOf` is the only expression in this application that produces an
    `agent_id` for a write, and it takes nothing from the request but the voice
    the caller asked for — a two-value enum that cannot name a principal. So a
    human authoring under an agent's name is not forbidden, it is unsayable.

    It also refuses rather than downgrades: a connection granted only its own
    voice that asks to write as the human is told so, and **nothing is
    written**. That refusal happens here, before the transaction, so the
    capture does not half-happen.
  */
  const { agentId, agentVoice } = authorshipOf(actor, input.as);

  const notificationJobs: string[] = [];
  let unfurlJob: string | undefined;
  const blip = await db.transaction(async (tx) => {
    /*
      A caller that writes architecture data (an element, a seam, an ADR with
      markers) names the template it expects. It takes the settings lock
      `updateRadar` holds exclusively, shared, as the first thing in the
      transaction and before any row lock: a template change waits for this write
      to commit and then sees it (`template_locked`). Callers that name no template
      (an RSS import already holds the row for share in `beforeInsert`) never take it,
      so no caller can hold a row lock and then wait for it.
    */
    if (options.requireTemplate)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`radar-settings:${access.radar.id}`}, 0))`,
      );
    await options.beforeInsert?.(tx);
    /*
      The lane is decided against the radar row **key-share locked**, not the
      copy read before the transaction. A lane edit takes the row FOR UPDATE and
      checks for stranded blips in the same transaction as its write, so the two
      serialise: either this capture commits first and the edit sees the blip
      and refuses, or the edit commits first and this capture resolves against
      the new lanes. Read unlocked, a capture could commit into a lane an edit
      had just removed — a blip on no column of the board.
    */
    const locked = await lockRadarForShare(tx, access.radar.id);
    if (!locked) throw notFound('Radar not found');
    // Against the locked row, not the copy read earlier: the caller may have checked a template
    // that has since changed, in which case both copies read as the new one.
    if (options.requireTemplate && locked.template !== options.requireTemplate)
      throw conflict(`This radar is no longer on the ${options.requireTemplate} template.`);
    const { status, lane } = captureLane(locked, input);
    if (!options.ratifiedAt && !options.element) assertEntry(access.radar, status);
    const rule = ratifiedLane(access.radar.template, access.radar.templateConfig);
    if (rule && status === 'charter') throw charterIsOneDocument();
    const ratifies = rule !== null && status === rule.id;
    supersedesId = await checkSupersedes(access.radar, input.supersedes, null, tx);
    const [inserted] = await tx
      .insert(schema.blips)
      .values({
        radarId: access.radar.id,
        authorId: actor.kind === 'guest' ? null : actor.user.id,
        agentId,
        agentVoice,
        kind,
        state: input.state ?? lane?.state ?? 'inbox',
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        status,
        supersedesId,
        ratifiedAt: ratifies ? (options.ratifiedAt ?? new Date()) : null,
        title: options.titleFor ? await options.titleFor(tx) : title,
        body,
        url: url ?? null,
        tags,
        authored,
        pinned: input.pinned ?? false,
      })
      .returning();
    if (!inserted) throw new Error('blip insert returned no row');
    await options.arbitrate?.(tx, inserted.id);

    if (attachmentRows.length > 0) {
      await tx
        .insert(schema.attachments)
        .values(attachmentRows.map((row) => ({ ...row, blipId: inserted.id })));
      // The upload is spent: `update_blip` must not take it again once this card goes.
      await tx.delete(schema.uploadTickets).where(
        inArray(
          schema.uploadTickets.objectKey,
          attachmentRows.map((row) => row.objectKey),
        ),
      );
    }
    // Deferred on a ratifying template: filed when the replacement is accepted.
    if (!rule || ratifies) {
      if (actor.kind !== 'guest') await setEditor(tx, actor.user.id, agentId);
      await applySupersession(actor, access.radar, supersedesId, inserted.id, tx);
    }
    if (url) unfurlJob = await enqueue(tx, 'unfurl', { blipId: inserted.id, url });
    const { newlyMentioned } = authored
      ? await reconcileMentions(
          access.radar,
          { blipId: inserted.id },
          inserted.body,
          actor.user.id,
          actor.agent?.agentId ?? null,
          tx,
        )
      : { newlyMentioned: [] };
    if (newlyMentioned.length > 0)
      notificationJobs.push(
        await enqueueNotificationEvent(tx, {
          type: 'mention',
          actor,
          radarId: access.radar.id,
          blipId: inserted.id,
          commentId: null,
          body: inserted.body,
          mentioned: newlyMentioned,
        }),
      );
    notificationJobs.push(
      await enqueueNotificationEvent(tx, {
        type: 'blip',
        actor,
        radarId: access.radar.id,
        blipId: inserted.id,
      }),
    );
    await enqueueSubscriptionEvent(tx, actor, access.radar, 'blip.created', inserted);
    await options.afterInsert?.(tx, inserted.id);
    return inserted;
  });
  (actor.connection ? invalidateRadarStatsSoon : invalidateRadarStats)(access.radar.id);
  if (!options.deferDelivery) kickSubscriptionDeliveries();
  if (unfurlJob && !options.deferDelivery) void drainOne(unfurlJob).catch(() => undefined);

  // The radar's "last touched" ordering should follow its contents. Only to the minute:
  // on a busy radar every capture writing the same row is a queue of writers for a
  // value nobody can see change, so the touch is skipped while the stored one is fresh.
  await db
    .update(schema.radars)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(schema.radars.id, access.radar.id),
        sql`${schema.radars.updatedAt} < now() - interval '60 seconds'`,
      ),
    );

  await recordAudit(actor, 'blip.create', 'blip', blip.id, {
    radarId: access.radar.id,
    kind,
    ...(actor.webhookId ? { webhookId: actor.webhookId } : {}),
    ...(actor.integrationId ? { integrationId: actor.integrationId } : {}),
  });

  // Fan-out runs after commit; a lost inline attempt remains durable for the worker.
  if (!options.deferDelivery) for (const job of notificationJobs) await drainOne(job);

  const [dto] = await hydrate([blip], actor.user.id, actor.agent?.agentId ?? null);
  if (!dto) throw new Error('blip vanished after insert');
  return dto;
}

/**
 * Validates each uploaded object actually exists, and prepares its row.
 *
 * Deliberately does **no writing**, and is called *before* the blip is
 * inserted. It used to run after, unwrapped, which meant a MinIO outage
 * committed the blip, dropped its attachments, and then 400'd the request — so
 * the person retried, and every retry orphaned another blip nobody could see
 * had happened. Doing the network round-trips first means a storage failure
 * refuses the capture before any row exists, and the insert that follows has no
 * I/O left in it to fail on.
 *
 * `headObject` now distinguishes an absent object from unreachable storage, so
 * only the first is reported as the caller's mistake.
 */
async function resolveAttachments(
  radarId: string,
  refs: NonNullable<CreateBlipInput['attachments']>,
  signal?: AbortSignal,
): Promise<Omit<typeof schema.attachments.$inferInsert, 'blipId'>[]> {
  // The key must be one we issued for *this* radar; otherwise a caller could
  // attach somebody else's object by guessing its key. Checked for every ref
  // before any storage round-trip.
  if (refs.some((ref) => !isIssuedAttachmentKey(radarId, ref.key))) {
    throw badRequest('That upload does not belong to this radar');
  }
  // One HEAD per file, all at once: a capture of ten photos waited on ten
  // sequential round-trips to storage.
  const heads = await Promise.all(refs.map((ref) => headObject(ref.key, signal)));
  return refs.map((ref, i) => {
    const head = heads[i];
    if (!head) throw badRequest(`Upload "${ref.filename}" was not completed`);
    assertUploadable(head.contentType, head.size);
    return {
      radarId,
      objectKey: ref.key,
      filename: ref.filename,
      contentType: head.contentType || ref.contentType,
      size: head.size,
      width: ref.width ?? null,
      height: ref.height ?? null,
    };
  });
}

/**
 * The radar row, locked FOR KEY SHARE for the rest of the transaction, and read
 * after the lock is granted.
 *
 * KEY SHARE is the lock the blip's own foreign key would take at the insert —
 * taken here instead, *before* the lanes are read, so there is no gap between
 * reading them and holding the row. Any number of captures hold it at once, and
 * it leaves ordinary updates of the radar (its `updated_at`) alone; only a lane
 * edit's FOR UPDATE (`updateRadar`) waits for it, and it for that. Every caller
 * passes an id: a row's own `radar_id`, or one `idSchema` has validated.
 */
async function lockRadarForShare(
  db: CaptureTransaction,
  radarId: string,
): Promise<RadarRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.radars)
    .where(eq(schema.radars.id, radarId))
    .for('key share');
  return row;
}

/**
 * The lane a new blip lands in, and the lane it takes its triage state from.
 *
 * The radar's template decides which lane a new blip lands in, and the lane
 * decides its triage state unless the caller said otherwise — so a card added
 * to a board's Backlog is still an Inbox item, and one added straight to Done
 * is not.
 */
function captureLane(
  radar: RadarRow,
  input: Pick<CreateBlipInput, 'status' | 'state'>,
): { status: string | null; lane: ReturnType<typeof findStatus> } {
  assertLane(radar, input.status, input.state);
  let status = resolveStatus(radar.template, input.status, null, radar.templateConfig);
  let lane = findStatus(radar.template, status, radar.templateConfig);
  // Captured straight into a state the default lane contradicts — an agent
  // filing something already handled as `state:'done'`. The board must not show
  // it in Backlog; same repair as `updateBlip`, and for the same reason.
  if (input.state !== undefined && input.status === undefined && lane?.state !== input.state) {
    const target = laneForState(radar.template, input.state, radar.templateConfig);
    if (target) {
      status = target.id;
      lane = target;
    }
  }
  return { status, lane };
}

/**
 * An explicitly named lane the template does not have is a mistake worth saying
 * out loud. `resolveStatus` degrades an unknown status to null, which is right
 * for a value already stored through a template change and wrong for one a
 * caller just supplied — there, silence means the card quietly leaves the board
 * and the caller is told nothing. Agents guess lane ids; this is what tells them
 * the vocabulary instead of dropping the write.
 */
/**
 * A blip's tag set: normalised, de-duplicated, and within the per-blip limit.
 *
 * Past the limit, the caller's own words are refused with the tags that would
 * not fit, rather than cut short silently — a `#tag` somebody typed and then
 * cannot find is the failure. Somebody else's words (`authored` false) keep the
 * first ones written; see `CaptureOptions.authored`.
 */
function blipTags(raw: readonly string[], authored: boolean): string[] {
  const tags = uniqueTags(raw);
  if (tags.length <= LIMITS.tagsPerBlip || !authored) return tags.slice(0, LIMITS.tagsPerBlip);
  const over = tags.slice(LIMITS.tagsPerBlip).map((tag) => `#${tag}`);
  throw badRequest(
    `A blip carries at most ${LIMITS.tagsPerBlip} tags, and this one would have ${tags.length}. ` +
      `${over.join(', ')} ${over.length === 1 ? 'does' : 'do'} not fit — remove some, or fold them together.`,
  );
}

/* ------------------- ratifying templates (the architecture radar) ---------- */

/** Lanes a blip can be created or moved into: those no transition leads to. */
function assertEntry(radar: RadarRow, status: string | null): void {
  if (isElementLane(radar.template, status, radar.templateConfig))
    throw new ApiError(
      409,
      'element_lane',
      `"${status ?? ''}" is written by upsert_boundary and upsert_contract on "${radar.name}", not captured or moved by hand.`,
    );
  const moves = templateFor(radar.template, radar.templateConfig).transitions;
  if (moves && status && Object.values(moves).some((to) => to.includes(status)))
    throw new ApiError(
      409,
      'lane_move_refused',
      `Nothing is created or moved straight into "${status}" on "${radar.name}". Propose it, then decide it.`,
    );
}

function assertLaneMove(radar: RadarRow, from: string | null, to: string | null): void {
  if (!laneMoveAllowed(radar.template, from, to))
    throw new ApiError(
      409,
      'lane_move_refused',
      `A blip cannot go from "${from ?? 'no lane'}" to "${to ?? 'no lane'}" on "${radar.name}". ` +
        'Proposed goes to accepted or rejected, accepted to repealed; the charter stays put.',
    );
}

/**
 * An ADR that has an amendment in the charter or that amends an element, and an element
 * that something amends or that has seams, can be neither deleted nor moved. A contract's own
 * seams go with it when it is deleted.
 */
async function assertUnanchored(
  db: Pick<Db, 'select'>,
  blip: Pick<BlipRow, 'id' | 'radarId' | 'status' | 'ratifiedAt'>,
  radar: RadarRow,
  action: 'delete' | 'move',
): Promise<void> {
  // Relations and element rows belong to the blip, not to the radar's template:
  // a radar switched to another template and back must not let them be cut or
  // carried across radars, so these checks run whatever the template is now.
  const links = await db
    .select({ from: schema.blipRelations.fromBlipId, kind: schema.blipRelations.kind })
    .from(schema.blipRelations)
    .where(
      or(eq(schema.blipRelations.fromBlipId, blip.id), eq(schema.blipRelations.toBlipId, blip.id)),
    );
  const [element] = await db
    .select({ id: schema.blipElements.blipId })
    .from(schema.blipElements)
    .where(eq(schema.blipElements.blipId, blip.id))
    .limit(1);
  if (
    action === 'move' &&
    (element || isElementLane(radar.template, blip.status, radar.templateConfig))
  )
    throw new ApiError(
      409,
      'anchored',
      'A boundary or contract belongs to the radar it is drawn on and cannot be moved to another.',
    );
  if (action === 'delete' && links.some((l) => l.kind === 'seam_side' && l.from !== blip.id))
    throw new ApiError(
      409,
      'boundary_in_use',
      'This boundary still has seams. Delete or repoint its contracts first.',
    );
  const linked = links.some((l) => action === 'move' || l.kind === 'amends');
  let named = false;
  if (
    ratifiedLane(radar.template, radar.templateConfig) &&
    ARCHITECTURE_ADR_LANES.some((lane) => lane === blip.status)
  ) {
    // An ADR with an amendment (anchored, or orphaned and waiting) stays. A dismissed one is history.
    await assertCharterReady(db, blip.radarId);
    // A ratified ADR (accepted, then maybe repealed or superseded) is part of the decision log: the
    // sealed versions of the charter render its replacement text from its anchor rows, which go
    // with it when it is deleted (or re-homed, when it is moved), so history would change. Repeal it.
    if (blip.ratifiedAt) {
      const [held] = await db
        .select({ id: schema.charterAnchors.id })
        .from(schema.charterAnchors)
        .where(
          and(
            eq(schema.charterAnchors.subjectId, blip.id),
            eq(schema.charterAnchors.kind, 'amend'),
          ),
        )
        .limit(1);
      if (action === 'delete' || held)
        throw new ApiError(
          409,
          'ratified',
          action === 'delete'
            ? 'A ratified ADR is part of the decision log and cannot be deleted. Repeal it instead; the charter keeps its history.'
            : 'A ratified ADR that amended the charter cannot be moved to another radar. Repeal it instead; the charter keeps its history.',
        );
    }
    const [hit] = await db
      .select({ id: schema.charterAnchors.id })
      .from(schema.charterAnchors)
      .where(
        and(
          eq(schema.charterAnchors.subjectId, blip.id),
          eq(schema.charterAnchors.kind, 'amend'),
          ne(schema.charterAnchors.state, 'dismissed'),
        ),
      )
      .limit(1);
    named = Boolean(hit);
  }
  // A boundary or contract with a passage of the charter linked to it keeps its link: the words
  // are still there. Once they are gone (orphaned, or unlinked) the element can be deleted and
  // its links go with it.
  if (action === 'delete' && !named && !linked) {
    const [link] = await db
      .select({ id: schema.charterAnchors.id })
      .from(schema.charterAnchors)
      .where(
        and(
          eq(schema.charterAnchors.subjectId, blip.id),
          eq(schema.charterAnchors.kind, 'link'),
          eq(schema.charterAnchors.state, 'anchored'),
        ),
      )
      .limit(1);
    named = Boolean(link);
  }
  if (named || linked)
    throw new ApiError(
      409,
      'anchored',
      'This blip carries, is named by, or is linked to an amendment or a charter passage. Repeal or reject the ADR, or unlink the passage, instead.',
    );
}

function assertLane(radar: RadarRow, status: string | null | undefined, state?: BlipState): void {
  if (status === undefined || status === null) return;
  const lane = findStatus(radar.template, status, radar.templateConfig);
  if (lane) {
    // A lane and a state that disagree would leave the board and the counts describing one card two
    // ways. The template says what each lane means; to restore a state no lane carries (dropped on a
    // board), send the state alone.
    if (state !== undefined && lane.state !== state) {
      const want = laneForState(radar.template, state, radar.templateConfig);
      throw badRequest(
        `Lane "${lane.label}" (${lane.id}) means state "${lane.state}". Send state "${lane.state}", ` +
          (want ? `move to "${want.label}" for "${state}", ` : `send state "${state}" alone, `) +
          'or send only one of them.',
      );
    }
    return;
  }
  const lanes = statusesFor(radar.template, radar.templateConfig);
  throw badRequest(
    lanes.length === 0
      ? `"${radar.name}" is a ${templateFor(radar.template).label} radar and has no lanes.`
      : `"${status}" is not a lane on "${radar.name}". Use one of: ${lanes.map((l) => l.id).join(', ')}.`,
  );
}

/**
 * Validates "this blip replaces that one" and files the replaced blip away.
 *
 * Two rules, and the first is a disclosure rule rather than a tidiness one: a
 * supersession link may **never cross a radar**, because `supersededBy` carries
 * the replacement's title into the DTO. A pointer at a blip on a radar the
 * reader cannot see would print a title out of it. The refusal deliberately does
 * not distinguish "no such blip" from "a blip somewhere you cannot see", for the
 * same reason `requireRadar` answers 404 rather than 403.
 *
 * The second is the verb doing its work: recording the link also moves the
 * replaced blip into whatever lane its template declares as `supersededStatus`,
 * and takes its triage state with it — so a decision log re-sorts itself the
 * moment you say what replaced what, instead of needing two calls that could
 * disagree. A template with no such lane still records the link and leaves the
 * blip where it is, which is the honest degradation.
 */
async function applySupersession(
  actor: Actor,
  radar: RadarRow,
  target: string | null,
  self: string | null,
  db: Pick<Db, 'select' | 'update' | 'insert' | 'execute' | 'transaction'> = getDb(),
): Promise<void> {
  if (!target) return;
  // Whatever template the radar is on now, a boundary or contract is never filed away.
  const [element] = await db
    .select({ id: schema.blipElements.blipId })
    .from(schema.blipElements)
    .where(eq(schema.blipElements.blipId, target))
    .limit(1);
  if (element)
    throw new ApiError(
      409,
      'anchored',
      'A boundary or contract cannot be replaced by another blip.',
    );
  const lane = supersededLane(radar.template, radar.templateConfig);
  if (!lane) return;
  const [before] = await db
    .select()
    .from(schema.blips)
    .where(eq(schema.blips.id, target))
    .for('update');
  // Deferred filing: the target must still be in force when the replacement is.
  const rule = ratifiedLane(radar.template, radar.templateConfig);
  if (rule && before?.status !== rule.id)
    throw conflict(
      `Only an ${rule.label.toLowerCase()} blip can be replaced, and that one no longer is.`,
    );
  const [after] = await db
    .update(schema.blips)
    .set({
      status: lane.id,
      state: lane.state,
      updatedAt: new Date(),
      dueRevision: sql`${schema.blips.dueRevision}+1`,
    })
    .where(eq(schema.blips.id, target))
    .returning();
  if (before && after)
    await enqueueSubscriptionEvent(db, actor, radar, 'blip.updated', after, before);
  await db.execute(
    sql`UPDATE blip_reminders SET reminder_at=NULL,triggered_at=NULL WHERE blip_id=${target}::uuid`,
  );
  await recordAudit(
    actor,
    'blip.supersede',
    'blip',
    target,
    {
      radarId: radar.id,
      ...(self ? { by: self } : {}),
    },
    db,
  );
}

/** The half of supersession that must happen before the row exists. */
async function checkSupersedes(
  radar: RadarRow,
  target: string | null | undefined,
  self: string | null,
  db: Pick<Db, 'select'> = getDb(),
): Promise<string | null> {
  if (target === undefined || target === null) return null;
  if (self && target === self) throw badRequest('A blip cannot replace itself');
  const rows = await db
    .select({ radarId: schema.blips.radarId, status: schema.blips.status })
    .from(schema.blips)
    .where(eq(schema.blips.id, target))
    .limit(1)
    .for('update');
  if (rows[0]?.radarId !== radar.id) {
    throw badRequest(`That blip is not on "${radar.name}" — a blip can only replace one beside it`);
  }
  const rule = ratifiedLane(radar.template, radar.templateConfig);
  if (rule && rows[0].status !== rule.id)
    throw conflict(`Only an ${rule.label.toLowerCase()} blip can be replaced.`);
  return target;
}

/**
 * Fetched after responding — the blip is already saved and must not wait on it.
 * Through the outbox now, so a pod killed mid-fetch retries instead of leaving
 * the blip preview-less forever. Duplicate-safe: a re-run refetches the same
 * URL and overwrites the same column with the same answer.
 */
registerOutboxHandler('unfurl', async (payload) => {
  const blipId = textValue(payload['blipId']);
  const url = textValue(payload['url']);
  if (!blipId || !url) return;
  const preview = await unfurl(url);
  if (!preview) return;
  await getDb()
    .update(schema.blips)
    .set({ preview })
    .where(and(eq(schema.blips.id, blipId), eq(schema.blips.url, url)));
});

/**
 * Duplicate-safe: S3 DeleteObjects on already-deleted keys is a no-op. Through
 * the outbox because the DB rows are gone by the time this runs — a lost
 * attempt was an orphaned object in MinIO, forever, with no sweep to find it.
 */
registerOutboxHandler('object-cleanup', async (payload) => {
  const keys = Array.isArray(payload['keys']) ? payload['keys'].map(String) : [];
  if (keys.length > 0) await cleanupStorageKeys(keys);
});

/** Everyone a radar's content reaches or is about to: its readers and its pending invitees. */
async function audienceOf(db: Db, radar: RadarRow): Promise<Set<string>> {
  const readers = await radarReaders(radar, db);
  const invites = await db
    .select({ email: schema.radarInvites.email })
    .from(schema.radarInvites)
    .where(and(eq(schema.radarInvites.radarId, radar.id), isNull(schema.radarInvites.acceptedAt)));
  return new Set([...readers, ...invites].map((who) => who.email.toLowerCase()));
}

/**
 * The internal notes on a helpdesk blip stay with the people the helpdesk was
 * shared with (qa-reviewer, slice 2; `docs/HELPDESK.md` §7.6).
 *
 * A blip moves with its whole thread. Out of a radar that is (or was) a
 * helpdesk, a thread of internal notes about a client may only land where it
 * would be just as private:
 *
 * - **a radar that can never be public** — another helpdesk, or a former one.
 *   An ordinary radar can be published later, which would publish the notes
 *   with it, so "it is private today" is not enough;
 * - **whose audience is no wider** — everyone who can read the destination, or
 *   has a pending invitation to it, can already read the source. Otherwise a
 *   move is a share of the notes with people nobody shared them with.
 *
 * A blip with no comments moves freely: the request text alone is the owner's
 * own capture. Refused before the first write, like every other move refusal.
 */
async function assertNotesStayInside(
  db: Db,
  blipId: string,
  source: RadarRow,
  target: RadarRow,
): Promise<void> {
  if (!neverPublic(source)) return;
  const [note] = await db
    .select({ id: schema.blipComments.id })
    .from(schema.blipComments)
    .where(eq(schema.blipComments.blipId, blipId))
    .limit(1);
  if (!note) return;
  if (!neverPublic(target)) {
    throw badRequest(
      `This blip has internal notes about a client, and "${target.name}" could be published. ` +
        'It can only move to another Helpdesk shared with the same people or fewer.',
    );
  }
  const from = await audienceOf(db, source);
  const wider = [...(await audienceOf(db, target))].some((who) => !from.has(who));
  if (wider) {
    throw badRequest(
      `This blip has internal notes about a client, and "${target.name}" is shared with ` +
        'people who cannot read them here. It can only move to a Helpdesk shared with the same ' +
        'people or fewer.',
    );
  }
}

/** The row was written after the caller read it (compared at the millisecond the API shows). */
export const staleRefusal = () =>
  new ApiError(
    409,
    'stale',
    'This was changed by someone else after you opened it. Load their version before saving.',
  );

/**
 * A write refused with the blip as it stands (409 `stale_revision` or `claimed`). Thrown inside the
 * transaction, which rolls back, and turned into an `ApiError` outside it so the blip the caller is
 * shown is the committed one.
 */
class BlipRefused extends Error {
  constructor(
    readonly code: 'stale_revision' | 'claimed',
    message: string,
    readonly row: BlipRow,
  ) {
    super(message);
  }
}

async function refusedWithCurrent(error: BlipRefused, actor: Actor): Promise<ApiError> {
  const [current] = await hydrate([error.row], actor.user.id, actor.agent?.agentId ?? null);
  return new ApiError(409, error.code, error.message, undefined, undefined, current);
}

/**
 * A live claim by anyone else keeps every bearer off the card; only a person in the browser can write
 * over it (ADR-0007, ADR-0028).
 * Live is decided by the database clock, in the same transaction as the write. The claim is ignored
 * on a template that is not `assignable`.
 */
async function assertClaimAllows(
  db: Pick<Db, 'execute'>,
  row: BlipRow,
  template: string,
  actor: Actor,
): Promise<void> {
  if (!row.claimedUntil || !assignableFor(template)) return;
  const me = actor.agent?.agentId;
  // Only a person (the browser cookie, or the native app's own session token) or the holding agent
  // itself passes. A sessionless PAT/OAuth/mcp token is never the person, even on a claim its own account holds.
  if (isHumanSession(actor) || (me && row.claimedByAgentId === me)) return;
  const [held] = (
    await db.execute<{ live: boolean; holder: string | null }>(sql`
      SELECT b.claimed_until > now() AS live, COALESCE(a.name, u.name, u.email) AS holder
      FROM blips b LEFT JOIN agents a ON a.id = b.claimed_by_agent_id
      LEFT JOIN users u ON u.id = b.claimed_by_user_id WHERE b.id = ${row.id}`)
  ).rows;
  if (held?.live && (row.claimedByAgentId || row.claimedByUserId))
    throw new BlipRefused(
      'claimed',
      `This card is claimed by ${held.holder ?? 'someone'} until ${row.claimedUntil.toISOString()}. ` +
        (me
          ? 'Leave it to the claimant, or ask them (or a person) to release it.'
          : 'Ask the holder to release it, ask a person in the browser, or wait until it expires.') +
        ' The claim is in `current`.',
      row,
    );
}

/** An assignee must be somebody who can open the radar, or an agent the caller can reach. */
async function assertAssignable(
  db: Db,
  actor: Actor,
  radar: RadarRow,
  input: Pick<UpdateBlipInput, 'assigneeUserId' | 'assigneeAgentId'>,
): Promise<void> {
  if (!assignableFor(radar.template))
    throw badRequest(
      `Cards on "${radar.name}" cannot be assigned: its ${radar.template} template does not take assignees.`,
    );
  if (input.assigneeUserId) {
    const readers = await radarReaders(radar, db);
    if (!readers.some((reader) => reader.id === input.assigneeUserId))
      throw badRequest('That person cannot open this radar, so they cannot be assigned its cards.');
  }
  if (input.assigneeAgentId) {
    const [reachable] = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.id, input.assigneeAgentId),
          sql`${schema.agents.id} IN (${reachableAgentQuery(actor.user.id, db)})`,
        ),
      );
    if (!reachable) throw badRequest('That agent is not one you can reach.');
  }
}

/**
 * `update_blip`'s `addAttachments`, in the caller's transaction. Each key must be a fresh upload
 * (referenced by no card) whose ticket was issued to this user and agent for this radar; the
 * ticket is deleted as the row is inserted, so it is good once and a rollback gives it back.
 * The bytes were verified before the transaction (`resolveAttachments`).
 */
async function attachIssuedUploads(
  db: CaptureTransaction,
  actor: Actor,
  existing: BlipRow,
  refs: Awaited<ReturnType<typeof resolveAttachments>>,
) {
  const rows = [...new Map(refs.map((row) => [row.objectKey, row])).values()];
  const keys = rows.map((row) => row.objectKey);
  const [taken] = await db
    .select({ key: schema.attachments.objectKey })
    .from(schema.attachments)
    .where(inArray(schema.attachments.objectKey, keys))
    .limit(1);
  if (taken) throw badRequest('One of those files is already attached to a card: upload it again.');
  const consumed = await db
    .delete(schema.uploadTickets)
    .where(
      and(
        inArray(schema.uploadTickets.objectKey, keys),
        eq(schema.uploadTickets.radarId, existing.radarId),
        eq(schema.uploadTickets.userId, actor.user.id),
        actor.agent
          ? eq(schema.uploadTickets.agentId, actor.agent.agentId)
          : isNull(schema.uploadTickets.agentId),
      ),
    )
    .returning({ key: schema.uploadTickets.objectKey });
  if (consumed.length !== keys.length)
    throw badRequest(
      'An upload ticket is spent, unknown, or was issued to someone else: upload the file ' +
        'again, with the same user and session that attaches it.',
    );
  const [kept] = await db
    .select({ n: count() })
    .from(schema.attachments)
    .where(eq(schema.attachments.blipId, existing.id));
  if ((kept?.n ?? 0) + keys.length > LIMITS.attachmentsPerBlip)
    throw badRequest(`A card holds at most ${LIMITS.attachmentsPerBlip} files.`);
  await db.insert(schema.attachments).values(rows.map((row) => ({ ...row, blipId: existing.id })));
}

/**
 * Updates a blip. A transaction the database rolled back as a deadlock or serialization victim is
 * run once more (nothing of the first attempt survives, and the side effects below it have not
 * started); a second conflict answers 503 with `Retry-After`.
 */
export async function updateBlip(...args: Parameters<typeof updateBlipOnce>): Promise<BlipDto> {
  try {
    return await retryOnConflict(() => updateBlipOnce(...args));
  } catch (error) {
    throw error instanceof BlipRefused ? await refusedWithCurrent(error, args[0]) : error;
  }
}

async function updateBlipOnce(
  actor: Actor,
  blipId: string,
  input: UpdateBlipInput,
  options: {
    /** Service-only: refuse (409 `stale`) when the row has been written since this moment. */
    ifUnchangedSince?: Date;
    /**
     * Service-only (`decide_adr`): stamp this as `ratified_at`, and this name as the decider, when
     * the move into the ratified lane is the one that first ratifies. Never in a request schema.
     */
    decided?: { at: Date; by?: string | undefined };
    /**
     * Service-only: runs first in the write's transaction, before anything is read or changed.
     * Where an idempotency key is claimed: a twin holding the same key waits on it, and a loser
     * rolls back with nothing written.
     */
    arbitrate?: (tx: Pick<Db, 'execute' | 'insert'>) => Promise<void>;
  } = {},
): Promise<BlipDto> {
  // A load session names the agent this write is under (§V2.5); resolved here,
  // in the service, so REST and MCP bind it identically.
  actor = await writeAsAgent(actor, input.session);
  let mentionJob: string | undefined;
  let unfurlJob: string | undefined;
  // Verified (right radar, bytes present) before the transaction, as `createBlip` does.
  let added: Awaited<ReturnType<typeof resolveAttachments>> = [];
  if (input.addAttachments) {
    const [first] = await getDb()
      .select({ radarId: schema.blips.radarId })
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .limit(1);
    if (!first) throw notFound('Blip not found');
    await requireRadar(first.radarId, actor, 'write');
    added = await resolveAttachments(first.radarId, input.addAttachments);
  }
  const { updated, from } = await getDb().transaction(async (db) => {
    await options.arbitrate?.(db);
    /*
      The radar is key-share locked before the blip is, for the reason
      `createBlip` gives: a lane edit serialises against it, so the lanes resolved below are
      the lanes the radar has when the blip lands in one. Radar before blip,
      because deleting a radar locks the radar and then cascades into its
      blips — taken the other way round, an edit and a delete could each hold
      what the other waits for.
    */
    const [peek] = await db
      .select({ radarId: schema.blips.radarId })
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .limit(1);
    if (!peek) throw notFound('Blip not found');
    const peekRadar = await lockRadarForShare(db, peek.radarId);
    /*
      Lock order (the comment at the top of charter-ops.ts): idempotency key, then the charter
      document, then the ADR row, then its anchors. A write that can move an ADR between lanes
      on a ratifying radar takes the document lock here, before the blip's own FOR UPDATE: the
      anchor actions hold the document and then wait for the ADR, so an accept that held the
      ADR and then asked for the document would deadlock with them.
    */
    const movesLane =
      input.status !== undefined || input.state !== undefined || input.supersedes !== undefined;
    if (movesLane && peekRadar && ratifiedLane(peekRadar.template, peekRadar.templateConfig))
      await lockCharter(db, peek.radarId);
    const rows = await db
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .limit(1)
      .for('update');
    const existing = rows[0];
    if (!existing) throw notFound('Blip not found');
    if (
      options.ifUnchangedSince &&
      existing.updatedAt.getTime() !== options.ifUnchangedSince.getTime()
    )
      throw staleRefusal();
    // Moved between the peek and the lock: the radar it is on now is the one to
    // hold and to authorize against — never the one it left.
    if (existing.radarId !== peek.radarId) {
      const now = await lockRadarForShare(db, existing.radarId);
      // Moved onto a ratifying radar between the peek and the lock: the ADR row is held already,
      // the one place the order cannot be kept. A deadlock here is retried (`updateBlip`).
      if (movesLane && now && ratifiedLane(now.template, now.templateConfig))
        await lockCharter(db, existing.radarId);
    }
    let home = await requireRadar(existing.radarId, actor, 'write', db);
    const sourceRadar = home.radar;
    // After the access check, so a reader is never shown a blip they could not have opened.
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision)
      throw new BlipRefused(
        'stale_revision',
        `This blip is at revision ${existing.revision}, not ${input.expectedRevision}. Merge your ` +
          `change into the current blip (in \`current\`) and retry with expectedRevision ${existing.revision}.`,
        existing,
      );
    await assertClaimAllows(db, existing, sourceRadar.template, actor);
    const [email] = await db
      .select({ id: schema.blipEmails.blipId })
      .from(schema.blipEmails)
      .where(eq(schema.blipEmails.blipId, existing.id));
    if (email && input.body !== undefined)
      throw badRequest('The original email cannot be edited. Add email notes instead.');
    /*
      A client's request is frozen, as an email is (docs/HELPDESK.md §7.4, §7.6).
      Its title and body are the client's words and are what the portal shows
      them; an agent tidying the body would publish its notes to the client.
      And it stays on the radar it was filed on: moved onto another client's
      helpdesk it would be one client's request in front of the next. Both
      refused here, a read, before anything below writes.
    */
    const [request] = await db
      .select({ blipId: schema.helpdeskRequests.blipId })
      .from(schema.helpdeskRequests)
      .where(eq(schema.helpdeskRequests.blipId, existing.id));
    if (request && (input.body !== undefined || input.title !== undefined))
      throw badRequest(
        "A client's request cannot be edited: the portal shows the client their own words. " +
          'Add an internal comment or tags instead.',
      );
    if (request && input.radarId && input.radarId !== existing.radarId)
      throw badRequest(
        "A client's request stays on the helpdesk it was filed on. " +
          'Capture a new blip on the other radar and link to this one instead.',
      );
    if (!email && input.emailNotes !== undefined)
      throw badRequest('Notes are only available on email captures.');
    if (added.length) await attachIssuedUploads(db, actor, existing, added);

    /*
    Resolved here, at the very top, and **before anything is written**.

    `authorshipOf` refuses a voice this connection was not granted, and the
    refusal has to land before the first side effect or it stops being a refusal
    and becomes a partial write. The move below is the specific hazard: it
    re-points the denormalised `radar_id` on this blip's attachments, comments,
    reactions and mentions *before* the blip's own row is patched, so a refusal
    raised after it would leave every one of those on the destination radar with
    the blip still on the source — exactly the "stranded on a radar its blip has
    left" failure `0008` warns about, reached from the other end.

    It depends on nothing but the actor and the argument, so there is no reason
    for it to be anywhere else.
  */
    const rewritten = authorshipOf(actor, input.as);

    const patch: Partial<typeof schema.blips.$inferInsert> = { updatedAt: new Date() };
    if (input.emailNotes !== undefined) patch.emailNotes = input.emailNotes;

    if (input.radarId && input.radarId !== existing.radarId) {
      // Moving needs write access to the destination too, not just the source.
      await lockRadarForShare(db, input.radarId);
      const target = await requireRadar(input.radarId, actor, 'write', db);
      if (target.radar.kind === 'smart') {
        throw badRequest(`"${target.radar.name}" is a smart radar and cannot hold blips.`);
      }
      /*
        A blip carrying a reply to a client — released or waiting for review —
        stays on the radar it was written on (docs/HELPDESK.md §7.6, §9 T1/T2).

        Moving it onto another client's helpdesk would put one client's
        conversation in front of the next; moving it onto an ordinary radar
        would turn a client-visible reply into a label on a radar that has no
        client side, readable by whoever that radar is shared with. Both are
        disclosures, and neither is something a re-file ever means. Refused
        here, a read, before the first write below re-points the thread.
      */
      const [clientReply] = await db
        .select({ id: schema.blipComments.id })
        .from(schema.blipComments)
        .where(
          and(
            eq(schema.blipComments.blipId, existing.id),
            ne(schema.blipComments.visibility, 'internal'),
          ),
        )
        .limit(1);
      if (clientReply) {
        throw badRequest(
          'This blip has a reply to a client on it, so it stays on its helpdesk. ' +
            'Capture a new blip on the other radar and link to this one instead.',
        );
      }
      await assertNotesStayInside(db, existing.id, sourceRadar, target.radar);
      await assertUnanchored(db, existing, sourceRadar, 'move');
      patch.radarId = target.radar.id;
      home = target;
      /*
      Validated against the DESTINATION, and here rather than further down.

      The same partial-write hazard as the voice refusal above, and it predates
      it: `assertLane` runs after this block, so
      `update_blip({ radarId, status: 'nonsense' })` re-pointed the whole
      conversation onto the new radar and *then* refused the lane, leaving the
      blip behind with its comments, reactions, attachments and mentions
      somewhere else. `requireRadar` and this check are both reads, so moving
      both refusals above the first write costs nothing and makes the move
      all-or-nothing.
    */
      assertLane(target.radar, input.status, input.state);
      // Everything hanging off the blip carries its denormalised radar id, and
      // that id is what authorizes and scopes it. Leaving any of these behind
      // would strand a comment on a radar its blip no longer lives on — readable
      // by the wrong people, and invisible to the right ones.
      const moves = [
        db
          .update(schema.attachments)
          .set({ radarId: target.radar.id })
          .where(eq(schema.attachments.blipId, existing.id)),
        db
          .update(schema.blipComments)
          .set({ radarId: target.radar.id })
          .where(eq(schema.blipComments.blipId, existing.id)),
        db
          .update(schema.blipReactions)
          .set({ radarId: target.radar.id })
          .where(eq(schema.blipReactions.blipId, existing.id)),
        /*
        Mentions too — on the blip's own body and on every comment underneath
        it, because the comments are moving in the same breath.

        This was the one omission, and `0008_threads_and_mentions.sql` named the
        failure before it happened: "re-deriving it through two joins on every
        read is how a mention ends up stranded on a radar its blip has left."
        Two consequences, and the second is the worse one.

        `dropRadarMentions` filters on this column, so the revocation sweep
        would miss exactly the mentions that had moved. And `mentions.radar_id`
        is `ON DELETE CASCADE` on `radars`: with the column left pointing at the
        old radar, deleting *that* radar silently strips the mentions off blips
        that now live somewhere else entirely — a blip whose `@ada` stops
        resolving because of something that happened to a radar it is no longer
        in.
      */
        db
          .update(schema.mentions)
          .set({ radarId: target.radar.id })
          .where(
            or(
              eq(schema.mentions.blipId, existing.id),
              inArray(
                schema.mentions.commentId,
                db
                  .select({ id: schema.blipComments.id })
                  .from(schema.blipComments)
                  .where(eq(schema.blipComments.blipId, existing.id)),
              ),
            ),
          ),
        // Supersession links are cut in both directions rather than carried, and
        // this is a disclosure rule, not tidiness. `supersededBy` puts the
        // replacement's title in the DTO, so a link left pointing across a radar
        // boundary would print a title out of a radar the reader cannot see —
        // outbound (this blip replaced one back there) and inbound (one back there
        // was replaced by this) both. A relation is not part of the blip the way
        // an attachment is; it is a claim about two blips sitting beside each
        // other, and moving one away is what ends it.
        db
          .update(schema.blips)
          .set({ supersedesId: null })
          .where(eq(schema.blips.supersedesId, existing.id)),
        // Notifications about this blip carry its radar too, and the list shows
        // one only while its radar is readable. Left on the source, a reader of
        // the source who cannot read the destination kept the excerpt of a
        // conversation that had moved out of their reach.
        db
          .update(schema.notifications)
          .set({ radarId: target.radar.id })
          .where(eq(schema.notifications.blipId, existing.id)),
      ];
      for (const move of moves) await move;
      /*
        A mention is a resolution against the radar's readers, not a fact about
        the text. The body's own are re-resolved against the destination below;
        the comments' are not re-parsed, so the ones naming somebody who cannot
        read the destination go here. Otherwise the thread on the new radar
        printed the name, handle and user id of a person outside it to everyone
        inside it. The comment text is untouched; the handle just stops
        resolving, exactly as it would if it were typed there today.
      */
      const readerIds = (await radarReaders(target.radar, db)).map((reader) => reader.id);
      await db
        .delete(schema.mentions)
        .where(
          and(
            inArray(
              schema.mentions.commentId,
              db
                .select({ id: schema.blipComments.id })
                .from(schema.blipComments)
                .where(eq(schema.blipComments.blipId, existing.id)),
            ),
            readerIds.length === 0
              ? undefined
              : or(
                  and(
                    isNotNull(schema.mentions.userId),
                    notInArray(schema.mentions.userId, readerIds),
                  ),
                  and(
                    isNotNull(schema.mentions.agentId),
                    notInArray(
                      schema.mentions.agentId,
                      db
                        .select({ id: schema.agents.id })
                        .from(schema.agents)
                        .where(inArray(schema.agents.ownerId, readerIds)),
                    ),
                  ),
                ),
          ),
        );
      patch.supersedesId = null;
    }

    if (input.body !== undefined) {
      const body = input.body.trim();
      // A page the charter was moved out of stays as it was; the document is the charter now.
      if (
        ratifiedLane(home.radar.template, home.radar.templateConfig) &&
        existing.status === 'charter'
      )
        throw charterIsOneDocument();
      patch.body = body;
      // Rewriting the body makes the words the caller's, whoever wrote them first.
      patch.authored = true;
      if (input.tags === undefined) {
        /*
          Inline tags follow the text they were written in: a `#tag` taken out of
          the body goes, one put in arrives. A tag the old body never carried was
          set explicitly (the tag editor, `tags` on a write, a webhook mapping)
          and stays. An explicit `tags` in the same call wins outright.
        */
        const before = new Set(uniqueTags(extractInlineTags(existing.body)));
        patch.tags = blipTags(
          [...existing.tags.filter((tag) => !before.has(tag)), ...extractInlineTags(body)],
          true,
        );
      }
    }
    if (input.tags !== undefined) patch.tags = blipTags(input.tags, true);
    if (input.title !== undefined) patch.title = input.title;

    // Authorship is not touched here: `author`/`agent`/`voice` name the creator for good
    // (`blips_keep_author`, 0095), and the revision log records who edited (docs/PERSONA.md).
    if (input.state !== undefined) patch.state = input.state;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.pinned !== undefined) patch.pinned = input.pinned;

    // The lane is resolved against the radar the blip will *end up in*, so moving
    // a card off a board drops a lane that means nothing there. Landing in a lane
    // also carries the blip's triage state with it — that is what stops a board's
    // Done column and the Inbox count disagreeing — unless the caller set `state`
    // explicitly in the same call, in which case they win.
    if (input.status !== undefined || patch.radarId !== undefined) {
      assertLane(home.radar, input.status, input.state);
      const status = resolveStatus(
        home.radar.template,
        input.status,
        existing.status,
        home.radar.templateConfig,
      );
      patch.status = status;
      const lane = findStatus(home.radar.template, status, home.radar.templateConfig);
      // A lane named on its own always sets its state, even when the card is already in it.
      if (
        lane &&
        input.state === undefined &&
        (input.status !== undefined || status !== existing.status)
      ) {
        patch.state = lane.state;
      }
    }

    // ...and the other way, which is a *repair* rather than a mapping. `state` has
    // no clean inverse — `doing` and `blocked` both imply `active` — so setting
    // `state` alone only moves the card when the lane it is sitting in now
    // contradicts it. A blocked card re-confirmed `active` stays Blocked; one
    // marked `done` lands in Done instead of lying in To do. Without this,
    // `update_blip({state:'done'})` left the board reading a count that was false.
    // An explicit `status` in the same call always wins: the caller named a lane.
    if (input.state !== undefined && input.status === undefined) {
      const settled = patch.status !== undefined ? patch.status : existing.status;
      const lane = findStatus(home.radar.template, settled, home.radar.templateConfig);
      if (!lane || lane.state !== input.state) {
        const target = laneForState(home.radar.template, input.state, home.radar.templateConfig);
        // No lane for this state (a `later` card on a reading list) leaves the
        // blip where it is — better a lane that is merely imprecise than one
        // invented, and the board still shows it.
        if (target) patch.status = target.id;
      }
    }
    if (input.url !== undefined) {
      patch.url = input.url;
      patch.preview = null;
    }

    // Resolved against the radar the blip ends up in, like the lane above: a blip
    // that just moved cannot replace one it left behind. An explicit null clears
    // the link and deliberately does *not* un-file the blip it used to point at —
    // the record of what happened to that blip is its own, and reversing somebody
    // else's lane as a side effect of an edit here would be the same "two writes
    // that can disagree" failure the lane/state repair exists to prevent.
    const finalStatus = patch.status !== undefined ? patch.status : existing.status;
    // A boundary or contract is an element by its row, not by the lane it happens to be in under
    // the radar's current template: no path takes it out of its lane.
    if (finalStatus !== existing.status) {
      const [element] = await db
        .select({ id: schema.blipElements.blipId })
        .from(schema.blipElements)
        .where(eq(schema.blipElements.blipId, existing.id))
        .limit(1);
      if (element)
        throw new ApiError(
          409,
          'lane_move_refused',
          'A boundary or contract stays in its lane. Delete it to remove it.',
        );
    }
    if (patch.radarId === undefined) assertLaneMove(home.radar, existing.status, finalStatus);
    else assertEntry(home.radar, finalStatus);
    // After the lane rules (they say more about a move), before anything is written: a page of
    // a charter that is a document now takes no write at all, tags and state included.
    await assertNotCharterPage(db, existing);
    // Nothing enters the charter lane of an Architecture radar, by a move from another lane or
    // from another radar either (create is refused the same way): the charter is one document.
    if (
      finalStatus === 'charter' &&
      ratifiedLane(home.radar.template, home.radar.templateConfig) &&
      (existing.status !== 'charter' || patch.radarId !== undefined)
    )
      throw charterIsOneDocument();
    const rule = ratifiedLane(home.radar.template, home.radar.templateConfig);
    const enters =
      rule !== null &&
      patch.radarId === undefined &&
      finalStatus === rule.id &&
      existing.status !== rule.id;
    if (enters) {
      // An ADR whose amended words are no longer in the charter cannot be accepted. Checked under the
      // charter's lock, so a save that orphans it lands either before this read or after this commit.
      const [anchored] = await db
        .select({ id: schema.charterAnchors.id })
        .from(schema.charterAnchors)
        .where(
          and(
            eq(schema.charterAnchors.subjectId, existing.id),
            eq(schema.charterAnchors.kind, 'amend'),
          ),
        )
        .limit(1);
      if (anchored) await assertAdrAcceptable(db, existing.radarId, existing.id);
    }
    if (enters && !existing.ratifiedAt) {
      patch.ratifiedAt = options.decided?.at ?? new Date();
      if (options.decided?.by) patch.ratifiedByName = options.decided.by;
    }

    let superseding: string | null = null;
    if (input.supersedes !== undefined && patch.radarId === undefined) {
      superseding = await checkSupersedes(home.radar, input.supersedes, existing.id, db);
      patch.supersedesId = superseding;
    }

    if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
    const scheduleChanged =
      (input.dueAt !== undefined &&
        (patch.dueAt?.getTime() ?? null) !== (existing.dueAt?.getTime() ?? null)) ||
      (patch.state !== undefined && patch.state !== existing.state) ||
      patch.radarId !== undefined;
    if (scheduleChanged) patch.dueRevision = existing.dueRevision + 1;
    if (input.assigneeUserId !== undefined || input.assigneeAgentId !== undefined) {
      await assertAssignable(db, actor, home.radar, input);
      if (input.assigneeUserId !== undefined) patch.assigneeUserId = input.assigneeUserId;
      if (input.assigneeAgentId !== undefined) patch.assigneeAgentId = input.assigneeAgentId;
    }
    await setEditor(db, actor.user.id, rewritten.agentId);
    const [updated] = await db
      .update(schema.blips)
      .set(patch)
      .where(eq(schema.blips.id, existing.id))
      .returning();
    if (!updated) throw notFound('Blip not found');
    // A dismissed amendment is all an ADR can carry out of a radar; it goes with it.
    if (patch.radarId !== undefined) await rehomeAnchors(db, updated.id, patch.radarId);
    if (scheduleChanged) await syncBlipReminders(db, updated.id);

    // On a ratifying template the replaced blip is filed when the replacement is in force.
    const toFile = !rule
      ? superseding
      : finalStatus === rule.id
        ? (superseding ?? (enters ? updated.supersedesId : null))
        : null;
    await applySupersession(actor, home.radar, toFile, updated.id, db);
    // A lane change of an ADR that has amendments is part of the charter's history.
    if (rule && patch.radarId === undefined && (updated.status !== existing.status || toFile))
      await sealAfterLaneChange(db, updated.radarId, updated.id, actor);
    if (input.url) unfurlJob = await enqueue(db, 'unfurl', { blipId: updated.id, url: input.url });
    // Somebody else's words address nobody, here any more than on capture: a
    // feed item moved to another radar does not start resolving its handles.
    if ((input.body !== undefined || input.radarId !== undefined) && updated.authored) {
      const { newlyMentioned } = await reconcileMentions(
        home.radar,
        { blipId: updated.id },
        updated.body,
        actor.user.id,
        actor.agent?.agentId ?? null,
        db,
      );
      if (newlyMentioned.length > 0)
        mentionJob = await enqueueNotificationEvent(db, {
          type: 'mention',
          actor,
          radarId: home.radar.id,
          blipId: updated.id,
          commentId: null,
          body: updated.body,
          mentioned: newlyMentioned,
        });
    }
    if (updated.radarId !== existing.radarId) {
      await enqueueSubscriptionEvent(db, actor, sourceRadar, 'blip.deleted', existing);
      await enqueueSubscriptionEvent(db, actor, home.radar, 'blip.created', updated);
    } else await enqueueSubscriptionEvent(db, actor, home.radar, 'blip.updated', updated, existing);
    return { updated, home, from: existing.radarId };
  });
  const drop = actor.connection ? invalidateRadarStatsSoon : invalidateRadarStats;
  drop(updated.radarId);
  drop(from);
  kickSubscriptionDeliveries();
  if (unfurlJob) void drainOne(unfurlJob).catch(() => undefined);

  await recordAudit(actor, 'blip.update', 'blip', updated.id, { fields: Object.keys(input) });

  if (mentionJob) await drainOne(mentionJob);

  const [dto] = await hydrate([updated], actor.user.id, actor.agent?.agentId ?? null);
  if (!dto) throw new Error('blip vanished after update');
  return dto;
}

/**
 * Take, renew or release a claim on a card: a lease of `ttl` seconds that keeps other agents off
 * it. A person can always take over or release one (ADR-0007). It does not touch lane, state or
 * `updated_at`; the revision still moves (the trigger counts every write).
 */
export async function claimBlip(
  actor: Actor,
  blipId: string,
  input: ClaimBlipInput,
): Promise<BlipDto> {
  actor = await writeAsAgent(actor, input.session);
  // A claim keeps other agents off the card, so it names one. A sessionless token would hold it as
  // the user with no agent, and then be refused its own edit, renewal and release for up to 4 hours.
  if (!actor.agent && !isHumanSession(actor))
    throw badRequest(
      'Say which agent is claiming this card: pass the session load_agent returned. ' +
        'A claim keeps other agents off the card, so it must name one. A person claims in the browser or the app.',
    );
  try {
    const row = await getDb().transaction(async (db) => {
      const [existing] = await db
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.id, blipId))
        .limit(1)
        .for('update');
      if (!existing) throw notFound('Blip not found');
      const { radar } = await requireRadar(existing.radarId, actor, 'write', db);
      if (!assignableFor(radar.template))
        throw badRequest(
          `Cards on "${radar.name}" cannot be claimed: its ${radar.template} template does not take claims.`,
        );
      await assertClaimAllows(db, existing, radar.template, actor);
      const held = input.release
        ? {
            claimedByUserId: null,
            claimedByAgentId: null,
            claimedUntil: null,
          }
        : {
            claimedByUserId: actor.user.id,
            claimedByAgentId: actor.agent?.agentId ?? null,
            claimedUntil: sql<Date>`now() + ${input.ttl} * interval '1 second'`,
          };
      const [updated] = await db
        .update(schema.blips)
        .set(held)
        .where(eq(schema.blips.id, existing.id))
        .returning();
      if (!updated) throw notFound('Blip not found');
      return updated;
    });
    await recordAudit(actor, input.release ? 'blip.release' : 'blip.claim', 'blip', row.id, {});
    const [dto] = await hydrate([row], actor.user.id, actor.agent?.agentId ?? null);
    if (!dto) throw notFound('Blip not found');
    return dto;
  } catch (error) {
    throw error instanceof BlipRefused ? await refusedWithCurrent(error, actor) : error;
  }
}

export async function deleteBlip(
  actor: Actor,
  blipId: string,
  options: { session?: string | undefined } = {},
): Promise<void> {
  actor = await writeAsAgent(actor, options.session);
  try {
    await deleteBlipOnce(actor, blipId);
  } catch (error) {
    throw error instanceof BlipRefused ? await refusedWithCurrent(error, actor) : error;
  }
}

async function deleteBlipOnce(actor: Actor, blipId: string): Promise<void> {
  let cleanupJob: string | undefined;
  const existing = await getDb().transaction(async (db) => {
    const [row] = await db
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, blipId))
      .limit(1)
      .for('update');
    if (!row) throw notFound('Blip not found');
    const access = await requireRadar(row.radarId, actor, 'write', db);
    await assertClaimAllows(db, row, access.radar.template, actor);
    await assertNotCharterPage(db, row);
    await assertUnanchored(db, row, access.radar, 'delete');
    await enqueueSubscriptionEvent(db, actor, access.radar, 'blip.deleted', row);
    const attachmentRows = await db
      .select({ objectKey: schema.attachments.objectKey })
      .from(schema.attachments)
      .where(eq(schema.attachments.blipId, row.id));
    const [email] = await db
      .select()
      .from(schema.blipEmails)
      .where(eq(schema.blipEmails.blipId, row.id));
    await db.delete(schema.blips).where(eq(schema.blips.id, row.id));
    const keys = [
      ...attachmentRows.map((a) => a.objectKey),
      ...[email?.payloadKey, email?.originalKey].filter((key): key is string => Boolean(key)),
    ];
    if (keys.length > 0) cleanupJob = await enqueue(db, 'object-cleanup', { keys });
    return row;
  });
  (actor.connection ? invalidateRadarStatsSoon : invalidateRadarStats)(existing.radarId);
  kickSubscriptionDeliveries();
  if (cleanupJob) void drainOne(cleanupJob).catch(() => undefined);
  await recordAudit(actor, 'blip.delete', 'blip', existing.id, { radarId: existing.radarId });
}

/* --------------------------------- extras -------------------------------- */

/**
 * Facets take a scope rather than a list of ids so a smart radar's chips count
 * the blips it actually resolves to, not the zero rows it owns.
 */
export function scopeOf(radarIds: string[], saved: SmartFilter | null = null): BlipScope {
  return { radarIds, saved };
}

function scopeClauses(scope: BlipScope): SQL[] {
  return [
    inArray(schema.blips.radarId, scope.radarIds),
    ...(scope.saved ? savedFilters(scope.saved) : []),
  ];
}

/**
 * Distinct tags in scope with counts, for the filter bar.
 *
 * Live only, like every count below it. A facet that offers a tag the stream
 * under it will not show is a filter that appears to do nothing — the same
 * failure as a lane header disagreeing with its column, one surface up.
 */
export async function tagCounts(scope: BlipScope): Promise<Array<{ tag: string; count: number }>> {
  if (scope.radarIds.length === 0) return [];
  const result = await getDb().execute<{ tag: string; count: number }>(
    sql`SELECT unnest(${schema.blips.tags}) AS tag, count(*)::int AS count
        FROM ${schema.blips}
        WHERE ${and(...scopeClauses(scope), liveExpr)}
        GROUP BY 1
        ORDER BY count DESC, tag ASC
        LIMIT 100`,
  );
  return result.rows;
}

/** Per-state counts, for the triage chips. Live only — see `tagCounts`. */
export async function stateCounts(scope: BlipScope): Promise<Record<BlipState, number>> {
  const empty: Record<BlipState, number> = { inbox: 0, active: 0, later: 0, done: 0, dropped: 0 };
  if (scope.radarIds.length === 0) return empty;
  const rows = await getDb()
    .select({ state: schema.blips.state, count: sql<number>`count(*)::int` })
    .from(schema.blips)
    .where(and(...scopeClauses(scope), liveExpr))
    .groupBy(schema.blips.state);
  for (const row of rows) empty[row.state] = row.count;
  return empty;
}

/**
 * Per-lane counts, live and archived, so a board can show how full each column
 * is without loading it — **and say what left it**.
 *
 * Both halves, from one grouped query, because the seam is the feature. A lane
 * header that reads `12` when 34 cards have quietly gone is the silent version
 * of this, and silent is the one thing archiving was not allowed to be.
 */
export interface LaneCounts {
  /** Blips currently in the lane. */
  live: Record<string, number>;
  /** Blips that were in the lane and have aged out. Empty on a template that never archives. */
  archived: Record<string, number>;
}

export async function statusCounts(scope: BlipScope): Promise<LaneCounts> {
  const counts: LaneCounts = { live: {}, archived: {} };
  if (scope.radarIds.length === 0) return counts;
  const rows = await getDb()
    .select({
      status: schema.blips.status,
      // FILTER rather than a second GROUP BY key: grouping on an expression that
      // carries a correlated subquery is legal and unreadable, and this way the
      // two numbers provably come from the same scan of the same rows.
      live: sql<number>`(count(*) FILTER (WHERE ${liveExpr}))::int`,
      archived: sql<number>`(count(*) FILTER (WHERE ${archivedExpr}))::int`,
    })
    .from(schema.blips)
    .where(and(...scopeClauses(scope)))
    .groupBy(schema.blips.status);
  for (const row of rows) {
    const lane = row.status ?? '_none';
    if (row.live > 0) counts.live[lane] = row.live;
    if (row.archived > 0) counts.archived[lane] = row.archived;
  }
  return counts;
}

/**
 * The tag, state and lane tallies for a radar: three scans of everything in it, so reused for
 * `STATS_CACHE_TTL_MS` per radar. A smart radar's scope depends on who is asking and is not cached.
 */
export function radarFacets(access: RadarAccess, scope: BlipScope) {
  const load = async () => {
    const [tags, states, statuses] = await Promise.all([
      tagCounts(scope),
      stateCounts(scope),
      statusCounts(scope),
    ]);
    return { tags, states, statuses };
  };
  return access.radar.kind === 'smart' ? load() : cachedForRadar(access.radar.id, 'facets', load);
}

/**
 * How many blips a scope resolves to, and when the newest one landed.
 *
 * Live and archived separately, for the same reason `statusCounts` splits: a
 * radar's `blipCount` is what you would see on opening it, and "still counted"
 * was half the complaint archiving exists to answer.
 */
export async function countScope(
  scope: BlipScope,
): Promise<{ count: number; archived: number; lastAt: Date | null }> {
  if (scope.radarIds.length === 0) return { count: 0, archived: 0, lastAt: null };
  const [row] = await getDb()
    .select({
      count: sql<number>`(count(*) FILTER (WHERE ${liveExpr}))::int`,
      archived: sql<number>`(count(*) FILTER (WHERE ${archivedExpr}))::int`,
      // Unfiltered on purpose: "when did anything last land here" is true of the
      // radar, not of the visible slice, and an archived blip is old by
      // construction so it can only ever be the answer on an empty radar.
      last: sql<string | null>`max(${schema.blips.createdAt})`,
    })
    .from(schema.blips)
    .where(and(...scopeClauses(scope)));
  return {
    count: row?.count ?? 0,
    archived: row?.archived ?? 0,
    lastAt: row?.last ? new Date(row.last) : null,
  };
}

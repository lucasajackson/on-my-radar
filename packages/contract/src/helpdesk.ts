/**
 * The client side of a helpdesk, as far as slice 1 needs it.
 *
 * A helpdesk radar's lanes are a per-radar vocabulary that a person or an agent
 * may rename at will (`docs/DESIGN.md` §4). What a client sees can therefore
 * never be a lane label: a lane renamed "Ignore" must not be able to reach
 * anybody outside. Every lane on a client-facing template instead names one of
 * these six values, and the words a client reads are the fixed labels below —
 * constants in this file, not radar data. That is what makes a status change
 * safe to show a client without review: it carries no free text, so the worst a
 * wrong move can do is show the wrong one of six statuses. See
 * `docs/HELPDESK.md` §6.1.
 */
export const CLIENT_STATUSES = [
  'received',
  'scheduled',
  'in_progress',
  'waiting_on_you',
  'resolved',
  'declined',
] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** What a client reads. Fixed here so no radar can say anything else. */
export const CLIENT_STATUS_LABELS: Readonly<Record<ClientStatus, string>> = {
  received: 'Received',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  waiting_on_you: 'Waiting on you',
  resolved: 'Resolved',
  declined: 'Declined',
};

export function isClientStatus(value: unknown): value is ClientStatus {
  return typeof value === 'string' && (CLIENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Who may see a comment beyond the radar's members (`docs/HELPDESK.md` §7).
 *
 * - `internal`       — staff only. The default on every path and every radar,
 *                      and the only value a comment off a client-facing radar
 *                      can have.
 * - `client_pending` — a reply to the client, written by anyone but the radar's
 *                      owner in person, waiting for the owner's review. Nobody
 *                      outside sees it.
 * - `client`         — a reply the client may see: released by the owner
 *                      against the hash of the exact text they reviewed, or (from
 *                      slice 3) the client's own words through the portal.
 *                      Immutable once there.
 *
 * Members of the radar see all three, labelled. Visibility is about who sees a
 * comment *outside* On My Radar, never about hiding anything from the people
 * working the radar — collaborators read internal notes by design (§6.1).
 */
export const COMMENT_VISIBILITIES = ['internal', 'client_pending', 'client'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

/**
 * What a writer may ask for. `client_pending` is an outcome, never a request:
 * whether a reply waits for review is decided by who wrote it, not by what they
 * said they wanted.
 */
export const REQUESTED_COMMENT_VISIBILITIES = ['internal', 'client'] as const;
export type RequestedCommentVisibility = (typeof REQUESTED_COMMENT_VISIBILITIES)[number];

export function isCommentVisibility(value: unknown): value is CommentVisibility {
  return typeof value === 'string' && (COMMENT_VISIBILITIES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------ */
/* Slice 3: the integration credential and the client projection (§3, §5). */
/* ------------------------------------------------------------------------ */

/**
 * The bounds of the portal's REST surface (`docs/HELPDESK.md` §5.1). The portal
 * itself caps a title at 150 and a body at 4,000, so these never bind a real
 * client; they bound what a leaked credential can write.
 */
export const HELPDESK_LIMITS = {
  title: 150,
  body: 8_000,
  reply: 8_000,
  ref: 64,
  requesterName: 120,
  requesterEmail: 254,
  idempotencyKey: 128,
  /** Hours an `Idempotency-Key` is remembered. */
  idempotencyHours: 24,
  listPage: 50,
  threadPage: 100,
  /** Every call, per integration, per minute. */
  integrationPerMinute: 600,
  /** Writes (requests and replies), per integration and requester account, per hour. */
  scopeWritesPerHour: 60,
} as const;

/** Decision 6: 90 days from mint or rotation; a rotation overlaps by 24 h at most. */
export const INTEGRATION_LIMITS = {
  expiryDays: 90,
  maxOverlapHours: 24,
  defaultOverlapHours: 2,
  name: 80,
  staffDisplayName: 80,
  externalRef: 64,
} as const;

/** The header every `/requests` route requires: the portal account the caller acts for. */
export const REQUESTER_SCOPE_HEADER = 'x-omr-requester-scope';

/**
 * Who wrote a client's words, as the portal asserted them. Display only and
 * untrusted: On My Radar never verifies, links or mails any of it.
 */
export interface ExternalAuthor {
  /** Server-assigned native ingress provenance; absent on historical portal replies. */
  via?: 'support' | 'guest';
  ref: string;
  accountRef: string;
  name: string;
  email: string;
}

/**
 * The marking on content a client supplied through the portal (T3). The
 * dashboard and MCP render such text as data, not as instructions.
 */
export interface ExternalMarking {
  via: 'portal' | 'support' | 'guest';
  requesterName: string;
}

/**
 * What the portal sees of a request. Built from a whitelist, never by
 * redacting a `BlipDto`: tags, triage state, lane, internal notes and their
 * count, agent identity and the radar's name cannot appear because nothing
 * here names them (§5.3).
 */
export interface HelpdeskRequestSummaryDto {
  id: string;
  radarId: string;
  title: string;
  clientStatus: ClientStatus;
  requester: { ref: string; name: string };
  createdAt: string;
  /** The latest client-visible moment: creation or the newest client-visible reply. */
  updatedAt: string;
  lastReplyAt: string | null;
  /** The newest staff reply with no client reply after it. Computed, never stored. */
  awaitingClientSince: string | null;
}

export interface HelpdeskRequestDto extends HelpdeskRequestSummaryDto {
  body: string;
  /** Escape-first: the text HTML-escaped, then paragraphs, line breaks and http(s)/mailto links. */
  bodyHtml: string;
  /** Client-projected attachments arrive in slice 7. Always empty until then. */
  attachments: { id: string; filename: string; contentType: string; size: number }[];
}

export interface HelpdeskThreadItemDto {
  id: string;
  from: 'staff' | 'client';
  /** Staff: the integration's display name (decision 2). Client: the requester's name. */
  authorName: string;
  body: string;
  bodyHtml: string;
  createdAt: string;
}

export interface HelpdeskRadarDto {
  id: string;
  name: string;
  externalRef: string | null;
}

/** An integration as its owner sees it. The token is present once, on mint or rotation. */
export interface IntegrationDto {
  id: string;
  purpose: 'helpdesk';
  name: string;
  staffDisplayName: string;
  agentReplyPolicy: 'review';
  tokenPrefix: string;
  tokenLastUsedAt: string | null;
  /** The previous token, while a rotation overlaps. */
  previous: { expiresAt: string; lastUsedAt: string | null } | null;
  expiresAt: string;
  rotatedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  enrolments: IntegrationEnrolmentDto[];
  /** Where events are pushed, or null when the portal only pulls them (slice 4). */
  delivery: IntegrationDeliveryDto | null;
  /** Only in the response that minted or rotated it. Shown once. */
  token?: string;
  /** The signing secret for pushed events, only in the response that minted it. Shown once. */
  deliverySecret?: string;
}

export interface IntegrationEnrolmentDto {
  id: string;
  radarId: string;
  radarName: string;
  externalRef: string | null;
  enrolledAt: string;
}

/* ------------------------------------------------------------------------ */
/* Slice 4: events to the portal (§5.4).                                    */
/* ------------------------------------------------------------------------ */

/**
 * What an event can say happened, and nothing more. An event carries ids only
 * (`HelpdeskEventDto`); the portal fetches what changed through the projection.
 *
 * - `request.status_changed`  — the client status shown for a request changed
 *   (a lane move between different statuses, a lane re-mapped, or the repair a
 *   client's own reply causes).
 * - `request.reply`           — a staff reply became client-visible: the owner's
 *   own, or a release.
 * - `request.reply_retracted` — a client-visible reply was deleted.
 * - `request.removed`         — the request left the portal's reach: deleted,
 *   its radar unenrolled, deleted, switched off the template or given away.
 * - `integration.test`        — a test ping from the owner.
 *
 * A request the portal files, and a client's own reply, report nothing: the
 * portal already knows (echo suppression).
 */
export const HELPDESK_EVENT_KINDS = [
  'request.status_changed',
  'request.reply',
  'request.reply_retracted',
  'request.removed',
  'integration.test',
] as const;
export type HelpdeskEventKind = (typeof HELPDESK_EVENT_KINDS)[number];

export function isHelpdeskEventKind(value: unknown): value is HelpdeskEventKind {
  return typeof value === 'string' && (HELPDESK_EVENT_KINDS as readonly string[]).includes(value);
}

export const HELPDESK_EVENT_LIMITS = {
  /** Events per reconcile page, by default and at most. */
  page: 100,
  maxPage: 500,
  /** Delivery attempts kept per integration. */
  history: 100,
  /** The log is kept 30 days, in absolute hours (see drizzle/0046 on day arithmetic). */
  retentionHours: 30 * 24,
} as const;

/**
 * One event: ids, never content. `cursor` is opaque — pass it back as `after`
 * and compare nothing else. `id` is the durable event id, also sent as
 * `X-OMR-Event-Id`: the portal dedupes on it under a unique constraint in its
 * own database, because push and pull deliver the same event by design.
 */
export interface HelpdeskEventDto {
  id: string;
  cursor: string;
  event: HelpdeskEventKind;
  occurredAt: string;
  integrationId: string;
  /** Null on `integration.test`. */
  requestId: string | null;
  radarId: string | null;
  /** On `request.reply` and `request.reply_retracted` only. */
  replyId: string | null;
}

/** Where an integration's events are pushed, and how that is going. */
export interface IntegrationDeliveryDto {
  url: string;
  /** Set when delivery is paused, by hand or after six failed attempts. Events keep queueing. */
  pausedAt: string | null;
  lastError: string | null;
  /** Events waiting to be pushed. */
  pending: number;
}

export interface IntegrationDeliveryAttemptDto {
  id: string;
  eventId: string;
  event: HelpdeskEventKind;
  attempt: number;
  status: number | null;
  error: string | null;
  createdAt: string;
}

export interface IntegrationDeliveriesDto {
  delivery: IntegrationDeliveryDto | null;
  attempts: IntegrationDeliveryAttemptDto[];
}

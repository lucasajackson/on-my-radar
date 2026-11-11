import type { SearchProblem } from './search.js';
import type { z } from 'zod';
import type { dashboardWidgetConfigSchema } from './schemas.js';
import type { EmailSummaryDto } from './email.js';
/** Wire shapes returned by the API and consumed by the SPA and the MCP tools. */
import type {
  AccessSource,
  BlipKind,
  BlipReaction,
  BlipState,
  InviteKind,
  NotificationKind,
  RadarAccent,
  RadarGlyph,
  RadarKind,
  RadarNotifyLevel,
  RadarRole,
  RadarVisibility,
  SmartFilter,
  TopicRole,
  UserState,
  Voice,
  WebhookFormat,
} from './domain.js';
import type { TemplateConfig } from './templates.js';
import type { RadarTheme } from './theme.js';
import type { CommentVisibility, ExternalMarking } from './helpdesk.js';

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  state: UserState;
  isAdmin: boolean;
  theme: 'system' | 'light' | 'dark';
  createdAt: string;
}

/** What the caller may do with a radar, resolved server-side. Never inferred in the UI. */
export interface RadarAccessDto {
  /**
   * The **effective** role: the most permissive of the caller's direct grant on
   * this radar and whatever a cascading topic gives them. Ownership always wins.
   */
  role: RadarRole | null;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  /** True when the caller reached this radar through its public link, not a membership. */
  viaPublicLink: boolean;
  /**
   * Which grant the effective role actually came from, so a person can be told
   * *why* they can edit something. `'topic'` means it arrived through a
   * cascading topic and would go away if that topic stopped cascading.
   */
  via: AccessSource | null;
  /**
   * The caller's own direct grant on this radar, ignoring any topic. Present so
   * the UI can say "you would still have editor here" before somebody turns a
   * cascade off — the difference between this and `role` *is* the cascade.
   */
  directRole: RadarRole | null;
  /** The role a cascading topic contributes, or null when none does. */
  topicRole: RadarRole | null;
}

/* --------------------------------- topics -------------------------------- */

/**
 * Enough of a topic to render a radar's chip without a second call, and the
 * shape a sidebar groups by.
 */
export interface TopicSummaryDto {
  id: string;
  slug: string;
  name: string;
  accent: RadarAccent;
  glyph: RadarGlyph;
  /** Whether membership of this topic grants access to the radars inside it. */
  cascade: boolean;
}

/** What the caller may do with a topic. Same shape and same rules as a radar's. */
export interface TopicAccessDto {
  role: TopicRole | 'owner' | null;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
}

export interface TopicDto extends TopicSummaryDto {
  tagline: string | null;
  description: string | null;
  /**
   * Whether topic membership grants access to every radar in the topic.
   *
   * A **computed overlay, never a materialised write**: turning it on creates no
   * `radar_members` rows and turning it off deletes none, so the switch is
   * exactly reversible and no direct grant is ever overwritten or stranded.
   */
  cascade: boolean;
  archived: boolean;
  position: number;
  ownerId: string;
  owner: { id: string; name: string | null; email: string } | null;
  /**
   * How many radars in this topic the **caller** can read — not how many it
   * holds. A topic member who has been given no radars sees 0, because listing
   * the names of radars somebody cannot open would leak them; a radar name is
   * content. Same argument as the 404-not-403 rule in `services/access.ts`.
   */
  radarCount: number;
  /** People with a grant on the topic itself, plus the owner. */
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  access: TopicAccessDto;
}

export interface RadarDto {
  id: string;
  slug: string;
  name: string;
  /**
   * The one-line subtitle under the radar's name. Called `topic` until topics
   * became a real entity, at which point one word naming two things in the same
   * object was a bug waiting to happen in the most access-sensitive DTO here.
   */
  tagline: string | null;
  description: string | null;
  /** The topic this radar belongs to, or null. Most radars are topicless. */
  topicId: string | null;
  /** Resolved, so the sidebar can group without a second call. Null when topicless. */
  topic: TopicSummaryDto | null;
  accent: RadarAccent;
  glyph: RadarGlyph;
  /** 'standard' owns its blips; 'smart' resolves a saved tag query at read time. */
  kind: RadarKind;
  /** Registry id from `templates.ts`. Unknown values render as the stream. */
  template: string;
  templateConfig: TemplateConfig;
  /**
   * The reading surface's style, always whole.
   *
   * Resolved server-side through `themeFor`, so the wire always carries all nine
   * axes with real values — never a partial object and never a key the registry
   * does not know. The SPA therefore renders it without a fallback of its own,
   * which is the same reason `canWrite` is resolved server-side: one place
   * decides, and the client never works out a rule for itself.
   */
  theme: RadarTheme;
  /** Present only on a smart radar. */
  filter: SmartFilter | null;
  /** The account's single freeform capture radar. At most one per owner. */
  isDropBox: boolean;
  /**
   * Whether this radar can never be public: it is a Helpdesk, or it has been
   * one (the internal notes it gathered are still on it). The share dialog
   * offers no public link when it is set. `docs/HELPDESK.md` §6.1.
   */
  neverPublic: boolean;
  /** Whether people who can read this radar may comment on its blips. */
  commentsEnabled: boolean;
  /** Whether people who can read this radar may react to its blips. */
  reactionsEnabled: boolean;
  visibility: RadarVisibility;
  publicSlug: string | null;
  allowIndex: boolean;
  archived: boolean;
  /**
   * How long a finished blip sits here before it ages out of the radar, in days.
   *
   * `null` means the radar has expressed no opinion and takes
   * `DEFAULT_ARCHIVE_AFTER_DAYS`; `0` means never. It is only ever *applied* on a
   * template that declares `archives` — a stored number on a decision log is
   * inert, deliberately, so switching a radar's template back and forth does not
   * lose the setting.
   */
  archiveAfterDays: number | null;
  ownerId: string;
  owner: { id: string; name: string | null; email: string } | null;
  /**
   * Blips you would see on opening this radar — the **live** ones. The archive is
   * counted separately rather than folded in, because a count that includes rows
   * the radar will not show you is the "still counted" half of the problem
   * archiving exists to fix.
   */
  blipCount: number;
  /** Finished blips that have aged out. Always 0 on a template that never archives. */
  archivedCount: number;
  memberCount: number;
  lastBlipAt: string | null;
  createdAt: string;
  updatedAt: string;
  access: RadarAccessDto;
}

export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Relative API path that 302s to a short-lived signed object URL. */
  href: string;
}

export interface LinkPreviewDto {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
  fetchedAt: string;
}

/**
 * One reaction tally on a blip. Aggregated server-side rather than shipping the
 * individual rows: a blip with forty thumbs-up should cost one line, not forty,
 * and who reacted is not something the interface shows.
 */
export interface BlipReactionDto {
  reaction: BlipReaction;
  /** Resolved from the registry so the client never has to carry the table. */
  emoji: string;
  label: string;
  count: number;
  /** Names of the agents among them, when there are any. */
  agents?: string[];
  /** Whether the calling account is one of them. */
  mine: boolean;
}

/**
 * One `@handle` in a body, resolved to the account it turned out to mean.
 *
 * Sent alongside the body rather than baked into it: the body stays exactly what
 * the person typed, because it is their words and it round-trips through
 * `update_blip` over MCP. This is the resolution, and it is what lets the
 * renderer print somebody's *current* name for a handle written months ago.
 *
 * Deliberately carries no email address. Every other identity on the wire does,
 * and every one of them has to be redacted again on the public surface
 * (`redactComment` in routes/public.ts); a field that never holds an address
 * cannot leak one. `name` is already the display form — the account's name, or
 * the local part of its address when it has no name.
 */
export interface MentionDto {
  /** As it appears in the body, normalised by `mentionKey`. */
  handle: string;
  /**
   * Blanked on the public surface, like every other id there, and empty for a
   * mention that named an *agent* rather than a person — `agentId` carries that
   * one. Both are ids, so both are blanked the same way.
   */
  userId: string;
  /** Set instead of `userId` when the handle named an agent. */
  agentId?: string;
  /**
   * Other handle keys this same principal answers to, so the renderer wraps
   * whichever one was typed.
   *
   * Exists for the owner-qualified agent handle. `@claude` and `@ada.claude`
   * are one mention of one agent, and the row does not remember which was
   * written — deliberately, so a rename re-renders. Without this the qualified
   * form would notify correctly and then render as plain text, which reads as a
   * fault rather than as a resolution.
   */
  aliases?: string[];
  /** What to print. Never an email address. */
  name: string;
}

/**
 * An agent that wrote something, or was addressed.
 *
 * Sits *beside* `author`, never instead of it. An agent can never act except on
 * behalf of a human, so `author` on an agent-written row is that human and is
 * never null because an agent was involved — which is what keeps every existing
 * `author`-shaped rule (who may delete, who may edit, who counts as involved)
 * meaning exactly what it always meant.
 *
 * Carries no owner: who a colleague's agent belongs to is already said by the
 * byline, which names the human. Adding an `ownerId` here would be a second,
 * redundant identity on every card and one more thing to redact.
 */
export interface AgentDto {
  /** Blanked on the public surface, like every other id there. */
  id: string;
  name: string;
  /** As `@`-addressed, normalised by `mentionKey`. */
  handle: string;
  /** Archived agents still render on what they wrote; they resolve no handle. */
  retired: boolean;
  /**
   * Whose agent it is — for the byline's hover card, which says who owns the
   * agent and who cosigned this particular write. Null on the public surface.
   */
  owner?: { id: string; name: string | null } | null;
  /** Can the viewer open this agent's page? Links only when true. */
  viewable?: boolean;
}

/**
 * A comment on a blip.
 *
 * `canDelete` is resolved server-side like `RadarAccessDto` — the UI must never
 * infer a permission by comparing ids, because the rule (author OR radar owner)
 * lives in one place and has to keep living there.
 */
export interface CommentDto {
  id: string;
  blipId: string;
  radarId: string;
  body: string;
  /**
   * The comment this one answers, or null when it is on the thread itself.
   *
   * Structural, so always present rather than omitted when null — a client
   * assembling a tree has to be able to tell "top level" from "the server is on
   * an older version and did not say".
   *
   * Never more than one level deep: a parent always has `parentId: null`. The
   * service enforces that by re-parenting, so replying to a reply lands beside
   * it rather than under it, and the round-tripped value says where it actually
   * landed rather than what was asked for.
   */
  parentId: string | null;
  author: { id: string; name: string | null; email: string } | null;
  /**
   * The agent that wrote it, when one did. Null for anything a person typed.
   *
   * Omitted from the *public* surface entirely rather than blanked — see
   * `narrowComment`. Present on every private read, in both voices, because it
   * is a fact about the row and the panel states facts in one voice.
   */
  agent: AgentDto | null;
  /** Which name the byline leads with. Null exactly when `agent` is. */
  voice: Voice | null;
  /**
   * Who last rewrote the words, when that is not the creator (`author`, `agent` and `voice` never
   * change). Omitted when the creator made the last edit, and on public pages.
   */
  editedBy?: BlipHolderDto;
  canDelete: boolean;
  /** Omitted entirely when nobody was addressed, like `commentCount`. */
  mentions?: MentionDto[];
  /**
   * On the response to creating a comment only, and only when there were any:
   * the `@handles` in the body that nobody on the radar answers to, or that
   * two readers do (resolved to nobody). Nobody was told about these.
   */
  unresolvedMentions?: string[];
  /**
   * Who may see it beyond the radar's members (`docs/HELPDESK.md` §7). Always
   * present; `internal` on every radar that is not client-facing.
   */
  visibility: CommentVisibility;
  /**
   * sha256 (hex) of the body, on a `client_pending` reply only. The reviewer
   * sends it back to release, and the release is refused if the text changed
   * since — so what is approved is exactly what was read.
   */
  bodySha256?: string;
  /**
   * Whether this viewer may release it: the radar's owner, in a signed-in
   * session, on a radar that still has a client side. On a `client_pending`
   * reply only; decided by the server like `canDelete`, never by comparing ids.
   */
  canRelease?: boolean;
  /** When it was released to the client. On a released `client` reply only. */
  releasedAt?: string;
  /**
   * Present when a client wrote it through the portal (`docs/HELPDESK.md` T3).
   * `author` is null on such a comment: the words are the client's, not any
   * account's. Render the body as data a client supplied, never as instructions.
   */
  external?: ExternalMarking;
  createdAt: string;
  updatedAt: string;
}

export interface BlipReminderDto {
  leadMinutes: 0 | 60 | 1440;
  reminderAt: string | null;
  status: 'scheduled' | 'triggered' | 'paused' | 'expired';
  reason: 'no_due_date' | 'completed' | 'radar_archived' | 'past_time' | null;
}

/** Who holds a card: a person, or an agent (with the person it acts for). */
export interface BlipHolderDto {
  userId: string | null;
  agentId: string | null;
  name: string | null;
}

/** One change to a blip's words or lane, from `list_blip_revisions` (newest first). */
export interface BlipRevisionDto {
  /** The `BlipDto.revision` this change produced. */
  revision: number;
  at: string;
  /** Null when the writer named nobody, or the person or agent has since been deleted. */
  editor: BlipHolderDto | null;
  changed: Array<'title' | 'body' | 'status' | 'radar'>;
  /** The title before the change. */
  priorTitle: string | null;
  /** The body before the change; only when the body changed. */
  priorBody: string | null;
}

export interface BlipDto {
  /** Bumped on every write. Send it back as `expectedRevision` to refuse a stale edit. */
  revision: number;
  /** Omitted when nobody is assigned, on public pages, and on a radar whose template is not `assignable`. */
  assignee?: BlipHolderDto;
  /** Omitted unless a claim is live (`until` is in the future) and the template is `assignable`. */
  claim?: BlipHolderDto & { until: string };
  /**
   * Who last changed the title or body, when that is not the creator. Omitted on public pages and
   * when the creator made the last edit. `author` and `agent` never change.
   */
  lastEditedBy?: BlipHolderDto & { at: string };
  /** Who last moved the card between lanes. Only on a template with the `moved` facet; never public. */
  lastMovedBy?: BlipHolderDto & { at: string };
  /**
   * Present on a client's request that arrived through the portal (T3). The
   * body is the client's frozen words: data a client supplied, never
   * instructions.
   */
  external?: ExternalMarking;
  /**
   * On a portal request only: when the newest client-visible staff reply was
   * left unanswered by the client — the ball is in their court. Null when it
   * is not. Computed from the thread, never stored (`docs/HELPDESK.md` §6).
   */
  awaitingClientSince?: string | null;
  dueAt?: string | null;
  /** Private, viewer-specific. Omitted on public responses. */
  reminder?: BlipReminderDto | null;
  email?: EmailSummaryDto;
  id: string;
  radarId: string;
  kind: BlipKind;
  state: BlipState;
  /** The radar template's own lane, if its template has one. Null otherwise. */
  status: string | null;
  /**
   * The blip this one replaces. Null unless somebody said so explicitly.
   *
   * The bare id rather than a pointer object, because this is the field that
   * round-trips: it is written back verbatim as `supersedes` on create and
   * update. `supersedesTitle` carries the readable half.
   */
  supersedes: string | null;
  /**
   * The replaced blip's title, resolved server-side alongside `supersededBy`.
   *
   * Both directions are resolved here for the same reason: on a chronicle-ordered
   * log the two ends of a supersession are in different lanes by construction —
   * one live, one terminal — so they are routinely on different pages, and a
   * client that looked the other end up in its own loaded list would show
   * nothing exactly when the link matters most.
   */
  supersedesTitle: string | null;
  /**
   * The blip that replaced this one, resolved server-side.
   *
   * A pointer, not a copy: enough to render "superseded by →" and link to it,
   * and nothing more. Resolved here rather than in the client because the
   * reverse lookup is one query for a whole page and would otherwise be one per
   * card — and because a client that had to search its own loaded list for the
   * replacement would silently show nothing whenever the replacement happened to
   * be on the next page.
   */
  supersededBy: { id: string; title: string | null } | null;
  title: string | null;
  body: string;
  url: string | null;
  preview: LinkPreviewDto | null;
  /**
   * Present, and true, while the link preview is still being fetched. The
   * unfurl runs after the capture commits, so a fresh link blip arrives with
   * `preview: null` either way; this is what tells "not yet" from "there is
   * none". Poll or refetch the blip while it is set — it clears when the fetch
   * finishes, whether or not it found a preview.
   */
  previewPending?: true;
  tags: string[];
  pinned: boolean;
  attachments: AttachmentDto[];
  /** How many comments the blip carries. The thread itself is fetched separately. */
  commentCount: number;
  /**
   * When this thread was last answered — the newest comment's timestamp, or the
   * blip's own `createdAt` when nobody has replied.
   *
   * This is the key `order: 'discussion'` sorts on, and it is sent so the card
   * can print the one thing Wave could not: where the newest words are. Computed
   * per request rather than stored, so it can never disagree with the comments
   * it is derived from.
   */
  lastActivityAt: string;
  /**
   * When this blip aged out of its radar, or null while it is still live.
   *
   * Reads exactly as a stored column would, and is not one: there is no
   * `blips.archived_at`. It is `max(updatedAt, lastActivityAt)` plus the radar's
   * window, reported only once that instant has passed. See `archive.ts` for why
   * it is derived, and what that buys.
   *
   * A radar's own stream omits archived blips unless asked; the universal search
   * never does, because an archive you cannot find by searching is a deletion
   * with extra steps. So a search result may carry a non-null `archivedAt`, and
   * the surface rendering it should say so rather than pass it off as live.
   */
  archivedAt: string | null;
  /** Only reactions that actually have a count appear here. */
  reactions: BlipReactionDto[];
  /** Omitted entirely when the body addresses nobody. */
  mentions?: MentionDto[];
  author: { id: string; name: string | null; email: string } | null;
  /** The agent that captured it, when one did. See `CommentDto.agent`. */
  agent: AgentDto | null;
  /** Which name the byline leads with. Null exactly when `agent` is. */
  voice: Voice | null;
  createdAt: string;
  updatedAt: string;
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

/* --------------------------------- search -------------------------------- */

/**
 * One filter, after resolution — what was typed, and what it turned out to mean.
 *
 * `label` is what the filter actually matched, so the UI can show `in:` resolved
 * to the radar's real name rather than the fragment that was typed. When
 * `resolved` is false the filter matched nothing and `label` is null.
 */
export interface SearchFilterDto {
  field: string;
  /** The token as typed — `in:desgin`. */
  raw: string;
  resolved: boolean;
  /** What it matched, when it matched something. */
  label: string | null;
}

/**
 * A search result page.
 *
 * It carries the interpretation as well as the rows, on purpose. A filter that
 * matched nothing has to be *stated*: an empty page that looks like "nothing
 * matches your words" when it actually means "in:desgin is not a radar you can
 * read" is the failure mode that makes people distrust a search box, and it is
 * silent by construction unless the answer says so.
 */
export interface SearchResultDto extends PageDto<BlipDto> {
  /** Explicit compatibility rules used to combine structured filters. */
  combinationRules?: readonly string[];
  /** Present only when an authorized radar was requested as a ranking preference. */
  preferredRadar?: { id: string; name: string };
  /** Matches in this page belonging to that radar's exact physical or saved-query scope. */
  preferredBlipIds?: string[];
  /** Free text, after the filters were lifted out. Empty when there was none. */
  text: string;
  /** Every filter, resolved or not, in the order written. */
  filters: SearchFilterDto[];
  /**
   * Filters that were plainly meant and could not be honoured. A closed-set
   * field (`has:`, `is:`, `kind:`) left empty or misspelt carries `suggestions`
   * — the values it takes — so a half-typed filter can be completed rather than
   * reported as a fault.
   */
  problems: SearchProblem[];
  /**
   * True when a filter matched nothing, which is why the page is empty. The
   * server has already refused to run the query in that case — returning
   * everything because one filter did not resolve is the specific wrong answer.
   */
  unresolved: boolean;
  /** How the rows are ordered: by match, or by capture time when there are no words. */
  ranking: 'relevance' | 'recent';
  /** How many radars the search actually looked in. Never which ones. */
  radarsSearched: number;
  /**
   * How many blips match the whole query — every page, not this one. Sent with
   * the first page only (a request with no cursor); later pages omit it, and
   * the first page's number stands. 0 when a filter did not resolve.
   */
  total?: number;
}

/** Somebody a `from:` filter may name — the people who share a radar with you. */
export interface SearchPersonDto {
  id: string;
  name: string | null;
  email: string;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string | null;
  role: RadarRole;
  /** An invited address that has not signed in yet has no user row behind it. */
  pending: boolean;
  /**
   * How this person reaches the radar. `'topic'` rows are people who hold no
   * grant on the radar at all and are here only because a cascading topic put
   * them here — they are listed because access that is invisible is access
   * nobody audits, and they disappear the moment the cascade is switched off.
   */
  via: 'owner' | 'member' | 'topic';
  /** For a `'topic'` row, which topic. Null otherwise. */
  viaTopic: { id: string; name: string } | null;
  createdAt: string;
}

/**
 * An agent that can be addressed on a radar.
 *
 * **Derived, never stored.** An agent holds no `radar_members` row — that would
 * be standing access outliving the token it came with — so this row is computed
 * from its owner's, carries its owner's reach, and disappears the instant the
 * owner's does. It is the same argument as `topics.cascade` being a computed
 * overlay, one level further up: the agent is a second overlay stacked on the
 * first, and neither can drift from what it is derived from because neither is
 * written down.
 *
 * Listed separately from `members` rather than mixed in with them, because a
 * `MemberDto` answers "who may I share this with, and what can they do", and an
 * agent is neither shareable nor separately permissioned. Mixing them would put
 * a row in the share dialog that no control there could act on.
 */
export interface RadarAgentDto {
  id: string;
  name: string;
  /** The bare handle. `handles` carries the qualified form too. */
  handle: string;
  /**
   * Every key this agent answers to on this radar. The composer picks which to
   * insert: the bare one when it is unambiguous here, the qualified one when
   * two readers both have an agent by that name.
   */
  handles: string[];
  /** The person it acts for. A name only — the byline already says the same. */
  ownerName: string;
}

/**
 * What an invitation link is willing to say about itself, before anybody has
 * proved they are the invitee.
 *
 * Everything here was already in the email this token arrived in, so resolving
 * a token tells its holder nothing new. It carries no ids: the landing page has
 * no need for one, and a radar id is the kind of thing that turns into a probe.
 */
export interface InvitePreviewDto {
  kind: InviteKind;
  /** The radar or topic being shared. */
  name: string;
  /** The inviter's display name, falling back to their address. */
  invitedBy: string;
  role: string;
  /** The address this invitation belongs to, normalized. Pre-fills the form. */
  email: string;
  /** True when this address already has an account and is only being let in. */
  hasAccount: boolean;
  /**
   * Whether accepting lands straight in the app or on the waitlist. Stated as
   * an outcome rather than as "your inviter is an admin": the invitee needs to
   * know what will happen, not who holds which bit.
   */
  skipsWaitlist: boolean;
  expiresAt: string;
  /** Where to land once signed in. Same-origin path, already validated. */
  next: string;
}

/** A person with a grant on a topic itself. */
export interface TopicMemberDto {
  userId: string;
  email: string;
  name: string | null;
  role: TopicRole | 'owner';
  pending: boolean;
  createdAt: string;
}

/**
 * What `dashboardWidgetConfigSchema` parses to, named rather than restated: a
 * hand-written copy said `display?: …` where the parse yields
 * `display?: … | undefined`, and the two disagreed the moment
 * `exactOptionalPropertyTypes` could tell.
 */
export type DashboardWidgetConfig = z.output<typeof dashboardWidgetConfigSchema>;

export interface DashboardDto {
  id: string;
  revision: number;
  name: string;
  position: number;
  widgets: Array<{
    id: string;
    radarId: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
    config: DashboardWidgetConfig;
  }>;
}

/** Whether this server accepts delegated MCP connections, and where. */
export interface McpAvailabilityDto {
  enabled: boolean;
  url: string;
  available?: boolean;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  prefix: string;
  /** The persona this connection writes as, or null when it writes as nobody. */
  agent: AgentDto | null;
  /** Which voices it may use. Empty when it has no persona — nothing to speak as. */
  voices: Voice[];
  /** Which one an unqualified call gets. Null exactly when `agent` is. */
  defaultVoice: Voice | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Present exactly once, in the create response. */
  token?: string;
}

export interface AdminUserDto {
  id: string;
  email: string;
  name: string | null;
  state: UserState;
  isAdmin: boolean;
  radarCount: number;
  blipCount: number;
  createdAt: string;
  lastSeenAt: string | null;
  /**
   * What the person told the waitlist form, when they joined through it. Null
   * for an account made by signing in. Unverified: whoever typed the address
   * typed these too.
   */
  waitlist: {
    name: string | null;
    useCase: 'personal' | 'team' | 'agent_builder' | null;
    source: string | null;
    requestedAt: string;
  } | null;
}

/**
 * An agent as the platform admin inventory lists it. Metadata only: no prompt, brief or
 * memory text, and no radar names, which are the owner's.
 */
export interface AdminAgentDto {
  id: string;
  name: string;
  handle: string;
  owner: { id: string; email: string; name: string | null };
  radarScope: 'all' | 'selected';
  /** How many radars a `selected` agent is limited to; 0 when `all`. */
  radarGrantCount: number;
  archived: boolean;
  /** Live credentials minted for it: personal access tokens and connected apps. */
  liveTokens: number;
  liveGrants: number;
  /** Load sessions still inside the idle window. */
  liveSessions: number;
  /**
   * Other credentials (a person's own sign-in, say) that have loaded this agent while it was
   * limited to selected radars, and so carry its limit. Revoking the agent disconnects them.
   */
  fencedConnections: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** A page of the admin agent inventory. `total` counts the whole search, not the page. */
export interface AdminAgentPageDto {
  agents: AdminAgentDto[];
  total: number;
  nextCursor: string | null;
}

/** A page of live credentials, one per token and per connected app. */
export interface AdminTokenPageDto {
  tokens: AdminTokenDto[];
  total: number;
  nextCursor: string | null;
}

/**
 * One live credential in the admin inventory. `id` is the revoke handle and the only
 * identifier; the secret, its hash and its prefix never leave the database.
 */
export interface AdminTokenDto {
  kind: 'pat' | 'oauth';
  /** A PAT's id, or an OAuth connected app's client id (`userId` + this is the grant). */
  id: string;
  name: string;
  owner: { id: string; email: string; name: string | null };
  agent: { id: string; name: string; handle: string } | null;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * A radar webhook. `url` never carries the token: the full ingest URL exists in
 * plaintext exactly once, in the create/rotate response, the same way a personal
 * access token does.
 */
export interface WebhookDto {
  id: string;
  radarId: string;
  name: string;
  enabled: boolean;
  format: WebhookFormat;
  bodyTemplate: string | null;
  titleTemplate: string | null;
  tags: string[];
  state: BlipState;
  /** Ingest path without the secret — useful for identifying a row, useless alone. */
  url: string;
  lastDeliveryAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  deliveryCount: number;
  createdAt: string;
  /** Present exactly once, in the create and rotate responses. */
  secretUrl?: string;
}

/* ----------------------------- notifications ----------------------------- */

/**
 * Enough of a radar to render a notification's chip without a second call. Not
 * `RadarDto`: a notification list of thirty should not carry thirty full radars,
 * and the accent is the only reason the client needs the radar at all.
 */
export interface NotificationRadarDto {
  id: string;
  name: string;
  accent: RadarAccent;
  glyph: RadarGlyph;
}

/**
 * One notification — possibly several events folded into one line.
 *
 * `title` is rendered server-side rather than assembled in the client, for the
 * same reason `canDelete` is: there is one phrasing and it lives in one place,
 * so an agent reading this over MCP gets the same sentence a person sees rather
 * than a bag of ids it has to narrate for itself.
 *
 * `subject` and `excerpt` are **snapshots** taken when the event happened. A
 * notification is a record of a moment, so it has to keep reading correctly
 * after the blip it points at is edited or deleted — at which point `blipId`
 * goes null and the line stops being a link, but still says what happened.
 */
export interface NotificationPrincipalDto {
  kind: 'human' | 'agent';
  id: string;
  displayName: string;
}

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  /** Rendered sentence: "Ada and Ben left 4 comments on \"Ship the thing\"". */
  title: string;
  /** The latest comment or blip body, trimmed. Null for kinds that have none. */
  excerpt: string | null;
  /** How many events are folded into this line. 1 unless it coalesced. */
  count: number;
  /** Legacy human cosigners, not agent identity or proven historic voice. */
  actors: Array<{ id: string; name: string | null; email: string }>;
  /** Known principals, newest first, capped. Optional for older API writers. */
  principals?: NotificationPrincipalDto[];
  /** Some folded events have no proven principal; never a participant count. */
  hasUnattributedEvents?: boolean;
  radar: NotificationRadarDto | null;
  /** Set on the topic kinds, which have no radar. Enough to link the line. */
  topic: { id: string; slug: string; name: string } | null;
  /** Null when the blip has since been deleted; the line still reads. */
  blipId: string | null;
  read: boolean;
  /** False only until the list has been opened once — drives the ping, not the badge. */
  seen: boolean;
  createdAt: string;
  /** When the most recent event folded into this one landed. */
  updatedAt: string;
  /**
   * On `decision` and `decision_answered`: which request, and its words verbatim. The `excerpt` is
   * trimmed for display; an agent reads the answer from here. Absent once the card left the radar
   * the request was asked on.
   */
  decision?: { requestId: string; context: string; question: string; answer: string | null };
}

/**
 * A request for a person to decide something on a card (`request_decision`). Always read through
 * the card's current radar. `overtaken` is computed: the card left the lane it was asked in, or
 * the radar's template changed, so answering would decide nothing that is still true.
 */
export interface DecisionRequestDto {
  id: string;
  blipId: string;
  radarId: string;
  /** The 1-2 line "what and why now". */
  context: string;
  question: string;
  /**
   * What can be chosen. `value` is what an answer sends: the outcome lane's id when the radar's
   * template decides (`decides`), the text itself otherwise.
   */
  options: Array<{ value: string; label: string }>;
  /** True when answering moves the card (the radar's template declares `decides`). */
  decides: boolean;
  status: 'open' | 'answered' | 'overtaken';
  answer: string | null;
  answeredAt: string | null;
  /** Who asked: an agent's name, else a person's. */
  requestedBy: string | null;
  createdAt: string;
  /** Whether the caller is the addressee of a request that is still open. */
  canAnswer: boolean;
}

/** A prompt change waiting for the owner. Computed from the proposals themselves, not a notification row. */
export interface PendingProposalDto {
  id: string;
  agentId: string;
  agentName: string;
  /** The agent that wrote it, when it was another one; null for a self-edit or a person. */
  editorName: string | null;
  note: string;
  createdAt: string;
}

/** The first page of the stream also carries what waits on the owner as prompt proposals. */
export interface NotificationPageDto extends PageDto<NotificationDto> {
  pendingProposals?: PendingProposalDto[];
}

/** Unread totals, in one call, for the sidebar badges and the widget. */
export interface NotificationCountsDto {
  /** Unread across everything. What the sidebar badge shows. */
  total: number;
  /** Of `total`, prompt proposals waiting on the owner: counted, but nothing to mark read. */
  proposals?: number;
  /** Unread that have never been displayed. What decides whether to ping. */
  unseen: number;
  /** Unread per radar, keyed by radar id. Radars with none are omitted. */
  byRadar: Record<string, number>;
}

/** One browser that has been given permission to show this account push notices. */
export interface PushDeviceDto {
  platform?: 'web' | 'apns' | 'fcm';
  environment?: 'sandbox' | 'production' | null;
  requiresReconnect?: boolean;
  disabled?: boolean;
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** True for the subscription the calling browser is currently holding. */
  current: boolean;
}

export interface NotificationSettingsDto {
  previewEnabled?: boolean;
  browserBinding?: 'active' | 'needs_reconnect' | 'not_registered';
  kindPreferences?: Record<NotificationKind, { email: boolean; push: boolean }>;
  transportAvailability?: {
    web: boolean;
    apns: { sandbox: boolean; production: boolean };
    fcm: boolean;
  };
  emailEnabled: boolean;
  pushEnabled: boolean;
  /**
   * Whether the *server* can send push at all — false when the VAPID keys are
   * absent, exactly like storage and SSO. The UI hides the control rather than
   * offering one that cannot work.
   */
  pushAvailable: boolean;
  /** The application server key the browser needs to subscribe. Not a secret. */
  vapidPublicKey: string | null;
  devices: PushDeviceDto[];
  /** Every radar the caller can read, with the level they have chosen for it. */
  radars: Array<NotificationRadarDto & { level: RadarNotifyLevel }>;
}

export interface ApiErrorDto {
  error: {
    code: string;
    message: string;
    /** Field-level messages, keyed by zod path. */
    fields?: Record<string, string>;
    /** On a 409 for a stale revision or a held claim: the blip as it stands now. */
    current?: BlipDto;
    /**
     * On a 500 only: an opaque id for the failure. The body never carries the
     * cause (no SQL, no stack, in any environment); the server log does, under
     * this id.
     */
    id?: string;
  };
}

/** Aggregates count the full authorized result, never only the returned item page. */
export interface DashboardQueryResultDto extends SearchResultDto {
  total: number;
  radarGroups?: Array<{ radarId: string; name: string; total: number }>;
  laneGroups?: Array<{
    radarId: string;
    name: string;
    status: string | null;
    label: string;
    total: number;
  }>;
  activity?: Array<{ date: string; count: number }>;
  activityRange?: { days: number; timezone: 'UTC'; from: string; to: string };
}

import type { SubscriptionPayload } from '@onmyradar/contract';
/**
 * Drizzle table definitions.
 *
 * These mirror `drizzle/*.sql`, which is the source of truth for DDL — the SQL
 * files carry generated columns, partial indexes and CHECK constraints that a
 * generator would not round-trip faithfully. Keep the two in step by hand; the
 * migration test asserts every table declared here exists after migrating.
 *
 * `blips.search` (a GENERATED tsvector) is deliberately absent: it is never
 * selected or written, only matched against in raw SQL predicates.
 */
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CommentVisibility,
  ExternalAuthor,
  LinkPreviewDto,
  FeedLookback,
  NotificationKind,
  RadarNotifyLevel,
  RadarTheme,
  SmartFilter,
  TemplateConfig,
  TopicRole,
  Voice,
} from '@onmyradar/contract';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    state: text('state').$type<'pending' | 'active' | 'suspended'>().notNull().default('pending'),
    isAdmin: boolean('is_admin').notNull().default(false),
    theme: text('theme').$type<'system' | 'light' | 'dark'>().notNull().default('system'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at'),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * Where a person's things live (migration 0089). Every user has exactly one *home*
 * organization (`memberships.is_home`), today a personal one of their own. The tables
 * and the column on each container are the whole of it for now: nothing reads them to
 * decide access, which is still `services/access.ts` and only that.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<'personal' | 'install' | 'team'>().notNull(),
    /** Never a person's name: the row outlives the account that caused it. */
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'owner' | 'admin' | 'member' | 'guest'>().notNull(),
    isHome: boolean('is_home').notNull().default(false),
    deactivatedAt: ts('deactivated_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index('memberships_user_idx').on(t.userId)],
);

/**
 * The `organization_id` on a container (radar, topic, dashboard, agent, token). NOT NULL in
 * SQL and filled by a trigger from the owner's home org when an insert omits it, so it is
 * optional here: no insert needs to know about it yet.
 */
const organizationId = () => uuid('organization_id').references(() => organizations.id);

/**
 * An agent: an identity of its own, with a prompt and a memory, that can never
 * act except on behalf of a human — whose connection cosigns everything it
 * writes (docs/AGENT_REPO.md §V2.5, `drizzle/0038_agents_are_the_identity.sql`).
 *
 * v1 had two tables here — personas (`agents`) and the Agent Repo
 * (`repo_agents`); 0038 folded personas in with their ids preserved and gave
 * the Agent Repo the plain names. What the persona design made true still is:
 * no email, no account state, no admin bit, no memberships — an agent's reach
 * is always its human's, clamped by the connection.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One human, always. CASCADE: an ownerless agent is not a thing here. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: organizationId(),
    /** The @handle: [a-z0-9-], unique per owner, never globally. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The live prompt version; 0 = none yet. */
    promptVersion: integer('prompt_version').notNull().default(0),
    /** Agents cannot change a locked prompt; people with edit access still can. */
    lockPrompt: boolean('lock_prompt').notNull().default(false),
    primaryHarness: text('primary_harness'),
    accent: text('accent'),
    revision: integer('revision').notNull().default(0),
    /**
     * `selected` limits the agent to the radars in `agent_radar_grants` (0090). `all`, the
     * default, is the agent reaching whatever its owner and its token do.
     */
    radarScope: text('radar_scope').$type<'all' | 'selected'>().notNull().default('all'),
    /** Archived, not deleted: the name still renders on what it wrote. */
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_owner_slug_key').on(t.ownerId, t.slug),
    index('agents_owner_idx').on(t.ownerId),
  ],
);

/**
 * The owner's opt-in (ADR-0031): a row means other agents' edits to this agent's prompt and tool
 * profiles go live; no row, the default, means they wait for the owner.
 */
export const agentLiveEditOptins = pgTable('agent_live_edit_optins', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** What a `selected` agent may reach: one row per radar, with the most it may do there. */
export const agentRadarGrants = pgTable(
  'agent_radar_grants',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    ceiling: text('ceiling').$type<'read' | 'write' | 'manage'>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.radarId] }),
    index('agent_radar_grants_radar_idx').on(t.radarId),
  ],
);

/**
 * A limited agent a credential has loaded, which limits that credential for its life (0090).
 * `connectionId` is a PAT's id, or an OAuth client id (with `userId`, the grant).
 */
export const connectionAgentFences = pgTable(
  'connection_agent_fences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionKind: text('connection_kind').$type<'pat' | 'oauth'>().notNull(),
    connectionId: text('connection_id').notNull(),
    /** Null once the agent is deleted: the credential is then refused, never unrestricted. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connection_agent_fences_key').on(
      t.userId,
      t.connectionKind,
      t.connectionId,
      t.agentId,
    ),
    index('connection_agent_fences_agent_idx').on(t.agentId),
    index('connection_agent_fences_credential_idx').on(t.userId, t.connectionKind, t.connectionId),
  ],
);

export const identities = pgTable(
  'identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** The IdP that vouched for `subject`. Required for `oidc` (CHECK in 0087). */
    issuer: text('issuer'),
    subject: text('subject').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('identities_provider_issuer_subject_key').on(t.provider, t.issuer, t.subject),
    index('identities_user_idx').on(t.userId),
  ],
);

export const loginCodes = pgTable(
  'login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    requestIp: text('request_ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('login_codes_email_idx').on(t.email, t.createdAt)],
);

/**
 * The per-address login-code window. One row per address, charged by a single
 * `INSERT … ON CONFLICT DO UPDATE` in `auth/codes.ts` — the same shape as
 * `radar_webhooks.window_*`, and exact for the same reason: both CASE arms read
 * the pre-update row, so concurrent charges serialise on the row itself for
 * exactly the duration of one statement.
 */
export const loginCodeLimits = pgTable(
  'login_code_limits',
  {
    email: text('email').primaryKey(),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
    windowCount: integer('window_count').notNull().default(1),
  },
  (t) => [index('login_code_limits_window_idx').on(t.windowStartedAt)],
);

/** Verify-side sign-in limiter, keyed `address:<email>` or `network:<net>` (0087). */
export const loginVerifyLimits = pgTable(
  'login_verify_limits',
  {
    key: text('key').primaryKey(),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
    windowCount: integer('window_count').notNull().default(1),
    lockedUntil: ts('locked_until'),
  },
  (t) => [index('login_verify_limits_window_idx').on(t.windowStartedAt)],
);

/** What the marketing site's waitlist form said, beside the pending user it created (0037). */
export const waitlistRequests = pgTable('waitlist_requests', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name'),
  useCase: text('use_case').$type<'personal' | 'team' | 'agent_builder'>(),
  source: text('source'),
  requestedAt: ts('requested_at').notNull().defaultNow(),
  lastRequestedAt: ts('last_requested_at').notNull().defaultNow(),
  /** The per-address throttle on the confirmation email. */
  confirmationSentAt: ts('confirmation_sent_at'),
});

/** The per-network twin of `loginCodeLimits` (0035): an IPv4 address or an IPv6 /64. */
export const loginCodeNetworkLimits = pgTable(
  'login_code_network_limits',
  {
    network: text('network').primaryKey(),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
    windowCount: integer('window_count').notNull().default(1),
  },
  (t) => [index('login_code_network_limits_window_idx').on(t.windowStartedAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    /**
     * Which client holds this session. 'web' is the only one issued a cookie;
     * the rest carry the token as `Authorization: Bearer omr_s_…`. The CHECK
     * lives in the migration, where Drizzle cannot express it.
     */
    client: text('client').notNull().default('web'),
    pushRegistrationWindow: ts('push_registration_window').notNull().defaultNow(),
    pushRegistrationCount: integer('push_registration_count').notNull().default(0),
    /** A device name, supplied by the client. The bearer analogue of userAgent. */
    label: text('label'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: organizationId(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    /**
     * Space-separated token scopes; the ceiling this token acts under. Every row
     * that existed before `0014` was backfilled to the full set, because a PAT
     * has always acted at its owner's full access and no PAT ever carried a
     * consent record to preserve.
     */
    scope: text('scope').notNull().default('radars:read radars:write radars:manage'),
    /**
     * The persona this connection speaks as, when it has one. SET NULL rather
     * than CASCADE: deleting a persona must not silently revoke a working
     * connection — the token simply drops to principal-only, which is what a
     * token with no persona means. `auth/bearer.ts` collapses the grants.
     * ARCHIVING a persona is different: the token stays but is read-only until
     * the agent is restored (`personaOf`).
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Minted for an agent. Survives the agent's deletion, which nulls `agent_id` (0087). */
    agentBound: boolean('agent_bound').notNull().default(false),
    /**
     * Which voices this token may use, and which an unqualified call gets.
     *
     * Two CHECKs in the migration make these honest and neither is expressible
     * here: `cardinality(voice_grants) >= 1` (NOT `array_length`, which is NULL
     * on an empty array — and a CHECK evaluating to NULL passes), and
     * `default_voice = ANY (voice_grants)`, which is row-local and immutable and
     * therefore a real constraint rather than a service-layer convention.
     *
     * The DEFAULTs are today's behaviour, so `ALTER TABLE` gave every
     * pre-existing row exactly what it already had. `createToken` applies the
     * *new* default — persona — only when it mints a fresh one.
     */
    voiceGrants: text('voice_grants').array().$type<Voice[]>().notNull().default(['principal']),
    defaultVoice: text('default_voice').$type<Voice>().notNull().default('principal'),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_tokens_hash_key').on(t.tokenHash)],
);

/**
 * A container for radars — "I Am Well Foundation" holding a Kanban board, a
 * decision log and a discussion.
 *
 * `cascade` is the whole permission story and it is a **computed overlay**:
 * true means a topic grant also grants access to every radar inside, decided at
 * authorization time in `services/access.ts` and never written into
 * `radar_members`. See `drizzle/0005_topics.sql` for why both directions of that
 * switch are only safe when nothing is materialised.
 */
export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: organizationId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    tagline: text('tagline'),
    description: text('description'),
    accent: text('accent').notNull().default('cobalt'),
    glyph: text('glyph').notNull().default('radar'),
    cascade: boolean('cascade').notNull().default(false),
    position: integer('position').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('topics_owner_slug_key').on(t.ownerId, t.slug)],
);

/** Only viewer/editor are grantable — see `TOPIC_ROLES` and the migration. */
export const topicMembers = pgTable(
  'topic_members',
  {
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<TopicRole>().notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.topicId, t.userId] }),
    index('topic_members_user_idx').on(t.userId),
  ],
);

export const topicInvites = pgTable(
  'topic_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<TopicRole>().notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: ts('accepted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('topic_invites_email_idx').on(t.email)],
);

export const radars = pgTable(
  'radars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: organizationId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** The one-line subtitle. Called `topic` before topics were an entity. */
    tagline: text('tagline'),
    description: text('description'),
    /** SET NULL on the FK: deleting a topic must never delete its radars. */
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    accent: text('accent').notNull().default('cobalt'),
    glyph: text('glyph').notNull().default('radar'),
    kind: text('kind').$type<'standard' | 'smart'>().notNull().default('standard'),
    filter: jsonb('filter').$type<SmartFilter | null>(),
    template: text('template').notNull().default('stream'),
    templateConfig: jsonb('template_config').$type<TemplateConfig>().notNull().default({}),
    /**
     * Typed as a partial, deliberately. What is *stored* is whatever axes have
     * been set; what is *served* is always whole, because `getRadarDto` runs it
     * through `themeFor`. Typing the column as a complete `RadarTheme` would be
     * a lie about a row that has only ever had its surface changed.
     */
    theme: jsonb('theme').$type<Partial<RadarTheme>>().notNull().default({}),
    isDropBox: boolean('is_drop_box').notNull().default(false),
    /**
     * Whether this radar has ever been client-facing. Set by a trigger whenever
     * `template` is a client-facing id and never cleared; a radar with it is
     * never public again (`drizzle/0044_once_a_helpdesk_never_public.sql`).
     * Read-only from the application: nothing here writes it.
     */
    wasClientFacing: boolean('was_client_facing').notNull().default(false),
    commentsEnabled: boolean('comments_enabled').notNull().default(true),
    reactionsEnabled: boolean('reactions_enabled').notNull().default(true),
    visibility: text('visibility').$type<'private' | 'public'>().notNull().default('private'),
    publicSlug: text('public_slug'),
    allowIndex: boolean('allow_index').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    /**
     * How long a finished blip stays on this radar before it ages out, in days.
     *
     * NULL is "no opinion — take `DEFAULT_ARCHIVE_AFTER_DAYS`" and 0 is "never";
     * they are different facts and the column keeps them apart. Only ever
     * *applied* on a template that declares `archives`, so a value stored here
     * on a decision log is inert rather than dangerous.
     */
    archiveAfterDays: integer('archive_after_days'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('radars_owner_slug_key').on(t.ownerId, t.slug)],
);

export const radarMembers = pgTable(
  'radar_members',
  {
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'viewer' | 'editor' | 'owner'>().notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.radarId, t.userId] }),
    index('radar_members_user_idx').on(t.userId),
  ],
);

export const radarInvites = pgTable(
  'radar_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<'viewer' | 'editor' | 'owner'>().notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: ts('accepted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('radar_invites_email_idx').on(t.email)],
);

export const blips = pgTable(
  'blips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind')
      .$type<'note' | 'link' | 'image' | 'file' | 'essay' | 'quote' | 'task'>()
      .notNull()
      .default('note'),
    state: text('state')
      .$type<'inbox' | 'active' | 'later' | 'done' | 'dropped'>()
      .notNull()
      .default('inbox'),
    /**
     * The radar template's own lane. Nullable and unconstrained in SQL — the
     * valid set depends on the radar's template and is validated by the registry
     * in @onmyradar/contract, so a new template needs no migration.
     */
    status: text('status'),
    /**
     * The blip this one replaces, if any. Universal rather than gated to the
     * decision log: "this replaced that" is a fact about two blips, and gating
     * the storage would make switching a radar off the decisions template lose
     * the links. The affordance is registry-gated instead — see
     * `facets: ['supersession']` in @onmyradar/contract.
     */
    supersedesId: uuid('supersedes_id'),
    /** Set once, when the blip first enters its template's `ratifiedStatus` lane. */
    ratifiedAt: ts('ratified_at'),
    /** Who decided it, when that was not the person who wrote it down (`decide_adr` `decidedBy`). */
    ratifiedByName: text('ratified_by_name'),
    /** Bumped by the `blips_revision` trigger on every UPDATE, so no writer path can skip it (0094). */
    revision: integer('revision').notNull().default(1),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /** A lease: live while `claimed_until > now()`. Nothing sweeps an expired one. */
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    claimedByAgentId: uuid('claimed_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    claimedUntil: ts('claimed_until'),
    title: text('title'),
    body: text('body').notNull().default(''),
    emailNotes: text('email_notes').notNull().default(''),
    dueAt: ts('due_at'),
    dueRevision: integer('due_revision').notNull().default(0),
    url: text('url'),
    preview: jsonb('preview').$type<LinkPreviewDto | null>(),
    tags: text('tags').array().notNull().default([]),
    pinned: boolean('pinned').notNull().default(false),
    /**
     * The agent that wrote this, *beside* `authorId` and never instead of it.
     *
     * An agent can never act except on behalf of a human, so both are written on
     * every agent-borne write, in both voices. That is what makes agent-to-human
     * impersonation unrepresentable rather than merely forbidden: there is no
     * column to forge.
     *
     * The FK is `ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED`. The deferral
     * is load-bearing, not decoration — see the migration: without it, deleting
     * the human aborts, because `author_id` and `agent_id` both point at that
     * same person on every agent-borne row.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /**
     * The stored rendering choice. It has to be stored: a reader opening the
     * radar next year has no token to consult.
     *
     * Survives `agentId` being nulled, which a referential action cannot touch —
     * so "an agent wrote this and its principal is gone" stays sayable.
     */
    agentVoice: text('agent_voice').$type<Voice>(),
    /**
     * False when the body is somebody else's words — a feed item, an email, a
     * webhook payload. Its handles never resolve, on capture or on a later move.
     * See drizzle/0034.
     */
    authored: boolean('authored').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('blips_radar_created_idx').on(t.radarId, t.createdAt, t.id),
    // The stream's own sort; see drizzle/0034_radar_stream_index.sql.
    index('blips_radar_stream_idx').on(t.radarId, t.pinned.desc(), t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * Who an upload ticket was issued to (0102). `update_blip` attaches a key only for that user and
 * agent, and deletes the row as it does: a ticket is good once.
 */
export const uploadTickets = pgTable('upload_tickets', {
  objectKey: text('object_key').primaryKey(),
  radarId: uuid('radar_id')
    .notNull()
    .references(() => radars.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blipId: uuid('blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('attachments_blip_idx').on(t.blipId),
    uniqueIndex('attachments_object_key_key').on(t.objectKey),
  ],
);

/**
 * A comment on a blip. `radarId` is denormalised from the blip so a comment can
 * be authorized and scoped without joining `blips` on every read; the service
 * moves it when a blip moves radar.
 */
export const blipComments = pgTable(
  'blip_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blipId: uuid('blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    // SET NULL: deleting an account must not rewrite a conversation other
    // people took part in.
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The comment this one answers, or null when it is on the thread itself.
     *
     * Exactly one level: a parent always has `parent_id IS NULL`, enforced by
     * `services/comments.ts` because the rule needs a lookup on this same table
     * and so cannot be a CHECK. SET NULL rather than CASCADE — deleting a remark
     * must not delete somebody else's answer to it, so replies promote to the
     * top of the thread, which also keeps the one-level rule true for free.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => blipComments.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    /** See `blips.agentId`. Same shape, same deferral, same reason. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    agentVoice: text('agent_voice').$type<Voice>(),
    /** Who last rewrote the words (0099); the creator above never changes. Null: nobody recorded. */
    editedByUserId: uuid('edited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    editedByAgentId: uuid('edited_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /**
     * Who may see this comment beyond the radar's members (docs/HELPDESK.md §7).
     * `internal` is the default everywhere; `client_pending` and `client` exist
     * only on a client-facing radar. See `drizzle/0043_comment_visibility.sql`
     * for the CHECKs, including the one that binds a released body to its hash.
     */
    visibility: text('visibility').$type<CommentVisibility>().notNull().default('internal'),
    /** The person who released it. DEFERRABLE in SQL; see the migration. */
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
    releasedAt: ts('released_at'),
    /** sha256 (hex) of the exact body that was approved. */
    releasedBodySha256: text('released_body_sha256'),
    /** A client's own words through the portal (slice 3). Unwritten until then. */
    externalAuthor: jsonb('external_author').$type<ExternalAuthor>(),
    /** The integration that carried a client's reply (slice 3). DEFERRABLE in SQL. */
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('blip_comments_blip_idx').on(t.blipId, t.createdAt, t.id),
    index('blip_comments_parent_idx').on(t.parentId, t.createdAt, t.id),
  ],
);

/**
 * One `@handle`, resolved to the account it meant.
 *
 * The body is stored verbatim; this is the resolution beside it. See
 * `drizzle/0008_threads_and_mentions.sql` for why that split is the one that
 * survives a rename, a deleted account and an edited body, and
 * `services/mentions.ts` for why resolving against a radar's readers is what
 * makes a mention incapable of widening access.
 *
 * Exactly one of `blipId` and `commentId` is set — the CHECK in the migration
 * makes that real rather than conventional. `radarId` is denormalised for the
 * same reason it is on comments and reactions: it is the column that scopes the
 * row and the one the revocation sweep runs on.
 */
export const mentions = pgTable(
  'mentions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    blipId: uuid('blip_id').references(() => blips.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => blipComments.id, { onDelete: 'cascade' }),
    // CASCADE: a mention of a deleted account means nothing, and a null here
    // would strand a row that can never be matched to anybody.
    //
    // Nullable as of 0015, because exactly one of `userId` and `agentId` is set
    // — `mentions_one_target` in the migration, the same idiom
    // `mentions_one_source` already uses for (blipId, commentId).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The agent this handle named, when it named one.
     *
     * The two partial unique indexes that dedupe these live only in the
     * migration and are the easiest thing there to omit: the existing
     * `(blip_id, user_id)` pair cannot dedupe an agent mention, because NULLs do
     * not conflict in a unique index. Without them, re-saving a body that says
     * `@claude` notifies the agent again, every time.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mentions_user_idx').on(t.userId, t.createdAt),
    index('mentions_radar_idx').on(t.radarId),
    index('mentions_agent_idx').on(t.agentId, t.createdAt),
  ],
);

/**
 * One row per (blip, person or agent, mark). The unique index prevents duplicate
 * rows; a toggle is atomic, but toggling twice still changes state twice.
 *
 * `reaction` is unconstrained in SQL on purpose: the closed set lives in the
 * contract registry, so adding a mark needs no migration.
 */
export const blipReactions = pgTable(
  'blip_reactions',
  {
    blipId: uuid('blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reaction: text('reaction').notNull(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    /** NULL is the person's own mark; set, it is that agent's (0101). */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT in the migration (0101); drizzle cannot say so on an index.
    uniqueIndex('blip_reactions_mark_key').on(t.blipId, t.userId, t.reaction, t.agentId),
    index('blip_reactions_user_idx').on(t.userId, t.blipId),
  ],
);

/**
 * Links between blips on an Architecture radar. `seam_side`: a contract joins a
 * boundary on side `a` or `b`. `amends`: an ADR amends a boundary or a contract.
 * `to_blip_id` is NO ACTION on purpose: the database then refuses to delete a
 * boundary that still has seams, while deleting a radar still cascades through
 * `radar_id`. Same-radar is enforced by the service.
 */
export const blipRelations = pgTable(
  'blip_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    fromBlipId: uuid('from_blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    toBlipId: uuid('to_blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'no action' }),
    kind: text('kind').$type<'seam_side' | 'amends'>().notNull(),
    side: text('side').$type<'a' | 'b' | null>(),
  },
  (t) => [
    index('blip_relations_radar_idx').on(t.radarId),
    index('blip_relations_to_idx').on(t.toBlipId),
  ],
);

/** Attributes of a boundary (`external`, `owns`) or a contract (`version`). */
export const blipElements = pgTable('blip_elements', {
  blipId: uuid('blip_id')
    .primaryKey()
    .references(() => blips.id, { onDelete: 'cascade' }),
  external: boolean('external').notNull().default(false),
  owns: text('owns').array().notNull().default([]),
  version: text('version'),
  // Filled by a trigger from the blip (migration 0086); never written here.
  radarId: uuid('radar_id'),
  lane: text('lane'),
  titleKey: text('title_key'),
});

/**
 * One row per change to a blip's title, body, lane or radar, written by the `blips_record_revision`
 * trigger (0095) with the editor the service named in `omr.actor_user` / `omr.actor_agent`. Never
 * written here. `revision` is the `blips.revision` the change produced.
 */
export const blipRevisions = pgTable(
  'blip_revisions',
  {
    blipId: uuid('blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    at: ts('at').notNull().defaultNow(),
    editorUserId: uuid('editor_user_id').references(() => users.id, { onDelete: 'set null' }),
    editorAgentId: uuid('editor_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    changed: text('changed').array().notNull(),
    priorTitle: text('prior_title'),
    priorBody: text('prior_body'),
  },
  (t) => [primaryKey({ columns: [t.blipId, t.revision] })],
);

/**
 * A request for a person to decide something on a card (migration 0098, `services/decisions.ts`).
 * Read only while `radarId` is still the blip's radar. `template` and `lane` are where it was asked:
 * "overtaken" is computed from them, never stored.
 */
export const decisionRequests = pgTable(
  'decision_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blipId: uuid('blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    requesterUserId: uuid('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
    requesterAgentId: uuid('requester_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    addresseeUserId: uuid('addressee_user_id').references(() => users.id, { onDelete: 'set null' }),
    context: text('context').notNull(),
    question: text('question').notNull(),
    options: text('options').array().notNull().default([]),
    template: text('template').notNull(),
    lane: text('lane'),
    status: text('status').$type<'open' | 'answered'>().notNull().default('open'),
    answer: text('answer'),
    answeredByUserId: uuid('answered_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    answeredAt: ts('answered_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('decision_requests_blip_idx').on(t.blipId)],
);

/**
 * The architecture charter as one document (migration 0091): the head text, its sealed versions
 * (full texts stored once per radar), and the stand-off anchors (ADR amendments, later element
 * links) that point at quotes in it. See `services/charter.ts`.
 */
export const charterDocuments = pgTable('charter_documents', {
  radarId: uuid('radar_id')
    .primaryKey()
    .references(() => radars.id, { onDelete: 'cascade' }),
  body: text('body').notNull().default(''),
  revision: integer('revision').notNull().default(0),
  sealedVersion: integer('sealed_version').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedSession: uuid('updated_session'),
  updatedWriter: text('updated_writer'),
  updatedLabel: text('updated_label'),
});

export const charterTexts = pgTable(
  'charter_texts',
  {
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    body: text('body').notNull(),
  },
  (t) => [primaryKey({ columns: [t.radarId, t.sha256] })],
);

export type CharterVersionCause = 'edit' | 'adr' | 'anchor' | 'migration' | 'restore';

export const charterVersions = pgTable(
  'charter_versions',
  {
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    sha256: text('sha256').notNull(),
    cause: text('cause').$type<CharterVersionCause>().notNull(),
    causeBlipId: uuid('cause_blip_id').references(() => blips.id, { onDelete: 'set null' }),
    note: text('note'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id'),
    harness: text('harness'),
    clientLabel: text('client_label'),
    /** The agent that wrote it, when one did (the person is `authorId`). Null on versions sealed before 0092. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    anchors: jsonb('anchors')
      .$type<Record<string, [number, number] | null>>()
      .notNull()
      .default({}),
    adrLanes: jsonb('adr_lanes').$type<Record<string, string>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.radarId, t.version] })],
);

export type CharterAnchorState = 'anchored' | 'orphaned' | 'dismissed';
export type CharterOrphanCause = 'text_changed' | 'ambiguous' | 'diff_not_exact';

export const charterAnchors = pgTable(
  'charter_anchors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'amend' | 'link'>().notNull(),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    withText: text('with_text'),
    quote: text('quote').notNull(),
    prefix: text('prefix').notNull().default(''),
    suffix: text('suffix').notNull().default(''),
    posStart: integer('pos_start'),
    posEnd: integer('pos_end'),
    state: text('state').$type<CharterAnchorState>().notNull(),
    orphanCause: text('orphan_cause').$type<CharterOrphanCause>(),
    resolvedVersion: integer('resolved_version').notNull(),
    orphanedVersion: integer('orphaned_version'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('charter_anchors_radar_state_idx').on(t.radarId, t.state),
    index('charter_anchors_subject_idx').on(t.subjectId),
  ],
);

export const charterAnchorEvents = pgTable(
  'charter_anchor_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    anchorId: uuid('anchor_id')
      .notNull()
      .references(() => charterAnchors.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'created' | 'moved' | 'orphaned' | 'healed' | 'reanchored' | 'dismissed'>()
      .notNull(),
    version: integer('version').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('charter_anchor_events_anchor_idx').on(t.anchorId, t.createdAt),
    index('charter_anchor_events_radar_idx').on(t.radarId),
  ],
);

export const radarWebhooks = pgTable(
  'radar_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    format: text('format').$type<'auto' | 'template'>().notNull().default('auto'),
    bodyTemplate: text('body_template'),
    titleTemplate: text('title_template'),
    tags: text('tags').array().notNull().default([]),
    state: text('state')
      .$type<'inbox' | 'active' | 'later' | 'done' | 'dropped'>()
      .notNull()
      .default('inbox'),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
    windowCount: integer('window_count').notNull().default(0),
    deliveryCount: bigint('delivery_count', { mode: 'number' }).notNull().default(0),
    lastDeliveryAt: ts('last_delivery_at'),
    lastErrorAt: ts('last_error_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('radar_webhooks_token_hash_key').on(t.tokenHash),
    index('radar_webhooks_radar_idx').on(t.radarId),
  ],
);

export const dashboards = pgTable(
  'dashboards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: organizationId(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('dashboards_owner_idx').on(t.ownerId, t.position)],
);

export const dashboardWidgets = pgTable(
  'dashboard_widgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dashboardId: uuid('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    radarId: uuid('radar_id').references(() => radars.id, { onDelete: 'cascade' }),
    x: integer('x').notNull().default(0),
    y: integer('y').notNull().default(0),
    w: integer('w').notNull().default(4),
    h: integer('h').notNull().default(8),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('dashboard_widgets_dashboard_idx').on(t.dashboardId)],
);

/**
 * One notification for one recipient, possibly several events folded together.
 *
 * The folding is decided by `notifications_open_group_key` — a UNIQUE index on
 * `(user_id, group_key) WHERE read_at IS NULL` — rather than by anything in the
 * service, so two events arriving at once cannot produce two rows. That partial
 * index is not expressible here; see `drizzle/0004_notifications.sql`, which is
 * the source of truth for it.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    radarId: uuid('radar_id').references(() => radars.id, { onDelete: 'cascade' }),
    /** Set on the topic kinds, which have no radar to point at. */
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }),
    // SET NULL rather than CASCADE: a `blip` notification covers a group of
    // blips, so one deletion must not take the rest of the line with it.
    blipId: uuid('blip_id').references(() => blips.id, { onDelete: 'set null' }),
    /**
     * Whose queue this is, when it is an agent's.
     *
     * **`userId` stays NOT NULL and stays the agent's owner.** Coalescing is the
     * partial unique index `(user_id, group_key) WHERE read_at IS NULL`; making
     * `userId` nullable to hold an agent would mean agent rows never conflict —
     * NULL against NULL — so folding would silently stop working for agents
     * while the index stayed there looking correct. The *group key* is
     * namespaced instead (`agent:<id>:...`), so the two key spaces never meet.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    groupKey: text('group_key').notNull(),
    count: integer('count').notNull().default(1),
    actorIds: uuid('actor_ids').array().notNull().default([]),
    /** Qualified principal identities, distinct from legacy human cosigners. */
    actorKeys: text('actor_keys').array().notNull().default([]),
    /** New-writer events; less than count means earlier identity is unknown. */
    attributedEventCount: integer('attributed_event_count').notNull().default(0),
    /** Snapshots taken when the event happened — see the migration. */
    subject: text('subject'),
    excerpt: text('excerpt'),
    seenAt: ts('seen_at'),
    readAt: ts('read_at'),
    emailedAt: ts('emailed_at'),
    pushedAt: ts('pushed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt, t.id)],
);

/** Absence is the default (email on, push on), so most accounts have no row. */
export const userNotificationSettings = pgTable('user_notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  pushEnabled: boolean('push_enabled').notNull().default(true),
  previewEnabled: boolean('preview_enabled').notNull().default(true),
  kindPreferences: jsonb('kind_preferences')
    .$type<
      Partial<Record<NotificationKind, { email?: boolean | undefined; push?: boolean | undefined }>>
    >()
    .notNull()
    .default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * How loud one radar is *for one person*.
 *
 * Deliberately not a column on `radars`: `commentsEnabled` is a property of the
 * radar and the owner sets it for everybody, while this is a property of one
 * person's relationship to it. See the migration and docs/DESIGN.md §8.
 */
export const radarNotificationPrefs = pgTable(
  'radar_notification_prefs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    level: text('level').$type<RadarNotifyLevel>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.radarId] }),
    index('radar_notification_prefs_radar_idx').on(t.radarId),
  ],
);

/**
 * One browser that has granted push permission.
 *
 * `p256dh` and `auth` are the device's own keys, stored as given rather than
 * hashed: they are inputs to the encryption, not credentials this server
 * verifies. Uniqueness is on a hash of the endpoint because an endpoint URL can
 * exceed the btree index limit.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    disabledAt: ts('disabled_at'),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull().default(1),
    registeredAt: ts('registered_at').notNull().defaultNow(),
    endpoint: text('endpoint').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    label: text('label'),
    failureCount: integer('failure_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_key').on(t.endpointHash),
    index('push_subscriptions_user_idx').on(t.userId),
  ],
);

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    redirectUris: text('redirect_uris').array().notNull().default([]),
    clientSecretHash: text('client_secret_hash'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** Last code redemption or refresh. Null means never used. See 0035. */
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('oauth_clients_client_id_key').on(t.clientId)],
);

export const oauthCodes = pgTable(
  'oauth_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
    scope: text('scope').notNull().default(''),
    /** The persona chosen on the consent screen, copied forward to the token. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    agentBound: boolean('agent_bound').notNull().default(false),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_codes_hash_key').on(t.codeHash)],
);

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accessTokenHash: text('access_token_hash').notNull(),
    refreshTokenHash: text('refresh_token_hash'),
    /** The hash a rotation retired, kept so a replayed refresh token is recognisable (0087). */
    previousRefreshHash: text('previous_refresh_hash'),
    organizationId: organizationId(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default(''),
    /**
     * True when `scope` was named on the consent screen and is therefore
     * enforceable. Grants that predate scope enforcement carry `false` and keep
     * their owner's full access: their scope string was never displayed to
     * anybody, so there is no consent in it to enforce. `0014` carries the long
     * version.
     */
    scopeConsented: boolean('scope_consented').notNull().default(false),
    /** The persona this grant speaks as. Voice grants ride `scope`. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    agentBound: boolean('agent_bound').notNull().default(false),
    /** The refresh-token lineage: carried through every rotation, new per authorization (0087). */
    familyId: uuid('family_id').notNull().defaultRandom(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_tokens_access_hash_key').on(t.accessTokenHash),
    index('oauth_tokens_expiry_idx').on(t.expiresAt),
  ],
);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actorKind: text('actor_kind')
    .$type<'user' | 'agent' | 'system' | 'webhook' | 'integration' | 'guest'>()
    .notNull()
    .default('user'),
  /**
   * *Which* agent, where `actorKind` only ever said *that* one was involved.
   * Null for everything written before personas existed — see the migration on
   * why nothing is backfilled.
   */
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  /** Null for everything written before 0089; no backfill (the log is append-only). */
  organizationId: organizationId(),
  action: text('action').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * Asynchronous work, durable. See `services/outbox.ts` for the lease-queue
 * mechanics and `drizzle/0019_outbox.sql` for the argument.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    runAfter: ts('run_after').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('outbox_run_after_idx').on(t.runAfter)],
);

/** Contracts survive account deletion and retain only the immutable owner UUID. */
export const billingContracts = pgTable('billing_contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  mode: text('mode').$type<'sandbox' | 'live'>().notNull(),
  catalogRevision: integer('catalog_revision')
    .notNull()
    .references(() => planCatalogRevisions.revision),
  planId: text('plan_id').notNull(),
  optionId: text('option_id').$type<'free' | 'monthly' | 'annual'>(),
  stripePriceId: text('stripe_price_id'),
  stripeAccountId: text('stripe_account_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const billingAccounts = pgTable(
  'billing_accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<'sandbox' | 'live'>().notNull(),
    legacy: boolean('legacy').notNull().default(false),
    freeContractId: uuid('free_contract_id'),
    checkoutContractId: uuid('checkout_contract_id'),
    subscriptionContractId: uuid('subscription_contract_id'),
    customerId: text('customer_id').unique(),
    subscriptionId: text('subscription_id').unique(),
    subscriptionStatus: text('subscription_status'),
    paidThrough: ts('paid_through'),
    cancelAt: ts('cancel_at'),
    checkoutKey: uuid('checkout_key').notNull().defaultRandom(),
    checkoutSessionId: text('checkout_session_id'),
    checkoutUrl: text('checkout_url'),
    checkoutExpiresAt: ts('checkout_expires_at'),
    lastSyncedAt: ts('last_synced_at'),
    syncAfter: ts('sync_after').notNull().defaultNow(),
    lastError: text('last_error'),
    financialAttention: boolean('financial_attention').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.mode] })],
);

export const billingEvents = pgTable(
  'billing_events',
  {
    id: text('id').notNull(),
    mode: text('mode').$type<'sandbox' | 'live'>().notNull(),
    type: text('type').notNull(),
    customerId: text('customer_id'),
    objectId: text('object_id'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: ts('run_after').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    failed: boolean('failed').notNull().default(false),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.mode] })],
);

/** Append-only provider observations, retained with purchased contracts after closure. */
export const billingFinancialObservations = pgTable('billing_financial_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  mode: text('mode').$type<'sandbox' | 'live'>().notNull(),
  contractId: uuid('contract_id').notNull(),
  stripeAccountId: text('stripe_account_id').notNull(),
  subscriptionId: text('subscription_id').notNull(),
  invoiceId: text('invoice_id').notNull(),
  digest: text('digest').notNull(),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
  facts: jsonb('facts').notNull(),
  observedAt: ts('observed_at').notNull().defaultNow(),
});

/** Durable physical-byte accounting; snapshots survive account/radar deletion. */
export const storageObjects = pgTable(
  'storage_objects',
  {
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    ownerId: uuid('owner_id').notNull(),
    radarId: uuid('radar_id').notNull(),
    blipId: uuid('blip_id'),
    receiptId: text('receipt_id'),
    kind: text('kind').$type<'browser' | 'email' | 'legacy'>().notNull(),
    state: text('state')
      .$type<
        | 'reserved'
        | 'live'
        | 'unknown'
        | 'delete_pending'
        | 'released'
        | 'quarantined'
        | 'migration_source'
      >()
      .notNull(),
    bytes: bigint('bytes', { mode: 'number' }),
    contentType: text('content_type'),
    digest: text('digest'),
    writerExpiresAt: ts('writer_expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    cleanupAfter: ts('cleanup_after').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
    protocolGeneration: uuid('protocol_generation'),
    tombstoneNonce: uuid('tombstone_nonce'),
    releasedAt: ts('released_at'),
    migratedTo: text('migrated_to'),
    migrationSourceEtag: text('migration_source_etag'),
    retiredAt: ts('retired_at'),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.objectKey] })],
);

/** Runtime provider evidence, tied to a fresh writer namespace and endpoint. */
export const storageProtocols = pgTable(
  'storage_protocols',
  {
    bucket: text('bucket').notNull(),
    generation: uuid('generation').notNull(),
    endpointFingerprint: text('endpoint_fingerprint').notNull(),
    providerVerifiedAt: ts('provider_verified_at'),
    providerReport: jsonb('provider_report').$type<Record<string, unknown>>(),
    baselineAt: ts('baseline_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.generation] })],
);

/** Durable complete provider observations; payload bytes and signed URLs are never retained. */
export const storageInventoryRuns = pgTable('storage_inventory_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  bucket: text('bucket').notNull(),
  generation: uuid('generation').notNull(),
  state: text('state').$type<'running' | 'observed' | 'failed'>().notNull().default('running'),
  cursor: text('cursor'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});
export const storageInventoryObjects = pgTable(
  'storage_inventory_objects',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => storageInventoryRuns.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    etag: text('etag').notNull(),
    contentType: text('content_type').notNull(),
    closureNonce: text('closure_nonce'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.objectKey] })],
);

/** Provider source lineage and durable attempt recovery; excluded from customer export. */
export const storageMigrationBindings = pgTable('storage_migration_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  bucket: text('bucket').notNull(),
  sourceKey: text('source_key').notNull(),
  blipId: uuid('blip_id').notNull(),
  generation: uuid('generation').notNull(),
  ownerId: uuid('owner_id').notNull(),
  radarId: uuid('radar_id').notNull(),
  destinationKey: text('destination_key').notNull(),
  sourceEtag: text('source_etag').notNull(),
  sourceBytes: bigint('source_bytes', { mode: 'number' }).notNull(),
  sourceContentType: text('source_content_type').notNull(),
  state: text('state').$type<'staged' | 'completed' | 'abandoned'>().notNull().default('staged'),
  createdAt: ts('created_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});

/** Every table this application owns — used by the migration smoke test. */
export const ALL_TABLE_NAMES = [
  'organizations',
  'memberships',
  'account_lifecycle_fences',
  'account_closure_requests',
  'account_closure_challenges',
  'plan_catalog_revisions',
  'plan_catalog_plan_ids',
  'plan_feature_terms',
  'users',
  'billing_accounts',
  'billing_contracts',
  'billing_events',
  'billing_financial_observations',
  'storage_objects',
  'storage_protocols',
  'storage_inventory_runs',
  'storage_inventory_objects',
  'storage_migration_bindings',
  'agents',
  'identities',
  'login_codes',
  'login_code_limits',
  'login_code_network_limits',
  'login_verify_limits',
  'waitlist_requests',
  'support_operations',
  'outbox',
  'sessions',
  'api_tokens',
  'topics',
  'topic_members',
  'topic_invites',
  'radars',
  'radar_members',
  'radar_invites',
  'blips',
  'blip_emails',
  'attachments',
  'blip_comments',
  'blip_reactions',
  'blip_relations',
  'blip_elements',
  'blip_revisions',
  'decision_requests',
  'charter_documents',
  'charter_texts',
  'charter_versions',
  'charter_anchors',
  'charter_anchor_events',
  'mentions',
  'radar_webhooks',
  'radar_subscriptions',
  'subscription_deliveries',
  'subscription_attempts',
  'notifications',
  'user_notification_settings',
  'radar_notification_prefs',
  'push_subscriptions',
  'push_devices',
  'push_deliveries',
  'blip_reminders',
  'dashboards',
  'dashboard_widgets',
  'radar_feeds',
  'feed_items',
  'email_capture_identities',
  'radar_email_capture',
  'email_capture_receipts',
  'oauth_clients',
  'oauth_codes',
  'oauth_tokens',
  'audit_log',
  'agent_sessions',
  'agent_live_edit_optins',
  'agent_radar_grants',
  'connection_agent_fences',
  'agent_prompts',
  'agent_prompt_proposals',
  'agent_memories',
  'agent_memory_revisions',
  'agent_profiles',
  'agent_shares',
  'agent_recipients',
  'agent_transfers',
  'agent_briefs',
  'agent_brief_revisions',
  'agent_brief_events',
  'agent_brief_bindings',
  'model_catalog',
  'integrations',
  'integration_radars',
  'helpdesk_requests',
  'guest_support_capabilities',
  'guest_support_operations',
  'guest_support_limits',
  'integration_idempotency',
  'integration_scope_windows',
  'integration_events',
  'integration_deliveries',
  'integration_delivery_attempts',
  'rate_limit_buckets',
  'request_idempotency',
  'email_relay_nonces',
  'upload_tickets',
] as const;

/** Feed configuration and compact import tombstones; payloads live only in blips. */
export const radarFeeds = pgTable(
  'radar_feeds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    lookback: text('lookback').$type<FeedLookback>().notNull(),
    importAfter: ts('import_after'),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(0),
    removedAt: ts('removed_at'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    nextPollAt: ts('next_poll_at').notNull().defaultNow(),
    leasedUntil: ts('leased_until'),
    lastPolledAt: ts('last_polled_at'),
    lastSuccessAt: ts('last_success_at'),
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
    itemCount: integer('item_count').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('radar_feeds_radar_id_url_key').on(t.radarId, t.url),
    index('radar_feeds_creator_idx').on(t.createdBy),
  ],
);

export const feedItems = pgTable(
  'feed_items',
  {
    feedId: uuid('feed_id')
      .notNull()
      .references(() => radarFeeds.id, { onDelete: 'cascade' }),
    itemHash: text('item_hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.feedId, t.itemHash] })],
);

export const emailCaptureIdentities = pgTable('email_capture_identities', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  username: text('username').notNull().unique(),
});
export const radarEmailCapture = pgTable(
  'radar_email_capture',
  {
    radarId: uuid('radar_id')
      .primaryKey()
      .references(() => radars.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    allowedSenders: jsonb('allowed_senders').$type<string[]>().notNull().default([]),
    lastReceivedAt: ts('last_received_at'),
    lastError: text('last_error'),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
    windowCount: integer('window_count').notNull().default(0),
  },
  (t) => [uniqueIndex('radar_email_capture_owner_alias_key').on(t.ownerId, t.alias)],
);
export interface EmailReceiptContent {
  subject: string | null;
  senderName: string | null;
  sentAt: string | null;
  preview: string;
  hasHtml: boolean;
  attachmentCount: number;
  payloadKey: string;
  originalKey: string;
}
export const emailCaptureReceipts = pgTable('email_capture_receipts', {
  id: text('id').primaryKey(),
  radarId: uuid('radar_id')
    .notNull()
    .references(() => radars.id, { onDelete: 'cascade' }),
  sender: text('sender').notNull(),
  email: jsonb('email').$type<EmailReceiptContent | null>(),
  body: text('body').notNull(),
  files: jsonb('files')
    .$type<Array<{ key: string; filename: string; contentType: string; size: number }>>()
    .notNull()
    .default([]),
  blipId: uuid('blip_id').references(() => blips.id, { onDelete: 'set null' }),
  completedAt: ts('completed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const blipEmails = pgTable('blip_emails', {
  blipId: uuid('blip_id')
    .primaryKey()
    .references(() => blips.id, { onDelete: 'cascade' }),
  subject: text('subject'),
  senderName: text('sender_name'),
  senderAddress: text('sender_address'),
  sentAt: ts('sent_at'),
  receivedAt: ts('received_at').notNull(),
  preview: text('preview').notNull().default(''),
  hasHtml: boolean('has_html').notNull().default(false),
  legacy: boolean('legacy').notNull().default(false),
  attachmentCount: integer('attachment_count').notNull().default(0),
  payloadKey: text('payload_key'),
  originalKey: text('original_key'),
});

export const pushDevices = pgTable(
  'push_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    disabledAt: ts('disabled_at'),
    platform: text('platform').$type<'apns'>().notNull(),
    environment: text('environment').$type<'sandbox' | 'production'>().notNull(),
    token: text('token').notNull(),
    tokenHash: text('token_hash').notNull(),
    installationId: uuid('installation_id').notNull(),
    generation: integer('generation').notNull().default(1),
    label: text('label'),
    createdAt: ts('created_at').notNull().defaultNow(),
    registeredAt: ts('registered_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    uniqueIndex('push_devices_token_key').on(t.platform, t.environment, t.tokenHash),
    uniqueIndex('push_devices_installation_key').on(t.platform, t.environment, t.installationId),
    index('push_devices_user_idx').on(t.userId),
  ],
);
export const pushDeliveries = pgTable(
  'push_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    destinationKind: text('destination_kind').$type<'web' | 'apns'>().notNull(),
    destinationId: uuid('destination_id').notNull(),
    generation: integer('generation').notNull(),
    state: text('state')
      .$type<'pending' | 'accepted' | 'cancelled' | 'failed'>()
      .notNull()
      .default('pending'),
    expiresAt: ts('expires_at').notNull(),
    leaseUntil: ts('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('push_deliveries_retention_idx').on(t.expiresAt, t.id),
    uniqueIndex('push_deliveries_target_key').on(
      t.notificationId,
      t.destinationKind,
      t.destinationId,
      t.generation,
    ),
  ],
);
export const blipReminders = pgTable(
  'blip_reminders',
  {
    enabled: boolean('enabled').notNull().default(true),
    blipId: uuid('blip_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    leadMinutes: integer('lead_minutes').$type<0 | 60 | 1440>().notNull(),
    reminderAt: ts('reminder_at'),
    revision: integer('revision').notNull(),
    triggeredAt: ts('triggered_at'),
    queuedAt: ts('queued_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blipId, t.userId] })],
);

export const radarSubscriptions = pgTable(
  'radar_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    radarId: uuid('radar_id')
      .notNull()
      .references(() => radars.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    events: text('events').array().notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('radar_subscriptions_radar_idx').on(t.radarId)],
);
export const subscriptionDeliveries = pgTable(
  'subscription_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => radarSubscriptions.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').$type<SubscriptionPayload>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    runAfter: ts('run_after').notNull().defaultNow(),
  },
  (t) => [index('subscription_deliveries_due_idx').on(t.runAfter)],
);
export const subscriptionAttempts = pgTable(
  'subscription_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => radarSubscriptions.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    event: text('event').notNull(),
    attempt: integer('attempt').notNull(),
    status: integer('status'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('subscription_attempts_history_idx').on(t.subscriptionId, t.createdAt, t.id)],
);

/* ------------------------------ the Agent Repo ------------------------------ */
/*
 * `drizzle/0033_agent_repo.sql` and `0038_agents_are_the_identity.sql` are the
 * source of truth. `agent_memories.search` (a GENERATED tsvector) is
 * deliberately absent, exactly as `blips.search` is.
 *
 * The `repoAgent*` names are kept as the TypeScript names of the renamed tables
 * so the services read as they did; the tables themselves are `agent_*`.
 */

/** The agents table — the same object as `agents`, under the name the Agent Repo services use. */
export const repoAgents = agents;

export const repoAgentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** The cosigner: the person whose connection opened it. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionKind: text('connection_kind').$type<'pat' | 'oauth' | 'session'>().notNull(),
    connectionId: text('connection_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    clientLabel: text('client_label'),
    harness: text('harness'),
    workspace: text('workspace'),
    startedAt: ts('started_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('agent_sessions_agent_idx').on(t.agentId, t.startedAt)],
);

export const repoAgentPrompts = pgTable(
  'agent_prompts',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<'live' | 'declined' | 'superseded'>().notNull(),
    basedOn: integer('based_on'),
    note: text('note').notNull().default(''),
    source: text('source').$type<'human' | 'agent' | 'import'>().notNull().default('human'),
    clientLabel: text('client_label'),
    harness: text('harness'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => repoAgentSessions.id, {
      onDelete: 'set null',
    }),
    /** The agent that made a live edit to ANOTHER agent's prompt (0097). */
    editorAgentId: uuid('editor_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.version] })],
);

/**
 * An edit to an agent's prompt waiting for its owner (0097, ADR-0029): a self-edit, one from an
 * unidentified connection, or any agent edit under the prompt lock. The live prompt does not move
 * until the owner accepts, which writes `agent_prompts` version `version`.
 */
export const repoAgentPromptProposals = pgTable(
  'agent_prompt_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    basedOn: integer('based_on').notNull(),
    body: text('body').notNull(),
    note: text('note').notNull().default(''),
    editorAgentId: uuid('editor_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => repoAgentSessions.id, {
      onDelete: 'set null',
    }),
    harness: text('harness'),
    clientLabel: text('client_label'),
    status: text('status')
      .$type<'pending' | 'accepted' | 'rejected'>()
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    version: integer('version'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('agent_prompt_proposals_agent_idx').on(t.agentId, t.createdAt)],
);

export const repoAgentMemories = pgTable(
  'agent_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<'feedback' | 'user' | 'project' | 'reference'>().notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    source: text('source').$type<'human' | 'agent' | 'import'>().notNull().default('agent'),
    /** The cosigner of the current revision. */
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    forgottenAt: ts('forgotten_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('agent_memories_agent_idx').on(t.agentId, t.updatedAt)],
);

export const repoAgentMemoryRevisions = pgTable(
  'agent_memory_revisions',
  {
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => repoAgentMemories.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    op: text('op').$type<'create' | 'update' | 'append' | 'forget' | 'restore'>().notNull(),
    type: text('type').$type<'feedback' | 'user' | 'project' | 'reference'>().notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    source: text('source').$type<'human' | 'agent' | 'import'>().notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => repoAgentSessions.id, {
      onDelete: 'set null',
    }),
    clientLabel: text('client_label'),
    harness: text('harness'),
    createdAt: ts('created_at').notNull().defaultNow(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.seq] })],
);

export const agentProfiles = pgTable(
  'agent_profiles',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    harness: text('harness').notNull(),
    settings: jsonb('settings').$type<Record<string, string | boolean>>().notNull().default({}),
    /**
     * Widening values (`widens` in the harness contract) the owner approved from a
     * browser session: `{ settingKey: approvedValue }`. Checkout writes a widening
     * value only when it matches an entry here (0087).
     */
    approvedWidening: jsonb('approved_widening')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    addendum: text('addendum').notNull().default(''),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.harness] })],
);

export const agentShares = pgTable(
  'agent_shares',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').$type<'user' | 'topic'>().notNull(),
    subjectId: uuid('subject_id').notNull(),
    promptAccess: text('prompt_access').$type<'view' | 'edit'>().notNull().default('view'),
    memoryAccess: text('memory_access').$type<'none' | 'view' | 'edit'>().notNull().default('none'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.subjectType, t.subjectId] }),
    index('agent_shares_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const agentRecipients = pgTable(
  'agent_recipients',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    acceptedVersion: integer('accepted_version').notNull(),
    followUpdates: boolean('follow_updates').notNull().default(false),
    acceptedAt: ts('accepted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.userId] })],
);

export const agentTransfers = pgTable('agent_transfers', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  toUserId: uuid('to_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** An agent's briefs: facts about the product it works on. Migration 0039. */
export const agentBriefs = pgTable(
  'agent_briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    revision: integer('revision').notNull().default(1),
    source: text('source').$type<'human' | 'agent' | 'import'>().notNull(),
    /** The cosigner of the current revision. */
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_briefs_agent_name_key').on(t.agentId, t.name)],
);

export const agentBriefRevisions = pgTable(
  'agent_brief_revisions',
  {
    briefId: uuid('brief_id')
      .notNull()
      .references(() => agentBriefs.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    note: text('note').notNull().default(''),
    source: text('source').$type<'human' | 'agent' | 'import'>().notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => repoAgentSessions.id, {
      onDelete: 'set null',
    }),
    clientLabel: text('client_label'),
    harness: text('harness'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.briefId, t.revision] })],
);

/**
 * A brief renamed or deleted — what Activity cannot read from the revisions,
 * because a rename writes none and a delete takes them with it. Keyed on the
 * agent so a delete outlives the brief. Migration 0040.
 */
export const agentBriefEvents = pgTable('agent_brief_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  op: text('op').$type<'rename' | 'delete'>().notNull(),
  name: text('name').notNull(),
  previousName: text('previous_name'),
  revision: integer('revision').notNull(),
  source: text('source').$type<'human' | 'agent' | 'import'>().notNull(),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => repoAgentSessions.id, { onDelete: 'set null' }),
  clientLabel: text('client_label'),
  harness: text('harness'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * A brief bound to a path in a GitLab project, and what the worker last found
 * there (blip 2e15ad9d, slice 2b). Migration 0041. The observation columns are
 * GitLab's state as of `checkedAt` against `checkedRevision`, not anything
 * derivable here.
 */
export const agentBriefBindings = pgTable('agent_brief_bindings', {
  briefId: uuid('brief_id')
    .primaryKey()
    .references(() => agentBriefs.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  path: text('path').notNull(),
  ref: text('ref').notNull(),
  mirror: boolean('mirror').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  checkedAt: ts('checked_at'),
  checkedRevision: integer('checked_revision'),
  checkState: text('check_state').$type<'ok' | 'unconfigured' | 'failed'>(),
  checkError: text('check_error'),
  commitsBehind: integer('commits_behind'),
  behindCapped: boolean('behind_capped').notNull().default(false),
  landedRevision: integer('landed_revision'),
  driftKind: text('drift_kind').$type<'edited' | 'deleted'>(),
  driftSha: text('drift_sha'),
  driftTitle: text('drift_title'),
  driftAt: ts('drift_at'),
  driftUrl: text('drift_url'),
  mirrorRevision: integer('mirror_revision'),
  mirrorState: text('mirror_state').$type<'opened' | 'failed'>(),
  mirrorError: text('mirror_error'),
  mirrorMrUrl: text('mirror_mr_url'),
});

export const modelCatalog = pgTable(
  'model_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    harness: text('harness').notNull(),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    family: text('family').notNull().default(''),
    hidden: boolean('hidden').notNull().default(false),
    deprecated: boolean('deprecated').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('model_catalog_harness_model_key').on(t.harness, t.modelId)],
);

/* ------------------------------------------------------------------------- */
/* Helpdesk slice 3: the integration credential (drizzle/0045, HELPDESK §3). */
/* ------------------------------------------------------------------------- */

/**
 * An outside system's credential, `omr_int_…`. Revoked, never deleted: a
 * trigger refuses a DELETE that is not an account-deletion cascade.
 */
export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').$type<'helpdesk'>().notNull().default('helpdesk'),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  tokenLastUsedAt: ts('token_last_used_at'),
  previousHash: text('previous_hash'),
  previousExpiresAt: ts('previous_expires_at'),
  previousLastUsedAt: ts('previous_last_used_at'),
  rotatedAt: ts('rotated_at'),
  expiresAt: ts('expires_at').notNull(),
  agentReplyPolicy: text('agent_reply_policy').$type<'review'>().notNull().default('review'),
  staffDisplayName: text('staff_display_name').notNull().default('Support'),
  windowStartedAt: ts('window_started_at').notNull().defaultNow(),
  windowCount: integer('window_count').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  /** Where events are pushed (slice 4, drizzle/0047). Null: the portal only pulls. */
  deliveryUrl: text('delivery_url'),
  deliverySecretCiphertext: text('delivery_secret_ciphertext'),
  /** Paused pushes buffer: events keep queueing (§5.4). */
  deliveryPausedAt: ts('delivery_paused_at'),
  deliveryLastError: text('delivery_last_error'),
});

export type EnrolmentRevokedReason =
  'unenrolled' | 'template_changed' | 'owner_changed' | 'integration_revoked' | 'radar_deleted';

/** The enrolment: the whole of what an integration reaches. Never revived. */
export const integrationRadars = pgTable('integration_radars', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id')
    .notNull()
    .references(() => integrations.id, { onDelete: 'cascade' }),
  radarId: uuid('radar_id')
    .notNull()
    .references(() => radars.id, { onDelete: 'cascade' }),
  externalRef: text('external_ref'),
  enrolledBy: uuid('enrolled_by').references(() => users.id, { onDelete: 'set null' }),
  enrolledAt: ts('enrolled_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  revokedReason: text('revoked_reason').$type<EnrolmentRevokedReason>(),
});

/** The side row that makes a blip a client's request. Requester fixed by trigger. */
export const helpdeskRequests = pgTable('helpdesk_requests', {
  blipId: uuid('blip_id')
    .primaryKey()
    .references(() => blips.id, { onDelete: 'cascade' }),
  integrationId: uuid('integration_id').references(() => integrations.id, {
    onDelete: 'set null',
  }),
  requesterRef: text('requester_ref').notNull(),
  requesterAccountRef: text('requester_account_ref').notNull(),
  requesterName: text('requester_name').notNull(),
  requesterEmail: text('requester_email').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  origin: text('origin').$type<'portal' | 'support' | 'guest'>().notNull().default('portal'),
  guestCapabilityId: uuid('guest_capability_id').references(() => guestSupportCapabilities.id, {
    onDelete: 'set null',
  }),
  nativeRequesterUserId: uuid('native_requester_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  supportCategory: text('support_category').$type<
    'account' | 'billing' | 'bug' | 'feature' | 'privacy'
  >(),
});

export const supportOperations = pgTable(
  'support_operations',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.operationId] })],
);

export const integrationIdempotency = pgTable(
  'integration_idempotency',
  {
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestSha256: text('request_sha256').notNull(),
    resourceId: uuid('resource_id').notNull(),
    status: integer('status').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.key] })],
);

export const integrationScopeWindows = pgTable(
  'integration_scope_windows',
  {
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    windowStartedAt: ts('window_started_at').notNull().defaultNow(),
    windowCount: integer('window_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.scope] })],
);

/* ------------------------------------------------------------------------- */
/* Helpdesk slice 4: events to the portal (drizzle/0047, HELPDESK §5.4).      */
/* ------------------------------------------------------------------------- */

/**
 * The event log: ids only, appended by triggers in the changing transaction.
 * `xid` (xid8, the writing transaction) is not mapped here: it is read and
 * compared in SQL only, as text, the way the reconcile cursor needs it.
 */
export const integrationEvents = pgTable('integration_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  id: text('id').notNull(),
  integrationId: uuid('integration_id')
    .notNull()
    .references(() => integrations.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  requestId: uuid('request_id'),
  radarId: uuid('radar_id'),
  replyId: uuid('reply_id'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
});

/** One row per event while its integration has a receiver. Kept, not dropped, on pause. */
export const integrationDeliveries = pgTable('integration_deliveries', {
  eventSeq: bigint('event_seq', { mode: 'number' })
    .primaryKey()
    .references(() => integrationEvents.seq, { onDelete: 'cascade' }),
  integrationId: uuid('integration_id')
    .notNull()
    .references(() => integrations.id, { onDelete: 'cascade' }),
  attempts: integer('attempts').notNull().default(0),
  runAfter: ts('run_after').notNull().defaultNow(),
});

export const integrationDeliveryAttempts = pgTable('integration_delivery_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id')
    .notNull()
    .references(() => integrations.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  event: text('event').notNull(),
  attempt: integer('attempt').notNull(),
  status: integer('status'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Immutable commercial snapshots; proposal publication does not grant entitlements. */
export const planCatalogRevisions = pgTable('plan_catalog_revisions', {
  revision: integer('revision').primaryKey(),
  state: text('state').notNull(),
  plans: jsonb('plans').notNull(),
  formatVersion: integer('format_version').notNull().default(1),
  baselinePlanId: text('baseline_plan_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  publishedAt: ts('published_at'),
});
/** Permanent commercial references; no owner content or provider credentials. */
export const planCatalogPlanIds = pgTable('plan_catalog_plan_ids', {
  id: text('id').primaryKey(),
  firstRevision: integer('first_revision')
    .notNull()
    .references(() => planCatalogRevisions.revision),
});

/** Exact immutable companion terms; absence means historical access is unspecified. */
export const planFeatureTerms = pgTable('plan_feature_terms', {
  catalogRevision: integer('catalog_revision')
    .notNull()
    .references(() => planCatalogRevisions.revision),
  planId: text('plan_id')
    .notNull()
    .references(() => planCatalogPlanIds.id),
  features: jsonb('features').notNull(),
});

/** Guest conversation credentials are hashes, never account identities. */
export const guestSupportCapabilities = pgTable('guest_support_capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  radarId: uuid('radar_id')
    .notNull()
    .references(() => radars.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  recoveryHash: text('recovery_hash').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});
export const guestSupportOperations = pgTable(
  'guest_support_operations',
  {
    capabilityId: uuid('capability_id')
      .notNull()
      .references(() => guestSupportCapabilities.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => blips.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.capabilityId, t.operationId] })],
);
export const guestSupportLimits = pgTable('guest_support_limits', {
  key: text('key').primaryKey(),
  windowStartedAt: ts('window_started_at').notNull().defaultNow(),
  count: integer('count').notNull().default(1),
});

/** Permanent access fence; no users FK, so restoration cannot remove it by cascade. */
export const accountClosureRequests = pgTable('account_closure_requests', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().unique(),
  confirmedSessionId: uuid('confirmed_session_id').notNull(),
  requestedAt: ts('requested_at').notNull().defaultNow(),
  phase: text('phase').$type<'access_closed'>().notNull().default('access_closed'),
  billingSnapshot: jsonb('billing_snapshot').$type<Record<string, unknown>>().notNull(),
});
export const accountClosureChallenges = pgTable('account_closure_challenges', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  id: uuid('id').notNull().unique(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: ts('consumed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  windowStartedAt: ts('window_started_at').notNull().defaultNow(),
  windowCount: integer('window_count').notNull().default(1),
});

/** Independent admission barrier: existing user-row lock ranks cannot invert it. */
export const accountLifecycleFences = pgTable('account_lifecycle_fences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
});

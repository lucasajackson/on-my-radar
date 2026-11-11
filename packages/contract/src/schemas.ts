/**
 * Request schemas. The HTTP routes and the MCP tools validate against exactly
 * these, so an agent and the SPA cannot drift apart on what a valid blip is.
 */
import { z } from 'zod';
import {
  AGENT,
  BLIP_KINDS,
  BLIP_REACTION_KEYS,
  BLIP_STATES,
  LIMITS,
  NOTIFICATION_BOXES,
  NOTIFICATION_KINDS,
  DECISIONS,
  SESSION_CLIENTS,
  NOTIFICATIONS,
  PASSWORD,
  RADAR_ACCENT_KEYS,
  RADAR_GLYPH_KEYS,
  RADAR_NOTIFY_LEVELS,
  RADAR_ROLES,
  RADAR_VISIBILITIES,
  SMART_MATCH_MODES,
  TOPIC_ROLES,
  TOKEN_SCOPES,
  VOICES,
  WEBHOOK_FORMATS,
  type BlipState,
} from './domain.js';
import { AMEND_LIMITS, CHARTER_LIMITS, withProblem } from './amend.js';
import { RADAR_TEMPLATE_IDS } from './templates.js';
import { MAX_ARCHIVE_AFTER_DAYS } from './archive.js';
import { LANE_ID_PATTERN, LANE_LIMITS } from './lanes.js';
import {
  CLIENT_STATUSES,
  HELPDESK_EVENT_LIMITS,
  HELPDESK_LIMITS,
  INTEGRATION_LIMITS,
  REQUESTED_COMMENT_VISIBILITIES,
} from './helpdesk.js';
import {
  RADAR_SURFACE_KEYS,
  THEME_BODY_FONT_KEYS,
  THEME_CHROME_FONT_KEYS,
  THEME_CORNER_KEYS,
  THEME_CURSOR_KEYS,
  THEME_DENSITY_KEYS,
  THEME_HEADLINE_KEYS,
  THEME_PATTERN_KEYS,
  THEME_PRESET_KEYS,
  THEME_RULE_KEYS,
} from './theme.js';

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Only http(s) URLs are allowed' });

export const idSchema = z.string().uuid();

/**
 * A boolean that survives a query string.
 *
 * The same schema validates an HTTP query *and* an MCP tool argument, and
 * `c.req.query()` hands back flat strings — so a bare `z.boolean()` would 400 on
 * the HTTP transport while working perfectly over MCP. Same argument as
 * `statesFilterSchema` below.
 *
 * Strict in both directions. Not zod's coercing boolean, which is
 * `Boolean(value)` and so reads the string "false" as true — that made the
 * Checkout tab render the private offline snapshot on every visit. And not
 * "anything unrecognised is false" either, which this used to be: `?unreadOnly=ture`
 * quietly meant false. One of these words, or a 400 that says so.
 */
export const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** `?archived=` on the radar and topic lists: strict, and absent means live only. */
export const archivedQuerySchema = z.object({ archived: queryBooleanSchema.default(false) });

/**
 * A radar's archive window, in days.
 *
 * `0` is "never" and `null` is "no opinion — take the default", and they are
 * genuinely different: the first is a decision the person made and the second is
 * the absence of one, which is what lets the default move later without
 * overriding anybody. Coerced for the same reason `queryBooleanSchema` is.
 */
export const archiveAfterDaysSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_ARCHIVE_AFTER_DAYS)
  .nullable();

/* ------------------------------- auth ---------------------------------- */

export const requestCodeSchema = z.object({
  email: emailSchema,
  /** Where to land after verifying; validated as a same-origin path by the server. */
  next: z.string().max(512).optional(),
});

export const verifyCodeSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  /** Same-origin path to return to; the server re-validates it. */
  next: z.string().max(512).optional(),
  /**
   * Which client is signing in. Absent means a browser, which is handed a
   * cookie and never sees the token — today's behaviour, unchanged. Any other
   * value means the token comes back in the body instead, because a client that
   * is not a browser has nowhere to put a `Set-Cookie`.
   */
  client: z.enum(SESSION_CLIENTS).optional(),
  /** A device name for the sessions list. Only meaningful with `client`. */
  label: optionalText(120),
});

/** A new password: length only. A breached-password list would need an outbound fetch. */
export const passwordSchema = z
  .string()
  .min(PASSWORD.minLength, `Use at least ${PASSWORD.minLength} characters`)
  .max(PASSWORD.maxLength);

const signInClientFields = {
  next: z.string().max(512).optional(),
  client: z.enum(SESSION_CLIENTS).optional(),
  label: optionalText(120),
};

export const passwordLoginSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: a too-short guess is a wrong password, not a 400.
  password: z.string().min(1).max(PASSWORD.maxLength),
  ...signInClientFields,
});

/** Forgot password: the emailed code proves the mailbox, then sets a new password. */
export const passwordResetSchema = z.object({
  email: emailSchema,
  code: verifyCodeSchema.shape.code,
  password: passwordSchema,
  ...signInClientFields,
});

/** Change a password with the current one, or set the first one with an emailed code. */
export const setPasswordSchema = z.object({
  password: passwordSchema,
  currentPassword: z.string().min(1).max(PASSWORD.maxLength).optional(),
  code: verifyCodeSchema.shape.code.optional(),
});

export const updateProfileSchema = z.object({
  name: optionalText(120),
  theme: z.enum(['system', 'light', 'dark']).optional(),
});

/* ------------------------------ radars --------------------------------- */

const templateIdSchema = z.enum(RADAR_TEMPLATE_IDS as [string, ...string[]]);

/**
 * `GET /api/radars`: archived ones on request, and optionally only one template.
 * `?template=helpdesk` is how a cross-project view finds every helpdesk without
 * a hand-kept list (docs/HELPDESK.md §4.1). It narrows the caller's own list and
 * can never widen it.
 */
export const listRadarsQuerySchema = archivedQuerySchema.extend({
  template: templateIdSchema.optional(),
});

/**
 * One lane of a radar's own vocabulary.
 *
 * The shape only. Whether a *set* of these makes a coherent radar — enough
 * lanes, no duplicate ids, a lane left to work in, the lane supersession needs
 * — is `validateLanes` in `lanes.ts`, and whether it would strand blips the
 * radar already holds is the server's. Three checks in three places because
 * each needs something the others do not have: a parser, the registry, and the
 * rows.
 */
const customLaneSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(LANE_LIMITS.idMaxLength)
      .regex(LANE_ID_PATTERN, 'Lane ids are lowercase letters, digits and hyphens'),
    label: z.string().trim().min(1).max(LANE_LIMITS.labelMaxLength),
    state: z.enum(BLIP_STATES),
    terminal: z.boolean().optional(),
    /** Client-facing templates only; `validateLanes` decides where it belongs. */
    clientStatus: z.enum(CLIENT_STATUSES).optional(),
  })
  .strict();

/** Small, closed set of display options. Anything unrecognised is dropped. */
export const templateConfigSchema = z
  .object({
    grouping: z.enum(['none', 'day']).optional(),
    collapseDone: z.boolean().optional(),
    /**
     * `null` is meaningful and is not the same as absent: it is "give this radar
     * its template's lanes back", which a client has no other way to say once a
     * custom set is stored. Absent leaves whatever is there alone.
     */
    lanes: z.array(customLaneSchema).max(LANE_LIMITS.max).nullable().optional(),
    defaultStatus: z.string().trim().max(LANE_LIMITS.idMaxLength).nullable().optional(),
  })
  .strict();

/**
 * A radar's theme: nine enum keys and nothing else.
 *
 * `.strict()` for the reason `templateConfigSchema` and `refusedTopicKey` are:
 * zod drops unknown keys in silence, and an agent that sends `backgroundImage`
 * or `css` should be told those do not exist rather than have the call quietly
 * succeed having done nothing. Every value is validated against the registry in
 * `theme.ts` — a string that is not one of the listed keys is refused here and
 * never reaches the database.
 *
 * `preset` is accepted as a shorthand and is **not stored**: the service expands
 * it to the nine axes and forgets the name. Explicit axes sent alongside a
 * preset win, so "geocities but with a serif" is one call.
 */
/**
 * The keys somebody will try, and the sentence they get instead.
 *
 * Same device as `refusedTopicKey` below, for a sharper reason. An agent that
 * knows what MySpace was will reach for `css`, and zod strips unknown keys in
 * silence — so without this the call *succeeds*, changes nothing, and returns a
 * theme that looks like it worked. Silence is the worst answer here: it teaches
 * the caller that the argument exists.
 *
 * The MCP tool schema needs its own copy of these, because the SDK builds a
 * plain `z.object` from the tool's field map and strips before `.strict()` on a
 * nested object could ever fire. `REFUSED_STYLE_KEYS` is exported so the two
 * cannot drift.
 */
const NO_RAW_STYLING =
  'A radar is styled from a fixed vocabulary, never from CSS. There is no ' +
  'stylesheet, colour, image or font URL argument, and there will not be one: a ' +
  'published radar carries third-party open-graph thumbnails, so its img-src has ' +
  'to allow https:, which is the channel a CSS exfiltration uses. Use `preset` ' +
  'and the named axes — surface, pattern, bodyFont, chromeFont, corners, rule, ' +
  'density, cursor, headline.';

/**
 * Kept short and strictly about *raw* styling.
 *
 * Every one of these appears in the MCP tool's published schema, so the list is
 * a cost as well as a guard: a longer one is more noise for every agent that
 * reads it, and a key like `color` would collide with a legitimate future axis.
 * These seven are what somebody reaching for MySpace actually types.
 */
export const REFUSED_STYLE_KEYS = [
  'css',
  'style',
  'styles',
  'stylesheet',
  'customCss',
  'backgroundImage',
  'html',
] as const;

// Described as well as refused, so an agent reading the schema is told *before*
// it tries rather than after. A property that appears with no explanation reads
// as an argument somebody forgot to document.
const refusedStyleKey = z
  .undefined({ invalid_type_error: NO_RAW_STYLING })
  .optional()
  .describe('Not supported, and never will be. Use `preset` and the named axes below.');

/** `{ css: refusedStyleKey, style: refusedStyleKey, … }`, built once. */
export const refusedStyleKeys = Object.fromEntries(
  REFUSED_STYLE_KEYS.map((key) => [key, refusedStyleKey]),
) as Record<(typeof REFUSED_STYLE_KEYS)[number], typeof refusedStyleKey>;

export const radarThemeSchema = z
  .object({
    ...refusedStyleKeys,
    preset: z.enum(THEME_PRESET_KEYS as [string, ...string[]]).optional(),
    surface: z.enum(RADAR_SURFACE_KEYS as [string, ...string[]]).optional(),
    pattern: z.enum(THEME_PATTERN_KEYS as [string, ...string[]]).optional(),
    bodyFont: z.enum(THEME_BODY_FONT_KEYS as [string, ...string[]]).optional(),
    chromeFont: z.enum(THEME_CHROME_FONT_KEYS as [string, ...string[]]).optional(),
    corners: z.enum(THEME_CORNER_KEYS as [string, ...string[]]).optional(),
    rule: z.enum(THEME_RULE_KEYS as [string, ...string[]]).optional(),
    density: z.enum(THEME_DENSITY_KEYS as [string, ...string[]]).optional(),
    cursor: z.enum(THEME_CURSOR_KEYS as [string, ...string[]]).optional(),
    headline: z.enum(THEME_HEADLINE_KEYS as [string, ...string[]]).optional(),
  })
  .strict();

/**
 * The saved query behind a smart radar. `tags` is required and non-empty on
 * purpose — see the note on `SmartFilter`.
 */
export const smartFilterSchema = z.object({
  tags: z
    .array(z.string().max(LIMITS.tagLength))
    .min(1, 'A smart radar needs at least one tag')
    .max(LIMITS.tagsPerBlip),
  match: z.enum(SMART_MATCH_MODES).optional(),
  states: z.array(z.enum(BLIP_STATES)).max(BLIP_STATES.length).optional(),
  kinds: z.array(z.enum(BLIP_KINDS)).max(BLIP_KINDS.length).optional(),
  radarIds: z.array(z.string().uuid()).max(64).optional(),
  q: z.string().trim().max(200).optional(),
});

/**
 * `topic` used to be the name of a radar's one-line subtitle. It now names the group a radar
 * belongs to (an array), so accepting it would quietly set the tagline for a caller who meant the
 * group. zod strips unknown keys in silence and a stale connector schema is a real condition, so
 * this turns the silent wrong thing into a loud error. Exported because the MCP field maps list
 * it too (`mcp/server.ts`): the SDK strips a key absent from a tool's map instead of refusing it.
 */
export const refusedTopicKey = z
  .undefined({
    invalid_type_error:
      '`topic` and `array` are not fields on a radar. Use `tagline` for the one-line ' +
      'subtitle. To put the radar in an array (a group of radars) use `set_radar_array` (`topicId` over REST).',
  })
  .optional();

export const createRadarSchema = z.object({
  name: trimmed(LIMITS.radarName).min(1, 'Give the radar a name'),
  tagline: optionalText(LIMITS.radarTagline),
  topic: refusedTopicKey,
  /** Put the radar straight into a topic. Requires manage on both. */
  topicId: idSchema.nullable().optional(),
  description: optionalText(LIMITS.radarDescription),
  accent: z.enum(RADAR_ACCENT_KEYS as [string, ...string[]]).optional(),
  glyph: z.enum(RADAR_GLYPH_KEYS as [string, ...string[]]).optional(),
  template: templateIdSchema.optional(),
  templateConfig: templateConfigSchema.optional(),
  theme: radarThemeSchema.optional(),
  commentsEnabled: z.boolean().optional(),
  reactionsEnabled: z.boolean().optional(),
  archiveAfterDays: archiveAfterDaysSchema.optional(),
});

/** A smart radar is created through its own endpoint: the filter is mandatory. */
export const createSmartRadarSchema = createRadarSchema.extend({
  filter: smartFilterSchema,
});

export const updateRadarSchema = z
  .object({
    name: trimmed(LIMITS.radarName).min(1).optional(),
    tagline: optionalText(LIMITS.radarTagline),
    topic: refusedTopicKey,
    /** Move the radar into a topic, or out of every topic with `null`. */
    topicId: idSchema.nullable().optional(),
    description: optionalText(LIMITS.radarDescription),
    accent: z.enum(RADAR_ACCENT_KEYS as [string, ...string[]]).optional(),
    glyph: z.enum(RADAR_GLYPH_KEYS as [string, ...string[]]).optional(),
    archived: z.boolean().optional(),
    template: templateIdSchema.optional(),
    templateConfig: templateConfigSchema.optional(),
    /** How the radar's reading surface is styled. See `theme.ts`. */
    theme: radarThemeSchema.optional(),
    /** Whether readers may comment / react. Off hides both surfaces entirely. */
    commentsEnabled: z.boolean().optional(),
    reactionsEnabled: z.boolean().optional(),
    /**
     * How long a finished blip sits here before it ages out. Days; `0` is never,
     * `null` restores the default. Accepted on every template — a value stored
     * on one that does not archive is inert rather than refused, so switching
     * template away and back does not lose the setting.
     */
    archiveAfterDays: archiveAfterDaysSchema.optional(),
    /** Only meaningful on a smart radar; rejected on a standard one. */
    filter: smartFilterSchema.optional(),
  })
  // `!== undefined` rather than a bare key count: `topic` above parses to
  // undefined on the only input it accepts (absence), and a caller who sent
  // nothing else should be told that rather than passed through.
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

export const radarVisibilitySchema = z.object({
  visibility: z.enum(RADAR_VISIBILITIES),
  /** Public radars are noindex by default; opting in is deliberate. */
  allowIndex: z.boolean().optional(),
});

/* ------------------------------- topics -------------------------------- */

export const createTopicSchema = z.object({
  name: trimmed(LIMITS.topicName).min(1, 'Give the array a name'),
  tagline: optionalText(LIMITS.topicTagline),
  description: optionalText(LIMITS.topicDescription),
  accent: z.enum(RADAR_ACCENT_KEYS as [string, ...string[]]).optional(),
  glyph: z.enum(RADAR_GLYPH_KEYS as [string, ...string[]]).optional(),
});

/**
 * `cascade` is deliberately NOT here.
 *
 * Every other field on a topic is presentation. `cascade` converts membership
 * into access to every radar inside, including radars added later — it is the
 * widest single access change in the application, so it gets its own endpoint,
 * its own audit action, and its own confirmation in the UI rather than riding
 * along in a patch that also changed the colour.
 */
export const updateTopicSchema = z
  .object({
    name: trimmed(LIMITS.topicName).min(1).optional(),
    tagline: optionalText(LIMITS.topicTagline),
    description: optionalText(LIMITS.topicDescription),
    accent: z.enum(RADAR_ACCENT_KEYS as [string, ...string[]]).optional(),
    glyph: z.enum(RADAR_GLYPH_KEYS as [string, ...string[]]).optional(),
    archived: z.boolean().optional(),
    position: z.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

/** Its own endpoint, for the reason given on `updateTopicSchema`. */
export const setTopicCascadeSchema = z.object({
  cascade: z.boolean(),
});

export const shareTopicSchema = z.object({
  email: emailSchema,
  role: z.enum(TOPIC_ROLES).default('viewer'),
});

/** Putting a radar into a topic, or taking it out with `topicId: null`. */
export const setRadarTopicSchema = z.object({
  topicId: idSchema.nullable(),
});

export const shareRadarSchema = z.object({
  email: emailSchema,
  role: z.enum(RADAR_ROLES).default('viewer'),
});

/* ------------------------------- blips --------------------------------- */

export const attachmentRefSchema = z.object({
  /** Object key returned by the upload-ticket endpoint. */
  key: z.string().min(1).max(512),
  filename: trimmed(255).min(1),
  contentType: trimmed(255).min(1),
  size: z.number().int().nonnegative().max(LIMITS.attachmentBytes),
  width: z.number().int().positive().max(30000).nullable().optional(),
  height: z.number().int().positive().max(30000).nullable().optional(),
});

/**
 * Whose name a write is rendered under.
 *
 * Spelled `me` / `agent` rather than `principal` / `persona` because the caller
 * is an agent choosing between itself and its human, and those are the words
 * that make sense from where the call is made. `VOICE_BY_AS` is the one-way map.
 *
 * Optional everywhere. Absent means the connection's own default, which is what
 * keeps `create_blip({ radarId, body })` a two-argument call — the point of the
 * whole capture design is that nothing has to be chosen before typing.
 *
 * Meaningless from a browser session and deliberately not refused there: a
 * person typing is the person, the field is ignored, and 400-ing on a stray key
 * would make the shared schema lie about which transport it serves.
 */
export const voiceArgSchema = z.enum(['me', 'agent']);

/**
 * A load session to write under (Agent Repo v2, §V2.5): the id `load_agent`
 * returned, which binds this one write to the loaded agent. Server-issued and
 * checked in full — this person, this connection, not idle, an agent they can
 * still run — so it names an identity without being one. Refused from a browser
 * session: a person typing is the person.
 */
/**
 * A caller-chosen key that makes a create safe to retry: the same key with the same request
 * returns the original result instead of writing again; the same key with a different request
 * is a 409. Kept for 24 hours, per person and connection. On REST it is the `Idempotency-Key`
 * header; on MCP the `idempotencyKey` argument. A UUID is a good key.
 */
export const IDEMPOTENCY_KEY_MAX = 128;
export const idempotencyKeySchema = z
  .string()
  .min(1, 'An idempotency key is 1-128 visible characters')
  .max(IDEMPOTENCY_KEY_MAX, 'An idempotency key is 1-128 visible characters')
  .regex(/^[\x21-\x7e]+$/, 'An idempotency key is 1-128 visible characters, with no spaces');

export const writeSessionSchema = z.string().uuid('A session is the id load_agent returned');

export const dueAtSchema = z.string().datetime({ offset: true }).nullable();
export const setReminderSchema = z
  .object({ leadMinutes: z.union([z.literal(0), z.literal(60), z.literal(1440)]) })
  .strict();

export const createBlipSchema = z
  .object({
    dueAt: dueAtSchema.optional(),
    body: z.string().max(LIMITS.blipBody).optional(),
    title: optionalText(LIMITS.blipTitle),
    url: httpUrlSchema.nullable().optional(),
    kind: z.enum(BLIP_KINDS).optional(),
    state: z.enum(BLIP_STATES).optional(),
    /** The radar template's own lane. Validated against the template, not here. */
    status: z.string().max(48).nullable().optional(),
    /** A blip in the same radar that this one replaces. Checked service-side. */
    supersedes: idSchema.nullable().optional(),
    tags: z.array(z.string().max(LIMITS.tagLength)).max(LIMITS.tagsPerBlip).optional(),
    pinned: z.boolean().optional(),
    attachments: z.array(attachmentRefSchema).max(LIMITS.attachmentsPerBlip).optional(),
    as: voiceArgSchema.optional(),
    session: writeSessionSchema.optional(),
    /** Retry-safe create. See `idempotencyKeySchema`. */
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .refine((v) => Boolean(v.body?.trim() || v.url || v.title || (v.attachments?.length ?? 0) > 0), {
    message: 'A blip needs some content — text, a link, or a file',
  });

export const updateBlipSchema = z
  .object({
    dueAt: dueAtSchema.optional(),
    emailNotes: z.string().max(10_000).optional(),
    body: z.string().max(LIMITS.blipBody).optional(),
    title: optionalText(LIMITS.blipTitle),
    url: httpUrlSchema.nullable().optional(),
    kind: z.enum(BLIP_KINDS).optional(),
    state: z.enum(BLIP_STATES).optional(),
    status: z.string().max(48).nullable().optional(),
    /**
     * A blip in the same radar that this one replaces; null clears the link.
     * Saying so also files the replaced blip in its template's superseded lane,
     * which is the verb doing the work — see `supersededLane`.
     */
    supersedes: idSchema.nullable().optional(),
    tags: z.array(z.string().max(LIMITS.tagLength)).max(LIMITS.tagsPerBlip).optional(),
    pinned: z.boolean().optional(),
    /** Files to add: completed `create_upload_ticket` uploads, issued to this caller, each good once. */
    addAttachments: z.array(attachmentRefSchema).min(1).max(LIMITS.attachmentsPerBlip).optional(),
    /** Moving a blip between radars is how you sort your shit out. */
    radarId: idSchema.optional(),
    /**
     * The `revision` you read. A stale one is refused (409) with the current blip, so two writers
     * cannot silently overwrite each other. Omit it to keep last-writer-wins.
     */
    expectedRevision: z.number().int().min(1).optional(),
    /** Who holds the card (null clears it). Only on a radar whose template is `assignable`. */
    assigneeUserId: idSchema.nullable().optional(),
    assigneeAgentId: idSchema.nullable().optional(),
    as: voiceArgSchema.optional(),
    session: writeSessionSchema.optional(),
  })
  // `as` does not count. It says how an edit is *attributed*, so on its own
  // there is no edit to attribute — and letting it satisfy "something to
  // update" would turn a stray argument into a silent no-op write.
  .refine(
    (v) => Object.keys(v).some((key) => !['as', 'session', 'expectedRevision'].includes(key)),
    { message: 'Nothing to update' },
  );

/** Longest a claim may be held without being renewed. */
export const CLAIM_MAX_SECONDS = 4 * 60 * 60;

export const claimBlipSchema = z.object({
  /** Seconds the claim lasts, at most 4 hours (14400). Claiming again renews it. */
  ttl: z.number().int().min(60).max(CLAIM_MAX_SECONDS).default(3600),
  /** Give the claim up instead of taking it. */
  release: z.boolean().optional(),
  session: writeSessionSchema.optional(),
});

export const listBlipRevisionsSchema = z.object({
  /** At most 25 are kept per blip. */
  limit: z.coerce.number().int().min(1).max(25).default(25),
});

/**
 * Annotated explicitly: the input is deliberately wide (an array, or the
 * comma-separated string a query string can carry) but the output has to be a
 * plain `BlipState[]`, or every caller downstream inherits the union.
 */
const statesFilterSchema: z.ZodType<BlipState[], z.ZodTypeDef, unknown> = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : value,
  z.array(z.enum(BLIP_STATES)).max(BLIP_STATES.length),
);

/**
 * A page cursor. **One schema, every paginated surface, both transports.**
 *
 * There used to be four of these written out longhand — `z.string().max(200)`
 * three times and `.max(400)` once — and they had already drifted into being
 * wrong. A blip cursor is 208–238 characters and a threaded comment cursor is
 * 247, so page 2 of the radar stream, the tag page, the comment thread and both
 * public radar routes were a 400 against their own server's output. Latent only
 * because a page is 50 blips. Meanwhile the MCP tools declared `z.string()` with
 * no cap at all, so an agent could page a radar that a browser could not — the
 * two transports disagreeing about the same request, which is the one thing the
 * shared contract exists to prevent.
 *
 * The fix is not a bigger number. A cursor is an opaque base64url blob whose
 * length is a function of whatever the keyset happens to sort on, so any cap
 * derived by measuring today's cursor is a number that goes stale the next time
 * a sort key is added — quietly, and only on page 2.
 *
 * What is asserted here is therefore the *shape*: base64url, which is what every
 * encoder in the server emits and which no future sort key can change. The
 * length bound is `LIMITS.cursor`, a memory ceiling rather than a format check.
 * Whether the blob is a real, current, decodable cursor is decided at the decode
 * in `services/cursor.ts`, which is the only place that can tell and which sits
 * on the path both transports take.
 *
 * Anything paginated must use this value itself, not a copy of it —
 * the server's `services/cursor.test.ts` walks every schema exported here and fails on
 * a `cursor` field that is not this exact object.
 */
export const cursorSchema = z
  .string()
  .max(LIMITS.cursor)
  .regex(/^[A-Za-z0-9_-]+$/, 'Not a page cursor');

export const listBlipsSchema = z.object({
  updatedSince: z.string().datetime({ offset: true }).optional(),
  sort: z.literal('updated').optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().max(LIMITS.tagLength).optional(),
  state: z.enum(BLIP_STATES).optional(),
  /**
   * Several triage states at once. `state` narrows to exactly one; this is for
   * "everything not yet dealt with", which is what sorting a drop box means and
   * which one value cannot express. Layered with `state`, not instead of it.
   *
   * Accepts a comma-separated string as well as an array, because this schema
   * validates a query string *and* an MCP tool argument — `c.req.query()` hands
   * back flat strings, so an array-only shape would 400 on the HTTP transport
   * while working over MCP. The two transports validate against one schema; it
   * has to accept both encodings or that stops being true.
   */
  states: statesFilterSchema.optional(),
  kind: z.enum(BLIP_KINDS).optional(),
  status: z.string().max(48).optional(),
  /**
   * Include blips that have aged out of the radar. Off by default, which is what
   * makes archiving mean anything.
   *
   * Named to match `list_radars` and `list_arrays`, which have taken an
   * `includeArchived` since topics shipped — blips were the asymmetry. `queryBooleanSchema`
   * because this validates a query string as well as an MCP tool argument, and
   * `c.req.query()` hands back `'true'`, not `true`.
   */
  includeArchived: queryBooleanSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
});

/**
 * Universal search: one string carrying words and filters together, plus the
 * page cursor.
 *
 * Deliberately *not* a set of structured parameters. The grammar is the input —
 * `in:` and `from:` are typed into the same box as the words, and an agent
 * constructing `in:"Design notes" from:ada after:7d` is composing one string,
 * not filling in a form. Structured equivalents would be a second way to say the
 * same thing, and two ways to say it is how they come to disagree.
 */
export const searchSchema = z.object({
  /** Rank matches belonging to this radar first without restricting accessible results. */
  preferRadarId: idSchema.optional(),
  /** Exact radar scope, including a smart radar's saved query. */
  radarId: idSchema.optional(),
  q: z.string().max(LIMITS.searchQuery).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
});

export const uploadTicketSchema = z.object({
  filename: trimmed(255).min(1),
  contentType: trimmed(255).min(1),
  size: z.number().int().positive().max(LIMITS.attachmentBytes),
});

/* ------------------------------ comments -------------------------------- */

export const createCommentSchema = z.object({
  body: trimmed(LIMITS.commentBody).min(1, 'Write something first'),
  /**
   * The comment being answered, when this is a reply rather than a remark on the
   * thread. Must be a comment on the same blip; one anywhere else is refused
   * without saying which case it is, exactly like `supersedes`.
   *
   * Naming a comment that is itself a reply is *not* an error — the service
   * re-parents to its parent, because a thread is one level deep and refusing
   * would make the reply button on a nested reply do nothing. The response says
   * where it actually landed.
   */
  parentId: idSchema.optional(),
  /**
   * `internal` (the default) or `client`. Asking for `client` is the explicit
   * act of writing to the client, accepted only on a client-facing radar (a
   * helpdesk). Whether it is released at once or waits for the owner's review
   * is decided by who is writing, never by this field: only the radar's owner,
   * in person, publishes directly. `docs/HELPDESK.md` §7.2.
   */
  visibility: z.enum(REQUESTED_COMMENT_VISIBILITIES).optional(),
  as: voiceArgSchema.optional(),
  session: writeSessionSchema.optional(),
  /** Retry-safe create. See `idempotencyKeySchema`. */
  idempotencyKey: idempotencyKeySchema.optional(),
});

/**
 * Releasing a pending reply to the client. `bodySha256` is the hash the
 * reviewer was shown (`CommentDto.bodySha256`); the release is refused if the
 * stored text no longer hashes to it, so an edit made after the review voids
 * the approval rather than riding it.
 */
export const releaseCommentSchema = z.object({
  bodySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'bodySha256 is the 64-character hex hash shown with the reply'),
});

export const updateCommentSchema = z.object({
  body: trimmed(LIMITS.commentBody).min(1, 'A comment cannot be emptied — delete it instead'),
  session: writeSessionSchema.optional(),
});

export const listCommentsSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.commentsPerPage).optional(),
});

/* ------------------------------ reactions ------------------------------- */

/**
 * A reaction is a toggle, not a create/delete pair: reacting twice with the same
 * mark is the user taking it back, and modelling that as one idempotent call is
 * what stops a double-click leaving two rows or an agent having to read state
 * before it can act.
 */
export const toggleReactionSchema = z.object({
  reaction: z.enum(BLIP_REACTION_KEYS as [string, ...string[]]),
  /**
   * true puts the mark on, false takes it off — both idempotent, so a retry
   * after a timeout does what the first call meant. Absent is a toggle, which is
   * what a button wants and nothing that might retry should use.
   */
  on: z.boolean().optional(),
});

/* ---------------------------- dashboards ------------------------------- */

export const dashboardWidgetConfigSchema = z.union([
  z
    .object({
      type: z.literal('query'),
      title: trimmed(120).min(1, 'Name the widget'),
      query: z.string().trim().max(LIMITS.searchQuery),
      limit: z.number().int().min(1).max(50).default(12),
      display: z.enum(['list', 'count', 'lanes', 'activity']).optional(),
      groupByRadar: z.boolean().optional(),
      hideWhenEmpty: z.boolean().optional(),
      activityDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    })
    .strict(),
  z.object({ type: z.literal('radar').optional(), hideWhenEmpty: z.boolean().optional() }).strict(),
]);

export const dashboardPreviewSchema = z.object({
  query: z.string().trim().max(LIMITS.searchQuery),
  limit: z.number().int().min(1).max(50).default(12),
  display: z.enum(['list', 'count', 'lanes', 'activity']).optional(),
  groupByRadar: z.boolean().optional(),
  activityDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
});

const widgetFields = {
  radarId: idSchema.nullable(),
  config: dashboardWidgetConfigSchema.optional(),
};
function validateWidgetSource(
  widget: {
    radarId: string | null;
    config?: z.infer<typeof dashboardWidgetConfigSchema> | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (widget.config?.type === 'query' ? widget.radarId !== null : widget.radarId === null)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['radarId'],
      message: 'Query widgets have no single radar; radar widgets need a radar.',
    });
}
export const widgetDraftSchema = z
  .object({
    ...widgetFields,
    w: z.number().int().min(2).max(12).optional(),
    h: z.number().int().min(2).max(40).optional(),
  })
  .strict()
  .superRefine(validateWidgetSource);

export const widgetLayoutSchema = z
  .object({
    ...widgetFields,
    id: idSchema.optional(),
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(400),
    w: z.number().int().min(2).max(12),
    h: z.number().int().min(2).max(40),
  })
  .superRefine((widget, ctx) => {
    validateWidgetSource(widget, ctx);
    if (widget.x + widget.w > 12)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['x'],
        message: 'Keep each panel inside the 12-column grid.',
      });
    const count = widget.config?.type === 'query' && widget.config.display === 'count';
    if (!count && (widget.w < 3 || widget.h < 4))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lists and charts need at least 3 columns and 4 rows; count tiles can use 2 by 2.',
      });
  });

export const dashboardOperationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      widget: widgetDraftSchema,
      x: z.number().int().min(0).max(11).optional(),
      y: z.number().int().min(0).max(400).optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove'), id: idSchema }).strict(),
  z
    .object({
      op: z.literal('move'),
      id: idSchema,
      x: z.number().int().min(0).max(11),
      y: z.number().int().min(0).max(400),
      w: z.number().int().min(2).max(12).optional(),
      h: z.number().int().min(2).max(40).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      id: idSchema,
      radarId: idSchema.nullable().optional(),
      config: dashboardWidgetConfigSchema.optional(),
    })
    .strict(),
]);

export const createDashboardSchema = z.object({ name: trimmed(120).min(1, 'Name the tab') });
export const updateDashboardSchema = z
  .object({
    name: trimmed(120).min(1).optional(),
    position: z.number().int().min(0).max(500).optional(),
    expectedRevision: z.number().int().min(0).optional(),
    widgets: z.array(widgetLayoutSchema).max(60).optional(),
    append: z.array(widgetDraftSchema).min(1).max(60).optional(),
    operations: z.array(dashboardOperationSchema).min(1).max(120).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ([v.widgets, v.append, v.operations].filter((value) => value !== undefined).length > 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose widgets, append, or operations in one update.',
      });
    if ((v.widgets?.filter((w) => w.config?.type === 'query').length ?? 0) > 12)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A dashboard can have up to 12 live query widgets.',
      });
    const widgets = v.widgets ?? [];
    for (const [i, a] of widgets.entries()) {
      if (
        widgets
          .slice(0, i)
          .some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y)
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['widgets', i],
          message: 'Place panels beside or below each other without overlapping.',
        });
    }
  })
  .refine((v) => Object.keys(v).some((key) => key !== 'expectedRevision'), {
    message: 'Nothing to update',
  });

/* ------------------------------- tokens -------------------------------- */

/**
 * How long a new personal access token lives when the caller says nothing.
 * Never expiring is a deliberate choice — `expiresInDays: null` — not the
 * default. Tokens minted before this existed keep the expiry they have.
 */
export const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

/** Omitted → `DEFAULT_TOKEN_EXPIRY_DAYS`; a number of days; or explicit `null` for never. */
export const tokenExpiryDaysSchema = z.number().int().min(1).max(365).nullable().optional();

export const createTokenSchema = z.object({
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).max(TOKEN_SCOPES.length).optional(),
  name: trimmed(120).min(1, 'Name the token so you know what to revoke'),
  expiresInDays: tokenExpiryDaysSchema,
  /**
   * The persona this connection speaks as, chosen from the ones the signed-in
   * person already owns.
   *
   * An id and never a name, so minting a token cannot *create* a principal as a
   * side effect. Naming an agent is its own act on its own screen
   * (`createAgent`), and keeping the two apart is what stops a token endpoint
   * becoming a second, quieter way to put a new name on somebody's radar.
   */
  agentId: idSchema.optional(),
  /**
   * Which voices the connection may use. Ignored without `agentId` — there is
   * nothing to speak as — and defaulted to `['persona']` when one is given,
   * because own-voice is the honest default and writing as the human is the
   * more consequential mode.
   */
  voices: z.array(z.enum(VOICES)).min(1).max(2).optional(),
});

export const createAgentSchema = z.object({
  name: trimmed(AGENT.nameLength).min(1, 'Give the agent a name'),
  /** Normalised by `mentionKey` service-side; derived from the name when absent. */
  handle: trimmed(AGENT.handleLength).optional(),
});

/* ------------------------------- webhooks ------------------------------ */

const webhookShape = {
  name: trimmed(120).min(1, 'Name the webhook so you know what to revoke'),
  format: z.enum(WEBHOOK_FORMATS).optional(),
  /** `{{field.path}}` interpolation over the payload. Only used when format is 'template'. */
  bodyTemplate: optionalText(4_000),
  titleTemplate: optionalText(300),
  tags: z.array(z.string().max(LIMITS.tagLength)).max(LIMITS.tagsPerBlip).optional(),
  state: z.enum(BLIP_STATES).optional(),
  enabled: z.boolean().optional(),
};

export const createWebhookSchema = z.object(webhookShape);

export const updateWebhookSchema = z
  .object({ ...webhookShape, name: webhookShape.name.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/* ---------------------------- notifications ----------------------------- */

export const listNotificationsSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATIONS.maxPageSize).optional(),
  /** Only the ones still outstanding — what the widget and the badge want. */
  unreadOnly: queryBooleanSchema.optional(),
  /** Narrow to one radar, for a per-radar activity view. */
  radarId: idSchema.optional(),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  /** `needs_you` (waiting on you) or `agents_reported` (the rest). Absent is both. */
  box: z.enum(NOTIFICATION_BOXES).optional(),
});

export const notificationCountsSchema = z.object({ box: z.enum(NOTIFICATION_BOXES).optional() });

/**
 * Asking a person to decide (`request_decision`). `context` is the TLDR a person reads before
 * anything else: one line, what this is and why it needs them now.
 */
export const requestDecisionSchema = z.object({
  context: z
    .string()
    .trim()
    .min(1)
    .max(DECISIONS.contextChars)
    .regex(/^[^\r\n]+$/, 'One line: what this is and why it needs them now'),
  question: z.string().trim().min(1).max(DECISIONS.questionChars),
  /** Free text on most radars; on a radar whose template decides, the outcomes are the options. */
  options: z
    .array(z.string().trim().min(1).max(DECISIONS.optionChars))
    .max(DECISIONS.maxOptions)
    .optional(),
  /** Who to ask: someone who can read the radar. Default is the person you act for. */
  addresseeId: idSchema.optional(),
  session: writeSessionSchema.optional(),
});

export const answerDecisionSchema = z.object({
  answer: z.string().trim().min(1).max(DECISIONS.answerChars),
});

/**
 * Marking things read.
 *
 * Three mutually useful shapes rather than three endpoints: specific ids (the
 * row you just clicked), everything on one radar (the badge you just dealt
 * with), or everything. At least one has to be given — an empty body meaning
 * "all" would make an accidental POST destroy the whole unread state.
 */
export const markNotificationsReadSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(200).optional(),
    radarId: idSchema.optional(),
    all: z.literal(true).optional(),
    /** Set false to put a notification *back*; only meaningful with `ids`. */
    read: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.ids || v.radarId || v.all), {
    message: 'Say which notifications — ids, radarId, or all: true',
  })
  // Enforced, not just documented: `{ all: true, read: false }` used to reach the
  // service, which dutifully marked every notification the person had ever read
  // as unread again.
  .refine((v) => v.read !== false || v.ids !== undefined, {
    message: 'Only specific notifications (ids) can be put back to unread',
    path: ['read'],
  });

export const updateNotificationSettingsSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    pushEnabled: z.boolean().optional(),
    previewEnabled: z.boolean().optional(),
    kindPreferences: z
      .record(
        z.enum(NOTIFICATION_KINDS),
        z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).strict(),
      )
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const radarNotifyLevelSchema = z.object({
  level: z.enum(RADAR_NOTIFY_LEVELS),
});

/**
 * A browser's push subscription, exactly as `PushSubscription.toJSON()` emits
 * it. The keys are the device's own — we need them to encrypt, so unlike every
 * other secret in this application they are stored as given rather than hashed.
 */
export const pushSubscriptionSchema = z.object({
  rebindExisting: z.boolean().optional(),
  endpoint: z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((v) => /^https:\/\//i.test(v), { message: 'A push endpoint must be https' }),
  keys: z.object({
    /** The device's P-256 public key, base64url, uncompressed point. */
    p256dh: z.string().trim().min(1).max(256),
    /** The device's 16-byte auth secret, base64url. */
    auth: z.string().trim().min(1).max(64),
  }),
  /** Free text shown on the devices list — "Chrome on the laptop". */
  label: z.string().trim().max(120).optional(),
});

export const nativePushSchema = z
  .object({
    activate: z.boolean().optional(),
    platform: z.literal('apns'),
    token: z
      .string()
      .regex(/^(?:[a-fA-F0-9]{2}){16,256}$/)
      .transform((v) => v.toLowerCase()),
    environment: z.enum(['sandbox', 'production']),
    installationId: idSchema.transform((value) => value.toLowerCase()),
    label: z.string().trim().max(120).optional(),
  })
  .strict();
export const registerPushSchema = z.union([nativePushSchema, pushSubscriptionSchema]);
export type NativePushInput = z.infer<typeof nativePushSchema>;
export type SetReminderInput = z.infer<typeof setReminderSchema>;

/* ------------------------------- waitlist ------------------------------- */

/** What someone joining the waitlist says they want it for. */
export const WAITLIST_USE_CASES = ['personal', 'team', 'agent_builder'] as const;
export type WaitlistUseCase = (typeof WAITLIST_USE_CASES)[number];

/**
 * `POST /api/waitlist` — the marketing site's form, same-origin, JSON only.
 *
 * `website` is a honeypot: the form renders it hidden from people, and anything
 * in it marks the submission as a bot's. It is accepted and answered exactly
 * like a real submission, so a bot learns nothing from the response.
 */
export const waitlistRequestSchema = z.object({
  email: emailSchema,
  /** Required: the admin deciding who to let in needs something to call them. */
  name: z.string().trim().min(1, 'Tell us your name').max(120),
  useCase: z.enum(WAITLIST_USE_CASES).optional(),
  /** Where the signup came from, e.g. `homepage` or `launch-post`. */
  source: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_.-]*$/i, 'A source is letters, digits, dots, dashes or underscores')
    .optional(),
  website: z.string().max(200).optional(),
});
export type WaitlistRequestInput = z.infer<typeof waitlistRequestSchema>;

/**
 * The only answer the endpoint gives to a request it accepts — identical for a
 * new address, one already queued, an existing account and a honeypot hit, so
 * it can never be used to learn who is registered.
 */
export interface WaitlistResponseDto {
  status: 'received';
  message: string;
}

/* -------------------------------- admin -------------------------------- */

export const adminUserActionSchema = z.object({
  action: z.enum(['approve', 'suspend', 'reinstate']),
});

export type RequestCodeInput = z.infer<typeof requestCodeSchema>;
export type SmartFilterInput = z.infer<typeof smartFilterSchema>;
export type CreateSmartRadarInput = z.infer<typeof createSmartRadarSchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
export type TemplateConfigInput = z.infer<typeof templateConfigSchema>;
export type RadarThemeInput = z.infer<typeof radarThemeSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
export type CreateTopicInput = z.infer<typeof createTopicSchema>;
export type UpdateTopicInput = z.infer<typeof updateTopicSchema>;
export type ShareTopicInput = z.infer<typeof shareTopicSchema>;
export type SetTopicCascadeInput = z.infer<typeof setTopicCascadeSchema>;
export type SetRadarTopicInput = z.infer<typeof setRadarTopicSchema>;
export type CreateRadarInput = z.infer<typeof createRadarSchema>;
export type UpdateRadarInput = z.infer<typeof updateRadarSchema>;
export type CreateBlipInput = z.infer<typeof createBlipSchema>;
export type UpdateBlipInput = z.infer<typeof updateBlipSchema>;
export type ClaimBlipInput = z.infer<typeof claimBlipSchema>;
export type ListBlipRevisionsQuery = z.infer<typeof listBlipRevisionsSchema>;
export type ListBlipsQuery = z.infer<typeof listBlipsSchema>;
export type SearchQueryInput = z.infer<typeof searchSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
export type ReleaseCommentInput = z.infer<typeof releaseCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsSchema>;
export type WidgetLayout = z.infer<typeof widgetLayoutSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type RequestDecisionInput = z.infer<typeof requestDecisionSchema>;
export type AnswerDecisionInput = z.infer<typeof answerDecisionSchema>;
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;
export type UpdateNotificationSettingsInput = z.infer<typeof updateNotificationSettingsSchema>;
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type VoiceArg = z.infer<typeof voiceArgSchema>;

export type DashboardUpdateInput = z.input<typeof updateDashboardSchema>;
export type WidgetDraft = z.input<typeof widgetDraftSchema>;

/* ------------------------- helpdesk slice 3 (HELPDESK §5, §3.4) -------------------------- */

/**
 * Text an outside system sends. PostgreSQL cannot store a NUL character in
 * `text` or `jsonb`, so one that reached SQL was a 500 (qa-reviewer, slice 3);
 * it is refused here as the 400 it is. Every string field of these schemas goes
 * through it, and a test sends a NUL in each one over the wire.
 */
export const NUL_REFUSAL = 'Text cannot contain a NUL character.';
const noNul = <T extends z.ZodString>(schema: T) =>
  schema.refine((value) => !value.includes('\u0000'), NUL_REFUSAL);
const refText = (max: number) => noNul(z.string().trim().min(1).max(max));

export const helpdeskRequesterSchema = z.object({
  ref: refText(HELPDESK_LIMITS.ref),
  accountRef: refText(HELPDESK_LIMITS.ref),
  name: refText(HELPDESK_LIMITS.requesterName),
  email: noNul(z.string().trim().min(3).max(HELPDESK_LIMITS.requesterEmail).email()),
});

export const createHelpdeskRequestSchema = z.object({
  title: noNul(z.string().trim().min(1, 'A request needs a title').max(HELPDESK_LIMITS.title)),
  body: noNul(z.string().trim().min(1, 'A request needs a description').max(HELPDESK_LIMITS.body)),
  requester: helpdeskRequesterSchema,
});

export const createHelpdeskReplySchema = z.object({
  body: noNul(z.string().trim().min(1, 'A reply needs some words').max(HELPDESK_LIMITS.reply)),
  requester: helpdeskRequesterSchema,
});

export const listHelpdeskRequestsSchema = z.object({
  status: z.enum(CLIENT_STATUSES).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(HELPDESK_LIMITS.listPage).optional(),
});

export const helpdeskThreadQuerySchema = z.object({
  cursor: cursorSchema.optional(),
});

export type HelpdeskRequester = z.infer<typeof helpdeskRequesterSchema>;
export type CreateHelpdeskRequestInput = z.infer<typeof createHelpdeskRequestSchema>;
export type CreateHelpdeskReplyInput = z.infer<typeof createHelpdeskReplySchema>;
export type ListHelpdeskRequestsQuery = z.infer<typeof listHelpdeskRequestsSchema>;

export const createIntegrationSchema = z.object({
  name: refText(INTEGRATION_LIMITS.name),
  staffDisplayName: refText(INTEGRATION_LIMITS.staffDisplayName).optional(),
});

export const rotateIntegrationSchema = z.object({
  /** How long the old token keeps working. 0 revokes it now (a leak). */
  overlapHours: z
    .number()
    .int()
    .min(0)
    .max(INTEGRATION_LIMITS.maxOverlapHours)
    .default(INTEGRATION_LIMITS.defaultOverlapHours),
});

export const enrolRadarSchema = z.object({
  radarId: z.string().uuid(),
  externalRef: refText(INTEGRATION_LIMITS.externalRef).optional(),
});

/* --------------------------- helpdesk slice 4 (HELPDESK §5.4) --------------------------- */

export const helpdeskEventsQuerySchema = z.object({
  /** The `cursor` of the last event already processed. Absent: from the oldest retained. */
  after: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(HELPDESK_EVENT_LIMITS.maxPage).optional(),
});

export const setIntegrationDeliverySchema = z.object({
  /** A public https URL, or null to stop pushing (the portal can still pull). */
  url: noNul(z.string().trim().max(2048).url('Give the full https:// address of the receiver.'))
    .refine((value) => value.startsWith('https://'), 'The receiver must be an https:// URL.')
    .nullable(),
});

export type HelpdeskEventsQuery = z.infer<typeof helpdeskEventsQuerySchema>;
export type SetIntegrationDeliveryInput = z.infer<typeof setIntegrationDeliverySchema>;
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;
export type RotateIntegrationInput = z.input<typeof rotateIntegrationSchema>;
export type EnrolRadarInput = z.infer<typeof enrolRadarSchema>;

/* ----------------------------- architecture ------------------------------ */

export const readArchitectureQuerySchema = z.object({
  /** `source` keeps the markers, for clients that draw the strikes themselves. */
  view: z.enum(['amended', 'written', 'source']).default('amended'),
  /** Only these pages. A query string carries them comma-separated. */
  pages: z
    .preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(idSchema).max(50))
    .optional(),
  outline: queryBooleanSchema.optional(),
  /** One boundary, its seams, its counterparties and the ADRs that amend them; no charter unless pages or outline. */
  boundary: idSchema.optional(),
  /** Also return this boundary's or contract's own text (`body`), in the same snapshot as its fields. */
  edit: idSchema.optional(),
  /**
   * Only these sections of the charter (a heading's slug, as `outline` lists them; a section runs
   * to the next heading of the same or a higher level, its own subsections included).
   */
  sections: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z.array(trimmed(200).min(1)).max(50),
    )
    .optional(),
  /** Only these parts of the answer (default: all four). `boundary` and `edit` narrow further. */
  include: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z.array(z.enum(['charter', 'adrs', 'boundaries', 'contracts'])).max(4),
    )
    .optional(),
  /** Only ADRs in these lanes (`proposed`, `accepted`, `rejected`, `repealed`). */
  lanes: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z.array(z.enum(['proposed', 'accepted', 'rejected', 'repealed'])).max(4),
    )
    .optional(),
  /** Only these ADRs, by id. */
  adr: z
    .preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(idSchema).max(50))
    .optional(),
  /** False leaves each boundary's `owns` list out of the index (it is the bulk of it). */
  owns: queryBooleanSchema.optional(),
  /**
   * Read the charter as it was at this sealed version (read-only: no `revision`, and the text,
   * its amendments and their strikes are the version's own).
   */
  version: z.coerce.number().int().min(1).optional(),
  /** Where this anchor stands (in the version, when one is asked for): `highlight` in the answer. */
  anchor: idSchema.optional(),
});

/** What every architecture write takes: a load session to write under, and a key that makes a retry safe. */
const architectureWriteArgs = {
  session: writeSessionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
};

export const adrAnchorSchema = z.object({
  quote: z.string().min(1).max(AMEND_LIMITS.quote),
  with: z
    .string()
    .max(AMEND_LIMITS.with)
    .refine((v) => !withProblem(v), 'A replacement is one line.'),
  /** Ignored: the charter is one document now. Accepted so earlier clients keep working. */
  pageId: idSchema.optional(),
  /** Up to 64 characters of the charter text just before and after the quote, to pick it when it recurs. */
  prefix: z.string().max(400).optional(),
  suffix: z.string().max(400).optional(),
  /**
   * Which match the reader selected (0-based, among the quote's matches in the charter as they saw
   * it) and how many they saw. A charter whose count has changed is `quote_moved`.
   */
  occurrence: z.number().int().min(0).max(10_000).optional(),
  seen: z.number().int().min(1).max(10_000).optional(),
});

export const proposeAdrSchema = z.object({
  title: trimmed(LIMITS.blipTitle).min(1),
  rationale: z.string().trim().min(1).max(20_000),
  anchors: z.array(adrAnchorSchema).max(AMEND_LIMITS.anchorsPerAdr).default([]),
  supersedes: idSchema.optional(),
  /** Boundaries or contracts this ADR amends. */
  amends: z.array(idSchema).max(AMEND_LIMITS.anchorsPerAdr).optional(),
  ...architectureWriteArgs,
});

/**
 * Replace the whole charter. `baseRevision` is the revision you read (`read_architecture` returns
 * it): a save based on an older one is refused with 409 `stale`. Anchors never refuse a save; they
 * are re-resolved, and the ones whose words are gone come back as `orphaned`.
 */
export const writeCharterSchema = z.object({
  markdown: z.string().max(CHARTER_LIMITS.document),
  baseRevision: z.number().int().min(0),
  note: z.string().trim().max(CHARTER_LIMITS.note).optional(),
  /**
   * True (the default) seals the result as a version. An editor that saves as the person types
   * sends false: the text becomes the head, and the version is sealed when the writer checkpoints,
   * when anyone else writes, after ten quiet minutes, or by a save that orphans or heals an amendment.
   */
  checkpoint: z.boolean().optional(),
  ...architectureWriteArgs,
});

/**
 * Change the charter by exact-text edits instead of sending it all. Each `find` is source text
 * that must occur exactly once in the charter as it stands (and no two may overlap); every edit
 * applies or none does. `baseRevision` is the revision you read: when the charter has moved on,
 * the edits are still applied wherever their text is (that is how two writers' changes to
 * different passages merge), and the answer says `rebased`.
 */
export const editCharterSchema = z.object({
  edits: z
    .array(
      z.object({
        find: z.string().min(1).max(CHARTER_LIMITS.document),
        replace: z.string().max(CHARTER_LIMITS.document),
      }),
    )
    .min(1)
    .max(CHARTER_LIMITS.editsPerCall),
  baseRevision: z.number().int().min(0).optional(),
  note: z.string().trim().max(CHARTER_LIMITS.note).optional(),
  /** As `write_charter`: false saves the working text without sealing a version. */
  checkpoint: z.boolean().optional(),
  ...architectureWriteArgs,
});

export const decideAdrSchema = z.object({
  decision: z.enum(['accept', 'reject', 'repeal']),
  /**
   * For an ADR decided before it was written down (an import, a repository's history): when it
   * was decided. Only on the accept that first ratifies the ADR, never in the future. Audited.
   */
  decidedAt: z.string().datetime({ offset: true }).optional(),
  /** Who decided it, when that was not the person writing it down. 120 characters. Same rule as `decidedAt`. */
  decidedBy: trimmed(120).min(1).optional(),
  ...architectureWriteArgs,
});

/**
 * Point an orphaned (or any) anchor at new words in the charter as it stands. The quote is what a
 * reader sees; `prefix` and `suffix` (the words just before and after) pick it when it recurs.
 */
export const reanchorSchema = z.object({
  quote: z.string().min(1).max(CHARTER_LIMITS.linkQuote),
  prefix: z.string().max(400).optional(),
  suffix: z.string().max(400).optional(),
  ...architectureWriteArgs,
});

/** Let an orphaned amendment go (the ADR stands free), or unlink a link. The anchor stays as history. */
export const dismissAnchorSchema = z.object({
  reason: z.string().trim().max(CHARTER_LIMITS.note).optional(),
  ...architectureWriteArgs,
});

/** A boundary or contract made in the same call as the link that points at it. */
const newLinkedBoundarySchema = z.object({
  kind: z.literal('boundary'),
  title: trimmed(LIMITS.blipTitle).min(1),
  owns: z.array(trimmed(200).min(1)).max(100).optional(),
  body: z.string().max(LIMITS.blipBody).optional(),
  external: z.boolean().optional(),
});
const newLinkedContractSchema = z.object({
  kind: z.literal('contract'),
  title: trimmed(LIMITS.blipTitle).min(1),
  version: trimmed(32).min(1).optional(),
  body: z.string().max(LIMITS.blipBody).optional(),
  a: idSchema,
  b: idSchema,
});

/**
 * Tie a passage of the charter to a boundary or contract. The passage is the words a reader sees
 * (`quote`, up to 4,000 characters, across paragraphs if need be), with `prefix` and `suffix` to
 * pick it when it recurs. `element` is an existing boundary's or contract's id, or a new one made
 * in the same transaction (a bad quote then leaves nothing behind).
 */
export const linkCharterSchema = z.object({
  quote: z.string().min(1).max(CHARTER_LIMITS.linkQuote),
  prefix: z.string().max(400).optional(),
  suffix: z.string().max(400).optional(),
  element: z.union([idSchema, newLinkedBoundarySchema, newLinkedContractSchema]),
  ...architectureWriteArgs,
});

const versionRef = z.union([z.literal('head'), z.coerce.number().int().min(1)]);

export const listCharterVersionsQuerySchema = z.object({
  /** Newest first. `before` is the oldest version of the page already read (a `nextCursor`). */
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** `from` and `to` are sealed version numbers, or `head` for the text as it is now. */
export const diffCharterQuerySchema = z.object({
  from: versionRef,
  to: versionRef.default('head'),
});

/** Put an earlier version's text back as a new version. History is never rewritten. */
export const restoreCharterSchema = z.object({
  baseRevision: z.number().int().min(0),
  note: z.string().trim().max(CHARTER_LIMITS.note).optional(),
  ...architectureWriteArgs,
});

/**
 * The `updatedAt` of the page, boundary or contract this change is based on. With `id`, a change
 * to a row that has been written since is refused (409 `stale`) instead of replacing what was
 * written. Left out, the change is made on whatever is there.
 */
const expectedUpdatedAt = z.string().datetime({ offset: true }).optional();

const ownsSchema = z.array(trimmed(200).min(1)).max(100);
const versionSchema = trimmed(32).min(1);

/** Create a boundary, or change one by `id` (otherwise matched by title, case-insensitively). */
export const upsertBoundarySchema = z.object({
  id: idSchema.optional(),
  expectedUpdatedAt,
  title: trimmed(LIMITS.blipTitle).min(1),
  owns: ownsSchema.optional(),
  body: z.string().max(LIMITS.blipBody).optional(),
  external: z.boolean().optional(),
  ...architectureWriteArgs,
});

/** Create a contract, or change one by `id` (otherwise matched by title). `a` and `b` are boundary ids. */
export const upsertContractSchema = z.object({
  id: idSchema.optional(),
  expectedUpdatedAt,
  title: trimmed(LIMITS.blipTitle).min(1),
  version: versionSchema.optional(),
  body: z.string().max(LIMITS.blipBody).optional(),
  a: idSchema,
  b: idSchema,
  ...architectureWriteArgs,
});

export const ARCHITECTURE_ADR_LANES = ['proposed', 'accepted', 'rejected', 'repealed'] as const;

/** An ADR's amendment as read: where it is, and, once its words are gone, why and since when. */
export interface CharterAnchorDto {
  /** The charter's single "page": the radar id. Earlier clients matched anchors to pages by it. */
  pageId: string;
  quote: string;
  with: string;
  id?: string;
  /** Left out when anchored. */
  state?: 'anchored' | 'orphaned' | 'dismissed';
  /** Only on an orphan. */
  cause?: 'text_changed' | 'ambiguous' | 'diff_not_exact';
  /** The last sealed version where it resolved. */
  resolvedVersion?: number;
  orphanedVersion?: number | null;
}

export interface CharterAnchorRefDto {
  anchorId: string;
  kind: 'amend' | 'link';
  /** The ADR (or element) the anchor belongs to. */
  subject: { id: string; label: string; lane: string | null };
  quote: string;
}

/** An anchor that has lost its words: the agent's to-do list. */
export interface CharterOrphanDto extends CharterAnchorRefDto {
  cause: 'text_changed' | 'ambiguous' | 'diff_not_exact';
  resolvedVersion: number;
  orphanedVersion: number | null;
}

/** What a full save did to the anchors. Only live ADRs (proposed, accepted) are listed as orphaned. */
export interface WriteCharterResult {
  revision: number;
  /** The sealed version this save made (the last one, when nothing changed). */
  version: number;
  changed: boolean;
  orphaned: CharterOrphanDto[];
  healed: CharterAnchorRefDto[];
  moved: CharterAnchorRefDto[];
  /** Anchors of rejected or repealed ADRs that lost their words: resolved and versioned, never reported. */
  inertOrphaned: number;
  /** Length of the charter after this save: a write answers with a summary, never the text. */
  chars?: number;
  /** A retry of a call whose key was already used: this is the charter as it stands now, not the first answer. */
  replayed?: true;
}

/** What `edit_charter` did: a save's summary, plus how many edits landed. */
export interface EditCharterResult extends WriteCharterResult {
  applied: number;
  /** The charter had moved on since `baseRevision`; the edits found their text and were applied. */
  rebased?: true;
}

/** What `reanchor` (re-anchoring or dismissing) did to one anchor. */
export interface AnchorActionResult {
  anchorId: string;
  kind: 'amend' | 'link';
  subject: { id: string; label: string; lane: string | null };
  /**
   * Where the anchor stands: right after the act it is `anchored` (re-anchored) or `dismissed`; on
   * a retry (`replayed`) it is where the anchor stands now, which can be `orphaned` again.
   */
  state: 'anchored' | 'orphaned' | 'dismissed';
  /** The sealed version that records it. */
  version: number;
  /** Where the anchor stood before: for the history it keeps. */
  was: {
    state: 'anchored' | 'orphaned' | 'dismissed';
    quote: string;
    orphanedVersion?: number | null;
  };
  quote: string;
  replayed?: true;
}

export interface ArchitectureAdrDto {
  id: string;
  label: string;
  title: string;
  lane: string | null;
  ratifiedAt: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  anchors: CharterAnchorDto[];
  /** Ids of the boundaries and contracts it amends. */
  amends: string[];
  /** Who decided it, when that was recorded as someone other than the person who wrote it down. */
  decidedBy?: string;
}

export interface ArchitecturePageDto {
  id: string;
  title: string;
  updatedAt: string;
  /** The whole page, `# title` first. */
  markdown: string;
}

export interface ArchitectureBoundaryDto {
  id: string;
  title: string;
  /** For `expectedUpdatedAt`. */
  updatedAt: string;
  /** Only the one asked for with `edit`. */
  body?: string;
  external: boolean;
  /** Left out when the read asked for `owns: false`. */
  owns?: string[];
  /** Ids of the ADRs that amend it, in any lane: the lane says whether the mark is red or amber. */
  amendedBy: string[];
  /** Left out when no charter passage is linked to it. */
  charter?: ElementCharterDto;
}

export interface ArchitectureContractDto {
  id: string;
  title: string;
  updatedAt: string;
  body?: string;
  version: string | null;
  /** Boundary ids. */
  a: string;
  b: string;
  amendedBy: string[];
  /** Left out when no charter passage is linked to it. */
  charter?: ElementCharterDto;
}

/**
 * What the charter says about an element: `linked` when any of its links still finds its words,
 * `orphaned` when it has links and none does (a dismissed link counts for nothing). Left out when
 * it has none. `links` are ids into the answer's `links`.
 */
export interface ElementCharterDto {
  state: 'linked' | 'orphaned';
  links: string[];
}

/** A passage of the charter tied to a boundary or contract. */
export interface CharterLinkDto {
  id: string;
  element: { id: string; title: string; kind: 'boundary' | 'contract' };
  state: 'anchored' | 'orphaned' | 'dismissed';
  /** The first 120 characters of the passage. */
  excerpt: string;
  /** The headings above the passage, outermost first; null for an anchor with no place now. */
  section: string[] | null;
  /** The last sealed version where it resolved: open it with `read_architecture({version, anchor: id})`. */
  resolvedVersion: number;
  /**
   * Where the passage is in the current charter: offsets into its plain-text projection, end
   * exclusive. Only on an anchored link of a read of the head; a past version's text is not the
   * text these were measured on.
   */
  start?: number;
  end?: number;
  /** Only on an orphan. */
  cause?: 'text_changed' | 'ambiguous' | 'diff_not_exact';
  orphanedVersion?: number | null;
}

/** Where an anchor stands in a read: offsets into the stored text's projection, and into its markdown. */
export interface CharterHighlightDto {
  anchorId: string;
  state: 'anchored' | 'orphaned' | 'dismissed';
  quote: string;
  /** Null when the anchor had no place in the text that was read. */
  start: number | null;
  end: number | null;
  sourceStart: number | null;
  sourceEnd: number | null;
}

/** Who wrote a version, and why it exists. */
export interface CharterVersionDto {
  version: number;
  createdAt: string;
  cause: 'edit' | 'adr' | 'anchor' | 'migration' | 'restore';
  /** "v12 · ADR-0028 proposed", "v7 · edit", "v3 · restore": for a list. */
  label: string;
  note: string | null;
  /** A person, or an agent working for one (`name` is then the agent's, `onBehalfOf` the person's). */
  by: {
    kind: 'person' | 'agent';
    id: string | null;
    name: string | null;
    onBehalfOf?: string | null;
    handle?: string | null;
  };
  /** The connection it came through (a token's or app's name), when it came through one. */
  via: string | null;
  /** The ADR or element the version was made for. */
  subject: { id: string; label: string; lane: string | null } | null;
  /** The lane the version's ADR was in when it was sealed (`subject.lane` is where it is now). */
  lane?: string | null;
  /** For a restore: the version whose text it put back; null when it cannot be told. */
  restoredFrom?: number | null;
}

export interface CharterVersionsDto {
  versions: CharterVersionDto[];
  /** Pass as `before` for the next page; null on the last. */
  nextCursor: number | null;
  /** The head: its revision, and whether it differs from the newest version (a working text). */
  head: { revision: number; version: number; unsealed: boolean };
}

export interface CharterDiffHunk {
  /** The headings above the change, in the newer text when it has the place, else the older. */
  section: string[] | null;
  /** Text only the older version has: offsets into its projection. `text` is cut at 400 characters. */
  struck: { start: number; end: number; text: string } | null;
  /** Text only the newer one has: offsets into its projection. */
  inserted: { start: number; end: number; text: string } | null;
}

export interface CharterDiffDto {
  from: { version: number | 'head' };
  to: { version: number | 'head' };
  identical: boolean;
  /** False when the diff spent its edit budget: some stretches count as wholly replaced. */
  exact: boolean;
  /** True when there were more hunks than `hunks` holds; `stats` still counts them all. */
  truncated: boolean;
  stats: { hunks: number; struckChars: number; insertedChars: number };
  hunks: CharterDiffHunk[];
}

export interface RestoreCharterResult extends WriteCharterResult {
  restoredFrom: number;
}

export interface ArchitectureDto {
  radar: { id: string; name: string };
  charter: Array<{
    id: string;
    title: string | null;
    updatedAt?: string;
    markdown?: string;
    headings?: string[];
    /** With `outline`: every heading's slug, level and text, for `sections`. */
    outline?: Array<{ slug: string; level: number; heading: string }>;
    /** With `sections`: the sections asked for, in document order. */
    sections?: Array<{ slug: string; heading: string; markdown: string }>;
  }>;
  adrs: ArchitectureAdrDto[];
  boundaries: ArchitectureBoundaryDto[];
  contracts: ArchitectureContractDto[];
  /** The charter's revision (what `write_charter` is based on) and its newest sealed version. */
  revision?: number;
  charterVersion?: number;
  /** Amendments of live ADRs, and links, whose words are gone; left out when there are none. */
  orphans?: CharterOrphanDto[];
  /** The charter's links to boundaries and contracts; left out when there are none. */
  links?: CharterLinkDto[];
  /** Present on a read of an earlier version: the charter is that version's, and nothing here can be saved. */
  asOf?: CharterVersionDto;
  readOnly?: true;
  /** For the `anchor` asked for. */
  highlight?: CharterHighlightDto | null;
}

export interface TraceRef {
  id: string;
  title: string;
}
export interface TraceAdr {
  id: string;
  label: string;
  lane: string | null;
}
/** Everything touching a boundary, a contract or an ADR. A charter page is not traceable. */
export type TraceDto =
  | {
      kind: 'boundary';
      id: string;
      title: string;
      external: boolean;
      owns: string[];
      seams: Array<{
        contract: TraceRef;
        version: string | null;
        side: 'a' | 'b';
        counterparty: TraceRef & { external: boolean };
      }>;
      amendedBy: TraceAdr[];
      /** The charter passages tied to it; left out when there are none. */
      links?: CharterLinkDto[];
    }
  | {
      kind: 'contract';
      id: string;
      title: string;
      version: string | null;
      a: TraceRef & { external: boolean };
      b: TraceRef & { external: boolean };
      amendedBy: TraceAdr[];
      links?: CharterLinkDto[];
    }
  | {
      kind: 'adr';
      id: string;
      label: string;
      lane: string | null;
      anchors: ArchitectureAdrDto['anchors'];
      amends: Array<TraceRef & { kind: 'boundary' | 'contract' }>;
      supersedes: TraceAdr | null;
      supersededBy: TraceAdr | null;
    };

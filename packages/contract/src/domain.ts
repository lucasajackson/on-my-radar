/**
 * On My Radar — shared domain vocabulary.
 *
 * Everything in this file is imported by BOTH the server and the browser
 * bundle, so it must stay dependency-free apart from zod. No Node built-ins.
 */

import { isOwnKey } from './own.js';

/* -------------------------------------------------------------------------- */
/* Blips                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A blip's `kind` is a *rendering affordance*, not a schema discriminator: every
 * blip has the same columns (body, url, attachments) and the kind only tells the
 * UI which shape to lead with. `deriveBlipKind` picks one when the caller — a
 * human hitting Enter, or an agent over MCP — did not bother to say.
 */
export const BLIP_KINDS = ['note', 'link', 'image', 'file', 'essay', 'quote', 'task'] as const;
export type BlipKind = (typeof BLIP_KINDS)[number];

/** Bodies longer than this read as an essay rather than a note. */
export const ESSAY_BODY_THRESHOLD = 600;

export function deriveBlipKind(input: {
  body?: string | null;
  url?: string | null;
  attachmentContentTypes?: string[];
}): BlipKind {
  const types = input.attachmentContentTypes ?? [];
  if (types.length > 0) {
    return types.every((t) => t.startsWith('image/')) ? 'image' : 'file';
  }
  if (input.url && !input.body?.trim()) return 'link';
  if ((input.body ?? '').length > ESSAY_BODY_THRESHOLD) return 'essay';
  return 'note';
}

/**
 * Triage state. The primary radar view is a reverse-chronological stream, so
 * this is a filter and a badge rather than a layout axis — but it is the thing
 * that turns a pile of captured thoughts into a sorted one.
 */
export const BLIP_STATES = ['inbox', 'active', 'later', 'done', 'dropped'] as const;
export type BlipState = (typeof BLIP_STATES)[number];

export const BLIP_STATE_LABELS: Record<BlipState, string> = {
  inbox: 'Inbox',
  active: 'Active',
  later: 'Later',
  done: 'Done',
  dropped: 'Dropped',
};

/* -------------------------------------------------------------------------- */
/* Radars                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Radar accents.
 *
 * Named rather than free-form hex so the same token can drive a Tailwind
 * gradient in the SPA, an SVG open-graph card on the server, and a colour word
 * an agent can set over MCP ("make it ember").
 *
 * ## Why each one declares a family
 *
 * A flat row of ten swatches is something you read at a glance. A flat row of
 * twenty-six is a wall, and a picker that draws it has stopped offering a choice
 * and started demanding a search. The family is what lets the picker draw six
 * short rows with a word above each — the same set, arranged so the eye can find
 * the warm ones without scanning the cold ones.
 *
 * It is display metadata and nothing else: no behaviour reads it, and an
 * accent's family can be changed without touching a stored row.
 *
 * ## The luminance band, and why nothing here is paler than `slate`
 *
 * `--accent-from` is used as a *text* colour in a couple of dozen rules and the
 * light theme deliberately does not restate it. So every `from` below stays
 * inside the band the original ten already occupied, whose palest member is
 * `slate` at #94a3b8. A genuinely pale accent — a bone, an oyster — would look
 * lovely on the dark theme and be unreadable on the light one, and adding one is
 * a cascade change rather than a palette change. See docs/DESIGN.md, known
 * limitations.
 */
export const ACCENT_FAMILIES = {
  warm: 'Warm',
  earth: 'Earth',
  green: 'Green',
  blue: 'Blue',
  violet: 'Violet',
  neutral: 'Neutral',
} as const;

export type AccentFamily = keyof typeof ACCENT_FAMILIES;
export const ACCENT_FAMILY_KEYS = Object.keys(ACCENT_FAMILIES) as AccentFamily[];

export interface RadarAccentDef {
  readonly label: string;
  readonly family: AccentFamily;
  readonly from: string;
  readonly to: string;
  readonly ink: string;
}

export const RADAR_ACCENTS = {
  /* -- warm -- */
  ember: { label: 'Ember', family: 'warm', from: '#fb923c', to: '#ef4444', ink: '#7c2d12' },
  citrus: { label: 'Citrus', family: 'warm', from: '#fbbf24', to: '#f97316', ink: '#78350f' },
  honey: { label: 'Honey', family: 'warm', from: '#facc15', to: '#ca8a04', ink: '#713f12' },
  cherry: { label: 'Cherry', family: 'warm', from: '#f87171', to: '#b91c1c', ink: '#450a0a' },
  coral: { label: 'Coral', family: 'warm', from: '#fb7185', to: '#e11d48', ink: '#4c0519' },
  bubblegum: { label: 'Bubblegum', family: 'warm', from: '#f472b6', to: '#db2777', ink: '#500724' },

  /* -- earth -- */
  rust: { label: 'Rust', family: 'earth', from: '#d97706', to: '#9a3412', ink: '#431407' },
  clay: { label: 'Clay', family: 'earth', from: '#d1976f', to: '#7c4a21', ink: '#3b220e' },
  sand: { label: 'Sand', family: 'earth', from: '#d9c18d', to: '#a1874e', ink: '#3f3218' },
  cocoa: { label: 'Cocoa', family: 'earth', from: '#a98467', to: '#5c3d2e', ink: '#2a1a12' },

  /* -- green -- */
  moss: { label: 'Moss', family: 'green', from: '#4ade80', to: '#059669', ink: '#064e3b' },
  pine: { label: 'Pine', family: 'green', from: '#34d399', to: '#065f46', ink: '#022c22' },
  jade: { label: 'Jade', family: 'green', from: '#5eead4', to: '#0d9488', ink: '#042f2e' },
  olive: { label: 'Olive', family: 'green', from: '#a3e635', to: '#4d7c0f', ink: '#1a2e05' },

  /* -- blue -- */
  lagoon: { label: 'Lagoon', family: 'blue', from: '#22d3ee', to: '#0284c7', ink: '#0c4a6e' },
  sky: { label: 'Sky', family: 'blue', from: '#38bdf8', to: '#0369a1', ink: '#082f49' },
  cobalt: { label: 'Cobalt', family: 'blue', from: '#60a5fa', to: '#4338ca', ink: '#1e1b4b' },
  denim: { label: 'Denim', family: 'blue', from: '#93c5fd', to: '#1e40af', ink: '#172554' },

  /* -- violet -- */
  orchid: { label: 'Orchid', family: 'violet', from: '#c084fc', to: '#7c3aed', ink: '#3b0764' },
  lilac: { label: 'Lilac', family: 'violet', from: '#c4b5fd', to: '#7c3aed', ink: '#2e1065' },
  plum: { label: 'Plum', family: 'violet', from: '#e879f9', to: '#a21caf', ink: '#4a044e' },
  indigo: { label: 'Indigo', family: 'violet', from: '#a5b4fc', to: '#3730a3', ink: '#1e1b4b' },

  /* -- neutral -- */
  slate: { label: 'Slate', family: 'neutral', from: '#94a3b8', to: '#334155', ink: '#0f172a' },
  ash: { label: 'Ash', family: 'neutral', from: '#a8b0c0', to: '#4b5563', ink: '#111827' },
  graphite: {
    label: 'Graphite',
    family: 'neutral',
    from: '#a1a1aa',
    to: '#3f3f46',
    ink: '#18181b',
  },
  midnight: {
    label: 'Midnight',
    family: 'neutral',
    from: '#818cf8',
    to: '#1e293b',
    ink: '#020617',
  },
} as const satisfies Record<string, RadarAccentDef>;

export type RadarAccent = keyof typeof RADAR_ACCENTS;
export const RADAR_ACCENT_KEYS = Object.keys(RADAR_ACCENTS) as RadarAccent[];
export const DEFAULT_RADAR_ACCENT: RadarAccent = 'cobalt';

export function isRadarAccent(value: unknown): value is RadarAccent {
  return isOwnKey(RADAR_ACCENTS, value);
}

/** Never throws: an unknown stored accent resolves to the default, like `templateFor`. */
export function accentFor(value: string | null | undefined): RadarAccentDef {
  return isRadarAccent(value) ? RADAR_ACCENTS[value] : RADAR_ACCENTS[DEFAULT_RADAR_ACCENT];
}

/** The accents in one family, in declaration order. The picker draws one row per family. */
export function accentsInFamily(family: AccentFamily): RadarAccent[] {
  return RADAR_ACCENT_KEYS.filter((key) => RADAR_ACCENTS[key].family === family);
}

/**
 * Radar glyphs.
 *
 * A curated set beats an emoji picker: they render identically on every
 * platform, they inherit the radar's accent, and an agent can pick one by name
 * over MCP without emitting an emoji.
 *
 * Grouped for exactly the reason the accents are — forty-eight glyphs in one
 * wrap is a wall — and given `keywords` so the picker's search finds `flask` for
 * somebody who typed "science". Both are display metadata; nothing behavioural
 * reads either.
 *
 * **The id is what is stored, so an id here is permanent.** The label and the
 * group are free to change; the key is not.
 */
export const GLYPH_GROUPS = {
  signal: 'Signal',
  thinking: 'Thinking',
  making: 'Making',
  living: 'Living',
  outside: 'Outside',
  media: 'Media',
} as const;

export type GlyphGroup = keyof typeof GLYPH_GROUPS;
export const GLYPH_GROUP_KEYS = Object.keys(GLYPH_GROUPS) as GlyphGroup[];

export interface RadarGlyphDef {
  readonly label: string;
  readonly group: GlyphGroup;
  /** Extra words the search matches, for glyphs whose id is not the word you would type. */
  readonly keywords?: string;
}

export const RADAR_GLYPHS = {
  /* -- signal -- */
  radar: { label: 'Radar', group: 'signal', keywords: 'sweep scan default' },
  target: { label: 'Target', group: 'signal', keywords: 'goal aim bullseye' },
  compass: { label: 'Compass', group: 'signal', keywords: 'direction bearing north' },
  sparkles: { label: 'Sparkles', group: 'signal', keywords: 'magic new shiny' },
  flame: { label: 'Flame', group: 'signal', keywords: 'fire hot urgent burning' },
  zap: { label: 'Zap', group: 'signal', keywords: 'lightning fast energy bolt' },
  orbit: { label: 'Orbit', group: 'signal', keywords: 'satellite space loop' },
  telescope: { label: 'Telescope', group: 'signal', keywords: 'look ahead future watch' },

  /* -- thinking -- */
  lightbulb: { label: 'Lightbulb', group: 'thinking', keywords: 'idea inspiration' },
  brain: { label: 'Brain', group: 'thinking', keywords: 'thought mind memory' },
  book: { label: 'Book', group: 'thinking', keywords: 'read reading library notes' },
  quote: { label: 'Quote', group: 'thinking', keywords: 'said writing words' },
  puzzle: { label: 'Puzzle', group: 'thinking', keywords: 'problem piece solve' },
  scroll: { label: 'Scroll', group: 'thinking', keywords: 'essay long document record' },
  glasses: { label: 'Glasses', group: 'thinking', keywords: 'review look closer editing' },
  message: { label: 'Message', group: 'thinking', keywords: 'talk chat discussion thread' },

  /* -- making -- */
  wrench: { label: 'Wrench', group: 'making', keywords: 'fix tools repair maintenance' },
  hammer: { label: 'Hammer', group: 'making', keywords: 'build diy work' },
  rocket: { label: 'Rocket', group: 'making', keywords: 'launch ship release' },
  code: { label: 'Code', group: 'making', keywords: 'dev software programming' },
  cpu: { label: 'Chip', group: 'making', keywords: 'hardware machine computer' },
  blocks: { label: 'Blocks', group: 'making', keywords: 'components build lego' },
  pen: { label: 'Pen', group: 'making', keywords: 'design draw sketch vector' },
  flask: { label: 'Flask', group: 'making', keywords: 'science lab experiment research' },

  /* -- living -- */
  coffee: { label: 'Coffee', group: 'living', keywords: 'cafe morning break' },
  heart: { label: 'Heart', group: 'living', keywords: 'love health people family' },
  house: { label: 'House', group: 'living', keywords: 'home diy household property' },
  gift: { label: 'Gift', group: 'living', keywords: 'present birthday christmas' },
  dumbbell: { label: 'Dumbbell', group: 'living', keywords: 'gym fitness training exercise' },
  basket: { label: 'Basket', group: 'living', keywords: 'shopping groceries errands buy' },
  dog: { label: 'Dog', group: 'living', keywords: 'pet animal walk' },
  utensils: { label: 'Utensils', group: 'living', keywords: 'food cooking recipes dinner' },

  /* -- outside -- */
  leaf: { label: 'Leaf', group: 'outside', keywords: 'garden plants nature green' },
  mountain: { label: 'Mountain', group: 'outside', keywords: 'hiking climb peak' },
  sun: { label: 'Sun', group: 'outside', keywords: 'weather summer day' },
  moon: { label: 'Moon', group: 'outside', keywords: 'night sleep evening' },
  waves: { label: 'Waves', group: 'outside', keywords: 'sea water swimming beach' },
  tent: { label: 'Tent', group: 'outside', keywords: 'camping outdoors trip' },
  map: { label: 'Map', group: 'outside', keywords: 'places travel navigation' },
  plane: { label: 'Plane', group: 'outside', keywords: 'travel flight holiday trip' },

  /* -- media -- */
  camera: { label: 'Camera', group: 'media', keywords: 'photos pictures shooting' },
  music: { label: 'Music', group: 'media', keywords: 'songs listening albums' },
  film: { label: 'Film', group: 'media', keywords: 'movies cinema watching video' },
  gamepad: { label: 'Gamepad', group: 'media', keywords: 'games gaming console play' },
  mic: { label: 'Microphone', group: 'media', keywords: 'podcast recording audio voice' },
  palette: { label: 'Palette', group: 'media', keywords: 'art paint colour drawing' },
  tv: { label: 'Television', group: 'media', keywords: 'shows series watching' },
  headphones: { label: 'Headphones', group: 'media', keywords: 'listening audio podcast' },
} as const satisfies Record<string, RadarGlyphDef>;

export type RadarGlyph = keyof typeof RADAR_GLYPHS;
export const RADAR_GLYPH_KEYS = Object.keys(RADAR_GLYPHS) as RadarGlyph[];
export const DEFAULT_RADAR_GLYPH: RadarGlyph = 'radar';

export function isRadarGlyph(value: unknown): value is RadarGlyph {
  return isOwnKey(RADAR_GLYPHS, value);
}

/** Never throws: an unknown stored glyph resolves to the default. */
export function glyphFor(value: string | null | undefined): RadarGlyphDef {
  return isRadarGlyph(value) ? RADAR_GLYPHS[value] : RADAR_GLYPHS[DEFAULT_RADAR_GLYPH];
}

export function glyphsInGroup(group: GlyphGroup): RadarGlyph[] {
  return RADAR_GLYPH_KEYS.filter((key) => RADAR_GLYPHS[key].group === group);
}

/**
 * Does this glyph match what somebody typed into the picker's search?
 *
 * In the contract rather than in the SPA because the matching rule is part of
 * what the vocabulary *means*: an agent asked for "something science-y" should
 * reach the same answer the picker does.
 */
export function matchesGlyphQuery(key: RadarGlyph, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const def = RADAR_GLYPHS[key];
  return (
    key.includes(needle) ||
    def.label.toLowerCase().includes(needle) ||
    GLYPH_GROUPS[def.group].toLowerCase().includes(needle) ||
    def.keywords.includes(needle)
  );
}

export function matchesAccentQuery(key: RadarAccent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const def = RADAR_ACCENTS[key];
  return (
    key.includes(needle) ||
    def.label.toLowerCase().includes(needle) ||
    ACCENT_FAMILIES[def.family].toLowerCase().includes(needle)
  );
}

/* -------------------------------------------------------------------------- */
/* Access                                                                     */
/* -------------------------------------------------------------------------- */

/** Ordered least → most privileged; `roleAtLeast` depends on the order. */
export const RADAR_ROLES = ['viewer', 'editor', 'owner'] as const;
export type RadarRole = (typeof RADAR_ROLES)[number];

export function roleAtLeast(role: RadarRole, required: RadarRole): boolean {
  return RADAR_ROLES.indexOf(role) >= RADAR_ROLES.indexOf(required);
}

/* -------------------------------------------------------------------------- */
/* Token scopes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a bearer token was granted — the ceiling an agent acts under.
 *
 * A scope is **not** a second permission system. It is a cap on the access its
 * human already has: effective access is `min(what the person may do, what the
 * token was granted)`. An agent therefore contributes no term to any union and
 * the only agent-specific operation in the whole authorization path is a
 * monotonically weakening `min`. There is no arrangement of scopes that lets a
 * token do something its owner could not.
 *
 * Radar scopes are ordered least → most privileged, each subsuming the prior:
 * `radars:manage` implies write implies read, because the ceiling is a single
 * `RadarRole` and the strongest scope decides it. Granting `manage` alone and
 * expecting an agent that can share but not capture is not representable, and
 * deliberately so — a role ceiling that is not a total order stops being a `min`.
 *
 * `radars:manage` exists rather than capping every agent at `editor`, because
 * five shipped MCP tools live above `editor` — `delete_radar`,
 * `set_radar_visibility`, `share_radar`, `create_webhook`, `delete_webhook`.
 * Removing capability that is live in production as a side effect of starting to
 * enforce consent is not a change anybody agreed to. It is granted by default
 * and named on the consent screen, so declining it is a choice a person makes
 * rather than one made for them.
 */
/** Supported scopes. */
export const TOKEN_SCOPES = ['radars:read', 'radars:write', 'radars:manage'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** The radar role each scope caps a credential at. */
export const SCOPE_CEILING: Record<TokenScope, RadarRole> = {
  'radars:read': 'viewer',
  'radars:write': 'editor',
  'radars:manage': 'owner',
};

/**
 * What a client gets when it asks for nothing. Ordinary radar access, because that is what
 * every token issued before scopes were enforced already did, and a default that
 * quietly narrows an existing integration is a breaking change wearing the
 * clothes of a security fix.
 */
export const DEFAULT_TOKEN_SCOPES = [
  'radars:read',
  'radars:write',
  'radars:manage',
] as const satisfies readonly TokenScope[];

/**
 * What a *new* OAuth consent grants when the client asks for nothing. Manage
 * (publishing, sharing, webhooks) is a separate, unticked box on the consent
 * screen. Grants made before this keep the scope they were given and refresh
 * with it; `DEFAULT_TOKEN_SCOPES` above is still what an unconsented one means.
 */
export const OAUTH_DEFAULT_SCOPES = [
  'radars:read',
  'radars:write',
] as const satisfies readonly TokenScope[];

function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * An OAuth scope string → the scopes this server actually understands.
 *
 * Unknown entries are dropped rather than rejected, per RFC 6749 §3.3, so a
 * client that asks for a scope some other server defines still connects. An
 * empty result means the caller asked for *nothing this server grants*, which is
 * a different thing from asking for nothing at all — the caller decides what to
 * do about it.
 */
export function parseScopes(raw: string | null | undefined): TokenScope[] {
  if (!raw) return [];
  const asked = new Set(
    raw
      .split(/[\s,]+/)
      .filter(Boolean)
      .filter(isTokenScope),
  );
  // Canonical order, so a stored scope string is comparable byte-for-byte
  // regardless of how the client wrote it.
  return TOKEN_SCOPES.filter((scope) => asked.has(scope));
}

/** The strongest ceiling a set of scopes confers, or null when the set is empty. */
export function ceilingFor(scopes: readonly TokenScope[]): RadarRole | null {
  let ceiling: RadarRole | null = null;
  for (const scope of scopes) {
    const role = SCOPE_CEILING[scope];
    if (ceiling === null || roleAtLeast(role, ceiling)) ceiling = role;
  }
  return ceiling;
}

/**
 * How each scope is described to a human on the consent screen.
 *
 * The Agent Repo rides the same ceiling (docs/AGENT_REPO.md §6.1) rather than a
 * second scope family, which would make the ceiling a partial order. So the
 * copy says so: a grant that reads radars also loads agents and their memory,
 * and one that writes also saves memory and proposes prompt changes.
 */
export const SCOPE_COPY: Record<TokenScope, { title: string; detail: string }> = {
  'radars:read': {
    title: 'Read and search everything you can see',
    detail:
      'Every radar, blip, comment and tag you have access to — and your agents’ prompts and memory.',
  },
  'radars:write': {
    title: 'Capture and file blips, and make new radars',
    detail:
      'Write blips, re-file and edit them, comment, react, and create radars and arrays. Save agent memory and propose prompt changes, which you approve.',
  },
  'radars:manage': {
    title: 'Publish radars and change who they are shared with',
    detail: 'Also delete radars, move them between arrays, and manage their webhooks.',
  },
};

/* -------------------------------------------------------------------------- */
/* Agent personas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whose name an agent's write is rendered under.
 *
 * **The voice decides what is rendered, never what is recorded.** An agent can
 * never act except on behalf of a human, so every agent-borne write already has
 * a human behind it: `author_id` is the human and `agent_id` is the agent, both
 * written every time, in both voices, with no mode that suppresses either.
 *
 * That is the whole of the impersonation argument. In the agent→human direction
 * there is no column to forge — the worst a mis-granted token can do is put the
 * wrong name in the larger type on a card, over a record that is still true and
 * still says which agent wrote it. Wave's failure was not that words appeared
 * under the wrong name; it was that the result was unrecoverable afterwards.
 *
 *   persona    Claude · via Ada
 *   principal  Ada · via Claude
 *
 * Note what is identical between those two rows in the database: everything.
 */
export const VOICES = ['persona', 'principal'] as const;
export type Voice = (typeof VOICES)[number];

/**
 * How the tool argument spells a voice.
 *
 * `as: 'me'` and `as: 'agent'` rather than the stored words, because the caller
 * is an agent choosing between *itself* and *its human* — "principal" is a word
 * about the model, and "me" is a word about the call. The mapping is one-way and
 * lives here so the MCP tool surface and the REST body cannot disagree.
 */
export const VOICE_BY_AS: Record<'me' | 'agent', Voice> = {
  me: 'principal',
  agent: 'persona',
};

/** How each voice is described to a human on the consent screen. */
export const VOICE_COPY: Record<Voice, { title: string; detail: string }> = {
  persona: {
    title: 'Write under its own name',
    detail: 'Blips and comments read “Claude · via you”, so anyone can see what the agent wrote.',
  },
  principal: {
    title: 'Write under your name',
    detail: 'Blips and comments read “you · via Claude”. The agent is still recorded underneath.',
  },
};

/**
 * The OAuth scope that grants a voice.
 *
 * Voices ride the scope string for OAuth because that is already the grant
 * channel and the consent screen already renders it. **Absence of any `voice:`
 * scope is read as legacy** — both voices permitted, default `principal` — which
 * is exactly what a token issued before personas existed already did, expressed
 * as a code rule rather than as a data migration.
 */
export const VOICE_SCOPES: Record<Voice, string> = {
  persona: 'voice:persona',
  principal: 'voice:principal',
};

export const VOICE_SCOPE_LIST = [VOICE_SCOPES.persona, VOICE_SCOPES.principal] as const;

/**
 * The voices a scope string grants, or `null` when it names none of them.
 *
 * `null` is not "no voices" — it is "this string predates the model", which the
 * caller turns into the legacy grant. An empty array is not representable and
 * would be meaningless: a token that may speak in no voice cannot write at all,
 * which is what `radars:read` is for.
 */
export function parseVoiceGrants(raw: string | null | undefined): Voice[] | null {
  if (!raw) return null;
  const asked = new Set(raw.split(/[\s,]+/).filter(Boolean));
  const granted = VOICES.filter((voice) => asked.has(VOICE_SCOPES[voice]));
  return granted.length > 0 ? granted : null;
}

export const USER_STATES = ['pending', 'active', 'suspended'] as const;
export type UserState = (typeof USER_STATES)[number];

/** Public radars are read-only to the world; visibility lives on the radar row. */
export const RADAR_VISIBILITIES = ['private', 'public'] as const;
export type RadarVisibility = (typeof RADAR_VISIBILITIES)[number];

/**
 * Where a caller's access to a radar came from. Resolved server-side and put on
 * the wire, for the same reason `canWrite` is: the UI must never work a
 * permission out for itself, and with topics in play "why can I edit this?" now
 * has more than one answer worth showing a person.
 */
export const ACCESS_SOURCES = ['owner', 'member', 'topic', 'public'] as const;
export type AccessSource = (typeof ACCESS_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/* Topics                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A topic is a container for radars — "I Am Well Foundation" holding a Kanban
 * board, a decision log and a discussion.
 *
 * **A topic grant is not a radar grant.** Sharing a topic tells somebody the
 * grouping exists and lets them see the radars in it *they can already reach*;
 * it hands over no radar by itself. Only `cascade` changes that, and it is an
 * opt-in property of the topic. See `docs/DESIGN.md` §17.
 *
 * Deliberately only two grantable roles, unlike `RADAR_ROLES`. A topic 'owner'
 * grant would let a second person flip `cascade` — the single widest access
 * change in the application — and widening this later is easy where narrowing
 * it would take access away from somebody who already has it.
 */
export const TOPIC_ROLES = ['viewer', 'editor'] as const;
export type TopicRole = (typeof TOPIC_ROLES)[number];

export function topicRoleAtLeast(role: TopicRole, required: TopicRole): boolean {
  return TOPIC_ROLES.indexOf(role) >= TOPIC_ROLES.indexOf(required);
}

/**
 * What a topic role grants on the radars inside a cascading topic.
 *
 * Never `owner`: a cascade may hand somebody the right to read or to capture,
 * but never the right to delete a radar, publish it, or share it onward. Those
 * stay with the radar's own owner, so the blast radius of the cascade switch
 * stops at content and never reaches access itself.
 */
export const CASCADE_GRANTS: Record<TopicRole, RadarRole> = {
  viewer: 'viewer',
  editor: 'editor',
};

/* -------------------------------------------------------------------------- */
/* Radar kinds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where a radar's blips come from.
 *
 * A `standard` radar owns its blips. A `smart` radar owns none: it is a saved
 * query over tags, resolved at read time against *the caller's* readable radars.
 * That last part is load-bearing — see `resolveRadarScope` in services/radars.ts.
 */
export const RADAR_KINDS = ['standard', 'smart'] as const;
export type RadarKind = (typeof RADAR_KINDS)[number];

/** How a smart radar's tag list is combined. */
export const SMART_MATCH_MODES = ['any', 'all'] as const;
export type SmartMatchMode = (typeof SMART_MATCH_MODES)[number];

/**
 * The saved query behind a smart radar. At least one tag is required: a smart
 * radar with no tags is "everything you can read", which is both confusing and
 * the most expensive query in the app.
 */
export interface SmartFilter {
  tags: string[];
  match: SmartMatchMode;
  states?: BlipState[];
  kinds?: BlipKind[];
  /** Restrict to these source radars. Always intersected with what you can read. */
  radarIds?: string[];
  q?: string;
}

/* -------------------------------------------------------------------------- */
/* Reactions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Blip reactions.
 *
 * A small, curated, *named* set rather than an open emoji picker — the same
 * argument as radar glyphs and accents. A stored key is stable whatever the
 * platform renders, an agent can react by name over MCP without emitting an
 * emoji, and every viewer sees the same six marks rather than a long tail of
 * near-duplicates nobody can aggregate.
 *
 * Deliberately NOT constrained in SQL, for the same reason `blips.status` is
 * not: the registry validates it, so adding a reaction is one line here and no
 * migration. See docs/DESIGN.md §4.
 */
export const BLIP_REACTIONS = {
  up: { emoji: '\u{1F44D}', label: 'Thumbs up' },
  down: { emoji: '\u{1F44E}', label: 'Thumbs down' },
  heart: { emoji: '\u{2764}\u{FE0F}', label: 'Love it' },
  party: { emoji: '\u{1F389}', label: 'Celebrate' },
  thinking: { emoji: '\u{1F914}', label: 'Not sure' },
  eyes: { emoji: '\u{1F440}', label: 'Looking at it' },
} as const;

export type BlipReaction = keyof typeof BLIP_REACTIONS;
export const BLIP_REACTION_KEYS = Object.keys(BLIP_REACTIONS) as BlipReaction[];

export function isBlipReaction(value: unknown): value is BlipReaction {
  return isOwnKey(BLIP_REACTIONS, value);
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How an inbound payload becomes a blip body.
 *
 * `auto` reads the shape: JSON with a recognisable text field uses it, a form
 * post renders every field as a labelled line, plain text is taken verbatim.
 * `template` renders a `{{field.path}}` string the radar's owner configured.
 */
export const WEBHOOK_FORMATS = ['auto', 'template'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const WEBHOOK = {
  /** Bodies larger than this are refused before parsing. */
  maxPayloadBytes: 64 * 1024,
  /** Per webhook, per minute. Anything above is a 429. */
  requestsPerMinute: 60,
  /** How long a rendered body may be before it is truncated. */
  maxBodyChars: 20_000,
  tokenPrefix: 'omr_hook_',
} as const;

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

export const LIMITS = {
  blipBody: 100_000,
  blipTitle: 300,
  radarName: 120,
  /** The one-line subtitle under a radar's name. Named `tagline` on the wire. */
  radarTagline: 300,
  radarDescription: 2_000,
  topicName: 120,
  topicTagline: 300,
  topicDescription: 2_000,
  /** A guard on the cascade blast radius, not a product ceiling. */
  radarsPerTopic: 200,
  tagsPerBlip: 24,
  tagLength: 48,
  /**
   * A mention handle, normalised. Same ceiling as a tag because it is the same
   * normalisation with a different sigil — see `mentionKey`.
   */
  mentionLength: 48,
  /**
   * How many people one body may address. A ceiling on the fan-out rather than a
   * product limit: a mention does not coalesce, so N mentions is N notifications
   * and N is worth bounding.
   */
  mentionsPerBody: 16,
  attachmentsPerBlip: 12,
  attachmentBytes: 25 * 1024 * 1024,
  pageSize: 50,
  maxPageSize: 200,
  /**
   * A memory ceiling on a page cursor, and deliberately nothing more.
   *
   * It is NOT a measurement of how long a cursor is. That number was tried and
   * it drifted: 200 was right when the blip cursor carried three keys and 139
   * characters, and became a 400 on page 2 of every stream the day `rank`,
   * `activityAt` and `score` joined it and took it past 208. The comment cursor
   * did the same when threading added its root keys and took it to 247. Both
   * failures were invisible until a radar held more than one page.
   *
   * So this is set four times above anything the encoders can currently emit,
   * and the question "is this a real cursor" is asked where it can actually be
   * answered — at the decode, by `decodeCursor`, on both transports.
   */
  cursor: 1_024,
  /** A comment is a remark, not an essay — the blip is where the long thought goes. */
  commentBody: 10_000,
  commentsPerPage: 100,
  /** The whole search box, filters and words together. */
  searchQuery: 500,
  /**
   * One `in:` or `from:` value. Short because it names a radar or a person, and
   * a longer string is a typo rather than a name — truncating it keeps a paste
   * accident from becoming a 500-character ILIKE pattern.
   */
  searchValue: 160,
  /** Maximum tokens per field and alternatives per token; overflow is an error. */
  searchFiltersPerField: 32,
} as const;

/**
 * Agent personas. Declared here rather than beside `VOICES` because
 * `handleLength` is `LIMITS.mentionLength` and a `const` cannot read one
 * declared below it.
 */
export const AGENT = {
  /** Same ceiling as a person's display name. */
  nameLength: 80,
  /** Normalised by `mentionKey`, so the same ceiling a handle already has. */
  handleLength: LIMITS.mentionLength,
  /*
   * v1's `perOwner: 12` persona cap is gone (docs/AGENT_REPO.md §V2.5): agents
   * are the identity now, and the only bound on how many a person holds — and
   * so on the mention directory — is AGENT_REPO.agentsPerOwner.
   */
} as const;

/** Login codes: six digits, short-lived, few attempts. */
export const LOGIN_CODE = {
  length: 6,
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  /** Unexpired, unused codes one address may hold; the oldest retire first. */
  maxLive: 3,
  /** Per email address, per hour. */
  requestsPerHour: 6,
  /**
   * Per network (an IPv4 address or an IPv6 /64), per hour, across every
   * address asked for. Sized for a shared NAT — an office, a campus, a
   * carrier-grade NAT putting many phones behind one IPv4 — rather than for one
   * person: thirty sign-ins an hour from one address is far past any real
   * group of people using this app, and far short of what spraying codes at
   * other people's addresses, or burning their hourly allowance, needs.
   */
  requestsPerNetworkPerHour: 30,
  /**
   * Wrong guesses at a live code, per address, per day, counted once per live
   * code each was compared against, so holding several codes buys no extra
   * guesses. The five-attempt cap protects one set of codes; this protects the address from being walked through
   * fresh codes (six an hour) all day. Reaching it locks verification for the
   * address for a day, even for the right code.
   */
  verifyFailuresPerAddressPerDay: 20,
  /**
   * Verifications of any outcome, per network, per hour. Above the request
   * ceiling's 30 because one sign-in is a request plus up to five tries; far
   * below what guessing across many addresses needs.
   */
  verifiesPerNetworkPerHour: 60,
} as const;

/**
 * The waitlist form's abuse bounds. It sends mail to an address a stranger
 * typed, so both are about that: one confirmation per address per day, and a
 * per-network ceiling on submissions — lower than sign-in codes', because
 * nobody joins a waitlist ten times an hour, and sized so an office or a
 * carrier NAT is still never refused.
 */
export const WAITLIST = {
  confirmationIntervalHours: 24,
  requestsPerNetworkPerHour: 10,
} as const;

/** Password sign-in (self-hosted instances; `PASSWORD_LOGIN_ENABLED`). */
export const PASSWORD = {
  minLength: 12,
  maxLength: 256,
  /** Per network, per hour, every password attempt of any outcome. */
  attemptsPerNetworkPerHour: 60,
  /** Wrong passwords per address per day; reaching it locks password sign-in for a day. */
  failuresPerAddressPerDay: 20,
} as const;

export const SESSION_TTL_DAYS = 30;

/**
 * The versioned API prefix, and the contract version a client pins to.
 *
 * Lives here rather than in the server because it is the one string a client and
 * the server must agree on before they can agree on anything else. The server
 * mounts every `/api/*` router under this prefix as well as the unversioned one;
 * a client that pins is choosing not to be broken by a v2 it has not seen.
 */
export const API_V1 = '/api/v1';

/**
 * How a session identifies the client holding it.
 *
 * `web` is the default and the only one a cookie is ever issued for. The others
 * are bearer-token clients: they receive the session token in a response body,
 * store it in whatever the platform's secure store is, and send it as
 * `Authorization: Bearer omr_s_…`.
 */
export const SESSION_CLIENTS = ['web', 'ios', 'android', 'cli'] as const;
export type SessionClient = (typeof SESSION_CLIENTS)[number];

/** Clients that receive a token in the body instead of a cookie. */
export function isBearerClient(client: SessionClient): boolean {
  return client !== 'web';
}

/**
 * Share-by-email invitations.
 *
 * `ttlDays` bounds two things and deliberately not a third:
 *
 * - the signed link in the invitation email stops resolving, and
 * - the invitation stops skipping the waitlist (see docs/DESIGN.md §19),
 *
 * but the *grant itself never expires*. Somebody who takes a month to get round
 * to signing up still finds the radar waiting for them; what they lose is the
 * shortcut past the queue, which is a privilege over the product rather than a
 * share of one radar. Expiring the grant too would quietly change what sharing
 * means for a feature that shipped long before this one.
 */
export const INVITE = {
  ttlDays: 14,
} as const;

/** What an invitation is an invitation to. */
export const INVITE_KINDS = ['radar', 'topic'] as const;
export type InviteKind = (typeof INVITE_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What is worth interrupting somebody for.
 *
 * The set is deliberately small, and the test each one had to pass is "would a
 * person go and look because of this?". A notification stream that cries wolf
 * gets muted once and then never read again, at which point it is worse than
 * having none — so the bar is *somebody else acted on something of yours*, not
 * *something happened somewhere you can see*.
 *
 * - `comment`  — somebody remarked on a blip you wrote, or on a thread you are
 *                already in. The gap docs/DESIGN.md called the biggest one in
 *                the participation feature.
 * - `mention`  — somebody addressed you by name. The only kind that can reach
 *                a person who is neither the blip's author nor already in the
 *                thread, which is exactly the gap it was built to close, and the
 *                only kind that deliberately **never coalesces**: ten reactions
 *                on one blip is one fact, but "mentioned you 2 times" loses
 *                which two and leaves you to go and find them. It also
 *                suppresses the `comment` notification for the same person on
 *                the same comment — one act by one person is one line, and being
 *                named is the stronger of the two sentences.
 * - `reaction` — somebody put a mark on a blip you wrote.
 * - `share`    — somebody granted you access to a radar. The only kind that is
 *                about the radar rather than a blip, and the only one that can
 *                arrive before you have any settings for that radar at all.
 * - `blip`     — a blip landed in a radar. Off by default for blips a person
 *                captured, because capture is the primary action and a shared
 *                radar between two active people would otherwise emit one of
 *                these per thought. On by default only for a *webhook*
 *                delivery, which arrives from outside with nobody watching.
 * - `reply_pending` — somebody other than you (usually your own agent) wrote a
 *                reply to a client on a helpdesk you own, and it waits for your
 *                review (`docs/HELPDESK.md` §7.2). Folded per radar. The one
 *                kind besides `due` that reaches you about your own agent's act:
 *                the whole point is that the agent cannot release it itself.
 * - `decision` — an agent (or a person) asked you to decide something on a card
 *                (`request_decision`). The only kind that is *waiting on you*: it is what the
 *                "Needs you" box holds, with a mention by a person. Never folds (one per request),
 *                and is not shown once the request is answered, overtaken or its radar has comments off.
 * - `decision_answered` — the person you asked answered. Lands in the asker's own queue
 *                (an agent's, read through `list_notifications` with its session).
 * - `charter_orphaned` — a save of an Architecture charter removed the words an
 *                ADR of yours amends, so the amendment now needs re-anchoring or
 *                dismissing. Addressed to the ADR's author (the person behind an
 *                agent that wrote it), never to whoever made the save, and folded
 *                per radar while unread. Only for ADRs still proposed or accepted.
 *
 * Unconstrained in SQL, like `blips.status` and `blip_reactions.reaction`: the
 * registry validates it, so a new kind is one line here and no migration. A
 * stored kind this registry does not know renders as a neutral line rather than
 * breaking the list — the same degradation rule as an unknown lane.
 */
export const NOTIFICATION_KINDS = [
  'subscription_failed',
  'comment',
  'mention',
  'reaction',
  'share',
  'blip',
  'topic_share',
  'topic_cascade',
  'email_received',
  'due',
  'reply_pending',
  'charter_orphaned',
  'decision',
  'decision_answered',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/**
 * How a kind reads in a sentence. `one` is used when a single person did it
 * once, `many` when the notification has folded several events together.
 * `{n}` is the count and `{subject}` the thing it happened to.
 */
export const NOTIFICATION_PHRASES: Record<NotificationKind, { one: string; many: string }> = {
  subscription_failed: {
    one: 'paused outbound delivery for {subject}',
    many: 'paused outbound delivery for {subject}',
  },
  email_received: { one: 'New email in {subject}', many: 'New email in {subject}' },
  due: { one: '{subject} is due', many: '{subject} is due' },
  // A whole sentence, like `email_received`: the actor is usually the reader's
  // own agent, writing as them, and "Ada wrote a reply" read by Ada says
  // nothing true. Who drafted it is on the reply itself.
  reply_pending: {
    one: 'A reply to the client waits for your review in {subject}',
    many: '{n} replies to clients wait for your review in {subject}',
  },
  // A save of the charter took the words an ADR of yours amends. A whole sentence, and folded per
  // radar while unread: the text is on the radar's Charter, not in anyone's name.
  charter_orphaned: {
    one: 'An amendment of yours lost its words in {subject}',
    many: '{n} amendments of yours lost their words in {subject}',
  },
  decision: { one: 'asks you to decide on {subject}', many: 'asks you to decide on {subject}' },
  decision_answered: {
    one: 'answered your question on {subject}',
    many: 'answered your question on {subject}',
  },
  comment: { one: 'commented on {subject}', many: 'left {n} comments on {subject}' },
  // `many` is written but unreachable: the group key names one comment, so a
  // mention can never fold. Kept because the record is exhaustive over the kinds
  // and a hole in it would be read as an oversight rather than as a property.
  mention: { one: 'mentioned you on {subject}', many: 'mentioned you on {subject}' },
  reaction: { one: 'reacted to {subject}', many: 'left {n} reactions on {subject}' },
  share: { one: 'shared {subject} with you', many: 'shared {subject} with you' },
  blip: { one: 'added a blip to {subject}', many: 'added {n} blips to {subject}' },
  topic_share: { one: 'shared the array {subject} with you', many: 'shared {subject} with you' },
  topic_cascade: {
    one: 'turned on shared access to every radar in {subject}',
    many: 'turned on shared access to every radar in {subject}',
  },
};

/**
 * How much a person wants to hear from one radar.
 *
 * Per user *and* per radar, which is why it cannot be a column on `radars` the
 * way `commentsEnabled` and `reactionsEnabled` are. Those are properties of the
 * radar — the owner decides for everybody. This is a property of one person's
 * relationship to the radar: a noisy shared radar has to be muteable by the one
 * person it is drowning without going silent for everyone else.
 *
 * - `all`      — everything above, plus every blip captured into it by anyone.
 * - `involved` — the default. Only things aimed at you: **being mentioned by
 *                name**, a comment on your blip or in your thread, a mark on
 *                your blip, and inbound webhook deliveries if the radar or the
 *                webhook is yours.
 * - `none`     — silence. A share grant still arrives, because it is an access
 *                change rather than activity, and because it is what tells you
 *                the radar exists at all.
 *
 * **A mention respects `none`**, and that is a decision rather than an
 * oversight. It is the highest-signal event this application has, so the case
 * for letting it through is real — but `none` means what it says, and a mute a
 * colleague can defeat by typing your name is not a mute. The one exception
 * stays what it always was: an access change, which is not activity.
 */
export const RADAR_NOTIFY_LEVELS = ['all', 'involved', 'none'] as const;
export type RadarNotifyLevel = (typeof RADAR_NOTIFY_LEVELS)[number];
export const DEFAULT_RADAR_NOTIFY_LEVEL: RadarNotifyLevel = 'involved';

export const RADAR_NOTIFY_LEVEL_LABELS: Record<RadarNotifyLevel, { label: string; hint: string }> =
  {
    all: { label: 'Everything', hint: 'Every blip captured here, plus replies to you' },
    involved: {
      label: 'Involved',
      hint: 'When you are mentioned, replies to your blips and threads, and inbound deliveries',
    },
    none: {
      label: 'Nothing',
      hint: 'Silence, even if somebody mentions you — you will still be told if access changes',
    },
  };

export function isRadarNotifyLevel(value: unknown): value is RadarNotifyLevel {
  return typeof value === 'string' && (RADAR_NOTIFY_LEVELS as readonly string[]).includes(value);
}

/**
 * The two boxes of the activity list. `needs_you` is what waits on the person: open decision requests
 * and mentions by a person (a `human:` principal, or a legacy row with none recorded). `agents_reported`
 * is everything else, mostly agents saying what they did.
 */
export const NOTIFICATION_BOXES = ['needs_you', 'agents_reported'] as const;
export type NotificationBox = (typeof NOTIFICATION_BOXES)[number];

/** Decision requests (`request_decision`). */
export const DECISIONS = {
  /** The "what and why now" line a person reads first: one line, never a paragraph. */
  contextChars: 200,
  questionChars: 500,
  maxOptions: 6,
  optionChars: 80,
  answerChars: 500,
  /** Open requests one requester (a person or one agent) may have waiting at once. */
  openPerRequester: 10,
} as const;

export const NOTIFICATIONS = {
  /** How many distinct people a folded notification names before "and N others". */
  maxActors: 8,
  pageSize: 30,
  maxPageSize: 100,
  /** How many the dashboard widget shows before sending you to the full list. */
  widgetItems: 6,
  /** Snapshot lengths. A notification is a pointer, not a copy of the content. */
  subjectChars: 140,
  excerptChars: 220,
  /** Read notifications older than this are swept at boot. */
  retentionDays: 60,
  /** A push endpoint that fails this many times in a row is dropped. */
  pushFailureLimit: 5,
} as const;

/** Small pure text helpers shared by the API, the UI and the MCP tools. */

import { LIMITS } from './domain.js';

/** Lower-cased, trimmed. Used for the unique index and for code lookup. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Tags are written however the user likes ("#Side Projects") and stored in one
 * canonical form ("side-projects") so that a tag typed by a human and a tag set
 * by an agent land in the same bucket.
 */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.tagLength);
}

/** Normalised and de-duplicated, in the order written, with no cap. */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** `uniqueTags`, cut at the per-blip limit — for filters and saved queries. */
export function normalizeTags(tags: readonly string[]): string[] {
  return uniqueTags(tags).slice(0, LIMITS.tagsPerBlip);
}

/* -------------------------------------------------------------------------- */
/* Mentions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The canonical form of a mention handle.
 *
 * Deliberately the same normalisation as `normalizeTag`, with a different sigil
 * stripped: `@Ada Lovelace`, `@ada.lovelace` and `@ada_lovelace` all key to
 * `ada-lovelace`. That is what lets one lookup serve both handles a person has —
 * the local part of their email address and the slug of their display name —
 * without the parser needing to know which one was typed.
 *
 * A person who types the short form gets the short form's answer: `@ada` keys to
 * `ada`, matches only somebody whose email local part or name *is* `ada`, and is
 * ambiguous if two of them are. Ambiguity does not resolve, which is the safe
 * direction: an unresolved handle is plain text and notifies nobody.
 */
export function mentionKey(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.mentionLength);
}

/**
 * Source with code removed, so a code sample can never address somebody.
 *
 * `@media`, a decorator, an npm scope and a shell variable all live in code, and
 * a notification fired by pasting a stylesheet is precisely the sort of thing
 * that gets a notification stream muted for good. Fenced blocks go first, then
 * inline spans — the same order the renderer lifts them in, so the two agree
 * about what is code.
 */
function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * The one place the shape of a mention is defined.
 *
 * A handle must start the body or follow a space or an opening bracket. That
 * narrowness is doing two specific jobs:
 *
 * - **Email addresses are not mentions.** In "write to ada@example.com" the `@`
 *   follows a letter, so it does not match.
 * - **Neither is an `@` inside a URL.** `https://example.com/@ada` has a `/`
 *   before the `@`, and a looser rule that allowed it would let the renderer
 *   wrap part of an href in a span — corrupting the link — while the server
 *   quietly notified somebody who was never addressed.
 *
 * Exported because `packages/ui/src/lib/markdown.ts` has to match *exactly* what
 * was parsed here. Two copies of this rule would eventually disagree, and the
 * symptom would be a mention that notifies but does not render, or renders but
 * notifies nobody.
 */
export const MENTION_PATTERN = /(^|[\s(])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,63})/gu;

/**
 * Every `@handle` in a body, normalised, deduplicated, capped.
 *
 * Trailing punctuation is dropped by `mentionKey`, so "@ada." at the end of a
 * sentence still means Ada.
 *
 * This returns *handles*, not people. Turning a handle into an account is the
 * server's job and it draws only from the people who can already read the radar,
 * which is what makes a mention incapable of widening access.
 */
export function extractMentions(body: string): string[] {
  const matches = withoutCode(body).matchAll(new RegExp(MENTION_PATTERN));
  const seen = new Set<string>();
  for (const match of matches) {
    // Group 1 is the boundary character; group 2 is the handle.
    const key = mentionKey(match[2] ?? '');
    if (key) seen.add(key);
    if (seen.size >= LIMITS.mentionsPerBody) break;
  }
  return [...seen];
}

/**
 * The handles an account answers to: the local part of its email address, and
 * the slug of its display name when it has one.
 *
 * Both, rather than picking one, because a person is called different things by
 * different colleagues and there is no `handle` column to make them choose. The
 * server intersects these against what was typed; a handle that two accounts on
 * the same radar both answer to resolves to neither.
 */
export function mentionHandlesFor(user: { email: string; name?: string | null }): string[] {
  const handles = new Set<string>();
  const local = mentionKey(user.email.split('@')[0] ?? '');
  if (local) handles.add(local);
  const named = user.name ? mentionKey(user.name) : '';
  if (named) handles.add(named);
  return [...handles];
}

/**
 * The handles an *agent* answers to: its own, and its owner's qualified form.
 *
 * Two, and both are load-bearing:
 *
 * - **the bare handle** — `claude`. What anybody will actually type, and what
 *   works on a radar where only one person has an agent by that name.
 * - **the owner-qualified handle** — `ada.claude`, built from the owner's own
 *   handle. It never collides, because an owner handle is already the thing that
 *   distinguishes two people called Ada.
 *
 * There is no new resolution mechanism here and that is the point. Two people's
 * agents both answering to `claude` collide, `mentionDirectory` already maps a
 * colliding handle onto `null` — "ambiguity resolves to nothing" — and each must
 * then be named in full. Agents share one namespace with people rather than
 * getting their own, so `@ada` can never mean a person on one radar and an agent
 * on another.
 *
 * The dot is normalised away by `mentionKey`, so `@ada.claude` and
 * `@ada-claude` are the same key and somebody typing either is understood.
 */
export function agentMentionHandlesFor(
  agent: { handle: string },
  owner: { email: string; name?: string | null },
): string[] {
  const handles = new Set<string>();
  const own = mentionKey(agent.handle);
  if (!own) return [];
  handles.add(own);
  for (const ownerHandle of mentionHandlesFor(owner)) {
    const qualified = mentionKey(`${ownerHandle}.${own}`);
    if (qualified) handles.add(qualified);
  }
  return [...handles];
}

/**
 * Who a card says wrote it.
 *
 * Two names, never one plus a badge. The chrome is an instrument voice — quiet,
 * monospace, precise — so provenance is stated as a fact in the byline rather
 * than decorated with a pill or an icon:
 *
 *   persona    Claude · via Ada · 14:02
 *   principal  Ada · 14:02              (see the note below)
 *   a person   Ada · 14:02
 *
 * ## Settled 2026-08-27: delegation is invisible
 *
 * Whether an agent acting on a human's behalf — `principal` voice — is named
 * *as an agent* to other people on a shared radar was the product owner's call. **They chose
 * hidden.** An agent writing in his voice renders simply as him.
 *
 * This flag is that decision and nothing else depends on it: the row records
 * both identities unconditionally, both DTOs carry both, and this function
 * decides only what is printed. So the record is complete either way and the
 * decision stays one line, reversible, with no schema change and no migration.
 *
 * It shipped `true` while the question was open, on the asymmetry that hiding
 * later costs nothing while revealing later invalidates every belief formed in
 * the meantime. The product owner answered the underlying question rather than the
 * asymmetry: an agent acting on your behalf **is** you, in the way a letter your
 * assistant typed is still your letter, and your delegation is your own
 * business.
 *
 * **This governs `principal` voice only.** An agent writing in its *own* persona
 * is still attributed as itself — that is the branch above, and it is not
 * affected. The distinction is the whole point: speaking as itself is the agent
 * saying something; speaking as you is you saying something through it.
 */
// Annotated `boolean`: a decision recorded as a switch, not a literal the
// compiler may fold the other branch away on.
export const PRINCIPAL_VOICE_NAMES_THE_AGENT: boolean = false;

export interface Byline {
  /** The name in the larger type. */
  lead: string;
  /**
   * The person who cosigned an agent's writing, or null when a person wrote it
   * (or an agent wrote in their voice, which is them). Rendered "cosigned by …".
   */
  cosigner: string | null;
}

/**
 * Who a blip or comment reads as.
 *
 * An agent writing as itself leads with its own name, **cosigned** by the
 * person whose connection ran it — a human always stands behind an agent's
 * work (docs/AGENT_REPO.md §V2.5). An agent writing in its person's voice reads
 * as that person; the record still holds both.
 */
export function bylineFor(
  authorName: string | null,
  agentName: string | null,
  voice: 'persona' | 'principal' | null,
): Byline {
  const human = authorName?.trim() || 'Someone';
  if (!agentName || voice === null) return { lead: human, cosigner: null };
  if (voice === 'persona') return { lead: agentName, cosigner: human };
  // Principal voice: the person, and nothing else in the byline. The agent is
  // still on the row and in the byline's hover card (§V2.5).
  return { lead: human, cosigner: null };
}

/** URL-safe slug for radars and public links. Never empty — falls back to 'radar'. */
export function slugify(input: string, fallback = 'radar'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/**
 * The name after a `#`, as source for a RegExp. It needs a letter somewhere:
 * `#26` in prose is a rank or an issue number, not a tag, while `#q4` and
 * `#2026-q4` still are. The one definition, so the server's extractor and the
 * UI's linkifier cannot disagree about what a tag is.
 */
export const INLINE_TAG_NAME = String.raw`(?=[\p{N}_-]{0,47}\p{L})[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}`;

/** Pull `#tags` out of free text so capture stays keyboard-only. */
export function extractInlineTags(body: string): string[] {
  const matches = body.matchAll(new RegExp(`(?:^|\\s)#(${INLINE_TAG_NAME})`, 'gu'));
  // Every one written, uncapped: whether they fit on a blip is the writer's
  // decision to make (`blipTags` on the server), not the extractor's to hide.
  return uniqueTags([...matches].map((m) => m[1] ?? ''));
}

/**
 * The title a body implies, which is *only* a real markdown heading on its first
 * line. Deriving one from the first sentence prints the same words twice.
 *
 * Shared by `createBlip`, which stores it, and by the blip card, which has to
 * know not to render that heading again underneath the title it produced. Two
 * separate copies of this rule would eventually disagree, and the symptom would
 * be a blip with its own title printed twice.
 */
export function headingTitle(body: string): string | null {
  const match = /^#{1,6}\s+(.+)$/.exec(body.split('\n')[0] ?? '');
  const title = match?.[1]?.trim() || null;
  // A "heading" longer than any title may be is a paragraph with a `#` in front
  // of it. Stored as the title it would be a value the edit schema refuses to
  // take back; left in the body, it reads as what it is.
  return title && title.length <= LIMITS.blipTitle ? title : null;
}

/** The body with its title heading removed, when the title came from one. */
export function bodyWithoutTitleHeading(body: string, title: string | null): string {
  if (!title || headingTitle(body) !== title) return body;
  return body.split('\n').slice(1).join('\n').replace(/^\n+/, '');
}

/** An inline `#tag` token as `extractInlineTags` reads one, with its leading space. */
const INLINE_TAG = new RegExp(`(?:^|\\s)#${INLINE_TAG_NAME}(?=\\s|$)`, 'gu');

/**
 * The single URL in a body, if the body is essentially just a URL. Used to
 * derive `kind: 'link'` and to fetch an unfurl.
 *
 * Hashtags around it do not count against that: `https://example.com/a
 * #reading` is a link filed under a tag, and reading it as a note lost the
 * preview. A `#` inside the URL is a fragment, not a tag — the token needs a
 * space (or the start of the text) before it.
 */
export function soleUrl(text: string): string | null {
  const trimmed = text.replace(INLINE_TAG, ' ').trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Closing marks that are usually punctuation around a URL rather than part of it. */
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** One http(s) token. Shared so `firstUrl` and `bodyWithoutLeadUrl` cannot disagree. */
const URL_TOKEN = /https?:\/\/[^\s<>"'`]+/i;

/** Separators people put between a link and the reason they saved it. */
const SEPARATORS = /[-\u2013\u2014:|\u00b7,]+/;

/**
 * Walks trailing junk off a URL token, one character at a time.
 *
 * Sentence punctuation goes; so does an unbalanced closing bracket, so a
 * markdown link `[title](https://example.com/x)` yields the target rather than
 * the target with a paren stuck to it. A closer that *is* balanced inside the
 * URL — a Wikipedia `(disambiguation)` path — survives, which is the case that
 * makes the counting worth doing rather than just trimming every bracket.
 */
function trimUrlTail(token: string): string {
  let candidate = token;
  for (;;) {
    const last = candidate.slice(-1);
    if (/[.,;:!?]/.test(last)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      const opens = candidate.split(opener).length - 1;
      const closes = candidate.split(last).length - 1;
      if (closes > opens) {
        candidate = candidate.slice(0, -1);
        continue;
      }
    }
    return candidate;
  }
}

/** The first URL in a body, as both the text that is in it and the value it parses to. */
function matchUrl(text: string): { raw: string; url: string } | null {
  const found = URL_TOKEN.exec(text);
  if (!found) return null;
  const raw = trimUrlTail(found[0]);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { raw, url: url.toString() };
  } catch {
    return null;
  }
}

/**
 * The first http(s) URL in a body that also carries text.
 *
 * `soleUrl` is deliberately strict — a body that is *nothing but* a URL is a
 * link, and a body that merely mentions one is a note. That rule is right for a
 * stream and wrong for a reading list, where "https://… — because Ben mentioned
 * it" is a link with a note attached, not a note with a link in it. So this is
 * the looser reading, and it is reached only when the radar's template declares
 * `capture.linkFirst` (see `TemplateCapture`), never by default.
 *
 * Trailing punctuation is stripped because a URL at the end of a sentence
 * usually has some, and an unbalanced closing bracket goes too so a markdown
 * link `[title](https://example.com/x)` yields the target rather than the
 * target with a paren stuck to it. A closer that *is* balanced inside the URL —
 * a Wikipedia `(disambiguation)` path — survives, which is the case that makes
 * the counting worth doing rather than just trimming every trailing bracket.
 */
export function firstUrl(text: string): string | null {
  return matchUrl(text)?.url ?? null;
}

/**
 * The body with its leading (or trailing) URL removed, when the card is already
 * leading with that link.
 *
 * The exact sibling of `bodyWithoutTitleHeading`, and the same rule: something
 * the card has already hoisted out of the body must not then be printed again
 * underneath. On a template whose cards lead with their source, a URL pulled out
 * of the body appears in the meta row *and* in the preview card, so leaving it in
 * the prose prints it three times — and the raw URL is by far the ugliest of the
 * three.
 *
 * Only stripped at the very start or the very end of the body. A URL in the
 * middle of a sentence is part of the sentence, and cutting a hole in one to
 * save a repetition is worse than the repetition.
 */
export function bodyWithoutLeadUrl(body: string, url: string | null): string {
  if (!url) return body;
  const trimmed = body.trim();
  const found = matchUrl(trimmed);
  if (!found || found.url !== url) return body;
  if (trimmed.startsWith(found.raw)) {
    return trimmed
      .slice(found.raw.length)
      .replace(new RegExp(`^\\s*${SEPARATORS.source}\\s*`), '')
      .trim();
  }
  if (trimmed.endsWith(found.raw)) {
    return trimmed
      .slice(0, -found.raw.length)
      .replace(new RegExp(`\\s*${SEPARATORS.source}\\s*$`), '')
      .trim();
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Post-login redirects                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Paths that must never be used as a post-login destination.
 *
 * `/login` is the important one. Without it, a guard that sends an unauthenticated
 * visitor to `/login?next=<current url>` will, once the current url is itself a
 * `/login?next=...`, nest that url inside itself — re-encoding it every pass, so
 * it grows exponentially until the server rejects the request line with a 414.
 * That is not hypothetical: it is what shipped, and it made SSO unreachable.
 *
 * `/oauth/authorize` is deliberately NOT here — the MCP authorization flow
 * legitimately bounces through `/login?next=/oauth/authorize?...`.
 *
 * `/invite` is here for the same reason `/login` is: it *is* the login screen,
 * wearing an invitation, so sending somebody back to it after they have signed
 * in is the start of a loop rather than a destination.
 */
const FORBIDDEN_NEXT_PREFIXES = ['/login', '/waiting', '/invite', '/api/'];

/** Longest post-login destination worth honouring. */
export const MAX_NEXT_LENGTH = 512;

/**
 * Validates a post-login destination, returning null when it must not be used.
 *
 * Shared by the server and the SPA on purpose: a redirect target that one of
 * them accepts and the other does not is exactly how a loop starts.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (next.length > MAX_NEXT_LENGTH) return null;
  // Must be a same-origin absolute path: `/` then neither `/` nor `\`, which a browser reads
  // as a protocol-relative URL and would leave the site. Browsers also strip tab, CR and LF
  // before parsing, so `/\t/host` becomes `//host`: no control or whitespace character
  // (<= 0x20, 0x7f) is allowed anywhere, and nor is a backslash.
  if (!/^\/(?![/\\])/.test(next)) return null;
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }

  const path = next.split(/[?#]/)[0] ?? '';
  for (const prefix of FORBIDDEN_NEXT_PREFIXES) {
    if (
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      (prefix.endsWith('/') && path.startsWith(prefix))
    ) {
      return null;
    }
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/* Webhook payload templates                                                  */
/* -------------------------------------------------------------------------- */

/** Walks `a.b.0.c` through a parsed JSON payload. Returns undefined, never throws. */
function readPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** How a resolved value is written into a blip body. Objects become compact JSON. */
export function stringifyPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyPayloadValue).filter(Boolean).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Renders a `{{field.path}}` template against a webhook payload.
 *
 * This produces a *blip body* — markdown, rendered by the SPA's escape-first
 * renderer — so it introduces no new injection surface and deliberately does no
 * escaping of its own. An unknown path renders as empty rather than leaving the
 * braces visible, because a webhook body full of `{{customer.name}}` is worse
 * than one with a gap in it.
 */
export function renderPayloadTemplate(
  template: string,
  payload: unknown,
  maxLength: number = LIMITS.blipBody,
): string {
  const rendered = template.replace(/\{\{\s*([\w$.[\]-]+?)\s*\}\}/g, (_match, path: string) =>
    stringifyPayloadValue(readPath(payload, path.replace(/\[(\d+)\]/g, '.$1'))),
  );
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength - 1)}…` : rendered;
}

/**
 * Turns a wire field name ("customer_email", "customerEmail") into a readable
 * label. Sentence case, not title case: these become `**Label:** value` lines in
 * a blip body, and a column of Title Cased Labels reads like a form, not like
 * something somebody wrote.
 */
export function humanizeFieldName(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

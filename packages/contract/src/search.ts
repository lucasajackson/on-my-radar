/**
 * The universal search grammar.
 *
 * One search box, across every radar the person can read, with structured
 * filters mixed into ordinary words: `roadmap in:"On My Radar Dev" from:ada`.
 *
 * ## Why the parser lives in the contract and not in the server
 *
 * Three things have to agree about what `in:` means: the API, the MCP tool, and
 * the box the person types into. The UI does not merely send the string on — it
 * highlights the tokens as you type and offers completions for them, which means
 * it has to lex exactly what the server will lex. A second lexer in the SPA
 * would drift the first time a field was added, and the symptom would be a
 * filter that looks applied and is not. Same argument the zod schemas already
 * make for validation.
 *
 * ## Parsing is pure; resolving is not
 *
 * This file turns text into tokens and nothing else. `in:` and `from:` name
 * things whose existence is a matter of authorization, so they are resolved in
 * `services/search.ts` against `readableRadarIds` and `searchablePeople` — never
 * here, and never twice.
 *
 * ## What is deliberately *not* a filter
 *
 * - **An unknown prefix is not an error, it is a word.** `note:` is not a field,
 *   so `note: to self` searches for those words, and `https://example.com` is a
 *   URL rather than a broken `https:` filter. Only a prefix in `SEARCH_FIELDS`
 *   is ever eaten. A field that *is* known and carries a value it cannot accept
 *   — `is:blue` — is reported as a problem instead, because there the person
 *   plainly meant a filter.
 * - **`status:` (a template lane) is not in the grammar.** A lane id only means
 *   something relative to one template: `todo` is the kanban's second column and
 *   nothing at all on a reading list. Across radars there is no template to read
 *   it against, so a global `status:todo` would silently mean different things
 *   in different rows. It stays on the single-radar API where it is meaningful.
 * Structured filters support a leading minus or `not:field:value`, and `|`
 * alternatives within a token. Negation applies to the whole alternative group.
 */
import { BLIP_KINDS, BLIP_STATES, LIMITS } from './domain.js';
import { normalizeTag } from './text.js';
import { ownValue } from './own.js';
import { listWithOr } from './prose.js';
import { RADAR_TEMPLATE_IDS } from './templates.js';

/** Every prefix the lexer will treat as a filter. Anything else is a word. */
export const SEARCH_FIELDS = [
  'in',
  'topic',
  'from',
  'tag',
  'is',
  'has',
  'kind',
  'template',
  'before',
  'after',
  'touched',
  'stale',
] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * What `is:` accepts on top of the five triage states.
 *
 * `archived` / `live` are the archive, and they are on `is:` rather than a field
 * of their own for a reason: archived-ness is not a sixth triage state, it is a
 * fact about a `done` or `dropped` blip that has sat still long enough — so it
 * composes with `is:done` rather than replacing it. `in:"Board" is:archived` is
 * the whole archive screen this feature deliberately does not build.
 *
 * **The universal search shows both by default**, unlike a radar's own stream.
 * An archive you cannot find by searching is a deletion with extra steps.
 */
export const IS_VALUES = ['pinned', 'unpinned', 'archived', 'live'] as const;
export type SearchIsValue = (typeof IS_VALUES)[number];

/** What `has:` can ask about, with the spellings people actually reach for. */
export const SEARCH_HAS = ['link', 'attachment', 'comment'] as const;
export type SearchHas = (typeof SEARCH_HAS)[number];
export const isSearchHas = (value: string): value is SearchHas =>
  (SEARCH_HAS as readonly string[]).includes(value);

const HAS_ALIASES: Record<string, SearchHas> = {
  link: 'link',
  url: 'link',
  attachment: 'attachment',
  attachments: 'attachment',
  file: 'attachment',
  files: 'attachment',
  comment: 'comment',
  comments: 'comment',
  reply: 'comment',
  replies: 'comment',
};

/** A filter token, exactly as written, before anything is looked up. */
export interface SearchToken {
  field: SearchField;
  /** The value with quotes removed. */
  value: string;
  /** Alternatives in one token; omitted for the existing single-value shape. */
  values?: string[];
  /** Negates the entire token, including all alternatives. */
  negated?: boolean;
  /** The token as typed, for echoing back in a message about it. */
  raw: string;
}

/** A filter that was plainly meant and cannot be honoured. */
export interface SearchProblem {
  /** The token as typed — `is:blue`. */
  raw: string;
  /** Plain English, addressed to whoever typed it. */
  message: string;
  /**
   * For a field with a closed vocabulary (`has:`, `is:`, `kind:`) left empty or
   * given a value it does not know: every value it does take, in the order to
   * offer them. A half-typed `has:` is somebody about to choose, and this is the
   * list to choose from.
   */
  suggestions?: readonly string[];
}

/**
 * The values each closed-vocabulary field takes, for completion. `in:`,
 * `array:` and `from:` name things the caller can see, so theirs come from
 * `GET /api/search/suggest`; `tag:` is open; the date fields take dates.
 */
export const SEARCH_FIELD_VALUES = {
  has: SEARCH_HAS,
  is: [...BLIP_STATES, ...IS_VALUES],
  kind: BLIP_KINDS,
  template: RADAR_TEMPLATE_IDS,
} as const satisfies Partial<Record<SearchField, readonly string[]>>;

type ClosedField = keyof typeof SEARCH_FIELD_VALUES;
const isClosedField = (field: SearchField): field is ClosedField =>
  Object.prototype.hasOwnProperty.call(SEARCH_FIELD_VALUES, field);

export interface ParsedSearch {
  /** Everything that was not a filter, rejoined — fed to `websearch_to_tsquery`. */
  text: string;
  tokens: SearchToken[];
  problems: SearchProblem[];
}

/**
 * One token: either `word`, `"quoted words"`, or `field:value` where the value
 * may itself be quoted (`in:"On My Radar Dev"`).
 *
 * Written as a scanner rather than a regex because a quoted value containing a
 * colon (`in:"9:30 standup"`) has to survive, and the leading `-` that
 * `websearch_to_tsquery` reads as exclusion has to be passed through untouched.
 */
interface RawToken {
  prefix: string | null;
  values: string[];
  raw: string;
  negated: boolean;
  invalidNot: boolean;
}

function scan(input: string): RawToken[] {
  const out: RawToken[] = [];
  let index = 0;
  while (index < input.length) {
    if (/\s/.test(input.charAt(index))) {
      index++;
      continue;
    }
    const start = index;
    let quoted = false;
    while (index < input.length) {
      const char = input.charAt(index);
      if (char === '"') quoted = !quoted;
      if (!quoted && /\s/.test(char)) break;
      index++;
    }
    const raw = input.slice(start, index);
    let rest = raw;
    let negated = false;
    if (rest.startsWith('-')) {
      negated = true;
      rest = rest.slice(1);
    }
    const not = /^not:/i.test(rest);
    if (not) {
      negated = true;
      rest = rest.slice(4);
    }
    const match = /^([a-z]+):/i.exec(rest);
    // `array:` is the current name for `topic:`; both mean the same filter.
    const typed = match?.[1]?.toLowerCase() ?? null;
    const prefix = typed === 'array' ? 'topic' : typed;
    const value = match ? rest.slice(match[0].length) : rest;
    const values: string[] = [];
    let part = '';
    quoted = false;
    for (const char of value) {
      if (char === '"') {
        quoted = !quoted;
        continue;
      }
      if (char === '|' && !quoted) {
        values.push(part);
        part = '';
      } else part += char;
    }
    values.push(part);
    out.push({ prefix, values, raw, negated, invalidNot: not && !isField(prefix) });
  }
  return out;
}

/** Completion uses the same quote-aware scanner as execution, including negative/OR tokens. */
export function pendingSearchFilter(
  input: string,
  caret: number,
): {
  field: 'in' | 'topic' | 'from';
  typed: string;
  replacementStart: number;
} | null {
  const upto = input.slice(0, caret);
  const token = scan(upto).at(-1);
  if (!token || !upto.endsWith(token.raw) || !['in', 'topic', 'from'].includes(token.prefix ?? ''))
    return null;
  const match = /^(-?(?:not:)?)(in|array|topic|from):/i.exec(token.raw);
  if (!match) return null;
  let start = match[0].length;
  let quoted = false;
  for (let index = start; index < token.raw.length; index++) {
    const char = token.raw[index];
    if (char === '"') quoted = !quoted;
    if (char === '|' && !quoted) start = index + 1;
  }
  return {
    field: token.prefix as 'in' | 'topic' | 'from',
    typed: token.raw.slice(start).replace(/^"/, ''),
    replacementStart: upto.length - token.raw.length + start,
  };
}

/**
 * A closed-vocabulary filter the caret is in the middle of, and what it could
 * become — the `has:` / `is:` / `kind:` counterpart of `pendingSearchFilter`,
 * which does the fields whose values are the caller's own radars and people.
 * `options` are the field's values that start with what has been typed, in
 * registry order; empty when nothing matches.
 */
export function pendingClosedFilter(
  input: string,
  caret: number,
): {
  field: ClosedField;
  typed: string;
  replacementStart: number;
  options: readonly string[];
} | null {
  const upto = input.slice(0, caret);
  const match = /(?:^|\s)(-?(?:not:)?)(has|is|kind|template):([^\s|"]*\|)*([^\s|"]*)$/i.exec(upto);
  if (!match) return null;
  const named = (match[2] ?? '').toLowerCase();
  const field = (['has', 'is', 'kind', 'template'] as const).find((key) => key === named);
  if (!field) return null;
  const typed = match[4] ?? '';
  return {
    field,
    typed,
    replacementStart: upto.length - typed.length,
    options: SEARCH_FIELD_VALUES[field].filter((value) => value.startsWith(typed.toLowerCase())),
  };
}

function isField(prefix: string | null): prefix is SearchField {
  return prefix !== null && (SEARCH_FIELDS as readonly string[]).includes(prefix);
}

/**
 * A date bound. Accepts an absolute day, month or year, or a relative span
 * counted back from now: `7d`, `2w`, `3m`, `1y`, plus `today` and `yesterday`.
 *
 * **UTC, always.** A bound in the reader's local zone would need that zone
 * carried on every transport, and an MCP client has none to send — so it would
 * be one meaning in the browser and another for an agent, which is exactly the
 * divergence the shared service layer exists to prevent. Stated in the help text
 * rather than left to be discovered.
 *
 * Returns an ISO instant, or null when the value is not a date at all.
 */
export function parseSearchDate(value: string, now: Date = new Date()): string | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;

  if (text === 'today') {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
  }
  if (text === 'yesterday') {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    ).toISOString();
  }

  const relative = /^(\d{1,4})([dwmy])$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const date = new Date(now.getTime());
    if (unit === 'd') date.setUTCDate(date.getUTCDate() - amount);
    else if (unit === 'w') date.setUTCDate(date.getUTCDate() - amount * 7);
    else if (unit === 'm') date.setUTCMonth(date.getUTCMonth() - amount);
    else date.setUTCFullYear(date.getUTCFullYear() - amount);
    // `after:2026y` reaches year 0 or before it, which Postgres will not take
    // as a timestamptz; it is not a date anyone meant.
    if (date.getUTCFullYear() < 1) return null;
    return date.toISOString();
  }

  const absolute = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text);
  if (absolute) {
    const year = Number(absolute[1]);
    const month = absolute[2] ? Number(absolute[2]) - 1 : 0;
    const day = absolute[3] ? Number(absolute[3]) : 1;
    if (year < 1 || month < 0 || month > 11 || day < 1 || day > 31) return null;
    // Field by field: `Date.UTC` reads years 0–99 as 1900–1999, so `before:0050`
    // would quietly mean 1950.
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    // Rejects 2026-02-31, which JS would otherwise roll forward into March.
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
    return date.toISOString();
  }

  return null;
}

/**
 * Turn what somebody typed into free text plus filter tokens.
 *
 * `now` is injectable so the relative bounds are testable without waiting.
 */
export function parseSearchQuery(input: string, now: Date = new Date()): ParsedSearch {
  const tokens: SearchToken[] = [];
  const problems: SearchProblem[] = [];
  const words: string[] = [];

  const fieldCounts = new Map<SearchField, number>();
  for (const token of scan(input)) {
    if (token.invalidNot) {
      problems.push({ raw: token.raw, message: 'Use not:field:value, for example not:tag:bug.' });
      continue;
    }
    if (!isField(token.prefix)) {
      if (token.raw) words.push(token.raw);
      continue;
    }
    const field = token.prefix;
    const count = (fieldCounts.get(field) ?? 0) + 1;
    fieldCounts.set(field, count);
    if (count > LIMITS.searchFiltersPerField) {
      problems.push({
        raw: token.raw,
        message: `Use at most ${LIMITS.searchFiltersPerField} ${field}: filters. No filters were ignored.`,
      });
      continue;
    }
    if (token.values.length > LIMITS.searchFiltersPerField) {
      problems.push({
        raw: token.raw,
        message: `Use at most ${LIMITS.searchFiltersPerField} alternatives in one filter.`,
      });
      continue;
    }
    const values: string[] = [];
    const beforeProblems = problems.length;
    for (const part of token.values) {
      const value = part.trim();
      if (!value) {
        problems.push({
          raw: token.raw,
          message: isClosedField(field)
            ? `${field}: takes ${listWithOr(SEARCH_FIELD_VALUES[field])}.`
            : `${field}: needs something after the colon and each |.`,
          ...(isClosedField(field) ? { suggestions: SEARCH_FIELD_VALUES[field] } : {}),
        });
        continue;
      }
      if (value.length > LIMITS.searchValue) {
        problems.push({
          raw: token.raw,
          message: `Filter values must be at most ${LIMITS.searchValue} characters.`,
        });
        continue;
      }
      switch (field) {
        case 'is': {
          const lowered = value.toLowerCase();
          if (
            !(IS_VALUES as readonly string[]).includes(lowered) &&
            !(BLIP_STATES as readonly string[]).includes(lowered)
          ) {
            problems.push({
              raw: token.raw,
              message:
                `is:${value} is not a state. Try ` +
                // One list, one "or", at the end. Joining `IS_VALUES` with " or "
                // produced "pinned or unpinned or archived or live", which reads
                // like four alternatives to a sentence rather than one list.
                `${listWithOr([...BLIP_STATES, ...IS_VALUES])}.`,
              suggestions: SEARCH_FIELD_VALUES.is,
            });
            continue;
          }
          values.push(lowered);
          continue;
        }
        case 'has': {
          const resolved = ownValue(HAS_ALIASES, value.toLowerCase());
          if (!resolved) {
            problems.push({
              raw: token.raw,
              message: `has:${value} is not something a blip can have. Try link, attachment or comment.`,
              suggestions: SEARCH_FIELD_VALUES.has,
            });
            continue;
          }
          values.push(resolved);
          continue;
        }
        case 'kind': {
          const lowered = value.toLowerCase();
          if (!(BLIP_KINDS as readonly string[]).includes(lowered)) {
            problems.push({
              raw: token.raw,
              message: `kind:${value} is not a kind of blip. Try ${BLIP_KINDS.join(', ')}.`,
              suggestions: SEARCH_FIELD_VALUES.kind,
            });
            continue;
          }
          values.push(lowered);
          continue;
        }
        case 'template': {
          // A radar-level filter over a closed vocabulary, validated against
          // the registry like `kind:` — so `template:blue` is reported, never
          // searched for as a word. It finds every radar of a shape across
          // topics (every helpdesk, say), which is what a cross-project view
          // needs and what a hand-kept radar list would drift from.
          const lowered = value.toLowerCase();
          if (!(RADAR_TEMPLATE_IDS as readonly string[]).includes(lowered)) {
            problems.push({
              raw: token.raw,
              message: `template:${value} is not a radar template. Try ${listWithOr(RADAR_TEMPLATE_IDS)}.`,
              suggestions: SEARCH_FIELD_VALUES.template,
            });
            continue;
          }
          values.push(lowered);
          continue;
        }
        case 'before':
        case 'after':
        case 'touched':
        case 'stale': {
          if (parseSearchDate(value, now) === null) {
            problems.push({
              raw: token.raw,
              message: `${field}:${value} is not a date. Try 2026-08-01, or a span back from now like 7d, 2w, 3m.`,
            });
            continue;
          }
          values.push(value);
          continue;
        }
        case 'tag': {
          const tag = normalizeTag(value);
          if (!tag) {
            problems.push({ raw: token.raw, message: `tag:${value} is not a usable tag.` });
            continue;
          }
          values.push(tag);
          continue;
        }
        default: {
          // `in:` and `from:` name things. Whether they name anything *this person*
          // can see is a question for the service layer, not for a lexer.
          values.push(value);
          continue;
        }
      }
    }
    if (problems.length === beforeProblems && values.length)
      tokens.push({
        field,
        value: values.join('|'),
        raw: token.raw,
        ...(values.length > 1 ? { values } : {}),
        ...(token.negated ? { negated: true } : {}),
      });
  }

  return { text: words.join(' ').trim(), tokens, problems };
}

/** Every token for one field, in the order they were written. */
export function tokensFor(parsed: ParsedSearch, field: SearchField): string[] {
  return parsed.tokens.filter((token) => token.field === field).map((token) => token.value);
}

/* ------------------------------- help text ------------------------------- */

/**
 * One line per field, shown under the box and repeated verbatim in the MCP tool
 * description. Written once so the two cannot disagree about what the grammar is.
 */
export const SEARCH_HELP: ReadonlyArray<{ field: SearchField; example: string; says: string }> = [
  { field: 'in', example: 'in:"Design notes"', says: 'only that radar — name, slug or id' },
  {
    field: 'topic',
    example: 'array:"Product work"',
    says: 'current radars in a readable array (topic: works too)',
  },
  {
    field: 'touched',
    example: 'touched:7d',
    says: 'edited or received a new comment since this date/span',
  },
  { field: 'stale', example: 'stale:30d', says: 'no edits or new comments since this date/span' },
  { field: 'from', example: 'from:lucas', says: 'only what that person captured' },
  { field: 'tag', example: 'tag:bug', says: 'only blips carrying the tag' },
  {
    field: 'is',
    example: 'is:active',
    says: 'triage state, pinned / unpinned, or archived / live',
  },
  { field: 'has', example: 'has:link', says: 'link, attachment or comment' },
  { field: 'kind', example: 'kind:essay', says: 'what sort of blip it is' },
  {
    field: 'template',
    example: 'template:helpdesk',
    says: 'only radars on that template, across every array',
  },
  { field: 'after', example: 'after:7d', says: 'captured since — a date or a span' },
  { field: 'before', example: 'before:2026-01-01', says: 'captured before that instant (UTC)' },
];

/** Compatibility rules shared by visible query interpretation and every transport. */
export const SEARCH_COMBINATION_RULES = [
  'Positive in/array/from/kind/template filters and triage-state is: filters union repeated values.',
  'Repeated tag: and has: filters intersect; | means alternatives within one token.',
  'Pin, archive and date/activity bounds use the last positive token for each axis.',
  'Negative filters intersect and exclude the entire | alternative group.',
  'Different filter axes intersect. Free-text OR applies only to words, not structured filters.',
] as const;

/**
 * The grammar as one paragraph, for a tool description. The combination rules are left out:
 * every search result carries them as `combinationRules`.
 */
export function searchGrammarSummary(): string {
  return (
    SEARCH_HELP.map((row) => `${row.example} — ${row.says}`).join('; ') +
    '; use | for alternatives (tag:bug|techdebt); -tag:bug or not:tag:bug excludes a filter.'
  );
}

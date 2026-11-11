/**
 * Universal search: one box, every radar the person can read.
 *
 * ## The whole security argument, in three sentences
 *
 * The set of rows this can ever return is `readableRadarIds(actor)` — the same
 * function the sidebar, the tag page and every smart radar resolve against, and
 * the one place the topic cascade is read. Every filter **narrows** that set and
 * none can widen it: `in:` intersects, exactly as `resolveRadarScope` intersects
 * a smart radar's saved `radarIds`, and `from:` can only name somebody who is
 * already a reader of a radar in it. There is no second authorization path here
 * because there is no authorization decision here — this file composes filters
 * and hands them to `listBlips`.
 *
 * That is deliberately boring, and the boredom is the point. A search that
 * leaks one blip title from a radar somebody cannot open is the worst bug this
 * application could have, and the way that bug gets written is by a search
 * growing its own idea of who may see what.
 *
 * ## Naming something you cannot see
 *
 * `in:` and `from:` name things, so they are also a way to *ask about* things.
 * The answer is the same shape as `requireRadar`'s 404: a radar you may not read
 * and a radar that does not exist are reported identically — "matched no radar
 * you can read" — because a message that distinguished them would confirm the
 * existence of an id, which is itself the disclosure. The same goes for a
 * person: `from:` is resolved against the people who share a radar with you, and
 * anybody else simply does not match.
 *
 * ## An unmatched filter returns nothing, and says so
 *
 * If `in:desgin` matches nothing, the query is **not** run with that filter
 * quietly dropped. It returns an empty page with `unresolved: true` and the
 * token echoed back. Silently returning everything is how somebody comes to
 * believe a search proved something it never tested — and an empty result that
 * reads as "nothing matches your words" when it means "your filter is a typo" is
 * the same failure wearing a nicer coat.
 */
import { createHash } from 'node:crypto';
import { and, inArray, sql } from 'drizzle-orm';
import {
  SEARCH_COMBINATION_RULES,
  SEARCH_HAS,
  isSearchHas,
  parseSearchDate,
  parseSearchQuery,
  type SearchFilterDto,
  type SearchPersonDto,
  type SearchQueryInput,
  type SearchResultDto,
  type SmartFilter,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { badRequest, type Actor } from '../http.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  readableRadarIdsFor,
  readableTopicQuery,
  readersOfRadars,
  requireRadar,
  topicsWithheld,
} from './access.js';
import {
  buildBlipFilterClauses,
  listBlips,
  resolveRadarScope,
  type SearchFilters,
  type SearchFilterGroup,
  type SearchPredicate,
  type BlipScope,
} from './blips.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A radar the caller can reach, as far as name resolution is concerned. */
interface NameableRadar {
  id: string;
  name: string;
  slug: string;
  kind: string;
  topicId?: string | null;
  template?: string;
}

/**
 * The radars this person can search in: everything `readableRadarIds` allows,
 * minus the smart ones.
 *
 * A smart radar holds no rows of its own — it is a saved query over the very
 * radars already in this list — so including it would add scan cost and could
 * not add a result. Exactly the reasoning `resolveRadarScope` already applies.
 */
async function searchableRadars(actor: Actor): Promise<NameableRadar[]> {
  const ids = await readableRadarIdsFor(actor);
  if (ids.length === 0) return [];
  return getDb()
    .select({
      id: schema.radars.id,
      name: schema.radars.name,
      slug: schema.radars.slug,
      kind: schema.radars.kind,
      topicId: schema.radars.topicId,
      template: schema.radars.template,
    })
    .from(schema.radars)
    .where(inArray(schema.radars.id, ids));
}

/**
 * Which radars an `in:` value names.
 *
 * Three passes, narrowest first: an exact id, then an exact name or slug
 * (case-insensitive), then a substring of the name. The substring pass returns
 * **every** match rather than refusing an ambiguous one — `in:design` meaning
 * both "Design notes" and "Design system" is a reasonable thing to want, and a
 * search box that refuses to search is worse than one that searches a little
 * wide and says which radars it used.
 */
function matchRadars(value: string, radars: NameableRadar[]): NameableRadar[] {
  const needle = value.trim().toLowerCase();
  if (!needle) return [];

  if (UUID.test(needle)) {
    return radars.filter((radar) => radar.id.toLowerCase() === needle);
  }

  const exact = radars.filter(
    (radar) => radar.name.toLowerCase() === needle || radar.slug.toLowerCase() === needle,
  );
  if (exact.length > 0) return exact;

  return radars.filter(
    (radar) =>
      radar.name.toLowerCase().includes(needle) || radar.slug.toLowerCase().includes(needle),
  );
}

/** Which people a `from:` value names, out of those the caller shares a radar with. */
function matchPeople(value: string, people: SearchPersonDto[]): SearchPersonDto[] {
  const needle = value.trim().toLowerCase();
  if (!needle) return [];

  if (UUID.test(needle)) return people.filter((person) => person.id.toLowerCase() === needle);

  const exact = people.filter(
    (person) =>
      person.email.toLowerCase() === needle || (person.name ?? '').toLowerCase() === needle,
  );
  if (exact.length > 0) return exact;

  return people.filter(
    (person) =>
      person.email.toLowerCase().includes(needle) ||
      (person.name ?? '').toLowerCase().includes(needle),
  );
}

/**
 * Everybody a `from:` may legally name: the readers of the radars this person
 * can read.
 *
 * Composed rather than queried — `readersOfRadars(readableRadarIds(me))` — so
 * the candidate list cannot drift from the access rules, and a change to how the
 * cascade grants reading changes this in the same commit by construction.
 * Also the endpoint behind the UI's `from:` completions, which is why it exists
 * as its own exported call.
 */
export async function searchPeople(actor: Actor): Promise<SearchPersonDto[]> {
  const ids = await readableRadarIdsFor(actor);
  const readers = await readersOfRadars(ids);
  return readers
    .map((reader) => ({ id: reader.id, name: reader.name, email: reader.email }))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** The radars a `in:` completion may offer. Names only — never a count or a member. */
export async function searchRadarNames(
  actor: Actor,
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const radars = await searchableRadars(actor);
  return radars
    .map(({ id, name, slug }) => ({ id, name, slug }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Names only, resolved through current topic ownership/membership. */
export async function searchTopicNames(
  actor: Actor,
): Promise<Array<{ id: string; name: string; slug: string }>> {
  if (await topicsWithheld(actor)) return [];
  return getDb()
    .select({ id: schema.topics.id, name: schema.topics.name, slug: schema.topics.slug })
    .from(schema.topics)
    .where(inArray(schema.topics.id, readableTopicQuery(actor.user.id)))
    .orderBy(schema.topics.name);
}

/**
 * Explicit scope supplied by MCP. REST can carry the same exact radar scope
 * in searchSchema; these transport options take precedence when both exist.
 *
 * `radarId` is resolved through `requireRadar` and `resolveRadarScope`, not by
 * name matching — so it keeps working for a smart radar, whose scope is a
 * resolved query rather than a container. `in:` then intersects further, which
 * is the same rule as everywhere else: naming can only narrow.
 */
export interface SearchScopeOptions {
  radarId?: string;
  /** A template lane. Meaningful only alongside `radarId`; see search.ts's header. */
  status?: string;
}

/** New search cursors anchor relative dates. Cursors from older releases still work. */
function searchClock(cursor?: string): Date {
  if (!cursor) return new Date();
  const decoded = decodeCursor(cursor);
  if (!decoded) throw badRequest('Invalid cursor');
  if (decoded['searchAt'] === undefined && decoded['searchKey'] === undefined) return new Date();
  if (
    typeof decoded['searchAt'] !== 'string' ||
    typeof decoded['searchKey'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(decoded['searchKey'])
  )
    throw badRequest('Invalid search cursor');
  const clock = new Date(decoded['searchAt']);
  if (!Number.isFinite(clock.getTime()) || clock.toISOString() !== decoded['searchAt'])
    throw badRequest('Invalid search cursor date');
  return clock;
}

/** Resolve once so list pages and aggregates share access and relative-date cutoffs. */
export async function resolveSearchQuery(
  actor: Actor,
  input: SearchQueryInput,
  options: SearchScopeOptions = {},
) {
  const now = searchClock(input.cursor);
  const parsed = parseSearchQuery(input.q ?? '', now);
  const filterDtos: SearchFilterDto[] = [];
  const problems = [...parsed.problems];
  const radars = await searchableRadars(actor);
  let radarIds = radars.map((radar) => radar.id);
  let saved: SmartFilter | null = null;
  const scopedRadarId = options.radarId ?? input.radarId;
  if (scopedRadarId) {
    const access = await requireRadar(scopedRadarId, actor, 'read');
    const scope = await resolveRadarScope(access, actor);
    const allowed = new Set(scope.radarIds);
    radarIds = radarIds.filter((id) => allowed.has(id));
    saved = scope.saved;
    filterDtos.push({
      field: 'in',
      raw: `in:${access.radar.name}`,
      resolved: true,
      label: access.radar.name,
    });
  }
  let preferredRadar: { id: string; name: string } | undefined;
  let preferredScope: BlipScope | undefined;
  if (input.preferRadarId) {
    const access = await requireRadar(input.preferRadarId, actor, 'read');
    preferredRadar = { id: access.radar.id, name: access.radar.name };
    preferredScope = await resolveRadarScope(access, actor);
  }
  const search: SearchFilters = { groups: [] };
  // Retain existing repeated-token behavior; explicit | is OR inside a token.
  // Negative groups always intersect and never replace positive bounds.
  const unions = new Map<string, SearchFilterGroup>();
  const lastBounds = new Map<string, SearchFilterGroup>();
  let people: SearchPersonDto[] | undefined;
  let topics: Array<{ id: string; name: string; slug: string }> | undefined;
  for (const token of parsed.tokens) {
    const any: SearchPredicate[] = [];
    const labels: string[] = [];
    const priorProblems = problems.length;
    for (const value of token.values ?? [token.value]) {
      switch (token.field) {
        case 'in': {
          const matched = matchRadars(value, radars);
          const standard = matched.filter((radar) => radar.kind !== 'smart');
          if (!standard.length) {
            problems.push({
              raw: token.raw,
              message: matched.length
                ? `${token.raw} names a smart radar — a saved search, not a container. Use radarId or preferRadarId to apply its saved filter.`
                : `${token.raw} matched no radar you can read.`,
            });
            break;
          }
          any.push({ field: 'radar', values: standard.map((radar) => radar.id).sort() });
          labels.push(...standard.map((radar) => radar.name));
          break;
        }
        case 'topic': {
          topics ??= await searchTopicNames(actor);
          const matched = matchRadars(
            value,
            topics.map((topic) => ({ ...topic, kind: 'standard' })),
          );
          if (!matched.length) {
            problems.push({
              raw: token.raw,
              message: `${token.raw} matched no array you can read.`,
            });
            break;
          }
          any.push({ field: 'topic', values: matched.map((topic) => topic.id).sort() });
          labels.push(...matched.map((topic) => topic.name));
          break;
        }
        case 'template': {
          // Resolved against nothing: the grammar already refused an unknown
          // id, and the set it narrows is `readableRadarIds`, so naming a
          // template can only ever find radars the caller could already read.
          any.push({ field: 'template', values: [value] });
          labels.push(value);
          break;
        }
        case 'from': {
          people ??= await searchPeople(actor);
          const matched = matchPeople(value, people);
          if (!matched.length) {
            problems.push({
              raw: token.raw,
              message: `${token.raw} matched nobody you share a radar with.`,
            });
            break;
          }
          any.push({ field: 'author', values: matched.map((person) => person.id).sort() });
          labels.push(...matched.map((person) => person.name ?? person.email));
          break;
        }
        case 'is':
          if (value === 'pinned' || value === 'unpinned')
            any.push({ field: 'pinned', value: value === 'pinned' });
          else if (value === 'archived' || value === 'live')
            any.push({ field: 'archived', value: value === 'archived' });
          else any.push({ field: 'state', value });
          labels.push(value);
          break;
        case 'before':
        case 'after':
        case 'touched':
        case 'stale': {
          const instant = parseSearchDate(value, now);
          if (!instant) {
            problems.push({ raw: token.raw, message: 'Invalid date bound.' });
            break;
          }
          any.push({ field: token.field, value: instant });
          labels.push(instant);
          break;
        }
        case 'has':
          if (!isSearchHas(value)) {
            problems.push({
              raw: token.raw,
              message: `has:${value} is not something a blip can have. Try ${SEARCH_HAS.join(', ')}.`,
            });
            break;
          }
          any.push({ field: 'has', value });
          labels.push(value);
          break;
        default:
          any.push({ field: token.field, value });
          labels.push(token.field === 'tag' ? `#${value}` : value);
          break;
      }
    }
    const resolved = problems.length === priorProblems;
    filterDtos.push({
      field: token.field,
      raw: token.raw,
      resolved,
      label: resolved ? `${token.negated ? 'Not ' : ''}${[...new Set(labels)].join(' or ')}` : null,
    });
    if (!resolved) continue;
    const group: SearchFilterGroup = { any, negated: token.negated ?? false };
    const fields = new Set(any.map((predicate) => predicate.field));
    const oneField = fields.size === 1 ? any[0]?.field : undefined;
    if (
      !group.negated &&
      oneField &&
      ['radar', 'author', 'topic', 'template', 'kind', 'state'].includes(oneField)
    ) {
      const previous = unions.get(oneField);
      if (previous) previous.any.push(...any);
      else {
        unions.set(oneField, group);
        search.groups.push(group);
      }
    } else if (
      !group.negated &&
      oneField &&
      ['pinned', 'archived', 'after', 'before', 'touched', 'stale'].includes(oneField)
    ) {
      const previous = lastBounds.get(oneField);
      if (previous) previous.any = any;
      else {
        lastBounds.set(oneField, group);
        search.groups.push(group);
      }
    } else search.groups.push(group);
  }
  // Cheap radar-only narrowing preserves corpus counts and avoids testing unrelated rows.
  for (const group of search.groups) {
    if (group.any.every((predicate) => predicate.field === 'radar')) {
      const chosen = new Set(
        group.any.flatMap((predicate) => (predicate.field === 'radar' ? predicate.values : [])),
      );
      radarIds = radarIds.filter((id) => (group.negated ? !chosen.has(id) : chosen.has(id)));
    }
  }
  for (const group of search.groups) {
    if (group.any.every((predicate) => predicate.field === 'topic')) {
      const chosen = new Set(
        group.any.flatMap((predicate) => (predicate.field === 'topic' ? predicate.values : [])),
      );
      const members = new Set(
        radars
          .filter((radar) => radar.topicId && chosen.has(radar.topicId))
          .map((radar) => radar.id),
      );
      radarIds = radarIds.filter((id) => (group.negated ? !members.has(id) : members.has(id)));
    }
  }
  for (const group of search.groups) {
    if (group.any.every((predicate) => predicate.field === 'template')) {
      const chosen = new Set(
        group.any.flatMap((predicate) => (predicate.field === 'template' ? predicate.values : [])),
      );
      const matching = new Set(
        radars.filter((radar) => radar.template && chosen.has(radar.template)).map((r) => r.id),
      );
      radarIds = radarIds.filter((id) => (group.negated ? !matching.has(id) : matching.has(id)));
    }
  }
  const unresolved = problems.length > 0;
  const metadata: Omit<SearchResultDto, 'items' | 'nextCursor' | 'preferredBlipIds'> = {
    text: parsed.text,
    combinationRules: SEARCH_COMBINATION_RULES,
    filters: filterDtos,
    problems,
    unresolved,
    ranking: parsed.text ? 'relevance' : 'recent',
    radarsSearched: unresolved ? 0 : radarIds.length,
    ...(preferredRadar ? { preferredRadar } : {}),
  };
  const query = {
    ...(parsed.text ? { q: parsed.text } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
  return {
    radarIds,
    saved,
    query,
    search,
    metadata,
    preferredScope,
    resolvedAt: now.toISOString(),
  };
}

export async function searchBlips(
  actor: Actor,
  input: SearchQueryInput,
  options: SearchScopeOptions = {},
): Promise<SearchResultDto> {
  return executeResolvedSearch(
    actor,
    input,
    await resolveSearchQuery(actor, input, options),
    options,
  );
}

export type ResolvedSearch = Awaited<ReturnType<typeof resolveSearchQuery>>;
/** Reuse one resolution for a dashboard list, aggregate total, and anchored cursor. */
export async function executeResolvedSearch(
  actor: Actor,
  input: SearchQueryInput,
  resolved: ResolvedSearch,
  options: SearchScopeOptions = {},
): Promise<SearchResultDto> {
  const { radarIds, saved, query, search, metadata, preferredScope } = resolved;
  const searchKey = createHash('sha256')
    .update(
      JSON.stringify({
        actor: actor.user.id,
        q: input.q?.trim() ?? '',
        scopedRadarId: options.radarId ?? input.radarId ?? null,
        radarIds: [...radarIds].sort(),
        saved,
        status: options.status ?? null,
        preferredRadarId: metadata.preferredRadar?.id ?? null,
        preferredScope: preferredScope
          ? { ...preferredScope, radarIds: [...preferredScope.radarIds].sort() }
          : null,
        search,
        resolvedAt: resolved.resolvedAt,
      }),
    )
    .digest('hex');
  const previous = input.cursor ? decodeCursor(input.cursor) : null;
  if (previous?.['searchKey'] !== undefined && previous['searchKey'] !== searchKey)
    throw badRequest('Search context changed. Start again from the first page.');
  if (metadata.unresolved || radarIds.length === 0)
    return {
      ...metadata,
      items: [],
      nextCursor: null,
      ...(input.cursor === undefined ? { total: 0 } : {}),
      ...(metadata.preferredRadar ? { preferredBlipIds: [] } : {}),
    };
  /*
    How many match, not how many were looked through: the header said "N blips"
    from the corpus size, which is the one number a search result must not
    show. Counted once, with the first page, over exactly the clauses the page
    applies — later pages do not re-count a number that cannot have meant more.
  */
  const total =
    input.cursor === undefined
      ? ((
          await getDb()
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.blips)
            .where(and(...buildBlipFilterClauses(radarIds, query, saved, search)))
        )[0]?.n ?? 0)
      : undefined;
  const page = await listBlips(radarIds, query, saved, actor.user.id, null, {
    agentId: actor.agent?.agentId ?? null,
    search,
    relevance: true,
    ...(preferredScope
      ? {
          priority: {
            ...preferredScope,
            key: createHash('sha256')
              .update(
                JSON.stringify({
                  query: input.q?.trim() ?? '',
                  actor: actor.user.id,
                  radarIds: [...radarIds].sort(),
                  saved,
                  status: options.status ?? null,
                  preferredRadarId: metadata.preferredRadar?.id ?? null,
                  preferredRadarIds: [...preferredScope.radarIds].sort(),
                  preferredSaved: preferredScope.saved,
                }),
              )
              .digest('hex'),
          },
        }
      : {}),
  });
  if (page.nextCursor) {
    const boundary = decodeCursor(page.nextCursor);
    if (!boundary) throw new Error('Generated search cursor could not be decoded');
    page.nextCursor = encodeCursor({ ...boundary, searchAt: resolved.resolvedAt, searchKey });
  }
  return { ...metadata, ...page, ...(total === undefined ? {} : { total }) };
}

/**
 * How many blips are within reach of a search at all — shown on the empty
 * search screen so the box says what it is about to look through.
 *
 * A count, never a list. It is derived from the same readable set as everything
 * else here, so it can never describe rows a search would not return.
 */
export async function searchCorpusSize(actor: Actor): Promise<{ radars: number; blips: number }> {
  const radars = await searchableRadars(actor);
  if (radars.length === 0) return { radars: 0, blips: 0 };
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.blips)
    .where(
      inArray(
        schema.blips.radarId,
        radars.map((radar) => radar.id),
      ),
    );
  return { radars: radars.length, blips: row?.total ?? 0 };
}

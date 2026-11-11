/**
 * Universal search: the grammar, and the proof it cannot leak.
 *
 * Two halves, deliberately in one file. The grammar half is pure and always
 * runs; the authorization half needs a real Postgres and skips without one, like
 * every other suite here.
 *
 * The properties that decide whether this is safe to ship:
 *
 * - **A blip in a radar you cannot read is unreachable by every route into it.**
 *   Not "does not normally appear" — unreachable by the words in its body, by
 *   its tag, by its author, and by naming its radar's id outright. A search is
 *   the one surface where a person supplies the predicate, so it has to be tried
 *   from every direction rather than trusted once.
 * - **Naming is not an oracle.** `in:<uuid of a radar somebody else owns>` and
 *   `in:<uuid that has never existed>` must produce byte-identical answers. If
 *   they differ at all, the search box is a way to test whether an id is real,
 *   which is exactly the disclosure `requireRadar`'s 404-not-403 rule exists to
 *   prevent — reintroduced through a different door.
 * - **The `from:` candidate list is a composition, not a copy.** It is asserted
 *   equal to the union of `radarReaders` over `readableRadarIds`, because that
 *   equality is the whole reason a second query for "who may I name" is not
 *   allowed to exist.
 * - **An unresolved filter returns nothing.** The failure being guarded against
 *   is the query running with the filter dropped, which returns *everything* and
 *   looks like a working search.
 * - **The keyset is total under relevance.** Rows tied on score and separated by
 *   microseconds have to page exactly once each. This is the float twin of the
 *   timestamp bug `services/blips.ts` already carries a warning about, and it is
 *   silent in the descending direction — a skipped row leaves nothing behind to
 *   notice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  isSearchHas,
  parseSearchDate,
  parseSearchQuery,
  tokensFor,
  type ParsedSearch,
} from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { radarReaders, readableRadarIds } from './access.js';
import { createBlip, type SearchPredicate } from './blips.js';
import { createRadar, createSmartRadar, shareRadar } from './radars.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';
import { searchBlips, searchPeople } from './search.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

/* ============================== the grammar ============================== */

describe('the search grammar', () => {
  const fields = (parsed: ParsedSearch) => parsed.tokens.map((t) => `${t.field}:${t.value}`);

  it('lifts filters out and leaves the words behind', () => {
    const parsed = parseSearchQuery('roadmap in:design from:lucas tag:bug');
    expect(parsed.text).toBe('roadmap');
    expect(fields(parsed)).toEqual(['in:design', 'from:lucas', 'tag:bug']);
    expect(parsed.problems).toEqual([]);
  });

  it('keeps a quoted value whole, spaces and all', () => {
    const parsed = parseSearchQuery('in:"On My Radar Dev" notes');
    expect(tokensFor(parsed, 'in')).toEqual(['On My Radar Dev']);
    expect(parsed.text).toBe('notes');
  });

  it('survives a colon inside a quoted value', () => {
    // The reason the lexer is a scanner rather than a regex.
    const parsed = parseSearchQuery('in:"9:30 standup"');
    expect(tokensFor(parsed, 'in')).toEqual(['9:30 standup']);
  });

  it('does not eat a URL as a filter', () => {
    // `https:` is not a field, so this is a word — the whole reason an unknown
    // prefix is text rather than an error.
    const parsed = parseSearchQuery('https://example.com/x');
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe('https://example.com/x');
  });

  it('treats an unknown prefix as words rather than a broken filter', () => {
    const parsed = parseSearchQuery('note:to self');
    expect(parsed.tokens).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.text).toBe('note:to self');
  });

  it('passes a phrase and an exclusion through to the text untouched', () => {
    // `websearch_to_tsquery` reads both; mangling either would quietly change
    // what was asked for.
    const parsed = parseSearchQuery('"exact phrase" -unwanted');
    expect(parsed.text).toBe('"exact phrase" -unwanted');
  });

  it('reports a known field with a value it cannot accept, rather than dropping it', () => {
    const parsed = parseSearchQuery('is:blue');
    expect(parsed.tokens).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.raw).toBe('is:blue');
    expect(parsed.problems[0]?.message).toMatch(/not a state/i);
    /*
      The message is the whole value of reporting the problem, so it is asserted
      as prose rather than as a substring. Building it by joining the accepted
      values with " or " produced "pinned or unpinned or archived or live" the
      moment `is:` grew past two extras — four alternatives to a sentence rather
      than one list, and nobody would have noticed without reading it.
    */
    expect(parsed.problems[0]?.message).toBe(
      'is:blue is not a state. Try inbox, active, later, done, dropped, pinned, unpinned, archived or live.',
    );
  });

  it('accepts the archive on is:, alongside the states and the pin', () => {
    expect(tokensFor(parseSearchQuery('is:archived'), 'is')).toEqual(['archived']);
    expect(tokensFor(parseSearchQuery('is:live'), 'is')).toEqual(['live']);
    // Composes rather than replaces: archived-ness is a fact about a finished
    // blip, not a sixth triage state.
    expect(tokensFor(parseSearchQuery('is:done is:archived'), 'is')).toEqual(['done', 'archived']);
    expect(parseSearchQuery('is:archived').problems).toEqual([]);
  });

  it('reports an empty filter value', () => {
    const parsed = parseSearchQuery('in:');
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.tokens).toEqual([]);
  });

  it('accepts the spellings people actually reach for on has:', () => {
    expect(tokensFor(parseSearchQuery('has:files'), 'has')).toEqual(['attachment']);
    expect(tokensFor(parseSearchQuery('has:replies'), 'has')).toEqual(['comment']);
    expect(tokensFor(parseSearchQuery('has:url'), 'has')).toEqual(['link']);
    expect(parseSearchQuery('has:vibes').problems).toHaveLength(1);
  });

  it('types has: as a closed set, so an unknown value cannot fall through to comment', () => {
    // The SQL builder once treated every value that was not link or
    // attachment as `comment`. The predicate is now typed to SEARCH_HAS, so
    // this line stops compiling if it is ever widened back to `string`.
    // @ts-expect-error — 'vibes' is not a SearchHas
    const bogus: SearchPredicate = { field: 'has', value: 'vibes' };
    expect(bogus.field).toBe('has');
    expect(isSearchHas('comment')).toBe(true);
    expect(isSearchHas('vibes')).toBe(false);
  });

  it('normalises a tag the same way capture does', () => {
    expect(tokensFor(parseSearchQuery('tag:"Side Projects"'), 'tag')).toEqual(['side-projects']);
    expect(tokensFor(parseSearchQuery('tag:#Bug'), 'tag')).toEqual(['bug']);
  });

  it('reads dates absolute and relative, and refuses a day that does not exist', () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    expect(parseSearchDate('2026-08-01', now)).toBe('2026-08-01T00:00:00.000Z');
    expect(parseSearchDate('7d', now)).toBe('2026-08-20T12:00:00.000Z');
    expect(parseSearchDate('today', now)).toBe('2026-08-27T00:00:00.000Z');
    // JS would roll this into March without saying so.
    expect(parseSearchDate('2026-02-31', now)).toBeNull();
    expect(parseSearchDate('tuesday', now)).toBeNull();
    // Year 0 and before are not dates Postgres takes; they were a 500.
    expect(parseSearchDate('2026y', now)).toBeNull();
    expect(parseSearchDate('9999y', now)).toBeNull();
    expect(parseSearchDate('0000', now)).toBeNull();
    expect(parseSearchDate('2025y', now)).toBe('0001-08-27T12:00:00.000Z');
    // Not 1950: a two-digit year is not a century shortcut.
    expect(parseSearchDate('0050', now)).toBe('0050-01-01T00:00:00.000Z');
  });

  it('is case-insensitive on the field, not on a quoted value', () => {
    const parsed = parseSearchQuery('IN:"Mixed Case"');
    expect(tokensFor(parsed, 'in')).toEqual(['Mixed Case']);
  });
});

/* ========================= against a real Postgres ======================== */

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      name: label,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

const NEVER_EXISTED = '11111111-2222-3333-4444-555555555555';

describe.skipIf(!hasDatabase)('universal search (real postgres)', () => {
  let me: Actor;
  let stranger: Actor;
  /** A radar of mine, holding the needle. */
  let mine: { id: string; name: string };
  /** A radar of the stranger's, holding an identical needle I must never reach. */
  let theirs: { id: string; name: string };

  beforeAll(async () => {
    await runMigrations();
    me = await makeUser('searcher');
    stranger = await makeUser('stranger');

    mine = await createRadar(me, { name: `Mine ${Date.now()}` });
    theirs = await createRadar(stranger, { name: `Theirs ${Date.now()}` });

    await createBlip(me, mine.id, { body: 'the peregrine falcon nests on the cathedral #birds' });
    await createBlip(stranger, theirs.id, {
      body: 'the peregrine falcon nests on the cathedral #birds',
    });
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  const ids = async (q: string, actor: Actor = me) =>
    (await searchBlips(actor, { q })).items.map((item) => item.radarId);

  /* ------------------------- what can never be seen ------------------------ */

  describe('a radar you cannot read is unreachable from every direction', () => {
    it('does not return it for words that match its blip exactly', async () => {
      const found = await ids('peregrine falcon');
      expect(found).toContain(mine.id);
      expect(found).not.toContain(theirs.id);
    });

    it('does not return it for a tag it carries', async () => {
      expect(await ids('tag:birds')).not.toContain(theirs.id);
    });

    it('does not return it for its author', async () => {
      // Two ways of naming them, because an email and a display name are
      // separate matching passes and only one of them being wrong is enough.
      const byEmail = await searchBlips(me, { q: `from:${stranger.user.email}` });
      expect(byEmail.items).toHaveLength(0);
      expect(byEmail.unresolved).toBe(true);

      const byName = await searchBlips(me, { q: 'from:stranger' });
      expect(byName.items).toHaveLength(0);
      expect(byName.unresolved).toBe(true);
    });

    it('does not return it when its id is named outright', async () => {
      const result = await searchBlips(me, { q: `peregrine in:${theirs.id}` });
      expect(result.items).toHaveLength(0);
      expect(result.unresolved).toBe(true);
      expect(result.radarsSearched).toBe(0);
    });
  });

  /* ------------------------- naming is not an oracle ----------------------- */

  describe('naming something you cannot see tells you nothing about it', () => {
    it('answers identically for a real radar of somebody else and an id that never existed', async () => {
      const real = await searchBlips(me, { q: `in:${theirs.id}` });
      const fake = await searchBlips(me, { q: `in:${NEVER_EXISTED}` });

      // Not "both empty" — byte-identical, once the id itself is normalised out.
      const shape = (r: Awaited<ReturnType<typeof searchBlips>>, id: string) =>
        JSON.stringify(r).split(id).join('<ID>');
      expect(shape(real, theirs.id)).toBe(shape(fake, NEVER_EXISTED));
    });

    it('answers identically for a real person you do not share with and nobody at all', async () => {
      const real = await searchBlips(me, { q: `from:${stranger.user.email}` });
      const fake = await searchBlips(me, { q: 'from:nobody@nowhere.invalid' });
      const shape = (r: Awaited<ReturnType<typeof searchBlips>>, who: string) =>
        JSON.stringify(r).split(who).join('<WHO>');
      expect(shape(real, stranger.user.email)).toBe(shape(fake, 'nobody@nowhere.invalid'));
    });

    it('says the same thing about a radar name that is a typo', async () => {
      const result = await searchBlips(me, { q: 'in:desgin' });
      expect(result.unresolved).toBe(true);
      expect(result.problems[0]?.message).toMatch(/matched no radar you can read/i);
    });
  });

  /* ------------------- the candidate list is a composition ----------------- */

  it('offers exactly the people who read a radar you read, and nobody else', async () => {
    // The equality that makes a second "who may I name" query unnecessary — and
    // therefore makes it impossible for one to drift from the other.
    const readable = await readableRadarIds(me.user.id);
    const union = new Set<string>();
    for (const radarId of readable) {
      const [row] = await getDb()
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.id, radarId))
        .limit(1);
      if (!row) continue;
      for (const reader of await radarReaders(row)) union.add(reader.id);
    }

    const offered = new Set((await searchPeople(me)).map((person) => person.id));
    expect([...offered].sort()).toEqual([...union].sort());
    expect(offered.has(stranger.user.id)).toBe(false);
  });

  /* ---------------------------- sharing changes it -------------------------- */

  describe('search follows the access rules and nothing else', () => {
    it('starts returning a radar the moment it is shared, and its author becomes nameable', async () => {
      const friend = await makeUser('friend');
      const shared = await createRadar(stranger, { name: `Shared ${Date.now()}` });
      await createBlip(stranger, shared.id, { body: 'kestrels hover over the verge' });

      expect((await searchBlips(friend, { q: 'kestrels' })).items).toHaveLength(0);

      await shareRadar(stranger, shared.id, friend.user.email, 'viewer');

      const after = await searchBlips(friend, { q: 'kestrels' });
      expect(after.items).toHaveLength(1);
      // And the person who wrote it is now somebody they may name.
      const byAuthor = await searchBlips(friend, { q: `from:${stranger.user.email}` });
      expect(byAuthor.unresolved).toBe(false);
      expect(byAuthor.items.length).toBeGreaterThan(0);
    });

    it('grants nothing through a topic that does not cascade, and everything through one that does', async () => {
      const guest = await makeUser('guest');
      const topic = await createTopic(stranger, { name: `Topic ${Date.now()}` });
      const inTopic = await createRadar(stranger, { name: `Contained ${Date.now()}` });
      await createBlip(stranger, inTopic.id, { body: 'goshawk in the plantation' });
      await setRadarTopic(stranger, inTopic.id, topic.id);
      await shareTopic(stranger, topic.id, guest.user.email, 'viewer');

      // A topic grant is not a radar grant. The literal ask behind topics.
      expect((await searchBlips(guest, { q: 'goshawk' })).items).toHaveLength(0);

      await setCascade(stranger, topic.id, true);
      expect((await searchBlips(guest, { q: 'goshawk' })).items).toHaveLength(1);

      // ...and switching it back off takes it away again, with nothing left over.
      await setCascade(stranger, topic.id, false);
      expect((await searchBlips(guest, { q: 'goshawk' })).items).toHaveLength(0);
    });
  });

  /* ------------------ an unresolved filter returns nothing ----------------- */

  describe('an unmatched filter is stated, never dropped', () => {
    it('returns nothing rather than everything', async () => {
      // The bug this guards: running the query with the bad filter lifted out
      // returns the whole corpus and looks like a working search.
      const everything = await searchBlips(me, { q: 'peregrine' });
      expect(everything.items.length).toBeGreaterThan(0);

      const withTypo = await searchBlips(me, { q: 'peregrine in:desgin' });
      expect(withTypo.items).toHaveLength(0);
      expect(withTypo.unresolved).toBe(true);
    });

    it('carries the token that failed, so the message can name it', async () => {
      const result = await searchBlips(me, { q: 'in:desgin' });
      expect(result.filters).toContainEqual({
        field: 'in',
        raw: 'in:desgin',
        resolved: false,
        label: null,
      });
    });

    it('refuses malformed known filters instead of widening to the remaining query', async () => {
      // `is:blue` is a parse problem, not an authorization one: the words still
      // run, and the problem is reported alongside the result.
      const result = await searchBlips(me, { q: 'peregrine is:blue' });
      expect(result.problems).toHaveLength(1);
      expect(result.items).toEqual([]);
      expect(result.unresolved).toBe(true);
    });

    it('refuses to search inside a smart radar, and says why', async () => {
      const smart = await createSmartRadar(me, {
        name: `Birds ${Date.now()}`,
        filter: { tags: ['birds'], match: 'any' },
      });
      const result = await searchBlips(me, { q: `in:${smart.id}` });
      expect(result.unresolved).toBe(true);
      // Safe to be specific here: they can read it, so its existence is not news.
      expect(result.problems[0]?.message).toMatch(/saved search, not a container/i);
    });
  });

  /* --------------------------- what each filter does ----------------------- */

  describe('the filters', () => {
    let box: { id: string; name: string };

    beforeAll(async () => {
      box = await createRadar(me, { name: `Filters ${Date.now()}` });
      await createBlip(me, box.id, { body: 'a plain thought about hedgerows #wild' });
      await createBlip(me, box.id, { body: 'https://example.com/hedgerows' });
      await createBlip(me, box.id, { body: '# Hedgerows\n\nA long piece about hedgerows.' });
    }, 30_000);

    it('narrows to one radar by name', async () => {
      const result = await searchBlips(me, { q: `hedgerows in:"${box.name}"` });
      expect(result.items.length).toBeGreaterThan(0);
      expect(new Set(result.items.map((i) => i.radarId))).toEqual(new Set([box.id]));
      expect(result.filters[0]?.label).toBe(box.name);
    });

    it('narrows by kind and by link', async () => {
      const links = await searchBlips(me, { q: `in:"${box.name}" kind:link` });
      expect(links.items.every((item) => item.kind === 'link')).toBe(true);

      const withUrl = await searchBlips(me, { q: `in:"${box.name}" has:link` });
      expect(withUrl.items.every((item) => item.url !== null)).toBe(true);
      expect(withUrl.items.length).toBeGreaterThan(0);
    });

    it('counts every match on the first page, not what was looked through', async () => {
      const q = `hedgerow in:"${box.name}"`;
      const first = await searchBlips(me, { q, limit: 1 });
      expect(first.items).toHaveLength(1);
      // Walk every page: the count is the number of rows the pages add up to.
      let seen = first.items.length;
      let cursor = first.nextCursor;
      while (cursor) {
        const next = await searchBlips(me, { q, limit: 1, cursor });
        expect(next.total).toBeUndefined();
        seen += next.items.length;
        cursor = next.nextCursor;
      }
      expect(seen).toBeGreaterThan(1);
      expect(first.total).toBe(seen);
      const none = await searchBlips(me, { q: `in:"${box.name}" kind:quote` });
      expect(none.total).toBe(0);
    });

    it('offers the values of a half-typed closed filter instead of only refusing it', async () => {
      const typing = await searchBlips(me, { q: 'hedgerows has:' });
      expect(typing.problems[0]?.suggestions).toEqual(['link', 'attachment', 'comment']);
      const misspelt = await searchBlips(me, { q: 'hedgerows kind:lnk' });
      expect(misspelt.problems[0]?.suggestions).toContain('link');
    });

    it('narrows by tag using the same normalisation capture used', async () => {
      const result = await searchBlips(me, { q: `in:"${box.name}" tag:Wild` });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((item) => item.tags.includes('wild'))).toBe(true);
    });

    it('partitions the corpus at a date bound with no row in both halves', async () => {
      const bound = new Date().toISOString();
      const before = await searchBlips(me, { q: `in:"${box.name}" before:${bound.slice(0, 10)}` });
      const after = await searchBlips(me, { q: `in:"${box.name}" after:${bound.slice(0, 10)}` });
      const overlap = new Set(before.items.map((i) => i.id));
      expect(after.items.filter((item) => overlap.has(item.id))).toHaveLength(0);
    });

    it('layers filters as an intersection', async () => {
      const result = await searchBlips(me, {
        q: `hedgerows in:"${box.name}" from:${me.user.email} is:inbox`,
      });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((item) => item.state === 'inbox')).toBe(true);
      expect(result.filters.filter((f) => f.resolved)).toHaveLength(3);
    });
  });

  /* -------------------------------- ranking -------------------------------- */

  it('ranks a title match above a body match', async () => {
    const radar = await createRadar(me, { name: `Ranking ${Date.now()}` });
    // A heading becomes the title, which the GENERATED tsvector weights 'A'.
    await createBlip(me, radar.id, { body: '# Ptarmigan\n\nSomething else entirely.' });
    await createBlip(me, radar.id, {
      body: 'A paragraph that eventually mentions a ptarmigan somewhere in the middle of it.',
    });

    const result = await searchBlips(me, { q: `ptarmigan in:"${radar.name}"` });
    expect(result.ranking).toBe('relevance');
    expect(result.items[0]?.title).toBe('Ptarmigan');
  });

  it('ranks a title that holds the phrase above 30 long bodies that repeat it', async () => {
    const radar = await createRadar(me, { name: `Phrase ${Date.now()}` });
    // Later capture = newer, so the title loses any created_at tie-break.
    const filler =
      'Notes on the rate limiter: every rate limiter we ran leaked, so the rate limiter changed. ';
    for (let i = 0; i < 30; i++) {
      await createBlip(me, radar.id, { body: `Standup ${i}. ${filler.repeat(12)}` });
    }
    const target = await createBlip(me, radar.id, {
      body: '# Review: rate limiter design\n\nShort note.',
    });
    // Filters are parsed out first: the boost must see only the words.
    const result = await searchBlips(me, { q: `rate limiter in:"${radar.name}" is:inbox` });
    expect(result.items.findIndex((item) => item.id === target.id)).toBe(0);
  });

  it('names a headingless blip by its first line: NULL title still earns the title boost', async () => {
    const radar = await createRadar(me, { name: `Derived ${Date.now()}` });
    // Oldest, so created_at cannot help it; no heading, so the stored title is NULL.
    const target = await createBlip(me, radar.id, {
      body: 'Review: rate limiter design\n\nShort note.',
    });
    expect(target.title).toBeNull();
    await createBlip(me, radar.id, { body: '# Rate limiter spike\n\nShort.' });
    await createBlip(me, radar.id, { body: '# Capacity plan\n\nThe rate limiter, again.' });
    const filler = 'Notes on the rate limiter: every rate limiter we ran leaked. ';
    for (let i = 0; i < 30; i++) {
      // One long paragraph: past title length, so it has no name of its own.
      await createBlip(me, radar.id, {
        body: `Standup ${i}. ${filler.repeat(12)}`,
      });
    }
    const result = await searchBlips(me, { q: `rate limiter in:"${radar.name}" is:inbox` });
    expect(result.items.slice(0, 3).map((i) => i.id)).toContain(target.id);
  });

  it('falls back to capture order when there is nothing to be relevant to', async () => {
    const result = await searchBlips(me, { q: `in:"${mine.name}" is:inbox` });
    expect(result.ranking).toBe('recent');
  });

  /* ------------------------ the keyset stays total -------------------------- */

  it('pages a relevance-ordered result without repeating or skipping a row', async () => {
    const radar = await createRadar(me, { name: `Paging ${Date.now()}` });

    // Identical bodies, so every row scores identically and the tiebreak is the
    // only thing separating them.
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const blip = await createBlip(me, radar.id, { body: 'capercaillie capercaillie' });
      made.push(blip.id);
    }

    /*
      Now force the timestamps into the same millisecond, differing only in
      microseconds. This is the shape that broke the comment cursor: a JS Date
      truncates to milliseconds, so a cursor built from one names an instant
      fractionally before the row it came from — and with a `<` comparison the
      rows inside that gap are silently skipped.
    */
    for (const [index, id] of made.entries()) {
      await getDb().execute(
        sql`UPDATE blips SET created_at = timestamptz '2026-08-01 12:00:00.123000+00' + (${index} * interval '1 microsecond') WHERE id = ${id}`,
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await searchBlips(me, {
        q: `capercaillie in:"${radar.name}"`,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(new Set(seen).size).toBe(made.length);
    expect(seen.sort()).toEqual([...made].sort());
  }, 30_000);

  it('carries the relevance score through the cursor losslessly', async () => {
    // Rows whose scores genuinely differ, paged one at a time: if the score were
    // round-tripped through a JS number the boundary comparison would drift and
    // a row would be served twice or lost.
    const radar = await createRadar(me, { name: `Scores ${Date.now()}` });
    await createBlip(me, radar.id, { body: '# Dunlin\n\nDunlin dunlin dunlin.' });
    await createBlip(me, radar.id, { body: 'Dunlin appear on the estuary in winter.' });
    await createBlip(me, radar.id, { body: 'A long paragraph in which a dunlin is mentioned.' });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await searchBlips(me, {
        q: `dunlin in:"${radar.name}"`,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(3);
  }, 30_000);
});

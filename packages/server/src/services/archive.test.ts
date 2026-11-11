/**
 * Blip archiving, against a real Postgres.
 *
 * There is no `blips.archived_at` column and no sweep: archived-ness is computed
 * from the row's own activity against its radar's window. That buys the thing
 * this file mostly exists to prove — **the SQL half and the JS half say the same
 * thing** — and it is the one place the design could quietly rot, because the
 * predicate in `archivedExpr` and the `archivedAt` computed in `hydrate` are two
 * expressions of one rule.
 *
 * So the first test is not an example. It is the invariant: over a matrix of
 * states, ages and templates, the set the stream hides is *exactly* the set
 * whose DTO reports itself archived. If somebody changes one spelling and not
 * the other, that test names it.
 *
 * Everything after it is a decision Lucas made, held in place:
 *
 * - unfinished work never ages out, however long it has sat there;
 * - a decision log never archives at all, because its rejected and superseded
 *   entries *are* the artifact;
 * - activity resurrects — commenting, editing, moving — and the reason that is
 *   worth asserting three times is that a stored flag would have needed three
 *   separate write paths to remember, and this design needs none;
 * - `0` means never, and it is a decision rather than an absence.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_ARCHIVE_AFTER_DAYS } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { requireRadar } from './access.js';
import { createBlip, radarStream, scopeOf, statusCounts, updateBlip } from './blips.js';
import { createComment } from './comments.js';
import { createRadar, getRadarDto, setVisibility, updateRadar } from './radars.js';
import { searchBlips } from './search.js';
import { must } from '../errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

/**
 * Push a blip's whole clock back, the way the passage of time would.
 *
 * `updated_at` **and** `created_at`, because the archive clock is
 * `GREATEST(updated_at, lastActivity)` and `lastActivity` falls back to
 * `created_at` when nobody has commented. Moving only one of them would age the
 * row by half and produce a test that passes for the wrong reason.
 */
async function ageBy(blipId: string, days: number): Promise<void> {
  await getDb()
    .update(schema.blips)
    .set({
      createdAt: sql`now() - make_interval(days => ${days})`,
      updatedAt: sql`now() - make_interval(days => ${days})`,
    })
    .where(eq(schema.blips.id, blipId));
}

/** The ids a plain read of the radar returns — the live set, as a board sees it. */
async function liveIds(actor: Actor, radarId: string): Promise<string[]> {
  const access = await requireRadar(radarId, actor, 'read');
  const page = await radarStream(access, actor, { limit: 200 });
  return page.items.map((b) => b.id);
}

/** Every blip, live or not, with what the DTO says about each one. */
async function allBlips(actor: Actor, radarId: string) {
  const access = await requireRadar(radarId, actor, 'read');
  const page = await radarStream(access, actor, { limit: 200, includeArchived: true });
  return page.items;
}

describe.skipIf(!hasDatabase)('blip archiving (real postgres)', () => {
  let owner: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('archive');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* --------------------------- the anti-drift test ------------------------- */

  it('hides exactly the blips whose DTO says they are archived', async () => {
    // One radar per template so the matrix covers both the archiving and the
    // non-archiving side of the registry declaration.
    const board = await createRadar(owner, {
      name: `Matrix board ${Math.random()}`,
      template: 'kanban',
    });
    const log = await createRadar(owner, {
      name: `Matrix log ${Math.random()}`,
      template: 'decisions',
    });

    const ages = [0, 5, 29, 31, 400];

    for (const age of ages) {
      for (const lane of ['backlog', 'todo', 'doing', 'blocked', 'done'] as const) {
        const blip = await createBlip(owner, board.id, {
          body: `board ${lane} ${age}`,
          status: lane,
        });
        await ageBy(blip.id, age);
      }
      for (const lane of ['proposed', 'accepted', 'rejected', 'superseded'] as const) {
        const blip = await createBlip(owner, log.id, { body: `log ${lane} ${age}`, status: lane });
        await ageBy(blip.id, age);
      }
    }

    for (const radarId of [board.id, log.id]) {
      const everything = await allBlips(owner, radarId);
      const live = new Set(await liveIds(owner, radarId));

      const saysArchived = everything
        .filter((b) => b.archivedAt !== null)
        .map((b) => b.id)
        .sort();
      const hidden = everything
        .filter((b) => !live.has(b.id))
        .map((b) => b.id)
        .sort();

      // The invariant. Not "some overlap" — the same set, both directions.
      expect(hidden).toEqual(saysArchived);
      // And it is not vacuously true: the matrix really did land rows here.
      expect(everything.length).toBeGreaterThan(0);
    }

    // The board archived something; the decision log archived nothing at all.
    const boardArchived = (await allBlips(owner, board.id)).filter((b) => b.archivedAt !== null);
    const logArchived = (await allBlips(owner, log.id)).filter((b) => b.archivedAt !== null);
    expect(boardArchived.length).toBeGreaterThan(0);
    expect(logArchived).toHaveLength(0);
  }, 60_000);

  /* ------------------------------ the window ------------------------------- */

  it('ages out finished work past the window and leaves the rest alone', async () => {
    const board = await createRadar(owner, { name: `Window ${Math.random()}`, template: 'kanban' });

    const old = await createBlip(owner, board.id, { body: 'finished long ago', status: 'done' });
    const recent = await createBlip(owner, board.id, {
      body: 'finished yesterday',
      status: 'done',
    });
    const working = await createBlip(owner, board.id, { body: 'still going', status: 'doing' });
    const stale = await createBlip(owner, board.id, { body: 'never picked up', status: 'backlog' });

    await ageBy(old.id, DEFAULT_ARCHIVE_AFTER_DAYS + 1);
    await ageBy(recent.id, 1);
    await ageBy(working.id, 400);
    // Unfinished work never ages out however long it has sat there: a stale
    // Backlog is a fact about you, and hiding it would be the app taking a view.
    await ageBy(stale.id, 400);

    const live = await liveIds(owner, board.id);
    expect(live).not.toContain(old.id);
    expect(live).toContain(recent.id);
    expect(live).toContain(working.id);
    expect(live).toContain(stale.id);

    // Nothing was deleted — it is one flag away.
    const all = (await allBlips(owner, board.id)).map((b) => b.id);
    expect(all).toContain(old.id);
  });

  it('archives a dropped blip, which is what replaced the sixth kanban lane', async () => {
    // `79c3f5d5` asked for a "Won't do" column so abandoned cards had somewhere
    // to go. They go here instead, and the board keeps five lanes.
    const board = await createRadar(owner, {
      name: `Dropped ${Math.random()}`,
      template: 'kanban',
    });
    const blip = await createBlip(owner, board.id, { body: 'not doing this', state: 'dropped' });
    await ageBy(blip.id, DEFAULT_ARCHIVE_AFTER_DAYS + 1);
    expect(await liveIds(owner, board.id)).not.toContain(blip.id);
  });

  it('never archives on a template that has not opted in, at any window', async () => {
    const log = await createRadar(owner, { name: `Log ${Math.random()}`, template: 'decisions' });
    // Even with the shortest window a person could possibly set, and stored on
    // the row rather than defaulted.
    await updateRadar(owner, log.id, { archiveAfterDays: 1 });
    const blip = await createBlip(owner, log.id, { body: 'we said no', status: 'rejected' });
    await ageBy(blip.id, 4000);
    expect(await liveIds(owner, log.id)).toContain(blip.id);
  });

  it('treats a window of 0 as never, and null as the default', async () => {
    const board = await createRadar(owner, { name: `Never ${Math.random()}`, template: 'kanban' });
    const blip = await createBlip(owner, board.id, { body: 'ancient but kept', status: 'done' });
    await ageBy(blip.id, 4000);

    expect(await liveIds(owner, board.id)).not.toContain(blip.id);

    await updateRadar(owner, board.id, { archiveAfterDays: 0 });
    expect(await liveIds(owner, board.id)).toContain(blip.id);

    // Back to no opinion: the default applies again and it goes.
    await updateRadar(owner, board.id, { archiveAfterDays: null });
    expect(await liveIds(owner, board.id)).not.toContain(blip.id);
  });

  it('widening the window brings blips back, because nothing was destroyed', async () => {
    const board = await createRadar(owner, { name: `Widen ${Math.random()}`, template: 'kanban' });
    const blip = await createBlip(owner, board.id, { body: 'finished in march', status: 'done' });
    await ageBy(blip.id, 45);

    expect(await liveIds(owner, board.id)).not.toContain(blip.id);
    await updateRadar(owner, board.id, { archiveAfterDays: 90 });
    expect(await liveIds(owner, board.id)).toContain(blip.id);
  });

  /* ---------------------------- activity resurrects ------------------------ */

  it('brings an archived blip back when somebody comments on it', async () => {
    const board = await createRadar(owner, {
      name: `Comment ${Math.random()}`,
      template: 'kanban',
    });
    const blip = await createBlip(owner, board.id, { body: 'shipped', status: 'done' });
    await ageBy(blip.id, 90);
    expect(await liveIds(owner, board.id)).not.toContain(blip.id);

    await createComment(owner, blip.id, { body: 'this broke again' });
    expect(await liveIds(owner, board.id)).toContain(blip.id);
  });

  it('brings an archived blip back when somebody edits it', async () => {
    const board = await createRadar(owner, { name: `Edit ${Math.random()}`, template: 'kanban' });
    const blip = await createBlip(owner, board.id, { body: 'shipped', status: 'done' });
    await ageBy(blip.id, 90);
    expect(await liveIds(owner, board.id)).not.toContain(blip.id);

    await updateBlip(owner, blip.id, { body: 'shipped, with a caveat' });
    expect(await liveIds(owner, board.id)).toContain(blip.id);
  });

  it('brings an archived blip back into the lane it was already in, not a new one', async () => {
    // The answer to "where does a resurrected card go". Archiving writes neither
    // `state` nor `status`, so there is no lane to restore: it never left.
    const board = await createRadar(owner, { name: `Lane ${Math.random()}`, template: 'kanban' });
    const blip = await createBlip(owner, board.id, { body: 'abandoned', status: 'blocked' });
    // Dropped has no lane on a board, so a state sent alone leaves the card in Blocked.
    await updateBlip(owner, blip.id, { state: 'dropped' });
    await ageBy(blip.id, 90);
    expect(await liveIds(owner, board.id)).not.toContain(blip.id);

    await createComment(owner, blip.id, { body: 'picking this up again' });
    const back = (await allBlips(owner, board.id)).find((b) => b.id === blip.id);
    expect(back?.status).toBe('blocked');
    expect(back?.state).toBe('dropped');
    expect(back?.archivedAt).toBeNull();
  });

  it('brings a blip back the moment it is moved out of a finished lane', async () => {
    const board = await createRadar(owner, { name: `Move ${Math.random()}`, template: 'kanban' });
    const blip = await createBlip(owner, board.id, { body: 'reopened', status: 'done' });
    await ageBy(blip.id, 90);
    expect(await liveIds(owner, board.id)).not.toContain(blip.id);

    await updateBlip(owner, blip.id, { status: 'doing' });
    expect(await liveIds(owner, board.id)).toContain(blip.id);
  });

  /* -------------------------------- the seam ------------------------------- */

  it('reports what left each lane, so the header is never silent', async () => {
    const board = await createRadar(owner, { name: `Seam ${Math.random()}`, template: 'kanban' });
    const kept = await createBlip(owner, board.id, { body: 'recently done', status: 'done' });
    await ageBy(kept.id, 2);
    for (let n = 0; n < 3; n += 1) {
      const gone = await createBlip(owner, board.id, { body: `old ${n}`, status: 'done' });
      await ageBy(gone.id, 90);
    }

    const counts = await statusCounts(scopeOf([board.id]));
    expect(counts.live['done']).toBe(1);
    expect(counts.archived['done']).toBe(3);

    // And the radar's own count is the live one, with the archive beside it —
    // the "still counted" half of the complaint.
    const access = await requireRadar(board.id, owner, 'read');
    const dto = await getRadarDto(access, owner);
    expect(dto.blipCount).toBe(1);
    expect(dto.archivedCount).toBe(3);
  });

  /* ------------------------------ search is it ----------------------------- */

  it('finds the archive through search, and narrows to it with is:archived', async () => {
    const board = await createRadar(owner, {
      name: `Searchable ${Math.random()}`,
      template: 'kanban',
    });
    const gone = await createBlip(owner, board.id, {
      body: 'zorblewick the archived one',
      status: 'done',
    });
    const here = await createBlip(owner, board.id, { body: 'zorblewick the live one' });
    await ageBy(gone.id, 90);

    // The default: search spans both, because an archive you cannot find by
    // searching is a deletion with extra steps.
    const both = await searchBlips(owner, { q: 'zorblewick' });
    expect(both.items.map((b) => b.id).sort()).toEqual([gone.id, here.id].sort());

    const onlyArchived = await searchBlips(owner, { q: 'zorblewick is:archived' });
    expect(onlyArchived.items.map((b) => b.id)).toEqual([gone.id]);

    const onlyLive = await searchBlips(owner, { q: 'zorblewick is:live' });
    expect(onlyLive.items.map((b) => b.id)).toEqual([here.id]);

    // The link the lane header prints, composed the way the UI composes it.
    const scoped = await searchBlips(owner, { q: `in:"${board.name}" is:archived` });
    expect(scoped.items.map((b) => b.id)).toEqual([gone.id]);
  });

  it('leaves is:archived out of the grammar problems it reports', async () => {
    const result = await searchBlips(owner, { q: 'is:archived' });
    expect(result.problems).toHaveLength(0);
  });

  /* ------------------------------ the public page -------------------------- */

  it('refuses includeArchived on a published radar, however it is asked', async () => {
    /*
      `includeArchived` lives on `listBlipsSchema`, which validates the private
      route and the MCP tool as well — so without the override in `routes/public.ts`
      a stranger could append it to the URL and read every abandoned card off a
      board whose owner published a page showing four. No public surface asks for
      it: there is no seam and no search on a published page, so the flag would
      exist only for somebody who guessed. Same narrowing this route already
      applies to author addresses and member counts.
    */
    const app = createApp();
    const board = await createRadar(owner, { name: `Public ${Math.random()}`, template: 'kanban' });
    const live = await createBlip(owner, board.id, { body: 'still on the board', status: 'todo' });
    const gone = await createBlip(owner, board.id, { body: 'aged out of it', status: 'done' });
    await ageBy(gone.id, 90);

    const { publicSlug } = await setVisibility(owner, board.id, 'public');
    expect(publicSlug).toBeTruthy();

    const read = async (query: string) => {
      const res = await app.request(
        `/api/public/radars/${must(publicSlug, 'publicSlug')}/blips${query}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      return body.items.map((b) => b.id);
    };

    expect(await read('')).toEqual([live.id]);
    // Asserting the answer, not the refusal: a route that 400s here would be
    // just as correct, and a route that quietly returns the archive would not.
    expect(await read('?includeArchived=true')).toEqual([live.id]);
    expect(await read('?includeArchived=1')).toEqual([live.id]);
  });

  /* ---------------------------- nothing was written ------------------------ */

  it('writes no blip rows in order to archive anything', async () => {
    // The point of computing it. If archiving ever starts writing, this fails —
    // and a write on a read path is exactly what a lazy sweep would have been.
    const board = await createRadar(owner, {
      name: `Nowrite ${Math.random()}`,
      template: 'kanban',
    });
    const blip = await createBlip(owner, board.id, { body: 'done', status: 'done' });
    await ageBy(blip.id, 90);

    const before = await getDb()
      .select({ updatedAt: schema.blips.updatedAt })
      .from(schema.blips)
      .where(inArray(schema.blips.id, [blip.id]));

    await liveIds(owner, board.id);
    await statusCounts(scopeOf([board.id]));

    const after = await getDb()
      .select({ updatedAt: schema.blips.updatedAt })
      .from(schema.blips)
      .where(inArray(schema.blips.id, [blip.id]));

    expect(after[0]?.updatedAt.toISOString()).toBe(before[0]?.updatedAt.toISOString());
  });
});

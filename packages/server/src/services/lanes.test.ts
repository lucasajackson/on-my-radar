/**
 * `state` and `status` are one axis seen twice, and they must not disagree.
 *
 * A board reads its columns from `status`; every triage count, every smart
 * radar and `search_blips({state})` read `state`. When those two drift apart the
 * board shows a card in To do that the rest of the app calls done, and there is
 * nothing on screen to say which is true. That is precisely what happened: six
 * cards on a live radar sat in To do and In progress while carrying
 * `state: 'done'`, because `update_blip({state:'done'})` never touched the lane.
 *
 * The rule under test, in both directions:
 *
 * - **status -> state is a mapping.** A lane declares the state it implies, so
 *   landing in one carries the blip's triage with it. Exact, no judgement.
 * - **state -> status is a repair.** There is no inverse — `doing` and `blocked`
 *   both imply `active` — so setting `state` alone moves the card only when the
 *   lane it is in now contradicts it, and then to the first lane that matches.
 *   A blocked card re-confirmed `active` stays Blocked; a card marked `done`
 *   lands in Done.
 *
 * Against a real Postgres because the round trip is the point: what the board
 * renders is the stored row, not the value the service computed.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip, updateBlip } from './blips.js';
import { getRadarAccess } from './access.js';
import { createRadar, getRadarDto, updateRadar } from './radars.js';
import type { RadarDto } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { SESSION_COOKIE, createSession } from '../auth/session.js';
import { must } from '../errors.js';
import { blockedBehind } from './lock-graph.js';

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

/** The stored row, not the DTO — the board renders what is actually in the table. */
async function stored(blipId: string): Promise<{ state: string; status: string | null }> {
  const [row] = await getDb()
    .select({ state: schema.blips.state, status: schema.blips.status })
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  if (!row) throw new Error('blip vanished');
  return row;
}

describe.skipIf(!hasDatabase)('state and status stay in agreement (real postgres)', () => {
  let owner: Actor;
  let board: string;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('lanes');
    const radar = await createRadar(owner, { name: `Board ${Math.random()}`, template: 'kanban' });
    board = radar.id;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('moves a card to Done when only its state is set', async () => {
    const blip = await createBlip(owner, board, { body: 'ship the thing', status: 'todo' });
    expect(await stored(blip.id)).toEqual({ state: 'later', status: 'todo' });

    const done = await updateBlip(owner, blip.id, { state: 'done' });
    expect(done.status).toBe('done');
    expect(await stored(blip.id)).toEqual({ state: 'done', status: 'done' });
  });

  it('leaves a blocked card blocked when it is re-confirmed active', async () => {
    // The whole reason this is a repair and not a mapping: `blocked` and `doing`
    // both imply `active`, so a caller saying `active` has not said which.
    const blip = await createBlip(owner, board, { body: 'waiting on infra', status: 'blocked' });
    expect(await stored(blip.id)).toEqual({ state: 'active', status: 'blocked' });

    await updateBlip(owner, blip.id, { state: 'active' });
    expect(await stored(blip.id)).toEqual({ state: 'active', status: 'blocked' });
  });

  it('still carries a lane into the state it implies', async () => {
    const blip = await createBlip(owner, board, { body: 'a card' });
    expect(await stored(blip.id)).toEqual({ state: 'inbox', status: 'backlog' });

    await updateBlip(owner, blip.id, { status: 'doing' });
    expect(await stored(blip.id)).toEqual({ state: 'active', status: 'doing' });
  });

  it('lets an explicit lane win when both are set in one call', async () => {
    // `blocked` implies `active` and the caller asked for `active`; but they also
    // named the lane, and a named lane is not a guess to be second-guessed.
    const blip = await createBlip(owner, board, { body: 'both at once' });
    await updateBlip(owner, blip.id, { state: 'active', status: 'blocked' });
    expect(await stored(blip.id)).toEqual({ state: 'active', status: 'blocked' });
  });

  it('refuses a lane and a state that contradict, naming the lane’s own state', async () => {
    const blip = await createBlip(owner, board, { body: 'mixed signals', status: 'todo' });
    const before = await stored(blip.id);
    const refused = updateBlip(owner, blip.id, { status: 'todo', state: 'done' });
    await expect(refused).rejects.toThrow(/Lane "To do" \(todo\) means state "later".*"Done"/s);
    await expect(refused).rejects.toMatchObject({ status: 400 });
    expect(await stored(blip.id)).toEqual(before);
    // Capture is the same door.
    await expect(
      createBlip(owner, board, { body: 'born mixed', status: 'todo', state: 'done' }),
    ).rejects.toThrow(/means state "later"/);
    // A matching pair, and either one alone, still work.
    await updateBlip(owner, blip.id, { status: 'todo', state: 'later' });
    await updateBlip(owner, blip.id, { status: 'done' });
    expect(await stored(blip.id)).toEqual({ state: 'done', status: 'done' });
  });

  it('refuses a state no lane carries beside a lane, so it is sent alone (the dashboard undo)', async () => {
    const blip = await createBlip(owner, board, { body: 'dropped but filed', status: 'todo' });
    await expect(updateBlip(owner, blip.id, { status: 'todo', state: 'dropped' })).rejects.toThrow(
      /means state "later".*send state "dropped" alone/s,
    );
    await updateBlip(owner, blip.id, { state: 'dropped' });
    expect(await stored(blip.id)).toEqual({ state: 'dropped', status: 'todo' });
    // ...and a reading list, whose lanes do not include `later`.
    const list = await createRadar(owner, { name: `Reads ${Math.random()}`, template: 'reading' });
    const read = await createBlip(owner, list.id, { body: 'https://example.com/a' });
    await expect(
      updateBlip(owner, read.id, { status: 'finished', state: 'later' }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await stored(read.id)).status).toBe('unread');
  });

  it('sets the lane’s state when a lane is sent on its own, even if the card is already in it', async () => {
    const blip = await createBlip(owner, board, { body: 'drifted', status: 'todo' });
    await updateBlip(owner, blip.id, { state: 'dropped' });
    expect(await stored(blip.id)).toEqual({ state: 'dropped', status: 'todo' });
    await updateBlip(owner, blip.id, { status: 'todo' });
    expect(await stored(blip.id)).toEqual({ state: 'later', status: 'todo' });
  });

  it('refuses a contradicting pair on a move before anything is re-pointed', async () => {
    const other = await createRadar(owner, { name: `Other ${Math.random()}`, template: 'kanban' });
    const blip = await createBlip(owner, board, { body: 'stays put', status: 'todo' });
    await expect(
      updateBlip(owner, blip.id, { radarId: other.id, status: 'todo', state: 'done' }),
    ).rejects.toThrow(/means state "later"/);
    const [row] = await getDb()
      .select({ radarId: schema.blips.radarId })
      .from(schema.blips)
      .where(eq(schema.blips.id, blip.id));
    expect(row?.radarId).toBe(board);
  });

  it('files a blip captured straight into done in the Done lane', async () => {
    const blip = await createBlip(owner, board, { body: 'already handled', state: 'done' });
    expect(await stored(blip.id)).toEqual({ state: 'done', status: 'done' });
  });

  it('leaves the lane alone when the template has none for the new state', async () => {
    // A reading list has no `later`. Better an imprecise lane than an invented
    // one — the item stays visible where the reader left it.
    const list = await createRadar(owner, { name: `List ${Math.random()}`, template: 'reading' });
    const blip = await createBlip(owner, list.id, { body: 'https://example.com/long-read' });
    expect(await stored(blip.id)).toEqual({ state: 'inbox', status: 'unread' });

    await updateBlip(owner, blip.id, { state: 'later' });
    expect(await stored(blip.id)).toEqual({ state: 'later', status: 'unread' });
  });

  it('leaves a laneless radar laneless', async () => {
    const stream = await createRadar(owner, { name: `Stream ${Math.random()}` });
    const blip = await createBlip(owner, stream.id, { body: 'just a thought' });
    await updateBlip(owner, blip.id, { state: 'done' });
    expect(await stored(blip.id)).toEqual({ state: 'done', status: null });
  });

  it('refuses a lane the template does not have instead of dropping it', async () => {
    // Silently nulling an unknown lane is how a card leaves the board with the
    // caller told nothing. Agents guess lane ids; the error names the real ones.
    const blip = await createBlip(owner, board, { body: 'guess the lane' });
    await expect(updateBlip(owner, blip.id, { status: 'in-progress' })).rejects.toThrow(
      /not a lane.*backlog, todo, doing, blocked, done/s,
    );
    expect(await stored(blip.id)).toEqual({ state: 'inbox', status: 'backlog' });
  });

  it('drops the lane when a card is moved off the board', async () => {
    const stream = await createRadar(owner, { name: `Elsewhere ${Math.random()}` });
    const blip = await createBlip(owner, board, { body: 'moving out', status: 'doing' });
    await updateBlip(owner, blip.id, { radarId: stream.id });
    expect(await stored(blip.id)).toEqual({ state: 'active', status: null });
  });
});

/**
 * A radar's own lane vocabulary, against a real database.
 *
 * The refusal that matters most here cannot be checked anywhere else: whether a
 * proposed lane set would strand blips the radar already holds is a question
 * about stored rows, so the contract's validator cannot answer it and neither
 * can a mock. Everything about the *shape* of a lane set is checked in
 * `src/lanes.test.ts` without a database.
 */
describe.skipIf(!hasDatabase)('a radar with lanes of its own (real postgres)', () => {
  let owner: Actor;

  /** Kanban, different words. The case the whole feature exists for. */
  const PIPELINE = [
    { id: 'lead', label: 'Lead', state: 'inbox' as const },
    { id: 'contacted', label: 'Contacted', state: 'active' as const },
    { id: 'won', label: 'Won', state: 'done' as const, terminal: true },
  ];

  const newBoard = async (label: string) =>
    createRadar(owner, { name: `${label} ${Math.random()}`, template: 'kanban' });

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('custom-lanes');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('captures into the radar’s own first lane, not the template’s', async () => {
    const radar = await newBoard('Pipeline');
    await updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });

    const blip = await createBlip(owner, radar.id, { body: 'Acme, via Ben' });
    expect(await stored(blip.id)).toEqual({ state: 'inbox', status: 'lead' });
  });

  it('carries a custom lane into the state it declares', async () => {
    const radar = await newBoard('Pipeline');
    await updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });

    const blip = await createBlip(owner, radar.id, { body: 'Acme' });
    await updateBlip(owner, blip.id, { status: 'won' });
    expect(await stored(blip.id)).toEqual({ state: 'done', status: 'won' });
  });

  it('refuses a lane from the template it replaced', async () => {
    const radar = await newBoard('Pipeline');
    await updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });

    const blip = await createBlip(owner, radar.id, { body: 'Acme' });
    await expect(updateBlip(owner, blip.id, { status: 'backlog' })).rejects.toThrow(
      /not a lane.*lead, contacted, won/s,
    );
  });

  /**
   * The refusal that needs the rows. Repairing instead would mean writing every
   * stranded blip into some other lane — a second write that can disagree with
   * the first, on rows the caller has not looked at.
   */
  it('refuses a lane set that would strand blips it already holds', async () => {
    const radar = await newBoard('Board');
    await createBlip(owner, radar.id, { body: 'in progress', status: 'doing' });
    await createBlip(owner, radar.id, { body: 'also in progress', status: 'doing' });

    await expect(
      updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } }),
    ).rejects.toThrow(/strand.*2 in "doing"/s);
  });

  /** Nothing is written on a refusal, or the radar half-changes. */
  it('leaves the radar exactly as it was when it refuses', async () => {
    const radar = await newBoard('Board');
    await createBlip(owner, radar.id, { body: 'in progress', status: 'doing' });

    await expect(
      updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } }),
    ).rejects.toThrow();

    const access = await getRadarAccess(radar.id, owner);
    if (!access) throw new Error('radar vanished');
    const after = await getRadarDto(access, owner);
    expect(after.templateConfig.lanes).toBeUndefined();
  });

  /** The way out of the refusal, and the one people will actually want. */
  it('lets a lane be relabelled without moving anything', async () => {
    const radar = await newBoard('Board');
    const blip = await createBlip(owner, radar.id, { body: 'in progress', status: 'doing' });

    const relabelled = await updateRadar(owner, radar.id, {
      templateConfig: {
        lanes: [
          { id: 'backlog', label: 'Someday', state: 'inbox' },
          { id: 'todo', label: 'Up next', state: 'later' },
          { id: 'doing', label: 'On the bench', state: 'active' },
          { id: 'blocked', label: 'Stuck', state: 'active' },
          { id: 'done', label: 'Shipped', state: 'done', terminal: true },
        ],
      },
    });

    expect(relabelled.templateConfig.lanes?.map((lane) => lane.label)).toContain('On the bench');
    expect(await stored(blip.id)).toEqual({ state: 'active', status: 'doing' });
  });

  it('gives the template’s lanes back, and forgets the custom default', async () => {
    const radar = await newBoard('Pipeline');
    await updateRadar(owner, radar.id, {
      templateConfig: { lanes: PIPELINE, defaultStatus: 'contacted' },
    });

    const restored = await updateRadar(owner, radar.id, { templateConfig: { lanes: null } });
    expect(restored.templateConfig.lanes).toBeUndefined();
    expect(restored.templateConfig.defaultStatus).toBeUndefined();

    const blip = await createBlip(owner, radar.id, { body: 'back on the board' });
    expect(await stored(blip.id)).toEqual({ state: 'inbox', status: 'backlog' });
  });

  /**
   * The bug this would otherwise have shipped with: the settings page sends
   * `{ grouping, collapseDone }` on every save, and a wholesale write of
   * `template_config` would take the lanes with it.
   */
  it('keeps the lanes when an unrelated display option is saved', async () => {
    const radar = await newBoard('Pipeline');
    await updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });

    const after = await updateRadar(owner, radar.id, { templateConfig: { collapseDone: true } });
    expect(after.templateConfig.collapseDone).toBe(true);
    expect(after.templateConfig.lanes?.map((lane) => lane.id)).toEqual([
      'lead',
      'contacted',
      'won',
    ]);
  });

  it('refuses a lane set on a template that has no lane axis', async () => {
    const stream = await createRadar(owner, { name: `Stream ${Math.random()}` });
    await expect(
      updateRadar(owner, stream.id, { templateConfig: { lanes: PIPELINE } }),
    ).rejects.toThrow(/no lanes to replace/);
  });

  /** One call may move a radar onto a board and give it a vocabulary. */
  it('accepts lanes in the same call that moves the radar onto a board', async () => {
    const stream = await createRadar(owner, { name: `Stream ${Math.random()}` });
    const moved = await updateRadar(owner, stream.id, {
      template: 'kanban',
      templateConfig: { lanes: PIPELINE },
    });
    expect(moved.template).toBe('kanban');
    expect(moved.templateConfig.lanes?.map((lane) => lane.id)).toEqual([
      'lead',
      'contacted',
      'won',
    ]);
  });

  /* ------------------------------ concurrency ------------------------------ */

  // `blockedBehind` (./lock-graph.ts) counts this test's own lock graph. Two
  // levels, because the second of two saves waits on the first save's advisory
  // lock, not on the row the holder locked.

  async function backendPid(client: pg.Client): Promise<number> {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return must(rows[0]).pid;
  }

  /**
   * The settings page sends `{ grouping, collapseDone }` on every save, and an
   * agent sets lanes with `set_radar_lanes`. Each folds its patch into what is
   * stored; folded onto a copy read before any lock, the later commit wrote
   * back the old lanes. Both saves are held at a lock here and released
   * together, which is the interleaving that lost one.
   */
  it('keeps both of two settings saves that land at once', async () => {
    const radar = await newBoard('Race');
    const holder = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM radars WHERE id = $1 FOR UPDATE', [radar.id]);
      const pid = await backendPid(holder);
      const lanes = updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });
      const display = updateRadar(owner, radar.id, { templateConfig: { collapseDone: true } });
      await expect.poll(() => blockedBehind(holder, pid), { timeout: 5_000 }).toBe(2);
      await holder.query('COMMIT');
      await Promise.all([lanes, display]);
    } finally {
      await holder.end();
    }
    const access = await getRadarAccess(radar.id, owner);
    if (!access) throw new Error('radar vanished');
    const after = await getRadarDto(access, owner);
    expect(after.templateConfig.collapseDone).toBe(true);
    expect(after.templateConfig.lanes?.map((lane) => lane.id)).toEqual([
      'lead',
      'contacted',
      'won',
    ]);
  });

  /**
   * A capture picks its lane from the radar row; a lane edit checks for
   * stranded blips and then writes. Unlocked, a capture could read the old
   * lanes, the edit could find nothing to strand and commit, and the capture
   * could then commit into the lane that had just gone.
   */
  it('refuses a capture into a lane an edit removed while it was being captured', async () => {
    const radar = await newBoard('Strand');
    await expect(
      createBlip(
        owner,
        radar.id,
        { body: 'stuck', status: 'blocked' },
        {
          // Runs inside the capture's transaction, before it reads the lanes.
          beforeInsert: async () => {
            await updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });
          },
        },
      ),
    ).rejects.toThrow(/not a lane/);
    await expectNothingStranded(radar.id);
  });

  it('refuses a lane edit that would strand a capture still being committed', async () => {
    const radar = await newBoard('Strand');
    const observer = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await observer.connect();
    let edit: Promise<unknown> | null = null;
    try {
      await createBlip(
        owner,
        radar.id,
        { body: 'stuck', status: 'blocked' },
        {
          // Inside the capture's transaction, after its insert: the edit has to
          // wait for this capture rather than decide without it.
          afterInsert: async (tx) => {
            const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            const capture = must(rows[0]).pid;
            edit = updateRadar(owner, radar.id, { templateConfig: { lanes: PIPELINE } });
            edit.catch(() => undefined);
            await expect.poll(() => blockedBehind(observer, capture), { timeout: 3_000 }).toBe(1);
          },
        },
      );
    } finally {
      await observer.end();
    }
    await expect(edit).rejects.toThrow(/strand.*1 in "blocked"/s);
    await expectNothingStranded(radar.id);
  });

  async function expectNothingStranded(radarId: string) {
    const access = await getRadarAccess(radarId, owner);
    if (!access) throw new Error('radar vanished');
    const lanes = (await getRadarDto(access, owner)).templateConfig.lanes;
    const ids = lanes?.map((lane) => lane.id) ?? ['backlog', 'todo', 'doing', 'blocked', 'done'];
    const stranded = await getDb()
      .select({ id: schema.blips.id })
      .from(schema.blips)
      .where(and(eq(schema.blips.radarId, radarId), notInArray(schema.blips.status, ids)));
    expect(stranded).toEqual([]);
  }
});

/**
 * The same vocabulary over REST, which is what the settings screen calls —
 * `PATCH /api/radars/:id` with `templateConfig.lanes` — so the SPA can do
 * everything `set_radar_lanes` does: add, rename (same id, new label), reorder
 * (the array order is the board order), remove (refused while blips sit in the
 * lane), and give the template's lanes back with `lanes: null`.
 */
describe.skipIf(!hasDatabase)('lanes over REST (real postgres)', () => {
  let owner: Actor;
  let cookie: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('rest-lanes');
    cookie = `${SESSION_COOKIE}=${(await createSession(owner.user)).token}`;
    app = createApp();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  const patch = (radarId: string, templateConfig: unknown) =>
    app.request(`/api/radars/${radarId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ templateConfig }),
    });
  const lanesOf = async (res: Response) =>
    ((await res.json()) as { radar: RadarDto }).radar.templateConfig.lanes?.map(
      (lane) => `${lane.id}:${lane.label}`,
    );

  it('adds, renames, reorders, refuses a stranding removal, and resets', async () => {
    const radar = await createRadar(owner, {
      name: `REST lanes ${Math.random()}`,
      template: 'kanban',
    });
    await createBlip(owner, radar.id, { body: 'underway', status: 'doing' });
    const lanes = [
      { id: 'backlog', label: 'Backlog', state: 'inbox' },
      { id: 'doing', label: 'Doing', state: 'active' },
      { id: 'review', label: 'Review', state: 'active' },
      { id: 'done', label: 'Done', state: 'done', terminal: true },
    ];
    const added = await patch(radar.id, { lanes });
    expect(added.status).toBe(200);
    expect(await lanesOf(added)).toEqual([
      'backlog:Backlog',
      'doing:Doing',
      'review:Review',
      'done:Done',
    ]);

    const renamedAndMoved = await patch(radar.id, {
      lanes: [lanes[1], { ...lanes[0], label: 'Someday' }, lanes[2], lanes[3]],
    });
    expect(await lanesOf(renamedAndMoved)).toEqual([
      'doing:Doing',
      'backlog:Someday',
      'review:Review',
      'done:Done',
    ]);

    const stranding = await patch(radar.id, { lanes: [lanes[0], lanes[2], lanes[3]] });
    expect(stranding.status).toBe(400);
    expect(((await stranding.json()) as { error: { message: string } }).error.message).toMatch(
      /strand.*1 in "doing"/s,
    );

    const reset = await patch(radar.id, { lanes: null });
    expect(reset.status).toBe(200);
    expect(await lanesOf(reset)).toBeUndefined();
  });
});

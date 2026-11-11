/**
 * Comments and reactions, against a real Postgres.
 *
 * The properties under test are the ones that decide whether these are safe to
 * ship on a shared radar, and none of them is visible to a mock:
 *
 * - **A viewer may take part without being able to write.** That is the whole
 *   ask — "people should be able to comment on blips they don't own" — and it
 *   means participation is a third capability, not a rename of `canWrite`.
 * - **A public link never grants it.** `decide()` says a public link is
 *   read-only, always. Shipping comments must not quietly make the public
 *   surface writable.
 * - **The per-radar switch is real.** An owner turning comments off has to stop
 *   the service, not just hide a box in the SPA — otherwise "off" only means
 *   "off in the browser" and the MCP tool still writes.
 * - **The reaction toggle is decided by the primary key**, not by a
 *   read-then-write. Two concurrent clicks must leave one row or none, never
 *   two, and that is a database behaviour.
 * - **A blip that moves radar takes its conversation with it.** The
 *   denormalised `radar_id` on both tables is what authorizes and scopes them,
 *   so a stale one would strand a comment on a radar its blip no longer lives
 *   on — readable by the wrong people.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { getRadarAccess } from './access.js';
import { createBlip, getBlip, updateBlip } from './blips.js';
import { createComment, deleteComment, listComments, updateComment } from './comments.js';
import { setReaction } from './reactions.js';
import { createRadar, setVisibility, updateRadar } from './radars.js';

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

async function share(radarId: string, actor: Actor, role: 'viewer' | 'editor') {
  await getDb().insert(schema.radarMembers).values({ radarId, userId: actor.user.id, role });
}

describe.skipIf(!hasDatabase)('comments (real postgres)', () => {
  let owner: Actor;
  let viewer: Actor;
  let stranger: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('owner');
    viewer = await makeUser('viewer');
    stranger = await makeUser('stranger');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('lets a viewer comment on a blip they cannot edit', async () => {
    const radar = await createRadar(owner, { name: `Shared ${Math.random()}` });
    await share(radar.id, viewer, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'what do we think' });

    const comment = await createComment(viewer, blip.id, { body: 'I think yes' });
    expect(comment.body).toBe('I think yes');

    // The same person still cannot touch the blip itself — which is the point of
    // participation being a separate capability rather than a widened `write`.
    await expect(updateBlip(viewer, blip.id, { body: 'rewritten' })).rejects.toThrow(
      /read-only access/i,
    );
  });

  it('refuses somebody the radar was never shared with, as a 404', async () => {
    const radar = await createRadar(owner, { name: `Private ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'mine alone' });

    // 404, not 403: a 403 would confirm the blip id exists.
    await expect(createComment(stranger, blip.id, { body: 'hello' })).rejects.toThrow(/not found/i);
  });

  it('never lets a public link write, however public the radar is', async () => {
    const radar = await createRadar(owner, { name: `Published ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'read this' });
    const slug = (await setVisibility(owner, radar.id, 'public')).publicSlug ?? '';

    // A stranger can read it through the public slug…
    const published = await getRadarAccess(slug, null);
    expect(published?.viaPublicLink).toBe(true);
    // …and not by its id, where a denied lookup is simply null.
    expect(await getRadarAccess(radar.id, null)).toBeNull();

    // …and still cannot say a word on it. A public link is read-only, always.
    await expect(createComment(stranger, blip.id, { body: 'hi' })).rejects.toThrow(/not found/i);
  });

  it('stops accepting comments when the owner turns them off', async () => {
    const radar = await createRadar(owner, { name: `Quiet ${Math.random()}` });
    await share(radar.id, viewer, 'editor');
    const blip = await createBlip(owner, radar.id, { body: 'no chat please' });

    await createComment(viewer, blip.id, { body: 'first' });
    await updateRadar(owner, radar.id, { commentsEnabled: false });

    await expect(createComment(viewer, blip.id, { body: 'second' })).rejects.toThrow(/turned off/i);
    // Off means "no new ones", never "the old ones vanish" — that would read as
    // data loss rather than as a setting.
    const thread = await listComments(owner, blip.id);
    expect(thread.items).toHaveLength(1);
  });

  it('takes no comments on a template that declares none, whatever the radar switch says', async () => {
    const radar = await createRadar(owner, {
      name: `Reader ${Math.random()}`,
      template: 'reading',
    });
    const blip = await createBlip(owner, radar.id, { body: 'https://example.com/story' });

    // The radar's own switch is still on; the template's declaration wins, in the DTO and the write.
    const [row] = await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id));
    expect(row?.commentsEnabled).toBe(true);
    expect(radar.commentsEnabled).toBe(false);
    await expect(createComment(owner, blip.id, { body: 'hello' })).rejects.toThrow(/turned off/i);
    expect((await listComments(owner, blip.id)).items).toHaveLength(0);
  });

  it('reads the thread forwards, unlike every other list in the app', async () => {
    const radar = await createRadar(owner, { name: `Order ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'a conversation' });
    for (const body of ['first', 'second', 'third']) {
      await createComment(owner, blip.id, { body });
    }
    const thread = await listComments(owner, blip.id);
    expect(thread.items.map((c) => c.body)).toEqual(['first', 'second', 'third']);
  });

  it('lets the owner delete a comment but never edit one', async () => {
    const radar = await createRadar(owner, { name: `Moderated ${Math.random()}` });
    await share(radar.id, viewer, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'topic' });
    const comment = await createComment(viewer, blip.id, { body: 'something regrettable' });

    // Putting words in somebody's mouth is worse than removing them.
    await expect(updateComment(owner, comment.id, { body: 'something else' })).rejects.toThrow(
      /not found/i,
    );

    await deleteComment({ ...owner, viaCookie: true }, comment.id);
    expect((await listComments(owner, blip.id)).items).toHaveLength(0);
  });

  it('serves a published thread to an anonymous reader — but only via the slug', async () => {
    // The public surface has no actor, and a public link grants access *only*
    // when it is the identifier that was used. Resolving the radar by its uuid
    // therefore yields nothing, which silently 404'd the thread on every
    // published blip until the slug was threaded through.
    const radar = await createRadar(owner, { name: `Open ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'say something' });
    await createComment(owner, blip.id, { body: 'a public remark' });
    const published = await setVisibility(owner, radar.id, 'public');
    const slug = published.publicSlug;
    expect(slug).not.toBeNull();

    const thread = await listComments(null, blip.id, {}, slug ?? undefined);
    expect(thread.items.map((c) => c.body)).toEqual(['a public remark']);

    // The uuid is not the public identifier and must not become one.
    await expect(listComments(null, blip.id)).rejects.toThrow(/not found/i);
  });

  it('will not let one radar’s public slug open another radar’s thread', async () => {
    // A valid slug plus somebody else's blip id is the obvious way to try to
    // read a private conversation, so the service cross-checks that the radar
    // the reference resolved to is the radar the blip actually lives on.
    const open = await createRadar(owner, { name: `Decoy ${Math.random()}` });
    const published = await setVisibility(owner, open.id, 'public');
    const slug = published.publicSlug;
    expect(slug).not.toBeNull();

    const secret = await createRadar(owner, { name: `Secret ${Math.random()}` });
    const hidden = await createBlip(owner, secret.id, { body: 'not for you' });
    await createComment(owner, hidden.id, { body: 'private chatter' });

    await expect(listComments(null, hidden.id, {}, slug ?? undefined)).rejects.toThrow(
      /not found/i,
    );
  });

  it('counts the thread on the blip itself, for both transports', async () => {
    const radar = await createRadar(owner, { name: `Counted ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'count me' });
    await createComment(owner, blip.id, { body: 'one' });
    await createComment(owner, blip.id, { body: 'two' });

    expect((await getBlip(blip.id, owner)).commentCount).toBe(2);
  });
});

describe.skipIf(!hasDatabase)('reactions (real postgres)', () => {
  let owner: Actor;
  let viewer: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('reactor');
    viewer = await makeUser('reactor-viewer');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('toggles: on, then off, leaving nothing behind', async () => {
    const radar = await createRadar(owner, { name: `React ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'thoughts?' });

    const on = await setReaction(owner, blip.id, 'up');
    expect(on.reacted).toBe(true);
    expect(on.reactions).toEqual([
      expect.objectContaining({ reaction: 'up', count: 1, mine: true }),
    ]);

    const off = await setReaction(owner, blip.id, 'up');
    expect(off.reacted).toBe(false);
    expect(off.reactions).toEqual([]);
  });

  it('sets and clears idempotently, so a retry never undoes the mark it meant', async () => {
    const radar = await createRadar(owner, { name: `Retry ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'retry me' });

    for (let i = 0; i < 3; i += 1) {
      const set = await setReaction(owner, blip.id, 'up', true);
      expect(set.reacted).toBe(true);
      expect(set.reactions).toEqual([expect.objectContaining({ reaction: 'up', count: 1 })]);
    }
    for (let i = 0; i < 2; i += 1) {
      const cleared = await setReaction(owner, blip.id, 'up', false);
      expect(cleared.reacted).toBe(false);
      expect(cleared.reactions).toEqual([]);
    }
  });

  it('cannot produce two rows for one person and one mark, however it races', async () => {
    // The composite primary key is what decides this, not the service. Before
    // it, two clicks that interleaved between the read and the write would each
    // insert.
    const radar = await createRadar(owner, { name: `Race ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'click me twice' });

    await Promise.allSettled([
      setReaction(owner, blip.id, 'heart'),
      setReaction(owner, blip.id, 'heart'),
      setReaction(owner, blip.id, 'heart'),
    ]);

    const rows = await getDb()
      .select()
      .from(schema.blipReactions)
      .where(
        and(
          eq(schema.blipReactions.blipId, blip.id),
          eq(schema.blipReactions.userId, owner.user.id),
        ),
      );
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('tallies several people and marks `mine` per caller', async () => {
    const radar = await createRadar(owner, { name: `Tally ${Math.random()}` });
    await share(radar.id, viewer, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'agreed?' });

    await setReaction(owner, blip.id, 'up');
    const both = await setReaction(viewer, blip.id, 'up');

    expect(both.reactions).toEqual([
      expect.objectContaining({ reaction: 'up', count: 2, mine: true }),
    ]);
    // The same rows, read by somebody who never reacted.
    const stranger = await makeUser('tally-stranger');
    await share(radar.id, stranger, 'viewer');
    const seen = await getBlip(blip.id, stranger);
    expect(seen.reactions).toEqual([
      expect.objectContaining({ reaction: 'up', count: 2, mine: false }),
    ]);
  });

  it('refuses a mark the registry does not know, and says which are real', async () => {
    const radar = await createRadar(owner, { name: `Unknown ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'hmm' });
    await expect(setReaction(owner, blip.id, 'shrug')).rejects.toThrow(/not a reaction/i);
  });

  it('stops accepting marks when the owner turns them off', async () => {
    const radar = await createRadar(owner, { name: `No marks ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'serious business' });
    await updateRadar(owner, radar.id, { reactionsEnabled: false });
    await expect(setReaction(owner, blip.id, 'party')).rejects.toThrow(/turned off/i);
  });
});

describe.skipIf(!hasDatabase)('a blip that moves radar (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('takes its comments and reactions with it', async () => {
    // The denormalised radar_id on both tables is what authorizes and scopes
    // them. A stale one strands a comment on a radar its blip has left —
    // readable by the wrong people, invisible to the right ones.
    const actor = await makeUser('mover');
    const from = await createRadar(actor, { name: `From ${Math.random()}` });
    const to = await createRadar(actor, { name: `To ${Math.random()}` });
    const blip = await createBlip(actor, from.id, { body: 'filed wrongly' });

    await createComment(actor, blip.id, { body: 'this belongs elsewhere' });
    await setReaction(actor, blip.id, 'eyes');

    await updateBlip(actor, blip.id, { radarId: to.id });

    const comments = await getDb()
      .select()
      .from(schema.blipComments)
      .where(eq(schema.blipComments.blipId, blip.id));
    expect(comments.every((c) => c.radarId === to.id)).toBe(true);

    const reactions = await getDb()
      .select()
      .from(schema.blipReactions)
      .where(eq(schema.blipReactions.blipId, blip.id));
    expect(reactions.every((r) => r.radarId === to.id)).toBe(true);

    // And they are still on the blip where it now lives.
    const moved = await getBlip(blip.id, actor);
    expect(moved.radarId).toBe(to.id);
    expect(moved.commentCount).toBe(1);
    expect(moved.reactions).toHaveLength(1);
  });
});

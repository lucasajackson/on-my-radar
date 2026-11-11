/**
 * The discussion template: threaded replies, @mentions, and activity ordering.
 *
 * Every property here is one a mock cannot see, because each is a question about
 * which rows a query actually returns or which constraint actually fires:
 *
 * - **A thread is exactly one level deep.** Replying to a reply re-parents
 *   rather than nesting, which is the rule the whole layout rests on — and the
 *   one Slack found "an instant success on all fronts" after building the
 *   unbounded version first.
 * - **Deleting a comment promotes its replies rather than deleting them.**
 *   Moderation must not take somebody else's words with it, and the promotion is
 *   what keeps the one-level invariant true without a trigger.
 * - **The thread keyset is total across a page boundary**, including when a
 *   reply and its parent land on different pages.
 * - **A mention resolves only against people who can read the radar** — the
 *   property that makes mentioning incapable of widening access. A non-cascading
 *   topic grants nothing, so its members must not resolve.
 * - **Editing a body notifies only the newly addressed.** The case that decides
 *   mentions are stored rather than parsed at render time.
 * - **A mention does not coalesce**, and it suppresses the comment notification
 *   for the same person on the same comment.
 * - **A cascaded member is in the notification audience at all** — they were not,
 *   before this change.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { radarReaders } from './access.js';
import { createBlip, listBlips } from './blips.js';
import { createComment, deleteComment, listComments, updateComment } from './comments.js';
import { resolveMentions } from './mentions.js';
import { listNotifications } from './notifications.js';
import { createRadar, shareRadar } from './radars.js';
import { blockedBehind } from './lock-graph.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

let seq = 0;
async function makeUser(label: string, name?: string): Promise<Actor> {
  seq += 1;
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${seq}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      ...(name ? { name } : {}),
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

/** The local part of an address, which is the handle it answers to. */
function handleOf(actor: Actor): string {
  return actor.user.email.split('@')[0] ?? '';
}

async function discussionRadar(owner: Actor) {
  return createRadar(owner, { name: `Forum ${Math.random()}`, template: 'discussion' });
}

/**
 * The *activity* a person was told about, with access changes filtered out.
 *
 * `share`, `topic_share` and `topic_cascade` are deliberately not activity: they
 * are how somebody finds out a radar exists at all, and they reach a person even
 * at level `none`. Sharing a radar in order to set a test up would otherwise
 * show up in every assertion below as noise that says nothing about mentions.
 */
const ACCESS_KINDS = new Set(['share', 'topic_share', 'topic_cascade']);
async function kindsFor(actor: Actor): Promise<string[]> {
  const page = await listNotifications(actor, {});
  return page.items.map((item) => item.kind).filter((kind) => !ACCESS_KINDS.has(kind));
}

describe.skipIf(!hasDatabase)('discussion template (real postgres)', () => {
  let owner: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('d-owner');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ---------------------------- one level deep ---------------------------- */

  describe('a thread is exactly one level deep', () => {
    it('re-parents a reply to a reply rather than nesting it', async () => {
      const radar = await discussionRadar(owner);
      const thread = await createBlip(owner, radar.id, { body: 'What should we call it?' });

      const first = await createComment(owner, thread.id, { body: 'Beacon?' });
      expect(first.parentId).toBeNull();

      const second = await createComment(owner, thread.id, {
        body: 'I like that',
        parentId: first.id,
      });
      expect(second.parentId).toBe(first.id);

      // The one that matters: answering a reply lands beside it, not under it.
      const third = await createComment(owner, thread.id, {
        body: 'me too',
        parentId: second.id,
      });
      expect(third.parentId).toBe(first.id);
    });

    it('refuses a parent on another blip without saying which case it is', async () => {
      const radar = await discussionRadar(owner);
      const mine = await createBlip(owner, radar.id, { body: 'Mine' });
      const other = await createBlip(owner, radar.id, { body: 'Other' });
      const elsewhere = await createComment(owner, other.id, { body: 'over here' });

      await expect(
        createComment(owner, mine.id, { body: 'nope', parentId: elsewhere.id }),
      ).rejects.toThrow(/not found/i);
    });

    it('promotes replies when their parent is deleted, rather than deleting them', async () => {
      const radar = await discussionRadar(owner);
      const thread = await createBlip(owner, radar.id, { body: 'Topic' });
      const parent = await createComment(owner, thread.id, { body: 'a remark' });
      const reply = await createComment(owner, thread.id, {
        body: 'an answer to it',
        parentId: parent.id,
      });

      await deleteComment({ ...owner, viaCookie: true }, parent.id);

      const page = await listComments(owner, thread.id);
      const surviving = page.items.find((item) => item.id === reply.id);
      // Somebody else's words survive a moderator removing what they answered.
      expect(surviving).toBeTruthy();
      // ...and promotion is what keeps "a parent is always top level" true.
      expect(surviving?.parentId).toBeNull();
    });

    it('authorises a comment delete against the radar the thread is on now', async () => {
      // `owner` moderates the source radar; Ada writes there and owns another
      // radar `owner` cannot read. Ada moves her thread across while the
      // moderator's delete is in flight.
      const ada = await makeUser('d-ada');
      const source = await discussionRadar(owner);
      await shareRadar(owner, source.id, ada.user.email, 'editor');
      const elsewhere = await discussionRadar(ada);
      const thread = await createBlip(ada, source.id, { body: 'moving soon' });
      const remark = await createComment(ada, thread.id, { body: 'mine' });

      const mover = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await mover.connect();
      try {
        // The move as `updateBlip` makes it — blip locked, comments re-pointed —
        // held open so the delete arrives in the middle of it.
        await mover.query('BEGIN');
        await mover.query('SELECT 1 FROM blips WHERE id = $1 FOR UPDATE', [thread.id]);
        await mover.query('UPDATE blip_comments SET radar_id = $1 WHERE blip_id = $2', [
          elsewhere.id,
          thread.id,
        ]);
        await mover.query('UPDATE blips SET radar_id = $1 WHERE id = $2', [
          elsewhere.id,
          thread.id,
        ]);
        const removal = deleteComment(owner, remark.id);
        removal.catch(() => undefined);
        await expect
          .poll(async () => blockedBehind(mover), { timeout: 3_000 })
          .toBeGreaterThanOrEqual(1);
        await mover.query('COMMIT');
        await expect(removal).rejects.toMatchObject({ status: 404 });
      } finally {
        await mover.end();
      }
      const kept = await getDb()
        .select({ id: schema.blipComments.id })
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, remark.id));
      expect(kept).toHaveLength(1);
    });

    it('answers a reply to a parent deleted mid-request with a 404, not a 500', async () => {
      const radar = await discussionRadar(owner);
      const thread = await createBlip(owner, radar.id, { body: 'Going' });
      const parent = await createComment(owner, thread.id, { body: 'about to go' });
      // The delete is in flight — row locked, not yet committed — when the reply
      // arrives; it commits while the reply waits on it.
      const deleter = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await deleter.connect();
      try {
        await deleter.query('BEGIN');
        await deleter.query('DELETE FROM blip_comments WHERE id = $1', [parent.id]);
        const reply = createComment(owner, thread.id, { body: 'too late', parentId: parent.id });
        reply.catch(() => undefined);
        await expect
          .poll(async () => blockedBehind(deleter), { timeout: 3_000 })
          .toBeGreaterThanOrEqual(1);
        await deleter.query('COMMIT');
        await expect(reply).rejects.toMatchObject({ status: 404, message: 'Comment not found' });
      } finally {
        await deleter.end();
      }
    });
  });

  /* ------------------------------ ordering -------------------------------- */

  describe('thread ordering', () => {
    it('reads each reply directly under the remark it answers', async () => {
      const radar = await discussionRadar(owner);
      const thread = await createBlip(owner, radar.id, { body: 'Ordering' });

      const a = await createComment(owner, thread.id, { body: 'A' });
      const b = await createComment(owner, thread.id, { body: 'B' });
      await createComment(owner, thread.id, { body: 'A1', parentId: a.id });
      await createComment(owner, thread.id, { body: 'B1', parentId: b.id });
      await createComment(owner, thread.id, { body: 'A2', parentId: a.id });

      const page = await listComments(owner, thread.id);
      // Not creation order — A2 was written last and still reads under A.
      expect(page.items.map((item) => item.body)).toEqual(['A', 'A1', 'A2', 'B', 'B1']);
    });

    it('pages a nested thread without duplicating or skipping a row', async () => {
      const radar = await discussionRadar(owner);
      const thread = await createBlip(owner, radar.id, { body: 'Paging' });

      const roots = [];
      for (let i = 0; i < 4; i += 1) {
        const root = await createComment(owner, thread.id, { body: `root-${i}` });
        roots.push(root);
        for (let j = 0; j < 2; j += 1) {
          await createComment(owner, thread.id, { body: `reply-${i}-${j}`, parentId: root.id });
        }
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      // A page size of 2 forces a boundary inside a sub-thread, which is the
      // case a flat cursor would get wrong.
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await listComments(owner, thread.id, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((item) => item.body));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toEqual([
        'root-0',
        'reply-0-0',
        'reply-0-1',
        'root-1',
        'reply-1-0',
        'reply-1-1',
        'root-2',
        'reply-2-0',
        'reply-2-1',
        'root-3',
        'reply-3-0',
        'reply-3-1',
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    }, 30_000);

    it('pages a FLAT thread without repeating its boundary row', async () => {
      // A regression test for a bug that shipped with comments and predates
      // threading entirely: the cursor carried `Date.toISOString()`, which is
      // millisecond precision, while `timestamptz` holds microseconds. The
      // truncated value names an instant just before the row it came from, and a
      // thread reads forwards with `>` — so the boundary row satisfied the
      // comparison again and every page served it a second time. Paging five
      // comments two at a time produced c0,c1,c1,c2,c2,c3,c3,c4,c4,c4…
      //
      // Nothing nested here on purpose: this is the shape that was already
      // broken, so it has to be asserted on its own rather than only inside the
      // nested case that found it.
      const radar = await createRadar(owner, { name: `Flat ${Math.random()}` });
      const blip = await createBlip(owner, radar.id, { body: 'Flat thread' });
      for (let i = 0; i < 5; i += 1) {
        await createComment(owner, blip.id, { body: `c${i}` });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await listComments(owner, blip.id, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((item) => item.body));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    }, 30_000);

    it('floats the thread that was answered most recently to the top', async () => {
      const radar = await discussionRadar(owner);
      const first = await createBlip(owner, radar.id, { body: 'Asked first' });
      const second = await createBlip(owner, radar.id, { body: 'Asked second' });

      // Capture order would put the newer thread on top...
      let page = await listBlips([radar.id], {}, null, owner.user.id, { template: 'discussion' });
      expect(page.items[0]?.id).toBe(second.id);

      // ...and answering the older one is what a forum sorts on.
      await createComment(owner, first.id, { body: 'here is an answer' });
      page = await listBlips([radar.id], {}, null, owner.user.id, { template: 'discussion' });
      expect(page.items[0]?.id).toBe(first.id);
      expect(page.items[0]?.lastActivityAt).not.toBe(page.items[0]?.createdAt);
    });

    it('sinks a resolved thread below every open one, however recent', async () => {
      const radar = await discussionRadar(owner);
      const settled = await createBlip(owner, radar.id, { body: 'Settled', status: 'resolved' });
      const live = await createBlip(owner, radar.id, { body: 'Still going' });
      // Reply to the resolved one so it is also the most recently active.
      await createComment(owner, settled.id, { body: 'one last word' });

      const page = await listBlips([radar.id], {}, null, owner.user.id, { template: 'discussion' });
      const ids = page.items.map((item) => item.id);
      expect(ids.indexOf(live.id)).toBeLessThan(ids.indexOf(settled.id));
    });
  });

  /* ------------------------------- mentions ------------------------------- */

  describe('who a mention can name', () => {
    it('resolves somebody the radar is shared with', async () => {
      const guest = await makeUser('d-guest');
      const radar = await discussionRadar(owner);
      await shareRadar(owner, radar.id, guest.user.email, 'viewer');

      const readers = await radarReaders({ ...radar, topicId: null } as never);
      expect(readers.map((r) => r.id)).toContain(guest.user.id);

      const resolved = await resolveMentions(
        { ...radar, topicId: null } as never,
        `what do you think @${handleOf(guest)}?`,
      );
      expect(resolved.resolved.map((m) => m.target.userId)).toEqual([guest.user.id]);
      expect(resolved.unknown).toEqual([]);
    });

    it('does NOT resolve a member of a non-cascading topic', async () => {
      // The trap the topic permission model sets: topic membership is not radar
      // access, so offering these people would suggest notifying somebody about
      // a conversation they cannot open.
      const grouped = await makeUser('d-grouped');
      const topic = await createTopic(owner, { name: `Foundation ${Math.random()}` });
      const radar = await discussionRadar(owner);
      await setRadarTopic(owner, radar.id, topic.id);
      await shareTopic(owner, topic.id, grouped.user.email, 'editor');

      const [row] = await getDb()
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.id, radar.id));
      const resolved = await resolveMentions(row as never, `hello @${handleOf(grouped)}`);
      expect(resolved.resolved).toEqual([]);
      expect(resolved.unknown).toEqual([handleOf(grouped)]);
    });

    it('DOES resolve them once the topic cascades', async () => {
      const grouped = await makeUser('d-cascaded');
      const topic = await createTopic(owner, { name: `Cascading ${Math.random()}` });
      const radar = await discussionRadar(owner);
      await setRadarTopic(owner, radar.id, topic.id);
      await shareTopic(owner, topic.id, grouped.user.email, 'editor');
      await setCascade(owner, topic.id, true);

      const [row] = await getDb()
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.id, radar.id));
      const resolved = await resolveMentions(row as never, `hello @${handleOf(grouped)}`);
      expect(resolved.resolved.map((m) => m.target.userId)).toEqual([grouped.user.id]);
    });

    it('leaves a stranger unresolved — mentioning cannot widen access', async () => {
      const stranger = await makeUser('d-stranger');
      const radar = await discussionRadar(owner);
      const thread = await createBlip(owner, radar.id, { body: 'Private thinking' });

      await createComment(owner, thread.id, { body: `psst @${handleOf(stranger)}` });

      // No row was written, so nothing was notified and nothing was granted.
      const rows = await getDb()
        .select()
        .from(schema.mentions)
        .where(eq(schema.mentions.userId, stranger.user.id));
      expect(rows).toEqual([]);
      expect(await kindsFor(stranger)).toEqual([]);
    });

    it('does not read an email address in the body as a mention', async () => {
      const radar = await discussionRadar(owner);
      const [row] = await getDb()
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.id, radar.id));
      const resolved = await resolveMentions(row as never, `write to ${owner.user.email}`);
      expect(resolved.resolved).toEqual([]);
      expect(resolved.unknown).toEqual([]);
    });

    it('does not read a handle inside code as a mention', async () => {
      const radar = await discussionRadar(owner);
      const [row] = await getDb()
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.id, radar.id));
      const resolved = await resolveMentions(
        row as never,
        'use `@media` and\n```\n@import "x";\n```\n',
      );
      expect(resolved.resolved).toEqual([]);
      expect(resolved.unknown).toEqual([]);
    });
  });

  /* ---------------------------- notifications ----------------------------- */

  describe('what a mention notifies', () => {
    it('tells somebody who is neither the author nor in the thread', async () => {
      const bystander = await makeUser('d-bystander');
      const radar = await discussionRadar(owner);
      await shareRadar(owner, radar.id, bystander.user.email, 'viewer');
      const thread = await createBlip(owner, radar.id, { body: 'A question' });

      await createComment(owner, thread.id, { body: `any idea @${handleOf(bystander)}?` });

      // The gap this whole feature exists to close: before mentions there was no
      // way to reach this person short of turning the radar up to `all`.
      expect(await kindsFor(bystander)).toEqual(['mention']);
    });

    it('sends one line, not two, when the person is also the blip author', async () => {
      const author = await makeUser('d-author');
      const radar = await discussionRadar(author);
      await shareRadar(author, radar.id, owner.user.email, 'editor');
      const thread = await createBlip(author, radar.id, { body: 'My thread' });

      await createComment(owner, thread.id, { body: `over to you @${handleOf(author)}` });

      // Being named is the stronger sentence, so the comment fan-out stays quiet.
      expect(await kindsFor(author)).toEqual(['mention']);
    });

    it('does not fold two mentions into one line', async () => {
      const named = await makeUser('d-named');
      const radar = await discussionRadar(owner);
      await shareRadar(owner, radar.id, named.user.email, 'viewer');
      const thread = await createBlip(owner, radar.id, { body: 'Twice' });

      await createComment(owner, thread.id, { body: `first @${handleOf(named)}` });
      await createComment(owner, thread.id, { body: `second @${handleOf(named)}` });

      // Ten reactions on one blip is one fact; two mentions are two addresses,
      // and folding them would lose which two.
      const page = await listNotifications(named, {});
      const mentions = page.items.filter((item) => item.kind === 'mention');
      expect(mentions).toHaveLength(2);
      expect(mentions.every((item) => item.count === 1)).toBe(true);
    });

    it('stays silent on a radar the person has muted', async () => {
      const muted = await makeUser('d-muted');
      const radar = await discussionRadar(owner);
      await shareRadar(owner, radar.id, muted.user.email, 'viewer');
      await getDb().insert(schema.radarNotificationPrefs).values({
        userId: muted.user.id,
        radarId: radar.id,
        level: 'none',
      });
      const thread = await createBlip(owner, radar.id, { body: 'Muted radar' });

      await createComment(owner, thread.id, { body: `hey @${handleOf(muted)}` });

      // A mute a colleague can defeat by typing your name is not a mute.
      expect(await kindsFor(muted)).toEqual([]);
    });

    it('notifies only the newly addressed when a body is edited', async () => {
      const first = await makeUser('d-edit-first');
      const second = await makeUser('d-edit-second');
      const radar = await discussionRadar(owner);
      await shareRadar(owner, radar.id, first.user.email, 'viewer');
      await shareRadar(owner, radar.id, second.user.email, 'viewer');
      const thread = await createBlip(owner, radar.id, { body: 'Editing' });

      const comment = await createComment(owner, thread.id, { body: `hi @${handleOf(first)}` });
      expect(await kindsFor(first)).toEqual(['mention']);

      await updateComment({ ...owner, viaCookie: true }, comment.id, {
        body: `hi @${handleOf(first)} and @${handleOf(second)}`,
      });

      // The case that decides mentions are stored rather than parsed at render
      // time: the person already named must not be told twice.
      //
      // Asserted on `count` rather than on the list, because the notification
      // stays listed once read — and because a second `notifyMention` for the
      // same comment would land on the same group key and fold, bumping the
      // count to 2. So `count === 1` is exactly the statement "nothing was sent
      // the second time", which is what `reconcileMentions` returning only the
      // newly addressed is for.
      const firstPage = await listNotifications(first, {});
      const theirs = firstPage.items.filter((item) => item.kind === 'mention');
      expect(theirs).toHaveLength(1);
      expect(theirs[0]?.count).toBe(1);

      expect(await kindsFor(second)).toEqual(['mention']);
    });

    it('drops the row when a mention is edited out', async () => {
      const named = await makeUser('d-removed');
      const radar = await discussionRadar(owner);
      await shareRadar(owner, radar.id, named.user.email, 'viewer');
      const thread = await createBlip(owner, radar.id, { body: 'Removal' });
      const comment = await createComment(owner, thread.id, { body: `hi @${handleOf(named)}` });

      await updateComment({ ...owner, viaCookie: true }, comment.id, { body: 'never mind' });

      const rows = await getDb()
        .select()
        .from(schema.mentions)
        .where(eq(schema.mentions.commentId, comment.id));
      expect(rows).toEqual([]);
    });
  });

  /* ------------------------- the audience bug fix -------------------------- */

  it('notifies a member who reaches the radar only through a cascade', async () => {
    // This did not work before `audience` grew the topic leg: the person could
    // read the radar, comment on it and be named in it, and heard nothing.
    const cascaded = await makeUser('d-cascade-notify');
    const topic = await createTopic(owner, { name: `Notify ${Math.random()}` });
    const radar = await discussionRadar(owner);
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, cascaded.user.email, 'editor');
    await setCascade(owner, topic.id, true);

    const thread = await createBlip(cascaded, radar.id, { body: 'Started by the guest' });
    await createComment(owner, thread.id, { body: 'answering the guest' });

    expect(await kindsFor(cascaded)).toContain('comment');
  });

  /* ------------------------ mentions in a blip body ------------------------ */

  it('addresses somebody from the opening post, not only from a reply', async () => {
    const named = await makeUser('d-opening');
    const radar = await discussionRadar(owner);
    await shareRadar(owner, radar.id, named.user.email, 'viewer');

    const thread = await createBlip(owner, radar.id, {
      body: `Kicking this off — @${handleOf(named)} you had thoughts?`,
    });

    const rows = await getDb()
      .select()
      .from(schema.mentions)
      .where(and(eq(schema.mentions.blipId, thread.id), eq(schema.mentions.userId, named.user.id)));
    expect(rows).toHaveLength(1);
    expect(await kindsFor(named)).toEqual(['mention']);
  });
});

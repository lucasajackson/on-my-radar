/**
 * `mentions.radar_id`: the column that scopes a mention, and what has to happen
 * to it when the content moves or the access goes away.
 *
 * `drizzle/0008_threads_and_mentions.sql` named the failure before it happened —
 * "re-deriving it through two joins on every read is how a mention ends up
 * stranded on a radar its blip has left" — and then `updateBlip` moved
 * `attachments`, `blip_comments` and `blip_reactions` on a radar change and left
 * `mentions` behind.
 *
 * Two defects, and the second is the one that shows:
 *
 * - **The revocation sweep filters on that column**, so it missed exactly the
 *   mentions that had moved. Worse, `dropRadarMentions` had **no caller at
 *   all** — the sweep its own docstring calls the counterpart to
 *   `dropRadarNotifications` never ran, on any path. So the tests below drive
 *   `removeMember` and the topic paths rather than calling the sweep directly:
 *   a suite that called it would have passed throughout, which is precisely how
 *   this hid.
 * - **`mentions.radar_id` is `ON DELETE CASCADE` on `radars`.** With the column
 *   left pointing at the old radar, deleting *that* radar strips the mentions
 *   off blips that now live somewhere else entirely — an `@ada` that stops
 *   resolving because of something that happened to a radar the blip is no
 *   longer in. That one is asserted directly, because it is visible without any
 *   sharing at all.
 *
 * And the third, found by the same reading: `setRadarTopic` swept on withdrawal
 * and not on a **move**, so a radar moved from one cascading topic to another
 * left the first topic's members holding what they could no longer open.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip, updateBlip } from './blips.js';
import { createComment } from './comments.js';
import { createRadar, deleteRadar, removeMember, shareRadar } from './radars.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

let seq = 0;

async function makeUser(label: string): Promise<Actor> {
  seq += 1;
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${seq}-${Date.now()}@example.test`,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

/** The handle `@…` that resolves to this person, as `services/mentions.ts` derives it. */
function handleOf(actor: Actor): string {
  return actor.user.email.split('@')[0] ?? '';
}

async function mentionRows(userId: string) {
  return getDb()
    .select({
      id: schema.mentions.id,
      radarId: schema.mentions.radarId,
      blipId: schema.mentions.blipId,
      commentId: schema.mentions.commentId,
    })
    .from(schema.mentions)
    .where(eq(schema.mentions.userId, userId));
}

describe.skipIf(!hasDatabase)('mentions follow their content (real postgres)', () => {
  let owner: Actor;
  let mentioned: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('ms-owner');
    mentioned = await makeUser('ms-mentioned');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ---------------------------- moving a blip ----------------------------- */

  it('carries a mention to the radar its blip moved to, on the body and on its comments', async () => {
    const from = await createRadar(owner, { name: `From ${Math.random()}` });
    const to = await createRadar(owner, { name: `To ${Math.random()}` });
    for (const radar of [from, to]) {
      await shareRadar(owner, radar.id, mentioned.user.email, 'viewer');
    }

    const blip = await createBlip(owner, from.id, { body: `hey @${handleOf(mentioned)}` });
    await createComment(owner, blip.id, { body: `and again @${handleOf(mentioned)}` });

    const before = await mentionRows(mentioned.user.id);
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.radarId === from.id)).toBe(true);
    // One on the blip body, one on the comment — both carry the column.
    expect(before.filter((row) => row.blipId !== null)).toHaveLength(1);
    expect(before.filter((row) => row.commentId !== null)).toHaveLength(1);

    await updateBlip(owner, blip.id, { radarId: to.id });

    const after = await mentionRows(mentioned.user.id);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.radarId === to.id)).toBe(true);
  });

  it('drops a comment’s mention of somebody the destination does not admit, and its notification', async () => {
    const xavier = await makeUser('ms-xavier');
    const from = await createRadar(owner, { name: `Shared ${Math.random()}` });
    const to = await createRadar(owner, { name: `Private ${Math.random()}` });
    await shareRadar(owner, from.id, xavier.user.email, 'viewer');
    const blip = await createBlip(owner, from.id, { body: `hey @${handleOf(xavier)}` });
    await createComment(owner, blip.id, { body: `and in the thread @${handleOf(xavier)}` });
    expect(await mentionRows(xavier.user.id)).toHaveLength(2);
    const inbox = () =>
      getDb()
        .select({ radarId: schema.notifications.radarId })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, xavier.user.id),
            eq(schema.notifications.blipId, blip.id),
          ),
        );
    expect((await inbox()).length).toBeGreaterThan(0);

    await updateBlip(owner, blip.id, { radarId: to.id });

    // The body's mention was re-resolved; the comment's must not survive either,
    // or the thread on `to` would name Xavier to everyone who can read it.
    expect(await mentionRows(xavier.user.id)).toEqual([]);
    // And the excerpts follow the blip, so the list — which shows a
    // notification only while its radar is readable — no longer shows them.
    expect((await inbox()).every((row) => row.radarId === to.id)).toBe(true);
  });

  it('does not lose a moved mention when the radar it left is deleted', async () => {
    const from = await createRadar(owner, { name: `Doomed ${Math.random()}` });
    const to = await createRadar(owner, { name: `Kept ${Math.random()}` });
    for (const radar of [from, to]) {
      await shareRadar(owner, radar.id, mentioned.user.email, 'viewer');
    }
    const blip = await createBlip(owner, from.id, { body: `moving @${handleOf(mentioned)}` });
    await updateBlip(owner, blip.id, { radarId: to.id });

    // `mentions.radar_id` is ON DELETE CASCADE, so a stale value here means the
    // mention is destroyed by a delete that has nothing to do with its blip.
    await deleteRadar(owner, from.id);

    const rows = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(rows).toHaveLength(1);
  });

  /* --------------------------- revoking access ---------------------------- */

  it('drops the mentions when a member is removed, through removeMember itself', async () => {
    const radar = await createRadar(owner, { name: `Revoke ${Math.random()}` });
    await shareRadar(owner, radar.id, mentioned.user.email, 'editor');
    const blip = await createBlip(owner, radar.id, { body: `hello @${handleOf(mentioned)}` });

    const before = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(before).toHaveLength(1);

    // Driven through the service, not by calling the sweep: the whole defect
    // was that nothing called it.
    await removeMember(owner, radar.id, mentioned.user.id);

    const after = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(after).toEqual([]);
  });

  it('keeps the mentions and notifications of a removed member who still reads through a topic', async () => {
    const both = await makeUser('both');
    const topic = await createTopic(owner, { name: `Both ways ${Math.random()}` });
    await setCascade(owner, topic.id, true);
    const radar = await createRadar(owner, { name: `Both ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, both.user.email, 'viewer');
    await shareRadar(owner, radar.id, both.user.email, 'editor');
    const blip = await createBlip(owner, radar.id, { body: `ping @${handleOf(both)}` });
    const notified = () =>
      getDb()
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, both.user.id),
            eq(schema.notifications.radarId, radar.id),
          ),
        );
    expect(await notified()).not.toHaveLength(0);

    // The direct grant goes; the cascading topic grant stays, so the radar is
    // still theirs to read — and so is what it told them.
    await removeMember(owner, radar.id, both.user.id);

    expect((await mentionRows(both.user.id)).map((m) => m.blipId)).toEqual([blip.id]);
    expect(await notified()).not.toHaveLength(0);
  });

  it('sweeps a mention on a radar moved out of a cascading topic', async () => {
    const cascading = await createTopic(owner, { name: `Cascading ${Math.random()}` });
    const plain = await createTopic(owner, { name: `Plain ${Math.random()}` });
    await setCascade(owner, cascading.id, true);

    const radar = await createRadar(owner, { name: `Moved ${Math.random()}` });
    await setRadarTopic(owner, radar.id, cascading.id);
    await shareTopic(owner, cascading.id, mentioned.user.email, 'editor');

    const blip = await createBlip(owner, radar.id, { body: `cascaded @${handleOf(mentioned)}` });
    const before = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(before).toHaveLength(1);

    // A **move**, not a withdrawal. This branch did not sweep at all.
    await setRadarTopic(owner, radar.id, plain.id);

    const after = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(after).toEqual([]);
  });

  it('sweeps the notifications on that same move, not only the mentions', async () => {
    const cascading = await createTopic(owner, { name: `Notify ${Math.random()}` });
    const plain = await createTopic(owner, { name: `Elsewhere ${Math.random()}` });
    await setCascade(owner, cascading.id, true);

    const radar = await createRadar(owner, { name: `Loud ${Math.random()}` });
    await setRadarTopic(owner, radar.id, cascading.id);
    await shareTopic(owner, cascading.id, mentioned.user.email, 'editor');
    // Addressed to them, so a notification is written whatever the radar's
    // level is set to — the point here is the notification, not the mention.
    await createBlip(owner, radar.id, { body: `worth reading @${handleOf(mentioned)}` });

    const before = await getDb()
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, mentioned.user.id),
          eq(schema.notifications.radarId, radar.id),
        ),
      );
    expect(before.length).toBeGreaterThan(0);

    await setRadarTopic(owner, radar.id, plain.id);

    const after = await getDb()
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, mentioned.user.id),
          eq(schema.notifications.radarId, radar.id),
        ),
      );
    expect(after).toEqual([]);
  });

  it('keeps what somebody still reaches after a move between two cascading topics', async () => {
    const first = await createTopic(owner, { name: `First ${Math.random()}` });
    const second = await createTopic(owner, { name: `Second ${Math.random()}` });
    await setCascade(owner, first.id, true);
    await setCascade(owner, second.id, true);

    const radar = await createRadar(owner, { name: `Shuffled ${Math.random()}` });
    await setRadarTopic(owner, radar.id, first.id);
    await shareTopic(owner, first.id, mentioned.user.email, 'editor');
    await shareTopic(owner, second.id, mentioned.user.email, 'editor');

    const blip = await createBlip(owner, radar.id, { body: `still here @${handleOf(mentioned)}` });
    await setRadarTopic(owner, radar.id, second.id);

    // They cascade on the destination too, so the move cost them nothing and
    // sweeping them would read as data loss rather than as revocation.
    const after = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(after).toHaveLength(1);
  });

  it('keeps a mention when the person has their own grant as well as the topic', async () => {
    const topic = await createTopic(owner, { name: `Both ${Math.random()}` });
    await setCascade(owner, topic.id, true);
    const radar = await createRadar(owner, { name: `Direct ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, mentioned.user.email, 'viewer');
    await shareRadar(owner, radar.id, mentioned.user.email, 'editor');

    const blip = await createBlip(owner, radar.id, { body: `direct @${handleOf(mentioned)}` });
    await setRadarTopic(owner, radar.id, null);

    // A direct grant survives topic revocation — so the mention does too.
    const after = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, mentioned.user.id), eq(schema.mentions.blipId, blip.id)),
      );
    expect(after).toHaveLength(1);
  });
});

/**
 * Topics and the cascade, against a real Postgres.
 *
 * This is the sharing seam, so every property here is one that decides whether
 * the feature is safe to ship — and not one of them is visible to a mock,
 * because each is a question about which rows a query actually returns:
 *
 * - **A topic grant is not a radar grant.** Sharing a topic with somebody must
 *   hand over no radar at all until cascading is deliberately switched on. This
 *   is the literal ask, and getting it wrong is a silent disclosure of every
 *   radar in the topic.
 * - **Effective permission is the most-permissive union**, and a **direct grant
 *   survives topic revocation**. If it did not, revoking a topic grant would
 *   take away access somebody was given separately and deliberately, which makes
 *   revocation something nobody can reason about at the moment they need to.
 * - **The cascade is exactly reversible.** Turning it on writes no membership
 *   rows and turning it off deletes none, so no direct grant is overwritten
 *   going on and none is stranded coming off. A materialised cascade cannot
 *   have both of those properties, which is why this one is computed.
 * - **A cascade never confers manage.** `CASCADE_GRANTS` has no 'owner' in its
 *   range, so the widest possible topic grant still cannot delete a radar,
 *   publish it, or share it onward.
 * - **The two exclusions are real refusals**, not hidden UI controls: the drop
 *   box and smart radars are refused by the service *and* by a CHECK
 *   constraint. An agent over MCP will try both.
 * - **Deleting a topic orphans nothing.** The radars survive, topicless, with
 *   their own member lists untouched.
 * - **Cascaded access reaches every surface**, not just the one it was written
 *   for. A radar someone reaches through a cascade has to appear in the radar
 *   list, in `readableRadarIds` (which scopes search and every smart radar) and
 *   in the member list — a divergence between those is the same class of bug as
 *   an MCP tool disagreeing with a REST route.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { LIMITS } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { getRadarAccess, readableRadarIds, requireRadar, requireTopic } from './access.js';
import {
  createRadar,
  createSmartRadar,
  ensureDropBox,
  listMembers,
  listRadars,
  shareRadar,
  updateRadar,
} from './radars.js';
import {
  createTopic,
  deleteTopic,
  listTopicMembers,
  listTopics,
  removeTopicMember,
  setCascade,
  setRadarTopic,
  shareTopic,
} from './topics.js';

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
 * The name of the CHECK constraint a raw update trips, or null if it succeeds.
 *
 * `pg` puts the constraint name on the error object; Drizzle re-throws its own
 * wrapper around it, so the name is reachable only through `cause`. Naming it
 * explicitly is what makes the assertion mean "this specific rule refused it"
 * rather than "something went wrong".
 */
async function constraintViolated(radarId: string, topicId: string): Promise<string | null> {
  try {
    await getDb().update(schema.radars).set({ topicId }).where(eq(schema.radars.id, radarId));
    return null;
  } catch (err) {
    let cursor: unknown = err;
    for (let depth = 0; depth < 5 && cursor; depth += 1) {
      const named = (cursor as { constraint?: string }).constraint;
      if (typeof named === 'string') return named;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    throw err;
  }
}

/** The effective role the authorization layer actually hands out. */
async function roleOn(radarId: string, actor: Actor): Promise<string | null> {
  const access = await getRadarAccess(radarId, actor);
  return access?.canRead ? (access.role ?? null) : null;
}

describe.skipIf(!hasDatabase)('topic sharing (real postgres)', () => {
  let owner: Actor;
  let member: Actor;
  let stranger: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('t-owner');
    member = await makeUser('t-member');
    stranger = await makeUser('t-stranger');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* --------------------------- the central rule --------------------------- */

  it('sharing a topic grants NO access to the radars in it', async () => {
    const topic = await createTopic(owner, { name: `Foundation ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Kanban ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);

    const result = await shareTopic(owner, topic.id, member.user.email, 'editor');
    expect(result.status).toBe('added');
    // The number the caller is handed says so out loud, which is what an agent
    // reports back to the person who asked.
    expect(result.radarsGranted).toBe(0);

    // They can see the topic...
    await expect(requireTopic(topic.id, member, 'read')).resolves.toBeTruthy();
    // ...and nothing inside it. A radar they cannot read is a 404, not a 403.
    expect(await roleOn(radar.id, member)).toBeNull();
    await expect(requireRadar(radar.id, member, 'read')).rejects.toThrow(/not found/i);
    expect(await readableRadarIds(member.user.id)).not.toContain(radar.id);
  });

  it('a topic member sees only the radars in it they can already reach', async () => {
    const topic = await createTopic(owner, { name: `Split ${Math.random()}` });
    const shared = await createRadar(owner, { name: `Shared ${Math.random()}` });
    const secret = await createRadar(owner, { name: `Secret ${Math.random()}` });
    await setRadarTopic(owner, shared.id, topic.id);
    await setRadarTopic(owner, secret.id, topic.id);

    await shareTopic(owner, topic.id, member.user.email, 'viewer');
    // One radar shared directly — the "one radar in the topic is only shared to
    // certain members of the group" case, in as many words.
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: shared.id, userId: member.user.id, role: 'viewer' });

    const theirs = await listRadars(member);
    const ids = theirs.map((r) => r.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(secret.id);

    // The count on the topic is what THEY can read, not what it holds. Saying
    // "2" would tell them a radar exists that they cannot open, and a radar's
    // name is content.
    const [theirTopic] = (await listTopics(member)).filter((t) => t.id === topic.id);
    expect(theirTopic?.radarCount).toBe(1);
  });

  /* ------------------------------- cascading ------------------------------ */

  it('cascading grants the topic role on every radar, and covers radars added later', async () => {
    const topic = await createTopic(owner, { name: `Cascade ${Math.random()}` });
    const first = await createRadar(owner, { name: `First ${Math.random()}` });
    await setRadarTopic(owner, first.id, topic.id);
    await shareTopic(owner, topic.id, member.user.email, 'editor');

    expect(await roleOn(first.id, member)).toBeNull();

    await setCascade(owner, topic.id, true);
    expect(await roleOn(first.id, member)).toBe('editor');

    // Added afterwards. Nothing had to be reconciled, because nothing was ever
    // written — which is the whole argument for computing the overlay.
    const later = await createRadar(owner, { name: `Later ${Math.random()}` });
    await setRadarTopic(owner, later.id, topic.id);
    expect(await roleOn(later.id, member)).toBe('editor');
    expect(await readableRadarIds(member.user.id)).toContain(later.id);
  });

  it('a viewer on a cascading topic gets viewer, not editor', async () => {
    const topic = await createTopic(owner, { name: `Readonly ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Board ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, member.user.email, 'viewer');
    await setCascade(owner, topic.id, true);

    const access = await requireRadar(radar.id, member, 'read');
    expect(access.role).toBe('viewer');
    expect(access.canWrite).toBe(false);
    expect(access.via).toBe('topic');
  });

  it('a cascade never confers manage, however wide the topic grant', async () => {
    const topic = await createTopic(owner, { name: `NoManage ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Precious ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, member.user.email, 'editor');
    await setCascade(owner, topic.id, true);

    const access = await requireRadar(radar.id, member, 'read');
    expect(access.canWrite).toBe(true);
    // The line that stops the cascade switch reaching access itself: an editor
    // through a topic can capture into the radar and cannot delete it, publish
    // it, or share it onward.
    expect(access.canManage).toBe(false);
    await expect(requireRadar(radar.id, member, 'manage')).rejects.toThrow(/only the owner/i);
  });

  /* ------------------- union, and what revocation removes ----------------- */

  it('a direct editor grant is not demoted by a viewer grant on the topic', async () => {
    const topic = await createTopic(owner, { name: `Union ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Both ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: member.user.id, role: 'editor' });
    await shareTopic(owner, topic.id, member.user.email, 'viewer');
    await setCascade(owner, topic.id, true);

    const access = await requireRadar(radar.id, member, 'read');
    // Most permissive wins. The narrower grant was the deliberate one; having a
    // container silently demote it is not something anybody would predict.
    expect(access.role).toBe('editor');
    expect(access.directRole).toBe('editor');
    expect(access.topicRole).toBe('viewer');
    expect(access.via).toBe('member');
  });

  it('revoking the topic grant leaves a direct radar grant standing', async () => {
    const topic = await createTopic(owner, { name: `Revoke ${Math.random()}` });
    const kept = await createRadar(owner, { name: `Kept ${Math.random()}` });
    const lost = await createRadar(owner, { name: `Lost ${Math.random()}` });
    await setRadarTopic(owner, kept.id, topic.id);
    await setRadarTopic(owner, lost.id, topic.id);
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: kept.id, userId: member.user.id, role: 'editor' });
    await shareTopic(owner, topic.id, member.user.email, 'editor');
    await setCascade(owner, topic.id, true);

    expect(await roleOn(kept.id, member)).toBe('editor');
    expect(await roleOn(lost.id, member)).toBe('editor');

    await removeTopicMember(owner, topic.id, member.user.id);

    // Exactly what the topic gave, and nothing else. This is the property that
    // makes revocation predictable.
    expect(await roleOn(kept.id, member)).toBe('editor');
    expect(await roleOn(lost.id, member)).toBeNull();
  });

  it('the cascade toggle is exactly reversible: nothing overwritten, nothing left behind', async () => {
    const topic = await createTopic(owner, { name: `Toggle ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Toggled ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: member.user.id, role: 'editor' });
    await shareTopic(owner, topic.id, stranger.user.email, 'viewer');

    const membersBefore = await getDb()
      .select()
      .from(schema.radarMembers)
      .where(eq(schema.radarMembers.radarId, radar.id));

    await setCascade(owner, topic.id, true);
    // Going ON wrote no membership rows — the direct grant was not clobbered,
    // merged into, or duplicated.
    const membersDuring = await getDb()
      .select()
      .from(schema.radarMembers)
      .where(eq(schema.radarMembers.radarId, radar.id));
    expect(membersDuring).toHaveLength(membersBefore.length);
    expect(await roleOn(radar.id, stranger)).toBe('viewer');
    expect(await roleOn(radar.id, member)).toBe('editor');

    await setCascade(owner, topic.id, false);
    // Going OFF deleted none, so the direct grant is untouched and the cascaded
    // access is gone completely. A materialised cascade cannot do both.
    const membersAfter = await getDb()
      .select()
      .from(schema.radarMembers)
      .where(eq(schema.radarMembers.radarId, radar.id));
    expect(membersAfter).toHaveLength(membersBefore.length);
    expect(await roleOn(radar.id, stranger)).toBeNull();
    expect(await roleOn(radar.id, member)).toBe('editor');
  });

  /* ------------------------------ exclusions ------------------------------ */

  it('holds the per-topic radar limit against two radars filed at once', async () => {
    const filer = await makeUser('t-filer');
    const topic = await createTopic(filer, { name: `Nearly full ${Math.random()}` });
    await getDb()
      .insert(schema.radars)
      .values(
        Array.from({ length: LIMITS.radarsPerTopic - 1 }, (_, i) => ({
          ownerId: filer.user.id,
          slug: `filler-${i}`,
          name: `Filler ${i}`,
          topicId: topic.id,
        })),
      );
    const a = await createRadar(filer, { name: `Last in ${Math.random()}` });
    const b = await createRadar(filer, { name: `One over ${Math.random()}` });
    const results = await Promise.allSettled([
      setRadarTopic(filer, a.id, topic.id),
      setRadarTopic(filer, b.id, topic.id),
    ]);
    expect(
      results
        .map((r) => (r.status === 'fulfilled' ? 200 : (r.reason as { status?: number }).status))
        .sort(),
    ).toEqual([200, 409]);
    const [held] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.radars)
      .where(eq(schema.radars.topicId, topic.id));
    expect(held?.n).toBe(LIMITS.radarsPerTopic);
  });

  it('refuses the drop box, with a reason', async () => {
    const topic = await createTopic(owner, { name: `NoDropBox ${Math.random()}` });
    const dropBox = await ensureDropBox(owner);
    await expect(setRadarTopic(owner, dropBox.id, topic.id)).rejects.toThrow(/drop box/i);

    const [row] = await getDb()
      .select({ topicId: schema.radars.topicId })
      .from(schema.radars)
      .where(eq(schema.radars.id, dropBox.id));
    expect(row?.topicId).toBeNull();
  });

  it('refuses a smart radar, with a reason', async () => {
    const topic = await createTopic(owner, { name: `NoSmart ${Math.random()}` });
    const smart = await createSmartRadar(owner, {
      name: `Saved ${Math.random()}`,
      filter: { tags: ['ideas'] },
    });
    await expect(setRadarTopic(owner, smart.id, topic.id)).rejects.toThrow(/smart radar/i);
    // And through the other door, so there is no route in at all.
    await expect(updateRadar(owner, smart.id, { topicId: topic.id })).rejects.toThrow(
      /smart radar/i,
    );
  });

  it('refuses both at the database too, not only in the service', async () => {
    const topic = await createTopic(owner, { name: `Constraints ${Math.random()}` });
    const dropBox = await ensureDropBox(owner);

    // Straight at the table, bypassing every service check — which is the point:
    // the service is the sentence a person reads, and the constraint is what
    // makes it impossible to get past by a code path nobody has written yet.
    //
    // Drizzle wraps the driver error, so the constraint name is on the `cause`
    // rather than the message it throws. Asserting on the wrapper's text would
    // pass for *any* failed update and prove nothing about which rule fired.
    expect(await constraintViolated(dropBox.id, topic.id)).toBe(
      'radars_drop_box_is_never_in_a_topic',
    );

    const smart = await createSmartRadar(owner, {
      name: `Saved2 ${Math.random()}`,
      filter: { tags: ['x'] },
    });
    expect(await constraintViolated(smart.id, topic.id)).toBe('radars_smart_is_never_in_a_topic');
  });

  /* --------------------------- assignment rules --------------------------- */

  it('refuses to file somebody else’s radar into your topic', async () => {
    const topic = await createTopic(owner, { name: `Mine ${Math.random()}` });
    const theirs = await createRadar(stranger, { name: `Theirs ${Math.random()}` });
    // A 404, not a 403: the owner cannot manage that radar and must not be told
    // whether the id exists.
    await expect(setRadarTopic(owner, theirs.id, topic.id)).rejects.toThrow(/not found/i);
  });

  it('refuses to file your radar into a topic you only hold a grant on', async () => {
    const topic = await createTopic(owner, { name: `Ours ${Math.random()}` });
    await shareTopic(owner, topic.id, member.user.email, 'editor');
    const mine = await createRadar(member, { name: `MyRadar ${Math.random()}` });

    // Granting needs manage on both sides. Otherwise a topic editor could hand
    // control of their own radar's sharing to whoever owns the topic.
    await expect(setRadarTopic(member, mine.id, topic.id)).rejects.toThrow(/only the array owner/i);
  });

  /* ------------------------------- orphans -------------------------------- */

  it('deleting a topic keeps its radars and their member lists', async () => {
    const topic = await createTopic(owner, { name: `Doomed ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Survivor ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: member.user.id, role: 'editor' });
    await setCascade(owner, topic.id, true);

    const { radarsFreed } = await deleteTopic(owner, topic.id);
    expect(radarsFreed).toBe(1);

    // The radar is alive, topicless, and its own grant is intact.
    const access = await requireRadar(radar.id, owner, 'manage');
    expect(access.radar.topicId).toBeNull();
    expect(await roleOn(radar.id, member)).toBe('editor');
  });

  /* ------------------------- visibility of access ------------------------- */

  it('lists cascaded people in the radar member list, marked as coming from the topic', async () => {
    const topic = await createTopic(owner, { name: `Visible ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Audited ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, member.user.email, 'editor');

    // Not cascading yet: they reach nothing, so they are not in the list.
    let members = await listMembers(await requireRadar(radar.id, owner, 'read'));
    expect(members.map((m) => m.userId)).not.toContain(member.user.id);

    await setCascade(owner, topic.id, true);
    members = await listMembers(await requireRadar(radar.id, owner, 'read'));
    const cascaded = members.find((m) => m.userId === member.user.id);
    // Access nobody can enumerate is access nobody audits.
    expect(cascaded).toBeTruthy();
    expect(cascaded?.via).toBe('topic');
    expect(cascaded?.role).toBe('editor');
    expect(cascaded?.viaTopic?.id).toBe(topic.id);
  });

  it('does not list a cascaded person twice when they also hold a direct grant', async () => {
    const topic = await createTopic(owner, { name: `Once ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Deduped ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: member.user.id, role: 'viewer' });
    await shareTopic(owner, topic.id, member.user.email, 'editor');
    await setCascade(owner, topic.id, true);

    const members = await listMembers(await requireRadar(radar.id, owner, 'read'));
    const rows = members.filter((m) => m.userId === member.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.via).toBe('member');
  });

  /* ------------------------------ topic access ---------------------------- */

  it('a topic nobody shared is a 404, not a 403', async () => {
    const topic = await createTopic(owner, { name: `Private ${Math.random()}` });
    await expect(requireTopic(topic.id, stranger, 'read')).rejects.toThrow(/not found/i);
    await expect(requireTopic(topic.id, null, 'read')).rejects.toThrow(/not found/i);
  });

  it('only the owner can manage a topic, share it, or move the cascade switch', async () => {
    const topic = await createTopic(owner, { name: `Locked ${Math.random()}` });
    await shareTopic(owner, topic.id, member.user.email, 'editor');

    await expect(setCascade(member, topic.id, true)).rejects.toThrow(/only the array owner/i);
    await expect(deleteTopic(member, topic.id)).rejects.toThrow(/only the array owner/i);
    await expect(shareTopic(member, topic.id, stranger.user.email, 'viewer')).rejects.toThrow(
      /only the array owner/i,
    );
  });

  it('lists the owner and every member of a topic', async () => {
    const topic = await createTopic(owner, { name: `Roster ${Math.random()}` });
    await shareTopic(owner, topic.id, member.user.email, 'editor');
    const roster = await listTopicMembers(await requireTopic(topic.id, owner, 'read'));
    expect(roster.find((m) => m.userId === owner.user.id)?.role).toBe('owner');
    expect(roster.find((m) => m.userId === member.user.id)?.role).toBe('editor');
  });

  /* --------------------- cascaded access reaches everywhere --------------- */

  it('a cascaded radar appears in the list, in readableRadarIds and in access, together', async () => {
    const topic = await createTopic(owner, { name: `Everywhere ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Consistent ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, member.user.email, 'editor');
    await setCascade(owner, topic.id, true);

    // Three surfaces, one answer. A radar that showed up in search but not in
    // the sidebar would be the same class of bug as an MCP tool disagreeing
    // with a REST route — here, inside a single service.
    const listed = (await listRadars(member)).find((r) => r.id === radar.id);
    expect(listed).toBeTruthy();
    expect(listed?.access.role).toBe('editor');
    expect(listed?.access.via).toBe('topic');
    expect(listed?.topic?.id).toBe(topic.id);
    expect(await readableRadarIds(member.user.id)).toContain(radar.id);
    expect(await roleOn(radar.id, member)).toBe('editor');
  });

  it('groups a radar under a non-cascading topic for somebody who reaches it directly', async () => {
    const topic = await createTopic(owner, { name: `Grouping ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Grouped ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, member.user.email, 'viewer');
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: member.user.id, role: 'editor' });

    const listed = (await listRadars(member)).find((r) => r.id === radar.id);
    // The topic is attached for *grouping* even though it grants nothing —
    // which is the entire point of a topic that does not cascade.
    expect(listed?.topic?.id).toBe(topic.id);
    expect(listed?.topic?.cascade).toBe(false);
    expect(listed?.access.role).toBe('editor');
    expect(listed?.access.via).toBe('member');
  });

  it('keeps the drop box in the radar list once topics exist', async () => {
    const dropBox = await ensureDropBox(owner);
    const listed = (await listRadars(owner)).find((r) => r.id === dropBox.id);
    // It is topicless by construction and has to stay reachable from every
    // surface that lists radars; a list that becomes topic-organised must not
    // quietly drop the one radar that can never be in a topic.
    expect(listed).toBeTruthy();
    expect(listed?.isDropBox).toBe(true);
    expect(listed?.topic).toBeNull();
  });

  /* ------------------------- notification hygiene ------------------------- */

  it('sweeps notifications for radars reached only through a revoked cascade', async () => {
    const topic = await createTopic(owner, { name: `Sweep ${Math.random()}` });
    const cascaded = await createRadar(owner, { name: `Swept ${Math.random()}` });
    const direct = await createRadar(owner, { name: `Untouched ${Math.random()}` });
    await setRadarTopic(owner, cascaded.id, topic.id);
    await setRadarTopic(owner, direct.id, topic.id);
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: direct.id, userId: member.user.id, role: 'viewer' });
    await shareTopic(owner, topic.id, member.user.email, 'viewer');
    await setCascade(owner, topic.id, true);

    // Two notifications, one on each radar.
    await getDb()
      .insert(schema.notifications)
      .values([
        {
          userId: member.user.id,
          kind: 'comment',
          radarId: cascaded.id,
          groupKey: `comment:${cascaded.id}`,
          subject: 'a thing they can currently read',
          excerpt: 'a snapshot of content',
        },
        {
          userId: member.user.id,
          kind: 'comment',
          radarId: direct.id,
          groupKey: `comment:${direct.id}`,
          subject: 'a thing they will keep',
          excerpt: 'a snapshot of content',
        },
      ]);

    await setCascade(owner, topic.id, false);

    const left = await getDb()
      .select({ radarId: schema.notifications.radarId })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, member.user.id));
    const radarIds = left.map((r) => r.radarId);
    // A notification carries a snapshot excerpt, so leaving one behind would
    // hand somebody a readable copy of a conversation they can no longer open.
    expect(radarIds).not.toContain(cascaded.id);
    // ...and the one they still have access to is untouched.
    expect(radarIds).toContain(direct.id);
  });

  it('raises a topic_share notification, and does not raise one per radar', async () => {
    const topic = await createTopic(owner, { name: `Told ${Math.random()}` });
    const a = await createRadar(owner, { name: `A ${Math.random()}` });
    const b = await createRadar(owner, { name: `B ${Math.random()}` });
    await setRadarTopic(owner, a.id, topic.id);
    await setRadarTopic(owner, b.id, topic.id);
    await setCascade(owner, topic.id, true);

    const fresh = await makeUser('t-told');
    await shareTopic(owner, topic.id, fresh.user.email, 'viewer');

    const rows = await getDb()
      .select({ kind: schema.notifications.kind, topicId: schema.notifications.topicId })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, fresh.user.id),
          eq(schema.notifications.kind, 'topic_share'),
        ),
      );
    // One act by one person is one line. Enumerating the radars would turn a
    // single share into N notifications, which is how a stream gets muted.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topicId).toBe(topic.id);
  });

  it('tells existing members when the cascade is switched on', async () => {
    const topic = await createTopic(owner, { name: `Widened ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Widened radar ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    const heard = await makeUser('t-heard');
    await shareTopic(owner, topic.id, heard.user.email, 'editor');

    await setCascade(owner, topic.id, true);

    const rows = await getDb()
      .select({ kind: schema.notifications.kind })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, heard.user.id),
          eq(schema.notifications.kind, 'topic_cascade'),
        ),
      );
    // This is the one moment access widens without anybody being shared
    // anything, so it is the one that most needs saying out loud.
    expect(rows).toHaveLength(1);
  });
  it("a radar's member count agrees with the list the share dialog shows", async () => {
    const owner = await makeUser('counter');
    const direct = await makeUser('direct');
    const cascaded = await makeUser('cascaded');

    const topic = await createTopic(owner, { name: `Counted ${Math.random()}` });
    const radar = await createRadar(owner, { name: `Counted ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareRadar(owner, radar.id, direct.user.email, 'editor');
    await shareTopic(owner, topic.id, cascaded.user.email, 'viewer');

    // Not cascading yet: the topic grant conveys nothing, and both halves must
    // say so.
    let listed = await listMembers(await requireRadar(radar.id, owner, 'read'));
    let shown = (await listRadars(owner)).find((r) => r.id === radar.id);
    expect(listed).toHaveLength(2);
    expect(shown?.memberCount).toBe(2);

    await setCascade(owner, topic.id, true);

    // Now it does. `listMembers` deliberately has a cascade leg — a cascaded
    // member appears in the share dialog labelled with where their access came
    // from, because access nobody can enumerate is access nobody audits. The
    // count beside it had no such leg, so the dialog listed three people and
    // the number said two.
    listed = await listMembers(await requireRadar(radar.id, owner, 'read'));
    shown = (await listRadars(owner)).find((r) => r.id === radar.id);
    expect(listed).toHaveLength(3);
    expect(shown?.memberCount).toBe(3);

    // And it does not double count somebody holding both grants.
    await shareTopic(owner, topic.id, direct.user.email, 'viewer');
    listed = await listMembers(await requireRadar(radar.id, owner, 'read'));
    shown = (await listRadars(owner)).find((r) => r.id === radar.id);
    expect(shown?.memberCount).toBe(listed.length);
  });
});

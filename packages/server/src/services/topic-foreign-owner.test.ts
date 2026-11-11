/**
 * A removed co-owner must not keep a grant path to a radar (audit P1.1).
 *
 * Repro: O shares R with C as owner; C creates topic T (cascade on) and files R
 * in it; O removes C; C adds C2 to T; C2 could write to R, because C still owns
 * T and a topic's cascade grants its members the radars in it.
 *
 * Two guards close it and each needs its own test — with both in place the
 * five-step story fails at step 2, so the story alone proves neither:
 *
 * - `setRadarTopic` refuses a topic the radar's owner does not own (step 2).
 * - Removing (or demoting) a co-owner detaches the radar from any topic its
 *   owner does not own, which is what repairs placements that already exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { getRadarAccess, readableRadarIds, requireRadar } from './access.js';
import { createRadar, listMembers, listRadars, removeMember, shareRadar } from './radars.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';

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

async function canWrite(radarId: string, actor: Actor): Promise<boolean> {
  const access = await getRadarAccess(radarId, actor);
  return Boolean(access?.canWrite);
}

async function topicOf(radarId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ topicId: schema.radars.topicId })
    .from(schema.radars)
    .where(eq(schema.radars.id, radarId));
  return row?.topicId ?? null;
}

describe.skipIf(!hasDatabase)('co-owner topic grant path (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  async function scenario() {
    const [o, c, c2] = await Promise.all([makeUser('fo-o'), makeUser('fo-c'), makeUser('fo-c2')]);
    const radar = await createRadar(o, { name: `Shared ${Math.random()}` });
    await shareRadar(o, radar.id, c.user.email, 'owner');
    const topic = await createTopic(c, { name: `C topic ${Math.random()}` });
    await setCascade(c, topic.id, true);
    return { o, c, c2, radar, topic };
  }

  it('refuses to file a radar into a topic its owner does not own', async () => {
    const { c, radar, topic } = await scenario();
    // C holds manage on both sides; that used to be enough.
    await expect(setRadarTopic(c, radar.id, topic.id)).rejects.toMatchObject({ status: 403 });
    expect(await topicOf(radar.id)).toBeNull();
  });

  it('still lets the radar owner file it into their own topic', async () => {
    const { o, radar } = await scenario();
    const own = await createTopic(o, { name: `O topic ${Math.random()}` });
    await setRadarTopic(o, radar.id, own.id);
    expect(await topicOf(radar.id)).toBe(own.id);
  });

  it('removing a co-owner detaches the radar from their topic, so a later member gets nothing', async () => {
    const { o, c, c2, radar, topic } = await scenario();
    // Placement that predates the guard, written the way old data was.
    await getDb()
      .update(schema.radars)
      .set({ topicId: topic.id })
      .where(eq(schema.radars.id, radar.id));
    await removeMember(o, radar.id, c.user.id);
    expect(await topicOf(radar.id)).toBeNull();

    await shareTopic(c, topic.id, c2.user.email, 'editor');
    expect(await canWrite(radar.id, c2)).toBe(false);
    expect(await getRadarAccess(radar.id, c2)).toBeNull();
    expect(await canWrite(radar.id, c)).toBe(false);
  });

  it('demoting a co-owner below owner detaches it as well', async () => {
    const { o, c, radar, topic } = await scenario();
    await getDb()
      .update(schema.radars)
      .set({ topicId: topic.id })
      .where(eq(schema.radars.id, radar.id));
    await shareRadar(o, radar.id, c.user.email, 'editor');
    expect(await topicOf(radar.id)).toBeNull();
  });

  it('leaves the radar in its owner’s own topic when a member is removed', async () => {
    const { o, c, radar } = await scenario();
    const own = await createTopic(o, { name: `O topic ${Math.random()}` });
    await setRadarTopic(o, radar.id, own.id);
    await removeMember(o, radar.id, c.user.id);
    expect(await topicOf(radar.id)).toBe(own.id);
  });

  it('a foreign placement that is already in the data grants no cascade at all (access-time invariant)', async () => {
    const { o, c2, radar, topic } = await scenario();
    // Legacy state: the radar sits in C's cascading topic, C is long gone from the
    // radar's member list, and C2 is in C's topic.
    await getDb()
      .update(schema.radars)
      .set({ topicId: topic.id })
      .where(eq(schema.radars.id, radar.id));
    await getDb().delete(schema.radarMembers).where(eq(schema.radarMembers.radarId, radar.id));
    await getDb()
      .insert(schema.topicMembers)
      .values({ topicId: topic.id, userId: c2.user.id, role: 'editor' });

    expect(await getRadarAccess(radar.id, c2)).toBeNull();
    expect(await canWrite(radar.id, c2)).toBe(false);
    expect(await readableRadarIds(c2.user.id)).not.toContain(radar.id);
    expect((await listRadars(c2)).map((r) => r.id)).not.toContain(radar.id);
    const members = await listMembers(await requireRadar(radar.id, o, 'read'));
    expect(members.some((m) => m.userId === c2.user.id)).toBe(false);
  });

  it('a retried removal still detaches a radar the first attempt left in a foreign topic', async () => {
    const { o, c, radar, topic } = await scenario();
    // The first attempt deleted the member row and was interrupted before detaching.
    await getDb()
      .update(schema.radars)
      .set({ topicId: topic.id })
      .where(eq(schema.radars.id, radar.id));
    await getDb().delete(schema.radarMembers).where(eq(schema.radarMembers.radarId, radar.id));
    await removeMember(o, radar.id, c.user.id);
    expect(await topicOf(radar.id)).toBeNull();
  });
});

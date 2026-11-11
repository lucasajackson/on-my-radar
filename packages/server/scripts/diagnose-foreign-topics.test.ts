import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, getPool, schema } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Actor } from '../src/http.js';
import { createRadar, shareRadar } from '../src/services/radars.js';
import { createTopic, setCascade, setRadarTopic } from '../src/services/topics.js';
import { findForeignTopicPlacements, formatPlacements } from './diagnose-foreign-topics.js';

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

describe.skipIf(!hasDatabase)('diagnose-foreign-topics (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  it('lists exactly the radars in a topic with a different owner', async () => {
    const o = await makeUser('dg-o');
    const c = await makeUser('dg-c');
    const radar = await createRadar(o, { name: `Foreign ${Math.random()}` });
    await shareRadar(o, radar.id, c.user.email, 'owner');
    const theirs = await createTopic(c, { name: `C topic ${Math.random()}` });
    await setCascade(c, theirs.id, true);
    // The placement the guard now prevents, written the way old data was.
    await getDb()
      .update(schema.radars)
      .set({ topicId: theirs.id })
      .where(eq(schema.radars.id, radar.id));

    const fine = await createRadar(o, { name: `Fine ${Math.random()}` });
    const own = await createTopic(o, { name: `O topic ${Math.random()}` });
    await setRadarTopic(o, fine.id, own.id);

    const rows = await findForeignTopicPlacements(getPool());
    expect(rows.find((r) => r.radarId === radar.id)).toMatchObject({
      radarOwnerEmail: o.user.email,
      topicId: theirs.id,
      topicOwnerEmail: c.user.email,
      cascade: true,
      topicOwnerHoldsRadarGrant: true,
    });
    expect(rows.some((r) => r.radarId === fine.id)).toBe(false);
    expect(formatPlacements(rows)).toContain(radar.id);
    expect(formatPlacements([])).toMatch(/No radar sits/);
  });

  it('runs in a read-only transaction: a write there is refused', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await expect(client.query('UPDATE radars SET name = name')).rejects.toThrow(/read-only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // And the diagnostic itself leaves nothing open on its connection.
    await findForeignTopicPlacements(getPool());
    const { rows } = await getPool().query('SHOW transaction_read_only');
    expect(rows[0]).toEqual({ transaction_read_only: 'off' });
  });
});

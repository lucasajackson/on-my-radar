/**
 * Deleting something has to take its bytes with it.
 *
 * Attachment bytes never pass through this process — the browser PUTs straight
 * to MinIO and tells the server the key — so the `attachments` rows are the
 * only record of what exists in the bucket. `attachments.radar_id` is
 * `ON DELETE CASCADE`, which means deleting a radar destroys that record; and
 * `deleteRadar` deleted the row and stopped there. `deleteObjects` documented
 * itself as cleanup "after a blip or radar is deleted" and had exactly one
 * caller, the single-blip path. Every object a deleted radar owned stayed in
 * the bucket forever, unreachable and uncountable — unbounded growth, and files
 * somebody believes they deleted still sitting there.
 *
 * The assertions are about **which keys are handed to `deleteObjects`**, which
 * is the only observable that distinguishes the fix from the bug: with no MinIO
 * configured the real call is a no-op, so a test that merely ran the delete and
 * checked for no exception would pass either way.
 *
 * Cleanup rides the outbox now (DESIGN.md §28), so a delete *enqueues* the keys
 * and the handler hands them to `deleteObjects`. Each test drains the queue and
 * waits for it to empty before asserting — the inline kick is asynchronous by
 * design, and asserting mid-flight is how one test's keys arrive during the
 * next test's count.
 *
 * The ordering property is the one worth stating out loud: reading the keys
 * *after* the row is deleted finds nothing, so a version that looked afterwards
 * would silently clean up zero objects and every assertion about "it was
 * called" would still hold. Hence the exact key set, not a call count.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import type * as StorageModule from './storage.js';

// A database of this suite's own (the migrate.test pattern): `settleOutbox`
// below asserts the queue drains to empty, and that is only a statement about
// THIS suite's work if no sibling worker is enqueuing into the same tables.
if (process.env['DATABASE_URL']) {
  const admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  const scratch = `omr_cleanup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${scratch}`);
  await admin.end();
  const url = new URL(process.env['DATABASE_URL']);
  url.pathname = `/${scratch}`;
  setEnvForTesting(loadEnv({ ...process.env, DATABASE_URL: url.toString() }));
}

const deleted: string[][] = [];

vi.mock('./storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageModule>()),
  deleteObjects: (keys: string[]) => {
    deleted.push(keys);
    return Promise.resolve();
  },
}));

const { createBlip, deleteBlip } = await import('./blips.js');
const { createRadar, deleteRadar } = await import('./radars.js');
const { drainDue } = await import('./outbox.js');

/** Drain, then wait out any in-flight inline kick: empty queue = all delivered. */
async function settleOutbox(): Promise<void> {
  await drainDue(20);
  await expect
    .poll(async () => (await getDb().select().from(schema.outbox)).length, { timeout: 5_000 })
    .toBe(0);
}

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
 * Written straight into the table rather than through the upload path, which
 * needs a presign and a HEAD against a real bucket. What is under test is what
 * happens to the row's key when the thing above it is deleted.
 */
async function attach(radarId: string, blipId: string, name: string): Promise<string> {
  const objectKey = `radars/${radarId}/${crypto.randomUUID()}/${name}`;
  await getDb().insert(schema.attachments).values({
    blipId,
    radarId,
    objectKey,
    filename: name,
    contentType: 'image/png',
    size: 1024,
  });
  return objectKey;
}

describe.skipIf(!hasDatabase)('object cleanup (real postgres)', () => {
  let owner: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('ac-owner');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('deletes every object a radar owned, across all of its blips', async () => {
    deleted.length = 0;
    const radar = await createRadar(owner, { name: `Cleanup ${Math.random()}` });
    const first = await createBlip(owner, radar.id, { body: 'one' });
    const second = await createBlip(owner, radar.id, { body: 'two' });
    const keys = [
      await attach(radar.id, first.id, 'a.png'),
      await attach(radar.id, first.id, 'b.png'),
      await attach(radar.id, second.id, 'c.png'),
    ];

    await deleteRadar(owner, radar.id);
    await settleOutbox();

    // The exact set, not a call count: the keys have to be read before the row
    // is deleted, and reading them afterwards would hand over an empty list.
    expect(deleted.flat().sort()).toEqual([...keys].sort());

    // And the rows really are gone, so there is no second chance to find them.
    const left = await getDb()
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(eq(schema.attachments.radarId, radar.id));
    expect(left).toEqual([]);
  });

  it('deletes nothing extra: another radar keeps its objects', async () => {
    deleted.length = 0;
    const doomed = await createRadar(owner, { name: `Doomed ${Math.random()}` });
    const spared = await createRadar(owner, { name: `Spared ${Math.random()}` });
    const doomedBlip = await createBlip(owner, doomed.id, { body: 'x' });
    const sparedBlip = await createBlip(owner, spared.id, { body: 'y' });
    const doomedKey = await attach(doomed.id, doomedBlip.id, 'gone.png');
    const sparedKey = await attach(spared.id, sparedBlip.id, 'kept.png');

    await deleteRadar(owner, doomed.id);
    await settleOutbox();

    expect(deleted.flat()).toEqual([doomedKey]);
    expect(deleted.flat()).not.toContain(sparedKey);
    const kept = await getDb()
      .select({ objectKey: schema.attachments.objectKey })
      .from(schema.attachments)
      .where(eq(schema.attachments.radarId, spared.id));
    expect(kept.map((row) => row.objectKey)).toEqual([sparedKey]);
  });

  it('asks for nothing when a radar had no attachments', async () => {
    deleted.length = 0;
    const radar = await createRadar(owner, { name: `Bare ${Math.random()}` });
    await createBlip(owner, radar.id, { body: 'nothing attached' });
    await deleteRadar(owner, radar.id);
    await settleOutbox();
    expect(deleted.flat()).toEqual([]);
  });

  it('still cleans up when a single blip is deleted', async () => {
    deleted.length = 0;
    const radar = await createRadar(owner, { name: `Single ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'one blip' });
    const other = await createBlip(owner, radar.id, { body: 'another' });
    const key = await attach(radar.id, blip.id, 'one.png');
    const survivor = await attach(radar.id, other.id, 'two.png');

    await deleteBlip(owner, blip.id);
    await settleOutbox();
    expect(deleted.flat()).toEqual([key]);
    expect(deleted.flat()).not.toContain(survivor);
  });
});

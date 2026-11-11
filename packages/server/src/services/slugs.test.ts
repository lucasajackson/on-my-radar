import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createRadar, createSmartRadar, ensureDropBox, updateRadar } from './radars.js';
import { createTopic, updateTopic } from './topics.js';
import { withUniqueSlug } from './slugs.js';
import { must } from '../errors.js';

process.env['SESSION_SECRET'] ??= 'slug-test-only-secret-not-used-in-production';
it('retries only the named slug constraint, including wrapped database errors', async () => {
  const write = vi
    .fn<(slug: string) => Promise<string>>()
    .mockRejectedValueOnce({ cause: { code: '23505', constraint: 'radars_owner_slug_key' } })
    .mockResolvedValue('created');
  expect(await withUniqueSlug('My radar', 'radars_owner_slug_key', write)).toBe('created');
  expect(write.mock.calls.map(([slug]) => slug)).toEqual(['my-radar', 'my-radar-2']);
  const other = vi
    .fn()
    .mockRejectedValue({ code: '23505', constraint: 'radars_one_drop_box_per_owner' });
  await expect(withUniqueSlug('My radar', 'radars_owner_slug_key', other)).rejects.toMatchObject({
    code: '23505',
  });
  expect(other).toHaveBeenCalledOnce();
});

describe.skipIf(!process.env['DATABASE_URL'])('concurrent slug allocation (real postgres)', () => {
  let actor: Actor;
  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `slug-${randomUUID()}@test.test`, state: 'active' })
      .returning();
    actor = { user: must(user), kind: 'user' };
  });
  afterAll(closeDb);

  it('creates standard and smart radars with one shared name without lost writes', async () => {
    const name = `Same ${randomUUID()}`;
    const rows = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? createRadar(actor, { name })
          : createSmartRadar(actor, { name, filter: { tags: ['test'] } }),
      ),
    );
    expect(new Set(rows.map((row) => row.slug)).size).toBe(12);
    expect(rows.every((row) => row.name === name)).toBe(true);
  });
  it('renames distinct radars concurrently, including a combined topic move', async () => {
    const topic = await createTopic(actor, { name: `Placement ${randomUUID()}` });
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => createRadar(actor, { name: randomUUID() })),
    );
    const name = `Renamed ${randomUUID()}`;
    const renamed = await Promise.all(
      rows.map((row, i) =>
        updateRadar(actor, row.id, { name, ...(i % 2 ? { topicId: topic.id } : {}) }),
      ),
    );
    expect(new Set(renamed.map((row) => row.slug)).size).toBe(6);
    expect(renamed.filter((row) => row.topic?.id === topic.id)).toHaveLength(3);
  });
  it('allocates topics under competing creates and renames', async () => {
    const name = `Topics ${randomUUID()}`;
    const rows = await Promise.all(Array.from({ length: 8 }, () => createTopic(actor, { name })));
    expect(new Set(rows.map((row) => row.slug)).size).toBe(8);
    const renamed = await Promise.all(
      rows.map((row) => updateTopic(actor, row.id, { name: `Changed ${name}` })),
    );
    expect(new Set(renamed.map((row) => row.slug)).size).toBe(8);
    expect(
      (await updateTopic(actor, must(renamed[0]).id, { name: must(renamed[0]).name })).slug,
    ).toBe(must(renamed[0]).slug);
  });
  it('preserves singleton drop box creation while another radar claims its name', async () => {
    const results = await Promise.all([
      createRadar(actor, { name: 'Drop Box' }),
      ensureDropBox(actor),
      ensureDropBox(actor),
    ]);
    expect(results[1].id).toBe(results[2].id);
    expect(results[0].id).not.toBe(results[1].id);
    expect(results[0].slug).not.toBe(results[1].slug);
  });
});

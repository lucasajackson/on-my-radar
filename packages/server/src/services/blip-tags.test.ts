/**
 * Tags follow the text they were written in (DESIGN §3: capture derives them
 * from `#hashtags`), and a tag set explicitly stays set.
 *
 * An edit used to only ever add: taking `#urgent` out of a body left the tag
 * behind, and once a blip held the limit a new `#tag` in edited text was dropped
 * without a word.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip, updateBlip } from './blips.js';
import { createRadar } from './radars.js';
import { must } from '../errors.js';

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!process.env['DATABASE_URL'])('tags on edit (real postgres)', () => {
  let owner: Actor;
  let radarId: string;

  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `tags-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    radarId = (await createRadar(owner, { name: `Tags ${randomUUID()}` })).id;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('drops a hashtag taken out of the body, adds one put in, keeps one set explicitly', async () => {
    const blip = await createBlip(owner, radarId, {
      body: 'ship it #urgent #release',
      tags: ['someday'],
    });
    expect(blip.tags.sort()).toEqual(['release', 'someday', 'urgent']);

    const edited = await updateBlip(owner, blip.id, { body: 'ship it #release #docs' });
    expect(edited.tags.sort()).toEqual(['docs', 'release', 'someday']);
  });

  it('lets explicit tags in the same call win outright', async () => {
    const blip = await createBlip(owner, radarId, { body: 'a #one' });
    const edited = await updateBlip(owner, blip.id, { body: 'a #two', tags: ['three'] });
    expect(edited.tags).toEqual(['three']);
  });

  it('refuses an edit that would carry more tags than a blip holds, naming the extras', async () => {
    const full = Array.from({ length: LIMITS.tagsPerBlip }, (_, i) => `#f${i}`).join(' ');
    const blip = await createBlip(owner, radarId, { body: full });
    const edit = updateBlip(owner, blip.id, { body: `${full} #one-more` });
    await expect(edit).rejects.toMatchObject({ status: 400 });
    await expect(edit).rejects.toThrow(/#one-more does not fit/);
  });
});

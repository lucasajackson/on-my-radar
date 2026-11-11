/**
 * A captured link: recognised as one even with tags beside it, and a preview
 * the client can tell is still coming.
 *
 * `unfurl` is replaced by one the test releases by hand, so "fetched after the
 * capture returned" is a state the test holds open rather than a race it hopes
 * to catch.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LinkPreviewDto } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { createBlip, getBlip } from './blips.js';
import { createRadar } from './radars.js';

const pending = vi.hoisted(() => new Map<string, (preview: LinkPreviewDto | null) => void>());
vi.mock('./unfurl.js', () => ({
  unfurl: vi.fn(
    (url: string) =>
      new Promise<LinkPreviewDto | null>((resolve) => {
        pending.set(url, resolve);
      }),
  ),
}));

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!process.env['DATABASE_URL'])('capturing a link (real postgres)', () => {
  let owner: Actor;
  let radarId: string;

  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `links-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    radarId = (await createRadar(owner, { name: `Links ${randomUUID()}` })).id;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('reads a URL with tags beside it as a link, and fetches its preview', async () => {
    const url = `https://example.com/article-${randomUUID()}`;
    const blip = await createBlip(owner, radarId, { body: `${url} #reading` });
    expect(blip).toMatchObject({ kind: 'link', url, tags: ['reading'] });
    await vi.waitFor(() => expect(pending.has(url)).toBe(true));
  });

  it('says the preview is pending until the fetch finishes, found or not', async () => {
    const found = `https://example.com/found-${randomUUID()}`;
    const created = await createBlip(owner, radarId, { body: found });
    expect(created).toMatchObject({ preview: null, previewPending: true });
    await vi.waitFor(() => expect(pending.has(found)).toBe(true));
    expect((await getBlip(created.id, owner)).previewPending).toBe(true);

    must(pending.get(found))({
      title: 'Found it',
      description: null,
      siteName: null,
      imageUrl: null,
      fetchedAt: new Date().toISOString(),
    });
    await vi.waitFor(async () => {
      const read = await getBlip(created.id, owner);
      expect(read.preview?.title).toBe('Found it');
      expect(read.previewPending).toBeUndefined();
    });

    const none = `https://example.com/none-${randomUUID()}`;
    const bare = await createBlip(owner, radarId, { body: none });
    await vi.waitFor(() => expect(pending.has(none)).toBe(true));
    must(pending.get(none))(null);
    await vi.waitFor(async () => {
      const read = await getBlip(bare.id, owner);
      expect(read.preview).toBeNull();
      expect(read.previewPending).toBeUndefined();
    });
  });

  it('never says pending on a blip with no link', async () => {
    const note = await createBlip(owner, radarId, { body: 'just a thought #reading' });
    expect(note.previewPending).toBeUndefined();
  });
});

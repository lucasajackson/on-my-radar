/** Public-route narrowing: archived blips' threads, and the card's cache policy. */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createComment } from '../services/comments.js';
import { createRadar, setVisibility } from '../services/radars.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('public routes (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let owner: Actor;
  let slug: string;
  let liveBlipId: string;
  let archivedBlipId: string;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    const [user] = await getDb()
      .insert(schema.users)
      .values({
        email: `pub-hard-${Math.random().toString(36).slice(2)}@example.test`,
        state: 'active',
      })
      .returning();
    if (!user) throw new Error('no user');
    owner = { user, kind: 'user' };
    const radar = await createRadar(owner, { name: 'Public hardening', template: 'kanban' });
    const live = await createBlip(owner, radar.id, { body: 'still moving', status: 'doing' });
    const old = await createBlip(owner, radar.id, { body: 'finished long ago', status: 'done' });
    liveBlipId = live.id;
    archivedBlipId = old.id;
    await createComment(owner, live.id, { body: 'live thread' });
    await createComment(owner, old.id, { body: 'archived thread' });
    // Age the archived blip and its comment out of the 30-day window.
    await getDb()
      .update(schema.blipComments)
      .set({ createdAt: sql`now() - make_interval(days => 90)` })
      .where(eq(schema.blipComments.blipId, old.id));
    await getDb()
      .update(schema.blips)
      .set({
        createdAt: sql`now() - make_interval(days => 90)`,
        updatedAt: sql`now() - make_interval(days => 90)`,
      })
      .where(eq(schema.blips.id, old.id));
    const published = await setVisibility(owner, radar.id, 'public');
    if (!published.publicSlug) throw new Error('no slug');
    slug = published.publicSlug;
  }, 30_000);
  afterAll(closeDb);

  it('serves the thread on a live blip', async () => {
    const res = await app.request(`/api/public/radars/${slug}/blips/${liveBlipId}/comments`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('does not serve the thread on an archived blip', async () => {
    const res = await app.request(`/api/public/radars/${slug}/blips/${archivedBlipId}/comments`);
    expect(res.status).toBe(404);
  });

  it('does not let a shared cache keep the radar card', async () => {
    const res = await app.request(`/api/public/radars/${slug}/card.svg`);
    expect(res.status).toBe(200);
    const control = res.headers.get('cache-control') ?? '';
    expect(control).not.toMatch(/\bpublic\b/);
    expect(control).toMatch(/private|no-store/);
  });
});

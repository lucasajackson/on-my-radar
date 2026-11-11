/**
 * Machine-ingested text never addresses anybody.
 *
 * A feed item, an inbound email and a webhook payload all become blips through
 * `createBlip`, the same function a person's composer calls. Mentions resolve
 * there, so an `@alice` in somebody else's words notified Alice — credited to
 * the radar's owner, as if they had called her in. The capture source decides
 * now: a webhook delivery (email, radar webhooks) resolves no mentions, and the
 * feed import says so explicitly because it captures as the feed's owner.
 *
 * Driven through the real paths — `pollFeed` with the transport stubbed, and a
 * `webhook` actor exactly as `inbound-email.ts` and `webhooks.ts` build one —
 * with a person's own capture as the control.
 */
import { randomUUID } from 'node:crypto';
import { LIMITS } from '@onmyradar/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type * as PublicRequestModule from './public-request.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip, updateBlip } from './blips.js';
import { createComment } from './comments.js';
import { createRadar, shareRadar } from './radars.js';
import { createFeed, pollFeed } from './rss.js';
import { must } from '../errors.js';

const transport = vi.hoisted(() => vi.fn());
vi.mock('./public-request.js', async (original) => ({
  ...(await original<typeof PublicRequestModule>()),
  publicRequest: transport,
}));

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label}-${randomUUID()}@example.test`, state: 'active' })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

describe.skipIf(!hasDatabase)('capture from somebody else’s words (real postgres)', () => {
  let owner: Actor;
  let alice: Actor;
  let radarId: string;
  let handle: string;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('cm-owner');
    alice = await makeUser('cm-alice');
    handle = must(alice.user.email.split('@')[0]);
    radarId = (await createRadar(owner, { name: `Ingest ${randomUUID()}` })).id;
    await shareRadar(owner, radarId, alice.user.email, 'viewer');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  async function addressed(blipIds: string[]) {
    const mentions = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(
        and(eq(schema.mentions.userId, alice.user.id), inArray(schema.mentions.blipId, blipIds)),
      );
    const notified = await getDb()
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, alice.user.id),
          eq(schema.notifications.kind, 'mention'),
          inArray(schema.notifications.blipId, blipIds),
        ),
      );
    return { mentions: mentions.length, notified: notified.length };
  }

  it('resolves a person’s own @handle — the control', async () => {
    const blip = await createBlip(owner, radarId, { body: `over to you @${handle}` });
    expect(await addressed([blip.id])).toEqual({ mentions: 1, notified: 1 });
  });

  it('never notifies somebody about their own @handle, on a blip or in a thread', async () => {
    const ownHandle = must(owner.user.email.split('@')[0]);
    const blip = await createBlip(owner, radarId, { body: `note to self @${ownHandle}` });
    const comment = await createComment(owner, blip.id, { body: `and again @${ownHandle}` });
    // The handle resolves — it is a real reader of the radar — so it renders as
    // a mention; it just addresses nobody but the writer.
    const rows = await getDb()
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .where(eq(schema.mentions.userId, owner.user.id));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const told = await getDb()
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, owner.user.id),
          eq(schema.notifications.kind, 'mention'),
          eq(schema.notifications.blipId, blip.id),
        ),
      );
    expect(told).toEqual([]);
    expect(comment.mentions?.map((m) => m.handle)).toContain(ownHandle);
  });

  it('resolves none from a webhook delivery — an email or a radar webhook', async () => {
    const delivery: Actor = { kind: 'webhook', user: owner.user };
    const blip = await createBlip(delivery, radarId, { body: `From: someone\n\ncc @${handle}` });
    expect(blip.body).toContain(`@${handle}`);
    expect(await addressed([blip.id])).toEqual({ mentions: 0, notified: 0 });
  });

  it('resolves none from a feed item, though the feed captures as its owner', async () => {
    const feed = await createFeed(owner, radarId, {
      url: `https://feed.test/${randomUUID()}`,
      lookback: 'forever',
    });
    transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: `<rss><channel><title>Feed</title><item><guid>one</guid><title>Post</title><description>thanks @${handle}</description></item></channel></rss>`,
    });
    await pollFeed(feed.id);
    const captured = await getDb()
      .select({ id: schema.blips.id, body: schema.blips.body })
      .from(schema.blips)
      .where(eq(schema.blips.radarId, radarId));
    const fromFeed = captured.filter((row) => row.body.includes('Imported from RSS feed'));
    expect(fromFeed).toHaveLength(1);
    expect(must(fromFeed[0]).body).toContain(`@${handle}`);
    expect(await addressed(fromFeed.map((row) => row.id))).toEqual({ mentions: 0, notified: 0 });

    // Moved to another radar Alice reads: still somebody else's words.
    const elsewhere = (await createRadar(owner, { name: `Moved ${randomUUID()}` })).id;
    await shareRadar(owner, elsewhere, alice.user.email, 'viewer');
    await updateBlip(owner, must(fromFeed[0]).id, { radarId: elsewhere });
    expect(await addressed([must(fromFeed[0]).id])).toEqual({ mentions: 0, notified: 0 });

    // Rewritten by the owner, the words are theirs, and the handle resolves.
    await updateBlip(owner, must(fromFeed[0]).id, {
      body: `${must(fromFeed[0]).body}\n\nover to you`,
    });
    expect(await addressed([must(fromFeed[0]).id])).toEqual({ mentions: 1, notified: 1 });
  });

  it('keeps the first tags of somebody else’s words, and refuses a person past the limit', async () => {
    const many = Array.from({ length: LIMITS.tagsPerBlip + 3 }, (_, i) => `#t${i}`).join(' ');
    const delivery: Actor = { kind: 'webhook', user: owner.user };
    const ingested = await createBlip(delivery, radarId, { body: many });
    expect(ingested.tags).toHaveLength(LIMITS.tagsPerBlip);
    expect(ingested.body).toContain(`#t${LIMITS.tagsPerBlip + 2}`);

    const refused = createBlip(owner, radarId, { body: many });
    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(refused).rejects.toThrow(
      new RegExp(`at most ${LIMITS.tagsPerBlip} tags.*#t${LIMITS.tagsPerBlip}, `),
    );
  });
});

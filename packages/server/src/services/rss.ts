import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  createFeedSchema,
  idSchema,
  updateFeedSchema,
  type CreateFeedInput,
  type FeedDto,
  type FeedLookback,
  type UpdateFeedInput,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, notFound, type Actor } from '../http.js';
import { logger } from '../logger.js';
import { requireRadar } from './access.js';
import { createBlip } from './blips.js';
import { dueBacklogAtLeast } from './outbox.js';
import {
  publicRequest,
  UnsafeOutboundUrlError,
  unsafeUrlMessage,
  vetPublicUrl,
} from './public-request.js';
import { MAX_FEED_BYTES, parseFeed } from './rss-parser.js';
import { must } from '../errors.js';

type FeedRow = typeof schema.radarFeeds.$inferSelect;
const POLL_MS = 15 * 60_000;
const CONTINUATION_MS = 30_000;
const CAPTURE_BUDGET = 500;
const MAX_POLL_WORK_MS = 20_000;
/**
 * How long a removed subscription is kept. Its tombstones are what stop a
 * re-added feed importing everything again, so they outlive the removal for a
 * while — and then go, with the row, in the worker's upkeep.
 */
const REMOVED_FEED_RETENTION_DAYS = 30;
const ACTIVE_FEEDS_PER_ACCOUNT = 50;
/**
 * Active plus still-retained removed subscriptions. Removed ones do not count
 * against the active limit, so without this an add/remove cycle created rows
 * (and tombstones) without end.
 */
const RETAINED_FEEDS_PER_ACCOUNT = 100;

function dto(row: FeedRow): FeedDto {
  return {
    id: row.id,
    radarId: row.radarId,
    url: row.url,
    title: row.title,
    lookback: row.lookback,
    enabled: row.enabled,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
  };
}
export function feedCutoff(lookback: FeedLookback, now = new Date()): Date | null {
  if (lookback === 'forever') return null;
  const days = { day: 1, week: 7, month: 30, year: 365 }[lookback];
  return new Date(now.getTime() - days * 86_400_000);
}
async function target(actor: Actor, radarId: string) {
  const access = await requireRadar(radarId, actor, 'manage');
  if (access.radar.ownerId !== actor.user.id)
    throw badRequest('Only the radar owner can manage its feeds');
  if (access.radar.kind !== 'standard')
    throw badRequest('A smart radar cannot receive feed entries');
  return access.radar;
}
export async function listFeeds(actor: Actor, radarId: string): Promise<FeedDto[]> {
  const radar = await target(actor, radarId);
  const rows = await getDb()
    .select()
    .from(schema.radarFeeds)
    .where(and(eq(schema.radarFeeds.radarId, radar.id), isNull(schema.radarFeeds.removedAt)))
    .orderBy(schema.radarFeeds.createdAt);
  return rows.map(dto);
}
export async function createFeed(
  actor: Actor,
  radarId: string,
  raw: CreateFeedInput,
): Promise<FeedDto> {
  const parsed = createFeedSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid feed');
  const input = parsed.data;
  const radar = await target(actor, radarId);
  const url = new URL(input.url);
  url.hash = '';
  // A feed on a private address would fail every poll with nothing to say why.
  await vetPublicUrl(url).catch((err: unknown) => {
    throw err instanceof UnsafeOutboundUrlError ? badRequest(unsafeUrlMessage(url, err)) : err;
  });
  const row = await getDb().transaction(async (tx) => {
    // One account-level lock serializes quotas across concurrent radar requests.
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, actor.user.id))
      .for('update');
    const retained = await tx
      .select({ radarId: schema.radarFeeds.radarId, removedAt: schema.radarFeeds.removedAt })
      .from(schema.radarFeeds)
      .where(eq(schema.radarFeeds.createdBy, actor.user.id));
    const existing = retained.filter((f) => !f.removedAt);
    if (existing.length >= ACTIVE_FEEDS_PER_ACCOUNT)
      throw badRequest(`An account can subscribe to at most ${ACTIVE_FEEDS_PER_ACCOUNT} feeds`);
    if (existing.filter((f) => f.radarId === radar.id).length >= 10)
      throw badRequest('A radar can subscribe to at most 10 feeds');
    const [previous] = await tx
      .select()
      .from(schema.radarFeeds)
      .where(
        and(eq(schema.radarFeeds.radarId, radar.id), eq(schema.radarFeeds.url, url.toString())),
      );
    if (previous) {
      if (!previous.removedAt) throw badRequest('This radar is already subscribed to that feed');
      const [restored] = await tx
        .update(schema.radarFeeds)
        .set({
          removedAt: null,
          enabled: true,
          lookback: input.lookback,
          importAfter: feedCutoff(input.lookback),
          etag: null,
          lastModified: null,
          nextPollAt: new Date(),
          leasedUntil: null,
          revision: sql`${schema.radarFeeds.revision} + 1`,
        })
        .where(eq(schema.radarFeeds.id, previous.id))
        .returning();
      return must(restored, 'the feed it just restored');
    }
    // Only a brand-new row is charged: restoring one above reuses it.
    if (retained.length >= RETAINED_FEEDS_PER_ACCOUNT)
      throw badRequest(
        `Removed feeds are kept for ${REMOVED_FEED_RETENTION_DAYS} days so re-adding one does not ` +
          'import it again, and this account has removed too many recently. Re-add one you ' +
          'removed, or try again later.',
      );
    const [inserted] = await tx
      .insert(schema.radarFeeds)
      .values({
        radarId: radar.id,
        createdBy: actor.user.id,
        url: url.toString(),
        lookback: input.lookback,
        importAfter: feedCutoff(input.lookback),
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw badRequest('This radar is already subscribed to that feed');
    return inserted;
  });
  return dto(row);
}
async function ownFeed(actor: Actor, radarId: string, feedId: string) {
  if (!idSchema.safeParse(feedId).success) throw badRequest('Invalid feed ID');
  const radar = await target(actor, radarId);
  const [row] = await getDb()
    .select()
    .from(schema.radarFeeds)
    .where(
      and(
        eq(schema.radarFeeds.id, feedId),
        eq(schema.radarFeeds.radarId, radar.id),
        isNull(schema.radarFeeds.removedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Feed not found');
  return row;
}
export async function updateFeed(
  actor: Actor,
  radarId: string,
  feedId: string,
  raw: UpdateFeedInput,
): Promise<FeedDto> {
  const parsed = updateFeedSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid feed');
  const input = parsed.data;
  const row = await ownFeed(actor, radarId, feedId);
  const [updated] = await getDb()
    .update(schema.radarFeeds)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.lookback !== undefined
        ? {
            lookback: input.lookback,
            importAfter: feedCutoff(input.lookback),
            etag: null,
            lastModified: null,
          }
        : {}),
      nextPollAt: new Date(),
      leasedUntil: null,
      revision: sql`${schema.radarFeeds.revision} + 1`,
    })
    .where(and(eq(schema.radarFeeds.id, row.id), isNull(schema.radarFeeds.removedAt)))
    .returning();
  if (!updated) throw notFound('Feed not found');
  return dto(updated);
}
export async function deleteFeed(actor: Actor, radarId: string, feedId: string): Promise<void> {
  const row = await ownFeed(actor, radarId, feedId);
  await getDb()
    .update(schema.radarFeeds)
    .set({
      removedAt: new Date(),
      enabled: false,
      revision: sql`${schema.radarFeeds.revision} + 1`,
      leasedUntil: null,
    })
    .where(eq(schema.radarFeeds.id, row.id));
}

/**
 * The feed as it is named inside an imported blip.
 *
 * Private feeds carry their credential in the URL — `?token=` on a GitHub or
 * Patreon feed, a key in the query of a podcast host — and the attribution line
 * is written into every entry, where every member of the radar reads it and a
 * public radar publishes it. Only the owner can see the subscription itself, so
 * the body must not be the place the secret leaks from. Origin and path are
 * kept: that is what tells a reader where the words came from.
 */
function feedAttribution(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

async function fetchFeed(feed: FeedRow) {
  let url = new URL(feed.url);
  const deadline = Date.now() + 20_000;
  for (let hop = 0; hop <= 3; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Feed fetch timed out');
    const response = await publicRequest(url, {
      timeoutMs: remaining,
      maxBytes: MAX_FEED_BYTES + 1,
      headers: {
        'user-agent': `OnMyRadarFeed/1.0 (+${env().APP_URL})`,
        accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
        'accept-encoding': 'identity',
        ...(feed.etag ? { 'if-none-match': feed.etag } : {}),
        ...(feed.lastModified ? { 'if-modified-since': feed.lastModified } : {}),
      },
      wantsBody: (status) => status >= 200 && status < 300,
    });
    if (response.status === 304) return { ...response, url: url.toString() };
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      url = new URL(response.headers.location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Feed returned HTTP ${response.status}`);
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
      throw new Error('Feed must support an uncompressed response');
    if (Buffer.byteLength(response.body) > MAX_FEED_BYTES)
      throw new Error('Feed exceeds the 2 MiB limit');
    return { ...response, url: url.toString() };
  }
  throw new Error('Feed exceeded three redirects');
}
class DuplicateEntry extends Error {}
class SourceChanged extends Error {}

/** Poll a previously claimed source; replay is safe even after lease expiry. */
export async function pollFeed(feedId: string, signal?: AbortSignal): Promise<void> {
  const [feed] = await getDb()
    .select()
    .from(schema.radarFeeds)
    .where(
      and(
        eq(schema.radarFeeds.id, feedId),
        sql`omr_account_open(${schema.radarFeeds.createdBy})`,
        sql`EXISTS(SELECT 1 FROM radars r WHERE r.id=${schema.radarFeeds.radarId} AND omr_account_open(r.owner_id))`,
      ),
    );
  if (!feed || !feed.enabled || feed.removedAt) return;
  try {
    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, feed.createdBy));
    if (!user || user.state !== 'active')
      throw new Error('The account behind this feed is not active');
    // Imports respect normal radar notifications without self-notifying the owner about historical backfills.
    const actor: Actor = { user, kind: 'user' };
    const access = await requireRadar(feed.radarId, actor, 'write');
    if (access.radar.archived)
      throw new Error('This radar is archived; restore it to resume imports');
    const response = await fetchFeed(feed);
    if (response.status === 304) {
      await getDb()
        .update(schema.radarFeeds)
        .set({
          lastSuccessAt: new Date(),
          lastPolledAt: new Date(),
          lastError: null,
          failures: 0,
          leasedUntil: null,
          nextPollAt: new Date(Date.now() + POLL_MS),
        })
        .where(
          and(eq(schema.radarFeeds.id, feed.id), eq(schema.radarFeeds.revision, feed.revision)),
        );
      return;
    }
    const parsed = parseFeed(response.body, response.url);
    // Missing dates cannot demonstrate membership of a requested finite history window.
    const candidates = parsed.entries.filter(
      (e) => !feed.importAfter || (e.publishedAt && e.publishedAt >= feed.importAfter),
    );
    const known = new Set<string>();
    // Bound SQL parameter count independently from the XML/entry limits.
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const hashes = candidates.slice(offset, offset + 500).map((e) => e.hash);
      if (hashes.length)
        for (const row of await getDb()
          .select({ hash: schema.feedItems.itemHash })
          .from(schema.feedItems)
          .where(
            and(eq(schema.feedItems.feedId, feed.id), inArray(schema.feedItems.itemHash, hashes)),
          ))
          known.add(row.hash);
    }
    const pending = [
      ...new Map(candidates.filter((e) => !known.has(e.hash)).map((e) => [e.hash, e])).values(),
    ];
    let attempted = 0;
    const started = Date.now();
    for (const entry of pending) {
      // Shutdown ends the batch like the budget does: what is left is picked up
      // as a continuation, and the lease is released below rather than held.
      if (
        attempted >= CAPTURE_BUDGET ||
        Date.now() - started >= MAX_POLL_WORK_MS ||
        signal?.aborted
      )
        break;
      attempted++;
      try {
        await createBlip(
          actor,
          feed.radarId,
          {
            title: entry.title || null,
            body: `${entry.body}\n\nImported from RSS feed: ${feedAttribution(feed.url)}${entry.publishedAt ? `\nPublished: ${entry.publishedAt.toISOString()}` : ''}`.trim(),
            url: entry.url,
          },
          {
            deferDelivery: true,
            // A feed item is somebody else's words: see CaptureOptions.authored.
            authored: false,
            beforeInsert: async (tx) => {
              // Prevent pause/delete/lookback edits racing a capture after the fetch.
              const [liveUser] = await tx
                .select({ state: schema.users.state })
                .from(schema.users)
                .where(eq(schema.users.id, user.id))
                .for('share');
              if (liveUser?.state !== 'active')
                throw new Error('The account behind this feed is not active');
              const [liveRadar] = await tx
                .select({ archived: schema.radars.archived })
                .from(schema.radars)
                .where(eq(schema.radars.id, feed.radarId))
                .for('share');
              if (!liveRadar || liveRadar.archived)
                throw new Error('This radar is archived; restore it to resume imports');
              const [current] = await tx
                .select()
                .from(schema.radarFeeds)
                .where(eq(schema.radarFeeds.id, feed.id))
                .for('update');
              if (!current?.enabled || current.removedAt || current.revision !== feed.revision)
                throw new SourceChanged();
              const [claim] = await tx
                .insert(schema.feedItems)
                .values({ feedId: feed.id, itemHash: entry.hash })
                .onConflictDoNothing()
                .returning();
              if (!claim) throw new DuplicateEntry();
            },
            afterInsert: async (tx) => {
              await tx
                .update(schema.radarFeeds)
                .set({ itemCount: sql`${schema.radarFeeds.itemCount} + 1` })
                .where(eq(schema.radarFeeds.id, feed.id));
            },
          },
        );
      } catch (err) {
        if (err instanceof DuplicateEntry) continue;
        if (err instanceof SourceChanged) return;
        throw err;
      }
    }
    const more = attempted < pending.length;
    await getDb()
      .update(schema.radarFeeds)
      .set({
        title: parsed.title,
        lastPolledAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
        failures: 0,
        leasedUntil: null,
        nextPollAt: new Date(Date.now() + (more ? CONTINUATION_MS : POLL_MS)),
        // Do not accept 304 until every available matching entry has been processed.
        etag: more ? null : (response.headers.etag?.slice(0, 1000) ?? null),
        lastModified: more ? null : (response.headers['last-modified']?.slice(0, 1000) ?? null),
      })
      .where(and(eq(schema.radarFeeds.id, feed.id), eq(schema.radarFeeds.revision, feed.revision)));
  } catch (err) {
    logger.warn({ err, feedId }, 'feed poll failed');
    await getDb()
      .update(schema.radarFeeds)
      .set({
        lastPolledAt: new Date(),
        leasedUntil: null,
        lastError: (err instanceof Error ? err.message : 'Feed could not be read').slice(0, 500),
        failures: sql`${schema.radarFeeds.failures} + 1`,
        nextPollAt: new Date(
          Date.now() + Math.min(POLL_MS * 2 ** Math.min(feed.failures, 5), 24 * 60 * 60_000),
        ),
      })
      .where(and(eq(schema.radarFeeds.id, feedId), eq(schema.radarFeeds.revision, feed.revision)));
  }
}

/** Claim one due source per iteration; outbox work always gets its own turn first. */
export async function pollDueFeed(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return 0;
  // A busy delivery queue takes precedence over acquiring more feed content —
  // counting only jobs something can run, so rows of an unknown kind waiting
  // to be dead-lettered cannot pause polling.
  if (await dueBacklogAtLeast(1_000)) return 0;
  const result = await getDb().execute<{ id: string }>(sql`
    WITH picked AS (
      SELECT id FROM radar_feeds WHERE enabled AND removed_at IS NULL AND next_poll_at <= now()
        AND omr_account_open(created_by) AND EXISTS(SELECT 1 FROM radars r WHERE r.id=radar_feeds.radar_id AND omr_account_open(r.owner_id))
        AND (leased_until IS NULL OR leased_until < now())
      ORDER BY next_poll_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE radar_feeds f SET leased_until = now() + interval '5 minutes'
      FROM picked WHERE f.id = picked.id RETURNING f.id`);
  const row = result.rows[0];
  if (!row) return 0;
  await pollFeed(row.id, signal);
  return 1;
}

/** Worker upkeep: removed subscriptions past retention go, tombstones with them. */
export async function purgeRemovedFeeds(batchSize = 200): Promise<number> {
  const result = await getDb().execute(sql`
    WITH picked AS (
      SELECT id FROM radar_feeds
       WHERE removed_at < now() - make_interval(days => ${REMOVED_FEED_RETENTION_DAYS})
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    )
    DELETE FROM radar_feeds f USING picked WHERE f.id = picked.id`);
  return result.rowCount ?? 0;
}

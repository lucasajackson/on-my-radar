/**
 * A short-lived per-radar cache for whole-radar aggregates (counts, tag and lane tallies).
 *
 * Those are a scan of every blip on the radar (a 10,000-blip board is 10,000 rows) and
 * answer the same question for everybody who can read the radar, so fifty people and their
 * agents listing radars each paid for the same scan fifty times. Cached per radar, they
 * are paid once per TTL (`STATS_CACHE_TTL_MS`, 30 seconds), and concurrent callers on a
 * cold key share one load rather than each starting their own.
 *
 * ## Stale while revalidating
 *
 * When an entry passes its TTL it is not thrown away: the next reader gets the old value at
 * once and one background load replaces it. Without that, the reader who arrives just after
 * the TTL waits for the full scan, every 30 seconds, and that reader is the p95. A value is
 * served stale for at most `STALE_FACTOR` TTLs; past that the reader waits for a fresh one.
 *
 * Process-local on purpose, and safe to be: a stale number is a count that is out of date
 * by a few TTLs on a replica that did not see the write, never a wrong authorization
 * answer (nothing here is consulted to decide who may read what). A person's own write
 * through this process drops the radar's entries (`invalidateRadarStats`) so the count moves
 * when they add a blip; an agent's write drops them at most once per two seconds
 * (`invalidateRadarStatsSoon`), because a hot radar would otherwise be one scan per write.
 * Comments are not in these aggregates. 0 disables the cache.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';

const MAX_ENTRIES = 5_000;
const STALE_FACTOR = 5;

interface Entry {
  at: number;
  /** The load in flight or finished. */
  value: Promise<unknown>;
  /** The last value that loaded successfully, served while a refresh runs. */
  settled?: { value: unknown };
  refreshing?: boolean;
  /** After a failed refresh, the earliest time to try again. `at` never moves: staleness is measured from the last good load. */
  retryAfter?: number;
}
const entries = new Map<string, Entry>();

export function cachedForRadar<T>(
  radarId: string,
  kind: string,
  load: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const ttl = env().STATS_CACHE_TTL_MS;
  if (ttl <= 0) return load();
  const key = `${radarId}:${kind}`;
  const hit = entries.get(key);
  if (hit && now - hit.at < ttl) return hit.value as Promise<T>;
  if (hit?.settled && now - hit.at < ttl * STALE_FACTOR) {
    if (!hit.refreshing && (hit.retryAfter ?? 0) <= now) {
      hit.refreshing = true;
      load().then(
        (value) => {
          // Only if this entry is still the cached one. `invalidateRadarStats` deletes entries,
          // and a fresh load puts a new object in their place, so the entry itself is the
          // generation: a refresh that started before an invalidation never overwrites what
          // came after it.
          if (entries.get(key) !== hit) return;
          entries.set(key, { at: Date.now(), value: Promise.resolve(value), settled: { value } });
        },
        (err: unknown) => {
          logger.warn({ err, key }, 'stats refresh failed; serving the previous value');
          // Try again shortly rather than on every read, but leave `at` alone: the value keeps
          // ageing from its last good load, so a refresh that never succeeds ends in a fresh
          // load (or its error) once `STALE_FACTOR` TTLs have passed, never a stale value forever.
          hit.refreshing = false;
          hit.retryAfter = now + 5_000;
        },
      );
    }
    return Promise.resolve(hit.settled.value as T);
  }
  if (entries.size >= MAX_ENTRIES) {
    for (const [k, v] of entries) if (now - v.at >= ttl * STALE_FACTOR) entries.delete(k);
    for (const k of entries.keys()) {
      if (entries.size < MAX_ENTRIES) break;
      entries.delete(k);
    }
  }
  const value = load();
  const entry: Entry = { at: now, value };
  entries.set(key, entry);
  value.then(
    (settled) => {
      if (entries.get(key) === entry) entry.settled = { value: settled };
    },
    () => {
      // A failed load must not be served for the next 30 seconds.
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return value;
}

/** Drop everything cached for a radar. Call after a write that changes its contents. */
export function invalidateRadarStats(radarId: string): void {
  const prefix = `${radarId}:`;
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}

/** The most often an agent's writes may drop one radar's entries; staleness is bounded by this. */
const AGENT_DROP_MS = 2_000;
const lastDrop = new Map<string, number>();
const dropQueued = new Set<string>();

/**
 * The same drop for a write made through a connection (an agent), at most once per
 * `AGENT_DROP_MS` per radar: the first write in a quiet period drops at once, the rest of a
 * burst share one trailing drop. So a person watching sees an agent's blip in the counts and
 * facets within seconds, while an agent writing at speed costs one rescan per window, not per write.
 */
export function invalidateRadarStatsSoon(radarId: string): void {
  if (env().STATS_CACHE_TTL_MS <= 0) return;
  const wait = (lastDrop.get(radarId) ?? 0) + AGENT_DROP_MS - Date.now();
  if (wait <= 0) {
    if (lastDrop.size >= MAX_ENTRIES) lastDrop.clear();
    lastDrop.set(radarId, Date.now());
    invalidateRadarStats(radarId);
    return;
  }
  if (dropQueued.has(radarId)) return;
  dropQueued.add(radarId);
  setTimeout(() => {
    dropQueued.delete(radarId);
    lastDrop.set(radarId, Date.now());
    invalidateRadarStats(radarId);
  }, wait).unref();
}

/** Test seam. */
export function clearStatsCacheForTesting(): void {
  entries.clear();
  lastDrop.clear();
}

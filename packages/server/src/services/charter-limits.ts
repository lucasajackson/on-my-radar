/**
 * Rate limits on saving the charter.
 *
 * The bearer limiter (`rate-limit.ts`) counts requests of agents; it does not see a browser, and a
 * charter save is not like a read: each one rewrites a document of up to 400k characters under a
 * row lock, and a sealed one also writes a version that is kept for good. So the charter has its
 * own two buckets, keyed by the writer (user, connection and agent, as `writerOf` names them) and
 * the radar, charged before the transaction opens so a refused save holds no lock:
 *
 * - every save (a working-text autosave included) draws on a generous bucket an editor does not
 *   reach: it debounces to a few saves a minute;
 * - a save that seals a version also draws on a smaller one, which is what bounds version spam.
 *
 * A limiter that cannot reach Postgres lets the save through and says so in the log, as the
 * bearer limiter does.
 */
import { env } from '../env.js';
import { ApiError, tooManyRequests, type Actor } from '../http.js';
import { logger } from '../logger.js';
import { countRateLimited } from '../metrics.js';
import { takeToken } from './token-bucket.js';

/** The writer a bucket belongs to: user, connection and agent, as `writerOf` names them. */
const writerKey = (actor: Actor): string =>
  [
    actor.user.id,
    actor.connection ? `${actor.connection.kind}:${actor.connection.id}` : 'session',
    actor.agent?.agentId ?? '',
  ].join('|');

/** Charges one bucket; a refusal is the 429, a limiter that cannot be reached lets the write through. */
async function charge(
  key: string,
  spec: { perMinute: number; burst: number },
  message: string,
): Promise<void> {
  try {
    const taken = await takeToken(key, spec);
    if (!taken.ok) {
      countRateLimited('charter', 'rest');
      throw tooManyRequests(message, taken.retryAfterSeconds);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn({ err: error }, 'charter save limiter unavailable; save allowed');
  }
}

export async function chargeCharterSave(
  actor: Actor,
  radarId: string,
  /** Whether this write seals a version (a checkpointed save, an anchor change). */
  seals: boolean,
): Promise<void> {
  const config = env();
  if (!config.RATE_LIMIT_ENABLED) return;
  await charge(
    `charter-save:${radarId}:${writerKey(actor)}`,
    { perMinute: config.CHARTER_SAVE_PER_MINUTE, burst: config.CHARTER_SAVE_BURST },
    `Saving this charter is limited to ${config.CHARTER_SAVE_PER_MINUTE} times a minute for one writer. Slow down and retry.`,
  );
  if (seals) await chargeCharterSeal(actor, radarId);
}

/**
 * The smaller budget, for a save that makes a version. Charged up front by a save that asked to
 * seal, and afterwards by one that did not ask but sealed anyway (it orphaned or healed an
 * amendment, or sealed another writer's working text): `saveCharter` finds that out under the
 * lock, rolls back, and comes here before trying again.
 */
export async function chargeCharterSeal(actor: Actor, radarId: string): Promise<void> {
  const config = env();
  if (!config.RATE_LIMIT_ENABLED) return;
  await charge(
    `charter-seal:${radarId}:${writerKey(actor)}`,
    { perMinute: config.CHARTER_SEAL_PER_MINUTE, burst: config.CHARTER_SEAL_BURST },
    `Sealing versions of this charter is limited to ${config.CHARTER_SEAL_PER_MINUTE} a minute for one writer. Save with checkpoint false (or wait) and retry.`,
  );
}

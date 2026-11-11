/** Outbox worker and bounded housekeeping. Unknown job kinds wait for a newer worker. */
import { createServer } from 'node:http';
import { sweepAuthRetention } from './auth/retention.js';
import { closeDb, pingDb, poolStatus } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv, reportTokenErrors } from './env.js';
import { finishWithin } from './lifecycle.js';
import { runEach, runWorkerLoop } from './worker-loop.js';
import { logger } from './logger.js';
import { closeApnsConnections } from './services/apns.js';
import { drainDue, sweepOutbox } from './services/outbox.js';
import { purgePushDeliveries } from './services/push-delivery.js';
import { sweepDueReminders } from './services/reminders.js';
import { pollDueFeed, purgeRemovedFeeds } from './services/rss.js';
import { checkDueBriefBinding } from './services/brief-bindings.js';
import { cleanupEmailReceipts } from './services/inbound-email.js';
import { drainSubscriptionDeliveries } from './services/subscriptions.js';
// Import handlers before claiming jobs. API inline kicks remain a fallback.
import './services/blips.js';
import './services/mail.js';
import './services/notifications.js';
import { purgeOldNotifications } from './services/notifications.js';
import { purgeExpiredIdempotencyKeys } from './services/helpdesk.js';
import { purgeExpiredRequestKeys } from './services/idempotency.js';
import { purgeExpiredRelayNonces } from './services/relay-nonces.js';
import { purgeIdleBuckets } from './services/token-bucket.js';
import {
  drainIntegrationDeliveries,
  purgeExpiredIntegrationEvents,
} from './services/integration-events.js';
import { purgeForgottenMemories, purgeIdleSessions } from './services/agent-memory.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadEnv();
  reportTokenErrors(config, logger);
  if (config.MIGRATE_ON_BOOT) logger.info(await runMigrations(), 'migrations checked');
  await pingDb();

  const health = createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          role: 'worker',
          buildSha: config.ONMYRADAR_BUILD_SHA || null,
        }),
      );
    } else res.writeHead(404).end();
  });
  health.listen(config.PORT, () =>
    logger.info({ port: config.PORT, databasePool: poolStatus() }, 'worker health listening'),
  );

  const stop = new AbortController();
  let lastSweep = 0;
  // Feed network waits never hold up queued notifications or housekeeping.
  // Each lane remains single-concurrency and all of them are joined on shutdown.
  const work = Promise.all([
    runWorkerLoop(
      () => drainSubscriptionDeliveries().then((n) => n > 0),
      stop.signal,
      (err) => logger.error({ err }, 'outbound subscription drain failed'),
    ),
    // Client-portal events (HELPDESK §5.4): their own lane, so a slow portal
    // never holds up a radar's subscriptions, and vice versa.
    runWorkerLoop(
      () => drainIntegrationDeliveries().then((n) => n > 0),
      stop.signal,
      (err) => logger.error({ err }, 'integration delivery drain failed'),
    ),
    runWorkerLoop(
      async () => {
        if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
          lastSweep = Date.now();
          // Each sweep stands alone: one that fails every time must not stop
          // the others, and none of them may stand between the queue and its
          // drain below.
          const swept = await runEach(
            [
              ['pushDeliveries', purgePushDeliveries],
              ['removed', sweepAuthRetention],
              ['notifications', purgeOldNotifications],
              ['emailReceipts', cleanupEmailReceipts],
              ['forgottenMemories', purgeForgottenMemories],
              ['agentSessions', purgeIdleSessions],
              ['outbox', sweepOutbox],
              ['removedFeeds', purgeRemovedFeeds],
              ['helpdeskIdempotency', purgeExpiredIdempotencyKeys],
              ['requestKeys', purgeExpiredRequestKeys],
              ['relayNonces', purgeExpiredRelayNonces],
              ['rateLimitBuckets', purgeIdleBuckets],
              ['helpdeskEvents', purgeExpiredIntegrationEvents],
            ],
            (task, err) => logger.error({ err, task }, 'retention sweep failed'),
          );
          logger.info({ ...swept, databasePool: poolStatus() }, 'retention sweep complete');
        }
        if (stop.signal.aborted) return false;
        await runEach([['reminders', sweepDueReminders]], (task, err) =>
          logger.error({ err, task }, 'reminder sweep failed'),
        );
        // Shutdown stops the claim; anything claimed but not started goes back.
        return (await drainDue(5, undefined, stop.signal)) > 0;
      },
      stop.signal,
      (err) => logger.error({ err }, 'outbox drain iteration failed'),
    ),
    runWorkerLoop(
      () => pollDueFeed(stop.signal).then((ran) => ran > 0),
      stop.signal,
      (err) => logger.error({ err }, 'feed poll iteration failed'),
    ),
    // Briefs bound to a repository: a GitLab round trip per binding, so its own
    // lane, and an idle sleep long enough that an estate with no bindings asks
    // Postgres twice a minute rather than every two seconds.
    runWorkerLoop(
      () => checkDueBriefBinding(stop.signal).then((n) => n > 0),
      stop.signal,
      (err) => logger.error({ err }, 'brief binding check iteration failed'),
      30_000,
    ),
  ]);

  const shutdown = (signal: string) => {
    if (stop.signal.aborted) return;
    stop.abort();
    logger.info({ signal }, 'worker shutting down');
    // Join every in-flight lane; work interrupted by the deadline retains its lease.
    void finishWithin(
      async () => {
        await work;
        closeApnsConnections();
        await new Promise<void>((resolve) => health.close(() => resolve()));
        await closeDb();
      },
      config.SHUTDOWN_TIMEOUT_MS,
      () => health.closeAllConnections(),
    )
      .then((clean) => {
        if (!clean) logger.error('worker shutdown deadline exceeded');
        process.exit(clean ? 0 : 1);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'worker shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await work;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});

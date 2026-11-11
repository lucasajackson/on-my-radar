/**
 * Process entrypoint: validate the environment, migrate if asked, start serving,
 * and shut down cleanly when Kubernetes sends SIGTERM.
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { closeDb, pingDb, poolStatus } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  env,
  loadEnv,
  mailConfigured,
  oidcConfigured,
  pushKeysConfigured,
  reportTokenErrors,
  storageConfigured,
} from './env.js';
import { drainHttpServer } from './lifecycle.js';
import { startMetricsServer } from './metrics.js';
import { migrateAllRadars } from './services/charter.js';
import { checkBrowserUploadCors } from './services/storage.js';
import { bootSummary, logger } from './logger.js';

async function main(): Promise<void> {
  // Fail loudly and immediately on bad config rather than at the first request.
  const config = loadEnv();
  reportTokenErrors(config, logger);

  if (config.MIGRATE_ON_BOOT) {
    const result = await runMigrations();
    logger.info(result, 'migrations checked');
  }

  await pingDb();

  // Surface degraded-but-running states at boot; each of these turns a feature
  // off rather than stopping the server.
  if (!storageConfigured(config)) logger.warn('S3 is not configured — attachments are disabled');
  else
    // Not awaited: a slow bucket must not hold the listener. See the function
    // for why the bucket's CORS policy is checked from here at all.
    void checkBrowserUploadCors().then((result) => {
      if (result && !result.ok)
        logger.error(
          result,
          'the storage bucket refuses browser uploads from this origin — set its CORS policy (docs/DEPLOY.md)',
        );
    });
  if (!mailConfigured(config))
    logger.warn(
      'no mail provider is configured (RESEND_API_KEY, or MAIL_PROVIDER=smtp with SMTP_URL) — sign-in emails cannot be sent',
    );
  if (!oidcConfigured(config)) logger.info('OIDC is not configured — SSO sign-in is hidden');
  else if (config.OIDC_TRUST_IDP_EMAIL)
    logger.warn(
      'OIDC_TRUST_IDP_EMAIL is on — SSO email addresses are treated as verified for first sign-in. Only valid if users cannot change their own email at the IdP.',
    );
  if (!pushKeysConfigured(config))
    logger.info('VAPID keys are not set — browser push is hidden, email still works');

  // Existing Architecture radars are moved into their single charter document (migration 0091's
  // tables) once, here. Not awaited, and a refusal is logged: it must not hold the listener, and
  // a radar that cannot be moved is moved lazily on its first architecture read instead.
  if (config.MIGRATE_ON_BOOT)
    void migrateAllRadars().then(
      (reports) => {
        for (const r of reports)
          logger.info(r, r.status === 'refused' ? 'charter not moved' : 'charter moved');
      },
      (err: unknown) => logger.error({ err }, 'moving charters failed'),
    );

  const server = serve({ fetch: createApp().fetch, port: config.PORT }, (info) => {
    logger.info(
      { ...bootSummary(), boundPort: info.port, databasePool: poolStatus() },
      'on my radar is listening',
    );
  });

  // Its own port, never routed by the ingress. See metrics.ts.
  const metrics = startMetricsServer();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    void drainHttpServer(server, {
      drainMs: config.SHUTDOWN_DRAIN_MS,
      timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
      closeResources: async () => {
        metrics?.close();
        await closeDb();
      },
    })
      .then((clean) => {
        if (!clean) logger.error('shutdown deadline exceeded');
        process.exit(clean ? 0 : 1);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // env() may itself throw here, so build the message defensively.
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

export { env };

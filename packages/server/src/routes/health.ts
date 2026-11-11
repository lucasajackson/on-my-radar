/**
 * Probes.
 *
 * `/health/live` answers without touching the database — a database blip must
 * not get the pod killed — and reports the build SHA so an unauthenticated
 * prober can prove which build is running. `/health/ready` does check the
 * database, because a pod that cannot reach Postgres should leave the endpoints,
 * but on its own connection (`pingDbForReadiness`): a saturated shared pool must
 * not make a busy pod look dead.
 */
import { Hono } from 'hono';
import { env } from '../env.js';
import { isDraining } from '../lifecycle.js';
import { pingDbForReadiness } from '../db/client.js';
import type { AppEnv } from '../http.js';
import { logger } from '../logger.js';

export const healthRoutes = new Hono<AppEnv>();

const startedAt = Date.now();

healthRoutes.get('/live', (c) =>
  c.json({
    status: 'ok',
    buildSha: env().ONMYRADAR_BUILD_SHA || null,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }),
);

healthRoutes.get('/ready', async (c) => {
  if (isDraining()) return c.json({ status: 'draining' }, 503);
  try {
    await pingDbForReadiness();
    return isDraining() ? c.json({ status: 'draining' }, 503) : c.json({ status: 'ready' });
  } catch (err) {
    // The detail goes to the log, not the body: this route is unauthenticated,
    // and a driver error names hosts, roles and why authentication failed.
    logger.warn({ err }, 'readiness check could not reach the database');
    return c.json({ status: 'unready', reason: 'database unreachable' }, 503);
  }
});

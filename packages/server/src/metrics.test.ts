import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { createApp } from './app.js';
import { closeDb, getDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv, setEnvForTesting } from './env.js';
import {
  countRateLimited,
  observeMcpTool,
  renderMetrics,
  resetMetricsForTesting,
  startMetricsServer,
} from './metrics.js';
import { DEAD_LETTER_AT } from './services/outbox.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
process.env['DATABASE_URL'] ??= 'postgres://unused';

describe.skipIf(!hasDatabase)('/metrics', () => {
  beforeAll(async () => {
    setEnvForTesting(loadEnv({ ...process.env, METRICS_PORT: '0' }));
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  it('is not served by the public app at all', async () => {
    const res = await createApp().request('/metrics');
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('omr_db_pool_connections');
  });

  it('exposes pool, route-pattern durations, MCP tool durations, 429s and outbox lag', async () => {
    const app = createApp();
    // A path carrying a credential must never become a label.
    await app.request('/api/radars/not-a-real-id-1234');
    await app.request('/hooks/some-id/super-secret-token', { method: 'POST', body: '{}' });
    observeMcpTool('read_radar', 'ok', 0.12);
    countRateLimited('token', 'mcp');
    await getDb().execute(sql`DELETE FROM outbox WHERE kind = 'metrics-test'`);
    await getDb().execute(sql`
      INSERT INTO outbox (kind, run_after) VALUES
        ('metrics-test', now() - interval '90 seconds'),
        ('metrics-test', ${DEAD_LETTER_AT}::timestamptz)`);
    resetMetricsForTesting();

    const text = await renderMetrics();
    expect(text).toMatch(/omr_db_pool_connections\{state="total"\} \d+/);
    expect(text).toMatch(/omr_db_pool_connections\{state="idle"\} \d+/);
    expect(text).toMatch(/omr_db_pool_connections\{state="waiting"\} \d+/);
    expect(text).toContain('omr_http_request_duration_seconds_bucket{');
    expect(text).toContain('route="/api/radars/:id"');
    expect(text).not.toContain('super-secret-token');
    expect(text).not.toContain('not-a-real-id-1234');
    expect(text).toContain('omr_mcp_tool_duration_seconds_count{outcome="ok",tool="read_radar"} 1');
    expect(text).toContain('omr_rate_limited_total{scope="token",surface="mcp"} 1');
    const lag = Number(/^omr_outbox_lag_seconds (\S+)/m.exec(text)?.[1]);
    expect(lag).toBeGreaterThanOrEqual(89);
    expect(Number(/^omr_outbox_dead_letters (\S+)/m.exec(text)?.[1])).toBeGreaterThanOrEqual(1);
    await getDb().execute(sql`DELETE FROM outbox WHERE kind = 'metrics-test'`);
  });

  it('serves on its own port, behind METRICS_TOKEN when one is set', async () => {
    setEnvForTesting(
      loadEnv({ ...process.env, METRICS_PORT: '19464', METRICS_TOKEN: 'a-metrics-token-1234567' }),
    );
    const server = startMetricsServer();
    expect(server).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    try {
      const port = (server?.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/metrics`;
      expect((await fetch(url)).status).toBe(401);
      const ok = await fetch(url, { headers: { authorization: 'Bearer a-metrics-token-1234567' } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toMatch(/text\/plain/);
      expect(await ok.text()).toContain('omr_db_pool_max');
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      server?.close();
    }
  });

  it('is off when METRICS_PORT is 0', () => {
    setEnvForTesting(loadEnv({ ...process.env, METRICS_PORT: '0' }));
    expect(startMetricsServer()).toBeNull();
  });
});

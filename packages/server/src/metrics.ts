/**
 * Prometheus text metrics, with no dependency: a handful of counters and histograms
 * kept in process, plus gauges read at scrape time (the pool, the outbox).
 *
 * Labels are bounded on purpose. Request duration is labelled by the route
 * *pattern* Hono matched (`/api/radars/:id`), never the path, because paths carry
 * credentials (webhook tokens, invitation links) and ids, and one series per id is
 * how a metrics server falls over. MCP durations are labelled by tool name, which is a
 * closed set.
 *
 * Served by its own listener (`metricsServer`, `METRICS_PORT`), not by the public app:
 * the ingress routes only the app port, so these are reachable from inside the cluster
 * and nowhere else, and `METRICS_TOKEN` can require a bearer on top.
 */
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, poolStatus } from './db/client.js';
import { Semaphore } from './db/request-gate.js';
import { env } from './env.js';
import { logger } from './logger.js';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const MAX_SERIES = 500;

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
}

class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    if (!this.values.has(key) && this.values.size >= MAX_SERIES) return;
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) out.push(`${this.name} 0`);
    for (const [key, v] of this.values) out.push(`${this.name}${key ? `{${key}}` : ''} ${v}`);
    return out;
  }
}

class Histogram {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(labels: Labels, seconds: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { counts: new Array<number>(BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += seconds;
    s.count += 1;
  }
  count(labels: Labels): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const sep = key ? `${key},` : '';
      BUCKETS.forEach((le, i) =>
        out.push(`${this.name}_bucket{${sep}le="${le}"} ${s.counts[i] ?? 0}`),
      );
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${key ? `{${key}}` : ''} ${s.sum}`);
      out.push(`${this.name}_count${key ? `{${key}}` : ''} ${s.count}`);
    }
    return out;
  }
}

const httpDuration = new Histogram(
  'omr_http_request_duration_seconds',
  'HTTP request duration by method, matched route pattern and status class.',
);
const mcpDuration = new Histogram(
  'omr_mcp_tool_duration_seconds',
  'MCP tool call duration by tool and outcome (ok, refused, failed).',
);
const rateLimited = new Counter(
  'omr_rate_limited_total',
  'Requests refused with 429 by the bearer rate limiter, by bucket and surface.',
);
const idempotentReplays = new Counter(
  'omr_idempotent_replays_total',
  'Writes answered from an Idempotency-Key instead of being repeated.',
);

export function observeHttp(method: string, route: string, status: number, seconds: number): void {
  httpDuration.observe({ method, route, status: `${Math.floor(status / 100)}xx` }, seconds);
}
export function observeMcpTool(
  tool: string,
  outcome: 'ok' | 'refused' | 'failed',
  seconds: number,
): void {
  mcpDuration.observe({ tool, outcome }, seconds);
}
export function countRateLimited(
  scope: 'token' | 'user' | 'charter',
  surface: 'rest' | 'mcp',
): void {
  rateLimited.inc({ scope, surface });
}
export function countIdempotentReplay(scope: string): void {
  idempotentReplays.inc({ scope });
}
export function rateLimitedCount(labels: Labels = {}): number {
  return rateLimited.get(labels);
}

/* ------------------------------ scrape-time gauges ------------------------- */

interface OutboxStats {
  pending: number;
  lagSeconds: number;
  deadLetters: number;
}
let outboxCache: { at: number; value: OutboxStats } | null = null;

/** The outbox, read at most every 10 seconds however often it is scraped. */
async function outboxStats(): Promise<OutboxStats | null> {
  if (outboxCache && Date.now() - outboxCache.at < 10_000) return outboxCache.value;
  try {
    const { rows } = await getDb().execute<{ pending: number; lag: number; dead: number }>(sql`
      SELECT count(*) FILTER (WHERE run_after <= now())::int AS pending,
             COALESCE(EXTRACT(EPOCH FROM now() - min(run_after) FILTER (WHERE run_after <= now())), 0)::float8 AS lag,
             count(*) FILTER (WHERE run_after >= '9999-01-01')::int AS dead
        FROM outbox`);
    const row = rows[0];
    const value = {
      pending: row?.pending ?? 0,
      lagSeconds: Math.max(0, row?.lag ?? 0),
      deadLetters: row?.dead ?? 0,
    };
    outboxCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    logger.warn({ err }, 'metrics: could not read the outbox');
    return outboxCache?.value ?? null;
  }
}

function gauge(name: string, help: string, rows: Array<[Labels, number]>): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...rows.map(([labels, v]) => {
      const key = labelKey(labels);
      return `${name}${key ? `{${key}}` : ''} ${v}`;
    }),
  ];
}

export async function renderMetrics(): Promise<string> {
  const pool = poolStatus();
  const outbox = await outboxStats();
  const mem = process.memoryUsage();
  const lines = [
    ...gauge('omr_db_pool_connections', 'Shared pool connections by state.', [
      [{ state: 'total' }, pool.total],
      [{ state: 'idle' }, pool.idle],
      [{ state: 'waiting' }, pool.waiting],
    ]),
    ...gauge('omr_db_pool_max', 'Configured pool size.', [[{}, pool.max]]),
    '# HELP omr_db_gate_waits_total Statements that waited on the per-request query cap.',
    '# TYPE omr_db_gate_waits_total counter',
    `omr_db_gate_waits_total ${Semaphore.waited}`,
    ...httpDuration.render(),
    ...mcpDuration.render(),
    ...rateLimited.render(),
    ...idempotentReplays.render(),
    ...gauge('omr_outbox_pending', 'Outbox jobs due now.', [[{}, outbox?.pending ?? 0]]),
    ...gauge('omr_outbox_lag_seconds', 'Age of the oldest due outbox job.', [
      [{}, outbox?.lagSeconds ?? 0],
    ]),
    ...gauge('omr_outbox_dead_letters', 'Outbox jobs parked as dead letters.', [
      [{}, outbox?.deadLetters ?? 0],
    ]),
    ...gauge('process_resident_memory_bytes', 'Resident set size.', [[{}, mem.rss]]),
    ...gauge('nodejs_heap_used_bytes', 'V8 heap in use.', [[{}, mem.heapUsed]]),
    ...gauge('process_uptime_seconds', 'Process uptime.', [[{}, Math.round(process.uptime())]]),
  ];
  return `${lines.join('\n')}\n`;
}

/** Test seam. */
export function resetMetricsForTesting(): void {
  outboxCache = null;
}

function authorized(header: string | undefined): boolean {
  const token = env().METRICS_TOKEN;
  if (!token) return true;
  const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The listener, or null when `METRICS_PORT` is 0. */
export function startMetricsServer(): Server | null {
  const port = env().METRICS_PORT;
  if (port === 0) return null;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    renderMetrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'metrics render failed');
        res.writeHead(500).end();
      });
  });
  server.on('error', (err) => logger.error({ err }, 'metrics listener error'));
  server.listen(port, () => logger.info({ port }, 'metrics listening (internal only)'));
  return server;
}

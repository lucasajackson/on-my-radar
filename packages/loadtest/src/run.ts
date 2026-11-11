/* eslint-disable no-console -- a command-line runner: its printed verdict is the product */
/**
 * The load-test runner.
 *
 *   LOADTEST_PG_URL=postgres://postgres@localhost:55442/postgres \
 *     pnpm --filter @onmyradar/loadtest start -- --image omr-loadtest:after --label after
 *
 * Per run: drop and recreate the `omr_loadtest` database, migrate it with the
 * image under test, seed it, start the app (and the outbox worker) constrained
 * like production (`--cpus=0.5 --memory=512m`, DB_POOL_MAX=10), drive it with
 * k6, and print a markdown table of the SLOs.
 *
 * Local only: the database and the app must be on this machine
 * (see `config.ts`). Prerequisites: docker, k6, and a local Postgres with
 * max_connections=100 reachable from containers as host.docker.internal.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  APP_HOST,
  APP_PORT,
  assertLocalUrl,
  databaseUrls,
  mergeAppEnv,
  DB_NAME,
  SESSION_SECRET,
} from './config.js';
import { seed } from './seed.js';

const APP = 'omr-lt-app';
const WORKER = 'omr-lt-worker';

// `pnpm start -- --flag` may hand the script a literal `--` first; parseArgs would stop reading flags at it.
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));

const { values } = parseArgs({
  args: argv,
  options: {
    image: { type: 'string' },
    label: { type: 'string', default: 'run' },
    out: { type: 'string' },
    duration: { type: 'string', default: '5m' },
    think: { type: 'string', default: '1500' },
    'agent-vus': { type: 'string', default: '150' },
    'ui-vus': { type: 'string', default: '50' },
    idempotency: { type: 'boolean', default: false },
    'no-worker': { type: 'boolean', default: false },
    cpus: { type: 'string', default: '0.5' },
    memory: { type: 'string', default: '512m' },
    pool: { type: 'string', default: '10' },
    env: { type: 'string', multiple: true, default: [] },
  },
  allowPositionals: true,
});

function sh(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !opts.allowFail)
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${String(res.status)}): ${res.stderr || res.stdout}`,
    );
  return res.stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How containers reach this machine. `host-gateway` is Docker's own alias; some VM-based Docker
 * setups (Rancher Desktop, for one) answer on their own gateway address instead, so set
 * LOADTEST_HOST_GATEWAY to it there.
 */
const HOST_ALIAS = `host.docker.internal:${process.env['LOADTEST_HOST_GATEWAY'] ?? 'host-gateway'}`;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`http://${APP_HOST}:${APP_PORT}/health/ready`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(
    `app did not become ready. Logs:\n${sh('docker', ['logs', '--tail', '40', APP])}`,
  );
}

function appEnvArgs(containerDbUrl: string, extra: string[]): string[] {
  const env: Record<string, string> = {
    DATABASE_URL: containerDbUrl,
    SESSION_SECRET,
    NODE_ENV: 'production',
    PORT: '3500',
    PUBLIC_URL: `http://localhost:${APP_PORT}`,
    DB_POOL_MAX: values.pool,
    MIGRATE_ON_BOOT: 'false',
    // The pinned seed users have invented addresses; nothing here may send mail.
    RESEND_API_KEY: '',
  };
  return Object.entries(mergeAppEnv(env, extra)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

function limits(): string[] {
  return ['--cpus', values.cpus, '--memory', values.memory];
}

/** Sum of VmRSS over every process in the container, in MiB (node is the only big one). */
function containerRssMiB(name: string): number {
  const out = sh(
    'docker',
    ['exec', name, 'sh', '-c', 'cat /proc/[0-9]*/status 2>/dev/null | grep VmRSS'],
    { allowFail: true },
  );
  let kib = 0;
  for (const line of out.split('\n')) kib += Number(/(\d+)/.exec(line)?.[1] ?? 0);
  return kib / 1024;
}

interface K6Metric {
  [stat: string]: number | undefined;
}
type K6Summary = Record<string, K6Metric & { values?: K6Metric }>;

function stat(summary: K6Summary, metric: string, key: string): number | null {
  const m = summary[metric];
  if (!m) return null;
  const v = m.values?.[key] ?? m[key];
  return typeof v === 'number' ? v : null;
}

const fmtMs = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(0)} ms`);

async function main(): Promise<void> {
  const image = values.image;
  if (!image) throw new Error('Pass --image <tag> (the app image under test).');
  const label = values.label;
  const outDir = resolve(values.out ?? join(process.cwd(), '.out', label));
  await mkdir(outDir, { recursive: true });

  const adminUrl = process.env['LOADTEST_PG_URL'];
  if (!adminUrl) throw new Error('Set LOADTEST_PG_URL (postgres://…@localhost:<port>/postgres).');
  const urls = databaseUrls(adminUrl);
  assertLocalUrl(`http://${APP_HOST}:${APP_PORT}`, 'the app URL');

  console.log(`[${label}] image ${image}; output ${outDir}`);

  // Clean slate: containers, then the database.
  sh('docker', ['rm', '-f', APP, WORKER], { allowFail: true });
  const admin = new pg.Client({ connectionString: urls.admin });
  await admin.connect();
  // The only database this program ever drops is its own scratch one.
  if (!/^omr_loadtest[a-z0-9_]*$/.test(DB_NAME))
    throw new Error('Refusing to drop a database that is not omr_loadtest*.');
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  const maxConnections = Number(
    (await admin.query<{ max_connections: string }>('SHOW max_connections')).rows[0]
      ?.max_connections,
  );
  await admin.end();

  console.log(`[${label}] migrating with the image under test`);
  sh('docker', [
    'run',
    '--rm',
    '--add-host',
    HOST_ALIAS,
    ...appEnvArgs(urls.container, values.env),
    image,
    'node',
    'packages/server/dist/db/migrate.js',
  ]);

  console.log(`[${label}] seeding`);
  const fixtures = await seed(urls.app, outDir);

  console.log(
    `[${label}] starting app (${values.cpus} cpu, ${values.memory}, pool ${values.pool})`,
  );
  sh('docker', [
    'run',
    '-d',
    '--name',
    APP,
    ...limits(),
    '--add-host',
    HOST_ALIAS,
    '-p',
    `${APP_PORT}:3500`,
    ...appEnvArgs(urls.container, values.env),
    image,
  ]);
  if (!values['no-worker'])
    sh('docker', [
      'run',
      '-d',
      '--name',
      WORKER,
      '--add-host',
      HOST_ALIAS,
      ...limits(),
      ...appEnvArgs(urls.container, values.env).concat(['-e', 'PORT=3501']),
      image,
      'node',
      'packages/server/dist/worker.js',
    ]);
  await waitReady();

  const db = new pg.Client({ connectionString: urls.app });
  await db.connect();
  const deadlocks = async () =>
    Number(
      (
        await db.query<{ deadlocks: string }>(
          `SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = $1`,
          [DB_NAME],
        )
      ).rows[0]?.deadlocks ?? 0,
    );
  const deadlocksBefore = await deadlocks();

  // Samplers: process RSS every 3 s, Postgres connections every 5 s.
  let peakRss = 0;
  let peakConnections = 0;
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, containerRssMiB(APP));
  }, 3000);
  const connTimer = setInterval(() => {
    void db
      .query<{ n: string }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'`,
        [DB_NAME],
      )
      .then((r) => {
        peakConnections = Math.max(peakConnections, Number(r.rows[0]?.n ?? 0));
      })
      .catch(() => undefined);
  }, 5000);

  console.log(`[${label}] k6 for ${values.duration}`);
  const summaryPath = join(outDir, 'k6-summary.json');
  const k6 = spawn(
    'k6',
    [
      'run',
      '--quiet',
      '--summary-export',
      summaryPath,
      '-e',
      `BASE_URL=http://${APP_HOST}:${APP_PORT}`,
      '-e',
      `FIXTURES=${join(outDir, 'fixtures.json')}`,
      '-e',
      `DURATION=${values.duration}`,
      '-e',
      `THINK_MS=${values.think}`,
      '-e',
      `AGENT_VUS=${values['agent-vus']}`,
      '-e',
      `UI_VUS=${values['ui-vus']}`,
      '-e',
      `IDEMPOTENCY=${values.idempotency ? '1' : '0'}`,
      fileURLToPath(new URL('../k6/scale.js', import.meta.url)),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let k6Log = '';
  k6.stdout.on('data', (d: Buffer) => (k6Log += d.toString()));
  k6.stderr.on('data', (d: Buffer) => (k6Log += d.toString()));
  const k6Exit: number = await new Promise((r) => k6.on('close', (code) => r(code ?? 1)));
  clearInterval(rssTimer);
  clearInterval(connTimer);
  await writeFile(join(outDir, 'k6.log'), k6Log);

  peakRss = Math.max(peakRss, containerRssMiB(APP));
  const inspect = sh('docker', [
    'inspect',
    '--format',
    '{{.State.OOMKilled}} {{.RestartCount}}',
    APP,
  ]);
  const [oom = '?', restarts = '?'] = inspect.split(' ');
  const deadlocksDelta = (await deadlocks()) - deadlocksBefore;
  const dupes = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM (
           SELECT substring(body from 'nonce:([A-Za-z0-9-]+)') AS nonce
             FROM blips WHERE body LIKE 'load test capture nonce:%'
            GROUP BY 1 HAVING count(*) > 1) d`,
      )
    ).rows[0]?.n ?? 0,
  );
  const created = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM blips WHERE body LIKE 'load test capture nonce:%'`,
      )
    ).rows[0]?.n ?? 0,
  );
  const outbox = await db
    .query<{ pending: string; lag: string }>(
      `SELECT count(*)::int AS pending,
              COALESCE(extract(epoch FROM now() - min(run_after)), 0)::int AS lag
         FROM outbox`,
    )
    .catch(() => null);
  await db.end();
  await writeFile(join(outDir, 'app.log'), sh('docker', ['logs', APP], { allowFail: true }));

  const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
    metrics?: K6Summary;
  } & K6Summary;
  const m: K6Summary = summary.metrics ?? summary;
  const p95 = (name: string) => stat(m, `mcp_${name}`, 'p(95)');
  const errorRate = stat(m, 'errors', 'rate') ?? stat(m, 'errors', 'value') ?? 0;
  const limited = stat(m, 'rate_limited', 'count') ?? 0;
  const readyRate = stat(m, 'ready_ok', 'rate') ?? stat(m, 'ready_ok', 'value');
  const reqs = stat(m, 'http_reqs', 'count') ?? 0;
  const rps = stat(m, 'http_reqs', 'rate') ?? 0;

  const row = (name: string, slo: string, got: string, pass: boolean | null) =>
    `| ${name} | ${slo} | ${got} | ${pass === null ? '—' : pass ? 'pass' : '**FAIL**'} |`;
  const lt = (v: number | null, limit: number) => (v === null ? false : v < limit);
  const lines = [
    `### Load test: ${label}`,
    '',
    `Image \`${image}\`; app ${values.cpus} cpu / ${values.memory}, DB_POOL_MAX=${values.pool}; ` +
      `${values['agent-vus']} agent VUs + ${values['ui-vus']} UI VUs, ${values.duration}, think ${values.think} ms; ` +
      `Postgres max_connections=${maxConnections}.`,
    '',
    '| Metric | SLO | Result | |',
    '|---|---|---|---|',
    row('read_radar p95', '< 400 ms', fmtMs(p95('read_radar')), lt(p95('read_radar'), 400)),
    row('search_blips p95', '< 500 ms', fmtMs(p95('search_blips')), lt(p95('search_blips'), 500)),
    row('list_radars p95', '< 300 ms', fmtMs(p95('list_radars')), lt(p95('list_radars'), 300)),
    row('create_blip p95', '< 300 ms', fmtMs(p95('create_blip')), lt(p95('create_blip'), 300)),
    row('error rate (excl. 429)', '< 0.5%', `${(errorRate * 100).toFixed(2)}%`, errorRate < 0.005),
    row(
      '/health/ready',
      'always 200',
      readyRate === null ? 'n/a' : `${(readyRate * 100).toFixed(1)}% 200`,
      readyRate === 1,
    ),
    row('deadlocks', '0', String(deadlocksDelta), deadlocksDelta === 0),
    row('duplicate blips', '0', `${dupes} (of ${created} created)`, dupes === 0),
    row(
      'peak RSS',
      '< 400 MiB',
      `${peakRss.toFixed(0)} MiB`,
      peakRss < 400 && oom !== 'true' && restarts === '0',
    ),
    '',
    '| Informational | Result |',
    '|---|---|',
    `| update_blip p95 | ${fmtMs(p95('update_blip'))} |`,
    `| create_comment p95 | ${fmtMs(p95('create_comment'))} |`,
    `| notification counts p95 (UI) | ${fmtMs(stat(m, 'ui_notification_counts', 'p(95)'))} |`,
    `| requests / rate | ${reqs.toFixed(0)} / ${rps.toFixed(1)} per s |`,
    `| 429s from the limiter | ${limited.toFixed(0)} |`,
    `| peak Postgres client connections | ${peakConnections} of ${maxConnections} |`,
    `| container OOM-killed / restarts | ${oom} / ${restarts} |`,
    `| k6 exit code (99 = threshold crossed) | ${k6Exit} |`,
    ...(outbox
      ? [
          `| outbox rows still queued at end / oldest due (s ago) | ${outbox.rows[0]?.pending ?? '?'} / ${outbox.rows[0]?.lag ?? '?'} |`,
        ]
      : []),
    '',
  ];
  const report = lines.join('\n');
  await writeFile(join(outDir, 'results.md'), report);
  await writeFile(
    join(outDir, 'results.json'),
    JSON.stringify(
      {
        label,
        image,
        p95: Object.fromEntries(
          [
            'list_radars',
            'read_radar',
            'search_blips',
            'create_blip',
            'update_blip',
            'create_comment',
          ].map((n) => [n, p95(n)]),
        ),
        errorRate,
        limited,
        readyRate,
        deadlocksDelta,
        dupes,
        created,
        peakRssMiB: peakRss,
        peakConnections,
        oom,
        restarts,
        k6Exit,
        fixturesTokens: fixtures.tokens.length,
      },
      null,
      2,
    ),
  );
  console.log(report);

  sh('docker', ['rm', '-f', APP, WORKER], { allowFail: true });
  process.exitCode = k6Exit === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  spawnSync('docker', ['rm', '-f', APP, WORKER]);
  process.exit(1);
});

/**
 * `pnpm phone` — the whole thing, from an empty database to a verdict.
 *
 *   1. drop and recreate a scratch database of its own
 *   2. start the real server on a free port, hosting the built SPA
 *   3. seed a realistic account through the real API
 *   4. sweep the phone viewport in headless Chrome
 *   5. print the verdict, tear down, exit non-zero on any failure
 *
 * The server hosts the built SPA through UI_DIST_DIR rather than proxying a Vite
 * dev server, which is both the production shape — one process, one port, the
 * bundle that actually ships — and one fewer moving part to race against.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { open } from './harness.js';
import { OWNER_EMAIL, seed } from './seed.js';
import { scratchDatabase } from './database.js';
import { runIdiomSweep } from './idiom.js';
import { runSweep } from './sweep.js';
import { DESKTOP_WIDTHS, runDesktopSweep } from './desktop.js';
import { runDashboardWidgets } from './dashboard-widgets.js';
import { runMissionControl } from './mission-control.js';
import { runSidebarRadars } from './sidebar-radars.js';
import { runArchitectureFlows } from './architecture-flows.js';
import { runKanbanPopup } from './kanban-popup.js';
import { runEditConflictFlows } from './edit-conflict-flows.js';
import { runAssignFlows } from './assign-flows.js';
import { runSettingsFlows } from './settings-flows.js';
import { runHeaderSearch } from './header-search.js';
import { runSelectFlows } from './select-flows.js';
import { runAuditFlows } from './audit-flows.js';
import { runEmailReaderFlows } from './email-reader.js';
import { runOutboundWebhooks } from './outbound-webhooks.js';
import { runAgentRepo } from './agent-repo.js';
import { runAgentBriefs } from './agent-briefs.js';
import { runHelpdeskFlows } from './helpdesk-flows.js';
import { runBlipLinkFlows } from './blip-link-flows.js';
import { runScrollFlows } from './scroll-flows.js';
import { runReaderFlows } from './reader-flows.js';
import { runDueNotifications } from './due-notifications.js';
import { runNotificationIdentity } from './notification-identity.js';
import { runGuestSupportFlows, supportQueue } from './guest-support-flows.js';
import { runStaffSupportFlows } from './staff-support-flows.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const OUT_DIR = process.env['OMR_PHONE_OUT'] ?? join(PACKAGE_ROOT, '.out');
const UI_DIST = join(REPO_ROOT, 'packages', 'ui', 'dist');
const SERVER_ENTRY = join(REPO_ROOT, 'packages', 'server', 'dist', 'index.js');
const WORKER_ENTRY = join(REPO_ROOT, 'packages', 'server', 'dist', 'worker.js');

/**
 * Its own database, always. Two earlier runs shared one and silently corrupted
 * each other's results, which is worse than either of them failing.
 */
const SCRATCH_DB = scratchDatabase(process.env['OMR_PHONE_DB'] ?? 'omr_phone');

function baseConnection(): URL {
  const raw =
    process.env['OMR_PHONE_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgres://onmyradar:onmyradar@127.0.0.1:5432/on-my-radar';
  return new URL(raw);
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (typeof address === 'string' || address === null) {
        srv.close(() => rej(new Error('could not pick a port')));
        return;
      }
      const { port } = address;
      srv.close(() => res(port));
    });
  });
}

/** Drop and recreate the scratch database, so every run starts from nothing. */
async function resetDatabase(): Promise<string> {
  const base = baseConnection();
  const target = new URL(base.toString());
  target.pathname = `/${SCRATCH_DB}`;

  const maintenance = new URL(base.toString());
  maintenance.pathname = '/postgres';
  const admin = new pg.Pool({ connectionString: maintenance.toString(), max: 1 });
  admin.on('error', () => undefined);
  try {
    // WITH (FORCE) terminates anything still connected — a previous run that
    // died without closing its pool would otherwise block the drop forever.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end().catch(() => undefined);
  }

  return target.toString();
}

/*
 * Why a run failed, in a file. CI keeps `.out` as an artifact even when the job's own trace is
 * gone, so the failing check, the message and the end of the app's log are written there too:
 * `failure.txt`. Written whenever a run does not pass, and never when it does.
 */
const progress: string[] = [];
const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  if (line.startsWith('[phone]')) {
    progress.push(line);
    if (progress.length > 60) progress.shift();
  }
  originalLog(...args);
};
let liveServer: Server | null = null;
function recordFailure(why: string): void {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    const serverLines = (liveServer?.log.join('') ?? '').split('\n').slice(-200);
    writeFileSync(
      join(OUT_DIR, 'failure.txt'),
      [
        `phone suite failed at ${new Date().toISOString()}`,
        '',
        '== why ==',
        why,
        '',
        '== last stages ==',
        ...progress.slice(-30),
        '',
        `== last ${serverLines.length} lines of the app's log ==`,
        ...serverLines,
        '',
      ].join('\n'),
    );
  } catch {
    // Writing the explanation must never be what fails the run.
  }
}

interface Server {
  child: ChildProcess;
  /**
   * The background worker, as in production. An agent's comment or blip no longer makes
   * the API wait for its notification fan-out; the worker's outbox drain delivers it, so
   * a sweep that reads those notifications back needs one running.
   */
  worker: ChildProcess;
  /** The tail of its stdout and stderr, kept for the failure message. */
  log: string[];
}

async function startServer(
  port: number,
  databaseUrl: string,
  support?: { radarId: string; ownerId: string },
): Promise<Server> {
  /*
   * Built from nothing rather than inherited. A developer's own RESEND_API_KEY,
   * S3_* or OIDC_* in the ambient environment would change what the app does —
   * and RESEND_API_KEY in particular would stop `devCode` being returned, so the
   * seed could not sign in and the failure would look like an auth bug.
   */
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    NODE_ENV: 'development',
    PORT: String(port),
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'phone-suite-session-secret-not-used-anywhere-else',
    MIGRATE_ON_BOOT: '1',
    ADMIN_EMAILS: OWNER_EMAIL,
    AUTO_APPROVE_EMAILS: '@example.test',
    MAIL_FROM: 'On My Radar <hello@example.test>',
    // Native operator-consent checks use this isolated server's real MCP route.
    MCP_ENABLED: '1',
    // No second listener: a developer's own server may already hold the default metrics port.
    METRICS_PORT: '0',
    UI_DIST_DIR: join(OUT_DIR, 'ui-snapshot'),
    ...(support ? { SUPPORT_RADAR_ID: support.radarId, SUPPORT_OWNER_ID: support.ownerId } : {}),
  };

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: join(REPO_ROOT, 'packages', 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const workerPort = await freePort();
  const worker = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: join(REPO_ROOT, 'packages', 'server'),
    env: { ...env, PORT: String(workerPort), MIGRATE_ON_BOOT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log: string[] = [];
  const keep = (chunk: Buffer): void => {
    log.push(chunk.toString());
    if (log.length > 400) log.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  worker.stdout.on('data', keep);
  worker.stderr.on('data', keep);
  return { child, worker, log };
}

async function waitForReady(port: number, { child, log }: Server): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${log.join('').slice(-2000)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (res.ok) return;
    } catch {
      // Not up yet. Keep going — a connection refused here is expected.
    }
    await new Promise<void>((r) => {
      setTimeout(() => r(), 500);
    });
  }
  throw new Error(`server never became ready:\n${log.join('').slice(-2000)}`);
}

async function main(): Promise<number> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // Lazy chunks must match the entry document throughout this run, even if
  // another task rebuilds the workspace bundle while the browser is open.
  cpSync(UI_DIST, join(OUT_DIR, 'ui-snapshot'), { recursive: true });

  console.log('[phone] resetting the scratch database');
  const databaseUrl = await resetDatabase();

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[phone] starting the app on ${baseUrl}`);

  let server = await startServer(port, databaseUrl);
  liveServer = server;
  let exitCode = 1;

  try {
    await waitForReady(port, server);

    console.log('[phone] seeding through the real API');
    const seeded = await seed(baseUrl);
    // Ordinary owner API seed/readback first; only intended nonsecret queue config changes.
    const support = await supportQueue(seeded);
    const stopped = new Promise<void>((resolve) => server.child.once('exit', () => resolve()));
    server.worker.kill('SIGTERM');
    server.child.kill('SIGTERM');
    await stopped;
    server = await startServer(port, databaseUrl, support);
    liveServer = server;
    await waitForReady(port, server);

    console.log('[phone] sweeping 390x844');
    const { browser, page } = await open(OUT_DIR, baseUrl, seeded.ownerCookie);
    let result;
    try {
      if (process.argv.includes('--due-only')) {
        result = await runDueNotifications(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--dashboard-only')) {
        result = await runDashboardWidgets(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--search-only')) {
        result = await runHeaderSearch(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--audit-only')) {
        result = await runAuditFlows(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--select-only')) {
        result = await runSelectFlows(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--email-only')) {
        result = await runEmailReaderFlows(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--webhooks-only')) {
        result = await runOutboundWebhooks(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--agents-only')) {
        result = await runAgentRepo(page, OUT_DIR, seeded, databaseUrl);
      } else if (process.argv.includes('--briefs-only')) {
        result = await runAgentBriefs(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--settings-only')) {
        result = await runSettingsFlows(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--architecture-only')) {
        result = await runArchitectureFlows(page, seeded);
      } else if (process.argv.includes('--identity-only')) {
        result = await runNotificationIdentity(page, OUT_DIR, seeded, databaseUrl);
      } else if (process.argv.includes('--edit-conflict-only')) {
        result = await runEditConflictFlows(page, seeded);
      } else if (process.argv.includes('--assign-only')) {
        result = await runAssignFlows(page, seeded);
      } else if (process.argv.includes('--scroll-only')) {
        result = await runScrollFlows(page, seeded, databaseUrl);
      } else if (process.argv.includes('--links-only')) {
        result = await runBlipLinkFlows(page, seeded);
      } else if (process.argv.includes('--reader-only')) {
        result = await runReaderFlows(page, seeded);
      } else if (process.argv.includes('--helpdesk-only')) {
        result = await runHelpdeskFlows(page, OUT_DIR, seeded);
      } else if (process.argv.includes('--discussion-only')) {
        // The phone sweep (390) and the desktop sweep (1920 .. 390), nothing else.
        const phone = await runSweep(page, OUT_DIR, seeded);
        const desktop = await runDesktopSweep(page, OUT_DIR, seeded);
        result = {
          checks: [...phone.checks, ...desktop.checks],
          failures: [...phone.failures, ...desktop.failures],
          notes: [...phone.notes, ...desktop.notes],
        };
      } else {
        const phone = await runSweep(page, OUT_DIR, seeded);
        /*
         * The desktop widths, in the same browser and against the same seed.
         *
         * `packages/phone` gated 390 and nothing gated a desktop viewport at all —
         * which is where the sidebar states and the lane budget live, both of them
         * tuned from arithmetic that turned out to be wrong. A second package
         * would have meant a second server, a second seed and a second CI job for
         * a viewport change; this is one process either way.
         *
         * The phone sweep runs FIRST and the desktop sweep resizes afterwards,
         * never the reverse: the phone checks assume a phone user-agent and a
         * touch viewport, and both are set once when the page opens.
         */
        /*
         * The idioms — the pager, the stack and the swipe — still at 390 and still
         * with the phone user agent, but after `runSweep` because that ends by
         * reading the public and invitation screens with the session deleted. It
         * signs back in the way the desktop sweep does.
         */
        console.log('[phone] driving the phone idioms');
        const idiom = await runIdiomSweep(page, OUT_DIR, seeded);

        console.log(`[phone] sweeping ${DESKTOP_WIDTHS.join(', ')}`);
        const desktop = await runDesktopSweep(page, OUT_DIR, seeded);
        console.log('[phone] checking radar organization workflows');
        const audit = await runAuditFlows(page, OUT_DIR, seeded);
        console.log('[phone] checking accessible select controls');
        const selects = await runSelectFlows(page, OUT_DIR, seeded);
        console.log('[phone] checking header search');
        const search = await runHeaderSearch(page, OUT_DIR, seeded);
        console.log('[phone] checking dashboard widgets');
        const widgets = await runDashboardWidgets(page, OUT_DIR, seeded);
        console.log('[phone] checking due dates and notification preferences');
        const due = await runDueNotifications(page, OUT_DIR, seeded);
        console.log('[phone] checking email readers');
        const email = await runEmailReaderFlows(page, OUT_DIR, seeded);
        console.log('[phone] checking outbound webhook subscriptions');
        const outbound = await runOutboundWebhooks(page, OUT_DIR, seeded);
        console.log('[phone] checking native Kanban popup editing, comments and drag coexistence');
        const kanbanPopup = await runKanbanPopup(page, OUT_DIR, seeded);
        console.log(
          '[phone] checking native Helpdesk popup editing, comments and drag coexistence',
        );
        const helpdeskPopup = await runKanbanPopup(page, OUT_DIR, seeded, 'helpdesk');
        console.log('[phone] checking stale browser saves against newer agent edits');
        const editConflict = await runEditConflictFlows(page, seeded);
        console.log('[phone] checking card assignment from the browser');
        const assign = await runAssignFlows(page, seeded);
        console.log('[phone] checking the architecture radar at phone and desktop widths');
        const architecture = await runArchitectureFlows(page, seeded);
        console.log('[phone] checking the Agent Repo');
        const agents = await runAgentRepo(page, OUT_DIR, seeded, databaseUrl);
        console.log('[phone] checking the Briefs tab at 390');
        const briefs = await runAgentBriefs(page, OUT_DIR, seeded);
        console.log('[phone] checking the helpdesk conversation');
        const helpdesk = await runHelpdeskFlows(page, OUT_DIR, seeded);
        console.log('[phone] checking served notification identity at phone and desktop widths');
        const identity = await runNotificationIdentity(page, OUT_DIR, seeded, databaseUrl);
        console.log(
          '[phone] checking fresh Mission Control dashboards at phone and desktop widths',
        );
        const missionControl = await runMissionControl(page, OUT_DIR, seeded);
        console.log('[phone] checking signed-out guest support at phone and desktop widths');
        const guestSupport = await runGuestSupportFlows(page, OUT_DIR, seeded);
        console.log('[phone] checking card links at phone and desktop widths');
        const blipLinks = await runBlipLinkFlows(page, seeded);
        console.log('[phone] checking that a jump inside a radar scrolls only its pane');
        const scrollJumps = await runScrollFlows(page, seeded, databaseUrl);
        console.log('[phone] checking the reading list as a reader at phone and desktop widths');
        const reader = await runReaderFlows(page, seeded);
        console.log('[phone] checking native human staff review and guest-link revocation');
        const staffSupport = await runStaffSupportFlows(page, OUT_DIR, seeded);
        console.log(
          '[phone] checking all owned radars beyond twenty in desktop sidebar and phone directory',
        );
        const sidebarRadars = await runSidebarRadars(page, OUT_DIR, seeded);
        console.log('[phone] checking Settings sections and the account download');
        const settingsFlows = await runSettingsFlows(page, OUT_DIR, seeded);
        result = {
          checks: [
            ...phone.checks,
            ...idiom.checks,
            ...desktop.checks,
            ...kanbanPopup.checks,
            ...helpdeskPopup.checks,
            ...editConflict.checks,
            ...assign.checks,
            ...architecture.checks,
            ...audit.checks,
            ...email.checks,
            ...selects.checks,
            ...search.checks,
            ...widgets.checks,
            ...due.checks,
            ...outbound.checks,
            ...agents.checks,
            ...briefs.checks,
            ...helpdesk.checks,
            ...identity.checks,
            ...missionControl.checks,
            ...guestSupport.checks,
            ...staffSupport.checks,
            ...sidebarRadars.checks,
            ...settingsFlows.checks,
            ...blipLinks.checks,
            ...scrollJumps.checks,
            ...reader.checks,
          ],
          failures: [
            ...phone.failures,
            ...idiom.failures,
            ...desktop.failures,
            ...kanbanPopup.failures,
            ...helpdeskPopup.failures,
            ...editConflict.failures,
            ...assign.failures,
            ...architecture.failures,
            ...audit.failures,
            ...email.failures,
            ...selects.failures,
            ...search.failures,
            ...widgets.failures,
            ...due.failures,
            ...outbound.failures,
            ...agents.failures,
            ...briefs.failures,
            ...helpdesk.failures,
            ...identity.failures,
            ...missionControl.failures,
            ...guestSupport.failures,
            ...staffSupport.failures,
            ...sidebarRadars.failures,
            ...settingsFlows.failures,
            ...blipLinks.failures,
            ...scrollJumps.failures,
            ...reader.failures,
          ],
          notes: [
            ...phone.notes,
            ...idiom.notes,
            ...desktop.notes,
            ...kanbanPopup.notes,
            ...helpdeskPopup.notes,
            ...audit.notes,
            ...email.notes,
            ...missionControl.notes,
            ...guestSupport.notes,
            ...staffSupport.notes,
          ],
        };
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(result, null, 2));

    console.log('');
    for (const c of result.checks) {
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
      if (!c.ok) console.log(`        ${JSON.stringify(c.detail)}`);
    }
    console.log('');

    const passed = result.checks.filter((c) => c.ok).length;
    console.log(`[phone] ${passed}/${result.checks.length} assertions passed`);
    console.log(`[phone] screenshots and report.json in ${OUT_DIR}`);

    if (result.failures.length > 0) {
      console.log('');
      console.log('[phone] FAILED:');
      for (const f of result.failures) console.log(`  - ${f}`);
      recordFailure(
        [
          ...result.checks
            .filter((c) => !c.ok)
            .map((c) => `check: ${c.name}\n  ${JSON.stringify(c.detail)}`),
          ...result.failures.map((f) => `failure: ${f}`),
        ].join('\n'),
      );
    }
    exitCode = result.failures.length === 0 ? 0 : 1;
  } finally {
    // A server that died mid-sweep otherwise surfaces only as the browser's
    // ERR_CONNECTION_REFUSED in whichever section happened to be running.
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      console.error(
        `[phone] the app server exited during the run (${String(server.child.exitCode ?? server.child.signalCode)}):\n` +
          server.log.join('').slice(-4000),
      );
    }
    server.worker.kill('SIGTERM');
    server.child.kill('SIGTERM');
  }

  return exitCode;
}

process.exitCode = await main().catch((err: unknown) => {
  console.error('[phone]', err instanceof Error ? err.stack : String(err));
  recordFailure(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 1;
});

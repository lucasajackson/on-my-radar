/**
 * Constants and the one safety rule of this package: it only ever talks to a
 * machine-local Postgres and a machine-local app. Both are checked here, before
 * anything is written, because a seed that drops and recreates a database is
 * exactly what must never reach a shared one.
 */

export const DB_NAME = 'omr_loadtest';

/** Not a secret: it signs tokens in a throwaway database that is dropped every run. */
export const SESSION_SECRET = 'loadtest-session-secret-not-a-real-secret-0123456789';

export const USERS = 50;
export const TOKENS_PER_USER = 3;
export const RADARS = 20;
export const BLIPS = 50_000;
export const BOARD_BLIPS = 10_000;
export const COMMENTS = 20_000;
/** Blip ids per radar handed to k6 as update/comment targets. */
export const SAMPLE_PER_RADAR = 150;
/** The radar that takes 30% of captures. Index 1: a stream, not the 10k board at index 0. */
export const HOT_RADAR_INDEX = 1;
export const BOARD_RADAR_INDEX = 0;

export const APP_PORT = 3500;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * CI's docker-in-docker sidecar is reachable as `docker`, not localhost. It is
 * allowed only by naming it in LOADTEST_EXTRA_LOCAL_HOSTS, so a typo or a pasted
 * production URL still fails closed.
 */
for (const host of (process.env['LOADTEST_EXTRA_LOCAL_HOSTS'] ?? '').split(','))
  if (host.trim() === 'docker') LOCAL_HOSTS.add('docker');

/** Where the app container's published port is reached from the runner and k6. */
export const APP_HOST = process.env['LOADTEST_APP_HOST'] ?? '127.0.0.1';

/** A unix-socket directory is this machine by definition. */
const isSocketPath = (host: string) => host.startsWith('/');

const isLocalHost = (host: string) => LOCAL_HOSTS.has(host) || isSocketPath(host);

const decodeHost = (host: string): string => {
  try {
    return decodeURIComponent(host);
  } catch {
    return host;
  }
};

/**
 * Every host a Postgres client built from `url` could end up connecting to.
 *
 * The URL's own hostname is not the whole answer. `pg` also honours `?host=` (which may
 * name a different machine than the authority does, or several), `?hostaddr=`, a
 * percent-encoded socket directory in the authority, and, when the URL names no host at
 * all, `PGHOST`. All of them are collected so that a URL which merely *looks* local cannot
 * send `DROP DATABASE` to a remote server. A `service=` / `PGSERVICE` can name any host in a
 * file this code cannot see, so it is refused outright.
 */
export function effectiveHosts(url: URL, env: NodeJS.ProcessEnv = process.env): string[] {
  if (url.searchParams.has('service') || env['PGSERVICE']) {
    throw new Error(
      "Refusing to run: a Postgres 'service' can point anywhere. Use an explicit localhost URL.",
    );
  }
  const hosts: string[] = [];
  const list = (value: string | null | undefined) => {
    for (const part of (value ?? '').split(',')) {
      const host = decodeHost(part.trim());
      if (host) hosts.push(host);
    }
  };
  list(url.hostname);
  list(url.searchParams.get('host'));
  list(url.searchParams.get('hostaddr'));
  // Anything the URL leaves out, the client takes from the environment (libpq's default is a
  // local socket, which is why an empty result is treated as `localhost` and still checked).
  if (hosts.length === 0) {
    list(env['PGHOST']);
    list(env['PGHOSTADDR']);
  }
  return hosts.length > 0 ? hosts : ['localhost'];
}

/**
 * Throws unless every host `raw` can resolve to is this machine (or the container's alias for
 * it). Returns the parsed URL with its query and host normalised to the one checked host, so
 * what is used afterwards cannot differ from what was checked.
 */
export function assertLocalUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL.`);
  }
  const hosts = effectiveHosts(url);
  const remote = hosts.find((host) => !isLocalHost(host));
  if (remote !== undefined) {
    throw new Error(
      `Refusing to run: ${what} points at '${remote}'. The load test only talks to localhost ` +
        '(it drops and recreates its database, and hammers its target). Never aim it at onmyradar.io ' +
        'or any shared database.',
    );
  }
  const host = must(hosts[0]);
  const normal = new URL(url);
  normal.search = '';
  if (isSocketPath(host)) {
    normal.hostname = '';
    normal.search = `?host=${encodeURIComponent(host)}`;
  } else {
    normal.hostname = host === '::1' ? '[::1]' : host;
  }
  return normal;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a host.');
  return value;
}

/** The admin connection (to the `postgres` database) with the load-test database name swapped in. */
export function databaseUrls(adminUrl: string): { admin: string; app: string; container: string } {
  const url = assertLocalUrl(adminUrl, 'LOADTEST_PG_URL');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const app = new URL(url);
  app.pathname = `/${DB_NAME}`;
  const container = new URL(app);
  // Containers reach the database through the host alias (`--add-host … host-gateway`).
  if (['localhost', '127.0.0.1', 'docker'].includes(container.hostname))
    container.hostname = 'host.docker.internal';
  return { admin: admin.toString(), app: app.toString(), container: container.toString() };
}

/** Env keys that name a database: the app must reach only the one this program validated. */
const DATABASE_KEY =
  /^(PG|DATABASE_)|_DATABASE_URL$|(^|_)(DB|POSTGRES|POSTGRESQL)_(URL|HOST|ADDR|SERVICE)/i;

/**
 * Applies `--env KEY=value` pairs over the app's base environment. A pair that would change
 * which database the container talks to (`DATABASE_URL`, any `PG*`, `*_DATABASE_URL`,
 * `DB_HOST` and the like) is refused, so the validated URL is the only one that can be used.
 */
export function mergeAppEnv(base: Record<string, string>, extra: string[]): Record<string, string> {
  const env = { ...base };
  for (const pair of extra) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    if (DATABASE_KEY.test(key)) {
      throw new Error(`Refusing --env ${key}: the database is set by LOADTEST_PG_URL only.`);
    }
    env[key] = pair.slice(eq + 1);
  }
  return env;
}

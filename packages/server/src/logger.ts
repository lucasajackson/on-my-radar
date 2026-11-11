import { createRequire } from 'node:module';
import { pino, stdSerializers } from 'pino';
import { env } from './env.js';

/**
 * Pretty output is for a developer's terminal. `pino-pretty` is a devDependency, so an
 * image built with `pnpm deploy --prod` does not have it: there, whatever NODE_ENV says,
 * the log stays JSON instead of the process dying on a missing transport.
 */
function prettyAvailable(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}
const isDev = prettyAvailable();

/**
 * URL shapes that carry a live credential in the path itself.
 *
 * Each entry keeps the part that makes a line traceable — the webhook's id, the
 * route it was — and throws away the part somebody could replay.
 */
/** Optional `scheme://host`, so a whole URL is scrubbed as readily as a path. */
const ORIGIN = '(?:[a-z][a-z0-9+.-]*://[^/]*)?';

const SECRET_PATHS: RegExp[] = [
  // `/hooks/<id>/<token>`: the ingest URL is pasted into other people's
  // products, so the token travels in the path and arrives on every delivery.
  new RegExp(`^(${ORIGIN}/hooks/[^/]+/).+$`, 'i'),
  // `/api/invites/<token>` and the SPA screen it backs, `/invite/<token>`. The
  // token is an HMAC over an invitation row and it is what the link is *for*,
  // so it is written down on every click of every invitation. The API is also
  // mounted under `/api/v1`, and the native client calls that one — so the
  // version segment is part of the shape, or its clicks log the token.
  new RegExp(`^(${ORIGIN}/api(?:/v\\d+)?/invites/).+$`, 'i'),
  new RegExp(`^(${ORIGIN}/invite/).+$`, 'i'),
];

/**
 * A request path with any credential in it replaced.
 *
 * **Applied by the logger itself, not by its callers.** This used to be
 * `safePath` in `app.ts`, called at the one place that logged a path — so when
 * a second and a third log call appeared (the 5xx branch of `app.onError`, and
 * `hookRoutes.onError`) they wrote the webhook token to the pod log verbatim,
 * beside an access-log line for the same request that had redacted it. The same
 * omission covered `/api/invites/<token>`, which is not an error path at all:
 * every successful invitation click logged its own token at INFO.
 *
 * Patching the call sites fixes the two that exist and leaves the next one to
 * be written. Doing it in `redact` below means a raw path cannot reach the log
 * from anywhere, including a call this file has never heard of.
 */
export function scrubPath(path: string): string {
  for (const pattern of SECRET_PATHS) {
    const match = pattern.exec(path);
    if (match?.[1]) return `${match[1]}[redacted]`;
  }
  return path;
}

/**
 * Exported so a test can build a logger with *this* configuration rather than
 * one that merely looks like it. The redaction is the guard; a suite that
 * re-declares it proves nothing about what production writes.
 */
export const REDACTION = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'password',
    'code',
    'token',
    '*.token',
    '*.secret',
    // Not secrets in themselves, which is why they take the scrubber below
    // rather than being blanked: a request path is how a log line is read.
    'path',
    '*.path',
    'url',
    '*.url',
  ],
  /**
   * One censor for two jobs, because pino takes only one. A key that names a
   * secret is blanked outright; a key that names a URL keeps everything except
   * the credential inside it.
   */
  censor: (value: unknown, keyPath: string[]): unknown => {
    const key = keyPath[keyPath.length - 1];
    if (key === 'path' || key === 'url') {
      return typeof value === 'string' ? scrubPath(value) : value;
    }
    return '[redacted]';
  },
} as const;

/**
 * A password hash must not reach the log from any error, whatever carried it: a failed
 * query's message, its `params`, or a cause. Applied to every serialized `err`.
 */
export function scrubHashes(serialized: object): object {
  return JSON.parse(
    JSON.stringify(serialized).replace(/scrypt\$1\$[A-Za-z0-9_$-]+/g, '[redacted]'),
  ) as object;
}

export const errSerializer = (err: Error) => scrubHashes(stdSerializers.err(err));

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  serializers: { err: errSerializer },
  // No pid or hostname on every line; `null` is how pino spells that.
  base: null,
  redact: { ...REDACTION, paths: [...REDACTION.paths] },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});

/** Never log a whole env; this is what is safe to print at boot. */
export function bootSummary() {
  const e = env();
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL,
    // Logged separately from publicUrl because they are the same value until a
    // client is split off, and the moment they differ is the moment somebody
    // wants to see both.
    appUrl: e.APP_URL,
    corsOrigins: e.CORS_ALLOWED_ORIGINS.length,
    buildSha: e.ONMYRADAR_BUILD_SHA || null,
    mcp: e.MCP_ENABLED,
  };
}

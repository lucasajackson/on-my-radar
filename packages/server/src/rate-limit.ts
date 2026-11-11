/**
 * Per-credential and per-person rate limits for bearer callers, REST and MCP alike.
 *
 * Mounted after `attachActor` (it needs to know who is calling) and before the body is
 * read (a refused caller must not get to make the server buffer a request first).
 *
 * Two buckets are charged for a PAT or OAuth connection:
 * - the connection, `tok:<user>:<kind>:<id>`. For OAuth the id is the client's, never the
 *   access-token row, which rotates on refresh and would hand a hammering agent a fresh
 *   bucket every hour;
 * - the person, `usr:<user>`, shared by all of their agents, so three agents cannot
 *   together do what one may not.
 *
 * Browser sessions are not limited here: the people clicking are not the load this
 * guards against, and a limit that can lock a person out of their own UI is a worse
 * failure than the one it prevents. `/health` is exempt. Webhooks and integrations
 * carry their own limits (`services/webhooks.ts`, `integration_scope_windows`).
 *
 * A limiter that cannot reach Postgres lets the request through, and says so in the log:
 * the database being down is the readiness probe's business, not a reason to refuse
 * every agent twice.
 */
import type { MiddlewareHandler } from 'hono';
import { env } from './env.js';
import { tooManyRequests, type AppEnv } from './http.js';
import { logger } from './logger.js';
import { countRateLimited } from './metrics.js';
import { takeToken } from './services/token-bucket.js';

export function rateLimitBearer(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    const config = env();
    if (!config.RATE_LIMIT_ENABLED || !actor?.connection || c.req.path.startsWith('/health')) {
      return next();
    }
    const surface = c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') ? 'mcp' : 'rest';
    try {
      const token = await takeToken(
        `tok:${actor.user.id}:${actor.connection.kind}:${actor.connection.id}`,
        { perMinute: config.RATE_LIMIT_TOKEN_PER_MINUTE, burst: config.RATE_LIMIT_TOKEN_BURST },
      );
      if (!token.ok) {
        countRateLimited('token', surface);
        throw tooManyRequests(
          `This connection is limited to ${config.RATE_LIMIT_TOKEN_PER_MINUTE} requests per minute. Slow down and retry.`,
          token.retryAfterSeconds,
        );
      }
      const user = await takeToken(`usr:${actor.user.id}`, {
        perMinute: config.RATE_LIMIT_USER_PER_MINUTE,
        burst: config.RATE_LIMIT_USER_BURST,
      });
      if (!user.ok) {
        countRateLimited('user', surface);
        throw tooManyRequests(
          `This account is limited to ${config.RATE_LIMIT_USER_PER_MINUTE} requests per minute across all of its connections. Slow down and retry.`,
          user.retryAfterSeconds,
        );
      }
    } catch (err) {
      if (isRefusal(err)) throw err;
      logger.warn({ err }, 'rate limiter unavailable; request allowed');
    }
    return next();
  };
}

function isRefusal(err: unknown): boolean {
  return err instanceof Error && err.name === 'ApiError';
}

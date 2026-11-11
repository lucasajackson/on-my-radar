/**
 * Cross-origin access, on exactly three surfaces and nowhere else.
 *
 * ## Why this is not `app.use('*', cors())`
 *
 * The REST API under `/api` is authenticated by a session cookie and nothing
 * else. Its whole defence against another origin acting as the signed-in person
 * is that a browser will not let that origin read the response. Hoisting an
 * allowance up to the app would hand that away — and doing it with
 * `Access-Control-Allow-Credentials` would hand away the cookie too. So the
 * allow-list below is a literal list of paths, and the next person who wants to
 * widen it should have to edit this file and read this paragraph first.
 *
 * ## Why these three are different
 *
 * `/.well-known/*`, `/oauth/*` and `/mcp` carry **no ambient authority**. There
 * is no cookie on them that a browser would attach on their behalf: the
 * discovery documents are public, the token endpoint proves possession of a PKCE
 * verifier or a refresh token, and `/mcp` proves possession of a bearer token.
 * A cross-origin caller that cannot produce those secrets gets nothing, and one
 * that can did not need a browser's help to do it.
 *
 * That is why `*` with **no** credentials is the right answer here rather than a
 * grudging one: it is what the OAuth 2.0 for Browser-Based Apps BCP expects of
 * an authorization server, and a remote MCP client running inside a renderer —
 * an Electron app, a hosted web client — cannot complete a token exchange
 * without it. `Access-Control-Allow-Credentials` must never be added to this
 * list; it is precisely what turns "no ambient authority" into "some".
 *
 * `WWW-Authenticate` is exposed because the 401 challenge on `/mcp` is the
 * document that tells a client where to authenticate. A challenge a client is
 * not permitted to read is not a challenge.
 *
 * ## What changed for `/api`, and why it does not give the cookie away
 *
 * `/api` can now answer a cross-origin caller, but only one listed in
 * `CORS_ALLOWED_ORIGINS`, and only ever as a **bearer** caller. The paragraph
 * above still holds in full: what it objects to is a cross-origin page acting
 * as the signed-in person *using ambient authority it did not have to produce*.
 * A bearer token is not ambient. A page that holds one had to be given it.
 *
 * Three things keep those apart, and all three have to stay true:
 *
 *  1. The allow-list is exact origins, echoed back one at a time, never `*`.
 *     `vary: origin` goes with it, because a response that varies by origin and
 *     does not say so is a cache poisoning waiting to happen.
 *  2. `Access-Control-Allow-Credentials` is never sent — here or anywhere. That
 *     is the single header that would turn this back into the thing the
 *     paragraph above refuses: without it a browser will not attach the session
 *     cookie to these requests, and will refuse to hand the response to a
 *     caller that asked it to.
 *  3. `attachActor` independently declines to read the session cookie on a
 *     cross-origin request, so the property does not rest on a browser getting
 *     (2) right. See `auth/middleware.ts`.
 *
 * Empty allow-list is the default and means none of this is reachable: the API
 * behaves exactly as it did when it refused every cross-origin caller.
 */
import type { MiddlewareHandler } from 'hono';
import { env } from './env.js';
import type { AppEnv } from './http.js';

/**
 * Exact paths, not prefixes of convenience. `/api` is deliberately absent and
 * `/hooks` is too — a webhook URL is a bearer secret in a query string and has
 * no business being callable from a page.
 */
function crossOriginAllowed(path: string): boolean {
  return (
    path.startsWith('/.well-known/') ||
    path.startsWith('/oauth/') ||
    path === '/mcp' ||
    path === '/mcp/'
  );
}

/** The API, versioned or not. `/hooks` is still deliberately absent. */
function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

/**
 * The request's origin, if it is one this deployment has allowed. Returns null
 * for an unlisted origin, a same-origin request, or a caller that sent no
 * `Origin` at all — none of which need a CORS answer.
 */
function allowedApiOrigin(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const allowed = env().CORS_ALLOWED_ORIGINS;
  if (allowed.length === 0) return null;
  const origin = c.req.header('origin');
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}

/**
 * Note what is NOT here: `access-control-allow-credentials`. Adding it is the
 * one edit to this file that would be a security change rather than a
 * configuration change, and it must never be made.
 */
const API_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  // `idempotency-key` is listed ahead of the server understanding it, because a
  // client that sends a header the preflight did not allow fails the request
  // outright rather than having the header quietly dropped.
  'access-control-allow-headers': 'authorization, content-type, accept, idempotency-key',
  'access-control-expose-headers': 'WWW-Authenticate, x-request-id, Retry-After',
  'access-control-max-age': '600',
};

/**
 * The response headers for the endpoints above, added by the middleware below
 * after the handler has answered. `/mcp` used to write its reply straight to
 * the raw Node response and applied these itself; it returns an ordinary
 * `Response` now, so one path covers it.
 */
const CROSS_ORIGIN_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  // Not load-bearing: a CORS-mode fetch does not consult CORP at all, so the
  // header above is what actually decides whether the response can be read.
  // It is set because the app-wide `same-origin` value is a second, quieter
  // reason for a browser to discard these responses if COEP is ever turned on,
  // and these three surfaces are meant to be readable from anywhere.
  'cross-origin-resource-policy': 'cross-origin',
};

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  // `authorization` and `content-type` are the two that matter; the `mcp-*`
  // pair and `last-event-id` are what the Streamable HTTP transport sends.
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-max-age': '600',
};

/**
 * Registered **before** `secureHeaders`, because middleware post-`next()` code
 * runs in reverse registration order and this one has to overwrite the
 * app-wide `cross-origin-resource-policy` rather than be overwritten by it.
 * The public-radar CSP block above it in `app.ts` is there for the same reason.
 */
export const crossOriginAccess = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (isApiPath(c.req.path)) {
    const origin = allowedApiOrigin(c);
    // `vary: origin` is set even when the origin is refused: the response for an
    // allowed origin and the response for an unlisted one differ, and a shared
    // cache that does not know that will serve one to the other.
    c.header('vary', 'origin');
    if (!origin) return next();

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'access-control-allow-origin': origin,
        vary: 'origin',
        ...API_PREFLIGHT_HEADERS,
      });
    }

    await next();
    c.header('access-control-allow-origin', origin);
    c.header(
      'access-control-expose-headers',
      API_PREFLIGHT_HEADERS['access-control-expose-headers'],
    );
    return;
  }

  if (!crossOriginAllowed(c.req.path)) return next();

  // A preflight is answered here and goes no further. Without this the request
  // falls through to `notFound`, which is what `OPTIONS /oauth/token` answered
  // with a 404 — a browser reads that as "this endpoint refuses you" and the
  // token exchange never happens.
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, { ...PREFLIGHT_HEADERS });
  }

  await next();
  for (const [name, value] of Object.entries(CROSS_ORIGIN_HEADERS)) c.header(name, value);
};

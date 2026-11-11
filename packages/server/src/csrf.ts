/**
 * Cross-site request forgery: refuse a state-changing request another site
 * made the browser send.
 *
 * Three layers, and this is the outermost:
 *
 *  1. `readJson` requires `Content-Type: application/json`. An HTML form can
 *     only send urlencoded, multipart or text/plain, and a cross-site `fetch`
 *     with a JSON type needs a preflight that `cors.ts` never grants with
 *     credentials — so no other site can put a JSON body in front of a handler.
 *  2. The session cookie is `SameSite=Lax`, so a cross-site POST carries none.
 *  3. This middleware, which does not depend on either: the browser says where
 *     a request came from (`Sec-Fetch-Site`, or `Origin` from one that predates
 *     it), and a write from another site is refused outright.
 *
 * Layer 2 is why this is not redundant with it. Login CSRF needs no cookie at
 * all: a cross-site form that posts the attacker's own code to
 * `/api/auth/verify-code` is answered with a `Set-Cookie`, and the victim's
 * browser is then signed in as the attacker — everything they capture after
 * that lands in the attacker's account. The endpoints that *issue* the cookie
 * are exactly the ones SameSite does not protect.
 *
 * A request authenticated by a bearer credential is exempt (`authVia`, set by
 * `attachActor` once the credential resolved — not merely an Authorization header
 * being present): it is not ambient, a page had to be handed it,
 * and `cors.ts` lets allow-listed origins use one cross-origin on purpose.
 * Non-browser clients send neither header and are unaffected.
 */
import type { MiddlewareHandler } from 'hono';
import { env } from './env.js';
import { ApiError, type AppEnv } from './http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Where a cookie-borne write may be made from: `/api`, and the OAuth consent. */
function guarded(path: string): boolean {
  return path.startsWith('/api/') || path === '/oauth/authorize/decision';
}

function ownOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const url of [env().PUBLIC_URL, env().APP_URL]) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // env validation already refused anything that is not a URL.
    }
  }
  return origins;
}

export const refuseCrossSiteWrites = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || !guarded(c.req.path)) return next();
  // Exempt only when the actor really authenticated by bearer. The header being
  // present proves nothing: a request carrying a session cookie and any
  // `Authorization: Bearer x` was authenticated by the cookie, which is ambient.
  if (c.get('authVia') === 'bearer') return next();

  const site = c.req.header('sec-fetch-site');
  const origin = c.req.header('origin');
  // `same-site` is allowed: a separately hosted client on a sibling subdomain
  // is the case `APP_URL` exists for. `none` is the person typing a URL.
  const crossSite =
    site !== undefined
      ? site === 'cross-site'
      : origin !== undefined && (origin === 'null' || !ownOrigins().has(origin));
  if (crossSite) {
    throw new ApiError(
      403,
      'cross_site_request',
      'This request was sent by another website, so it was refused. Open On My Radar directly and try again.',
    );
  }
  return next();
};

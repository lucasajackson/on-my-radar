/**
 * Resolves the actor for every request: session cookie first, then bearer token.
 *
 * ## A session token is a bearer credential too
 *
 * `omr_s_…` presented as `Authorization: Bearer` resolves through exactly the
 * same session path as the cookie and produces exactly the same actor:
 * `kind: 'user'`. That is deliberate, and it is the whole reason a native or
 * separately-hosted client can be a first-class client rather than a delegate.
 *
 * `assertHumanDecision` distinguishes a person from something acting on a
 * person's behalf — it is what stops an agent token registering for push or
 * changing notification settings. Somebody signed into a first-party client
 * with their own emailed code is a person; the container their credential sits
 * in (an httpOnly cookie, a keychain) is a browser implementation detail, not
 * the authority model. So the fence is untouched here, and PATs and OAuth
 * tokens remain `kind: 'agent'` with their scope ceiling intact.
 *
 * ## Why a cross-origin request cannot use the cookie
 *
 * When `CORS_ALLOWED_ORIGINS` is configured, `/api` answers cross-origin callers
 * — but only bearer ones. `cors.ts` never sends
 * `Access-Control-Allow-Credentials`, so a browser will not attach the session
 * cookie to those requests and will not expose the response to a caller that
 * asks it to. That is already sufficient, and it is somebody else's code
 * enforcing it. The check below makes it ours: an `Origin` that is neither the
 * API's own nor the app's gets no cookie authentication, whatever the browser
 * decided to send.
 *
 * It is inert unless a deployment has opted into cross-origin access, so a
 * same-origin deployment and a dev proxy behave exactly as they did.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { API_V1 } from '@onmyradar/contract';
import { INTEGRATION_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from './crypto.js';
import type { AppEnv } from '../http.js';
import { env } from '../env.js';
import { resolveSession as resolveStoredSession, readSessionCookie } from './session.js';
import { admitOnOpenSignup } from './accounts.js';
import { resolveBearerToken } from './bearer.js';
import { resolveIntegrationToken } from './integration.js';

/**
 * Where an integration credential is somebody (`docs/HELPDESK.md` §3.3).
 *
 * Everywhere else, `/mcp` and every other `/api` route included, an `omr_int_`
 * token resolves to nothing and the request is anonymous. This is "state first,
 * then scope" applied to place: outside its routes the token is not an actor
 * with a small ceiling, it is not an actor. Exact segment match, so
 * `/api/v1/helpdesk-anything` is not inside, and versioned only: the portal is
 * a separately-deployed client, which is what `/api/v1` exists for.
 */
export const HELPDESK_PREFIX = `${API_V1}/helpdesk`;
export function isHelpdeskPath(path: string): boolean {
  return path === HELPDESK_PREFIX || path.startsWith(`${HELPDESK_PREFIX}/`);
}

/** The origins whose pages are allowed to authenticate with the session cookie. */
function cookieOriginAllowed(c: Context): boolean {
  const e = env();
  if (e.CORS_ALLOWED_ORIGINS.length === 0) return true;

  const origin = c.req.header('origin');
  if (!origin) return true;

  const own = new Set<string>();
  for (const url of [e.PUBLIC_URL, e.APP_URL]) {
    try {
      own.add(new URL(url).origin);
    } catch {
      // A malformed configured URL is not this middleware's problem to report;
      // env validation already refused anything that is not a URL.
    }
  }
  return own.has(origin);
}

/** A live session, with a still-waitlisted person let in once signup is open. */
async function resolveSession(token: string) {
  const session = await resolveStoredSession(token);
  if (session?.user.state === 'pending') session.user = await admitOnOpenSignup(session.user);
  return session;
}

export const attachActor = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const cookie = cookieOriginAllowed(c) ? readSessionCookie(c) : undefined;
  if (cookie) {
    const session = await resolveSession(cookie);
    if (session) {
      c.set('actor', {
        user: session.user,
        kind: 'user',
        sessionId: session.sessionId,
        viaCookie: true,
      });
      c.set('authVia', 'cookie');
      return next();
    }
  }

  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      // A session token presented as a bearer credential is the same session,
      // and therefore the same person, as one presented in a cookie.
      if (token.startsWith(SESSION_TOKEN_PREFIX)) {
        const session = await resolveSession(token);
        if (session) {
          c.set('actor', {
            user: session.user,
            kind: 'user',
            sessionId: session.sessionId,
            ...(session.client === 'ios' || session.client === 'android'
              ? { appSession: true as const }
              : {}),
          });
          c.set('authVia', 'bearer');
        }
        return next();
      }

      if (token.startsWith(INTEGRATION_TOKEN_PREFIX)) {
        if (isHelpdeskPath(c.req.path)) {
          const integration = await resolveIntegrationToken(token);
          if (integration) {
            c.set('authVia', 'bearer');
            c.set('actor', {
              user: integration.user,
              kind: 'integration',
              integrationId: integration.integrationId,
              // Never the owner's full reach: the client side of a radar is
              // reading and replying, and `requireHelpdeskRadar` asks for no more.
              ceiling: 'editor',
            });
          }
        }
        return next();
      }

      const bearer = await resolveBearerToken(token);
      if (bearer) {
        // The ceiling travels with the actor from here on. Dropping it — which
        // is what this middleware used to do — is what made every token scope
        // in the application decoration: `Actor` had no field for it, so no
        // service could read one, so every agent acted at the full breadth of
        // its human's access no matter what the grant said.
        c.set('authVia', 'bearer');
        c.set('actor', {
          user: bearer.user,
          kind: 'agent',
          tokenId: bearer.tokenId,
          scopes: bearer.scopes,
          ceiling: bearer.ceiling,
          // The persona and its voice grants travel with the actor for the same
          // reason the ceiling does, and with the same consequence if they do
          // not: `Actor` is the only place a service can read them from, so a
          // field dropped here is a feature that silently does nothing.
          //
          // Spread conditionally rather than assigned as `undefined`, because
          // `exactOptionalPropertyTypes` draws a distinction between an absent
          // key and a present undefined one — and here the absent key is the
          // meaningful state: this connection has no persona.
          ...(bearer.agent ? { agent: bearer.agent } : {}),
          ...(bearer.voice ? { voice: bearer.voice } : {}),
          ...(bearer.retiredAgent ? { retiredAgent: bearer.retiredAgent } : {}),
          ...(bearer.radarFence ? { radarFence: bearer.radarFence } : {}),
          connection: bearer.connection,
        });
      }
    }
  }

  return next();
};

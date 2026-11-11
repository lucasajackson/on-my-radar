/**
 * Resolving an invitation link.
 *
 * Unauthenticated by necessity — the whole point is that the person holding the
 * link does not have an account yet. It is safe to leave open because the token
 * is an HMAC over an invitation row id: there is nothing to enumerate, and
 * everything the route will say was already in the email the token arrived in.
 *
 * There is exactly one failure response. A bad signature, an expired token, a
 * revoked invitation, a deleted radar and an invitation somebody already
 * accepted all answer 404 with the same sentence. Telling them apart would
 * describe the inside of somebody else's account to whoever is holding the
 * link, and the landing page has the same thing to say in every one of those
 * cases anyway: this is no longer open, sign in normally.
 */
import { Hono } from 'hono';
import { notFound, type AppEnv } from '../http.js';
import { resolveInvite } from '../services/invites.js';

export const inviteRoutes = new Hono<AppEnv>();

inviteRoutes.get('/:token', async (c) => {
  const invite = await resolveInvite(c.req.param('token'));
  if (!invite) {
    throw notFound('That invitation is no longer open. You can still sign in with your address.');
  }
  return c.json({ invite });
});

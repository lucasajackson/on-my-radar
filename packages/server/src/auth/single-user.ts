/**
 * Single-user mode: an instance only its owner can reach (`SINGLE_USER_EMAIL`).
 *
 * The browser is signed in as that one account with no sign-in step. That is safe
 * only because of four things, each with a test that fails without it:
 *
 * - `env.ts` refuses to boot unless the instance's own URL is a local host.
 * - `singleUserHostFence` answers 421 to any other Host, so a DNS-rebinding page
 *   (a hostile name pointed at 127.0.0.1) is not served: to the browser it would
 *   be same-origin, and the boot check cannot see it.
 * - The session is minted in exactly one place, `GET /api/auth/session` (here),
 *   never in `attachActor`, which would write a row for every probe and also hand
 *   `/mcp` a cookie session. `/mcp` refuses cookie sessions in this mode, so
 *   agents still bring a token or OAuth grant.
 * - Nothing can invite somebody new, and the other sign-in routes answer 404.
 *
 * Any local process that can reach the port can mint a session. That is the mode.
 */
import type { MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { ApiError, type AppEnv, type Ctx } from '../http.js';
import { logger } from '../logger.js';
import { activateUser, findOrCreateUser, type UserRow } from './accounts.js';

/** `host` as a Host header gives it (port included), compared with the instance's own URLs. */
function hostIsOurs(host: string | undefined): boolean {
  const e = env();
  return [e.PUBLIC_URL, e.APP_URL].some((u) => new URL(u).host === host?.toLowerCase());
}

export const singleUserHostFence = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  // Probes may use the pod's or container's own name; /health says nothing worth rebinding for.
  if (
    env().SINGLE_USER_EMAIL &&
    !c.req.path.startsWith('/health') &&
    !hostIsOurs(c.req.header('host'))
  )
    throw new ApiError(421, 'misdirected_request', 'This instance is not served at that address.');
  return next();
};

/**
 * The account to sign this request in as, or null. Only for a request that came
 * from our own page: no `Authorization`, our own Host, and not another site's.
 */
export async function singleUserAccount(
  c: Ctx,
): Promise<{ user: UserRow; created: boolean } | null> {
  const email = env().SINGLE_USER_EMAIL;
  const site = c.req.header('sec-fetch-site');
  if (
    !email ||
    c.req.header('authorization') ||
    !hostIsOurs(c.req.header('host')) ||
    (site && site !== 'same-origin' && site !== 'none')
  )
    return null;

  let account;
  try {
    account = await findOrCreateUser(email);
  } catch (err) {
    logger.error({ err }, 'single-user account cannot sign in');
    return null;
  }
  let { user } = account;
  // Never un-suspends: a suspended account mints nothing.
  if (user.state === 'suspended') {
    logger.error({ userId: user.id }, 'single-user account is suspended; no session minted');
    return null;
  }
  if (user.state === 'pending') {
    await activateUser(null, user, 'single-user');
    user = { ...user, state: 'active' };
  }
  if (!user.isAdmin) {
    await getDb()
      .update(schema.users)
      .set({ isAdmin: true, updatedAt: new Date() })
      .where(and(eq(schema.users.id, user.id), eq(schema.users.state, 'active')));
    user = { ...user, isAdmin: true };
  }
  return { user, created: account.created };
}

import { Hono } from 'hono';
import { z } from 'zod';
import {
  guestSupportRequestSchema,
  guestSupportRecoverySchema,
  supportReplySchema,
  supportPageSchema,
} from '@onmyradar/contract';
import { clientIp, readJson, readQuery, requireUser, notFound, type AppEnv } from '../http.js';
import { networkOf } from '../services/public-request.js';
import {
  startGuestSupport,
  getGuestSupport,
  createGuestSupport,
  replyGuestSupport,
  recoverGuestSupport,
  revokeGuestSupport,
  revokeGuestSupportAsStaff,
  chargeGuestSupport,
  guestSecretHash,
  guestCapabilityLive,
} from '../services/guest-support.js';
export const guestSupportRoutes = new Hono<AppEnv>();
guestSupportRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  await next();
});
function network(c: Parameters<typeof clientIp>[0]) {
  const ip = clientIp(c);
  return ip ? networkOf(ip) : null;
}
/**
 * Validate the capability before spending any shared allowance: a stranger's invalid
 * tokens only drain their own network's miss bucket, never everyone's access.
 */
async function credential(c: Parameters<typeof clientIp>[0]) {
  const header = c.req.header('authorization') ?? '';
  if (!/^Support [A-Za-z0-9_-]{43}$/.test(header))
    throw notFound('Support conversation unavailable.');
  const token = header.slice(8);
  const net = network(c);
  const source = net ? guestSecretHash(net) : 'unknown';
  if (!(await guestCapabilityLive(token))) {
    await chargeGuestSupport(`access-miss:${source}`, 30, 60);
    throw notFound('Support conversation unavailable.');
  }
  if (net) await chargeGuestSupport(`access:${source}`, 300, 60);
  await chargeGuestSupport(`access:${guestSecretHash(token)}`, 60, 60);
  return token;
}
const emptyBody = z.object({}).strict();
guestSupportRoutes.post('/start', async (c) => {
  await readJson(c, emptyBody);
  return c.json(await startGuestSupport(network(c)), 201);
});
guestSupportRoutes.post('/recover', async (c) =>
  c.json(
    await recoverGuestSupport(
      (await readJson(c, guestSupportRecoverySchema)).recoveryCode,
      network(c),
    ),
  ),
);
guestSupportRoutes.get('/conversation', async (c) =>
  c.json(await getGuestSupport(await credential(c), readQuery(c, supportPageSchema).after)),
);
guestSupportRoutes.post('/conversation', async (c) =>
  c.json(
    await createGuestSupport(
      await credential(c),
      await readJson(c, guestSupportRequestSchema),
      network(c),
    ),
    201,
  ),
);
guestSupportRoutes.post('/conversation/replies', async (c) =>
  c.json(
    await replyGuestSupport(await credential(c), await readJson(c, supportReplySchema), network(c)),
    201,
  ),
);
guestSupportRoutes.post('/conversation/revoke', async (c) => {
  await readJson(c, emptyBody);
  await revokeGuestSupport(await credential(c));
  return c.json({ revoked: true });
});
guestSupportRoutes.post('/requests/:id/revoke', async (c) => {
  await readJson(c, emptyBody);
  await revokeGuestSupportAsStaff(requireUser(c), c.req.param('id'));
  return c.json({ revoked: true });
});

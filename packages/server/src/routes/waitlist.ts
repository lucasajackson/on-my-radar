/**
 * `POST /api/waitlist` — the marketing site's form. Unauthenticated by design;
 * everything that makes that safe is in `services/waitlist.ts`, except the
 * per-network ceiling, which needs the request's edge header and so is here.
 */
import { Hono } from 'hono';
import { waitlistRequestSchema } from '@onmyradar/contract';
import { chargeWaitlistNetwork } from '../auth/codes.js';
import { clientIp, readJson, tooManyRequests, type AppEnv } from '../http.js';
import { networkOf } from '../services/public-request.js';
import { joinWaitlist, waitlistResponse } from '../services/waitlist.js';

export const waitlistRoutes = new Hono<AppEnv>();

waitlistRoutes.post('/', async (c) => {
  const input = await readJson(c, waitlistRequestSchema);
  // Charged for every submission, a honeypot hit included: a bot is exactly
  // what the ceiling is for. No trusted header means no network to key on.
  const ip = clientIp(c);
  const network = ip ? networkOf(ip) : null;
  const retry = network ? await chargeWaitlistNetwork(network) : null;
  if (retry !== null) {
    throw tooManyRequests('Too many signups from your network. Try again later.', retry);
  }
  await joinWaitlist(input);
  return c.json(waitlistResponse(), 202);
});

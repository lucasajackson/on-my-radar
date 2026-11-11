/**
 * Charter anchors: settling the ones that lost their words (charter S4).
 *
 * `reanchor` points an anchor at new words in the charter as it stands; `dismiss` lets an orphaned
 * amendment go (or unlinks a link). Both are found by the anchor's own id, and an anchor of a
 * radar the caller may not write answers like an anchor that does not exist.
 */
import { Hono } from 'hono';
import { dismissAnchorSchema, reanchorSchema } from '@onmyradar/contract';
import { readJson, requireActor, type AppEnv } from '../http.js';
import { dismiss, reanchor } from '../services/architecture.js';
import { withHeaderKey } from '../services/idempotency.js';

export const anchorRoutes = new Hono<AppEnv>();

anchorRoutes.post('/:id/reanchor', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(c.req.header('idempotency-key'), await readJson(c, reanchorSchema));
  return c.json(await reanchor(actor, c.req.param('id'), input));
});

anchorRoutes.post('/:id/dismiss', async (c) => {
  const actor = requireActor(c);
  const input = withHeaderKey(
    c.req.header('idempotency-key'),
    await readJson(c, dismissAnchorSchema),
  );
  return c.json(await dismiss(actor, c.req.param('id'), input));
});

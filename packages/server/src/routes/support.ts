import { Hono } from 'hono';
import { supportPageSchema, supportReplySchema, supportRequestSchema } from '@onmyradar/contract';
import { readJson, readQuery, type AppEnv } from '../http.js';
import { createSupport, getSupport, listSupport, replySupport } from '../services/support.js';

export const supportRoutes = new Hono<AppEnv>();
supportRoutes.get('/', async (c) =>
  c.json(await listSupport(c.get('actor'), readQuery(c, supportPageSchema).after)),
);
supportRoutes.post('/', async (c) =>
  c.json(
    { request: await createSupport(c.get('actor'), await readJson(c, supportRequestSchema)) },
    201,
  ),
);
supportRoutes.get('/:id', async (c) =>
  c.json(
    await getSupport(c.get('actor'), c.req.param('id'), readQuery(c, supportPageSchema).after),
  ),
);
supportRoutes.post('/:id/replies', async (c) =>
  c.json(
    await replySupport(c.get('actor'), c.req.param('id'), await readJson(c, supportReplySchema)),
    201,
  ),
);

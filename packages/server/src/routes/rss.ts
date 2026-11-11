import { Hono } from 'hono';
import { createFeedSchema, updateFeedSchema } from '@onmyradar/contract';
import { readJson, requireActor, type AppEnv } from '../http.js';
import { createFeed, deleteFeed, listFeeds, updateFeed } from '../services/rss.js';

export const rssRouter = new Hono<AppEnv>();
rssRouter.get('/:id/feeds', async (c) =>
  c.json({ feeds: await listFeeds(requireActor(c), c.req.param('id')) }),
);
rssRouter.post('/:id/feeds', async (c) =>
  c.json(
    {
      feed: await createFeed(
        requireActor(c),
        c.req.param('id'),
        await readJson(c, createFeedSchema),
      ),
    },
    201,
  ),
);
rssRouter.patch('/:id/feeds/:feedId', async (c) =>
  c.json({
    feed: await updateFeed(
      requireActor(c),
      c.req.param('id'),
      c.req.param('feedId'),
      await readJson(c, updateFeedSchema),
    ),
  }),
);
rssRouter.delete('/:id/feeds/:feedId', async (c) => {
  await deleteFeed(requireActor(c), c.req.param('id'), c.req.param('feedId'));
  return c.body(null, 204);
});

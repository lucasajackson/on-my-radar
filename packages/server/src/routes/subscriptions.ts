import { Hono } from 'hono';
import { createSubscriptionSchema, updateSubscriptionSchema } from '@onmyradar/contract';
import { readJson, requireActor, type AppEnv } from '../http.js';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  listSubscriptionDeliveries,
  rotateSubscription,
  testSubscription,
  updateSubscription,
} from '../services/subscriptions.js';
export const subscriptionRoutes = new Hono<AppEnv>();
subscriptionRoutes.get('/:id/subscriptions', async (c) =>
  c.json({ subscriptions: await listSubscriptions(requireActor(c), c.req.param('id')) }),
);
subscriptionRoutes.post('/:id/subscriptions', async (c) =>
  c.json(
    {
      subscription: await createSubscription(
        requireActor(c),
        c.req.param('id'),
        await readJson(c, createSubscriptionSchema),
      ),
    },
    201,
  ),
);
subscriptionRoutes.patch('/:id/subscriptions/:subscriptionId', async (c) =>
  c.json({
    subscription: await updateSubscription(
      requireActor(c),
      c.req.param('id'),
      c.req.param('subscriptionId'),
      (await readJson(c, updateSubscriptionSchema)).enabled,
    ),
  }),
);
subscriptionRoutes.delete('/:id/subscriptions/:subscriptionId', async (c) => {
  await deleteSubscription(requireActor(c), c.req.param('id'), c.req.param('subscriptionId'));
  return c.body(null, 204);
});
subscriptionRoutes.post('/:id/subscriptions/:subscriptionId/rotate', async (c) =>
  c.json({
    subscription: await rotateSubscription(
      requireActor(c),
      c.req.param('id'),
      c.req.param('subscriptionId'),
    ),
  }),
);
subscriptionRoutes.post('/:id/subscriptions/:subscriptionId/test', async (c) => {
  await testSubscription(requireActor(c), c.req.param('id'), c.req.param('subscriptionId'));
  return c.json({ queued: true }, 202);
});
subscriptionRoutes.get('/:id/subscriptions/:subscriptionId/deliveries', async (c) =>
  c.json({
    deliveries: await listSubscriptionDeliveries(
      requireActor(c),
      c.req.param('id'),
      c.req.param('subscriptionId'),
    ),
  }),
);

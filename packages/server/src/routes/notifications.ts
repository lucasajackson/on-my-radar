import {
  registerNativePush,
  pushDeviceSettings,
  removePushDevice,
} from '../services/push-devices.js';
import { apnsConfigured } from '../services/apns.js';
/**
 * The notification stream, its read state, and the settings that govern it.
 *
 * Thin wrappers, like every other route file: the rules live in
 * `services/notifications.ts` so the MCP tools get exactly the same answers.
 *
 * Nothing here takes a radar id and trusts it. The one route that does —
 * setting a radar's level — lives in `routes/radars.ts` behind `requireRadar`,
 * because it is a statement about a radar and has to go through the one place
 * that decides who may reach one.
 */
import { Hono } from 'hono';
import {
  listNotificationsSchema,
  markNotificationsReadSchema,
  notificationCountsSchema,
  pushSubscriptionSchema,
  registerPushSchema,
  updateNotificationSettingsSchema,
  type NotificationSettingsDto,
} from '@onmyradar/contract';
import { env } from '../env.js';
import { readJson, readQuery, requireActor, type AppEnv } from '../http.js';
import {
  getSettings,
  listNotifications,
  markRead,
  markSeen,
  notificationCounts,
  updateSettings,
} from '../services/notifications.js';
import {
  pushConfigured,
  subscribePush,
  unsubscribePush,
  endpointHash,
  vapidPublicKey,
} from '../services/push.js';

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  const query = readQuery(c, listNotificationsSchema);
  return c.json(await listNotifications(actor, query));
});

/**
 * Everything the shell's badges need in one round trip. Polled, so it is
 * deliberately the cheapest query in the feature: one partial-index scan
 * grouped by radar.
 */
notificationRoutes.get('/counts', async (c) => {
  const actor = requireActor(c);
  return c.json(await notificationCounts(actor, readQuery(c, notificationCountsSchema).box));
});

notificationRoutes.post('/read', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, markNotificationsReadSchema);
  return c.json(await markRead(actor, input));
});

/**
 * The list has been displayed. Seen is not read: this stops the ping without
 * claiming anything has been dealt with, so the badge keeps its count.
 */
notificationRoutes.post('/seen', async (c) => {
  const actor = requireActor(c);
  return c.json(await markSeen(actor));
});

/* -------------------------------- settings ------------------------------- */

notificationRoutes.get('/settings', async (c) => {
  const actor = requireActor(c);
  const e = env();
  const endpoint = c.req.query('endpoint');
  const mineHash = c.req.query('endpointHash') ?? (endpoint ? endpointHash(endpoint) : undefined);
  const [settings, binding] = await Promise.all([
    getSettings(actor),
    pushDeviceSettings(actor, mineHash, c.req.query('deviceId')),
  ]);
  c.header('cache-control', 'no-store');

  const body: NotificationSettingsDto = {
    previewEnabled: settings.previewEnabled,
    kindPreferences: settings.kindPreferences,
    browserBinding: binding.browserBinding,
    transportAvailability: {
      web: pushConfigured(e),
      apns: { sandbox: apnsConfigured('sandbox', e), production: apnsConfigured('production', e) },
      fcm: false,
    },
    emailEnabled: settings.emailEnabled,
    pushEnabled: settings.pushEnabled,
    // Absent VAPID keys are a supported state, exactly like storage and SSO —
    // the UI hides the control rather than offering one that cannot work.
    pushAvailable: pushConfigured(e),
    vapidPublicKey: vapidPublicKey(e),
    devices: binding.devices,
    radars: settings.radars,
  };
  return c.json(body);
});

notificationRoutes.patch('/settings', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateNotificationSettingsSchema);
  await updateSettings(actor, input);
  return c.json(await getSettings(actor));
});

/* ---------------------------------- push --------------------------------- */

/**
 * Register this browser. Idempotent by endpoint, so a page load that
 * re-subscribes updates the row rather than adding one.
 */
notificationRoutes.post('/push', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, registerPushSchema);
  return c.json(
    'platform' in input
      ? await registerNativePush(actor, input)
      : await subscribePush(actor, input),
    201,
  );
});

/**
 * POST rather than DELETE with a body: the endpoint is a 300-character URL and
 * a DELETE body is not reliably forwarded by every proxy in the path.
 */
notificationRoutes.post('/push/unsubscribe', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, pushSubscriptionSchema.pick({ endpoint: true }));
  await unsubscribePush(actor, input.endpoint);
  return c.body(null, 204);
});

notificationRoutes.delete('/push/:deviceId', async (c) => {
  await removePushDevice(requireActor(c), c.req.param('deviceId'));
  return c.body(null, 204);
});

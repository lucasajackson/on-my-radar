// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { existingPushSubscription, subscribeToPush } from './push';

afterEach(() => vi.unstubAllGlobals());
function browser(permission: NotificationPermission) {
  const requestPermission = vi.fn();
  const subscribe = vi.fn();
  const json = { endpoint: 'https://push.test/private', keys: { p256dh: 'key', auth: 'secret' } };
  const getSubscription = vi.fn().mockResolvedValue({ toJSON: () => json });
  const registration = { pushManager: { getSubscription, subscribe } };
  const getRegistration = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('Notification', { permission, requestPermission });
  // Only its presence is checked.
  vi.stubGlobal('PushManager', {});
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration,
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  return { requestPermission, subscribe, json, getRegistration };
}
it('automatic reconnect reads existing granted consent without requesting or creating anything', async () => {
  const b = browser('granted');
  expect(await existingPushSubscription()).toEqual(b.json);
  expect(b.requestPermission).not.toHaveBeenCalled();
  expect(b.subscribe).not.toHaveBeenCalled();
});
it.each(['default', 'denied'] as const)(
  'does not inspect or create subscriptions when permission is %s',
  async (permission) => {
    const b = browser(permission);
    expect(await existingPushSubscription()).toBeNull();
    expect(b.getRegistration).not.toHaveBeenCalled();
    expect(b.requestPermission).not.toHaveBeenCalled();
  },
);
it('explicit enable reuses already granted permission without prompting again', async () => {
  const b = browser('granted');
  expect(await subscribeToPush('unused-existing-key')).toEqual(b.json);
  expect(b.requestPermission).not.toHaveBeenCalled();
  expect(b.subscribe).not.toHaveBeenCalled();
});

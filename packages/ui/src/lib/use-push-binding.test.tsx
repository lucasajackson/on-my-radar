// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { NotificationSettingsDto } from '@onmyradar/contract';
import { api } from './api';
import { usePushBinding } from './use-push-binding';
import * as push from './push';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.restoreAllMocks());
function Probe() {
  usePushBinding('viewer');
  return null;
}
it.each([
  ['needs_reconnect', true, true],
  ['not_registered', true, false],
  ['active', true, false],
  ['needs_reconnect', false, false],
] as const)('reconnect eligibility: %s / push %s', async (binding, enabled, expected) => {
  const subscription = {
    endpoint: 'https://push.test/private',
    keys: { p256dh: 'key', auth: 'secret' },
  };
  vi.spyOn(push, 'existingPushSubscription').mockResolvedValue(subscription);
  vi.spyOn(push, 'describeThisBrowser').mockReturnValue('Browser');
  vi.spyOn(api.notifications, 'settings').mockResolvedValue({
    pushEnabled: enabled,
    browserBinding: binding,
  } as NotificationSettingsDto);
  const register = vi.spyOn(api.notifications, 'subscribePush').mockResolvedValue({ id: 'device' });
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  if (expected) expect(register).toHaveBeenCalledWith(subscription, 'Browser', true);
  else expect(register).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

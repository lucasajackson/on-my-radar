// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { NOTIFICATION_KINDS, type NotificationSettingsDto } from '@onmyradar/contract';
import { NotificationSettings } from './notification-settings';
import { api } from '../lib/api';
import * as push from '../lib/push';
import { must } from '../lib/must';

it('does not confuse a local endpoint with server registration and preserves other event choices', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(push, 'readPushState').mockResolvedValue({
    supported: true,
    permission: 'granted',
    endpoint: 'https://push.test/endpoint',
  });
  const settings: NotificationSettingsDto = {
    emailEnabled: true,
    pushEnabled: true,
    previewEnabled: false,
    pushAvailable: true,
    vapidPublicKey: 'key',
    browserBinding: 'not_registered',
    radars: [],
    devices: [
      {
        id: 'disabled',
        label: 'Old phone',
        platform: 'apns',
        disabled: true,
        createdAt: '2026-09-20T12:00:00Z',
        lastUsedAt: null,
        current: false,
      },
    ],
    kindPreferences: Object.fromEntries(
      NOTIFICATION_KINDS.map((k) => [k, { email: false, push: true }]),
    ) as NonNullable<NotificationSettingsDto['kindPreferences']>,
  };
  vi.spyOn(api.notifications, 'settings').mockResolvedValue(settings);
  const save = vi.spyOn(api.notifications, 'updateSettings').mockResolvedValue(settings);
  const subscribe = vi.spyOn(push, 'subscribeToPush');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NotificationSettings />
      </QueryClientProvider>,
    ),
  );
  // Push state, then the settings that depend on it: two async hops. Wait on
  // the result, not a fixed delay — 20ms was not always enough on a loaded box.
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.textContent).toContain('Enable in this browser');
  });
  expect(host.textContent).not.toContain('Connected and ready');
  expect(host.textContent).toContain('Disconnected');
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Disconnect Old phone"]')?.disabled,
  ).toBe(true);
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () =>
    must(
      host.querySelector<HTMLInputElement>('input[aria-label="Incoming email by email"]'),
    ).click(),
  );
  expect(save).toHaveBeenCalledWith({ kindPreferences: { email_received: { email: true } } });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it('folds the per-radar list behind a summary while the defaults stay in view', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(push, 'readPushState').mockResolvedValue({
    supported: false,
    permission: 'denied',
    endpoint: null,
  });
  const radar = (id: string, level: 'all' | 'involved' | 'none') => ({
    id,
    name: `Radar ${id}`,
    glyph: 'radar',
    accent: 'teal',
    level,
  });
  vi.spyOn(api.notifications, 'settings').mockResolvedValue({
    emailEnabled: true,
    pushEnabled: false,
    pushAvailable: false,
    vapidPublicKey: null,
    radars: [radar('a', 'involved'), radar('b', 'none'), radar('c', 'involved')],
    devices: [],
    kindPreferences: Object.fromEntries(
      NOTIFICATION_KINDS.map((k) => [k, { email: true, push: false }]),
    ) as NonNullable<NotificationSettingsDto['kindPreferences']>,
  } as NotificationSettingsDto);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationSettings />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.textContent).toContain('Per-radar settings');
  });
  const fold = must(host.querySelector<HTMLDetailsElement>('[data-omr="per-radar-notifications"]'));
  expect(fold.open).toBe(false);
  expect(fold.querySelector('summary')?.textContent).toContain('1 of 3 changed');
  expect(fold.querySelector('[aria-label="Notifications for Radar b"]')).not.toBeNull();
  // The account-wide defaults are outside the fold.
  const defaults = must(host.querySelector('input[aria-label="Mentions by email"]'));
  expect(fold.contains(defaults)).toBe(false);
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

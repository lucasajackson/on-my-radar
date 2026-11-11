// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { NotificationDto } from '@onmyradar/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationLine, clearableTotal, useRefreshOnEnter } from './notifications';

it('shows the shared principal sentence as text, preserving distinct agent labels', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const notification: NotificationDto = {
    id: 'notification',
    kind: 'comment',
    title: 'Lulu (agent) and Lulu commented on “Launch”',
    excerpt: '<img src=x onerror=alert(1)>',
    count: 2,
    actors: [],
    principals: [
      { kind: 'agent', id: 'agent', displayName: 'Lulu' },
      { kind: 'human', id: 'human', displayName: 'Lulu' },
    ],
    hasUnattributedEvents: false,
    radar: null,
    topic: null,
    blipId: null,
    read: true,
    seen: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const host = document.createElement('ul');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<NotificationLine notification={notification} />));
    expect(host.querySelector('.notification-title')?.textContent).toBe(notification.title);
    expect(host.querySelector('img')).toBeNull();
    await act(async () =>
      root.render(
        <NotificationLine
          notification={{ ...notification, title: '<script>alert(1)</script> (agent) commented' }}
        />,
      ),
    );
    expect(host.textContent).toContain('<script>alert(1)</script> (agent)');
    expect(host.querySelector('script')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('leaves proposals out of what the widget can clear', () => {
  expect(clearableTotal({ total: 1, proposals: 1, unseen: 0, byRadar: {} })).toBe(0);
  expect(clearableTotal({ total: 3, proposals: 1, unseen: 0, byRadar: {} })).toBe(2);
  expect(clearableTotal({ total: 2, unseen: 0, byRadar: {} })).toBe(2);
  expect(clearableTotal(undefined)).toBe(0);
});

it('refetches the list and the counts when the page is entered', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  function Probe() {
    useRefreshOnEnter();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
    const keys = invalidate.mock.calls.map(([f]) => f?.queryKey);
    expect(keys).toContainEqual(['notifications']);
    expect(keys).toContainEqual(['notification-counts']);
  } finally {
    await act(async () => root.unmount());
  }
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { Composer } from './composer';
import { SessionProvider } from '../lib/session';
import { must, setNativeValue } from '../lib/must';
import type { MemberDto } from '@onmyradar/contract';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // A desktop, where the composer takes focus on arrival.
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function arriveWhileFocusedOn(element: HTMLElement) {
  document.body.append(element);
  element.focus();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // The composer mounts when the radar's data arrives — possibly mid-word.
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer radarId="r1" onCaptured={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const active = document.activeElement;
  await act(async () => root.unmount());
  return { active, composer: host };
}

it('does not take the keyboard from a field somebody is typing in', async () => {
  const filter = document.createElement('input');
  const { active } = await arriveWhileFocusedOn(filter);
  expect(active).toBe(filter);
});

it('still takes focus on arrival from the link that brought you here', async () => {
  const link = document.createElement('a');
  link.href = '/radar/r1';
  const { active } = await arriveWhileFocusedOn(link);
  expect(active?.tagName).toBe('TEXTAREA');
});

it('lets a dragged link or sentence drop into the box, and takes only files for itself', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer radarId="r1" onCaptured={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const box = host.querySelector('textarea');
  const drag = (type: 'dragover' | 'drop', types: string[]) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types, files: [] } });
    box?.dispatchEvent(event);
    return event.defaultPrevented;
  };
  // A link from another tab: the browser's own drop must go ahead.
  expect(drag('dragover', ['text/uri-list', 'text/plain'])).toBe(false);
  expect(drag('drop', ['text/uri-list', 'text/plain'])).toBe(false);
  // A file is the composer's to handle.
  expect(drag('dragover', ['Files'])).toBe(true);
  await act(async () => root.unmount());
});

it('does not promise to notify you about your own mention', async () => {
  const member = (userId: string, name: string): MemberDto => ({
    userId,
    email: `${name.toLowerCase()}@example.com`,
    name,
    role: 'editor',
    pending: false,
    via: 'member',
    viaTopic: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  vi.spyOn(api.radars, 'members').mockResolvedValue({
    members: [member('me', 'Lucas'), member('u2', 'Ada')],
    agents: [],
  });
  vi.spyOn(api.auth, 'session').mockResolvedValue({
    user: {
      id: 'me',
      email: 'lucas@example.com',
      name: 'Lucas',
      avatarUrl: null,
      state: 'active',
      isAdmin: false,
      theme: 'system',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider>
          <Composer radarId="r1" onCaptured={vi.fn()} />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  const box = must(host.querySelector('textarea'), 'capture box');
  await act(async () => {
    setNativeValue(box, 'for @lucas and @ada');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const footer = host.textContent;
  expect(footer).toContain('will notify · Ada');
  expect(footer).not.toContain('Lucas');
  await act(async () => root.unmount());
});

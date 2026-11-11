// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { Conversation } from '../components/conversation';
import { RelativeTime } from '../components/relative-time';
import { api } from './api';
import { useLivePoll } from './polling';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useRouter: () => undefined,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

let visibility: 'visible' | 'hidden' = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const setVisibility = async (next: 'visible' | 'hidden') => {
  visibility = next;
  await act(
    async () => void document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
  );
};
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function Probe({ fetcher }: { fetcher: () => Promise<number> }) {
  const poll = useLivePoll();
  useQuery({ queryKey: ['probe'], queryFn: fetcher, ...poll });
  return null;
}

it('polls every 15 s while visible; hidden, it registers no interval and fetches nothing; it catches up on return', async () => {
  const fetcher = vi.fn(() => Promise.resolve(1));
  const root = createRoot(document.createElement('div'));
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe fetcher={fetcher} />
      </QueryClientProvider>,
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await advance(15_000);
  expect(fetcher).toHaveBeenCalledTimes(2);

  const visibleTimers = vi.getTimerCount();
  await setVisibility('hidden');
  expect(vi.getTimerCount()).toBe(visibleTimers - 1); // the refetch interval, cleared
  await advance(5 * 60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);

  await setVisibility('visible');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBeGreaterThanOrEqual(visibleTimers);
  await advance(15_000);
  expect(fetcher).toHaveBeenCalledTimes(4);
  await act(async () => root.unmount());
  client.clear();
});

it('relative times keep counting, and hold no timer while the tab is hidden', async () => {
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<RelativeTime iso="2026-11-01T11:59:50Z" />));
  expect(host.textContent).toBe('now');
  expect(vi.getTimerCount()).toBe(1);
  await advance(60_000);
  expect(host.textContent).toBe('1m');
  await advance(10 * 60_000);
  expect(host.textContent).toBe('11m');

  await setVisibility('hidden');
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(Date.now() + 30 * 60_000); // time passes while hidden
  await advance(60_000);
  expect(host.textContent).toBe('11m');
  await setVisibility('visible'); // shown again: one immediate tick, timer back
  expect(host.textContent).toBe('42m');
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
});

const threadBlip = (id: string) =>
  ({
    id,
    radarId: 'r1',
    kind: 'note',
    title: id,
    body: id,
    url: null,
    state: 'inbox',
    status: null,
    pinned: false,
    tags: [],
    attachments: [],
    commentCount: 2,
    reactions: [],
    author: null,
    agent: null,
    voice: null,
    mentions: [],
    email: null,
    dueAt: null,
    reminder: null,
    archivedAt: null,
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
  }) as unknown as BlipDto;

it('a discussion page of threads makes no comment polls; the one open card polls once per 15 s', async () => {
  const comments = vi
    .spyOn(api.blips, 'comments')
    .mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
  const root = createRoot(document.createElement('div'));
  const client = new QueryClient();
  const page = Array.from({ length: 12 }, (_, i) => threadBlip(`t${i}`));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {page.map((blip) => (
          <Conversation
            key={blip.id}
            blip={blip}
            template="discussion"
            commentsEnabled
            reactionsEnabled={false}
          />
        ))}
        <Conversation
          blip={threadBlip('open')}
          template="discussion"
          commentsEnabled
          reactionsEnabled={false}
          poll
        />
      </QueryClientProvider>,
    ),
  );
  const callsFor = (id: string) => comments.mock.calls.filter(([blipId]) => blipId === id).length;
  expect(comments).toHaveBeenCalledTimes(13); // every thread loads once
  await advance(60_000);
  for (const blip of page) expect(callsFor(blip.id)).toBe(1);
  expect(callsFor('open')).toBe(1 + 4);
  await act(async () => root.unmount());
  client.clear();
});

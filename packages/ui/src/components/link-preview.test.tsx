// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { BlipCard } from './blips';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const pending = {
  id: 'b1',
  radarId: 'r1',
  kind: 'link',
  title: null,
  body: 'https://example.com/article #reading',
  url: 'https://example.com/article',
  preview: null,
  previewPending: true,
  state: 'inbox',
  status: null,
  pinned: false,
  tags: ['reading'],
  attachments: [],
  commentCount: 0,
  reactions: [],
  author: null,
  agent: null,
  voice: null,
  mentions: [],
  email: null,
  dueAt: null,
  reminder: null,
  archivedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
} as unknown as BlipDto;

const { previewPending: _dropped, ...rest } = pending;
const done: BlipDto = {
  ...rest,
  preview: {
    title: 'An article worth reading',
    description: null,
    siteName: 'Example',
    imageUrl: null,
    fetchedAt: '2026-09-01T00:00:02Z',
  },
};

async function render(extra: { publicSlug?: string } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <BlipCard blip={pending} readOnly={false} onChanged={vi.fn()} {...extra} />
      </QueryClientProvider>,
    ),
  );
  return host;
}

it('says a link preview is coming, asks after it, and shows it when it lands', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const get = vi
      .spyOn(api.blips, 'get')
      .mockResolvedValueOnce({ blip: pending })
      .mockResolvedValue({ blip: done });
    const host = await render();
    expect(host.textContent).toContain('fetching preview…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    await vi.waitFor(() => expect(host.textContent).toContain('An article worth reading'));
    expect(host.textContent).not.toContain('fetching preview…');
    const calls = get.mock.calls.length;
    // Done: nothing more is asked, however long it is left.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(get.mock.calls.length).toBe(calls);
  } finally {
    vi.useRealTimers();
  }
});

it('gives up asking after a bounded number of tries', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const get = vi.spyOn(api.blips, 'get').mockResolvedValue({ blip: pending });
    const host = await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(get.mock.calls.length).toBeLessThanOrEqual(8);
    expect(host.textContent).not.toContain('fetching preview…');
  } finally {
    vi.useRealTimers();
  }
});

it('does not poll from a public page, where an anonymous reader has no blip route', async () => {
  const get = vi.spyOn(api.blips, 'get');
  const host = await render({ publicSlug: 'shared' });
  expect(host.textContent).not.toContain('fetching preview…');
  expect(get).not.toHaveBeenCalled();
});

it('asks again on returning to the tab while a preview is still coming', async () => {
  const get = vi
    .spyOn(api.blips, 'get')
    .mockResolvedValueOnce({ blip: pending })
    .mockResolvedValue({ blip: done });
  const host = await render();
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  // Away and back, well before the next poll is due.
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('An article worth reading'), {
    timeout: 1_000,
  });
  focusManager.setFocused(undefined);
});

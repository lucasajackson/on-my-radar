// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { RadarEmailCapture } from './email-capture';
import { FeedSources } from './feed-sources';
import { must, setNativeValue } from '../lib/must';
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  must(
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent.trim() === text,
    ),
  );
const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
it('requires an explicit history choice and preserves the feed draft after a failed save', async () => {
  vi.spyOn(api.feeds, 'list').mockResolvedValue({ feeds: [] });
  const create = vi
    .spyOn(api.feeds, 'create')
    .mockRejectedValue(new ApiError(400, 'invalid', 'That URL is not a feed'));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FeedSources radarId="radar" />
      </QueryClientProvider>,
    ),
  );
  await act(async () => button('Add RSS feed').click());
  const url = must(document.querySelector<HTMLInputElement>('input[type="url"]'));
  await type(url, 'https://example.com/feed');
  expect(button('Add feed').disabled).toBe(true);
  const history = must(document.querySelector<HTMLButtonElement>('[role="combobox"]'));
  await act(async () => history.click());
  const month = must(
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'Past month',
    ),
  );
  await act(async () => month.click());
  await act(async () => button('Add feed').click());
  expect(create).toHaveBeenCalledWith('radar', {
    url: 'https://example.com/feed',
    lookback: 'month',
  });
  expect(url.value).toBe('https://example.com/feed');
  expect(history.textContent).toBe('Past month');
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});

it('enables a radar after username reservation even before its alias has been allocated', async () => {
  const settings = {
    available: true,
    identityConfigured: true,
    enabled: false,
    address: null,
    allowedSenders: ['owner@example.test'],
    lastReceivedAt: null,
    lastError: null,
  };
  vi.spyOn(api.emailCapture, 'radar').mockResolvedValue(settings);
  const update = vi
    .spyOn(api.emailCapture, 'updateRadar')
    .mockResolvedValue({ ...settings, enabled: true, address: 'owner+radar@onmyradar.io' });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RadarEmailCapture radarId="radar" isDropBox={false} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const toggle = must(document.querySelector<HTMLInputElement>('input[type="checkbox"]'));
  expect(toggle.disabled).toBe(false);
  expect(document.body.textContent).toContain('assigned when you enable');
  await act(async () => toggle.click());
  expect(update).toHaveBeenCalledWith('radar', {
    enabled: true,
    allowedSenders: ['owner@example.test'],
  });
  expect(document.body.textContent).toContain('owner+radar@onmyradar.io');
});

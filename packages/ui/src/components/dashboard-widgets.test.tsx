// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { WidgetEditor } from './dashboard-widgets';
import type { DashboardQueryResultDto } from '@onmyradar/contract';
import { must, setNativeValue } from '../lib/must';
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
const empty: DashboardQueryResultDto = {
  total: 0,
  items: [],
  nextCursor: null,
  text: '',
  filters: [],
  problems: [],
  unresolved: false,
  ranking: 'recent',
  radarsSearched: 2,
};
it.each([true, false])(
  'allows valid empty queries but blocks unresolved filters (unresolved=%s)',
  async (unresolved) => {
    vi.spyOn(api.search, 'suggest').mockResolvedValue({
      radars: [],
      people: [],
      topics: [],
      corpus: { radars: 2, blips: 0 },
    });
    vi.spyOn(api.dashboards, 'preview').mockResolvedValue({ ...empty, unresolved });
    const save = vi.fn(async () => {});
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WidgetEditor radars={[]} taken={new Set()} onClose={vi.fn()} onSave={save} />
        </QueryClientProvider>,
      ),
    );
    const live = must(
      Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))[1],
    );
    await act(async () => live.click());
    await type(
      must(document.querySelector<HTMLInputElement>('input[placeholder="Reading to catch up on"]')),
      'Inbox across radars',
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(button('Add widget').disabled).toBe(unresolved);
    // A disabled Add says why, beside it.
    expect(document.body.textContent.includes('Fix the query first')).toBe(unresolved);
    await act(async () => button('Add widget').click());
    if (unresolved) expect(save).not.toHaveBeenCalled();
    else
      expect(save).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          type: 'query',
          title: 'Inbox across radars',
          query: 'is:inbox',
          limit: 12,
        }),
      );
  },
);

it('says a live query widget needs a name, rather than leaving Add disabled without a reason', async () => {
  vi.spyOn(api.search, 'suggest').mockResolvedValue({
    radars: [],
    people: [],
    topics: [],
    corpus: { radars: 2, blips: 0 },
  });
  vi.spyOn(api.dashboards, 'preview').mockResolvedValue(empty);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WidgetEditor radars={[]} taken={new Set()} onClose={vi.fn()} onSave={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const live = must(
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))[1],
  );
  await act(async () => live.click());
  expect(button('Add widget').disabled).toBe(true);
  expect(document.body.textContent).toContain('Name the widget to add it.');
  expect(
    must(document.querySelector('input[placeholder="Reading to catch up on"]')).hasAttribute(
      'required',
    ),
  ).toBe(true);
});

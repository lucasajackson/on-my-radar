// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto, SearchResultDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { UniversalSearch } from './universal-search';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/', search: {} } }),
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRadars: () => ({ data: { radars: [] } }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('marks the words that matched in a quick result, rather than flattening them to text', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.search, 'suggest').mockResolvedValue({
    radars: [],
    people: [],
    topics: [],
    corpus: { radars: 1, blips: 1 },
  });
  const blip = {
    id: 'b1',
    radarId: 'r1',
    title: 'Garden plans',
    body: 'Plant the tomatoes after the last frost.',
    email: null,
    archivedAt: null,
    dueAt: null,
    reminder: null,
  } as unknown as BlipDto;
  vi.spyOn(api.search, 'run').mockResolvedValue({
    items: [blip],
    nextCursor: null,
    text: 'tomatoes',
    filters: [],
    problems: [],
  } as unknown as SearchResultDto);

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <UniversalSearch />
      </QueryClientProvider>,
    ),
  );
  const input = must(host.querySelector<HTMLInputElement>('#global-search'), 'the search box');
  await act(async () => {
    input.focus();
    setNativeValue(input, 'tomatoes');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const mark = await vi.waitFor(() =>
    must(host.querySelector('.universal-search-result-preview mark'), 'a highlighted match'),
  );
  expect(mark.textContent.toLowerCase()).toBe('tomatoes');
  await act(async () => root.unmount());
});

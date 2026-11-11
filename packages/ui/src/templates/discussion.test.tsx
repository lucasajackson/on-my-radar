// @vitest-environment jsdom
/** The discussion's index / open thread / side panel, and which thread is open when. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { paneFor, type TemplateViewProps } from './index';
import { DiscussionView } from './discussion';

const router = vi.hoisted(() => {
  const search: Record<string, unknown> = {};
  return { search, navigate: vi.fn() };
});
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: router.navigate, history: { back: vi.fn() } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { search: router.search } }),
}));
// The card is its own suite; here it only has to say which blip is open.
vi.mock('../components/blips', () => ({
  BlipCard: ({ blip }: { blip: BlipDto }) => (
    <div data-testid="card">
      {blip.id}
      <textarea data-testid="draft" />
    </div>
  ),
}));
vi.mock('../lib/api', () => ({ api: { blips: { get: vi.fn() } } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const T0 = '2026-11-02T12:00:00.000Z';
const blip = (id: string, patch: Partial<BlipDto> = {}) =>
  ({
    id,
    radarId: 'r1',
    title: `Thread ${id}`,
    body: '',
    status: 'open',
    state: 'active',
    tags: [],
    commentCount: 2,
    createdAt: T0,
    lastActivityAt: T0,
    author: { id: 'u', name: 'Lucas', email: 'l@example.com' },
    agent: null,
    voice: null,
    supersedes: null,
    supersededBy: null,
    ...patch,
  }) as unknown as BlipDto;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.blips.get).mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  router.search = {};
  router.navigate.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Render, or re-render the same view with new blips (a refetch that reordered them). */
const show = (blips: BlipDto[]) => {
  const props = {
    radar: { id: 'r1', template: 'discussion', templateConfig: null } as unknown as RadarDto,
    blips,
    readOnly: false,
    loading: false,
    loadingMore: false,
    hasMore: false,
    onLoadMore: vi.fn(),
    onChanged: vi.fn(),
    emptyTitle: 'Nothing',
    emptyHint: '',
  } satisfies TemplateViewProps;
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <DiscussionView {...props} />
      </QueryClientProvider>,
    ),
  );
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);

it('opens the newest thread beside the index when the address names none', () => {
  show([blip('a'), blip('b')]);
  expect(host.querySelectorAll('.disc-topic')).toHaveLength(2);
  expect(q('[data-testid=card]')?.textContent).toBe('a');
  expect(q('.disc-topic[aria-current]')?.textContent).toContain('Thread a');
  expect(q('.cols')?.getAttribute('data-view')).toBe('index');
});

it('opens the thread ?sel= names, and marks the page open for a phone', () => {
  router.search = { sel: 'b' };
  show([blip('a'), blip('b')]);
  expect(q('[data-testid=card]')?.textContent).toBe('b');
  expect(q('.cols')?.getAttribute('data-view')).toBe('item');
});

it('choosing a thread writes ?sel= and keeps the rest of the address', () => {
  show([blip('a'), blip('b')]);
  act(() => host.querySelectorAll<HTMLElement>('.disc-topic')[1]?.click());
  const { search } = router.navigate.mock.calls[0]?.[0] as {
    search: (prev: object) => object;
  };
  expect(search({ blip: 'x' })).toEqual({ blip: 'x', sel: 'b' });
});

it('the side panel states status, participants, tags and what a thread links to', () => {
  show([
    blip('a', {
      tags: ['ux'],
      supersedes: 'b',
      supersedesTitle: 'Old plan',
      mentions: [{ handle: 'lulu', userId: '', name: 'Lulu' }],
    }),
    blip('b'),
  ]);
  const text = q('.cols-panel')?.textContent ?? '';
  expect(text).toContain('Open');
  expect(text).toContain('Lucas, Lulu');
  expect(text).toContain('#ux');
  expect(q('.disc-link')?.textContent).toBe('Replaces Old plan');
});

it('keeps the open thread, and the draft in it, when a refetch reorders the threads', () => {
  show([blip('a'), blip('b')]);
  const draft = q('[data-testid=draft]') as HTMLTextAreaElement;
  draft.value = 'half a reply';
  show([blip('b'), blip('a')]);
  expect(q('[data-testid=card]')?.textContent).toBe('a');
  expect(q('[data-testid=draft]')).toBe(draft);
  expect((q('[data-testid=draft]') as HTMLTextAreaElement).value).toBe('half a reply');
  expect(host.querySelectorAll('.disc-topic')[1]?.getAttribute('aria-current')).toBe('true');
});

it('fetches a ?sel= thread that is beyond the loaded page instead of showing another', async () => {
  router.search = { sel: 'far' };
  vi.mocked(api.blips.get).mockResolvedValue({ blip: blip('far') });
  show([blip('a')]);
  expect(q('[data-testid=card]')).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(api.blips.get).toHaveBeenCalledWith('far');
  expect(q('[data-testid=card]')?.textContent).toBe('far');
  expect(q('.cols')?.getAttribute('data-view')).toBe('item');
});

it('says so, and shows no other thread, when the named one is not in this radar', async () => {
  router.search = { sel: 'elsewhere' };
  vi.mocked(api.blips.get).mockResolvedValue({ blip: blip('elsewhere', { radarId: 'r2' }) });
  show([blip('a')]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(q('[data-testid=card]')).toBeNull();
  expect(q('.cols-main')?.textContent).toContain('not available');
});

it('a template declares its own pane; an unknown layout is read as a stream', () => {
  expect(paneFor('discussion')).toEqual({
    measure: 'max-w-[var(--radar-max)]',
    contained: true,
    rail: false,
  });
  expect(paneFor('from-a-newer-server')).toEqual(paneFor('stream'));
});

it('every layout fills up to --radar-max; only reading-list-shaped ones rail, only the popup-bearing ones are not contained', () => {
  const layouts = ['stream', 'timeline', 'log', 'board', 'architecture', 'discussion'] as const;
  for (const layout of layouts) expect(paneFor(layout).measure).toBe('max-w-[var(--radar-max)]');
  expect(layouts.filter((layout) => paneFor(layout).rail)).toEqual(['stream']);
  expect(layouts.filter((layout) => !paneFor(layout).contained)).toEqual(['board', 'architecture']);
});

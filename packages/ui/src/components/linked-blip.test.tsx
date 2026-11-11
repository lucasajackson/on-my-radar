// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { LinkedBlip } from './linked-blip';
import { api, ApiError } from '../lib/api';
import { must } from '../lib/must';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

it('does not reveal cached content while rechecking a notification target that lost access', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['blips', 'detail', 'secret'], {
    blip: {
      id: 'secret',
      radarId: 'old',
      title: 'Cached secret title',
      body: 'Cached secret content',
    },
  });
  client.setQueryData(['radar', 'linked', 'old'], { radar: { id: 'old', template: 'kanban' } });
  let reject!: (error: Error) => void;
  vi.spyOn(api.blips, 'get').mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  vi.spyOn(api.radars, 'get').mockRejectedValue(new ApiError(403, 'forbidden', 'Access changed'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LinkedBlip id="secret" originRadarId="old" onClose={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  expect(document.body.textContent).not.toContain('Cached secret content');
  expect(document.body.textContent).not.toContain('Cached secret title');
  await act(async () => reject(new ApiError(403, 'forbidden', 'Access changed')));
  expect(document.body.textContent).not.toContain('Cached secret content');
  expect(document.body.textContent).not.toContain('Cached secret title');
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.restoreAllMocks();
});

it('reads the linked radar alongside the blip, and follows a blip that moved', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let land!: (value: { blip: never }) => void;
  vi.spyOn(api.blips, 'get').mockImplementation(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  const radarFor = (id: string) =>
    ({
      radar: {
        id,
        name: id === 'origin' ? 'Origin' : 'Elsewhere',
        template: 'stream',
        templateConfig: {},
        access: { canWrite: false },
        commentsEnabled: false,
        reactionsEnabled: false,
      },
    }) as never;
  const radars = vi
    .spyOn(api.radars, 'get')
    .mockImplementation((id) => Promise.resolve(radarFor(id)));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LinkedBlip id="b1" originRadarId="origin" onClose={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  // In parallel: the radar is asked for before the blip has answered.
  expect(radars).toHaveBeenCalledWith('origin');
  await act(async () =>
    land({
      blip: {
        id: 'b1',
        radarId: 'elsewhere',
        kind: 'note',
        title: null,
        body: 'Moved away',
        url: null,
        preview: null,
        state: 'inbox',
        status: null,
        pinned: false,
        tags: [],
        attachments: [],
        commentCount: 0,
        reactions: [],
        author: null,
        agent: null,
        voice: null,
        mentions: [],
        archivedAt: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      } as never,
    }),
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain('This blip is now in'));
  expect(radars).toHaveBeenCalledWith('elsewhere');
  expect(document.body.textContent).toContain('Elsewhere');
  expect(document.querySelector('.modal-head h2')?.textContent).toBe('Blip');
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.restoreAllMocks();
});

it.each([
  { canWrite: false, template: 'kanban' },
  { canWrite: true, template: 'kanban' },
  { canWrite: true, template: 'stream' },
])(
  'preserves linked title and deletion semantics (writer=$canWrite, template=$template)',
  async ({ canWrite, template }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const remove = vi.spyOn(api.blips, 'remove').mockResolvedValue(undefined);
    let land!: (value: Awaited<ReturnType<typeof api.blips.comments>>) => void;
    vi.spyOn(api.blips, 'comments').mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
    const get = vi.spyOn(api.blips, 'get').mockResolvedValue({
      blip: {
        id: 'b1',
        radarId: 'r1',
        kind: 'note',
        title: 'Current linked title',
        body: '# Current linked title\n\nFresh linked content',
        url: null,
        preview: null,
        state: 'active',
        status: 'doing',
        pinned: false,
        tags: [],
        attachments: [],
        commentCount: 0,
        reactions: [],
        author: null,
        agent: null,
        voice: null,
        mentions: [],
        archivedAt: null,
        email: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      } as never,
    });
    vi.spyOn(api.radars, 'get').mockResolvedValue({
      radar: {
        id: 'r1',
        name: 'Current radar',
        template,
        templateConfig: {},
        access: { canWrite },
        commentsEnabled: true,
        reactionsEnabled: false,
      },
    } as never);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <LinkedBlip id="b1" originRadarId="r1" onClose={onClose} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"] [data-blip-id="b1"]')).not.toBeNull(),
    );
    if (template === 'kanban') {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
      await act(async () => land({ items: [], nextCursor: null }));
      await vi.waitFor(() =>
        expect(document.querySelector('textarea[id="comment-b1"]')).not.toBeNull(),
      );
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    }
    if (template === 'kanban') {
      expect(document.querySelector('.modal-head h2')?.textContent).toBe('Current linked title');
      if (!canWrite) {
        expect(document.querySelector('.kanban-detail')?.textContent).not.toContain(
          'Current linked title',
        );
        expect(document.querySelector('[role="dialog"] button[title="Delete"]')).toBeNull();
      }
      expect(
        [
          ...document.querySelectorAll('.kanban-detail h1, .kanban-detail h2, .kanban-detail h3'),
        ].filter((heading) => heading.textContent === 'Current linked title'),
      ).toHaveLength(0);
      expect(document.querySelector('.kanban-detail')?.textContent).toContain(
        'Fresh linked content',
      );
    }
    if (canWrite) {
      const listRead = vi.fn().mockResolvedValue({ items: [] });
      const observer = new QueryObserver(client, {
        queryKey: ['blips', 'r1', {}],
        queryFn: listRead,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      await vi.waitFor(() => expect(listRead).toHaveBeenCalledTimes(1));
      const detailReads = get.mock.calls.length;
      if (template !== 'kanban')
        get.mockRejectedValue(new ApiError(404, 'not_found', 'Blip not found'));
      await act(async () =>
        must(
          document.querySelector<HTMLButtonElement>('[role="dialog"] button[title="Delete"]'),
        ).click(),
      );
      await act(async () =>
        must(
          document.querySelector<HTMLButtonElement>(
            '[role="dialog"][aria-label="Delete this blip?"] .btn-danger',
          ),
        ).click(),
      );
      expect(remove).toHaveBeenCalledWith('b1');
      expect(onClose).toHaveBeenCalledTimes(template === 'kanban' ? 1 : 0);
      await vi.waitFor(() => expect(listRead).toHaveBeenCalledTimes(2));
      if (template === 'kanban') {
        expect(get).toHaveBeenCalledTimes(detailReads);
        expect(document.querySelector('.kanban-detail')).not.toBeNull();
      } else {
        await vi.waitFor(
          () =>
            expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
              'This blip is no longer available',
            ),
          { timeout: 3000 },
        );
        expect(get.mock.calls.length).toBeGreaterThan(detailReads);
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
          'Fresh linked content',
        );
      }
      unsubscribe();
    } else {
      expect(remove).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    vi.restoreAllMocks();
  },
);

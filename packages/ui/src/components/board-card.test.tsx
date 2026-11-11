// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto, CommentDto, RadarDto } from '@onmyradar/contract';
import { api, ApiError } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { BlipCard } from './blips';
import { ToastHost } from './primitives';
import { BoardView } from '../templates/board';
import { LinkedBlip } from './linked-blip';
import { BlipRouteContext, type BlipRoute } from '../lib/blip-route';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const blip = {
  id: 'b1',
  radarId: 'r1',
  kind: 'note',
  title: 'Fix the gate',
  body: 'Fix the gate',
  url: null,
  state: 'active',
  status: 'doing',
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
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
} as unknown as BlipDto;

async function card(
  settings: { commentsEnabled: boolean; reactionsEnabled: boolean },
  template?: RadarDto,
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.blips, 'comments').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <BlipCard
          blip={blip}
          readOnly={false}
          onChanged={vi.fn()}
          conversation={false}
          {...settings}
          {...(template ? { template } : {})}
        />
      </QueryClientProvider>,
    ),
  );
  return host;
}

it('lets a board card be answered when the radar has comments on', async () => {
  const host = await card({ commentsEnabled: true, reactionsEnabled: true });
  const open = must(host.querySelector<HTMLButtonElement>('.card-discuss'), 'the discuss control');
  expect(open.getAttribute('aria-label')).toBe('Comments on Fix the gate, 2');
  await act(async () => open.click());
  const dialog = must(document.querySelector('[role=dialog]'), 'the thread dialog');
  expect(dialog.getAttribute('aria-label')).toBe('Fix the gate');
  await vi.waitFor(() => expect(dialog.querySelector('.comment-thread')).not.toBeNull());
  // Opened to reply, so the box is where the keyboard is.
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('comment-b1'));
});

it('offers nothing to open when the radar has both switched off', async () => {
  const host = await card({ commentsEnabled: false, reactionsEnabled: false });
  expect(host.querySelector('.card-discuss')).toBeNull();
});

it('keeps the line breaks a comment was written with', async () => {
  const host = await card({ commentsEnabled: true, reactionsEnabled: true });
  vi.mocked(api.blips.comments).mockResolvedValue({
    items: [
      {
        id: 'c1',
        blipId: 'b1',
        radarId: 'r1',
        body: 'one\ntwo\nthree',
        parentId: null,
        author: { id: 'u1', name: 'Lucas', email: 'lucas@example.com' },
        agent: null,
        voice: null,
        canDelete: true,
        visibility: 'internal',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    ],
    nextCursor: null,
  });
  await act(async () => must(host.querySelector<HTMLButtonElement>('.card-discuss')).click());
  const body = await vi.waitFor(() => must(document.querySelector('.comment-body')));
  expect(body.querySelectorAll('br')).toHaveLength(2);
  expect(body.textContent).toBe('onetwothree');
});

it('puts focus back on the card that was edited, not the page title', async () => {
  const host = await card({ commentsEnabled: false, reactionsEnabled: false });
  vi.spyOn(api.blips, 'update').mockResolvedValue({ blip });
  const edit = must(host.querySelector<HTMLButtonElement>('[aria-label="Edit Fix the gate"]'));
  await act(async () => edit.click());
  const box = must(host.querySelector('textarea'), 'the editor');
  await act(async () => {
    setNativeValue(box, 'Fix the gate today');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = must(
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent.trim() === 'Save',
    ),
  );
  save.focus();
  await act(async () => save.click());
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit Fix the gate'),
  );
});

async function board(options: { readOnly?: boolean; template?: 'kanban' | 'helpdesk' } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(api.blips, 'comments').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
  const radar = {
    id: 'r1',
    template: options.template ?? 'kanban',
    templateConfig: {},
    commentsEnabled: true,
    reactionsEnabled: false,
  } as unknown as RadarDto;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const changed = vi.fn();
  const render = async (items: BlipDto[], route: BlipRoute | null = null) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={query}>
          <BlipRouteContext.Provider value={route}>
            <BoardView
              radar={radar}
              blips={items}
              readOnly={options.readOnly ?? false}
              loading={false}
              loadingMore={false}
              hasMore={false}
              onLoadMore={vi.fn()}
              onChanged={changed}
              emptyTitle="Empty"
              emptyHint="Capture a card"
            />
          </BlipRouteContext.Provider>
        </QueryClientProvider>,
      ),
    );
  };
  await render([{ ...blip, status: options.template === 'helpdesk' ? 'new' : 'backlog' }]);
  return { host, render, changed };
}

it.each(['kanban', 'helpdesk'] as const)(
  'opens %s body details even without a comment-count activation and retains comments while editing',
  async (template) => {
    const { host } = await board({ template });
    await act(async () => must(host.querySelector<HTMLElement>('.blip-body')).click());
    const dialog = must(document.querySelector('[role="dialog"]'));
    expect(dialog.getAttribute('aria-label')).toBe('Fix the gate');
    await vi.waitFor(() => expect(dialog.querySelector('.comment-thread')).not.toBeNull());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    await act(async () =>
      must(dialog.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
    );
    expect(dialog.querySelector('textarea[id="body-b1"]')).not.toBeNull();
    expect(dialog.querySelector('.comment-thread')).not.toBeNull();
  },
);

it('keeps read popup focus at its header when delayed comments mount the composer', async () => {
  const { host } = await board();
  let land!: (value: Awaited<ReturnType<typeof api.blips.comments>>) => void;
  vi.mocked(api.blips.comments).mockImplementation(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  await act(async () => land({ items: [], nextCursor: null }));
  await vi.waitFor(() =>
    expect(document.querySelector('textarea[id="comment-b1"]')).not.toBeNull(),
  );
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  expect(document.querySelector('.comment-thread')).not.toBeNull();
});

it('keeps the compact Kanban email subject reader independent of the whole-card popup', async () => {
  const { host, render } = await board();
  const email = {
    subject: 'Fix the gate',
    senderName: 'Sender',
    senderAddress: 'sender@example.test',
    sentAt: null,
    receivedAt: blip.createdAt,
    preview: 'A compact email preview',
    hasHtml: false,
    legacy: false,
    notes: 'A long note '.repeat(100),
    attachmentCount: 0,
  };
  const read = vi.spyOn(api.blips, 'email').mockResolvedValue({
    email: {
      ...email,
      text: 'Original email message',
      html: null,
      attachments: [],
      imageOrigins: [],
      originalHref: null,
      remoteImagesBlocked: 0,
    },
  });
  await render([{ ...blip, status: 'backlog', email }]);
  expect(host.querySelector('.email-card.is-compact')).not.toBeNull();
  await act(async () => must(host.querySelector<HTMLButtonElement>('.email-card-subject')).click());
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith('b1', false));
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await vi.waitFor(() =>
    expect(document.querySelector('.email-reader-text')?.textContent).toBe(
      'Original email message',
    ),
  );
  await act(async () =>
    must(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')).click(),
  );
  await act(async () => must(host.querySelector<HTMLElement>('.board-card')).click());
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
    'Fix the gate',
  );
  expect(document.querySelector('.comment-thread')).not.toBeNull();
});

it('routes the Kanban pencil into the popup and keeps failed saves retryable without dropping the conversation', async () => {
  const { host } = await board();
  const update = vi
    .spyOn(api.blips, 'update')
    .mockRejectedValue(new ApiError(409, 'conflict', 'Please retry'));
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
  );
  const dialog = must(document.querySelector('[role="dialog"]'));
  const box = must(dialog.querySelector<HTMLTextAreaElement>('textarea[id="body-b1"]'));
  await act(async () => {
    setNativeValue(box, 'A changed draft');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = must(
    [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent.trim() === 'Save',
    ),
  );
  await act(async () => save.click());
  expect(update).toHaveBeenCalledWith('b1', { body: 'A changed draft', title: 'Fix the gate' });
  expect(box.value).toBe('A changed draft');
  expect(save.disabled).toBe(false);
  expect(dialog.querySelector('.comment-thread')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
});

it('places the Kanban toolbar after its compact summary while retaining inline comments and all controls', async () => {
  const { host } = await board();
  const card = must(host.querySelector('.kanban-compact'));
  const metadata = must(card.querySelector('.blip-meta'));
  const actions = must(card.querySelector('.kanban-card-actions'));
  const summary = must(card.querySelector('.blip-body'));
  expect(metadata.querySelector('.card-discuss')).not.toBeNull();
  expect(metadata.contains(actions)).toBe(false);
  expect(summary.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(actions.querySelector('[aria-label="Lane for Fix the gate"]')).not.toBeNull();
  expect(actions.querySelector('button[title="Edit"]')).not.toBeNull();
  expect(actions.querySelector('button[title="Delete"]')).not.toBeNull();
});

it('makes the visible Due label clickable in keyboard-aligned Kanban toolbar order', async () => {
  const { host } = await board();
  await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
  const parent = must(document.querySelector('[role="dialog"]'));
  const toolbar = must(parent.querySelector('.kanban-detail-actions'));
  const due = must(toolbar.querySelector<HTMLButtonElement>('[aria-label="Set due date"]'));
  expect(due.textContent).toBe('Due');
  const controls = [...toolbar.querySelectorAll('button')];
  expect(controls[0]?.getAttribute('aria-label')).toBe('Lane for Fix the gate');
  expect(controls[1]?.getAttribute('title')).toBe('Edit');
  expect(controls[2]).toBe(due);
  await act(async () => must(due.querySelector<HTMLElement>('span')).click());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  expect(parent.isConnected).toBe(true);
  await act(async () =>
    must([...document.querySelectorAll<HTMLButtonElement>('[aria-label="Close"]')].at(-1)).click(),
  );
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(parent.isConnected).toBe(true);
});

it('gives Kanban details one title and one searchable copy of inline tags without rewriting data', async () => {
  const { host, render } = await board();
  const item = {
    ...blip,
    status: 'backlog',
    body: '# Fix the gate\n\nRead #bug and `#code`.',
    tags: ['bug', 'code', 'manual'],
  };
  await render([item]);
  await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
  const dialog = must(document.querySelector('[role="dialog"]'));
  expect(dialog.querySelector('.modal-head h2')?.textContent).toBe('Fix the gate');
  expect(dialog.querySelector('.kanban-detail h3')?.textContent).toBe('Comments');
  expect(dialog.querySelectorAll('a[href="/t/bug"]')).toHaveLength(1);
  expect([...dialog.querySelectorAll('.blip-tags a')].map((node) => node.textContent)).toEqual([
    '#code',
    '#manual',
  ]);
  expect(dialog.querySelector('button[title="Edit"]')?.textContent).toBe('Edit');
  expect(item.body).toBe('# Fix the gate\n\nRead #bug and `#code`.');
  expect(item.tags).toEqual(['bug', 'code', 'manual']);
});

it('gives Helpdesk cards the shared compact metadata and separate action row', async () => {
  const { host, render } = await board({ template: 'helpdesk' });
  await render([{ ...blip, status: 'new', body: 'Read #bug.', tags: ['bug'] }]);
  expect(host.querySelector('.kanban-detail')).toBeNull();
  expect(host.querySelector('h3')?.textContent).toBe('Fix the gate');
  expect(host.querySelector('.blip-tags')?.textContent).toBe('#bug');
  expect(host.querySelector('button[title="Edit"]')?.textContent).toBe('');
  expect(host.querySelector('.blip-meta .blip-actions')).toBeNull();
  expect(host.querySelector('.kanban-card-actions')).not.toBeNull();
});

it.each(['kanban', 'helpdesk'] as const)(
  '%s closes only after its own successful deletion, preserving cancelled and failed editor attempts',
  async (template) => {
    const { host } = await board({ template });
    const toastHost = document.createElement('div');
    document.body.append(toastHost);
    const toastRoot = createRoot(toastHost);
    roots.push(toastRoot);
    await act(async () => toastRoot.render(<ToastHost />));
    const remove = vi
      .spyOn(api.blips, 'remove')
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'Cannot delete now'))
      .mockResolvedValue(undefined);
    await act(async () =>
      must(host.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
    );
    const parent = must(document.querySelector('[role="dialog"]'));
    const press = async (label: string) => {
      await act(async () =>
        must(
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              '[role="dialog"][aria-label="Delete this blip?"] button',
            ),
          ].find((button) => button.textContent.trim() === label),
        ).click(),
      );
    };
    await act(async () =>
      must(parent.querySelector<HTMLButtonElement>('button[title="Delete"]')).click(),
    );
    await press('Cancel');
    expect(remove).not.toHaveBeenCalled();
    expect(parent.isConnected).toBe(true);
    expect(parent.querySelector('textarea[id="body-b1"]')).not.toBeNull();
    await act(async () =>
      must(parent.querySelector<HTMLButtonElement>('button[title="Delete"]')).click(),
    );
    await press('Delete blip');
    expect(parent.isConnected).toBe(true);
    await vi.waitFor(() =>
      expect(document.querySelector('.toast-host [role="alert"]')?.textContent).toContain(
        'Cannot delete now',
      ),
    );
    expect(parent.querySelector('textarea[id="body-b1"]')).not.toBeNull();
    await act(async () =>
      must(parent.querySelector<HTMLButtonElement>('button[title="Delete"]')).click(),
    );
    await press('Delete blip');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenLastCalledWith('b1');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);

it('closes a card-owned nested Kanban reader after its own successful deletion', async () => {
  const remove = vi.spyOn(api.blips, 'remove').mockResolvedValue(undefined);
  const host = await card({ commentsEnabled: true, reactionsEnabled: false }, {
    id: 'r1',
    template: 'kanban',
    templateConfig: {},
    commentsEnabled: true,
    reactionsEnabled: false,
  } as unknown as RadarDto);
  await act(async () => must(host.querySelector<HTMLButtonElement>('.card-discuss')).click());
  const parent = must(document.querySelector('[role="dialog"]'));
  await act(async () =>
    must(parent.querySelector<HTMLButtonElement>('button[title="Delete"]')).click(),
  );
  await act(async () =>
    must(
      document.querySelector<HTMLButtonElement>(
        '[role="dialog"][aria-label="Delete this blip?"] .btn-danger',
      ),
    ).click(),
  );
  expect(remove).toHaveBeenCalledWith('b1');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps a reused card nested reader open when its previous deletion completes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.blips, 'comments').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
  let finish!: () => void;
  vi.spyOn(api.blips, 'remove').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const client = new QueryClient();
  const template = {
    id: 'r1',
    template: 'kanban',
    templateConfig: {},
    commentsEnabled: true,
    reactionsEnabled: false,
  } as unknown as RadarDto;
  const render = async (item: BlipDto) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BlipCard
            blip={item}
            readOnly={false}
            onChanged={vi.fn()}
            conversation={false}
            commentsEnabled
            reactionsEnabled={false}
            template={template}
          />
        </QueryClientProvider>,
      ),
    );
  };
  await render(blip);
  await act(async () => must(host.querySelector<HTMLButtonElement>('.card-discuss')).click());
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
  await act(async () =>
    must(document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')).click(),
  );
  await render({ ...blip, id: 'b2', title: 'Other card' });
  await act(async () => must(host.querySelector<HTMLButtonElement>('.card-discuss')).click());
  await act(async () => finish());
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Other card');
});

it('does not close a newly opened card when a previous own deletion finishes later', async () => {
  const { host, render } = await board();
  await render([
    { ...blip, status: 'backlog' },
    { ...blip, id: 'b2', status: 'backlog', title: 'Other card' },
  ]);
  let finish!: () => void;
  vi.spyOn(api.blips, 'remove').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('[data-blip-id="b1"] [data-open-blip]')).click(),
  );
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
  await act(async () =>
    must(document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')).click(),
  );
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('[data-blip-id="b2"] [data-open-blip]')).click(),
  );
  await act(async () => finish());
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Other card');
});

it('keeps external deletion truthful rather than closing an unrelated read popup', async () => {
  const { host, render } = await board();
  await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
  const parent = must(document.querySelector('[role="dialog"]'));
  await render([]);
  expect(parent.isConnected).toBe(true);
  expect(parent.textContent).toContain('This blip is no longer available');
});

it('keeps popup identity and refreshed contents when a card moves to another lane', async () => {
  const { host, render } = await board();
  await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
  const dialog = must(document.querySelector('[role="dialog"]'));
  await render([{ ...blip, status: 'doing', body: 'Saved after the move', title: 'Moved card' }]);
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(dialog.getAttribute('aria-label')).toBe('Moved card');
  expect(dialog.textContent).toContain('Saved after the move');
  await act(async () =>
    must(dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')).click(),
  );
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open Moved card'),
  );
});

it('shows the questions put to the person in a card opened from the board', async () => {
  const list = vi.spyOn(api.decisions, 'list').mockResolvedValue({
    requests: [
      {
        id: 'q1',
        blipId: 'b1',
        radarId: 'r1',
        context: 'Needs a vendor today',
        question: 'Which vendor?',
        options: [],
        decides: false,
        status: 'open',
        answer: null,
        answeredAt: null,
        requestedBy: 'Lulu',
        createdAt: '2026-09-01T00:00:00Z',
        canAnswer: true,
      },
    ],
  });
  const { host } = await board();
  await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
  const dialog = must(document.querySelector('[role="dialog"]'));
  await vi.waitFor(() =>
    expect(dialog.querySelector('.decision-context')?.textContent).toBe('Needs a vendor today'),
  );
  expect(list).toHaveBeenCalledWith('b1');
});

it('cancels editor Escape within the popup, then closes with a second Escape and returns focus', async () => {
  const { host } = await board();
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
  );
  const dialog = must(document.querySelector('[role="dialog"]'));
  const box = must(dialog.querySelector<HTMLTextAreaElement>('textarea[id="body-b1"]'));
  await act(async () =>
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(dialog.querySelector('textarea[id="body-b1"]')).toBeNull();
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open Fix the gate'),
  );
});

it.each(['kanban', 'helpdesk'] as const)(
  '%s keeps nested pin controls, selected text and a completed drag out of card activation',
  async (template) => {
    const { host } = await board({ template });
    const update = vi.spyOn(api.blips, 'update').mockResolvedValue({ blip });
    await act(async () =>
      must(host.querySelector<HTMLButtonElement>('button[title="Pin to the top"]')).click(),
    );
    expect(update).toHaveBeenCalledWith('b1', { pinned: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'selected thought' } as unknown as Selection);
    await act(async () => must(host.querySelector<HTMLElement>('.blip-body')).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    selection.mockReturnValue(null);
    const outer = must(host.querySelector('.board-card'));
    const start = new Event('dragstart', { bubbles: true });
    Object.defineProperty(start, 'dataTransfer', {
      value: { effectAllowed: '', setData: vi.fn() },
    });
    await act(async () => {
      outer.dispatchEvent(start);
      outer.dispatchEvent(new Event('dragend', { bubbles: true }));
      must(host.querySelector<HTMLElement>('.blip-body')).click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);

it.each(['kanban', 'helpdesk'] as const)(
  'allows read-only %s details without exposing editor or lane mutation controls',
  async (template) => {
    const { host } = await board({ template, readOnly: true });
    await act(async () => must(host.querySelector<HTMLButtonElement>('[data-open-blip]')).click());
    const dialog = must(document.querySelector('[role="dialog"]'));
    expect(dialog.querySelector('button[title="Edit"]')).toBeNull();
    expect(dialog.querySelector('textarea[id="body-b1"]')).toBeNull();
    expect(dialog.querySelector('[id="state-b1"]')).toBeNull();
  },
);

it('opens Helpdesk pencil editing in the full reader with its conversation', async () => {
  const { host } = await board({ template: 'helpdesk' });
  expect(host.querySelector('[data-open-blip]')).not.toBeNull();
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
  );
  const dialog = must(document.querySelector('[role="dialog"]'));
  expect(dialog.classList.contains('max-w-6xl')).toBe(true);
  expect(dialog.querySelector('textarea[id="body-b1"]')).not.toBeNull();
  expect(dialog.querySelector('.comment-thread')).not.toBeNull();
  expect(host.querySelector('textarea[id="body-b1"]')).toBeNull();
});

it.each(['kanban', 'helpdesk'] as const)(
  'keeps a long %s preview compact but opens the entire body and file links in wide details',
  async (template) => {
    const { host, render } = await board({ template });
    const ending = 'THE FULL BODY END';
    const longBody = `${'Long prose with **markdown**. '.repeat(80)}${ending}`;
    await render([
      {
        ...blip,
        status: template === 'helpdesk' ? 'new' : 'backlog',
        body: longBody,
        attachments: [
          {
            id: 'a1',
            filename: 'notes.txt',
            contentType: 'text/plain',
            size: 30,
            href: '/files/notes.txt',
            width: null,
            height: null,
          },
        ],
      },
    ]);
    const preview = must(host.querySelector('.blip-body'));
    expect(preview.textContent).not.toContain(ending);
    expect(preview.classList.contains('line-clamp-4')).toBe(true);
    expect(host.textContent).toContain('1 attachment');
    expect(host.querySelector('a[href="/files/notes.txt?download=1"]')).toBeNull();
    await act(async () => must(host.querySelector<HTMLElement>('.board-card')).click());
    const dialog = must(document.querySelector('[role="dialog"]'));
    expect(dialog.classList.contains('max-w-6xl')).toBe(true);
    expect(dialog.classList.contains('is-reader')).toBe(false);
    expect(dialog.querySelector('.blip-body')?.textContent).toContain(ending);
    expect(dialog.querySelector('.blip-body')?.classList.contains('line-clamp-4')).toBe(false);
    expect(dialog.querySelector('a[href="/files/notes.txt?download=1"]')).not.toBeNull();
  },
);

it.each(['kanban', 'helpdesk'] as const)(
  '%s resets drag exclusion on the next pointer press so the following plain card click opens',
  async (template) => {
    const { host } = await board({ template });
    const outer = must(host.querySelector('.board-card'));
    const start = new Event('dragstart', { bubbles: true });
    Object.defineProperty(start, 'dataTransfer', {
      value: { effectAllowed: '', setData: vi.fn() },
    });
    await act(async () => {
      outer.dispatchEvent(start);
      outer.dispatchEvent(new Event('dragend', { bubbles: true }));
      outer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      outer.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
      );
      outer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  },
);

it.each(['kanban', 'helpdesk'] as const)(
  'uses full %s details for a fresh notification target and retains comments while editing',
  async (template) => {
    await board({ template });
    const longBody = `${'Full notification body. '.repeat(80)}NOTIFICATION END`;
    vi.spyOn(api.blips, 'get').mockResolvedValue({ blip: { ...blip, body: longBody } });
    vi.spyOn(api.radars, 'get').mockResolvedValue({
      radar: {
        id: 'r1',
        name: 'Current Kanban',
        template,
        templateConfig: {},
        commentsEnabled: true,
        reactionsEnabled: false,
        access: { canWrite: true },
      } as unknown as RadarDto,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () =>
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <LinkedBlip id="b1" originRadarId="r1" onClose={vi.fn()} />
        </QueryClientProvider>,
      ),
    );
    const dialog = await vi.waitFor(() => {
      const found = must(document.querySelector('[role="dialog"]'));
      expect(found.textContent).toContain('NOTIFICATION END');
      return found;
    });
    expect(dialog.classList.contains('max-w-6xl')).toBe(true);
    expect(dialog.classList.contains('is-reader')).toBe(false);
    await act(async () =>
      must(dialog.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
    );
    expect(must(dialog.querySelector<HTMLTextAreaElement>('textarea[id="body-b1"]')).value).toBe(
      longBody,
    );
    expect(dialog.querySelector('.comment-thread')).not.toBeNull();
  },
);

it('retains Helpdesk requester and outward moderation states in the full editor conversation', async () => {
  const { host, render } = await board({ template: 'helpdesk' });
  const comments: CommentDto[] = ['internal', 'client', 'client_pending'].map(
    (visibility, index) => ({
      id: `c${index}`,
      blipId: 'b1',
      radarId: 'r1',
      parentId: null,
      body: `Synthetic ${visibility} comment`,
      author: null,
      agent: null,
      voice: null,
      canDelete: false,
      visibility:
        visibility === 'client'
          ? 'client'
          : visibility === 'client_pending'
            ? 'client_pending'
            : 'internal',
      ...(visibility === 'client_pending' ? { canRelease: true, bodySha256: 'a'.repeat(64) } : {}),
      createdAt: blip.createdAt,
      updatedAt: blip.updatedAt,
    }),
  );
  vi.mocked(api.blips.comments).mockResolvedValue({ items: comments, nextCursor: null });
  await render([
    {
      ...blip,
      status: 'new',
      external: { via: 'portal', requesterName: 'Pat Client' },
      awaitingClientSince: blip.createdAt,
    },
  ]);
  expect(host.querySelector('[data-facet="awaiting-client"]')?.textContent).toContain(
    'waiting on client',
  );
  expect(host.querySelector('.blip-meta [data-facet="awaiting-client"]')).toBeNull();
  expect(host.querySelector('[data-facet="requester"]')?.textContent).toBe(
    'from Pat Client · via portal',
  );
  await act(async () => must(host.querySelector<HTMLElement>('.blip-body')).click());
  const dialog = must(document.querySelector('[role="dialog"]'));
  await vi.waitFor(() => expect(dialog.querySelectorAll('li.comment')).toHaveLength(3));
  expect(dialog.querySelector('[data-facet="requester"]')?.textContent).toBe(
    'from Pat Client · via portal',
  );
  expect([...dialog.querySelectorAll('.visibility-tag')].map((tag) => tag.textContent)).toEqual([
    'to client',
    'draft · awaiting review',
  ]);
  expect(
    dialog.querySelector('li.comment:not(.is-client):not(.is-pending) .visibility-tag'),
  ).toBeNull();
  expect(
    [...dialog.querySelectorAll('.release-bar button')].map((button) => button.textContent),
  ).toEqual(['Discard', 'Release to client']);
  await act(async () =>
    must(dialog.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
  );
  expect(dialog.querySelector('textarea[id="body-b1"]')).not.toBeNull();
  expect(dialog.querySelectorAll('li.comment')).toHaveLength(3);
  expect(dialog.querySelectorAll('.release-bar button')).toHaveLength(2);
});

it('gives a card opened on a radar its own address, and closes when the address goes', async () => {
  const { host, render } = await board();
  const items = [{ ...blip, status: 'backlog' }] as BlipDto[];
  const route = { openId: null, open: vi.fn(() => true), close: vi.fn() };
  await render(items, route);
  await act(async () => must(host.querySelector<HTMLElement>('.blip-body')).click());
  expect(route.open).toHaveBeenCalledWith('b1');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  // The address arrives, then Back takes it away: the card closes without a second close().
  await render(items, { ...route, openId: 'b1' });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await render(items, { ...route, openId: null });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(route.close).not.toHaveBeenCalled();
});

it('returns to the radar address when the card is closed', async () => {
  const { host, render } = await board();
  const items = [{ ...blip, status: 'backlog' }] as BlipDto[];
  const route = { openId: 'b1', open: vi.fn(() => true), close: vi.fn() };
  await render(items, { ...route, openId: null });
  await act(async () => must(host.querySelector<HTMLElement>('.blip-body')).click());
  await render(items, route);
  await act(async () =>
    must(document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')).click(),
  );
  expect(route.close).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

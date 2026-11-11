// @vitest-environment jsdom
/**
 * The helpdesk side of the conversation (docs/HELPDESK.md §7): the composer
 * says which of the two a reply goes out as before it is sent, defaults to the
 * internal note every time, and the owner reviews a draft by the hash of the
 * words on screen. Off a helpdesk none of it exists.
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto, CommentDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { Conversation } from './conversation';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const blip = {
  id: 'b1',
  radarId: 'r1',
  kind: 'note',
  title: 'Contact form sends twice',
  body: 'Contact form sends twice',
  url: null,
  state: 'inbox',
  status: 'new',
  pinned: false,
  tags: [],
  attachments: [],
  commentCount: 3,
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
} as unknown as BlipDto;

function comment(over: Partial<CommentDto>): CommentDto {
  return {
    id: 'c',
    blipId: 'b1',
    radarId: 'r1',
    body: 'words',
    parentId: null,
    author: { id: 'u1', name: 'Lucas', email: 'lucas@example.com' },
    agent: null,
    voice: null,
    canDelete: true,
    visibility: 'internal',
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...over,
  };
}

const THREAD: CommentDto[] = [
  comment({ id: 'note', body: 'Client is slow to pay' }),
  comment({
    id: 'draft',
    body: 'We will fix it today.',
    visibility: 'client_pending',
    bodySha256: 'a'.repeat(64),
    canRelease: true,
  }),
  comment({
    id: 'sent',
    body: 'Fixed.',
    visibility: 'client',
    releasedAt: '2026-10-02T01:00:00Z',
  }),
];

function type(field: HTMLTextAreaElement, value: string) {
  setNativeValue(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(template: string, items: CommentDto[], ownsRadar = true) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.blips, 'comments').mockResolvedValue({ items, nextCursor: null });
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Conversation
          blip={blip}
          template={template}
          commentsEnabled
          reactionsEnabled={false}
          startOpen
          ownsRadar={ownsRadar}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.querySelector('.comment-thread')).not.toBeNull());
  return host;
}

it('labels the two outward states and leaves an internal note unmarked', async () => {
  const host = await mount('helpdesk', THREAD);
  await vi.waitFor(() => expect(host.querySelectorAll('li.comment')).toHaveLength(3));
  const rows = [...host.querySelectorAll<HTMLLIElement>('li.comment')];
  expect(rows[0]?.className).not.toMatch(/is-client|is-pending/);
  expect(rows[0]?.querySelector('.visibility-tag')).toBeNull();
  expect(rows[1]?.className).toMatch(/is-pending/);
  expect(rows[1]?.querySelector('.visibility-tag')?.textContent).toBe('draft · awaiting review');
  expect(rows[2]?.className).toMatch(/is-client/);
  expect(rows[2]?.querySelector('.visibility-tag')?.textContent).toBe('to client');
});

it('releases a draft by the hash of the words on screen', async () => {
  const release = vi
    .spyOn(api.comments, 'release')
    .mockResolvedValue({ comment: comment({ id: 'draft', visibility: 'client' }) });
  const host = await mount('helpdesk', THREAD);
  const button = await vi.waitFor(() =>
    must(
      [...host.querySelectorAll<HTMLButtonElement>('.release-bar button')].find(
        (b) => b.textContent === 'Release to client',
      ),
      'the release button',
    ),
  );
  await act(async () => button.click());
  expect(release).toHaveBeenCalledWith('draft', 'a'.repeat(64));
});

it('offers no release where the server says this viewer cannot', async () => {
  const host = await mount('helpdesk', [
    comment({
      id: 'draft',
      visibility: 'client_pending',
      bodySha256: 'b'.repeat(64),
      canRelease: false,
    }),
  ]);
  await vi.waitFor(() => expect(host.querySelector('li.comment.is-pending')).not.toBeNull());
  expect(host.querySelector('.release-bar')).toBeNull();
});

it('defaults the composer to an internal note, sends client only when chosen, and resets after', async () => {
  const post = vi
    .spyOn(api.blips, 'comment')
    .mockResolvedValue({ comment: comment({ id: 'new', visibility: 'client_pending' }) });
  const host = await mount('helpdesk', [], false);
  const radios = [...host.querySelectorAll<HTMLButtonElement>('.composer-visibility [role=radio]')];
  expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
    ['internal note', 'true'],
    ['reply to client', 'false'],
  ]);
  const input = must(host.querySelector<HTMLTextAreaElement>('#comment-b1'), 'the box');
  const send = must(host.querySelector<HTMLButtonElement>('[aria-label^="Post"]'), 'send');

  await act(async () => type(input, 'A note'));
  await act(async () => send.click());
  expect(post).toHaveBeenLastCalledWith('b1', 'A note', undefined, 'internal');

  await act(async () => radios[1]?.click());
  // Not the owner: told it goes for review before anything is sent.
  expect(host.querySelector('.composer-visibility-hint')?.textContent).toMatch(/for review/);
  await act(async () => type(input, 'Dear client'));
  await act(async () => send.click());
  expect(post).toHaveBeenLastCalledWith('b1', 'Dear client', undefined, 'client');
  await vi.waitFor(() =>
    expect(host.querySelector('.composer-visibility [aria-checked=true]')?.textContent).toBe(
      'internal note',
    ),
  );
});

it('has no visibility switch off a helpdesk', async () => {
  const post = vi
    .spyOn(api.blips, 'comment')
    .mockResolvedValue({ comment: comment({ id: 'new' }) });
  const host = await mount('kanban', []);
  expect(host.querySelector('.composer-visibility')).toBeNull();
  const input = must(host.querySelector<HTMLTextAreaElement>('#comment-b1'), 'the box');
  await act(async () => type(input, 'plain'));
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('[aria-label^="Post"]'), 'send').click(),
  );
  expect(post).toHaveBeenLastCalledWith('b1', 'plain', undefined, undefined);
});

it("labels a client's own reply as the client's, by the name the portal gave, not an account", async () => {
  const host = await mount('helpdesk', [
    comment({
      id: 'client',
      body: 'Still broken on Safari',
      author: null,
      visibility: 'client',
      external: { via: 'portal', requesterName: 'Pat Client' },
    }),
  ]);
  const row = await vi.waitFor(() =>
    must(host.querySelector<HTMLLIElement>('li.comment'), 'the client reply'),
  );
  expect(row.querySelector('[data-external="portal"]')?.textContent).toBe('Pat Client');
  expect(row.querySelector('.visibility-tag')?.textContent).toBe('client · via portal');
  expect(row.textContent).not.toContain('someone');
});

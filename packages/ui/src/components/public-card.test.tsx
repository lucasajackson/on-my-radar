// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentDto, BlipDto } from '@onmyradar/contract';
import { BlipCard } from './blips';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

const agent = { id: 'a1', name: 'lulu', owner: null, viewable: false, retired: false } as AgentDto;
const base = {
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
  commentCount: 0,
  reactions: [],
  author: { id: 'u1', name: 'Lucas', email: 'lucas@example.com' },
  agent,
  voice: 'persona',
  mentions: [],
  email: null,
  dueAt: null,
  reminder: null,
  archivedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
} as unknown as BlipDto;

async function card(blip: BlipDto, publicSlug?: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <BlipCard
          blip={blip}
          readOnly
          onChanged={vi.fn()}
          conversation={false}
          commentsEnabled
          reactionsEnabled
          {...(publicSlug ? { publicSlug } : {})}
        />
      </QueryClientProvider>,
    ),
  );
  return host;
}

it('shows a public card the name it leads with, with no cosign', async () => {
  const host = await card(base, 'open-board');
  expect(host.querySelector('.byline')?.textContent).toBe('lulu');
  expect(host.textContent).not.toContain('cosigned');
  expect(host.querySelector('.byline-card')).toBeNull();
});

it('drops the comment icon from a public card with no comments, and keeps it with some', async () => {
  expect((await card(base, 'open-board')).querySelector('.card-discuss')).toBeNull();
  const some = { ...base, commentCount: 3 };
  expect((await card(some, 'open-board')).querySelector('.card-discuss')?.textContent).toBe('3');
});

it('leaves a signed-in card as it was: cosign and comment icon both present', async () => {
  const host = await card(base);
  expect(host.textContent).toContain('cosigned by');
  expect(host.querySelector('.card-discuss')).not.toBeNull();
});

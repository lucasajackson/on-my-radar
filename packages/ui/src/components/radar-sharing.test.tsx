// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemberDto, RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { SharePanel } from './radar-sharing';
import { useMentionCandidates } from './mention-input';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const member = (userId: string, email: string, role: MemberDto['role']): MemberDto => ({
  userId,
  email,
  name: null,
  role,
  pending: false,
  via: role === 'owner' ? 'owner' : 'member',
  viaTopic: null,
  createdAt: '2026-09-01T00:00:00Z',
});

it('makes a person just shared with someone the composer can @mention straight away', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const owner = member('u1', 'lucas@example.com', 'owner');
  const ada = member('u2', 'ada@example.com', 'viewer');
  let shared = false;
  vi.spyOn(api.radars, 'members').mockImplementation(async () => ({
    members: shared ? [owner, ada] : [owner],
    agents: [],
  }));
  vi.spyOn(api.radars, 'share').mockImplementation(async () => {
    shared = true;
    return {
      share: { status: 'shared', email: ada.email, approved: false, inviteUrl: null },
    };
  });

  // Just enough of a radar for the panel; the fields it reads are real.
  const radar = {
    id: 'r1',
    isDropBox: false,
    visibility: 'private',
    publicSlug: null,
    allowIndex: false,
    updatedAt: '2026-09-01T00:00:00Z',
    access: { canWrite: true, canManage: true },
  } as unknown as RadarDto;

  let handles: string[] = [];
  function Composer() {
    handles = useMentionCandidates('r1').map((candidate) => candidate.handle);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Composer />
        <SharePanel radar={radar} onChanged={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(handles).toEqual(['lucas']));

  const input = host.querySelector<HTMLInputElement>('input[type=email]');
  await act(async () => {
    if (!input) return;
    // The native setter, so React's value tracker sees a real change.
    Reflect.set(HTMLInputElement.prototype, 'value', ada.email, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const share = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === 'Share',
  );
  await act(async () => share?.click());

  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(handles).toEqual(['lucas', 'ada']);
  });
  await act(async () => root.unmount());
});

it('warns that a helpdesk shows members every internal note, keeps sharing, and offers no public link', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const owner = member('u1', 'lucas@example.com', 'owner');
  const andrea = member('u3', 'andrea@example.com', 'editor');
  vi.spyOn(api.radars, 'members').mockImplementation(async () => ({
    members: [owner, andrea],
    agents: [],
  }));
  const render = async (template: string, neverPublic = template === 'helpdesk') => {
    const radar = {
      id: `r-${template}-${String(neverPublic)}`,
      template,
      neverPublic,
      isDropBox: false,
      visibility: 'private',
      publicSlug: null,
      allowIndex: false,
      updatedAt: '2026-09-01T00:00:00Z',
      access: { canWrite: true, canManage: true },
    } as unknown as RadarDto;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SharePanel radar={radar} onChanged={vi.fn()} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(host.textContent).toContain('andrea@example.com'));
    return { host, root };
  };

  const helpdesk = await render('helpdesk');
  const warning = helpdesk.host.querySelector('[data-testid="helpdesk-share-warning"]');
  expect(warning?.textContent).toMatch(/every internal note/);
  expect(warning?.textContent).toMatch(/never with the client/);
  // Sharing stays: the existing collaborator is listed and the share box is there.
  expect(helpdesk.host.querySelector('input[type=email]')).not.toBeNull();
  // No public link, not even a refused one.
  const labels = Array.from(helpdesk.host.querySelectorAll('button')).map((b) => b.textContent);
  expect(labels.some((label) => label.includes('Publish'))).toBe(false);
  expect(helpdesk.host.textContent).toMatch(/has no public link/);
  await act(async () => helpdesk.root.unmount());

  // Positive control: an ordinary board still offers Publish and no warning.
  const board = await render('kanban');
  expect(board.host.querySelector('[data-testid="helpdesk-share-warning"]')).toBeNull();
  const boardLabels = Array.from(board.host.querySelectorAll('button')).map((b) => b.textContent);
  expect(boardLabels.some((label) => label.includes('Publish'))).toBe(true);
  await act(async () => board.root.unmount());

  // A board that was a helpdesk keeps both rules: it still holds the notes.
  const former = await render('kanban', true);
  expect(former.host.querySelector('[data-testid="helpdesk-share-warning"]')).not.toBeNull();
  const formerLabels = Array.from(former.host.querySelectorAll('button')).map((b) => b.textContent);
  expect(formerLabels.some((label) => label.includes('Publish'))).toBe(false);
  expect(former.host.textContent).toMatch(/was a helpdesk has no public link/);
  await act(async () => former.root.unmount());
});

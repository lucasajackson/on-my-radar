// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { CHARTER_DRAFTS, forgetDrafts, readDraft, writeDraft } from './drafts';
import { queryKeys, SessionProvider } from './session';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

async function session(user: { id: string } | null, client: QueryClient) {
  vi.spyOn(api.auth, 'session').mockResolvedValue({ user } as never);
  await act(async () => client.invalidateQueries({ queryKey: queryKeys.session }));
  await settle();
}

it('forgets every charter draft of the person who was signed in when the account changes or ends', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.auth, 'session').mockResolvedValue({ user: { id: 'alice' } } as never);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <p>app</p>
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  writeDraft('charter-draft:alice:r', '{"markdown":"private"}');
  writeDraft('charter-mine:alice:r', '{"markdown":"private"}');
  writeDraft('quick-drop', 'not a charter');
  // Another account signs in in this tab.
  await session({ id: 'bob' }, client);
  expect(readDraft('charter-draft:alice:r')).toBe('');
  expect(readDraft('charter-mine:alice:r')).toBe('');
  expect(readDraft('quick-drop')).toBe('not a charter');
  // And signing out takes bob's.
  writeDraft('charter-mine:bob:r', '{"markdown":"bobs"}');
  await session(null, client);
  expect(readDraft('charter-mine:bob:r')).toBe('');
  await act(async () => root.unmount());
});

it('forgetDrafts takes the session copy and the in-memory one, and only what starts with the prefix', () => {
  writeDraft('charter-draft:u:r', 'x');
  writeDraft('other', 'y');
  forgetDrafts(CHARTER_DRAFTS);
  expect(readDraft('charter-draft:u:r')).toBe('');
  expect(window.sessionStorage.getItem('omr:draft:charter-draft:u:r')).toBeNull();
  expect(readDraft('other')).toBe('y');
});

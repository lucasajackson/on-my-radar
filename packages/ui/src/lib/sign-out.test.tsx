// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import { queryKeys, useSignOut } from './session';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

afterEach(() => {
  vi.restoreAllMocks();
  navigate.mockReset();
});

async function signOutWith(logout: () => Promise<{ ok: true }>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.auth, 'logout').mockImplementation(logout);
  const client = new QueryClient();
  client.setQueryData(queryKeys.session, { user: { id: 'u1', state: 'pending' } });
  let signOut: () => Promise<void> = async () => undefined;
  function Probe() {
    signOut = useSignOut();
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  await act(async () => signOut());
  await act(async () => root.unmount());
  return client;
}

it('forgets the cached user before going to /login, so login cannot bounce back', async () => {
  const client = await signOutWith(async () => ({ ok: true }));
  expect(client.getQueryData(queryKeys.session)).toBeUndefined();
  expect(navigate).toHaveBeenCalledWith({ to: '/login' });
});

it('stays put, still signed in, when the server did not end the session', async () => {
  const client = await signOutWith(() =>
    Promise.reject(new ApiError(503, 'unavailable', 'Unavailable')),
  );
  expect(client.getQueryData(queryKeys.session)).toBeDefined();
  expect(navigate).not.toHaveBeenCalled();
});

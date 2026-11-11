// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import { SessionProvider, useSession } from './session';
import { must } from './must';

it('exposes a failed session read separately from a successful signed-out response and recovers on retry', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const failure = new ApiError(503, 'unavailable', 'Unavailable');
  const session = vi
    .spyOn(api.auth, 'session')
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ user: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let result: ReturnType<typeof useSession> | undefined;
  function Probe() {
    result = useSession();
    return null;
  }
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SessionProvider>
            <Probe />
          </SessionProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(result?.error).toBe(failure);
    });
    expect(result?.user).toBeNull();
    await act(async () => must(result).refresh());
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(result?.error).toBeNull();
    });
    expect(result?.user).toBeNull();
    expect(result?.loading).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    session.mockRestore();
  }
});

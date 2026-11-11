// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { router } from './router';

// jsdom does not implement scrolling; the router asks for it on navigation.
Object.assign(window, { scrollTo: () => undefined });

it('shows the not-found page, not a blank shell, for an address that is no route', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  router.history.push('/docs/never/was/a/page');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  expect(host.textContent).toContain('Nothing here');
  expect(host.textContent).toContain('Go home');
  await act(async () => root.unmount());
  host.remove();
});

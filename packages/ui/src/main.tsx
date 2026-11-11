import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { SessionProvider } from './lib/session';
import { applyTheme, storedTheme } from './lib/theme';
import './styles.css';

// Applied before the first render so there is no flash of the wrong scheme.
applyTheme(storedTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // A 401/403/404 will not become truthier on the third attempt.
        const status = (error as { status?: number }).status;
        if (status && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);

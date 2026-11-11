// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { WaitingRoute } from './waiting';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  session: { user: null, loading: true, error: null as Error | null, refresh: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../lib/session', () => ({
  useSession: () => mocks.session,
  useSignOut: () => vi.fn(),
}));

it('waits for a definitive session result instead of redirecting during loading or a failed read', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<WaitingRoute />));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Checking your account');
    mocks.session = {
      ...mocks.session,
      loading: false,
      error: new ApiError(503, 'unavailable', 'Unavailable'),
    };
    await act(async () => root.render(<WaitingRoute />));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Could not load session');
    mocks.session = { ...mocks.session, error: null };
    await act(async () => root.render(<WaitingRoute />));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/login' });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

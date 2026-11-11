// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { DashboardDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { must } from '../lib/must';
import { HomeRoute } from './home';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useRouter: () => undefined,
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRadars: () => ({ data: { radars: [] }, isPending: false }),
}));
vi.mock('../components/notifications', () => ({ NotificationWidget: () => null }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const tab = (id: string, name: string): DashboardDto =>
  ({ id, name, widgets: [], createdAt: '', updatedAt: '' }) as unknown as DashboardDto;

it('after deleting a tab, focus is on the neighbouring tab — never on a Delete control', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  let tabs = [tab('main', 'Mission Control'), tab('side', 'Side project')];
  vi.spyOn(api.dashboards, 'list').mockImplementation(() => Promise.resolve({ dashboards: tabs }));
  vi.spyOn(api.dashboards, 'remove').mockImplementation((id: string) => {
    tabs = tabs.filter((t) => t.id !== id);
    return Promise.resolve(undefined as never);
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <HomeRoute />
        </QueryClientProvider>,
      ),
    );
    await settle();
    const side = must(host.querySelector<HTMLButtonElement>('[data-dashboard-tab="side"]'));
    await act(async () => side.click());
    const del = must(
      host.querySelector<HTMLButtonElement>('[aria-label="Delete tab Side project"]'),
    );
    del.focus();
    await act(async () => del.click());
    const confirm = must(
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')).find((b) =>
        /^Delete/.test(b.textContent.trim()),
      ),
    );
    await act(async () => confirm.click());
    await settle();
    await settle();
    const focused = document.activeElement;
    expect(focused?.getAttribute('data-dashboard-tab')).toBe('main');
    expect(focused?.getAttribute('aria-label') ?? '').not.toMatch(/^Delete/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { must } from '../lib/must';
import { ConnectRoute } from './connect';

const QUERY = '?client_id=abc&redirect_uri=https%3A%2F%2Fx.test%2Fcb&code_challenge=cccc&state=s';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (l: { searchStr: string }) => string }) =>
    select({ searchStr: QUERY }),
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({
    user: { id: 'u', email: 'lucas@example.com', name: 'Lucas', isAdmin: false },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("offers the person's agents to write as, You first, and says a chat can choose by loading one", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api.oauth, 'client').mockResolvedValue({
    clientId: 'abc',
    clientName: 'Claude',
    redirectUris: ['https://x.test/cb'],
    agents: [
      { id: 'a', name: 'architect', handle: 'architect', retired: false },
      { id: 'r', name: 'old-helper', handle: 'old-helper', retired: true },
    ],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ConnectRoute />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(host.textContent).toContain('Connect Claude');
    });
    expect(host.textContent).toContain('You can also choose per chat by loading an agent.');
    expect(host.textContent).not.toContain('Identities');
    const trigger = must(host.querySelector<HTMLElement>('[role=combobox]'));
    expect(trigger.textContent).toContain('You');
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    const options = Array.from(document.querySelectorAll('[role=option]')).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['You', 'architect · cosigned by you']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

/** Renders the consent screen, optionally ticks manage, presses Connect, returns the scope sent. */
async function connectWith(tickManage: boolean): Promise<string | undefined> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.oauth, 'client').mockResolvedValue({
    clientId: 'abc',
    clientName: 'Claude',
    redirectUris: ['https://x.test/cb'],
    agents: [],
  });
  const decide = vi.spyOn(api.oauth, 'decide').mockResolvedValue({ redirectTo: 'about:blank' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ConnectRoute />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(host.textContent).toContain('Connect Claude');
    });
    const box = must(host.querySelector<HTMLInputElement>('input[type=checkbox]'));
    expect(box.checked).toBe(false);
    if (tickManage) await act(async () => box.click());
    const connect = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Connect',
    );
    await act(async () => must(connect).click());
    return decide.mock.lastCall?.[0].scope;
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

it('a new consent asks for read and write, with manage an unticked box', async () => {
  expect(await connectWith(false)).toBe('radars:read radars:write');
});

it('ticking the box is the only way manage is sent', async () => {
  expect(await connectWith(true)).toBe('radars:read radars:write radars:manage');
});

// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiTokenDto, RepoAgentDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { ConnectionsSettings, SettingsHome, writableAgents } from './settings';
import { must, setNativeValue } from '../lib/must';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({
    user: { email: 'lucas@example.com', name: null, theme: 'system', isAdmin: false },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it('paints Connections only once its lists have settled, so "New token" cannot move under the pointer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: 'http://localhost/mcp' },
  });
  vi.spyOn(api.integrations, 'list').mockResolvedValue({ integrations: [] });
  vi.spyOn(api.agentRepo, 'list').mockResolvedValue({ agents: [] });
  // Connected apps is the late one.
  let land: (value: { grants: [] }) => void = () => undefined;
  vi.spyOn(api.tokens, 'grants').mockReturnValue(
    new Promise((resolve) => {
      land = resolve;
    }),
  );

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const newTokenButton = () =>
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent.includes('New token'));
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ConnectionsSettings />
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(host.textContent).toContain('Loading connections');
    expect(newTokenButton()).toBeUndefined();
    expect(host.textContent).not.toContain('No tokens yet');

    await act(async () => land({ grants: [] }));
    await vi.waitFor(async () => {
      await settle();
      expect(host.textContent).not.toContain('Loading connections');
    });
    const button = newTokenButton();
    expect(button).toBeDefined();
    // Client portals are for admins and for people who already have one.
    expect(host.textContent).not.toContain('Client portals');

    const create = vi
      .spyOn(api.tokens, 'create')
      .mockRejectedValue(new Error('Synthetic request stop'));
    await act(async () => button?.click());
    expect(document.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe(
      'New access token',
    );
    const name = must(document.querySelector<HTMLInputElement>('[aria-label="Token name"]'));
    await act(async () => {
      setNativeValue(name, 'Explicit scope test');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = must(
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Create token',
      ),
    );
    await act(async () => submit.click());
    expect(create).toHaveBeenLastCalledWith({
      name: 'Explicit scope test',
      scopes: ['radars:read', 'radars:write', 'radars:manage'],
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('lists every section as its own link on the phone, with sign out at hand', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SettingsHome />
        </QueryClientProvider>,
      ),
    );
    const links = Array.from(host.querySelectorAll('[data-omr="settings-section-link"]'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/profile',
      '/settings/notifications',
      '/settings/connections',
      '/settings/email',
      '/settings/data',
    ]);
    expect(host.textContent).toContain('Sign out');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('tells two connected apps with one name apart', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: 'http://localhost/mcp' },
  });
  const app = (clientId: string, port: number, clientName = 'LM Studio') => ({
    clientId,
    clientName,
    scopes: ['radars:read'],
    agent: null,
    lastUsedAt: null,
    createdAt: '2026-09-01T12:00:00Z',
    lapsesAt: '2026-10-15T12:00:00Z',
    registeredAt: '2026-09-01T11:59:00Z',
    redirectHosts: [`127.0.0.1:${port}`],
  });
  vi.spyOn(api.tokens, 'grants').mockResolvedValue({
    grants: [
      app('omr_client_4f1c0aa1aaaa1111', 53682),
      app('omr_client_9e22b0c7bbbb2222', 41000),
      app('omr_client_77d0e1f2cccc3333', 5000, 'Cursor'),
    ],
  });
  vi.spyOn(api.integrations, 'list').mockResolvedValue({ integrations: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ConnectionsSettings />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(host.textContent).toContain('returns to 127.0.0.1:41000');
    });
    expect(host.textContent).toContain('returns to 127.0.0.1:53682');
    // The server's date, not createdAt plus a window.
    expect(host.textContent).toMatch(/lapses Oct 15, 2026 if unused/);
    // The shared name shows ids; the unique one does not need to.
    // The part that differs, never the shared "omr_clie" prefix.
    expect(host.textContent).toContain('id …aaaa1111');
    expect(host.textContent).toContain('id …bbbb2222');
    expect(host.textContent).not.toContain('omr_clie');
    // First on its line and never cut: a narrow screen truncated the line's end.
    const line = must(
      Array.from(host.querySelectorAll('div')).find(
        (div) => div.children.length === 0 && div.textContent.includes('id …aaaa1111'),
      ),
    );
    expect(line.textContent.startsWith('id …aaaa1111')).toBe(true);
    expect(line.className).not.toContain('truncate');
    expect(host.textContent).not.toContain('cccc3333');
    const names = Array.from(host.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label'))
      .filter((label) => label?.startsWith('Disconnect'));
    expect(new Set(names).size).toBe(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

/** Only the fields `writableAgents` and the dialog read; the rest are irrelevant here. */
const repoAgent = (over: Partial<RepoAgentDto> & Pick<RepoAgentDto, 'id' | 'name'>) =>
  ({
    role: 'owner',
    archived: false,
    awaitingAccept: false,
    access: { prompt: 'edit', memory: 'edit', canManage: true },
    ...over,
  }) as RepoAgentDto;

it('binds a token only to the person’s own live agents', () => {
  // A shared agent — even one they may edit — writes under its name through a
  // load session, never through a credential: bearer auth refuses the binding.
  const offered = writableAgents([
    repoAgent({ id: 'b', name: 'merchandiser' }),
    repoAgent({ id: 'a', name: 'architect' }),
    repoAgent({ id: 'x', name: 'archived', archived: true }),
    repoAgent({ id: 'v', name: 'viewer', role: 'shared', access: { prompt: 'view' } as never }),
    repoAgent({ id: 'e', name: 'editor', role: 'shared', access: { prompt: 'edit' } as never }),
    repoAgent({ id: 'p', name: 'pending', role: 'shared', awaitingAccept: true }),
  ]).map((agent) => agent.id);
  expect(offered).toEqual(['a', 'b']);
});

it('has no identities any more: tokens say who they write as, and a new one can write as an agent', async () => {
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
  const token = (id: string, agent: ApiTokenDto['agent']): ApiTokenDto => ({
    id,
    name: id,
    prefix: 'omr_x',
    agent,
    voices: [],
    defaultVoice: null,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-09-01T12:00:00Z',
  });
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [
      token('laptop', { id: 'a', name: 'architect', handle: 'architect', retired: false }),
      token('phone', null),
    ],
    agents: [],
    mcp: { enabled: true, url: 'http://localhost/mcp' },
  });
  vi.spyOn(api.tokens, 'grants').mockResolvedValue({ grants: [] });
  vi.spyOn(api.agentRepo, 'list').mockResolvedValue({
    agents: [repoAgent({ id: 'a', name: 'architect' })],
  });
  const create = vi
    .spyOn(api.tokens, 'create')
    .mockResolvedValue({ token: { ...token('new', null), token: 'omr_secret' } });
  vi.spyOn(api.integrations, 'list').mockResolvedValue({ integrations: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ConnectionsSettings />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await settle();
      expect(host.textContent).toContain('writes as architect');
    });
    expect(host.textContent).toContain('writes as you');
    expect(host.textContent).toContain('Connections');
    expect(host.textContent).not.toContain('Identities');
    expect(host.textContent).not.toContain('New identity');
    expect(host.textContent).toContain('Agents and their prompts live in Agents');

    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent.includes('New token'))
        ?.click(),
    );
    await settle();
    const dialog = must(document.querySelector<HTMLElement>('[role=dialog]'));
    const name = must(dialog.querySelector<HTMLInputElement>('input[aria-label="Token name"]'));
    await act(async () => {
      setNativeValue(name, 'laptop 2');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const trigger = must(dialog.querySelector<HTMLElement>('[role=combobox]'));
    expect(trigger.textContent).toContain('You');
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    const option = must(
      Array.from(document.querySelectorAll<HTMLElement>('[role=option]')).find((o) =>
        o.textContent.includes('architect · cosigned by you'),
      ),
    );
    await act(async () => option.focus());
    await act(async () =>
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    await act(async () =>
      must(
        Array.from(dialog.querySelectorAll('button')).find((b) =>
          b.textContent.includes('Create token'),
        ),
      ).click(),
    );
    await settle();
    expect(create).toHaveBeenCalledWith({
      name: 'laptop 2',
      agentId: 'a',
      voices: ['persona'],
      scopes: ['radars:read', 'radars:write', 'radars:manage'],
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

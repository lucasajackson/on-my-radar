// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminAgentDto, AdminTokenDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { must } from '../lib/must';
import { AdminAgentsRoute } from './admin-agents';

const viewer = vi.hoisted(() => ({ isAdmin: true, state: 'active' }));
vi.mock('../lib/session', () => ({
  useSession: () => ({ user: viewer }),
  queryKeys: { adminAgents: ['admin-agents'], adminTokens: ['admin-tokens'] },
}));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

const owner = { id: 'u1', email: 'ada@example.test', name: 'Ada' };
const agent = (over: Partial<AdminAgentDto>): AdminAgentDto => ({
  id: 'a1',
  name: 'Scribe',
  handle: 'scribe',
  owner,
  radarScope: 'selected',
  radarGrantCount: 2,
  archived: false,
  liveTokens: 1,
  liveGrants: 0,
  liveSessions: 0,
  fencedConnections: 0,
  lastUsedAt: null,
  createdAt: '2026-10-30T00:00:00Z',
  ...over,
});
const pat: AdminTokenDto = {
  kind: 'pat',
  id: 't1',
  name: 'laptop',
  owner,
  agent: { id: 'a1', name: 'Scribe', handle: 'scribe' },
  scopes: ['radars:read'],
  lastUsedAt: null,
  expiresAt: null,
  createdAt: '2026-10-30T00:00:00Z',
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  viewer.isAdmin = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.admin, 'agents').mockResolvedValue({
    agents: [agent({}), agent({ id: 'a2', name: 'Wide', handle: 'wide', radarScope: 'all' })],
    total: 2,
    nextCursor: null,
  });
  vi.spyOn(api.admin, 'tokens').mockResolvedValue({ tokens: [pat], total: 1, nextCursor: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AdminAgentsRoute />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
const button = (scope: ParentNode, text: string) =>
  must(
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent.trim() === text,
    ),
  );

it('lists agents with how they are limited, and credentials, and nothing else', async () => {
  await render();
  const text = host.textContent;
  expect(text).toContain('Scribe');
  expect(text).toContain('limited to 2 radars');
  expect(text).toContain('all radars');
  expect(text).toContain('laptop');
  expect(text).toContain('as @scribe');
});

const dialog = () =>
  must(document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]'));

it('revokes an agent after a confirmation, and a credential through its own door', async () => {
  const revokeAgent = vi.spyOn(api.admin, 'revokeAgent').mockResolvedValue(undefined);
  const revokeToken = vi.spyOn(api.admin, 'revokeToken').mockResolvedValue(undefined);
  await render();
  await act(async () => button(host, 'Revoke all').click());
  expect(revokeAgent).not.toHaveBeenCalled();
  await act(async () => button(dialog(), 'Revoke').click());
  await settle();
  expect(revokeAgent).toHaveBeenCalledWith('a1');

  await act(async () => button(host, 'Revoke').click());
  await act(async () => button(dialog(), 'Revoke').click());
  await settle();
  expect(revokeToken).toHaveBeenCalledWith(pat);
});

it('shows a non-admin nothing and asks the server for nothing', async () => {
  viewer.isAdmin = false;
  await render();
  expect(host.textContent).toContain('Admins only');
  expect(api.admin.agents).not.toHaveBeenCalled();
});

it('Revoke all is on for an agent with only open sessions or connections that ran it, and says so', async () => {
  vi.spyOn(api.admin, 'agents').mockResolvedValue({
    agents: [
      agent({ id: 'a3', liveTokens: 0, liveGrants: 0, liveSessions: 0, fencedConnections: 0 }),
      agent({
        id: 'a4',
        name: 'Carrier',
        handle: 'carrier',
        liveTokens: 0,
        liveGrants: 0,
        liveSessions: 1,
        fencedConnections: 2,
      }),
    ],
    total: 2,
    nextCursor: null,
  });
  const revokeAgent = vi.spyOn(api.admin, 'revokeAgent').mockResolvedValue(undefined);
  await render();
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter(
    (b) => b.textContent.trim() === 'Revoke all',
  );
  expect(buttons.map((b) => b.disabled)).toEqual([true, false]);
  expect(host.textContent).toContain('1 open session');
  expect(host.textContent).toContain('2 connections that ran it');
  await act(async () => must(buttons[1]).click());
  expect(dialog().textContent).toContain('also disconnects 2 connections that ran this agent');
  await act(async () => button(dialog(), 'Revoke').click());
  await settle();
  expect(revokeAgent).toHaveBeenCalledWith('a4');
});

it('says how many there are when the list stops short, and pages and searches on request', async () => {
  const agents = vi.spyOn(api.admin, 'agents').mockImplementation(async (query = {}) =>
    query.cursor
      ? {
          agents: [agent({ id: 'a9', name: 'Ninth', handle: 'ninth' })],
          total: 3,
          nextCursor: null,
        }
      : {
          agents: [agent({}), agent({ id: 'a2', name: 'Wide', handle: 'wide' })],
          total: 3,
          nextCursor: 'next-page',
        },
  );
  await render();
  expect(host.textContent).toContain('Showing 2 of 3 agents');
  expect(host.textContent).not.toContain('Ninth');
  await act(async () => button(host, 'Show more').click());
  await settle();
  expect(agents).toHaveBeenLastCalledWith({ cursor: 'next-page' });
  expect(host.textContent).toContain('Ninth');
  expect(host.textContent).toContain('Showing 3 of 3 agents');

  const box = must(host.querySelector<HTMLInputElement>('input[aria-label^="Search agents"]'));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'nin');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
  await settle();
  expect(agents).toHaveBeenLastCalledWith({ q: 'nin' });
});

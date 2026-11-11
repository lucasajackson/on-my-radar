// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { api, ApiError } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import type * as Session from '../lib/session';
import { AssignControl, AssigneeChip, initialsOf } from './assign';

vi.mock('../lib/session', async (original) => ({
  ...(await original<typeof Session>()),
  useSession: () => ({ user: { id: 'me' } }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const holder = (agentId: string | null, name: string) => ({ userId: null, agentId, name });

it('shows initials for a person and the agent badge for an agent', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <>
        <AssigneeChip holder={holder(null, 'Ada Lovelace')} />
        <AssigneeChip holder={holder('a1', 'Lulu')} />
      </>,
    ),
  );
  const [person, agent] = [...host.querySelectorAll('.assignee-chip')];
  expect(person?.getAttribute('data-assignee')).toBe('person');
  expect(person?.querySelector('.assignee-mark')?.textContent).toBe('AL');
  expect(agent?.getAttribute('data-assignee')).toBe('agent');
  expect(agent?.querySelector('.assignee-mark.is-agent svg')).not.toBeNull();
  expect(initialsOf(null)).toBe('?');
  expect(initialsOf('  ada  ')).toBe('A');
  await act(async () => root.unmount());
});

async function open(blip: Partial<BlipDto> = {}) {
  vi.spyOn(api.radars, 'members').mockResolvedValue({
    members: [
      { userId: 'me', email: 'me@example.test', name: 'Me Myself', pending: false },
      { userId: 'u2', email: 'bo@example.test', name: 'Bo', pending: false },
      { userId: 'u3', email: 'new@example.test', name: null, pending: true },
    ],
    agents: [{ id: 'a1', name: 'Lulu', handle: 'lulu', handles: ['lulu'], ownerName: 'Bo' }],
  } as unknown as Awaited<ReturnType<typeof api.radars.members>>);
  const update = vi
    .spyOn(api.blips, 'update')
    .mockResolvedValue({} as Awaited<ReturnType<typeof api.blips.update>>);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AssignControl blip={{ id: 'b1', radarId: 'r1', ...blip } as BlipDto} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => must(host.querySelector('button')).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const press = (label: string) =>
    act(async () =>
      must(
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label)),
      ).click(),
    );
  return { update, press, root };
}

it('lists members and agents, filters by search, and assigns one holder at a time', async () => {
  const { update, press, root } = await open();
  const options = () => [...document.querySelectorAll('[data-assign-option]')];
  expect(options().map((o) => o.getAttribute('data-assign-option'))).toEqual([
    'person',
    'person',
    'agent',
  ]);
  const search = must(document.querySelector<HTMLInputElement>('input[type="search"]'));
  await act(async () => {
    setNativeValue(search, 'lulu');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(options()).toHaveLength(1);
  await press('Lulu');
  expect(update).toHaveBeenLastCalledWith('b1', { assigneeUserId: null, assigneeAgentId: 'a1' });
  await act(async () => root.unmount());
});

it('shows the server refusal inline, then assigns to me', async () => {
  const { update, press, root } = await open({ assignee: holder('a1', 'Lulu') });
  update.mockRejectedValueOnce(
    new ApiError(400, 'bad_request', 'That agent is not one you can reach.'),
  );
  await press('Unassign');
  expect(update).toHaveBeenLastCalledWith('b1', { assigneeUserId: null, assigneeAgentId: null });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'That agent is not one you can reach.',
  );
  await press('Assign to me');
  expect(update).toHaveBeenLastCalledWith('b1', { assigneeUserId: 'me', assigneeAgentId: null });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.unmount());
});

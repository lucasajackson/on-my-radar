// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { DecisionRequestDto } from '@onmyradar/contract';
import { DecisionRequests } from './decision-requests';
import { api } from '../lib/api';
import { must } from '../lib/must';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.restoreAllMocks());

const request = (over: Partial<DecisionRequestDto>): DecisionRequestDto => ({
  id: 'r1',
  blipId: 'b1',
  radarId: 'rad',
  context: 'Release is blocked on this choice',
  question: 'Adopt the new queue?',
  options: [
    { value: 'accepted', label: 'Accepted' },
    { value: 'rejected', label: 'Rejected' },
  ],
  decides: true,
  status: 'open',
  answer: null,
  answeredAt: null,
  requestedBy: 'Lulu',
  createdAt: new Date().toISOString(),
  canAnswer: true,
  ...over,
});

async function show(requests: DecisionRequestDto[]) {
  vi.spyOn(api.decisions, 'list').mockResolvedValue({ requests });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DecisionRequests blipId="b1" />
      </QueryClientProvider>,
    ),
  );
  // The list resolves a tick after the first render.
  await vi.waitFor(() => expect(host.querySelector('.decision-request')).not.toBeNull());
  return { host, done: () => act(async () => root.unmount()) };
}

it('leads with the context line and answers with the option tapped', async () => {
  const answer = vi.spyOn(api.decisions, 'answer').mockResolvedValue({
    request: request({ status: 'answered', answer: 'accepted', canAnswer: false }),
  });
  const { host, done } = await show([request({})]);
  expect(host.querySelector('.decision-context')?.textContent).toBe(
    'Release is blocked on this choice',
  );
  // The template decides: the options are the whole answer, no free text box.
  expect(host.querySelector('input')).toBeNull();
  const accept = must(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Accepted'),
  );
  await act(async () => accept.click());
  expect(answer).toHaveBeenCalledWith('b1', 'r1', 'accepted');
  await done();
});

it('offers a free-text answer where the options are only suggestions, and none once overtaken', async () => {
  const { host, done } = await show([
    request({ decides: false, options: [{ value: 'Acme', label: 'Acme' }] }),
    request({ id: 'r2', status: 'overtaken', canAnswer: false }),
  ]);
  expect(host.querySelectorAll('input')).toHaveLength(1);
  expect(host.textContent).toContain('the card moved on');
  expect(host.querySelectorAll('button')).toHaveLength(2);
  await done();
});

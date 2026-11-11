// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { RadarAttachments } from './radar-attachments';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('names what goes with a radar: hooks, feeds, its address, its people, its link', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.subscriptions, 'list').mockResolvedValue({
    subscriptions: [{ id: 's1' }, { id: 's2' }],
  } as never);
  vi.spyOn(api.radars, 'webhooks').mockResolvedValue({ webhooks: [{ id: 'w1' }] } as never);
  vi.spyOn(api.feeds, 'list').mockResolvedValue({ feeds: [] });
  vi.spyOn(api.radars, 'members').mockResolvedValue({
    members: [{ via: 'owner' }, { via: 'member' }],
    agents: [],
  } as never);
  vi.spyOn(api.emailCapture, 'radar').mockResolvedValue({
    enabled: true,
    address: 'lucas+reading@in.example',
  } as never);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RadarAttachments radar={{ id: 'r1', visibility: 'public' }} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain('Also deleted with it'));
  const items = Array.from(host.querySelectorAll('li')).map((li) => li.textContent);
  expect(items).toEqual([
    '2 outbound webhooks — receivers stop getting events',
    '1 inbound webhook — anything posting to them starts failing',
    'its email address, lucas+reading@in.example',
    'access for 1 person it is shared with',
    'its public link',
  ]);
  await act(async () => root.unmount());
});

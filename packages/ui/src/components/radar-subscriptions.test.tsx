// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionDto } from '@onmyradar/contract';
import { api, ApiError } from '../lib/api';
import { RadarSubscriptions } from './radar-subscriptions';
import { must, setNativeValue } from '../lib/must';
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const row: SubscriptionDto = {
  id: 'subscription',
  radarId: 'radar',
  name: 'Portal',
  url: 'https://portal.example/hooks',
  events: ['blip.updated'],
  enabled: true,
  lastError: null,
  createdAt: new Date().toISOString(),
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.subscriptions, 'list').mockResolvedValue({ subscriptions: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  must(
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent.trim() === text,
    ),
  );
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RadarSubscriptions radarId="radar" />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('preserves a rejected draft, enforces event selection, and clears the one-time secret on acknowledgement', async () => {
  const create = vi
    .spyOn(api.subscriptions, 'create')
    .mockRejectedValueOnce(new ApiError(400, 'bad_request', 'Use HTTPS'))
    .mockResolvedValueOnce({ subscription: { ...row, secret: 'one-time-secret' } });
  await render();
  await act(async () => button('New subscription').click());
  const inputs = document.querySelectorAll<HTMLInputElement>('input');
  await type(must(inputs[0]), 'Portal');
  await type(must(inputs[1]), row.url);
  const checks = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
  await act(async () => {
    for (const input of checks) input.click();
  });
  expect(button('Create subscription').disabled).toBe(true);
  await act(async () => must(checks[1]).click());
  await act(async () => button('Create subscription').click());
  expect(create).toHaveBeenCalledWith('radar', {
    name: 'Portal',
    url: row.url,
    events: ['blip.updated'],
  });
  expect(must(inputs[1]).value).toBe(row.url);
  // The refusal is said beside the URL, in the dialog, with the field marked.
  const alert = must(document.querySelector('[role=dialog] [role=alert]'), 'inline error');
  expect(alert.textContent).toBe('Use HTTPS');
  expect(must(inputs[1]).getAttribute('aria-invalid')).toBe('true');
  expect(must(inputs[1]).getAttribute('aria-describedby')).toBe(alert.id);
  expect(document.activeElement).toBe(inputs[1]);
  vi.mocked(api.subscriptions.list).mockResolvedValue({ subscriptions: [row] });
  await act(async () => button('Create subscription').click());
  const secretField = must(
    document.querySelector<HTMLInputElement>('[aria-label="Signing secret"]'),
  );
  expect(secretField.value).toBe('one-time-secret');
  // The secret is what to act on now, not the page title.
  await vi.waitFor(() => expect(document.activeElement).toBe(secretField));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  await act(async () => button('I have saved it').click());
  expect(document.querySelector('[aria-label="Signing secret"]')).toBeNull();
  // …and then the subscription it belongs to.
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('data-subscription-id')).toBe(row.id),
  );
});
it('shows delivery failures and requires a deliberate confirmation before rotation', async () => {
  vi.mocked(api.subscriptions.list).mockResolvedValue({ subscriptions: [row] });
  const rotate = vi
    .spyOn(api.subscriptions, 'rotate')
    .mockResolvedValue({ subscription: { ...row, secret: 'rotated' } });
  vi.spyOn(api.subscriptions, 'deliveries').mockResolvedValue({
    deliveries: [
      {
        id: 'attempt',
        eventId: 'evt_test',
        event: 'blip.updated',
        attempt: 2,
        status: 500,
        error: 'Receiver returned HTTP 500',
        createdAt: new Date().toISOString(),
      },
    ],
  });
  await render();
  await act(async () => button('Rotate secret').click());
  expect(rotate).not.toHaveBeenCalled();
  const confirm = must(document.querySelector<HTMLButtonElement>('[role=dialog] .btn-accent'));
  await act(async () => confirm.click());
  expect(rotate).toHaveBeenCalledWith('radar', row.id);
  await act(async () => button('Delivery history').click());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(document.body.textContent).toContain('attempt 2');
  expect(document.body.textContent).toContain('HTTP 500');
});

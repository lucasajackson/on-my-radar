// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserDto, SupportRequestDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { SupportRoute } from './support';

const mocks = vi.hoisted(() => ({
  user: null as UserDto | null,
  selected: undefined as string | undefined,
  navigate: vi.fn(async () => undefined),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useSearch: () => ({ request: mocks.selected }),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../lib/session', () => ({
  useSession: () => ({ user: mocks.user, loading: false, error: null, refresh: vi.fn() }),
}));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const request: SupportRequestDto = {
  id: '6ad6a357-d92c-4238-a025-0cd0a5fb1536',
  category: 'bug',
  title: 'A private bug',
  body: '<script>private</script>',
  status: 'received',
  createdAt: '2026-10-03T00:00:00Z',
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.user = { id: 'user-one', state: 'pending' } as UserDto;
  mocks.selected = undefined;
  mocks.navigate.mockClear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api.support, 'list').mockResolvedValue({ requests: [], next: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SupportRoute />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
it('offers authenticated intake to a pending account and reports unconfigured support honestly', async () => {
  vi.spyOn(api.support, 'list').mockRejectedValue(
    new ApiError(503, 'support_unavailable', 'Support intake is not available yet.'),
  );
  await render();
  await flush();
  expect(host.textContent).toContain('Support intake is not available yet.');
  expect(host.querySelector('form')).toBeNull();
  expect(host.querySelector('a[href="/waiting"]')).not.toBeNull();
});
it('asks anonymous people to sign in without claiming to have received a request', async () => {
  mocks.user = null;
  await render();
  expect(host.textContent).toContain('Sign in to contact support');
  expect(api.support.list).not.toHaveBeenCalled();
  expect(host.querySelector('form')).toBeNull();
});
it('keeps failed-submission text and its retry reference, then navigates to the receipt', async () => {
  const create = vi
    .spyOn(api.support, 'create')
    .mockRejectedValueOnce(new Error('Temporary failure'))
    .mockResolvedValue({ request });
  await render();
  await flush();
  await act(async () => {
    must(host.querySelector<HTMLInputElement>('#support-title')).focus();
    setNativeValue(must(host.querySelector<HTMLInputElement>('#support-title')), 'A private bug');
    must(host.querySelector('#support-title')).dispatchEvent(new Event('input', { bubbles: true }));
    must(host.querySelector('#support-title')).dispatchEvent(new Event('keyup', { bubbles: true }));
    must(host.querySelector<HTMLTextAreaElement>('#support-body')).focus();
    setNativeValue(
      must(host.querySelector<HTMLTextAreaElement>('#support-body')),
      'A redacted reproduction',
    );
    must(host.querySelector('#support-body')).dispatchEvent(new Event('input', { bubbles: true }));
    must(host.querySelector('#support-body')).dispatchEvent(new Event('keyup', { bubbles: true }));
  });
  const form = must(host.querySelector('form'));
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
  expect(host.textContent).toContain('Temporary failure');
  expect(host.querySelector<HTMLTextAreaElement>('#support-body')?.value).toBe(
    'A redacted reproduction',
  );
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
  expect(create.mock.calls[0]?.[0].operationId).toBe(create.mock.calls[1]?.[0].operationId);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: '/support', search: { request: request.id } });
});
it('shows the reference, fixed status and private thread as text, with an authenticated reply', async () => {
  mocks.selected = request.id;
  vi.spyOn(api.support, 'get').mockResolvedValue({
    request,
    replies: [
      {
        id: 'reply-one',
        from: 'support',
        body: '<img src=x onerror=alert(1)>',
        createdAt: '2026-10-03T00:01:00Z',
      },
    ],
    next: null,
  });
  await render();
  await flush();
  expect(host.textContent).toContain(`Reference: ${request.id.slice(0, 8)}`);
  expect(host.textContent).toContain('Received');
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('#support-reply')).not.toBeNull();
});

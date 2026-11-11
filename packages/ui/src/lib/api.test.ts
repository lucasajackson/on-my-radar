import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, uploadFile } from './api';

afterEach(() => vi.unstubAllGlobals());

function respond(body: string | null, status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
}

describe('API response errors', () => {
  it('preserves the status of an HTML gateway failure', async () => {
    respond('<html>upstream unavailable</html>', 502);
    await expect(api.radars.list()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'http_error',
      message: 'Request failed (502). Please try again.',
    });
  });

  it('keeps structured validation errors and their field hints', async () => {
    respond(
      JSON.stringify({
        error: { code: 'invalid_input', message: 'Name required', fields: { name: 'Required' } },
      }),
      400,
    );
    await expect(api.radars.list()).rejects.toMatchObject({
      status: 400,
      code: 'invalid_input',
      message: 'Name required',
      fields: { name: 'Required' },
    });
  });

  it('rejects a successful HTML fallback instead of returning it as API data', async () => {
    respond('<html>SPA fallback</html>', 200);
    await expect(api.radars.list()).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });

  it('handles an empty error response', async () => {
    respond(null, 503);
    await expect(api.radars.list()).rejects.toBeInstanceOf(ApiError);
  });

  it('accepts a successful no-content deletion', async () => {
    respond(null, 204);
    await expect(api.radars.remove('example')).resolves.toBeUndefined();
  });
});

it('sends only a SHA-256 endpoint hash in the notification settings URL', async () => {
  respond('{}', 200);
  const endpoint = 'https://push.test/private-capability';
  await api.notifications.settings(endpoint);
  const called = vi.mocked(fetch).mock.calls[0]?.[0];
  expect(called).toMatch(/\/api\/notifications\/settings\?endpointHash=[a-f0-9]{64}$/);
  expect(called).not.toContain('private-capability');
});

it('sends every outbound subscription management call to the authenticated API', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })),
  );
  await api.subscriptions.list('radar');
  await api.subscriptions.create('radar', {
    name: 'Portal',
    url: 'https://example.com/hooks',
    events: ['blip.updated'],
  });
  await api.subscriptions.update('radar', 'subscription', false);
  await api.subscriptions.rotate('radar', 'subscription');
  await api.subscriptions.test('radar', 'subscription');
  await api.subscriptions.deliveries('radar', 'subscription');
  await api.subscriptions.remove('radar', 'subscription');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/api/radars/radar/subscriptions',
    '/api/radars/radar/subscriptions',
    '/api/radars/radar/subscriptions/subscription',
    '/api/radars/radar/subscriptions/subscription/rotate',
    '/api/radars/radar/subscriptions/subscription/test',
    '/api/radars/radar/subscriptions/subscription/deliveries',
    '/api/radars/radar/subscriptions/subscription',
  ]);
});

it('keeps an id from the URL inside its own path segment', async () => {
  // `/radar/..%2F..%2Fadmin%2Fusers` hands the route this id, already decoded.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })),
  );
  await api.radars.get('../../admin/users');
  await api.publicRadars.get('a/b?c');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/api/radars/..%2F..%2Fadmin%2Fusers',
    '/api/public/radars/a%2Fb%3Fc',
  ]);
});

describe('uploadFile', () => {
  const ticket = {
    ticket: {
      key: 'radars/r/u/image.png',
      url: 'https://storage.example/on-my-radar/radars/r/u/image.png?X-Amz-Signature=x',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      expiresIn: 900,
    },
  };
  // The measuring decode is not what is under test; an Image that cannot decode
  // is the path uploadFile already treats as "size unknown".
  class UndecodableImage {
    onerror: (() => void) | null = null;
    set src(_: string) {
      queueMicrotask(() => this.onerror?.());
    }
  }
  beforeEach(() => vi.stubGlobal('Image', UndecodableImage));
  // A clipboard paste arrives as exactly this: a File called image.png.
  const pasted = () =>
    new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });

  it('names a PUT the browser never sent (CORS, network) as storage being unreachable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 200 }))
      // What fetch does when the bucket has no CORS policy: a bare TypeError.
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadFile('r', pasted())).rejects.toMatchObject({
      name: 'ApiError',
      code: 'storage_unreachable',
      message: 'Storage unreachable',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(ticket.ticket.url);
  });

  it('reports the status when the storage answers and refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 200 }))
        .mockResolvedValueOnce(
          new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 }),
        ),
    );
    await expect(uploadFile('r', pasted())).rejects.toMatchObject({
      code: 'upload_failed',
      status: 400,
      message: 'Storage refused it (400)',
    });
  });

  it('PUTs the file with only the signed content-type header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = pasted();
    await expect(uploadFile('r', file)).resolves.toMatchObject({
      key: ticket.ticket.key,
      filename: 'image.png',
      contentType: 'image/png',
      size: 4,
    });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: file,
    });
  });
});

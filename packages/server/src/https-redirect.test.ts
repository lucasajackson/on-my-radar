import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { loadEnv, setEnvForTesting } from './env.js';
import { createApp } from './app.js';
import { redirectToHttps } from './https-redirect.js';

const app = new Hono();
app.use('*', redirectToHttps());
app.all('*', (c) => c.text('served'));

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  app.request(`http://onmyradar.io${path}`, {
    method,
    redirect: 'manual',
    headers: { host: 'onmyradar.io', ...headers },
  });
const PLAIN = { 'cf-visitor': '{"scheme":"http"}' };

describe('HTTP to HTTPS', () => {
  it('sends a plain-http visitor to the same address over https, path and query kept', async () => {
    const response = await get('/radar/abc?x=1&y=2', PLAIN);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://onmyradar.io/radar/abc?x=1&y=2');
  });
  it('redirects whatever the method, because Cloudflare has already refused to speak http to us', async () => {
    expect((await get('/api/blips', PLAIN, 'POST')).status).toBe(301);
  });
  it.each([
    ['an https visitor', { 'cf-visitor': '{"scheme":"https"}' }],
    ['no CF-Visitor, as with every in-cluster probe', {}],
    ['a header that is not JSON about a scheme', { 'cf-visitor': 'http' }],
  ])('serves %s', async (_name, headers) => {
    const response = await get('/api/blips', headers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('served');
  });
  it.each(['/health', '/health/ready', '/health/live'])('never redirects %s', async (path) => {
    expect((await get(path, PLAIN)).status).toBe(200);
  });
  it('does not treat /healthy as a probe', async () => {
    expect((await get('/healthy', PLAIN)).status).toBe(301);
  });
  it('will not echo a hostile Host header into a Location', async () => {
    for (const host of ['evil.example/@x', 'a b', 'evil.example\\@x']) {
      const response = await get('/x', { ...PLAIN, host });
      expect(response.headers.get('location')).toBeNull();
    }
  });
});

describe('the API', () => {
  beforeEach(() =>
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgresql://not-connected/test',
        SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
      }),
    ),
  );
  afterEach(() => vi.restoreAllMocks());
  it('redirects before anything else runs, and leaves /health/live alone', async () => {
    const api = createApp();
    const moved = await api.request('http://onmyradar.io/api/anything', {
      redirect: 'manual',
      headers: { host: 'onmyradar.io', ...PLAIN },
    });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('https://onmyradar.io/api/anything');
    const probe = await api.request('http://onmyradar.io/health/live', {
      headers: { host: 'onmyradar.io', ...PLAIN },
    });
    expect(probe.status).toBe(200);
    expect(probe.headers.get('strict-transport-security')).toContain('max-age=15552000');
  });
});

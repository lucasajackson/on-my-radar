import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { LIMITS } from '@onmyradar/contract';
import { boundRequestBody } from './body-limit.js';
import { loadEnv, setEnvForTesting } from './env.js';
import { errorBody, type AppEnv } from './http.js';
import { createApp } from './app.js';

const envFixture = {
  DATABASE_URL: 'postgresql://not-connected/test',
  SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
};
beforeEach(() => setEnvForTesting(loadEnv(envFixture)));
afterEach(() => vi.restoreAllMocks());
const app = new Hono<AppEnv>();
// Stand-in for attachActor: an authenticated caller keeps the full limit.
app.use('*', async (c, next) => {
  c.set('actor', { kind: 'user' } as AppEnv['Variables']['actor']);
  await next();
});
app.use('*', boundRequestBody());
app.post('/json', async (c) =>
  c.json({ size: (await c.req.json<{ body: string }>()).body.length }),
);
app.onError((error, c) => {
  const result = errorBody(error);
  return c.json(result.body, result.status as 413);
});

describe('aggregate body cap', () => {
  it('accepts the largest body as fully escaped JSON inside an MCP-sized envelope', async () => {
    // Six bytes per UTF-16 unit is the largest JSON encoding of a valid character.
    const body = '{"body":"' + '\\u0061'.repeat(LIMITS.blipBody) + '","jsonrpc":"2.0","id":1}';
    const response = await app.request('/json', { method: 'POST', body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: LIMITS.blipBody });
  });
  it.each(['/api/auth/request-code', '/oauth/token', '/mcp', '/hooks/id/token'])(
    'caps %s before authentication or parsing',
    async (path) => {
      const response = await createApp().request(path, {
        method: 'POST',
        headers: { 'content-length': String(3 * 1024 * 1024) },
        body: '{}',
      });
      expect(response.status).toBe(413);
      const body = (await response.json()) as { error: { code: string | number } };
      // An MCP client reads JSON-RPC, so /mcp refuses in that shape (-32600, Invalid Request).
      expect(body.error.code).toBe(path === '/mcp' ? -32600 : 'payload_too_large');
    },
  );
  it('caps requests without an actor at 16 KiB, before any route parses them', async () => {
    const hostile = (path: string, bytes: number) =>
      createApp().request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"legacyConsent":{"features":{"templates":[' + '1,'.repeat(bytes / 2) + '1]}}}',
      });
    for (const path of ['/oauth/register', '/api/waitlist', '/api/v1/waitlist']) {
      expect((await hostile(path, 8 * 1024)).status).not.toBe(413);
      expect((await hostile(path, 800 * 1024)).status).toBe(413);
    }
  });
  it('authenticates a route before reading its body', async () => {
    const response = await createApp().request('/api/radars', {
      method: 'POST',
      body: 'not json, and no content type',
    });
    // Parsing first would have answered 415.
    expect(response.status).toBe(401);
  });
  it('cancels chunked input despite a false Content-Length', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(512 * 1024));
        if (pulls === 12) controller.close();
      },
      cancel,
    });
    const response = await app.request(
      new Request('http://localhost/json', {
        method: 'POST',
        headers: { 'content-length': '1' },
        body: stream,
        duplex: 'half',
      }),
    );
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThan(12);
  });
});

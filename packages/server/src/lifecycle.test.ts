import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainHttpServer, finishWithin, isDraining } from './lifecycle.js';
import { healthRoutes } from './routes/health.js';
import { loadEnv, setEnvForTesting } from './env.js';

vi.mock('./db/client.js', () => ({ pingDbForReadiness: vi.fn().mockResolvedValue(undefined) }));
setEnvForTesting(
  loadEnv({
    DATABASE_URL: 'postgresql://not-connected/test',
    SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  }),
);
afterEach(() => vi.restoreAllMocks());

it('withdraws readiness first, serves endpoint propagation and finishes an in-flight request', async () => {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      entered();
      void gate.then(() => res.end('completed'));
    } else res.end('still serving');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const url = `http://127.0.0.1:${address.port}`;
  const slow = fetch(`${url}/slow`);
  await started;
  const closeResources = vi.fn().mockResolvedValue(undefined);
  const shutdown = drainHttpServer(server, { drainMs: 150, timeoutMs: 2000, closeResources });
  expect(isDraining()).toBe(true);
  expect((await healthRoutes.request('/ready')).status).toBe(503);
  expect((await healthRoutes.request('/live')).status).toBe(200);
  expect(await (await fetch(url)).text()).toBe('still serving');
  expect(closeResources).not.toHaveBeenCalled();
  release();
  expect(await (await slow).text()).toBe('completed');
  expect(await shutdown).toBe(true);
  expect(server.listening).toBe(false);
  expect(closeResources).toHaveBeenCalledOnce();
});

describe('shutdown deadline', () => {
  it('forces termination when a dependency never settles', async () => {
    const force = vi.fn();
    expect(await finishWithin(() => new Promise(() => undefined), 20, force)).toBe(false);
    expect(force).toHaveBeenCalledOnce();
  });
  it('propagates shutdown failures instead of reporting success', async () => {
    await expect(
      finishWithin(async () => {
        throw new Error('close failed');
      }, 100),
    ).rejects.toThrow('close failed');
  });
});

it('closes a hung HTTP request when the shutdown deadline expires', async () => {
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer(() => entered());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const request = fetch(`http://127.0.0.1:${address.port}`).catch(() => null);
  await started;
  expect(
    await drainHttpServer(server, {
      drainMs: 0,
      timeoutMs: 30,
      closeResources: async () => undefined,
    }),
  ).toBe(false);
  expect(await request).toBeNull();
  expect(server.listening).toBe(false);
});

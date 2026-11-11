/**
 * Cross-origin access to `/api`, which exists for exactly one caller shape.
 *
 * `cors.test.ts` fences the old rule: `/api` answers no cross-origin caller at
 * all. That rule has been narrowed rather than dropped — the API now answers a
 * configured origin, and only ever as a bearer caller. The distinction is the
 * whole security argument, and it lives in one header that must never appear.
 *
 * These run without a database on purpose. The property under test is a header
 * on a refusal, and a suite that needs Postgres to check a header is a suite
 * that does not run on the laptop where the mistake gets made.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { crossOriginAccess } from './cors.js';
import { loadEnv, setEnvForTesting } from './env.js';
import type { AppEnv } from './http.js';

function appWith(origins: string): Hono<AppEnv> {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'x'.repeat(48),
      NODE_ENV: 'test',
      PUBLIC_URL: 'https://onmyradar.io',
      CORS_ALLOWED_ORIGINS: origins,
    }),
  );
  const app = new Hono<AppEnv>();
  app.use('*', crossOriginAccess());
  app.get('/api/radars', (c) => c.json({ radars: [] }));
  app.get('/api/v1/radars', (c) => c.json({ radars: [] }));
  return app;
}

const APP = 'https://app.onmyradar.io';
const EVIL = 'https://evil.example';

describe('cross-origin access to /api', () => {
  beforeEach(() => setEnvForTesting(null));

  it('answers no cross-origin caller when no origins are configured', async () => {
    const res = await appWith('').request('/api/radars', { headers: { origin: APP } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes a configured origin, and never a wildcard', async () => {
    const res = await appWith(APP).request('/api/radars', { headers: { origin: APP } });
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('refuses an origin that is not on the list', async () => {
    const res = await appWith(APP).request('/api/radars', { headers: { origin: EVIL } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  /**
   * The one that matters. `Access-Control-Allow-Credentials` is what would turn
   * a bearer-only allowance back into "any page you visit can act as you", and
   * it must be absent on every path: allowed, refused, and preflight alike.
   */
  it('never sends allow-credentials, on any answer', async () => {
    const app = appWith(APP);
    for (const init of [
      { headers: { origin: APP } },
      { headers: { origin: EVIL } },
      { method: 'OPTIONS', headers: { origin: APP } },
      { method: 'OPTIONS', headers: { origin: EVIL } },
    ]) {
      const res = await app.request('/api/radars', init);
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('answers a preflight for a configured origin', async () => {
    const res = await appWith(APP).request('/api/radars', {
      method: 'OPTIONS',
      headers: { origin: APP },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  /**
   * A response that differs by origin and does not say so is a cache waiting to
   * serve one caller's answer to another. Set on the refusal too, because the
   * refusal is the response that would be poisoned.
   */
  it('varies on origin whether or not the origin is allowed', async () => {
    for (const [origins, origin] of [
      [APP, APP],
      [APP, EVIL],
      ['', APP],
    ] as const) {
      const res = await appWith(origins).request('/api/radars', { headers: { origin } });
      expect(res.headers.get('vary')).toContain('origin');
    }
  });

  it('covers the versioned prefix too', async () => {
    const res = await appWith(APP).request('/api/v1/radars', { headers: { origin: APP } });
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
  });
});

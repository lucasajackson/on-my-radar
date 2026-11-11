/**
 * The versioned mount, and the two ways it could be wrong without anybody
 * noticing.
 *
 * A router mounted at one prefix and not the other is a client that 404s on
 * paths the documentation promises. Worse, a versioned path that falls through
 * to the SPA fallback answers `200 text/html` -- a React shell, which reads to a
 * machine as a request that succeeded and then said nothing. That failure mode
 * is why `/mcp` and `/.well-known` were carved out of the fallback already; the
 * version segment joins them by being under `/api/`, and this pins it.
 *
 * No database: every assertion here is about routing, and each path answers
 * before it would reach one.
 */
import { describe, expect, it } from 'vitest';
import { API_V1 } from '@onmyradar/contract';
import { createApp } from './app.js';

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
process.env['DATABASE_URL'] ??= 'postgres://unused';

const app = createApp();

/** One authenticated path per router, chosen so each refuses before any query. */
const AUTHENTICATED = [
  '/radars',
  '/topics',
  '/blips',
  '/dashboards',
  '/notifications/counts',
  '/tokens',
];

describe('the versioned API', () => {
  it('answers every router under both prefixes, with the same status', async () => {
    for (const path of AUTHENTICATED) {
      const plain = await app.request(`/api${path}`);
      const versioned = await app.request(`${API_V1}${path}`);
      expect(plain.status, `/api${path}`).toBe(401);
      expect(versioned.status, `${API_V1}${path}`).toBe(401);
    }
  });

  it('never lets a versioned path reach the SPA fallback', async () => {
    for (const path of [...AUTHENTICATED, '/nope', '/radars/does-not-exist']) {
      const res = await app.request(`${API_V1}${path}`);
      expect(res.headers.get('content-type') ?? '', `${API_V1}${path}`).not.toMatch(/text\/html/);
    }
  });

  it('answers a versioned unknown path as JSON, not as a React shell', async () => {
    const res = await app.request(`${API_V1}/definitely-not-a-router`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });

  it('serves the unauthenticated routers under the version too', async () => {
    // A bad invite token is a 404 from the router; a 404 from the *fallback*
    // would be HTML. The distinction is the point.
    const res = await app.request(`${API_V1}/invites/nonexistent-token`);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
  });
});

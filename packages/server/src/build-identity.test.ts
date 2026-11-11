import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadEnv, setEnvForTesting } from './env.js';

it('serves build identity without caching in the API-hosted UI fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omr-build-identity-'));
  try {
    await writeFile(join(dir, 'build.json'), JSON.stringify({ buildSha: 'local-test-sha' }));
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgresql://unused/test',
        SESSION_SECRET: 'build-test-only-secret-with-at-least-32-characters',
        UI_DIST_DIR: dir,
      }),
    );
    const response = await createApp().request('/build.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.json()).toEqual({ buildSha: 'local-test-sha' });
  } finally {
    await rm(dir, { recursive: true, force: true });
    setEnvForTesting(null);
  }
});

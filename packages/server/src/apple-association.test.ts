import { afterEach, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadEnv, setEnvForTesting } from './env.js';

afterEach(() => setEnvForTesting(null));
it('serves Apple association JSON without an installed UI or session', async () => {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'x'.repeat(48),
      NODE_ENV: 'test',
    }),
  );
  const response = await createApp().request('/.well-known/apple-app-site-association');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const body = (await response.json()) as {
    applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, string>> }> };
  };
  expect(body.applinks.details).toEqual([
    {
      appIDs: ['6BUHQ4F5AN.io.onmyradar.app'],
      components: [{ '/': '/radar/*' }, { '/': '/topic/*' }, { '/': '/notifications' }],
    },
  ]);
});

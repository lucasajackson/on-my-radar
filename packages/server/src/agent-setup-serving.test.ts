/**
 * https://onmyradar.io/agent-setup/ when the API serves the UI bundle itself
 * (docs/AGENT_REPO.md §V2.18). nginx is checked by scripts/check-ui-serving.sh;
 * this is the same contract for the other server.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadEnv, setEnvForTesting } from './env.js';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omr-agent-setup-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>SPA shell</title>');
  await mkdir(join(dir, 'agent-setup'));
  await writeFile(join(dir, 'agent-setup', 'prompt.md'), '# Set up On My Radar\n');
  await writeFile(join(dir, 'agent-setup', 'omr-agent.mjs'), 'console.log(1);\n');
  await writeFile(join(dir, 'agent-setup', 'marketplace.json'), '{"name":"onmyradar"}\n');
  await writeFile(join(dir, 'agent-setup', 'SHA256SUMS'), 'abc  omr-agent.mjs\n');
  await writeFile(join(dir, 'agent-setup', 'omr-plugin-0.3.0-abcdef012345.zip'), 'PK');
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgresql://unused/test',
      SESSION_SECRET: 'agent-setup-test-only-secret-with-32-characters',
      UI_DIST_DIR: dir,
    }),
  );
});

afterAll(async () => {
  setEnvForTesting(null);
  await rm(dir, { recursive: true, force: true });
});

it.each([
  ['prompt.md', 'text/markdown; charset=utf-8', 'no-cache', '# Set up On My Radar\n'],
  ['omr-agent.mjs', 'text/javascript; charset=utf-8', 'no-cache', 'console.log(1);\n'],
  ['marketplace.json', 'application/json; charset=utf-8', 'no-cache', '{"name":"onmyradar"}\n'],
  ['SHA256SUMS', 'text/plain; charset=utf-8', 'no-cache', 'abc  omr-agent.mjs\n'],
  [
    'omr-plugin-0.3.0-abcdef012345.zip',
    'application/zip',
    'public, max-age=31536000, immutable',
    'PK',
  ],
])('serves /agent-setup/%s as %s, cache %s', async (file, type, cache, body) => {
  const response = await createApp().request(`/agent-setup/${file}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(type);
  expect(response.headers.get('cache-control')).toBe(cache);
  expect(await response.text()).toBe(body);
});

it.each(['missing.mjs', 'notes.txt', '..%2Findex.html', '.hidden.md', 'a/b.md', ''])(
  'answers /agent-setup/%s with a 404, never the SPA shell',
  async (file) => {
    const response = await createApp().request(`/agent-setup/${file}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA shell');
  },
);

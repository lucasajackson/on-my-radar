/**
 * /agent-setup/ stamped at runtime from PUBLIC_URL (AGENT_SETUP_SRC), the way the
 * public image serves it. The origin is configuration: it ends up as the CLI's
 * DEFAULT_ORIGIN, the only host `omr-agent` sends credentials to, so a request's
 * Host header must never reach it.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentSetupFiles, resetAgentSetupForTesting } from './agent-setup.js';
import { createApp } from './app.js';
import { loadEnv, setEnvForTesting } from './env.js';
import type { Actor } from './http.js';
import { staleBridgeHint } from './services/agent-memory.js';
import { must } from './errors.js';

const SRC = fileURLToPath(new URL('../../../agent-setup', import.meta.url));
const ORIGIN = 'https://omr.example.test';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let ui = '';

const configure = (overrides: Record<string, string | undefined> = {}) => {
  resetAgentSetupForTesting();
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgresql://unused/test',
      SESSION_SECRET: 'agent-setup-test-only-secret-with-32-characters',
      UI_DIST_DIR: ui,
      PUBLIC_URL: ORIGIN,
      AGENT_SETUP_SRC: SRC,
      ...overrides,
    }),
  );
};

const get = async (file: string, init?: RequestInit) => {
  const response = await createApp().request(`/agent-setup/${file}`, init);
  expect(response.status, file).toBe(200);
  return response;
};

beforeAll(async () => {
  ui = await mkdtemp(join(tmpdir(), 'omr-agent-setup-runtime-'));
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>SPA shell</title>');
});

afterEach(() => resetAgentSetupForTesting());

afterAll(async () => {
  setEnvForTesting(null);
  await rm(ui, { recursive: true, force: true });
});

describe('runtime stamping from PUBLIC_URL', () => {
  it('stamps one origin through prompt, CLI, marketplace, zip and SHA256SUMS', async () => {
    configure();
    const prompt = await (await get('prompt.md')).text();
    expect(prompt).toContain(`${ORIGIN}/agent-setup/omr-agent.mjs`);
    expect(prompt).not.toMatch(/onmyradar\.io|localhost/);

    const cli = await (await get('omr-agent.mjs')).text();
    expect(cli).toMatch(/^export const DEFAULT_ORIGIN = 'https:\/\/omr\.example\.test';$/m);

    const market = (await (await get('marketplace.json')).json()) as {
      plugins: { source: { url: string; sha256: string } }[];
    };
    const { url, sha256 } = must(market.plugins[0]).source;
    expect(url.startsWith(`${ORIGIN}/agent-setup/omr-plugin-`)).toBe(true);
    const zip = new Uint8Array(await (await get(must(url.split('/').pop()))).arrayBuffer());
    expect(sha(zip)).toBe(sha256);

    const sums = (await (await get('SHA256SUMS')).text()).trim().split('\n');
    expect(sums).toHaveLength(3);
    for (const line of sums) {
      const [digest, name] = line.split(/\s+/) as [string, string];
      expect(sha(new Uint8Array(await (await get(name)).arrayBuffer())), name).toBe(digest);
    }
  });

  it('serves exactly what the nginx build writes for onmyradar.io', async () => {
    configure({ PUBLIC_URL: 'https://onmyradar.io/' });
    const build = (await import(pathToFileURL(join(SRC, 'build-plugin.mjs')).href)) as {
      buildSite(opts: { out: string; baseUrl: string }): { files: string[] };
    };
    const out = await mkdtemp(join(tmpdir(), 'omr-nginx-build-'));
    try {
      const { files } = build.buildSite({ out, baseUrl: 'https://onmyradar.io/agent-setup' });
      expect(files).toHaveLength(5);
      const mem = await must(agentSetupFiles());
      expect([...mem.keys()].sort()).toEqual([...files].sort());
      for (const name of files) {
        const served = Buffer.from(await (await get(name)).arrayBuffer());
        expect(served.equals(await readFile(join(out, name))), name).toBe(true);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('takes the origin from config, never from the request Host', async () => {
    configure();
    for (const file of ['prompt.md', 'omr-agent.mjs', 'marketplace.json']) {
      const response = await createApp().request(`http://evil.example/agent-setup/${file}`, {
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
      });
      const body = await response.text();
      expect(body, file).toContain(ORIGIN);
      expect(body, file).not.toContain('evil.example');
    }
  });

  it('keeps the same types, cache rules and 404s as the disk route', async () => {
    configure();
    const prompt = await get('prompt.md');
    expect(prompt.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(prompt.headers.get('cache-control')).toBe('no-cache');
    expect((await get('SHA256SUMS')).headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const name = (await (await get('SHA256SUMS')).text()).match(/omr-plugin-\S+\.zip/)?.[0] ?? '';
    const zip = await get(name);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const file of ['missing.mjs', 'omr-plugin-9.9.9-000000000000.zip', 'notes.txt']) {
      const response = await createApp().request(`/agent-setup/${file}`);
      expect(response.status, file).toBe(404);
      expect(await response.text()).not.toContain('SPA shell');
    }
  });

  it('builds once, lazily, and does not remember a failure', async () => {
    configure({ AGENT_SETUP_SRC: join(ui, 'missing') });
    expect(() => createApp(), 'a bad source must not stop boot').not.toThrow();
    expect((await createApp().request('/agent-setup/prompt.md')).status).toBe(500);
    configure();
    const first = agentSetupFiles();
    expect(first).toBe(agentSetupFiles());
    expect((await createApp().request('/agent-setup/prompt.md')).status).toBe(200);
  });

  it('leaves the disk route alone when AGENT_SETUP_SRC is unset', async () => {
    configure({ AGENT_SETUP_SRC: undefined });
    expect(agentSetupFiles()).toBeNull();
    expect((await createApp().request('/agent-setup/prompt.md')).status).toBe(404);
  });
});

describe('the stale omr-agent notice', () => {
  const stale = { connection: { kind: 'oauth', id: 'c', label: 'omr-agent on mac' } } as Actor;

  it('points at this deployment, not onmyradar.io', () => {
    configure();
    const hint = must(staleBridgeHint(stale));
    expect(hint).toContain(`follow ${ORIGIN}/agent-setup/prompt.md`);
    expect(hint).not.toContain('onmyradar.io');
  });
});

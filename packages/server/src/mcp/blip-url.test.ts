/** C4: every card has a stable app link, returned beside the blip over MCP and REST, never to a stranger. */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { createSession } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar } from '../services/radars.js';
import { httpTransport } from './test-client.js';

describe.skipIf(!process.env['DATABASE_URL'])('blip app url', () => {
  const database = `omr_blip_url_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let base: string;
  let owner: Actor;
  let radarId: string;
  let cookie: string;
  let strangerCookie: string;
  let mcp: Client;

  const user = async (name: string) =>
    must(
      (
        await getDb()
          .insert(schema.users)
          .values({ name, email: `${name}-${randomUUID()}@example.test`, state: 'active' })
          .returning()
      )[0],
    );
  async function rest(method: string, path: string, session: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: session },
      body: body === undefined ? null : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  async function tool(name: string, args: Record<string, unknown>) {
    const result = await mcp.callTool({ name, arguments: args });
    const text = must(
      (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
        ?.text,
    );
    return JSON.parse(text) as Record<string, unknown>;
  }

  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'blip-url-synthetic-session-secret-1',
        PUBLIC_URL: 'http://localhost:3500',
        APP_URL: 'https://app.example.test',
      }),
    );
    await runMigrations();
    owner = { user: await user('owner'), kind: 'user' };
    cookie = `omr_session=${(await createSession(owner.user)).token}`;
    strangerCookie = `omr_session=${(await createSession(await user('stranger'))).token}`;
    radarId = (await createRadar(owner, { name: 'Linked' })).id;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;
    const secret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: owner.user.id,
        name: 'url',
        prefix: tokenPrefix(secret),
        tokenHash: hashSecret(secret),
        scope: 'radars:read radars:write',
      });
    mcp = new Client({ name: 'blip-url', version: '1' });
    await mcp.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await mcp.close();
    if (listener) await new Promise<void>((resolve) => must(listener).close(() => resolve()));
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  const address = (id: string) => `https://app.example.test/radar/${radarId}/blip/${id}`;

  it('returns the address from create and get, over REST and MCP', async () => {
    const made = await rest('POST', `/radars/${radarId}/blips`, cookie, { body: 'rest card' });
    const restId = (made.json['blip'] as { id: string }).id;
    expect(made.json['url']).toBe(address(restId));
    expect((await rest('GET', `/blips/${restId}`, cookie)).json['url']).toBe(address(restId));

    const viaMcp = await tool('create_blip', { radarId, body: 'mcp card' });
    expect(viaMcp['appUrl']).toBe(address(viaMcp['id'] as string));
    const read = await tool('get_blip', { blipId: viaMcp['id'] });
    expect(read['appUrl']).toBe(address(viaMcp['id'] as string));
  });

  it('keeps the card link in `url` when the blip carries its own', async () => {
    const id = (await createBlip(owner, radarId, { body: 'https://example.com/page' })).id;
    const read = await tool('get_blip', { blipId: id });
    expect(read['url']).toBe('https://example.com/page');
    expect(read['appUrl']).toBe(address(id));
  });

  it('gives a stranger the normal not-found, with no address', async () => {
    const id = (await createBlip(owner, radarId, { body: 'private' })).id;
    const res = await rest('GET', `/blips/${id}`, strangerCookie);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.json)).not.toContain(radarId);
  });
});

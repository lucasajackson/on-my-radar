/**
 * One `/mcp` (blip 7f5a655c): every credential, a person's or an agent's, gets the same full tool
 * list, and `/mcp/collab` is gone. Over real HTTP on an isolated database.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar } from '../services/radars.js';
import { createRepoAgent } from '../services/repo-agents.js';
import { createToken } from '../services/tokens.js';
import { httpTransport } from './test-client.js';

type Content = Array<{ type: string; text?: string }>;

describe.skipIf(!process.env['DATABASE_URL'])('one /mcp for agents and for people', () => {
  const database = `omr_single_mcp_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let base: URL;
  const clients: Client[] = [];
  let owner: Actor;
  let radarId = '';
  let agentId = '';
  let pat = '';
  let agentPat = '';
  let agentOauth = '';

  async function connect(token: string, path = '/mcp') {
    const client = new Client({ name: 'single-mcp-test', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(new URL(path, base), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }
  const text = (result: object) =>
    (result as { content: Content }).content.map((block) => block.text ?? '').join('\n');
  const names = async (token: string) =>
    (await (await connect(token)).listTools()).tools.map((t) => t.name).sort();
  const oauth = async (agent: string | null) => {
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_single_mcp',
        userId: owner.user.id,
        scope: 'radars:read',
        scopeConsented: true,
        agentId: agent,
        agentBound: agent !== null,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    return access;
  };

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
        SESSION_SECRET: 'single-mcp-test-secret-not-used-anywhere-else',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const [row] = await getDb()
      .insert(schema.users)
      .values({ email: 'owner@single-mcp.test', state: 'active', name: 'owner' })
      .returning();
    owner = { user: must(row), kind: 'user' };
    radarId = (await createRadar(owner, { name: 'Single mcp radar' })).id;
    await createBlip(owner, radarId, { body: 'zebra for the agent tools test' });
    agentId = (await createRepoAgent(owner, { name: 'Slim', slug: 'slim' })).id;
    pat = must((await createToken(owner, { name: 'person pat' })).token);
    agentPat = must((await createToken(owner, { name: 'agent pat', agentId })).token);
    agentOauth = await oauth(agentId);
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = new URL(`http://127.0.0.1:${address.port}`);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    const open = listener;
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    await closeDb();
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('lists the same full tools to a person and to an agent, by PAT or OAuth grant', async () => {
    const full = await names(pat);
    expect(full.length).toBeGreaterThan(90);
    expect(await names(agentPat)).toEqual(full);
    expect(await names(agentOauth)).toEqual(full);
    expect(await names(await oauth(null))).toEqual(full);
    const instructions = (await connect(pat)).getInstructions();
    expect((await connect(agentPat)).getInstructions()).toBe(instructions);
  });

  it('lets an agent call a tool a slim list would have hidden', async () => {
    const client = await connect(agentPat);
    expect(text(await client.callTool({ name: 'list_arrays', arguments: {} }))).not.toMatch(
      /not found/i,
    );
  });

  it('has no /mcp/collab, and /mcp challenges at its own resource', async () => {
    const post = (path: string) =>
      fetch(new URL(path, base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const challenged = await post('/mcp');
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://localhost:3500/.well-known/oauth-protected-resource"',
    );
    expect((await post('/mcp/collab')).status).toBe(404);
    expect(
      (await fetch(new URL('/.well-known/oauth-protected-resource/mcp/collab', base))).status,
    ).toBe(404);
  });
});

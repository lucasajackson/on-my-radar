/**
 * Prompts and resources run inside the same error boundary as tools.
 *
 * `guard` wraps every tool, but the prompt and resource callbacks called the
 * services bare, so whatever they threw went back through the SDK as the
 * JSON-RPC error message. `prompts/get` with an agent name containing a NUL
 * reached Postgres, and Drizzle's error — the SQL and its parameters — was
 * handed to the client verbatim.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createRepoAgent } from '../services/repo-agents.js';
import { httpTransport } from './test-client.js';

describe.skipIf(!process.env['DATABASE_URL'])('MCP prompt and resource errors', () => {
  const database = `omr_mcp_boundary_${Date.now()}`;
  let admin: pg.Pool;
  let listener: ReturnType<typeof serve>;
  let client: Client;
  let owner: Actor;

  beforeAll(async () => {
    const connection = process.env['DATABASE_URL'] ?? '';
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'mcp-boundary-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: 'owner@mcp-boundary.test', state: 'active', name: 'owner' })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    owner = { user, kind: 'user' };
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_boundary',
        userId: user.id,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    client = new Client({ name: 'boundary-test', version: '1' });
    await client.connect(
      httpTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await closeDb();
    setEnvForTesting(null);
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  const failure = async (call: () => Promise<unknown>): Promise<string> => {
    try {
      await call();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected the call to fail');
  };

  it('never returns SQL or parameters from a prompt', async () => {
    const message = await failure(() =>
      client.getPrompt({ name: 'agent', arguments: { agent: 'bad\u0000agent' } }),
    );
    expect(message).not.toMatch(/select|from "|params|Failed query/i);
    expect(message).toMatch(/failed on the server/);
  });

  it('answers a malformed resource argument in a sentence, not a validation dump', async () => {
    await createRepoAgent(owner, { name: 'Named', slug: 'named' });
    const message = await failure(() =>
      client.readResource({ uri: 'onmyradar://agents/named/memories/Not_Kebab' }),
    );
    // A thrown ZodError's message is its issues as JSON.
    expect(message).not.toMatch(/"code":|"path":/);
    expect(message).toMatch(/kebab-case/);
  });

  it('keeps the deliberate refusals, which are written to be read', async () => {
    expect(
      await failure(() => client.getPrompt({ name: 'agent', arguments: { agent: 'no-such' } })),
    ).toMatch(/Agent not found/);
    const agent = await createRepoAgent(owner, { name: 'Boundary', slug: 'boundary' });
    expect(
      await failure(() =>
        client.readResource({ uri: `onmyradar://agents/${agent.slug}/memories/missing` }),
      ),
    ).toMatch(/Memory not found/);
    // Control: a good read still works.
    const ok = await client.readResource({ uri: 'onmyradar://radars' });
    expect(ok.contents).toHaveLength(1);
  });
});

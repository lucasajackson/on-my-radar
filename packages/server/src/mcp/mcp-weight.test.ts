/** S4: agent reactions are the agent's, and heavy MCP answers are lean. Real MCP HTTP, real PG. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Voice } from '@onmyradar/contract';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar, setVisibility, shareRadar } from '../services/radars.js';
import { createRepoAgent } from '../services/repo-agents.js';
import { httpTransport } from './test-client.js';

type Tally = { reaction: string; count: number; agents?: string[]; mine: boolean };

describe.skipIf(!process.env['DATABASE_URL'])('MCP weight and agent reactions', () => {
  const database = `omr_mcp_weight_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let endpoint: URL;
  let owner: Actor;
  let client: Client;
  const clients: Client[] = [];

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    const text = must((result.content as Array<{ text?: string }>)[0]?.text);
    expect(result.isError, text).not.toBe(true);
    return JSON.parse(text) as T;
  }
  async function session(agentId: string) {
    const result = await client.callTool({
      name: 'load_agent',
      arguments: { agent: agentId, harness: 'codex' },
    });
    const blocks = result.content as Array<{ text?: string }>;
    return (JSON.parse(must(must(blocks[blocks.length - 1]).text)) as { session: string }).session;
  }

  async function connectAs(actor: Actor, agentId?: string) {
    const secret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: actor.user.id,
        name: 'weight-agent',
        prefix: tokenPrefix(secret),
        tokenHash: hashSecret(secret),
        scope: 'radars:read radars:write radars:manage',
        ...(agentId
          ? {
              agentId,
              voiceGrants: ['persona', 'principal'] as Voice[],
              defaultVoice: 'principal' as Voice,
            }
          : {}),
      });
    const c = new Client({ name: 'mcp-weight-agent', version: '1' });
    clients.push(c);
    await c.connect(
      httpTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${secret}` } } }),
    );
    return c;
  }
  async function userNamed(name: string) {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ name, email: `w-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    return { user: must(user), kind: 'user' } as Actor;
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
        SESSION_SECRET: 'mcp-weight-synthetic-session-secret',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ name: 'Lucas', email: `weight-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const secret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: owner.user.id,
        name: 'weight',
        prefix: tokenPrefix(secret),
        tokenHash: hashSecret(secret),
        scope: 'radars:read radars:write radars:manage',
      });
    client = new Client({ name: 'mcp-weight', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${secret}` } } }),
    );
  }, 30000);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    if (listener) await new Promise<void>((resolve) => must(listener).close(() => resolve()));
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('keeps an agent’s and the person’s 👀 apart, each attributed, and the old pod’s insert valid', async () => {
    const radar = await createRadar(owner, { name: `Weight ${randomUUID()}` });
    const blip = await createBlip(owner, radar.id, { body: 'look at this' });
    const agent = await createRepoAgent(owner, { name: `Eyes ${randomUUID()}`, prompt: 'p' });
    const s = await session(agent.id);

    await call('react_to_blip', { blipId: blip.id, reaction: 'thinking' });
    const both = await call<{ reactions: Tally[] }>('react_to_blip', {
      blipId: blip.id,
      reaction: 'thinking',
      session: s,
    });
    expect(both.reactions).toHaveLength(1);
    expect(both.reactions[0]).toMatchObject({ count: 2, agents: [agent.name], mine: true });

    // The previous image: targetless ON CONFLICT DO NOTHING, no agent_id. Still one person's mark.
    const old = await getDb().execute(
      sql`INSERT INTO blip_reactions (blip_id, user_id, reaction, radar_id)
          VALUES (${blip.id}, ${owner.user.id}, 'thinking', ${radar.id}) ON CONFLICT DO NOTHING`,
    );
    expect(old.rowCount).toBe(0);

    const off = await call<{ reactions: Tally[] }>('react_to_blip', {
      blipId: blip.id,
      reaction: 'thinking',
      on: false,
      session: s,
    });
    expect(off.reactions[0]).toMatchObject({ count: 1, mine: false });
    expect(off.reactions[0]?.agents).toBeUndefined();
  });

  it('re-runs 0101 harmlessly', async () => {
    const migration = readFileSync(
      new URL('../../drizzle/0101_reaction_agent.sql', import.meta.url),
      'utf8',
    );
    await getDb().execute(sql.raw(migration));
    await runMigrations();
  });

  it('answers list_capabilities in a summary under 12K chars, keeping every old key’s type', async () => {
    const summary = await client.callTool({ name: 'list_capabilities', arguments: {} });
    const text = must((summary.content as Array<{ text?: string }>)[0]?.text);
    expect(text.length).toBeLessThanOrEqual(12_000);
    const guide = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['scope', 'search', 'dashboards'])
      expect(typeof guide[key], key).toBe('string');
    expect(Array.isArray(guide['humanOnly'])).toBe(true);
    expect((guide['humanOnly'] as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(guide['endpoints'])).toBe(true);
    const full = await call<{ endpoints: { route: string }[] }>('list_capabilities', {
      section: 'endpoints',
    });
    expect(full.endpoints.length).toBeGreaterThan(50);
    expect(typeof full.endpoints[0]?.route).toBe('string');
  });

  it('lists agents flat with the old keys, naming two owners called Alex apart', async () => {
    const alexA = await userNamed('Alex');
    const alexB = await userNamed('Alex');
    const radar = await createRadar(alexA, { name: `Alex ${randomUUID()}` });
    await shareRadar(alexA, radar.id, alexB.user.email, 'viewer');
    await createRepoAgent(alexA, { name: 'Claude', prompt: 'p' });
    await createRepoAgent(alexB, { name: 'Claude', prompt: 'p' });
    await createRepoAgent(alexB, { name: 'Codex', prompt: 'p' });
    const c = await connectAs(alexA);
    const result = await c.callTool({
      name: 'list_radar_members',
      arguments: { radarId: radar.id },
    });
    const members = JSON.parse(must((result.content as Array<{ text?: string }>)[0]?.text)) as {
      agents: { name: string; mention: string; handles: string[]; actsFor: string }[];
    };
    expect(Array.isArray(members.agents)).toBe(true);
    for (const a of members.agents) {
      expect(Object.keys(a).sort()).toEqual(['actsFor', 'handles', 'mention', 'name']);
      expect(typeof a.name).toBe('string');
      expect(typeof a.mention).toBe('string');
      expect(a.handles.every((h) => typeof h === 'string')).toBe(true);
      expect(a.actsFor).toBe('Alex');
    }
    const claudes = members.agents.filter((a) => a.name === 'Claude');
    expect(claudes).toHaveLength(2);
    // Same bare handle on both, so it resolves to neither: each keeps its full list, including an
    // alias the other lacks, which is the one that still resolves uniquely.
    const [one, two] = claudes;
    expect(one?.handles.some((h) => !two?.handles.includes(h))).toBe(true);
    expect(two?.handles.some((h) => !one?.handles.includes(h))).toBe(true);
    expect(one?.handles.length).toBeGreaterThan(2);
    const codex = members.agents.find((a) => a.name === 'Codex');
    expect(codex?.handles.length).toBeGreaterThan(2);
  });

  it('marks `mine` for a reading agent as the agent’s own mark, on get_blip and read_radar', async () => {
    const radar = await createRadar(owner, { name: `Mine ${randomUUID()}` });
    const blip = await createBlip(owner, radar.id, { body: 'whose mark' });
    const agent = await createRepoAgent(owner, { name: `Reader ${randomUUID()}`, prompt: 'p' });
    const agentClient = await connectAs(owner, agent.id);
    await call('react_to_blip', { blipId: blip.id, reaction: 'up' }); // the person's own
    // read_radar and get_blip summarise a mark as "up 👍 1 (incl. you)" or as a Tally.
    const isMine = (r: Tally | string | undefined) =>
      typeof r === 'string' ? r.includes('(incl. you)') : r?.mine;
    const mineOf = async (c: Client) => {
      const got = await c.callTool({ name: 'get_blip', arguments: { blipId: blip.id } });
      const one = JSON.parse(must((got.content as Array<{ text?: string }>)[0]?.text)) as {
        reactions: (Tally | string)[];
      };
      const read = await c.callTool({ name: 'read_radar', arguments: { radarId: radar.id } });
      const page = JSON.parse(must((read.content as Array<{ text?: string }>)[0]?.text)) as {
        blips: { reactions?: (Tally | string)[] }[];
      };
      return [isMine(one.reactions[0]), isMine(page.blips[0]?.reactions?.[0])];
    };
    expect(await mineOf(client)).toEqual([true, true]);
    expect(await mineOf(agentClient)).toEqual([false, false]);
    // The agent-bound credential writes as the agent, so the same identity now reads as mine.
    await agentClient.callTool({
      name: 'react_to_blip',
      arguments: { blipId: blip.id, reaction: 'up' },
    });
    expect(await mineOf(agentClient)).toEqual([true, true]);
    expect(await mineOf(client)).toEqual([true, true]);
  });

  it('sends theme only when published, lanes either way, and the revision on create', async () => {
    const radar = await createRadar(owner, { name: `Lean ${randomUUID()}`, template: 'kanban' });
    const priv = await call<{ radar: Record<string, unknown>; lanes: unknown[] }>('read_radar', {
      radarId: radar.id,
    });
    expect(priv.radar).not.toHaveProperty('theme'); // unpublished and unthemed
    expect(priv.lanes.map((l) => (l as { id: string }).id)).toEqual([
      'backlog',
      'todo',
      'doing',
      'blocked',
      'done',
    ]);
    await setVisibility(owner, radar.id, 'public', false);
    const pub = await call<{ radar: Record<string, unknown>; lanes: unknown[] }>('read_radar', {
      radarId: radar.id,
    });
    expect(pub.radar).toHaveProperty('theme');
    // Lanes and their order do not depend on publishing.
    expect(pub.lanes).toEqual(priv.lanes);

    const made = await call<{ revision: number }>('create_blip', { radarId: radar.id, body: 'x' });
    expect(made.revision).toBe(1);
  });
});

/**
 * The Agent Repo over real MCP HTTP, on an isolated database: the tools, the
 * prompt and the resources exist and behave as a harness will see them — v2's
 * autonomy (a live prompt, bounded by the owner's lock), per-tool profiles,
 * writing under an agent's name through a load session, and a disconnect that
 * cannot be outrun by a refresh.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { httpTransport } from './test-client.js';
import pg from 'pg';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES, type NotificationKind } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar } from '../services/radars.js';
import { remember } from '../services/agent-memory.js';
import {
  acceptShare,
  createRepoAgent,
  setAgentEditsLive,
  setLocked,
  shareAgent,
} from '../services/repo-agents.js';
import { revokeGrant } from '../services/tokens.js';
import { must } from '../errors.js';

type Content = Array<{ type: string; text?: string }>;

describe.skipIf(!process.env['DATABASE_URL'])('the Agent Repo over MCP', () => {
  const database = `omr_mcp_agent_repo_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let endpoint: URL;
  const clients: Client[] = [];
  let owner: Actor;
  let stranger: Actor;
  let writer: Client;
  let outsider: Client;

  async function grant(actor: Actor, clientId: string, scope = TOKEN_SCOPES.join(' ')) {
    const access = randomToken(32);
    const refresh = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(refresh),
        clientId,
        userId: actor.user.id,
        scope,
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    return { access, refresh };
  }

  async function connect(actor: Actor, clientId: string) {
    const { access } = await grant(actor, clientId);
    const client = new Client({ name: 'agent-repo-test', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
      }),
    );
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, content: result.content as Content };
  }

  /** load_agent over the wire; returns the blocks and the session id from the last one. */
  async function load(client: Client, args: Record<string, unknown>) {
    const loaded = await client.callTool({ name: 'load_agent', arguments: args });
    const blocks = loaded.content as Content;
    expect(loaded.isError, must(blocks[0]).text).not.toBe(true);
    const { session } = JSON.parse(must(must(blocks[blocks.length - 1]).text)) as {
      session: string;
    };
    return { blocks, session, text: blocks.map((b) => b.text).join('') };
  }

  const json = (result: { content: Content }): unknown =>
    JSON.parse(must(must(result.content[0]).text));

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
        SESSION_SECRET: 'agent-repo-mcp-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    for (const label of ['owner', 'stranger']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@agent-repo-mcp.test`, state: 'active', name: label })
        .returning();
      if (label === 'owner') owner = { user: must(user), kind: 'user' };
      else stranger = { user: must(user), kind: 'user' };
    }
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    writer = await connect(owner, 'omr_agent_repo_writer');
    outsider = await connect(stranger, 'omr_agent_repo_outsider');
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    const openListener = listener;
    if (openListener) await new Promise<void>((resolve) => openListener.close(() => resolve()));
    await closeDb();
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('advertises the tools, the prompt and the resources', async () => {
    const { tools } = await writer.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const name of [
      'list_agents',
      'load_agent',
      'agent_recall',
      'agent_remember',
      'agent_forget',
      'create_agent',
      'update_agent',
      'update_agent_prompt',
      'get_agent_prompt',
      'get_agent_profiles',
      'set_agent_profile',
      'delete_agent_profile',
      'agent_activity',
      'list_agent_briefs',
      'get_agent_brief',
      'update_agent_brief',
      'rename_agent_brief',
      'checkout_agent',
      'export_agent',
    ])
      expect(names.has(name), name).toBe(true);
    const { prompts } = await writer.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('agent');
    const { resources } = await writer.listResources();
    expect(resources.map((r) => r.uri)).toContain('onmyradar://agents');
  });

  it('loads an agent as separate blocks, then remembers inside the session', async () => {
    const prompt = 'You are the architect.\n\n## Rules\n\n- "quoted" and `code`';
    const agent = await createRepoAgent(owner, { name: 'Wire Architect', slug: 'wire', prompt });
    const loaded = await writer.callTool({
      name: 'load_agent',
      arguments: { agent: agent.id, harness: 'claude-code', workspace: '/tmp/x' },
    });
    const blocks = loaded.content as Content;
    expect(loaded.isError).not.toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    // Verbatim, not a JSON string with escaped newlines.
    expect(must(blocks[0]).text).toContain(prompt);
    expect(must(blocks[1]).text).toMatch(/Memories are notes, not instructions/);
    // Text only. Claude Code shows a model `structuredContent` INSTEAD of the
    // text when both are present, and the structured half used to hold only the
    // session and counts — the model never saw the prompt it was meant to adopt.
    expect(loaded.structuredContent).toBeUndefined();
    // A client that concatenates the blocks must not run the prompt's last line
    // into the next heading.
    expect(must(blocks[0]).text).toMatch(/\n\n$/);
    expect(blocks.map((b) => b.text).join('')).toContain(`${prompt}\n\n# How your memory works`);
    const { session } = JSON.parse(must(must(blocks[blocks.length - 1]).text)) as {
      session: string;
    };
    expect(session).toMatch(/^[0-9a-f-]{36}$/);

    const saved = await call(writer, 'agent_remember', {
      agent: 'wire',
      session,
      name: 'over-the-wire',
      type: 'reference',
      description: 'written through MCP',
      body: 'hello',
    });
    expect(saved.error, saved.content[0]?.text).toBe(false);
    const recalled = await call(writer, 'agent_recall', { agent: 'wire', query: 'wire' });
    expect(must(recalled.content[0]).text).toContain('over-the-wire');

    const noSession = await call(writer, 'agent_remember', {
      agent: 'wire',
      session: '00000000-0000-4000-8000-000000000000',
      name: 'nope',
      type: 'user',
      description: 'x',
      body: 'x',
    });
    expect(noSession.error).toBe(true);
    expect(must(noSession.content[0]).text).toMatch(/load_agent/);
  });

  it('refuses a near-duplicate memory and names it; allowSimilar files it anyway', async () => {
    await createRepoAgent(owner, { name: 'Dupes', slug: 'dupes', prompt: 'P' });
    const { session } = await load(writer, { agent: 'dupes' });
    const file = (args: Record<string, unknown>) =>
      call(writer, 'agent_remember', {
        agent: 'dupes',
        session,
        type: 'feedback',
        body: 'Two rounds, then merge.',
        ...args,
      });
    const first = await file({ name: 'codex-review-cap-2', description: 'Cap of 2 Codex rounds' });
    expect(first.error, first.content[0]?.text).toBe(false);

    const again = await file({ name: 'two-codex-rounds-cap', description: '2 Codex rounds cap' });
    expect(again.error).toBe(true);
    expect(must(again.content[0]).text).toMatch(/codex-review-cap-2.*revision 1.*allowSimilar/s);

    const unrelated = await file({ name: 'ui-select-lint', description: 'No native select' });
    expect(unrelated.error, unrelated.content[0]?.text).toBe(false);
    const forced = await file({
      name: 'two-codex-rounds-cap',
      description: '2 Codex rounds cap',
      allowSimilar: true,
    });
    expect(forced.error, forced.content[0]?.text).toBe(false);

    // A person in the browser (no load session) is not checked: sprawl is an agent problem.
    const person = await remember(owner, 'dupes', {
      mode: 'create',
      name: 'codex-cap-two-rounds',
      type: 'feedback',
      description: '2 Codex rounds cap',
      body: 'Written by a person.',
    });
    expect(person.created).toBe(true);
  });

  it('serves the prompt and resources, and hides a stranger’s agent', async () => {
    const agent = await createRepoAgent(owner, {
      name: 'Prompted',
      slug: 'prompted',
      prompt: 'P!',
    });
    const got = await writer.getPrompt({ name: 'agent', arguments: { agent: 'prompted' } });
    const text = (must(got.messages[0]).content as { text: string }).text;
    expect(text).toContain('P!');
    expect(text).toMatch(/Operate as the On My Radar agent `prompted`/);

    const read = await writer.readResource({ uri: 'onmyradar://agents/prompted' });
    expect((read.contents[0] as { text: string }).text).toContain('P!');

    const theirs = await call(outsider, 'load_agent', { agent: agent.id });
    expect(theirs.error).toBe(true);
    expect(must(theirs.content[0]).text).toBe('Agent not found');
    const listed = await call(outsider, 'list_agents', {});
    expect(must(listed.content[0]).text).not.toContain(agent.id);
  });

  it('names a shared agent by owner-email/slug, and never lets it answer to your own slug', async () => {
    const shared = await createRepoAgent(owner, { name: 'Shared', slug: 'twin', prompt: 'THEIRS' });
    await shareAgent(owner, shared.id, { email: stranger.user.email, preset: 'use' });
    // Shared is not yet running: a recipient reads it and accepts first (§V2.6).
    const early = await call(outsider, 'load_agent', { agent: `${owner.user.email}/twin` });
    expect(early.error).toBe(true);
    expect(must(early.content[0]).text).toMatch(/have not accepted it yet/);
    await acceptShare(stranger, shared.id);
    const listedShared = json(await call(outsider, 'list_agents', { view: 'shared' })) as Array<{
      id: string;
      role: string;
      access: { memory: string };
    }>;
    expect(listedShared.map((a) => [a.id, a.role, a.access.memory])).toEqual([
      [shared.id, 'shared', 'none'],
    ]);
    const own = await createRepoAgent(stranger, { name: 'Own', slug: 'twin', prompt: 'MINE' });
    const ref = `${owner.user.email}/twin`;

    const got = await outsider.getPrompt({ name: 'agent', arguments: { agent: ref } });
    expect((must(got.messages[0]).content as { text: string }).text).toContain('THEIRS');
    const completion = await outsider.complete({
      ref: { type: 'ref/prompt', name: 'agent' },
      argument: { name: 'agent', value: 'owner@' },
    });
    expect(completion.completion.values).toEqual([ref]);

    // Two agents called `twin`, two different URIs, each reading its own prompt.
    const { resources } = await outsider.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('onmyradar://agents/twin');
    expect(uris).toContain(`onmyradar://agents/${shared.id}`);
    const mine = await outsider.readResource({ uri: 'onmyradar://agents/twin' });
    expect((mine.contents[0] as { text: string }).text).toContain('MINE');
    const theirs = await outsider.readResource({ uri: `onmyradar://agents/${shared.id}` });
    expect((theirs.contents[0] as { text: string }).text).toContain('THEIRS');
    expect(own.ref).toBe('twin');
  });

  it('renders a checkout with hashes and no credential', async () => {
    const agent = await createRepoAgent(owner, { name: 'Checked', slug: 'checked' });
    const result = await call(writer, 'checkout_agent', {
      agent: agent.id,
      harness: 'claude-code',
    });
    const checkout = JSON.parse(must(must(result.content[0]).text)) as {
      operations: Array<{ path: string; op: string; sha256?: string; content?: string }>;
    };
    expect(checkout.operations.map((o) => o.path)).toEqual([
      '.omr/agent.json',
      '.omr/AGENT.md',
      'CLAUDE.md',
    ]);
    expect(must(checkout.operations[0]).sha256).toMatch(/^[0-9a-f]{64}$/);
    // No credential in anything written to the workspace. The connect
    // instructions name a token only as a placeholder the person fills in.
    const rendered = JSON.parse(must(must(result.content[0]).text)) as {
      operations: unknown[];
      connect: unknown;
    };
    expect(JSON.stringify(rendered.operations)).not.toMatch(/Bearer|omr_pat_|omr_[A-Za-z0-9]{16}/);
    expect(JSON.stringify(rendered.connect)).toContain('$OMR_TOKEN');
    expect(JSON.stringify(rendered.connect)).not.toMatch(/omr_pat_|omr_[A-Za-z0-9]{16}/);

    // Production, 2026-09-26: an agent guessed `agents_md` and the SDK refused
    // it at the tool boundary before the contract could fold it.
    const guessed = await call(writer, 'checkout_agent', { agent: agent.id, harness: 'agents_md' });
    expect(guessed.error, guessed.content[0]?.text).toBe(false);
    expect(must(guessed.content[0]).text).toContain('AGENTS.md');
    const codex = await call(writer, 'checkout_agent', { agent: agent.id, harness: 'codex-cli' });
    expect((json(codex) as { harness: string }).harness).toBe('codex');
    const helper = await call(writer, 'checkout_agent', {
      agent: agent.id,
      harness: 'claude_code',
      mode: 'subagent',
    });
    expect(helper.error, helper.content[0]?.text).toBe(false);
    expect(json(helper) as { mode: string; operations: Array<{ path: string }> }).toMatchObject({
      mode: 'helper',
      operations: [{ path: '.claude/agents/checked.md' }],
    });
    const unknown = await call(writer, 'checkout_agent', { agent: agent.id, harness: 'vim' });
    expect(unknown.error).toBe(true);
    expect(must(unknown.content[0]).text).toMatch(/Unknown tool 'vim'\. Use one of 'claude-code'/);
    const noHelper = await call(writer, 'checkout_agent', {
      agent: agent.id,
      harness: 'windsurf',
      mode: 'helper',
    });
    expect(noHelper.error).toBe(true);
  });

  it('forgets a memory by the id agent_recall returned', async () => {
    const agent = await createRepoAgent(owner, { name: 'Forgetful', slug: 'forgetful' });
    const loaded = await writer.callTool({ name: 'load_agent', arguments: { agent: agent.id } });
    const blocks = loaded.content as Content;
    const { session } = JSON.parse(must(must(blocks[blocks.length - 1]).text)) as {
      session: string;
    };
    await call(writer, 'agent_remember', {
      agent: agent.id,
      session,
      name: 'stale-fact',
      type: 'reference',
      description: 'wrong',
      body: 'wrong',
    });
    const recalled = await call(writer, 'agent_recall', { agent: agent.id, name: 'stale-fact' });
    const {
      memories: [memory],
    } = JSON.parse(must(must(recalled.content[0]).text)) as { memories: Array<{ id: string }> };
    const forgot = await call(writer, 'agent_forget', {
      agent: agent.id,
      session,
      id: must(memory).id,
      reason: 'it was wrong',
    });
    expect(forgot.error, forgot.content[0]?.text).toBe(false);
    const after = await call(writer, 'agent_recall', { agent: agent.id, name: 'stale-fact' });
    expect(json(after)).toMatchObject({ memories: [], nextCursor: null, total: 0 });
  });

  it('lists 25 agents compactly, and in full with detail', async () => {
    const description = 'Owns one product: plans, builds, reviews and ships it. '.repeat(6);
    for (let i = 0; i < 25; i++)
      await createRepoAgent(stranger, {
        name: `Roster ${i}`,
        slug: `roster-${i}`,
        description,
        prompt: 'p',
      });
    const compact = await call(outsider, 'list_agents', {});
    const rows = json(compact) as Array<Record<string, unknown>>;
    expect(rows.filter((r) => String(r['slug']).startsWith('roster-'))).toHaveLength(25);
    expect(must(compact.content[0]).text?.length).toBeLessThanOrEqual(10_000);
    const pick = (list: typeof rows) => must(list.find((r) => r['slug'] === 'roster-0'));
    expect(pick(rows)).not.toHaveProperty('memories');
    expect(pick(rows)).not.toHaveProperty('lastSession');
    const full = json(await call(outsider, 'list_agents', { detail: true })) as typeof rows;
    expect(pick(full)).toHaveProperty('memories');
    expect(pick(full)).toHaveProperty('lastSession');
    expect(String(pick(full)['description']).length).toBe(300);
    expect(String(pick(rows)['description']).length).toBe(80);
  });

  it('holds its own prompt edit for the owner, and lets a sibling’s edit through only once the owner opts in and until the owner locks it', async () => {
    const agent = await createRepoAgent(owner, {
      name: 'Self Editor',
      slug: 'self-editor',
      prompt: 'v1',
    });
    const { session } = await load(writer, { agent: agent.id, harness: 'claude-code' });
    const edited = await call(writer, 'update_agent_prompt', {
      agent: agent.id,
      body: 'v2 — sharper',
      basedOn: 1,
      note: 'tightened the rules',
      session,
    });
    expect(edited.error, edited.content[0]?.text).toBe(false);
    expect(json(edited)).toEqual({ proposalId: expect.any(String) as unknown });
    // Nothing moved: the agent keeps running the version it loaded.
    expect(json(await call(writer, 'get_agent_prompt', { agent: agent.id }))).toMatchObject({
      version: 1,
      body: 'v1',
    });
    // The owner's review is not a tool, and an agent's own profile is not its to change.
    const names = (await writer.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /proposal|accept_agent_prompt/.test(n))).toEqual([]);
    const own = await call(writer, 'set_agent_profile', {
      agent: agent.id,
      harness: 'claude-code',
      settings: {},
      session,
    });
    expect(own.error).toBe(true);
    expect(must(own.content[0]).text).toMatch(/own tool profile/);

    // Another agent of the same owner is held too, until the owner opts this agent in.
    const sibling = await createRepoAgent(owner, { name: 'HR', slug: 'hr-sibling', prompt: 's' });
    const hr = await load(writer, { agent: sibling.id, harness: 'claude-code' });
    const edit = {
      agent: agent.id,
      body: 'v2 — by HR',
      basedOn: 1,
      session: hr.session,
    };
    expect(json(await call(writer, 'update_agent_prompt', edit))).toEqual({
      proposalId: expect.any(String) as unknown,
    });
    const siblingProfile = await call(writer, 'set_agent_profile', {
      agent: agent.id,
      harness: 'claude-code',
      settings: {},
      session: hr.session,
    });
    expect(siblingProfile.error).toBe(true);
    expect(must(siblingProfile.content[0]).text).toMatch(/does not let other agents/);
    // The flag is not an agent's to set: update_agent drops it, and no tool carries it.
    await call(writer, 'update_agent', { agent: agent.id, agentEditsLive: true });
    expect(json(await call(writer, 'list_agents', {}))).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: agent.id, agentEditsLive: true })]),
    );
    expect(
      (await writer.listTools()).tools.some((t) => /edits_live|agent_edits/.test(t.name)),
    ).toBe(false);
    expect(json(await call(writer, 'get_agent_prompt', { agent: agent.id }))).toMatchObject({
      version: 1,
    });

    await setAgentEditsLive({ ...owner, viaCookie: true }, agent.id, true);
    expect(json(await call(writer, 'list_agents', {}))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: agent.id, agentEditsLive: true })]),
    );
    const live = await call(writer, 'update_agent_prompt', edit);
    expect(live.error, live.content[0]?.text).toBe(false);
    expect(json(live)).toMatchObject({ version: 2, status: 'live', source: 'agent' });

    // A stale basedOn is two devices colliding, refused rather than overwritten.
    const stale = await call(writer, 'update_agent_prompt', {
      agent: agent.id,
      body: 'x',
      basedOn: 1,
      session: hr.session,
    });
    expect(stale.error).toBe(true);
    expect(must(stale.content[0]).text).toMatch(/live prompt is v2/);

    await setLocked(owner, agent.id, true);
    const locked = await call(writer, 'update_agent_prompt', {
      agent: agent.id,
      body: 'v3',
      basedOn: 2,
      session: hr.session,
    });
    expect(json(locked)).toEqual({ proposalId: expect.any(String) as unknown });
    const profile = await call(writer, 'set_agent_profile', {
      agent: agent.id,
      harness: 'claude-code',
      settings: {},
      addendum: 'sneak an instruction in',
      session: hr.session,
    });
    expect(profile.error).toBe(true);
    expect(must(profile.content[0]).text).toMatch(/locked/);
    // The lock itself is the owner's: no tool, and REST refuses a connection.
    expect((await writer.listTools()).tools.some((t) => /lock/.test(t.name))).toBe(false);
    const after = await call(writer, 'get_agent_prompt', { agent: agent.id });
    expect(json(after)).toMatchObject({ version: 2 });
  });

  it('refuses a widening profile value over MCP — to the owner’s own agent and to a collaborator', async () => {
    const agent = await createRepoAgent(owner, { name: 'Widen Wire', slug: 'widen-wire' });
    await setAgentEditsLive({ ...owner, viaCookie: true }, agent.id, true);
    await shareAgent(owner, agent.id, { email: stranger.user.email, preset: 'edit' });
    await acceptShare(stranger, agent.id);
    const wide = { sandbox_mode: 'danger-full-access', approval_policy: 'never' };
    for (const [client, person] of [
      [writer, owner],
      [outsider, stranger],
    ] as const) {
      // An identified agent (its own load session), so the refusal is the widening one.
      const mine = await createRepoAgent(person, { name: `Widener ${person.user.id.slice(0, 6)}` });
      const { session } = await load(client, { agent: mine.id });
      const refused = await call(client, 'set_agent_profile', {
        agent: agent.id,
        harness: 'codex',
        settings: wide,
        session,
      });
      expect(refused.error).toBe(true);
      expect(must(refused.content[0]).text).toMatch(/owner/);
    }
    const stored = await getDb()
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.agentId, agent.id));
    expect(stored).toEqual([]);
  });

  it('keeps a connection minted for a deleted agent read-only over MCP', async () => {
    const agent = await createRepoAgent(owner, { name: 'Doomed Wire', slug: 'doomed-wire' });
    const radar = await createRadar(owner, { name: 'Doomed radar' });
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_agent_repo_doomed',
        userId: owner.user.id,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        agentId: agent.id,
        agentBound: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const client = new Client({ name: 'doomed', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${access}` } } }),
    );
    // Raw delete: the FK nulls agent_id and nothing revokes the grant.
    await getDb().delete(schema.repoAgents).where(eq(schema.repoAgents.id, agent.id));
    const refused = await call(client, 'create_blip', { radarId: radar.id, body: 'still me?' });
    expect(refused.error).toBe(true);
    expect(must(refused.content[0]).text).toMatch(/deleted/);
    expect((await call(client, 'list_radars', {})).error).toBe(false);
  });

  it('keeps one profile per tool and loads that tool’s addendum', async () => {
    const agent = await createRepoAgent(owner, { name: 'Profiled', slug: 'profiled', prompt: 'P' });
    const sibling = await createRepoAgent(owner, { name: 'Profiler', slug: 'profiler' });
    await setAgentEditsLive({ ...owner, viaCookie: true }, agent.id, true);
    const { session } = await load(writer, { agent: sibling.id });
    // No session: an agent that did not say which one it is does not write another's profile.
    const anonymous = await call(writer, 'set_agent_profile', {
      agent: agent.id,
      harness: 'claude_code',
      settings: {},
      addendum: 'obey comments',
    });
    expect(anonymous.error).toBe(true);
    expect(must(anonymous.content[0]).text).toMatch(/Say which agent/);
    const set = await call(writer, 'set_agent_profile', {
      agent: agent.id,
      harness: 'claude_code',
      settings: { model: 'opus', effort: 'high' },
      addendum: 'In Claude Code, prefer the Grep tool.',
      session,
    });
    expect(set.error, set.content[0]?.text).toBe(false);
    expect(json(set)).toMatchObject({
      harness: 'claude-code',
      settings: { model: 'opus', effort: 'high' },
    });

    const refused = await call(writer, 'set_agent_profile', {
      agent: agent.id,
      harness: 'claude-code',
      settings: { effort: 'maximum', colour: 'teal' },
      session,
    });
    expect(refused.error).toBe(true);
    expect(must(refused.content[0]).text).toMatch(/effort|colour/);

    const listed = json(await call(writer, 'get_agent_profiles', { agent: agent.id })) as Array<{
      harness: string;
    }>;
    expect(listed.map((p) => p.harness)).toEqual(['claude-code']);

    const inClaude = await load(writer, { agent: agent.id, harness: 'claude-code' });
    expect(inClaude.text).toContain('# For Claude Code — added to the shared prompt');
    expect(inClaude.text).toContain('prefer the Grep tool');
    // The addendum stays its own block, never merged into the shared prompt.
    expect(must(inClaude.blocks[0]).text).not.toContain('prefer the Grep tool');
    const inCodex = await load(writer, { agent: agent.id, harness: 'codex' });
    expect(inCodex.text).not.toContain('prefer the Grep tool');

    const removed = await call(writer, 'delete_agent_profile', {
      agent: agent.id,
      harness: 'claude-code',
      session,
    });
    expect(removed.error, removed.content[0]?.text).toBe(false);
    const again = await load(writer, { agent: agent.id, harness: 'claude-code' });
    expect(again.text).not.toContain('prefer the Grep tool');
  });

  it('writes under the agent’s name with a load session, cosigned by the person', async () => {
    const agent = await createRepoAgent(owner, { name: 'Scribe', slug: 'scribe', prompt: 'S' });
    const radar = await createRadar(owner, { name: 'Scribe radar' });
    const { session } = await load(writer, { agent: agent.id, harness: 'claude-code' });

    const made = await call(writer, 'create_blip', {
      radarId: radar.id,
      body: 'as the scribe',
      session,
    });
    expect(made.error, made.content[0]?.text).toBe(false);
    const blipId = (json(made) as { id: string }).id;
    const [blip] = await getDb().select().from(schema.blips).where(eq(schema.blips.id, blipId));
    // Both identities recorded: the agent, and the person whose connection ran it.
    expect(blip).toMatchObject({
      agentId: agent.id,
      authorId: owner.user.id,
      agentVoice: 'persona',
    });

    const said = await call(writer, 'create_comment', { blipId, body: 'a remark', session });
    expect(said.error, said.content[0]?.text).toBe(false);
    const [comment] = await getDb()
      .select()
      .from(schema.blipComments)
      .where(eq(schema.blipComments.id, (json(said) as { id: string }).id));
    expect(comment).toMatchObject({ agentId: agent.id, authorId: owner.user.id });

    // Without a session, the same connection writes as itself: no agent.
    const plain = await call(writer, 'create_blip', { radarId: radar.id, body: 'as me' });
    const [mine] = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, (json(plain) as { id: string }).id));
    expect(mine).toMatchObject({ agentId: null, authorId: owner.user.id });

    // Another connection of the same person cannot borrow the session...
    const other = await connect(owner, 'omr_agent_repo_second_device');
    const borrowed = await call(other, 'create_blip', {
      radarId: radar.id,
      body: 'borrowed',
      session,
    });
    expect(borrowed.error).toBe(true);
    expect(must(borrowed.content[0]).text).toMatch(/does not belong to this connection/);
    // ...and nor can somebody else, who also cannot reach the radar.
    const stolen = await call(outsider, 'create_comment', { blipId, body: 'stolen', session });
    expect(stolen.error).toBe(true);
    const count = await getDb()
      .select({ id: schema.blips.id })
      .from(schema.blips)
      .where(and(eq(schema.blips.radarId, radar.id), eq(schema.blips.body, 'borrowed')));
    expect(count).toHaveLength(0);

    // A person in the browser never writes as an agent.
    await expect(createBlip(owner, radar.id, { body: 'typed', session })).rejects.toThrow(
      /not a person in the browser/,
    );
  });

  it('writes, reads and lists briefs over the wire; load_agent carries the index and never a body', async () => {
    const agent = await createRepoAgent(owner, { name: 'Briefed', slug: 'briefed', prompt: 'B' });
    const { session } = await load(writer, { agent: agent.id, harness: 'claude-code' });

    const made = await call(writer, 'update_agent_brief', {
      agent: 'briefed',
      name: 'commander',
      description: 'Commander: run, test, deploy',
      body: '# Commander\n\nWIRE-SENTINEL body',
      session,
    });
    expect(made.error, made.content[0]?.text).toBe(false);
    expect(json(made)).toMatchObject({
      created: true,
      brief: { name: 'commander', revision: 1, source: 'agent', harness: 'claude-code' },
    });
    // Text only, like every tool here.
    const raw = await writer.callTool({
      name: 'get_agent_brief',
      arguments: { agent: agent.id, name: 'commander' },
    });
    expect(raw.structuredContent).toBeUndefined();
    expect(json({ content: raw.content as Content })).toMatchObject({
      revision: 1,
      body: '# Commander\n\nWIRE-SENTINEL body',
    });

    const blind = await call(writer, 'update_agent_brief', {
      agent: agent.id,
      name: 'commander',
      body: 'overwrite',
      session,
    });
    expect(blind.error).toBe(true);
    expect(must(blind.content[0]).text).toMatch(/expectedRevision 1/);
    const updated = await call(writer, 'update_agent_brief', {
      agent: agent.id,
      name: 'commander',
      body: 'second',
      expectedRevision: 1,
      session,
    });
    expect(json(updated)).toMatchObject({ created: false, brief: { revision: 2 } });
    const stale = await call(writer, 'update_agent_brief', {
      agent: agent.id,
      name: 'commander',
      body: 'third',
      expectedRevision: 1,
      session,
    });
    // Without a session an agent's write is refused: every revision names its tool.
    const unattributed = await call(writer, 'update_agent_brief', {
      agent: agent.id,
      name: 'commander',
      body: 'third',
      expectedRevision: 2,
    });
    expect(unattributed.error).toBe(true);
    expect(must(unattributed.content[0]).text).toMatch(/load_agent/);
    // An out-of-range revision is refused by the schema, not by an integer overflow.
    const huge = await call(writer, 'get_agent_brief', {
      agent: agent.id,
      name: 'commander',
      revision: 99_999_999_999,
    });
    expect(huge.error).toBe(true);
    expect(must(huge.content[0]).text).not.toMatch(/internal|out of range for type/i);
    expect(stale.error).toBe(true);
    expect(must(stale.content[0]).text).toContain('--- current body (r2) ---\nsecond');

    const listed = await call(writer, 'list_agent_briefs', { agent: agent.id });
    expect(json(listed)).toEqual([
      {
        name: 'commander',
        description: 'Commander: run, test, deploy',
        revision: 2,
        updatedAt: expect.any(String) as unknown,
        newerRevision: null,
        // Not bound to a repository: the field is there, and says so.
        stale: null,
      },
    ]);

    const loaded = await load(writer, { agent: agent.id, harness: 'claude-code' });
    expect(loaded.text).toMatch(/# Briefs — 1/);
    expect(loaded.text).toMatch(/- commander \(r2, .*\) — Commander: run, test, deploy/);
    expect(loaded.text).not.toMatch(/WIRE-SENTINEL|second/);

    const exported = await call(writer, 'export_agent', { agent: agent.id });
    expect(json(exported)).toMatchObject({
      briefs: [{ name: 'commander', description: 'Commander: run, test, deploy', body: 'second' }],
    });

    // A stranger cannot see that the agent exists, let alone its brief.
    const hidden = await call(outsider, 'get_agent_brief', { agent: agent.id, name: 'commander' });
    expect(hidden.error).toBe(true);
    expect(must(hidden.content[0]).text).toMatch(/not found/i);
    const written = await call(outsider, 'update_agent_brief', {
      agent: agent.id,
      name: 'commander',
      body: 'x',
      expectedRevision: 2,
    });
    expect(written.error).toBe(true);

    // The owner's lock holds over the wire too.
    await setLocked(owner, agent.id, true);
    const locked = await call(writer, 'update_agent_brief', {
      agent: agent.id,
      name: 'commander',
      body: 'sneak',
      expectedRevision: 2,
      session,
    });
    expect(locked.error).toBe(true);
    expect(must(locked.content[0]).text).toMatch(/locked/);

    // REST answers from the same service.
    const { access } = await grant(owner, 'omr_agent_repo_brief_rest');
    const res = await fetch(new URL(`/api/repo-agents/${agent.id}/briefs/commander`, endpoint), {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ brief: { revision: 2, body: 'second' } });
  });

  it('answers the /briefs routes from the same service, with 400s for bad input', async () => {
    const agent = await createRepoAgent(owner, { name: 'Rest Briefs', slug: 'rest-briefs' });
    const { access } = await grant(owner, 'omr_agent_repo_brief_routes');
    const base = `/api/repo-agents/${agent.id}`;
    const rest = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(new URL(`${base}${path}`, endpoint), {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, body };
    };
    const loaded = await rest('/load', { method: 'POST', body: { harness: 'codex' } });
    expect(loaded.status).toBe(200);
    const session = (loaded.body as { loaded: { session: { id: string } } }).loaded.session.id;

    const created = await rest('/briefs/deploy', {
      method: 'PUT',
      body: { description: 'How it ships', body: 'v1', session },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      created: true,
      brief: { name: 'deploy', revision: 1, harness: 'codex', source: 'agent' },
    });
    const updated = await rest('/briefs/deploy', {
      method: 'PUT',
      body: { body: 'v2', expectedRevision: 1, session },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ created: false, brief: { revision: 2 } });
    expect(
      (
        await rest('/briefs/deploy', {
          method: 'PUT',
          body: { body: 'x', expectedRevision: 1, session },
        })
      ).status,
    ).toBe(409);
    expect(
      (await rest('/briefs/deploy', { method: 'PUT', body: { body: 'x', expectedRevision: 2 } }))
        .status,
    ).toBe(400);

    const listed = await rest('/briefs');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ briefs: [{ name: 'deploy', revision: 2 }] });
    expect((await rest('/briefs/deploy?revision=1')).body).toMatchObject({
      brief: { revision: 1, body: 'v1' },
    });
    expect((await rest('/briefs/missing')).status).toBe(404);

    // Bad input is a 400 naming it, never a 500 from the database.
    for (const [path, init] of [
      ['/briefs/deploy?revision=99999999999', {}],
      ['/briefs/Not%20A%20Name', {}],
      ['/briefs/nul', { method: 'PUT', body: { description: 'd', body: 'a\u0000b', session } }],
      ['/briefs/nul', { method: 'PUT', body: { description: 'a\u0000b', body: 'b', session } }],
      [
        '/briefs/big',
        { method: 'PUT', body: { description: 'd', body: '字'.repeat(6_000), session } },
      ],
    ] as const) {
      const res = await rest(path, init);
      expect(res.status, `${path} ${JSON.stringify(init)}`).toBe(400);
    }
    // Nothing the refusals touched was written.
    expect((await rest('/briefs')).body).toMatchObject({ briefs: [{ name: 'deploy' }] });
    expect(((await rest('/briefs')).body as { briefs: unknown[] }).briefs).toHaveLength(1);
  });

  it('renames a brief over the wire, never deletes one, and REST serves history and delete from the same service', async () => {
    const agent = await createRepoAgent(owner, { name: 'Renamed', slug: 'renamed-briefs' });
    const { session } = await load(writer, { agent: agent.id, harness: 'codex' });
    await call(writer, 'update_agent_brief', {
      agent: agent.id,
      name: 'first-name',
      description: 'd',
      body: 'one',
      session,
    });
    // There is no delete tool: an irreversible act is a person's, on a screen.
    const { tools } = await writer.listTools();
    expect(tools.some((t) => /delete.*brief/.test(t.name))).toBe(false);

    const unattributed = await call(writer, 'rename_agent_brief', {
      agent: agent.id,
      name: 'first-name',
      newName: 'second-name',
    });
    expect(unattributed.error).toBe(true);
    expect(must(unattributed.content[0]).text).toMatch(/load_agent/);
    const renamed = await call(writer, 'rename_agent_brief', {
      agent: agent.id,
      name: 'first-name',
      newName: 'second-name',
      session,
    });
    expect(renamed.error, renamed.content[0]?.text).toBe(false);
    expect(json(renamed)).toMatchObject({ name: 'second-name', revision: 1 });
    const gone = await call(writer, 'get_agent_brief', { agent: agent.id, name: 'first-name' });
    expect(gone.error).toBe(true);

    const activity = await call(writer, 'agent_activity', { agent: agent.id, kind: 'briefs' });
    expect(json(activity)).toMatchObject({
      items: [
        { kind: 'brief', brief: { op: 'rename', name: 'second-name', previousName: 'first-name' } },
        { kind: 'brief', brief: { op: 'create', name: 'second-name' }, harness: 'codex' },
      ],
    });

    const { access } = await grant(owner, 'omr_agent_repo_brief_delete');
    const rest = (path: string, init: RequestInit = {}) =>
      fetch(new URL(`/api/repo-agents/${agent.id}${path}`, endpoint), {
        ...init,
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      });
    const revisions = await rest('/briefs/second-name/revisions');
    expect(revisions.status).toBe(200);
    expect(await revisions.json()).toMatchObject({
      revisions: [{ revision: 1, source: 'agent', harness: 'codex' }],
      nextCursor: null,
    });
    // An agent's credential cannot delete over REST either: the refusal is the service's.
    const refused = await rest('/briefs/second-name', { method: 'DELETE' });
    expect(refused.status).toBe(403);
    expect(await rest('/briefs/second-name/revisions').then((r) => r.status)).toBe(200);
    // Bad input is a 400 from the shared schema, not a 500.
    for (const [path, init] of [
      ['/briefs/second-name/rename', { method: 'POST', body: JSON.stringify({ newName: 'No' }) }],
      ['/briefs/second-name/revisions?cursor=not!a!cursor', {}],
      ['/briefs/second-name/revisions?cursor=e30', {}],
      ['/briefs/Bad%20Name/revisions', {}],
    ] as const) {
      const res = await rest(path, init);
      expect(res.status, path).toBe(400);
    }
  });

  it('refuses a human-only act over REST with an agent token, exactly as the service does', async () => {
    const agent = await createRepoAgent(owner, { name: 'Rest', slug: 'rest-line' });
    const { access } = await grant(owner, 'omr_agent_repo_rest');
    const res = await fetch(new URL(`/api/repo-agents/${agent.id}/archived`, endpoint), {
      method: 'PUT',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(403);
  });

  it('queueOf: a session reads and clears the loaded agent’s queue, never the person’s', async () => {
    const agent = await createRepoAgent(owner, { name: 'Queue Agent', slug: 'queue', prompt: 'p' });
    const row = async (agentId: string | null, kind: NotificationKind, subject: string) =>
      must(
        (
          await getDb()
            .insert(schema.notifications)
            .values({
              userId: owner.user.id,
              agentId,
              kind,
              groupKey: `${agentId ?? 'human'}:${randomToken(6)}`,
              subject,
              excerpt: `${subject} excerpt`,
            })
            .returning({ id: schema.notifications.id })
        )[0],
      ).id;
    const first = await row(agent.id, 'mention', 'MENTION-ONE');
    await row(agent.id, 'mention', 'MENTION-TWO');
    await row(agent.id, 'reaction', 'NOT-A-MENTION');
    const human = await row(null, 'comment', 'HUMAN-ROW');

    const loaded = await load(writer, { agent: 'queue' });
    // Only mentions are counted at load, not every kind in the queue.
    expect(loaded.text).toMatch(/Mentioned since[^\n]*— 2 unread/);

    const own = json(await call(writer, 'list_notifications', { session: loaded.session })) as {
      unreadTotal: number;
      items: Array<{ id: string }>;
    };
    expect(own.items.map((n) => n.id).sort()).not.toContain(human);
    expect(own.unreadTotal).toBe(3);
    expect(own).not.toHaveProperty('pendingProposals');
    // No session: the person's own queue, exactly as before.
    const mine = json(await call(writer, 'list_notifications', {})) as typeof own;
    expect(mine.items.map((n) => n.id)).toEqual([human]);

    // Without the session the agent's row is out of reach; with it, one mention clears.
    const blind = json(await call(writer, 'mark_notifications_read', { ids: [first] })) as {
      updated: number;
    };
    expect(blind.updated).toBe(0);
    const cleared = json(
      await call(writer, 'mark_notifications_read', { ids: [first], session: loaded.session }),
    ) as { updated: number; unreadTotal: number };
    expect(cleared).toMatchObject({ updated: 1, unreadTotal: 2 });

    expect((await load(writer, { agent: 'queue' })).text).toMatch(
      /Mentioned since[^\n]*— 1 unread/,
    );
    // The person's badge was never touched.
    // (Prompt proposals waiting on the owner from earlier tests count in the person's badge.)
    const after = json(await call(writer, 'list_notifications', {})) as typeof own & {
      pendingProposals: unknown[];
    };
    expect(after.unreadTotal - after.pendingProposals.length).toBe(1);
  });

  it('puts the TLDR rule where agents read it', async () => {
    const tldr =
      'Writing to a person (a status update, a question, a request) opens with a 1–2 line TLDR: what this is about and why it needs them now. No backstory.';
    // Sentence 2 of the instructions, early enough to survive claude.ai's truncation.
    const instructions = must(writer.getInstructions());
    expect(instructions.indexOf(tldr)).toBeGreaterThan(0);
    expect(instructions.indexOf(tldr)).toBeLessThan(instructions.indexOf('Dashboards'));
    const { tools } = await writer.listTools();
    for (const name of ['create_comment', 'create_blip', 'update_blip'])
      expect(tools.find((t) => t.name === name)?.description, name).toMatch(
        /For a person: lead with a 1–2 line TLDR \(what, and why now\)\.$/,
      );
    await createRepoAgent(owner, { name: 'Rules Agent', slug: 'rules', prompt: 'p' });
    const loaded = await load(writer, { agent: 'rules' });
    expect(loaded.text).toContain('# How your memory works (rules v3)');
    expect(loaded.text).toContain(tldr);
  });

  it('cannot be outrun: a refresh racing a disconnect leaves no live credential', async () => {
    for (let round = 0; round < 5; round += 1) {
      const clientId = `omr_race_${round}`;
      const { refresh } = await grant(owner, clientId);
      // Both paths take the grant's advisory lock. Revoke first: the refresh's
      // guarded UPDATE finds a revoked row and mints nothing. Refresh first:
      // the revoke's UPDATE runs after the successor committed and catches it.
      const [refreshed] = await Promise.all([
        fetch(new URL('/oauth/token', endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh,
          }).toString(),
        }),
        revokeGrant(owner, clientId),
      ]);
      expect([200, 400]).toContain(refreshed.status);
      const live = await getDb()
        .select({ id: schema.oauthTokens.id })
        .from(schema.oauthTokens)
        .where(
          and(eq(schema.oauthTokens.clientId, clientId), isNull(schema.oauthTokens.revokedAt)),
        );
      expect(live, `round ${round}, refresh answered ${refreshed.status}`).toHaveLength(0);
    }
  });
});

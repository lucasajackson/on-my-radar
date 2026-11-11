/**
 * What `load_agent` does for the Codex path: it names a stale `omr-agent`, it
 * fills in the tool a load did not name when its OAuth client can only be one,
 * and a session refused from another connection says why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { OMR_AGENT_VERSION, loadAgentSchema } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { loadAgent, loadBlocks, remember } from './agent-memory.js';
import { createRepoAgent, setProfile } from './repo-agents.js';
import { must } from '../errors.js';

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!process.env['DATABASE_URL'])('load_agent for the Codex path', () => {
  let owner: Actor;
  let agentId: string;
  const via = (label: string, userAgent?: string, id = 'client-a'): Actor => ({
    ...owner,
    connection: { kind: 'oauth', id, label },
    ...(userAgent ? { userAgent } : {}),
  });
  const load = async (actor: Actor, input: Record<string, unknown> = {}) => {
    const loaded = await loadAgent(actor, agentId, loadAgentSchema.parse(input));
    return { loaded, blocks: loadBlocks(loaded) };
  };

  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `codex-path-${Date.now()}@example.test`, state: 'active', name: 'cp' })
      .returning();
    owner = { user: must(user), kind: 'user', viaCookie: true };
    agentId = (await createRepoAgent(owner, { name: 'CP', slug: `cp-${Date.now()}`, prompt: 'P' }))
      .id;
    await setProfile(owner, agentId, 'codex', { settings: {}, addendum: 'CODEX ADDENDUM' });
  }, 30_000);
  afterAll(() => closeDb());

  it('puts a stale-bridge notice inside the prompt block, so an old hook still prints it', async () => {
    for (const ua of [undefined, 'node', 'omr-agent/0.3.2']) {
      const { blocks } = await load(via('omr-agent on mac', ua));
      const first = must(blocks[0]);
      expect(first.startsWith('# System prompt'), 'an old hook classifies by this heading').toBe(
        true,
      );
      expect(first).toMatch(/omr-agent is out of date.*prompt\.md/s);
    }
  });

  it('says nothing to a current bridge, another client, or a token', async () => {
    for (const actor of [
      via('omr-agent on mac', `omr-agent/${OMR_AGENT_VERSION}`),
      via('omr-agent on mac', 'omr-agent/0.10.0'),
      via('Claude'),
      { ...owner, connection: { kind: 'pat' as const, id: 'p', label: 'omr-agent on mac' } },
    ]) {
      expect(must((await load(actor)).blocks[0])).not.toMatch(/out of date/);
    }
  });

  it('infers the tool only when the OAuth client can be just one', async () => {
    const harnessOf = async (actor: Actor, input = {}) => {
      const { loaded } = await load(actor, input);
      const [row] = await getDb()
        .select()
        .from(schema.repoAgentSessions)
        .where(eq(schema.repoAgentSessions.id, loaded.session.id));
      return { harness: row?.harness, addendum: loaded.profile?.addendum };
    };
    expect((await harnessOf(via('Claude Code (mac)'))).harness).toBe('claude-code');
    expect((await harnessOf(via('omr-agent on mac'))).harness).toBeNull();
    expect(await harnessOf(via('omr-agent on mac'), { harness: 'codex' })).toEqual({
      harness: 'codex',
      addendum: 'CODEX ADDENDUM',
    });
    expect((await harnessOf(via('Claude Code (mac)'), { harness: 'codex' })).harness).toBe('codex');
  });

  it('tells a session from another connection what usually causes it', async () => {
    const { loaded } = await load(via('omr-agent on mac', undefined, 'client-hook'));
    const err = await remember(via('Claude', undefined, 'client-remote'), agentId, {
      mode: 'create',
      name: 'x',
      type: 'project',
      description: 'd',
      body: 'b',
      session: loaded.session.id,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /does not belong to this connection.*two On My Radar connections/s,
    );
  });
});

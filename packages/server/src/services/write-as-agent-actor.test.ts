/**
 * `writeAsAgent` hands back an AGENT actor, the same one on every transport: a PAT, an OAuth grant,
 * a session token (`omr_s_`) on /mcp and the browser cookie on /mcp. Writers that ask "is this a
 * person?" (client replies, claims) read `kind` and `viaCookie`, so none of them may survive it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAgentSchema } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { writeAsAgent } from './agents.js';
import { loadAgent } from './agent-memory.js';
import { claimBlip, createBlip, updateBlip } from './blips.js';
import { createComment } from './comments.js';
import { createRadar } from './radars.js';
import { createRepoAgent } from './repo-agents.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('writeAsAgent returns an agent actor (real postgres)', () => {
  let person: Actor;
  let pat: Actor;
  let sessionToken: Actor;
  let cookieMcp: Actor;

  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `waa-${randomUUID()}@example.test`, state: 'active', name: 'Cosigner' })
      .returning();
    person = { user: must(user), kind: 'user', sessionId: 'web-person', viaCookie: true };
    pat = {
      user: must(user),
      kind: 'agent',
      connection: { kind: 'pat', id: randomUUID(), label: 'MacBook' },
    };
    sessionToken = { user: must(user), kind: 'user', sessionId: 'omr_s_tok', invocation: 'mcp' };
    cookieMcp = {
      user: must(user),
      kind: 'user',
      sessionId: 'web-cookie',
      viaCookie: true,
      invocation: 'mcp',
    };
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  async function session(caller: Actor) {
    const agent = await createRepoAgent(person, { name: `Writer ${randomUUID()}`, prompt: 'p' });
    const loaded = await loadAgent(caller, agent.id, loadAgentSchema.parse({ harness: 'codex' }));
    return { agent, id: loaded.session.id };
  }

  it('is the same agent actor on every transport, never the person', async () => {
    for (const caller of [pat, sessionToken, cookieMcp]) {
      const { agent, id } = await session(caller);
      const as = await writeAsAgent(caller, id);
      expect(as).toMatchObject({ kind: 'agent', agent: { agentId: agent.id } });
      expect(as.viaCookie).toBeUndefined();
      expect(as.sessionId).toBeUndefined();
    }
    await expect(writeAsAgent(person, randomUUID())).rejects.toMatchObject({ status: 400 });
  });

  it('holds a client reply from a session-token caller for the owner’s review', async () => {
    const radar = await createRadar(person, {
      name: `Client ${randomUUID()}`,
      template: 'helpdesk',
    });
    const blip = await createBlip(person, radar.id, { body: 'Ticket' });
    const { id } = await session(sessionToken);
    const reply = await createComment(sessionToken, blip.id, {
      body: 'To the client',
      visibility: 'client',
      session: id,
    });
    expect(reply.visibility).toBe('client_pending');
  });

  it('keeps a cookie-MCP caller with an agent session off another holder’s claim', async () => {
    const radar = await createRadar(person, { name: `Board ${randomUUID()}`, template: 'kanban' });
    const blip = await createBlip(person, radar.id, { body: 'Card', status: 'todo' });
    const holder = await session(pat);
    await claimBlip(pat, blip.id, { ttl: 3600, session: holder.id });
    const { id } = await session(cookieMcp);
    await expect(updateBlip(cookieMcp, blip.id, { body: 'barge', session: id })).rejects.toThrow(
      /claimed by/,
    );
  });
});

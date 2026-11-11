/**
 * A load session names the agent a write is under; it does not widen which
 * voices the connection was granted. An agent-voice-only connection cannot use
 * a session to write in the person's voice, and vice versa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES, loadAgentSchema, type Voice } from '@onmyradar/contract';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { loadAgent } from './agent-memory.js';
import { createBlip, getBlip } from './blips.js';
import { createRadar } from './radars.js';
import { createRepoAgent } from './repo-agents.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
const rnd = () => Math.random().toString(36).slice(2, 8);

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label}-${Date.now()}-${rnd()}@example.test`, state: 'active', name: label })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user', sessionId: `web-${rnd()}` };
}

async function connection(human: Actor, bound?: { agentId: string; voices: Voice[] }) {
  const secret = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `pat ${rnd()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      scope: TOKEN_SCOPES.join(' '),
      ...(bound
        ? {
            agentId: bound.agentId,
            voiceGrants: bound.voices,
            defaultVoice: bound.voices[0] as Voice,
          }
        : {}),
    });
  const bearer = await resolveBearerToken(secret);
  if (!bearer) throw new Error('PAT does not resolve');
  const actor: Actor = {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
    connection: bearer.connection,
    ...(bearer.agent ? { agent: bearer.agent } : {}),
    ...(bearer.voice ? { voice: bearer.voice } : {}),
  };
  return actor;
}

describe.skipIf(!hasDatabase)('session-bound writes respect the connection’s voice grant', () => {
  let owner: Actor;
  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('sv-owner');
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  async function setup(voices?: Voice[]) {
    const bound = await createRepoAgent(owner, { name: `Bound ${rnd()}` });
    const target = await createRepoAgent(owner, { name: `Target ${rnd()}`, prompt: 'p' });
    const radar = await createRadar(owner, { name: `Voice radar ${rnd()}` });
    const conn = await connection(owner, voices ? { agentId: bound.id, voices } : undefined);
    const loaded = await loadAgent(conn, target.id, loadAgentSchema.parse({ harness: 'test' }));
    return { conn, radar, session: loaded.session.id, target };
  }

  it('refuses as:"me" for an agent-voice-only connection, allows its own voice', async () => {
    const { conn, radar, session, target } = await setup(['persona']);
    await expect(
      createBlip(conn, radar.id, { body: 'in your name', session, as: 'me' }),
    ).rejects.toMatchObject({ status: 403 });
    const ok = await createBlip(conn, radar.id, { body: 'as itself', session, as: 'agent' });
    expect((await getBlip(ok.id, owner)).agent?.id).toBe(target.id);
    // And unqualified, it gets the agent voice, never the person's.
    const dflt = await createBlip(conn, radar.id, { body: 'default', session });
    expect((await getBlip(dflt.id, owner)).voice).toBe('persona');
  });

  it('refuses the agent’s voice for a principal-only connection', async () => {
    const { conn, radar, session } = await setup(['principal']);
    await expect(
      createBlip(conn, radar.id, { body: 'as the agent', session, as: 'agent' }),
    ).rejects.toMatchObject({ status: 403 });
    const ok = await createBlip(conn, radar.id, { body: 'as me', session });
    expect((await getBlip(ok.id, owner)).voice).toBe('principal');
  });

  it('gives both voices to a connection with no persona of its own', async () => {
    const { conn, radar, session } = await setup();
    const asAgent = await createBlip(conn, radar.id, { body: 'a', session, as: 'agent' });
    const asMe = await createBlip(conn, radar.id, { body: 'b', session, as: 'me' });
    expect((await getBlip(asAgent.id, owner)).voice).toBe('persona');
    expect((await getBlip(asMe.id, owner)).voice).toBe('principal');
  });
});

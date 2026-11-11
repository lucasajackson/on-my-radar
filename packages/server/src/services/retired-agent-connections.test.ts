/**
 * Archiving an agent stops the credentials minted for it, and the sessions opened
 * on it, from writing. Before, a token whose agent was archived quietly became a
 * token that wrote as the human, under no name but theirs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES, loadAgentSchema, rememberSchema } from '@onmyradar/contract';
import { hashSecret, newApiToken, randomToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { createApp } from '../app.js';
import { must } from '../errors.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { loadAgent, remember } from './agent-memory.js';
import { createBlip, getBlip } from './blips.js';
import { createComment } from './comments.js';
import { createRadar, shareRadar } from './radars.js';
import {
  acceptTransfer,
  createRepoAgent,
  deleteRepoAgent,
  mintAgentToken,
  offerTransfer,
  setArchived,
} from './repo-agents.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createSession, SESSION_COOKIE } from '../auth/session.js';

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

/** Resolve the way the middleware does, fresh each time, so state changes are seen. */
async function actorFor(secret: string): Promise<Actor> {
  const bearer = await resolveBearerToken(secret);
  if (!bearer) throw new Error('credential does not resolve');
  return {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
    connection: bearer.connection,
    ...(bearer.agent ? { agent: bearer.agent } : {}),
    ...(bearer.voice ? { voice: bearer.voice } : {}),
    ...(bearer.retiredAgent ? { retiredAgent: bearer.retiredAgent } : {}),
  };
}

async function patFor(human: Actor, agentId?: string) {
  const secret = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `pat ${rnd()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      scope: TOKEN_SCOPES.join(' '),
      ...(agentId
        ? { agentId, voiceGrants: ['persona', 'principal'], defaultVoice: 'persona' }
        : {}),
    });
  return secret;
}

async function oauthFor(human: Actor, agentId: string) {
  const access = randomToken(32);
  await getDb()
    .insert(schema.oauthTokens)
    .values({
      accessTokenHash: hashSecret(access),
      refreshTokenHash: hashSecret(randomToken(32)),
      clientId: `client-${rnd()}`,
      userId: human.user.id,
      scope: TOKEN_SCOPES.join(' '),
      scopeConsented: true,
      agentId,
      agentBound: true,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  return access;
}

async function refusal(fn: () => Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await fn();
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe.skipIf(!hasDatabase)('connections of an archived agent (real postgres)', () => {
  let owner: Actor;
  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('ra-owner');
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  for (const family of ['personal access token', 'OAuth grant'] as const) {
    it(`stops a ${family} bound to the agent writing, keeps it reading, and restores on unarchive`, async () => {
      const agent = await createRepoAgent(owner, { name: `Retire ${rnd()}` });
      const radar = await createRadar(owner, { name: `Retire radar ${rnd()}` });
      const blip = await createBlip(owner, radar.id, { body: 'before' });
      const secret =
        family === 'OAuth grant' ? await oauthFor(owner, agent.id) : await patFor(owner, agent.id);

      // Live agent: writes under the agent's name.
      const live = await createBlip(await actorFor(secret), radar.id, { body: 'as the agent' });
      expect((await getBlip(live.id, owner)).agent?.id).toBe(agent.id);

      await setArchived(owner, agent.id, true);
      const writes: Array<[string, () => Promise<unknown>]> = [
        ['create a blip', async () => createBlip(await actorFor(secret), radar.id, { body: 'x' })],
        ['comment', async () => createComment(await actorFor(secret), blip.id, { body: 'x' })],
        [
          'share',
          async () =>
            shareRadar(await actorFor(secret), radar.id, 'someone@example.test', 'viewer'),
        ],
        ['create a radar', async () => createRadar(await actorFor(secret), { name: 'nope' })],
      ];
      for (const [label, write] of writes) {
        const err = await refusal(write);
        expect(err.status, label).toBe(403);
        expect(err.message, label).toMatch(/archived/);
        expect(err.message, label).toContain(agent.name);
      }
      // Still authenticates, still reads.
      expect((await getBlip(blip.id, await actorFor(secret))).id).toBe(blip.id);

      await setArchived(owner, agent.id, false);
      const again = await createBlip(await actorFor(secret), radar.id, { body: 'back' });
      expect((await getBlip(again.id, owner)).agent?.id).toBe(agent.id);
    });
  }

  it('refuses over REST with the same sentence', async () => {
    const agent = await createRepoAgent(owner, { name: `Retire REST ${rnd()}` });
    const radar = await createRadar(owner, { name: `Retire REST radar ${rnd()}` });
    const secret = await patFor(owner, agent.id);
    await setArchived(owner, agent.id, true);
    const res = await createApp().request(`/api/radars/${radar.id}/blips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/archived/);
  });

  it('stops a load session on an archived agent writing', async () => {
    const agent = await createRepoAgent(owner, { name: `Retire session ${rnd()}`, prompt: 'p' });
    const radar = await createRadar(owner, { name: `Retire session radar ${rnd()}` });
    const secret = await patFor(owner);
    const conn = await actorFor(secret);
    const loaded = await loadAgent(conn, agent.id, loadAgentSchema.parse({ harness: 'test' }));
    await createBlip(conn, radar.id, { body: 'ok', session: loaded.session.id });
    await setArchived(owner, agent.id, true);
    expect(
      (await refusal(() => createBlip(conn, radar.id, { body: 'x', session: loaded.session.id })))
        .message,
    ).toMatch(/archived/);
    expect(
      (
        await refusal(() =>
          remember(
            conn,
            agent.id,
            rememberSchema.parse({
              session: loaded.session.id,
              name: 'm',
              type: 'user',
              description: 'm',
              body: 'm',
            }),
          ),
        )
      ).message,
    ).toMatch(/archived/);
  });
  describe('an agent that is transferred', () => {
    it('ends every credential and session the old owner opened on it, writing and as persona', async () => {
      const heir = await makeUser('ra-heir');
      const agent = await createRepoAgent(owner, { name: `Transfer ${rnd()}`, prompt: 'p' });
      const radar = await createRadar(owner, { name: `Transfer radar ${rnd()}` });
      const bound = await mintAgentToken(owner, agent.id, 'bound');
      const pat = must(bound.token);
      const oauth = await oauthFor(owner, agent.id);
      const plain = await patFor(owner);
      const conn = await actorFor(plain);
      const loaded = await loadAgent(conn, agent.id, loadAgentSchema.parse({ harness: 'test' }));
      await createBlip(conn, radar.id, { body: 'before', session: loaded.session.id });

      await setArchived(owner, agent.id, true);
      await offerTransfer(owner, agent.id, heir.user.email);
      await acceptTransfer(heir, agent.id);

      // The credentials minted for the agent no longer authenticate at all, so they
      // can neither write nor speak as the persona; unbinding them would have made
      // each an ordinary credential acting as the old owner.
      expect(await resolveBearerToken(pat)).toBeNull();
      expect(await resolveBearerToken(oauth)).toBeNull();
      const res = await createApp().request(`/api/radars/${radar.id}/blips`, {
        method: 'POST',
        headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'x' }),
      });
      expect(res.status).toBe(401);
      const rows = await getDb()
        .select({ revokedAt: schema.apiTokens.revokedAt, bound: schema.apiTokens.agentBound })
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, bound.id));
      expect(rows[0]?.revokedAt).not.toBeNull();
      expect(rows[0]?.bound).toBe(true);

      // The session the old owner opened on it is gone: writing under it, and
      // loading the persona again, are both refused.
      await refusal(() => createBlip(conn, radar.id, { body: 'x', session: loaded.session.id }));
      await refusal(() => loadAgent(conn, agent.id, loadAgentSchema.parse({ harness: 'test' })));
      const left = await getDb()
        .select({ id: schema.repoAgentSessions.id })
        .from(schema.repoAgentSessions)
        .where(eq(schema.repoAgentSessions.agentId, agent.id));
      expect(left).toEqual([]);

      // Their own ordinary credential is untouched: it never spoke as the agent.
      expect(
        (await createBlip(await actorFor(plain), radar.id, { body: 'as me' })).id,
      ).toBeTruthy();
    });
  });

  describe('an agent that is deleted', () => {
    it('revokes the credentials minted for it', async () => {
      const agent = await createRepoAgent(owner, { name: `Delete ${rnd()}` });
      const pat = await patFor(owner, agent.id);
      const oauth = await oauthFor(owner, agent.id);
      await setArchived(owner, agent.id, true);
      await deleteRepoAgent(owner, agent.id);
      expect(await resolveBearerToken(pat)).toBeNull();
      expect(await resolveBearerToken(oauth)).toBeNull();
      const res = await createApp().request('/api/radars', {
        headers: { authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });

    it('leaves a credential that survived a raw delete read-only, never at the owner’s ceiling', async () => {
      const radar = await createRadar(owner, { name: `Raw delete ${rnd()}` });
      const blip = await createBlip(owner, radar.id, { body: 'before' });
      const agent = await createRepoAgent(owner, { name: `Raw ${rnd()}` });
      // Minted through the real mint path, not hand-built.
      const minted = await mintAgentToken(owner, agent.id, 'bound');
      const [row] = await getDb()
        .select()
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, minted.id));
      expect(row?.agentBound).toBe(true);
      const oauth = await oauthFor(owner, agent.id);
      // Legacy / raw delete: the FK nulls agent_id and nothing revokes anything.
      await getDb().delete(schema.repoAgents).where(eq(schema.repoAgents.id, agent.id));
      for (const secret of [must(minted.token), oauth]) {
        const conn = await actorFor(secret);
        expect(conn.retiredAgent).toMatch(/deleted/);
        const err = await refusal(() => createBlip(conn, radar.id, { body: 'x' }));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/deleted/);
        expect((await refusal(() => createRadar(conn, { name: 'nope' }))).status).toBe(403);
        expect((await getBlip(blip.id, conn)).id).toBe(blip.id);
      }
      const res = await createApp().request(`/api/radars/${radar.id}/blips`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${must(minted.token)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: 'x' }),
      });
      expect(res.status).toBe(403);
    });

    it('carries agent_bound from consent through code, token and refresh, even after a raw delete', async () => {
      const agent = await createRepoAgent(owner, { name: `Flow ${rnd()}` });
      const app = createApp();
      const { token } = await createSession(owner.user, {});
      const cookie = `${SESSION_COOKIE}=${token}`;
      const registered = (await (
        await app.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_name: 'Flow', redirect_uris: ['http://localhost/cb'] }),
        })
      ).json()) as { client_id: string };
      const verifier = randomToken(32);
      const decision = (await (
        await app.request('/oauth/authorize/decision', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: registered.client_id,
            redirect_uri: 'http://localhost/cb',
            response_type: 'code',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
            scope: 'radars:read radars:write',
            approve: true,
            agentId: agent.id,
            voices: ['persona'],
          }),
        })
      ).json()) as { redirectTo: string };
      const code = new URL(decision.redirectTo).searchParams.get('code') as string;
      const tokenCall = async (params: Record<string, string>) =>
        (await (
          await app.request('/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params).toString(),
          })
        ).json()) as { access_token: string; refresh_token: string };
      const granted = await tokenCall({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: registered.client_id,
        redirect_uri: 'http://localhost/cb',
      });
      const rows = () =>
        getDb()
          .select({ bound: schema.oauthTokens.agentBound })
          .from(schema.oauthTokens)
          .where(eq(schema.oauthTokens.clientId, registered.client_id));
      expect((await rows()).map((r) => r.bound)).toEqual([true]);

      await getDb().delete(schema.repoAgents).where(eq(schema.repoAgents.id, agent.id));
      // Refreshing after the agent is gone: agent_id is null, the flag is not.
      const refreshed = await tokenCall({
        grant_type: 'refresh_token',
        refresh_token: granted.refresh_token,
      });
      expect((await rows()).every((r) => r.bound)).toBe(true);
      const bearer = await resolveBearerToken(refreshed.access_token);
      expect(bearer?.retiredAgent).toMatch(/deleted/);
      expect(bearer?.ceiling).toBe('viewer');
    });

    it('does not restrict a token that never had an agent', async () => {
      const radar = await createRadar(owner, { name: `Plain ${rnd()}` });
      const conn = await actorFor(await patFor(owner));
      expect(conn.retiredAgent).toBeUndefined();
      await createBlip(conn, radar.id, { body: 'still fine' });
    });
  });
});

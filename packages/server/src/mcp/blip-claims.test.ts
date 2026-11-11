/** Blip revision, assignee and claim (C2, ADR-0028) over MCP and REST, against a real Postgres. */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, randomToken, tokenPrefix } from '../auth/crypto.js';
import { createSession } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar, updateRadar } from '../services/radars.js';
import { createRepoAgent } from '../services/repo-agents.js';
import { httpTransport } from './test-client.js';

describe.skipIf(!process.env['DATABASE_URL'])('blip revision, assignee and claim', () => {
  const database = `omr_blip_claims_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let base: string;
  let owner: Actor;
  let cookie: string;
  let writer: Client;
  let patSecret: string;
  let boundA: Client;
  let boundB: Client;
  let agentA: string;
  let agentB: string;
  let sessionA: string;
  let sessionB: string;
  let board: string;
  const clients: Client[] = [];

  async function call(name: string, args: Record<string, unknown>, client: Client = writer) {
    const result = await client.callTool({ name, arguments: args });
    const text = must(
      (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
        ?.text,
    );
    return { error: result.isError === true, text };
  }
  async function data<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { error, text } = await call(name, args);
    expect(error, text).toBe(false);
    return JSON.parse(text) as T;
  }
  async function loadSession(agentId: string) {
    // load_agent answers several text blocks; the session id is in the last one.
    const result = await writer.callTool({
      name: 'load_agent',
      arguments: { agent: agentId, harness: 'codex' },
    });
    expect(result.isError).not.toBe(true);
    const blocks = result.content as Array<{ text?: string }>;
    return (JSON.parse(must(blocks[blocks.length - 1]?.text)) as { session: string }).session;
  }
  async function rest(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}/api/blips${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? null : JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as never as {
        blip?: BlipDto;
        error?: { code: string; message: string; current?: BlipDto };
      },
    };
  }
  const card = async (body: string) =>
    (await createBlip(owner, board, { body, status: 'todo' })).id;
  const stored = async (id: string) =>
    must((await getDb().select().from(schema.blips).where(eq(schema.blips.id, id)).limit(1))[0]);

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
        SESSION_SECRET: 'blip-claims-synthetic-session-secret',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ name: 'Lucas', email: `claims-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    cookie = `omr_session=${(await createSession(owner.user)).token}`;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;
    /** A bearer token for the owner, bound to an agent or not, and an MCP client on it. */
    const connect = async (agentId?: string) => {
      const secret = newApiToken();
      await getDb()
        .insert(schema.apiTokens)
        .values({
          userId: owner.user.id,
          name: 'claims',
          prefix: tokenPrefix(secret),
          tokenHash: hashSecret(secret),
          scope: 'radars:read radars:write radars:manage',
          ...(agentId
            ? { agentId, voiceGrants: ['persona', 'principal'], defaultVoice: 'persona' }
            : {}),
        });
      const client = new Client({ name: 'blip-claims', version: '1' });
      clients.push(client);
      await client.connect(
        httpTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${secret}` } },
        }),
      );
      return { client, secret };
    };
    ({ client: writer, secret: patSecret } = await connect());
    agentA = (await createRepoAgent(owner, { name: `A ${randomUUID()}`, prompt: 'a' })).id;
    agentB = (await createRepoAgent(owner, { name: `B ${randomUUID()}`, prompt: 'b' })).id;
    boundA = (await connect(agentA)).client;
    boundB = (await connect(agentB)).client;
    sessionA = await loadSession(agentA);
    sessionB = await loadSession(agentB);
    board = (await createRadar(owner, { name: 'Claims board', template: 'kanban' })).id;
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (listener) await new Promise<void>((resolve) => must(listener).close(() => resolve()));
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('bumps the revision on every writer path, including raw SQL', async () => {
    const id = await card('revision trigger');
    expect((await stored(id)).revision).toBe(1);
    await getDb().execute(sql`UPDATE blips SET pinned = true WHERE id = ${id}`);
    expect((await stored(id)).revision).toBe(2);
    const r = await data<{ revision: number }>('update_blip', {
      blipId: id,
      title: 'x',
      session: sessionA,
    });
    expect(r.revision).toBe(3);
  });

  it('refuses the second writer on the same expectedRevision, with the current blip (MCP and REST)', async () => {
    const id = await card('race');
    const first = await data<{ revision: number }>('update_blip', {
      blipId: id,
      body: 'A wins',
      expectedRevision: 1,
      session: sessionA,
    });
    expect(first.revision).toBe(2);
    const lost = await call('update_blip', {
      blipId: id,
      body: 'B loses',
      expectedRevision: 1,
      session: sessionB,
    });
    expect(lost.error).toBe(true);
    expect(lost.text).toContain('revision 2, not 1');
    expect(lost.text).toContain('"revision": 2');
    expect(lost.text).toContain('A wins');
    expect((await stored(id)).body).toBe('A wins');

    const viaRest = await rest('PATCH', `/${id}`, { body: 'late', expectedRevision: 1 });
    expect(viaRest.status).toBe(409);
    expect(viaRest.json.error?.code).toBe('stale_revision');
    expect(viaRest.json.error?.current?.revision).toBe(2);
    // Callers that do not pass it keep last-writer-wins; the right one passes.
    expect((await rest('PATCH', `/${id}`, { body: 'no check' })).status).toBe(200);
    expect((await rest('PATCH', `/${id}`, { body: 'ok', expectedRevision: 3 })).status).toBe(200);
    // expectedRevision alone is not an edit.
    expect((await rest('PATCH', `/${id}`, { expectedRevision: 4 })).status).toBe(400);
  });

  it('keeps other agents off a claimed card but never the person, and an expired claim refuses nobody', async () => {
    const id = await card('claimed');
    const before = await stored(id);
    const claimed = await data<{ revision: number; claim: { name: string; until: string } }>(
      'claim_blip',
      { blipId: id, ttl: 600, session: sessionA },
    );
    expect(claimed.claim.name).toBeTruthy();
    const after = await stored(id);
    // A claim moves neither lane, state nor updated_at.
    expect([after.status, after.state, after.updatedAt]).toEqual([
      before.status,
      before.state,
      before.updatedAt,
    ]);

    const refused = await call('update_blip', {
      blipId: id,
      body: 'B barges in',
      session: sessionB,
    });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('until');
    expect((await call('claim_blip', { blipId: id, session: sessionB })).error).toBe(true);
    // The holder can still write; the person can too.
    const again = await card('claimed again');
    await data('claim_blip', { blipId: again, session: sessionA });
    expect(
      (await call('update_blip', { blipId: again, body: 'A edits', session: sessionA })).error,
    ).toBe(false);
    expect((await rest('PATCH', `/${again}`, { body: 'Lucas edits' })).status).toBe(200);
    // The person takes the claim over, so A is now the one refused.
    const taken = await rest('POST', `/${again}/claim`, { ttl: 600 });
    expect(taken.status).toBe(200);
    expect(taken.json.blip?.claim?.agentId).toBeNull();
    expect(
      (await call('update_blip', { blipId: again, body: 'A again', session: sessionA })).error,
    ).toBe(true);
    // Release by the person; then it is free.
    expect(
      (await rest('POST', `/${again}/claim`, { release: true })).json.blip?.claim,
    ).toBeUndefined();
    expect(
      (await call('update_blip', { blipId: again, body: 'A free', session: sessionA })).error,
    ).toBe(false);

    // Expiry is computed against now(); nothing sweeps.
    const stale = await card('expired');
    await data('claim_blip', { blipId: stale, session: sessionA });
    await getDb().execute(
      sql`UPDATE blips SET claimed_until = now() - interval '1 minute' WHERE id = ${stale}`,
    );
    expect(
      (await call('update_blip', { blipId: stale, body: 'B ok', session: sessionB })).error,
    ).toBe(false);
    expect((await data<BlipDto>('get_blip', { blipId: stale })).claim).toBeUndefined();
  });

  it('refuses every token while a claim is live, takeOver or not, and only the browser writes over it', async () => {
    const id = await card('token writes');
    await data('claim_blip', { blipId: id, session: sessionA });
    // The ways in without a cookie: a PAT, an OAuth grant, a session token as a bearer and on /mcp.
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_blip_claims',
        userId: owner.user.id,
        scope: 'radars:read radars:write radars:manage',
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const sessionToken = (await createSession(owner.user)).token;
    const mcpWith = async (token: string) => {
      const client = new Client({ name: 'blip-claims-bearer', version: '1' });
      clients.push(client);
      await client.connect(
        httpTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    const unclaimed = /claimed by .* until .*ask a person in the browser/s;
    const unbound = [writer, await mcpWith(access), await mcpWith(sessionToken)];
    // A claim must name an agent, so a sessionless token is refused before it reaches the claim.
    for (const client of unbound) {
      for (const args of [{ blipId: id }, { blipId: id, release: true }]) {
        const refused = await call('claim_blip', args, client);
        expect(refused.error).toBe(true);
        expect(refused.text).toMatch(/session/);
        expect(refused.text).not.toContain('"claim"');
      }
    }
    for (const client of [...unbound, boundB]) {
      for (const [tool, args] of [
        ['update_blip', { blipId: id, body: 'barge' }],
        ['delete_blip', { blipId: id }],
        ...(client === boundB
          ? ([
              ['claim_blip', { blipId: id }],
              ['claim_blip', { blipId: id, release: true }],
            ] as const)
          : []),
      ] as const) {
        // `takeOver` is gone from the API: sent by an old client, it is dropped and changes nothing.
        for (const extra of [{}, { takeOver: true }]) {
          const refused = await call(tool, { ...args, ...extra }, client);
          expect(refused.error, tool).toBe(true);
          expect(refused.text, tool).toContain('"claim"');
        }
      }
    }
    expect((await call('update_blip', { blipId: id, body: 'x' })).text).toMatch(unclaimed);
    expect((await call('update_blip', { blipId: id, body: 'x' }, boundB)).text).toContain(
      'Leave it to the claimant',
    );
    // The holder's own bound credential passes without a session.
    expect((await call('update_blip', { blipId: id, body: 'mine' }, boundA)).error).toBe(false);
    // REST on a token: 409 `claimed` with the claim, takeOver on the query or in the body ignored.
    for (const token of [patSecret, access, sessionToken]) {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const patch = await fetch(`${base}/api/blips/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body: 'rest', takeOver: true }),
      });
      expect(patch.status).toBe(409);
      const body = (await patch.json()) as { error: { code: string; current: BlipDto } };
      expect(body.error.code).toBe('claimed');
      expect(body.error.current.claim?.agentId).toBe(agentA);
      const del = await fetch(`${base}/api/blips/${id}?takeOver=true`, {
        method: 'DELETE',
        headers,
      });
      expect(del.status).toBe(409);
    }
    expect((await stored(id)).body).toBe('mine');
    // The person in the browser writes over it, without saying anything.
    expect((await rest('PATCH', `/${id}`, { body: 'person' })).status).toBe(200);
    expect((await rest('DELETE', `/${id}`)).status).toBe(204);
  });

  it('refuses a lane and a state that contradict over MCP, naming the lane’s state', async () => {
    const id = await card('mixed over the wire');
    const refused = await call('update_blip', { blipId: id, status: 'todo', state: 'done' });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/Lane "To do" \(todo\) means state "later"/);
    expect((await stored(id)).state).toBe('later');
    const ok = await data<BlipDto>('update_blip', { blipId: id, status: 'done' });
    expect(ok).toMatchObject({ status: 'done', state: 'done' });
  });

  it('keeps a claim a person made in the browser from every sessionless token, even the same account’s', async () => {
    const id = await card('human held');
    expect((await rest('POST', `/${id}/claim`, { ttl: 600 })).status).toBe(200);
    const held = await stored(id);
    expect(held.claimedByUserId).toBe(owner.user.id);
    expect(held.claimedByAgentId).toBeNull();
    // A sessionless release is refused for want of an agent; with a session it meets the claim.
    const noSession = await call('claim_blip', { blipId: id, release: true });
    expect(noSession.error).toBe(true);
    expect(noSession.text).toMatch(/session/);
    for (const [tool, args] of [
      ['update_blip', { blipId: id, body: 'barge' }],
      ['delete_blip', { blipId: id }],
      ['claim_blip', { blipId: id, release: true, session: sessionA }],
    ] as const) {
      const refused = await call(tool, args);
      expect(refused.error, tool).toBe(true);
      expect(refused.text, tool).toContain('"claim"');
      // An agent session on the same account is not the holder either.
      expect((await call(tool, { ...args, session: sessionA })).error, tool).toBe(true);
    }
    expect((await stored(id)).body).toBe('human held');
    expect((await rest('POST', `/${id}/claim`, { release: true })).status).toBe(200);
    expect((await call('update_blip', { blipId: id, body: 'free' })).error).toBe(false);
  });

  it('refuses a sessionless claim from every non-person bearer, naming session', async () => {
    const id = await card('sessionless');
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_blip_claims',
        userId: owner.user.id,
        scope: 'radars:read radars:write radars:manage',
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const web = (await createSession(owner.user, { client: 'web' })).token;
    const cli = (await createSession(owner.user, { client: 'cli' })).token;
    const ios = (await createSession(owner.user, { client: 'ios' })).token;
    const mcpWith = async (token: string) => {
      const client = new Client({ name: 'blip-claims-sessionless', version: '1' });
      clients.push(client);
      await client.connect(
        httpTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    // /mcp: a PAT, an OAuth grant, a session token. Taking, renewing and releasing all need an agent.
    for (const client of [writer, await mcpWith(access), await mcpWith(web), await mcpWith(ios)]) {
      for (const args of [{ blipId: id }, { blipId: id, release: true }]) {
        const refused = await call('claim_blip', args, client);
        expect(refused.error).toBe(true);
        expect(refused.text).toMatch(/session/);
      }
    }
    // REST: the same bearers, bar the iOS app's, which is a person.
    const post = (token: string, body: unknown) =>
      fetch(`${base}/api/blips/${id}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const token of [patSecret, access, web, cli]) {
      for (const body of [{}, { release: true }]) {
        const res = await post(token, body);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
          /session/,
        );
      }
    }
    expect((await stored(id)).claimedUntil).toBeNull();

    // Unchanged: an agent by session, an agent-bound credential, the browser, the app.
    const bySession = await card('by session');
    await data('claim_blip', { blipId: bySession, session: sessionA });
    expect((await stored(bySession)).claimedByAgentId).toBe(agentA);
    const bySecret = await card('by bound credential');
    expect((await call('claim_blip', { blipId: bySecret }, boundA)).error).toBe(false);
    expect((await stored(bySecret)).claimedByAgentId).toBe(agentA);
    const byBrowser = await card('by browser');
    expect((await rest('POST', `/${byBrowser}/claim`, { ttl: 600 })).status).toBe(200);
    const byApp = await card('by app');
    const app = await fetch(`${base}/api/blips/${byApp}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ios}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(app.status).toBe(200);
  });

  it('lets the native app’s own session token act as the person on a claim, and no other bearer', async () => {
    const id = await card('app held');
    expect((await rest('POST', `/${id}/claim`, { ttl: 600 })).status).toBe(200);
    const bearer = async (client: 'web' | 'ios' | 'cli') => ({
      authorization: `Bearer ${(await createSession(owner.user, { client })).token}`,
      'content-type': 'application/json',
    });
    const patch = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/api/blips/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body }),
      });
    // A session token from the web or the CLI is a credential an agent could hold.
    for (const client of ['web', 'cli'] as const) {
      expect((await patch(await bearer(client), 'x')).status, client).toBe(409);
    }
    // The iOS app's session token, from a human sign-in, edits and releases a card the person claimed.
    const ios = await bearer('ios');
    expect((await patch(ios, 'edited on the phone')).status).toBe(200);
    expect((await stored(id)).body).toBe('edited on the phone');
    // The same token on /mcp is an agent connection, so the claim holds.
    const viaMcp = new Client({ name: 'blip-claims-ios-mcp', version: '1' });
    clients.push(viaMcp);
    await viaMcp.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: ios.authorization } },
      }),
    );
    expect((await call('update_blip', { blipId: id, body: 'mcp' }, viaMcp)).error).toBe(true);
    const release = await fetch(`${base}/api/blips/${id}/claim`, {
      method: 'POST',
      headers: ios,
      body: JSON.stringify({ release: true }),
    });
    expect(release.status).toBe(200);
    expect((await rest('POST', `/${id}/claim`, { ttl: 600 })).status).toBe(200);
    expect(
      (await fetch(`${base}/api/blips/${id}`, { method: 'DELETE', headers: ios })).status,
    ).toBe(204);
  });

  it('gives a bearer session no implicit takeover, and lets the claiming agent delete with its session', async () => {
    const id = await card('bearer session');
    await data('claim_blip', { blipId: id, session: sessionA });
    // A first-party session token as a bearer is the same person, but not the browser cookie.
    const bearer = {
      authorization: `Bearer ${(await createSession(owner.user)).token}`,
      'content-type': 'application/json',
    };
    const url = `${base}/api/blips/${id}`;
    const patch = await fetch(url, { method: 'PATCH', headers: bearer, body: '{"body":"x"}' });
    expect(patch.status).toBe(409);
    expect((await fetch(url, { method: 'DELETE', headers: bearer })).status).toBe(409);
    expect((await stored(id)).body).toBe('bearer session');
    // delete_blip carries the load_agent session: B is refused, the holder A is not.
    expect((await call('delete_blip', { blipId: id, session: sessionB })).error).toBe(true);
    expect((await call('delete_blip', { blipId: id, session: sessionA })).error).toBe(false);
  });

  it('refuses a ttl over four hours, and claims or assignees on a template that does not take them', async () => {
    const id = await card('ttl');
    const named = { blipId: id, session: sessionA };
    expect((await call('claim_blip', { ...named, ttl: 4 * 3600 + 1 })).error).toBe(true);
    expect((await call('claim_blip', { ...named, ttl: 4 * 3600 })).error).toBe(false);
    const stream = await createRadar(owner, { name: 'Plain stream', template: 'stream' });
    const plain = (await createBlip(owner, stream.id, { body: 'plain' })).id;
    const claim = await call('claim_blip', { blipId: plain, session: sessionA });
    expect(claim.error).toBe(true);
    expect(claim.text).toContain('does not take claims');
    const assign = await call('update_blip', { blipId: plain, assigneeUserId: owner.user.id });
    expect(assign.error).toBe(true);
    expect(assign.text).toContain('cannot be assigned');
  });

  it('shows revision, assignee and claim on reads, and hides them once the template stops taking them', async () => {
    const id = await card('shown');
    await data('update_blip', {
      blipId: id,
      assigneeUserId: owner.user.id,
      assigneeAgentId: agentA,
    });
    await data('claim_blip', { blipId: id, session: sessionA });
    const full = await data<BlipDto>('get_blip', { blipId: id });
    expect(full.revision).toBeGreaterThan(1);
    expect(full.assignee).toMatchObject({ userId: owner.user.id, agentId: agentA });
    expect(full.claim).toMatchObject({ agentId: agentA });
    const radar = await data<{
      blips: Array<{ id: string; revision: number; assignee?: unknown; claim?: unknown }>;
    }>('read_radar', { radarId: board });
    const row = must(radar.blips.find((b) => b.id === id));
    expect(row.revision).toBe(full.revision);
    expect(row.assignee).toBeTruthy();
    expect(row.claim).toBeTruthy();
    // An assignee must be somebody who can open the radar.
    const [stranger] = await getDb()
      .insert(schema.users)
      .values({ email: `stranger-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const nope = await call('update_blip', {
      blipId: id,
      assigneeUserId: must(stranger).id,
      session: sessionA,
    });
    expect(nope.text).toContain('cannot open this radar');
    expect(nope.error).toBe(true);
    // The template stops taking assignees: stored values are ignored, not deleted.
    await updateRadar(owner, board, { template: 'stream' });
    const hidden = await data<BlipDto>('get_blip', { blipId: id });
    expect(hidden.assignee).toBeUndefined();
    expect(hidden.claim).toBeUndefined();
    expect((await stored(id)).assigneeAgentId).toBe(agentA);
    await updateRadar(owner, board, { template: 'kanban' });
    expect((await data<BlipDto>('get_blip', { blipId: id })).claim).toBeTruthy();
  });
});

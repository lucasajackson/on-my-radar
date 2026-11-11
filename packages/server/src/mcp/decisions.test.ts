/** Decision requests (D1): asking over MCP and REST, answering over REST only, against a real Postgres. */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecisionRequestDto } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { createSession } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { proposeAdr } from '../services/architecture.js';
import { createBlip } from '../services/blips.js';
import { readDecisionRequestsFor } from '../services/decision-live.js';
import { drainDue } from '../services/outbox.js';
import { createRadar, updateRadar } from '../services/radars.js';
import { createRepoAgent, setAgentRadars } from '../services/repo-agents.js';
import { httpTransport } from './test-client.js';

describe.skipIf(!process.env['DATABASE_URL'])('decision requests', () => {
  const database = `omr_decisions_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let base: string;
  let owner: Actor;
  let cookie: string;
  let otherCookie: string;
  let aliceCookie: string;
  let aliceId: string;
  let agentClient: Client;
  let agentSecret: string;
  let agentId: string;
  let session: string;
  let board: string;
  let log: string;
  const clients: Client[] = [];

  async function ask(args: Record<string, unknown>, client: Client = agentClient) {
    const result = await client.callTool({ name: 'request_decision', arguments: args });
    const text = must(
      (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
        ?.text,
    );
    return { error: result.isError === true, text };
  }
  /** Every response shape these tests read, so one helper serves them all. */
  interface Reply {
    requests: DecisionRequestDto[];
    request: DecisionRequestDto;
    items: Array<{
      kind: string;
      title: string;
      excerpt: string | null;
      read: boolean;
      blipId: string | null;
    }>;
    total: number;
    unseen: number;
    byRadar: Record<string, number>;
    error?: { code: string; message: string };
  }
  async function rest(
    method: string,
    path: string,
    body?: unknown,
    as: { cookie?: string; bearer?: string } = { cookie },
  ) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(as.bearer ? { authorization: `Bearer ${as.bearer}` } : { cookie: as.cookie ?? cookie }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as Reply,
    };
  }
  const requestsOn = async (blipId: string, as?: { cookie?: string; bearer?: string }) =>
    (await rest('GET', `/blips/${blipId}/decisions`, undefined, as)).json.requests;
  const answer = (
    blipId: string,
    requestId: string,
    text: string,
    as?: { cookie?: string; bearer?: string },
  ) => rest('POST', `/blips/${blipId}/decisions/${requestId}/answer`, { answer: text }, as);
  const counts = async (box?: 'needs_you' | 'agents_reported') =>
    (await rest('GET', `/notifications/counts${box ? `?box=${box}` : ''}`)).json;
  const inbox = async (box: 'needs_you' | 'agents_reported') =>
    (await rest('GET', `/notifications?box=${box}&limit=100`)).json.items;
  const drain = async () => {
    while ((await drainDue(50)) > 0);
  };
  const card = async (radar: string, body: string, status?: string) =>
    (await createBlip(owner, radar, { body, ...(status ? { status } : {}) })).id;
  /** The agent asks over MCP; returns the request id. */
  async function agentAsks(blipId: string, extra: Record<string, unknown> = {}) {
    const asked = await ask({
      blipId,
      context: 'Release is blocked on this choice',
      question: 'Which way?',
      session,
      ...extra,
    });
    expect(asked.error, asked.text).toBe(false);
    await drain();
    return (JSON.parse(asked.text) as { id: string }).id;
  }
  const stored = async (blipId: string) =>
    must((await getDb().select().from(schema.blips).where(eq(schema.blips.id, blipId)))[0]);

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
        SESSION_SECRET: 'decisions-synthetic-session-secret',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const [user, other, alice] = await getDb()
      .insert(schema.users)
      .values(
        ['Lucas', 'Other', 'Alice'].map((name) => ({
          name,
          email: `${name}-${randomUUID()}@example.test`,
          state: 'active' as const,
        })),
      )
      .returning();
    owner = { user: must(user), kind: 'user' };
    cookie = `omr_session=${(await createSession(owner.user)).token}`;
    otherCookie = `omr_session=${(await createSession(must(other))).token}`;
    aliceCookie = `omr_session=${(await createSession(must(alice))).token}`;
    aliceId = must(alice).id;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;

    agentId = (await createRepoAgent(owner, { name: `Asker ${randomUUID()}`, prompt: 'a' })).id;
    agentSecret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: owner.user.id,
        name: 'decisions',
        prefix: tokenPrefix(agentSecret),
        tokenHash: hashSecret(agentSecret),
        scope: 'radars:read radars:write radars:manage',
        agentId,
        voiceGrants: ['persona', 'principal'],
        defaultVoice: 'persona',
      });
    agentClient = new Client({ name: 'decisions', version: '1' });
    clients.push(agentClient);
    await agentClient.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${agentSecret}` } },
      }),
    );
    const loaded = await agentClient.callTool({
      name: 'load_agent',
      arguments: { agent: agentId, harness: 'codex' },
    });
    const blocks = loaded.content as Array<{ text?: string }>;
    session = (JSON.parse(must(blocks[blocks.length - 1]?.text)) as { session: string }).session;

    board = (await createRadar(owner, { name: 'Board', template: 'kanban' })).id;
    log = (await createRadar(owner, { name: 'Log', template: 'decisions' })).id;
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: board, userId: must(other).id, role: 'viewer' });
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

  it('refuses a request with no context, or more than one line, on both transports', async () => {
    const id = await card(board, 'needs a choice', 'todo');
    const rest400 = await rest('POST', `/blips/${id}/decisions`, { question: 'Which?' });
    expect(rest400.status).toBe(400);
    const mcp = await ask({ blipId: id, question: 'Which?', session });
    expect(mcp.error).toBe(true);
    for (const context of ['line one\nline two', 'x'.repeat(201)]) {
      expect(
        (await rest('POST', `/blips/${id}/decisions`, { context, question: 'Which?' })).status,
      ).toBe(400);
      expect((await ask({ blipId: id, context, question: 'Which?', session })).error).toBe(true);
    }
    // The table holds the line even for a writer that skips the schema.
    await expect(
      getDb().execute(sql`
        INSERT INTO decision_requests (blip_id, radar_id, context, question, template)
        SELECT id, radar_id, E'two\nlines', 'q', 'kanban' FROM blips WHERE id = ${id}`),
    ).rejects.toThrow();
    expect(await requestsOn(id)).toEqual([]);
  });

  it('puts an agent’s question to its own owner in "Needs you", and tells the agent the answer', async () => {
    const id = await card(log, 'Adopt the new queue?');
    const requestId = await agentAsks(id);

    const needs = await inbox('needs_you');
    expect(needs.map((n) => n.kind)).toContain('decision');
    expect(needs.find((n) => n.kind === 'decision')?.excerpt).toBe(
      'Release is blocked on this choice',
    );
    expect((await inbox('agents_reported')).map((n) => n.kind)).not.toContain('decision');
    const [open] = await requestsOn(id);
    expect(open).toMatchObject({
      id: requestId,
      status: 'open',
      decides: true,
      canAnswer: true,
      options: [
        { value: 'accepted', label: 'Accepted' },
        { value: 'rejected', label: 'Rejected' },
      ],
    });

    const before = (await counts('needs_you')).total;
    const done = await answer(id, requestId, 'accepted');
    expect(done.status).toBe(200);
    expect(done.json.request).toMatchObject({ status: 'answered', answer: 'accepted' });
    expect((await stored(id)).status).toBe('accepted');
    expect((await counts('needs_you')).total).toBe(before - 1);

    await drain();
    const told = await agentClient.callTool({
      name: 'list_notifications',
      arguments: { session, kind: 'decision_answered' },
    });
    const items = (
      JSON.parse(must((told.content as Array<{ text?: string }>)[0]?.text)) as {
        items: Array<{ summary: string; excerpt?: string }>;
      }
    ).items;
    expect(items.map((n) => n.excerpt)).toContain('accepted');
    // Once answered it is answered: the same answer again is refused, the card untouched.
    expect((await answer(id, requestId, 'rejected')).status).toBe(409);
    expect((await stored(id)).status).toBe('accepted');
  });

  it('moves an Architecture ADR through ratification when its question is answered', async () => {
    const arch = (await createRadar(owner, { name: 'Arch', template: 'architecture' })).id;
    const { adr } = await proposeAdr(owner, arch, {
      title: 'ADR-1: Use queues',
      rationale: 'Because.',
      anchors: [],
    });
    const requestId = await agentAsks(adr.id);
    expect((await answer(adr.id, requestId, 'accepted')).status).toBe(200);
    const row = await stored(adr.id);
    expect(row.status).toBe('accepted');
    expect(row.ratifiedAt).toBeInstanceOf(Date);
  });

  it('refuses to address a viewer where answering moves the card, and only there', async () => {
    const grant = (radarId: string, role: 'viewer' | 'editor') =>
      getDb().insert(schema.radarMembers).values({ radarId, userId: aliceId, role });
    const blip = await card(log, 'viewer cannot decide', 'proposed');
    const asked = (blipId: string) =>
      ask({ blipId, context: 'Needs a call', question: 'Which?', session, addresseeId: aliceId });
    await grant(log, 'viewer');
    const refused = await asked(blip);
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('can only view this radar');
    const rows = () =>
      getDb()
        .select()
        .from(schema.decisionRequests)
        .where(eq(schema.decisionRequests.blipId, blip));
    expect(await rows()).toEqual([]);
    // The same viewer is a fine addressee on a template that declares no `decides`.
    await grant(board, 'viewer');
    expect((await asked(await card(board, 'free text', 'todo'))).error).toBe(false);
    // An editor can answer, so an editor can be asked.
    await getDb()
      .update(schema.radarMembers)
      .set({ role: 'editor' })
      .where(and(eq(schema.radarMembers.radarId, log), eq(schema.radarMembers.userId, aliceId)));
    expect((await asked(blip)).error).toBe(false);
    expect(await rows()).toHaveLength(1);
    await getDb().delete(schema.radarMembers).where(eq(schema.radarMembers.userId, aliceId));
  });

  it('refuses an answer from an agent, and from anyone but the addressee', async () => {
    const id = await card(board, 'who answers', 'todo');
    const requestId = await agentAsks(id);
    const viaAgent = await answer(id, requestId, 'yes', { bearer: agentSecret });
    expect(viaAgent.status).toBe(403);
    const viaOther = await answer(id, requestId, 'yes', { cookie: otherCookie });
    expect(viaOther.status).toBe(403);
    expect((await requestsOn(id))[0]?.status).toBe('open');
    // There is no tool for it either.
    const tools = (await agentClient.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('request_decision');
    expect(tools.filter((n) => /answer/.test(n))).toEqual([]);
  });

  it('hands the agent the whole request and answer, and the card’s questions on get_blip', async () => {
    const id = await card(board, 'Which restriction?', 'todo');
    const requestId = await agentAsks(id);
    // 254 characters, fenced markdown and a restriction at the very end: nothing may be trimmed.
    const long = `${'Ship it behind the flag. '.repeat(8)}\`\`\`\nNever before Friday\n\`\`\` **Restriction: not in EU**`;
    expect(long.length).toBeGreaterThan(220);
    expect((await answer(id, requestId, long)).status).toBe(200);
    await drain();
    const told = await agentClient.callTool({
      name: 'list_notifications',
      arguments: { session, kind: 'decision_answered', limit: 50 },
    });
    const items = (
      JSON.parse(must((told.content as Array<{ text?: string }>)[0]?.text)) as {
        items: Array<{ decision?: { requestId: string; question: string; answer: string } }>;
      }
    ).items;
    expect(items.find((n) => n.decision?.requestId === requestId)?.decision).toMatchObject({
      question: 'Which way?',
      answer: long,
    });
    const got = await agentClient.callTool({ name: 'get_blip', arguments: { blipId: id } });
    const blip = JSON.parse(must((got.content as Array<{ text?: string }>)[0]?.text)) as {
      decisionRequests?: Array<{ id: string; status: string; answer: string }>;
    };
    expect(blip.decisionRequests).toMatchObject([
      { id: requestId, status: 'answered', answer: long },
    ]);
  });

  it('shows a decision’s words only to someone who can read the radar it was asked on, now', async () => {
    const A = (await createRadar(owner, { name: 'Radar A', template: 'kanban' })).id;
    const B = (await createRadar(owner, { name: 'Radar B', template: 'kanban' })).id;
    const member = (radarId: string) =>
      getDb().insert(schema.radarMembers).values({ radarId, userId: aliceId, role: 'viewer' });
    await member(A);
    await member(B);
    const dropAlice = (radarId: string) =>
      getDb().execute(
        sql`DELETE FROM radar_members WHERE radar_id = ${radarId}::uuid AND user_id = ${aliceId}::uuid`,
      );
    const alices = async () =>
      (await rest('GET', '/notifications?limit=100', undefined, { cookie: aliceCookie })).json
        .items;
    const askAsAlice = async (blipId: string) => {
      const made = await rest(
        'POST',
        `/blips/${blipId}/decisions`,
        {
          context: 'ALICE-CONTEXT-SECRET',
          question: 'ALICE-QUESTION-SECRET',
          addresseeId: owner.user.id,
        },
        { cookie: aliceCookie },
      );
      expect(made.status).toBe(201);
      return made.json.request.id;
    };

    // Answered while she can read A: she is told, with the words.
    const told = await card(A, 'ANSWERED-WHILE-SHE-READS', 'todo');
    const toldId = await askAsAlice(told);
    expect((await answer(told, toldId, 'ANSWER-SECRET-ONE')).status).toBe(200);
    expect((await alices()).find((n) => n.kind === 'decision_answered')?.excerpt).toBe(
      'ANSWER-SECRET-ONE',
    );
    // She loses A, the card moves to B where she reads: the notification follows the card, the words do not.
    await dropAlice(A);
    expect((await rest('PATCH', `/blips/${told}`, { radarId: B, status: 'todo' })).status).toBe(
      200,
    );
    const after = (await alices()).find((n) => n.kind === 'decision_answered');
    expect(after).toMatchObject({
      title: 'A decision on a card you can no longer see',
      excerpt: null,
    });
    expect(JSON.stringify(after)).not.toMatch(/ANSWER-SECRET|ALICE-|ANSWERED-WHILE/);

    // She still reads both radars: the card having left A is enough to hide the words.
    await member(A);
    const hopped = await card(A, 'HOPPED-CARD', 'todo');
    const hoppedId = await askAsAlice(hopped);
    expect((await answer(hopped, hoppedId, 'ANSWER-SECRET-HOP')).status).toBe(200);
    expect((await rest('PATCH', `/blips/${hopped}`, { radarId: B, status: 'todo' })).status).toBe(
      200,
    );
    const hop = (await alices()).find(
      (n) => n.blipId === null && n.kind === 'decision_answered' && n.excerpt === null,
    );
    expect(hop).toBeDefined();
    expect(JSON.stringify(await alices())).not.toContain('ANSWER-SECRET-HOP');
    await dropAlice(A);

    // Answered after she lost the radar: nothing is created for her at all.
    await member(A);
    const gone = await card(A, 'ANSWERED-AFTER-SHE-LEFT', 'todo');
    const goneId = await askAsAlice(gone);
    await dropAlice(A);
    expect((await answer(gone, goneId, 'ANSWER-SECRET-TWO')).status).toBe(200);
    await drain();
    expect(JSON.stringify(await alices())).not.toContain('ANSWER-SECRET-TWO');
    expect(
      (
        await getDb().execute(
          sql`SELECT 1 FROM notifications WHERE group_key = ${`decision_answered:${goneId}`}`,
        )
      ).rows,
    ).toHaveLength(0);

    // The rule itself, in one statement: the card is on A, she lacks A, so the words are not read.
    const row = (
      await getDb()
        .select()
        .from(schema.decisionRequests)
        .where(eq(schema.decisionRequests.id, goneId))
    )[0];
    expect(row?.radarId).toBe(A);
    const byId = eq(schema.decisionRequests.id, goneId);
    expect(await readDecisionRequestsFor(aliceId, byId)).toEqual([]);
    expect(await readDecisionRequestsFor(owner.user.id, byId)).toHaveLength(1);
    await member(A);
    expect(await readDecisionRequestsFor(aliceId, byId)).toHaveLength(1);
  });

  it('gives a limited agent nothing of a decision on a radar outside its fence', async () => {
    const A = (await createRadar(owner, { name: 'Outside fence', template: 'kanban' })).id;
    const inside = (await createRadar(owner, { name: 'Inside fence', template: 'kanban' })).id;
    const limitedId = (
      await createRepoAgent(owner, { name: `Limited ${randomUUID()}`, prompt: 'l' })
    ).id;
    const secret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: owner.user.id,
        name: 'limited',
        prefix: tokenPrefix(secret),
        tokenHash: hashSecret(secret),
        scope: 'radars:read radars:write radars:manage',
        agentId: limitedId,
        voiceGrants: ['persona', 'principal'],
        defaultVoice: 'persona',
      });
    const limited = new Client({ name: 'limited', version: '1' });
    clients.push(limited);
    await limited.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
      }),
    );
    const loaded = await limited.callTool({
      name: 'load_agent',
      arguments: { agent: limitedId, harness: 'codex' },
    });
    const blocks = loaded.content as Array<{ text?: string }>;
    const limitedSession = (
      JSON.parse(must(blocks[blocks.length - 1]?.text)) as { session: string }
    ).session;
    const id = await card(A, 'FENCED-CARD', 'todo');
    const asked = await ask(
      {
        blipId: id,
        context: 'FENCED-CONTEXT',
        question: 'FENCED-QUESTION',
        session: limitedSession,
      },
      limited,
    );
    expect(asked.error, asked.text).toBe(false);
    const requestId = (JSON.parse(asked.text) as { id: string }).id;
    await drain();
    expect((await answer(id, requestId, 'FENCED-ANSWER')).status).toBe(200);
    await drain();

    // Now the agent is limited to a radar that is not A.
    await setAgentRadars(owner, limitedId, {
      scope: 'selected',
      grants: [{ radarId: inside, ceiling: 'write' }],
    });
    const queue = await limited.callTool({
      name: 'list_notifications',
      arguments: { session: limitedSession, limit: 50 },
    });
    expect(JSON.stringify(queue.content)).not.toMatch(/FENCED-/);
    const read = await limited.callTool({ name: 'get_blip', arguments: { blipId: id } });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read.content)).not.toMatch(/FENCED-/);

    // The rule itself: the same person reads the request, the agent's fence does not.
    const byId = eq(schema.decisionRequests.id, requestId);
    expect(await readDecisionRequestsFor(owner.user.id, byId)).toHaveLength(1);
    expect(await readDecisionRequestsFor(owner.user.id, byId, [A])).toHaveLength(1);
    expect(await readDecisionRequestsFor(owner.user.id, byId, [inside])).toEqual([]);
    expect(await readDecisionRequestsFor(owner.user.id, byId, [])).toEqual([]);
  });

  it('lists every open request however many were answered since, and answers an old one', async () => {
    const radar = (await createRadar(owner, { name: 'Busy card', template: 'kanban' })).id;
    const id = await card(radar, 'many questions', 'todo');
    const oldest = await agentAsks(id);
    for (let i = 0; i < 22; i += 1)
      await getDb().execute(sql`
        INSERT INTO decision_requests (blip_id, radar_id, requester_user_id, addressee_user_id, context, question, template, lane, status, answer, answered_at)
        SELECT id, radar_id, ${owner.user.id}::uuid, ${owner.user.id}::uuid, 'done', 'q', 'kanban', 'todo', 'answered', 'a', now() FROM blips WHERE id = ${id}`);
    // Answered requests left on another radar by a card that has since moved do not use up the 20.
    const elsewhere = (await createRadar(owner, { name: 'Left behind', template: 'kanban' })).id;
    await getDb().execute(sql`
      INSERT INTO decision_requests (blip_id, radar_id, requester_user_id, addressee_user_id, context, question, template, lane, status, answer, answered_at)
      SELECT ${id}::uuid, ${elsewhere}::uuid, ${owner.user.id}::uuid, ${owner.user.id}::uuid, 'stale', 'q', 'kanban', 'todo', 'answered', 'a', now() + interval '1 hour'
        FROM generate_series(1, 21)`);
    const listed = await requestsOn(id);
    expect(listed.filter((r) => r.status === 'answered')).toHaveLength(20);
    expect(listed.find((r) => r.id === oldest)?.status).toBe('open');
    const done = await answer(id, oldest, 'fine');
    expect(done.status).toBe(200);
    expect(done.json.request).toMatchObject({ id: oldest, status: 'answered' });
  });

  it('takes a free-text answer on a board without moving the card', async () => {
    const id = await card(board, 'Which vendor?', 'todo');
    const requestId = await agentAsks(id, { options: ['Acme', 'Globex'] });
    const [open] = await requestsOn(id);
    expect(open).toMatchObject({
      decides: false,
      options: [
        { value: 'Acme', label: 'Acme' },
        { value: 'Globex', label: 'Globex' },
      ],
    });
    expect((await answer(id, requestId, 'Neither: build it')).status).toBe(200);
    expect((await stored(id)).status).toBe('todo');
    // Answered once: a second answer finds nothing waiting, whatever the lane.
    expect((await answer(id, requestId, 'Both')).status).toBe(409);
    expect((await requestsOn(id))[0]?.answer).toBe('Neither: build it');
    // On a template that decides, the answer must be one of the outcomes.
    const adrCard = await card(log, 'Pick');
    const second = await agentAsks(adrCard);
    expect((await answer(adrCard, second, 'maybe')).status).toBe(400);
    // A lane of the radar that is not one of the outcomes is not an answer either.
    expect((await answer(adrCard, second, 'superseded')).status).toBe(400);
    expect((await requestsOn(adrCard))[0]?.status).toBe('open');
    expect((await stored(adrCard)).status).toBe('proposed');
  });

  it('reads as overtaken once the card leaves the lane it was asked in', async () => {
    const id = await card(board, 'moves on', 'todo');
    const requestId = await agentAsks(id);
    await rest('PATCH', `/blips/${id}`, { status: 'doing' });
    const [overtaken] = await requestsOn(id);
    expect(overtaken).toMatchObject({ status: 'overtaken', canAnswer: false });
    expect((await answer(id, requestId, 'late')).status).toBe(409);
    // A template change overtakes it too, though the card's lane value is untouched.
    const other = await card(board, 'template changes', 'todo');
    const second = await agentAsks(other);
    await updateRadar(owner, board, { template: 'stream' });
    expect((await requestsOn(other))[0]).toMatchObject({ status: 'overtaken' });
    expect((await answer(other, second, 'late')).status).toBe(409);
    await updateRadar(owner, board, { template: 'kanban' });
    expect((await requestsOn(other))[0]?.status).toBe('open');
    // Never deleted, and it returns if the card goes back.
    await rest('PATCH', `/blips/${id}`, { status: 'todo' });
    expect((await requestsOn(id))[0]?.status).toBe('open');
  });

  it('fences a request to the radar the card is on now', async () => {
    const id = await card(board, 'travels', 'todo');
    const requestId = await agentAsks(id);
    const elsewhere = (await createRadar(owner, { name: 'Elsewhere', template: 'kanban' })).id;
    const needsBefore = (await counts('needs_you')).total;
    expect(
      (await rest('PATCH', `/blips/${id}`, { radarId: elsewhere, status: 'todo' })).status,
    ).toBe(200);
    expect(await requestsOn(id)).toEqual([]);
    expect((await counts('needs_you')).total).toBe(needsBefore - 1);
    expect((await answer(id, requestId, 'x')).status).toBe(409);
    expect(
      (
        await getDb()
          .select()
          .from(schema.decisionRequests)
          .where(eq(schema.decisionRequests.id, requestId))
      )[0]?.status,
    ).toBe('open');
  });

  it('hides open requests and refuses new ones when comments are off, and keeps them', async () => {
    const radar = (await createRadar(owner, { name: 'Quiet', template: 'kanban' })).id;
    const id = await card(radar, 'quiet card', 'todo');
    const requestId = await agentAsks(id);
    const needsBefore = (await counts('needs_you')).total;
    await updateRadar(owner, radar, { commentsEnabled: false });
    expect(await requestsOn(id)).toEqual([]);
    expect((await counts('needs_you')).total).toBe(needsBefore - 1);
    const refused = await ask({ blipId: id, context: 'again', question: 'Still?', session });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/Comments are turned off/);
    await updateRadar(owner, radar, { commentsEnabled: true });
    expect((await requestsOn(id))[0]).toMatchObject({ id: requestId, status: 'open' });
    expect((await counts('needs_you')).total).toBe(needsBefore);
  });

  it('holds a requester to ten open questions, and an answer makes room', async () => {
    const radar = (await createRadar(owner, { name: 'Capped', template: 'kanban' })).id;
    // Earlier tests left some of this agent's questions open: start the count from none.
    await getDb().execute(
      sql`UPDATE decision_requests SET status = 'answered', answer = 'x', answered_at = now() WHERE status = 'open'`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = await card(radar, `cap ${i}`, 'todo');
      ids.push(id);
      await agentAsks(id);
    }
    const extra = await card(radar, 'one too many', 'todo');
    const over = await ask({ blipId: extra, context: 'eleventh', question: '?', session });
    expect(over.error).toBe(true);
    expect(over.text).toMatch(/10 questions waiting/);
    // A person asking is a different requester.
    expect(
      (await rest('POST', `/blips/${extra}/decisions`, { context: 'mine', question: '?' })).status,
    ).toBe(201);
    const [first] = await requestsOn(must(ids[0]));
    expect((await answer(must(ids[0]), must(first).id, 'done')).status).toBe(200);
    expect((await ask({ blipId: extra, context: 'now fine', question: '?', session })).error).toBe(
      false,
    );
  });

  it('counts only "Needs you" in the badge: people’s mentions and open questions, not agents’ reports', async () => {
    const radar = (await createRadar(owner, { name: 'Boxes', template: 'stream' })).id;
    const humanKey = `human:${randomUUID()}`;
    const agentKey = `agent:${randomUUID()}`;
    const mk = (kind: string, keys: string[], tag: string) =>
      getDb()
        .insert(schema.notifications)
        .values({
          userId: owner.user.id,
          kind: kind as 'mention',
          radarId: radar,
          groupKey: `${kind}:${tag}:${randomUUID()}`,
          actorKeys: keys,
          attributedEventCount: keys.length,
          count: 1,
        });
    await mk('mention', [humanKey], 'by a person');
    await mk('mention', [], 'legacy, who is unknown');
    await mk('mention', [agentKey], 'by an agent');
    await mk('comment', [humanKey], 'a comment');
    await mk('reaction', [agentKey], 'a reaction');
    const onRadar = async (box: 'needs_you' | 'agents_reported') =>
      (await rest('GET', `/notifications?box=${box}&radarId=${radar}`)).json.items
        .map((n) => n.kind)
        .sort();
    expect(await onRadar('needs_you')).toEqual(['mention', 'mention']);
    expect(await onRadar('agents_reported')).toEqual(['comment', 'mention', 'reaction']);
    const all = (await counts()).byRadar[radar];
    expect(all).toBe(5);
    expect((await counts('needs_you')).byRadar[radar]).toBe(2);
    expect((await counts('agents_reported')).byRadar[radar]).toBe(3);
    expect((await rest('GET', '/notifications?box=elsewhere')).status).toBe(400);
  });

  it('queues its events under their own outbox kind, which a previous pod never claims', async () => {
    const id = await card(board, 'queued', 'todo');
    // A person asking from the browser: a different requester than the capped agent.
    const asked = await rest('POST', `/blips/${id}/decisions`, {
      context: 'Own queue',
      question: '?',
    });
    expect(asked.status).toBe(201);
    const queued = await getDb().execute<{ kind: string }>(
      sql`SELECT kind FROM outbox WHERE payload->>'type' IN ('decision', 'decision-answered')`,
    );
    expect(queued.rows.length).toBeGreaterThan(0);
    expect(new Set(queued.rows.map((r) => r.kind))).toEqual(new Set(['decision-event']));
    await drain();
  });

  it('declares its authorship foreign keys SET NULL and deferrable', async () => {
    const rows = await getDb().execute<{
      conname: string;
      condeferrable: boolean;
      confdeltype: string;
    }>(sql`
      SELECT conname, condeferrable, confdeltype FROM pg_constraint
      WHERE conrelid = 'decision_requests'::regclass AND contype = 'f'
        AND conname ~ '(requester|addressee|answered_by)'`);
    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) {
      expect(row.condeferrable, row.conname).toBe(true);
      expect(row.confdeltype, row.conname).toBe('n');
    }
  });
});

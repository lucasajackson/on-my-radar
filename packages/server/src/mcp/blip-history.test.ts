/** Blip edit history (C3, ADR-0028): the creator stays, the editor is shown, over MCP and REST, on a real Postgres. */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlipDto, BlipRevisionDto } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { createSession } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { historyFor, revisionsIn } from '../services/blip-history.js';
import { updateBlip } from '../services/blips.js';
import { narrowBlip } from '../services/redaction.js';
import { createRadar } from '../services/radars.js';
import { createRepoAgent } from '../services/repo-agents.js';
import { httpTransport } from './test-client.js';

/** The parts of a tool answer these tests read. */
type Out = {
  id: string;
  agent?: { id: string };
  lastEditedBy?: { name: string };
  lastMovedBy?: { name: string };
  revisions: unknown[];
};

describe.skipIf(!process.env['DATABASE_URL'])('blip edit history', () => {
  const database = `omr_blip_history_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let base: string;
  let owner: Actor;
  let cookie: string;
  let human: Client;
  let connect: (bind?: string) => Promise<Client>;
  let agentClient: Client;
  let agentId: string;
  let agentSession: string;
  let board: string;
  let stream: string;
  const clients: Client[] = [];

  async function call(name: string, args: Record<string, unknown>, client: Client = human) {
    const result = await client.callTool({ name, arguments: args });
    const text = must(
      (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
        ?.text,
    );
    expect(result.isError === true, text).toBe(false);
    return JSON.parse(text) as Out;
  }
  async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}/api/blips${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? null : JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }
  const db = () => getDb();
  const stored = async (id: string) =>
    must((await db().select().from(schema.blips).where(eq(schema.blips.id, id)).limit(1))[0]);
  const rows = async (id: string) =>
    (
      await db().execute<{ revision: number; changed: string[]; prior_body: string | null }>(
        sql`SELECT revision, changed, prior_body FROM blip_revisions WHERE blip_id = ${id} ORDER BY revision`,
      )
    ).rows;
  /** A card the agent captured. */
  const agentCard = async (radar = board) =>
    (
      await call(
        'create_blip',
        {
          radarId: radar,
          body: 'the agent wrote this',
          title: 'Agent card',
          session: agentSession,
        },
        agentClient,
      )
    ).id;

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
        SESSION_SECRET: 'blip-history-synthetic-session-secret',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const [user] = await db()
      .insert(schema.users)
      .values({ name: 'Lucas', email: `history-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    cookie = `omr_session=${(await createSession(owner.user)).token}`;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;
    connect = async (bind?: string) => {
      const secret = newApiToken();
      await db()
        .insert(schema.apiTokens)
        .values({
          userId: owner.user.id,
          name: 'history',
          prefix: tokenPrefix(secret),
          tokenHash: hashSecret(secret),
          scope: 'radars:read radars:write radars:manage',
          ...(bind
            ? { agentId: bind, voiceGrants: ['persona', 'principal'], defaultVoice: 'persona' }
            : {}),
        });
      const client = new Client({ name: 'blip-history', version: '1' });
      clients.push(client);
      await client.connect(
        httpTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${secret}` } },
        }),
      );
      return client;
    };
    human = await connect();
    agentId = (await createRepoAgent(owner, { name: `Lulu ${randomUUID()}`, prompt: 'a' })).id;
    agentClient = await connect(agentId);
    const loaded = (await agentClient.callTool({
      name: 'load_agent',
      arguments: { agent: agentId, harness: 'codex' },
    })) as { content: Array<{ text?: string }> };
    agentSession = (
      JSON.parse(must(loaded.content[loaded.content.length - 1]?.text)) as { session: string }
    ).session;
    board = (await createRadar(owner, { name: 'History board', template: 'kanban' })).id;
    stream = (await createRadar(owner, { name: 'History stream' })).id;
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

  it('keeps the agent mark when a person edits, and shows who edited (REST and MCP)', async () => {
    const viaRest = await agentCard();
    const patched = await rest<{ blip: BlipDto }>('PATCH', `/${viaRest}`, {
      body: 'Lucas fixed it',
    });
    expect(patched.blip.agent?.id).toBe(agentId);
    expect(patched.blip.voice).toBe('persona');
    expect(patched.blip.lastEditedBy).toMatchObject({ name: 'Lucas', agentId: null });

    const viaMcp = await agentCard();
    await call('update_blip', { blipId: viaMcp, title: 'Retitled' });
    const read = await call('get_blip', { blipId: viaMcp });
    expect(read.agent?.id).toBe(agentId);
    expect(read.lastEditedBy?.name).toBe('Lucas');
    expect((await stored(viaMcp)).agentId).toBe(agentId);
    // The creator editing their own card is not news: nothing is shown.
    const mine = await agentCard();
    await call(
      'update_blip',
      { blipId: mine, body: 'agent again', session: agentSession },
      agentClient,
    );
    expect((await call('get_blip', { blipId: mine })).lastEditedBy).toBeUndefined();
  });

  it('lists the log newest first, with the prior body only when the body changed', async () => {
    const id = await agentCard();
    await rest('PATCH', `/${id}`, { title: 'only the title' });
    await rest('PATCH', `/${id}`, { body: 'new words' });
    const { revisions } = await rest<{ revisions: BlipRevisionDto[] }>('GET', `/${id}/revisions`);
    expect(revisions.map((r) => r.changed)).toEqual([['body'], ['title']]);
    expect(revisions[0]).toMatchObject({
      priorBody: 'the agent wrote this',
      editor: { name: 'Lucas' },
    });
    expect(revisions[1]?.priorBody).toBeNull();
    const viaMcp = await call('list_blip_revisions', { blipId: id, limit: 1 });
    expect(viaMcp.revisions).toHaveLength(1);
  });

  it('leaves the creator alone when an old pod rewrites author, agent and voice', async () => {
    const id = await agentCard();
    const [other] = await db()
      .insert(schema.users)
      .values({ email: `other-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const before = await stored(id);
    await db().execute(
      sql`UPDATE blips SET author_id = ${must(other).id}, agent_id = NULL, agent_voice = NULL, body = 'old pod' WHERE id = ${id}`,
    );
    const after = await stored(id);
    expect(after.body).toBe('old pod');
    expect([after.authorId, after.agentId, after.agentVoice]).toEqual([
      before.authorId,
      before.agentId,
      before.agentVoice,
    ]);
  });

  it('writes nothing for a claim, a pin or a tag, and survives deleting the people it names', async () => {
    const id = await agentCard();
    await call('claim_blip', { blipId: id, session: agentSession }, agentClient);
    await call('claim_blip', { blipId: id, session: agentSession }, agentClient);
    await call(
      'update_blip',
      { blipId: id, pinned: true, tags: ['x'], session: agentSession },
      agentClient,
    );
    expect(await rows(id)).toEqual([]);

    await rest('PATCH', `/${id}`, { body: 'edited by the owner' });
    await call(
      'update_blip',
      { blipId: id, title: 'by the agent', session: agentSession },
      agentClient,
    );
    const [leaver] = await db()
      .insert(schema.users)
      .values({ email: `leaver-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    await db().execute(
      sql`UPDATE blip_revisions SET editor_user_id = ${must(leaver).id} WHERE blip_id = ${id} AND revision = 2`,
    );
    await db().execute(sql`DELETE FROM users WHERE id = ${must(leaver).id}`);
    // Deleting an agent that wrote and edited nulls the card's mark and the log's editor.
    const gone = (await createRepoAgent(owner, { name: `Gone ${randomUUID()}`, prompt: 'x' })).id;
    const goneClient = await connect(gone);
    const loaded = (await goneClient.callTool({
      name: 'load_agent',
      arguments: { agent: gone, harness: 'codex' },
    })) as { content: Array<{ text?: string }> };
    const session = (
      JSON.parse(must(loaded.content[loaded.content.length - 1]?.text)) as { session: string }
    ).session;
    const theirs = (
      await call('create_blip', { radarId: board, body: 'mine', session }, goneClient)
    ).id;
    await call('update_blip', { blipId: theirs, body: 'mine again', session }, goneClient);
    expect((await rows(theirs)).length).toBe(1);
    await db().delete(schema.agents).where(eq(schema.agents.id, gone));
    expect((await stored(theirs)).agentId).toBeNull();
    expect(
      (
        await db().execute(
          sql`SELECT 1 FROM blip_revisions WHERE blip_id = ${theirs} AND editor_agent_id IS NOT NULL`,
        )
      ).rows,
    ).toEqual([]);
  });

  it('shows who moved a card only where the template declares the facet, and never publicly', async () => {
    const card = (
      await call('create_blip', { radarId: board, body: 'on the board', status: 'todo' })
    ).id;
    await call('update_blip', { blipId: card, status: 'doing' });
    expect((await call('get_blip', { blipId: card })).lastMovedBy).toMatchObject({ name: 'Lucas' });

    const plain = (await call('create_blip', { radarId: stream, body: 'on a stream' })).id;
    await call('update_blip', { blipId: plain, state: 'later', body: 'edited' });
    const read = await call('get_blip', { blipId: plain });
    expect(read.lastEditedBy).toBeUndefined();
    expect(read.lastMovedBy).toBeUndefined();

    const dto = await rest<{ blip: BlipDto }>('GET', `/${card}`);
    expect(dto.blip.lastMovedBy).toBeDefined();
    const narrowed = narrowBlip({ ...dto.blip, lastEditedBy: must(dto.blip.lastMovedBy) });
    expect(narrowed.lastMovedBy).toBeUndefined();
    expect(narrowed.lastEditedBy).toBeUndefined();
  });

  it('keeps the newest 25 rows plus the newest edit and the newest move', async () => {
    const edits = (await call('create_blip', { radarId: board, body: 'busy', status: 'todo' })).id;
    await db().execute(sql`UPDATE blips SET status = 'doing' WHERE id = ${edits}`);
    for (let n = 0; n < 30; n += 1)
      await db().execute(sql`UPDATE blips SET body = ${`edit ${n}`} WHERE id = ${edits}`);
    const kept = await rows(edits);
    expect(kept).toHaveLength(26);
    expect(kept[0]?.changed).toEqual(['status']);

    const moves = (await call('create_blip', { radarId: board, body: 'shuffled', status: 'todo' }))
      .id;
    await db().execute(sql`UPDATE blips SET body = 'once' WHERE id = ${moves}`);
    for (let n = 0; n < 30; n += 1)
      await db().execute(
        sql`UPDATE blips SET status = ${n % 2 ? 'todo' : 'doing'} WHERE id = ${moves}`,
      );
    const movesKept = await rows(moves);
    expect(movesKept).toHaveLength(26);
    expect(movesKept[0]?.changed).toEqual(['body']);
  });

  it('restarts the log at a move, in the data, and a stale radar id reads nothing', async () => {
    const id = (await call('create_blip', { radarId: stream, body: 'private words' })).id;
    await call('update_blip', { blipId: id, body: 'edited before the move' });
    await call('update_blip', { blipId: id, radarId: board });
    await call('update_blip', { blipId: id, body: 'edited after the move' });
    const { revisions } = await rest<{ revisions: BlipRevisionDto[] }>('GET', `/${id}/revisions`);
    expect(revisions.map((r) => r.changed)).toEqual([['body'], ['status', 'radar']]);
    // The arrival row says who moved it, never what it said on the radar it left.
    expect([revisions[1]?.priorTitle, revisions[1]?.priorBody]).toEqual([null, null]);
    expect(await rows(id)).toHaveLength(2);
    // A reader who passed the access check on the old radar, then lost the race to a move.
    expect(await revisionsIn(stream, id)).toEqual([]);
    expect(await revisionsIn(board, id)).toHaveLength(2);
    // Card hydration is fenced the same way: authorized on the old radar, it names nobody.
    const row = await stored(id);
    expect(
      (await historyFor([{ ...row, radarId: stream }], owner.user.id)).get(id),
    ).toBeUndefined();
    expect((await historyFor([row], owner.user.id)).get(id)?.lastMovedBy).toBeDefined();
  });

  it('never names a pre-move editor, even after enough lane changes to prune', async () => {
    const [other] = await db()
      .insert(schema.users)
      .values({ name: 'Private editor', email: `pe-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const editor: Actor = { user: must(other), kind: 'user' };
    await db()
      .insert(schema.radarMembers)
      .values({ radarId: stream, userId: editor.user.id, role: 'editor' });
    const id = (await call('create_blip', { radarId: stream, body: 'mine' })).id;
    await updateBlip(editor, id, { body: 'edited by the private editor' });
    await call('update_blip', { blipId: id, radarId: board, status: 'todo' });
    for (let n = 0; n < 26; n += 1)
      await db().execute(
        sql`UPDATE blips SET status = ${n % 2 ? 'todo' : 'doing'} WHERE id = ${id}`,
      );
    expect((await call('get_blip', { blipId: id })).lastEditedBy).toBeUndefined();
    expect(
      (
        await db().execute(
          sql`SELECT 1 FROM blip_revisions WHERE blip_id = ${id} AND editor_user_id = ${editor.user.id}`,
        )
      ).rows,
    ).toEqual([]);
  });
});

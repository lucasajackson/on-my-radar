/**
 * `update_blip` adds files (`addAttachments`) over MCP and REST, against a real Postgres. Tickets
 * come from the real `create_upload_ticket` tool (S3 has throwaway credentials, so presigning runs
 * for real); only `headObject` is stubbed, to answer for the keys a test "PUT". A ticket attaches
 * once, for the user and agent it was issued to, and never a key a card already holds.
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { createSession } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar } from '../services/radars.js';
import { createRepoAgent } from '../services/repo-agents.js';
import type * as StorageModule from '../services/storage.js';
import { httpTransport } from './test-client.js';

const storage = vi.hoisted(() => ({
  uploaded: new Map<string, { size: number; contentType: string }>(),
}));
vi.mock('../services/storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageModule>()),
  headObject: (key: string) => Promise.resolve(storage.uploaded.get(key) ?? null),
}));

type Ref = { key: string; filename: string; contentType: string; size: number };

describe.skipIf(!process.env['DATABASE_URL'])('update_blip attachments', () => {
  const database = `omr_blip_attachments_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let own: pg.Pool | undefined;
  let bob: Client;
  let listener: ReturnType<typeof serve> | undefined;
  let base: string;
  let owner: Actor;
  let cookie: string;
  let writer: Client;
  let sessionA: string;
  let sessionB: string;
  let radar: string;
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
    const result = await writer.callTool({
      name: 'load_agent',
      arguments: { agent: agentId, harness: 'codex' },
    });
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
        error?: { code: string; message: string };
      },
    };
  }
  /** A real ticket from `create_upload_ticket`, then the "PUT": storage now has the object. */
  async function upload(
    radarId: string,
    filename: string,
    who: { session?: string; client?: Client } = {},
  ): Promise<Ref> {
    const { error, text } = await call(
      'create_upload_ticket',
      {
        radarId,
        filename,
        contentType: 'image/png',
        size: 10,
        ...(who.session ? { session: who.session } : {}),
      },
      who.client,
    );
    expect(error, text).toBe(false);
    const ticket = JSON.parse(text) as { key: string };
    storage.uploaded.set(ticket.key, { size: 10, contentType: 'image/png' });
    return { key: ticket.key, filename, contentType: 'image/png', size: 10 };
  }
  const card = async (files: Ref[] = [], on = radar) =>
    (await createBlip(owner, on, { body: `card ${randomUUID()}`, attachments: files })).id;
  const stored = async (id: string) =>
    must((await getDb().select().from(schema.blips).where(eq(schema.blips.id, id)).limit(1))[0]);
  const keysOf = async (id: string) =>
    (
      await getDb()
        .select({ key: schema.attachments.objectKey })
        .from(schema.attachments)
        .where(eq(schema.attachments.blipId, id))
    )
      .map((r) => r.key)
      .sort();
  const ticketRows = async (keys: string[]) =>
    (await getDb().select().from(schema.uploadTickets)).filter((t) => keys.includes(t.objectKey));

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
        SESSION_SECRET: 'blip-attachments-synthetic-session-secret',
        PUBLIC_URL: 'http://localhost:3500',
        S3_ENDPOINT: 'http://127.0.0.1:9',
        S3_ACCESS_KEY: 'test-access-key',
        S3_SECRET_KEY: 'test-secret-key',
      }),
    );
    await runMigrations();
    own = new pg.Pool({ connectionString: url.toString() });
    const [user] = await getDb()
      .insert(schema.users)
      .values({ name: 'Lucas', email: `files-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
    cookie = `omr_session=${(await createSession(owner.user)).token}`;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = `http://127.0.0.1:${address.port}`;
    const secret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: owner.user.id,
        name: 'files',
        prefix: tokenPrefix(secret),
        tokenHash: hashSecret(secret),
        scope: 'radars:read radars:write radars:manage',
      });
    writer = new Client({ name: 'blip-attachments', version: '1' });
    clients.push(writer);
    await writer.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
      }),
    );
    const agentA = (await createRepoAgent(owner, { name: `A ${randomUUID()}`, prompt: 'a' })).id;
    const agentB = (await createRepoAgent(owner, { name: `B ${randomUUID()}`, prompt: 'b' })).id;
    sessionA = await loadSession(agentA);
    sessionB = await loadSession(agentB);
    radar = (await createRadar(owner, { name: 'Clippings' })).id;
    // Bob can write to Alice's radar (a shared editor) but is not who uploaded her files.
    const [bobUser] = await getDb()
      .insert(schema.users)
      .values({ name: 'Bob', email: `bob-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar, userId: must(bobUser).id, role: 'editor' });
    const bobSecret = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: must(bobUser).id,
        name: 'bob',
        prefix: tokenPrefix(bobSecret),
        tokenHash: hashSecret(bobSecret),
        scope: 'radars:read radars:write radars:manage',
      });
    bob = new Client({ name: 'blip-attachments-bob', version: '1' });
    clients.push(bob);
    await bob.connect(
      httpTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${bobSecret}` } },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (listener) await new Promise<void>((resolve) => must(listener).close(() => resolve()));
    await own?.end();
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  const refused = /upload ticket is spent, unknown, or was issued to someone else/;

  it('adds files over MCP and REST, and the attach spends each ticket', async () => {
    const id = await card();
    const revision = (await stored(id)).revision;
    const [c1, c2] = [await upload(radar, 'one.png'), await upload(radar, 'two.png')];
    expect(await ticketRows([c1.key, c2.key])).toHaveLength(2);

    const mcp = await data<{ revision: number; attachments: Array<{ filename: string }> }>(
      'update_blip',
      { blipId: id, addAttachments: [c1], expectedRevision: revision },
    );
    expect(mcp.revision).toBe(revision + 1);
    expect(mcp.attachments.map((a) => a.filename)).toEqual(['one.png']);
    const viaRest = await rest('PATCH', `/${id}`, {
      addAttachments: [c2],
      expectedRevision: revision + 1,
    });
    expect(viaRest.status).toBe(200);
    expect(viaRest.json.blip?.revision).toBe(revision + 2);
    expect(await keysOf(id)).toEqual([c1.key, c2.key].sort());
    expect(await ticketRows([c1.key, c2.key])).toHaveLength(0);
  });

  it('refuses a reused or unknown ticket: a ticket is good once', async () => {
    const [a, b] = [await card(), await card()];
    const c = await upload(radar, 'once.png');
    await data('update_blip', { blipId: a, addAttachments: [c] });
    // The file is detached again (a row delete stands in for a removal elsewhere), so the key is
    // referenced by no card; the ticket is what refuses it, not the "already attached" check.
    await getDb().delete(schema.attachments).where(eq(schema.attachments.blipId, a));
    for (const target of [a, b]) {
      const again = await call('update_blip', { blipId: target, addAttachments: [c] });
      expect(again.error).toBe(true);
      expect(again.text).toMatch(refused);
      const viaRest = await rest('PATCH', `/${target}`, { addAttachments: [c] });
      expect(viaRest.status).toBe(400);
      expect(viaRest.json.error?.message).toMatch(refused);
      expect(await keysOf(target)).toEqual([]);
    }
    // A ticket an old pod issued has no row.
    const old = await upload(radar, 'old.png');
    await getDb().delete(schema.uploadTickets).where(eq(schema.uploadTickets.objectKey, old.key));
    const unknown = await call('update_blip', { blipId: b, addAttachments: [old] });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toMatch(refused);
  });

  it('refuses another user’s ticket, and leaves it unspent for its owner', async () => {
    const id = await card();
    const bobs = await upload(radar, 'bobs.png', { client: bob });
    const mine = await upload(radar, 'mine.png');
    const theirs = await call('update_blip', { blipId: id, addAttachments: [bobs] });
    expect(theirs.error).toBe(true);
    expect(theirs.text).toMatch(refused);
    expect((await rest('PATCH', `/${id}`, { addAttachments: [bobs] })).status).toBe(400);
    const other = await call('update_blip', { blipId: id, addAttachments: [mine] }, bob);
    expect(other.error).toBe(true);
    expect(other.text).toMatch(refused);
    expect(await keysOf(id)).toEqual([]);
    expect(await ticketRows([bobs.key, mine.key])).toHaveLength(2);
    // Bob can write the card, so the ticket is the only thing that stopped him; his own works.
    expect((await call('update_blip', { blipId: id, addAttachments: [bobs] }, bob)).error).toBe(
      false,
    );
    expect(await keysOf(id)).toEqual([bobs.key]);
  });

  it('refuses another agent’s ticket, a sessionless caller’s, and a person’s used by an agent', async () => {
    const id = await card();
    const byA = await upload(radar, 'a.png', { session: sessionA });
    const person = await upload(radar, 'person.png');
    for (const args of [
      { addAttachments: [byA], session: sessionB },
      { addAttachments: [byA] },
      { addAttachments: [person], session: sessionA },
    ]) {
      const result = await call('update_blip', { blipId: id, ...args });
      expect(result.error).toBe(true);
      expect(result.text).toMatch(refused);
    }
    expect((await rest('PATCH', `/${id}`, { addAttachments: [byA] })).status).toBe(400);
    expect(await keysOf(id)).toEqual([]);
    expect(await ticketRows([byA.key, person.key])).toHaveLength(2);
    expect(
      (await call('update_blip', { blipId: id, addAttachments: [byA], session: sessionA })).error,
    ).toBe(false);
    expect(await keysOf(id)).toEqual([byA.key]);
  });

  it('never takes a key some card already holds, ticket or not', async () => {
    const held = await upload(radar, 'held.png');
    const owner1 = await card([held]);
    // create_blip spends the ticket too; a row put back (as an older pod's create left it) must
    // still not let the key onto a second card or twice onto the first.
    expect(await ticketRows([held.key])).toHaveLength(0);
    await getDb()
      .insert(schema.uploadTickets)
      .values({ objectKey: held.key, radarId: radar, userId: owner.user.id });
    const other = await card();
    for (const target of [owner1, other]) {
      const result = await call('update_blip', { blipId: target, addAttachments: [held] });
      expect(result.error).toBe(true);
      expect(result.text).toContain('already attached');
    }
    expect(await keysOf(other)).toEqual([]);
    expect(await keysOf(owner1)).toEqual([held.key]);
  });

  it('refuses a stale revision with 409, spends nothing, and attaches on the retry', async () => {
    const id = await card();
    const c = await upload(radar, 'late.png');
    const stale = (await stored(id)).revision;
    await data('update_blip', { blipId: id, title: 'moved on' });
    const viaRest = await rest('PATCH', `/${id}`, { addAttachments: [c], expectedRevision: stale });
    expect(viaRest.status).toBe(409);
    expect(viaRest.json.error?.code).toBe('stale_revision');
    const viaMcp = await call('update_blip', {
      blipId: id,
      addAttachments: [c],
      expectedRevision: stale,
    });
    expect(viaMcp.error).toBe(true);
    expect(viaMcp.text).toContain(`not ${stale}`);
    expect(await keysOf(id)).toEqual([]);
    expect(await ticketRows([c.key])).toHaveLength(1);
    const now = (await stored(id)).revision;
    await data('update_blip', { blipId: id, addAttachments: [c], expectedRevision: now });
    expect(await keysOf(id)).toEqual([c.key]);
  });
});

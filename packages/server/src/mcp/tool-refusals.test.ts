/**
 * What an agent is told when a tool says no, over real MCP HTTP on an isolated
 * database.
 *
 * Each case is a refusal that used to arrive as "That failed on the server
 * rather than because of anything in the request" — `guard` passes on only an
 * `ApiError`'s words, so a plain `Error` or a Postgres cast failure hid the one
 * sentence the agent needed — or a read-only connection that could write.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { httpTransport } from './test-client.js';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createComment, deleteComment } from '../services/comments.js';
import { createRadar } from '../services/radars.js';
import { must } from '../errors.js';

type Content = Array<{ type: string; text?: string }>;
const SERVER_FAULT = /failed on the server/;

describe.skipIf(!process.env['DATABASE_URL'])('MCP refusals an agent can act on', () => {
  const database = `omr_mcp_refusals_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let endpoint: URL;
  const clients: Client[] = [];
  let owner: Actor;
  let reader: Actor;
  let full: Client;
  let readOnly: Client;
  let readOnlyToken = '';

  let lastAccess = '';
  async function connect(actor: Actor, clientId: string, scope: string) {
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId,
        userId: actor.user.id,
        scope,
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const client = new Client({ name: 'refusals-test', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
      }),
    );
    lastAccess = access;
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Content)[0]?.text ?? '';
    return { error: result.isError === true, text };
  }

  const dropBoxes = async (actor: Actor) =>
    getDb()
      .select({ id: schema.radars.id })
      .from(schema.radars)
      .where(and(eq(schema.radars.ownerId, actor.user.id), eq(schema.radars.isDropBox, true)));

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
        SESSION_SECRET: 'mcp-refusals-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    for (const label of ['owner', 'reader']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@mcp-refusals.test`, state: 'active', name: label })
        .returning();
      if (label === 'owner') owner = { user: must(user), kind: 'user' };
      else reader = { user: must(user), kind: 'user' };
    }
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    full = await connect(owner, 'omr_refusals_full', TOKEN_SCOPES.join(' '));
    readOnly = await connect(reader, 'omr_refusals_read', 'radars:read');
    readOnlyToken = lastAccess;
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    const openListener = listener;
    if (openListener) await new Promise<void>((resolve) => openListener.close(() => resolve()));
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('says why a delete was refused, and deletes nothing', async () => {
    const radar = await createRadar(owner, { name: 'Keep me' });
    const refused = await call(full, 'delete_radar', { radarId: radar.id, confirmName: 'Wrong' });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/confirmName does not match: the radar is called "Keep me"/);
    const kept = await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id));
    expect(kept).toHaveLength(1);
  });

  it('says a kanban radar cannot be themed', async () => {
    const board = await createRadar(owner, { name: 'Board', template: 'kanban' });
    const refused = await call(full, 'set_radar_theme', { radarId: board.id, preset: 'plain' });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/cannot be themed/);
  });

  it('refuses a malformed id as the caller’s mistake, on every id-taking tool', async () => {
    for (const [tool, args] of [
      ['get_blip', { blipId: 'abc' }],
      ['list_comments', { blipId: 'abc' }],
      ['delete_comment', { commentId: 'abc' }],
      ['delete_webhook', { webhookId: 'abc' }],
      ['list_notifications', { radarId: 'abc' }],
      ['create_comment', { blipId: 'abc', body: 'x' }],
    ] as const) {
      const result = await call(full, tool, args);
      expect(result.error, tool).toBe(true);
      expect(result.text, tool).not.toMatch(SERVER_FAULT);
      // Refused by the schema, naming the argument — not rescued by the
      // database-error backstop in `guard`, which cannot say which id it was.
      expect(result.text, tool).toMatch(/Invalid uuid/);
    }
  });

  it('parses a webhook and a drop through the same contract as REST', async () => {
    const radar = await createRadar(owner, { name: 'Hooked' });
    const blank = await call(full, 'create_webhook', { radarId: radar.id, name: '   ' });
    expect(blank.error).toBe(true);
    expect(blank.text).toMatch(/Name the webhook/);
    const longTag = await call(full, 'create_blip', { body: 'x', tags: ['t'.repeat(500)] });
    expect(longTag.error).toBe(true);
    expect(longTag.text).not.toMatch(SERVER_FAULT);
    // Control: an ordinary drop still lands.
    const dropped = await call(full, 'create_blip', { body: 'an ordinary thought' });
    expect(dropped.error, dropped.text).toBe(false);
    expect(JSON.parse(dropped.text)).toMatchObject({ radarName: expect.any(String) as unknown });
  });

  it('a merged tool takes exactly one of its alternatives, and says so', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const radarId = id;
    for (const [tool, args, said] of [
      ['reanchor', { anchorId: id }, /quote .* dismiss/],
      ['reanchor', { anchorId: id, quote: 'x', dismiss: '' }, /quote .* dismiss/],
      ['write_charter', { radarId, baseRevision: 0 }, /markdown .* restoreVersion/],
      ['write_charter', { radarId, baseRevision: 0, markdown: 'x', restoreVersion: 1 }, /markdown/],
      ['remove_radar_member', { radarId }, /userId .* email/],
      ['remove_radar_member', { radarId, userId: id, email: 'a@b.test' }, /userId .* email/],
      ['remove_array_member', { arrayId: id }, /userId .* email/],
      ['set_feed', { radarId, enabled: false }, /feedId/],
      ['set_feed', { radarId, feedId: id, url: 'https://example.test/f.xml' }, /url cannot change/],
      ['preview_dashboard_query', {}, /query, or dashboardId and widgetId/],
      ['preview_dashboard_query', { query: 'x', dashboardId: id, widgetId: id }, /not both/],
      ['create_agent', { name: 'Both', profile: { model: 'opus' }, profiles: {} }, /not both/],
    ] as const) {
      const refused = await call(full, tool, args);
      expect(refused.error, tool).toBe(true);
      expect(refused.text, tool).toMatch(said);
    }
  });

  it('never lets a read-only connection delete its human’s comments', async () => {
    const radar = await createRadar(reader, { name: 'Read-only thread' });
    const blip = await createBlip(reader, radar.id, { body: 'something to discuss' });
    const mine = await createComment(reader, blip.id, { body: 'my own words' });
    const still = async (id: string) =>
      (await getDb().select().from(schema.blipComments).where(eq(schema.blipComments.id, id)))
        .length;

    // Over MCP: refused, naming the scope, and the list does not offer it.
    const refused = await call(readOnly, 'delete_comment', { commentId: mine.id });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/radars:write/);
    const listed = await call(readOnly, 'list_comments', { blipId: blip.id });
    const listing = JSON.parse(listed.text) as { comments: Array<{ canDelete: boolean }> };
    expect(listing.comments[0]?.canDelete).toBe(false);
    // Over REST with the same token.
    const rest = await fetch(new URL(`/api/comments/${mine.id}`, endpoint), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(rest.status).toBe(403);
    expect(await still(mine.id)).toBe(1);

    // Control: the person themselves still deletes their own comment.
    await deleteComment({ ...reader, viaCookie: true }, mine.id);
    expect(await still(mine.id)).toBe(0);
  });

  it('never lets a read-only connection create the drop box', async () => {
    expect(await dropBoxes(reader)).toHaveLength(0);
    const read = await call(readOnly, 'read_drop_box', {});
    expect(read.error, read.text).toBe(false);
    expect(JSON.parse(read.text)).toMatchObject({ blips: [] });
    const dropped = await call(readOnly, 'create_blip', { body: 'sneaky' });
    expect(dropped.error).toBe(true);
    expect(dropped.text).toMatch(/radars:write/);
    expect(await dropBoxes(reader)).toHaveLength(0);
  });
});

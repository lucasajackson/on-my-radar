/** Capability parity through real MCP HTTP and isolated PostgreSQL, with local S3 bytes. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { httpTransport } from './test-client.js';
import {
  createRadarSchema,
  updateRadarSchema,
  createBlipSchema,
  updateBlipSchema,
  createTopicSchema,
  updateTopicSchema,
  createFeedSchema,
  updateFeedSchema,
  createDashboardSchema,
  updateDashboardSchema,
  searchSchema,
  type BlipDto,
  type FeedDto,
  type WebhookDto,
  type RadarDto,
} from '@onmyradar/contract';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { env, loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar, createSmartRadar, shareRadar } from '../services/radars.js';
import { createTopic, setRadarTopic, shareTopic } from '../services/topics.js';
import { resetStorageClientForTesting } from '../services/storage.js';
import { must } from '../errors.js';

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text ?? '';
  return { error: result.isError === true, text };
}
async function data<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await call(client, name, args);
  expect(result.error, result.text).toBe(false);
  return JSON.parse(result.text) as T;
}

describe.skipIf(!process.env['DATABASE_URL'])('application capability tools over MCP', () => {
  const database = `omr_mcp_capabilities_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  const clients: Client[] = [];
  let owner: Actor;
  let other: Actor;
  let manager: Client;
  let writer: Client;
  let storage: ReturnType<typeof createServer> | undefined;
  const objects = new Map<string, Buffer>();
  let reader: Client;
  let outsider: Client;

  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    // A rejected handler would be an unhandled rejection that fails nothing;
    // answer 500 so the test sees it.
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const key = new URL(must(req.url), 'http://storage.test').pathname;
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
        return;
      }
      const bytes = objects.get(key);
      if (!bytes) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-length': bytes.length,
        'content-type': 'application/octet-stream',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    storage = createServer((req, res) => {
      handle(req, res).catch((error: unknown) => {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : 'storage stub failed');
      });
    });
    const started = storage;
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
    const storageAddress = started.address();
    if (!storageAddress || typeof storageAddress === 'string')
      throw new Error('Missing storage listener');
    resetStorageClientForTesting();
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'email-mcp-test-secret-not-used-in-production',
        PUBLIC_URL: 'http://localhost:3500',
        S3_ENDPOINT: `http://127.0.0.1:${storageAddress.port}`,
        S3_ACCESS_KEY: 'local-test-key',
        S3_SECRET_KEY: 'local-test-secret',
        S3_BUCKET: 'on-my-radar',
      }),
    );
    await runMigrations();
    for (const label of ['owner', 'other']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@email-mcp.test`, state: 'active' })
        .returning();
      if (!user) throw new Error('Missing fixture user');
      if (label === 'owner') owner = { user, kind: 'user' };
      else other = { user, kind: 'user' };
    }
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    async function connect(actor: Actor, scope: string) {
      const access = randomToken(32);
      await getDb()
        .insert(schema.oauthTokens)
        .values({
          accessTokenHash: hashSecret(access),
          refreshTokenHash: hashSecret(randomToken(32)),
          clientId: 'omr_email_test',
          userId: actor.user.id,
          scope,
          scopeConsented: true,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      const client = new Client({ name: 'email-regression', version: '1' });
      clients.push(client);
      await client.connect(
        httpTransport(endpoint, {
          requestInit: { headers: { authorization: `Bearer ${access}` } },
        }),
      );
      return client;
    }
    manager = await connect(owner, 'radars:manage');
    writer = await connect(owner, 'radars:write');
    reader = await connect(owner, 'radars:read');
    outsider = await connect(other, 'radars:write');
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    const openListener = listener;
    if (openListener) await new Promise<void>((resolve) => openListener.close(() => resolve()));
    const openStorage = storage;
    if (openStorage) await new Promise<void>((resolve) => openStorage.close(() => resolve()));
    resetStorageClientForTesting();
    await closeDb();
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('keeps shared contract fields present in the advertised MCP input schemas', async () => {
    const { tools } = await reader.listTools();
    const pairs = [
      ['create_radar', createRadarSchema.shape],
      ['update_radar', updateRadarSchema.innerType().shape],
      ['create_blip', createBlipSchema.innerType().shape],
      ['update_blip', updateBlipSchema.innerType().shape],
      ['create_array', createTopicSchema.shape],
      ['update_array', updateTopicSchema.innerType().shape],
      ['set_feed', createFeedSchema.shape],
      ['set_feed', updateFeedSchema.innerType().shape],
      ['create_dashboard', createDashboardSchema.shape],
      ['update_dashboard', updateDashboardSchema.innerType().innerType().shape],
    ] as const;
    for (const [name, shape] of pairs) {
      const properties = must(
        must(tools.find((tool) => tool.name === name)).inputSchema.properties,
      );
      // The radar tools leave the array to `set_radar_array`, so `topicId` is not theirs over MCP.
      for (const key of Object.keys(shape))
        if (key !== 'topicId') expect(properties, `${name}.${key}`).toHaveProperty(key);
    }
    const search = must(
      must(tools.find((tool) => tool.name === 'search_blips')).inputSchema.properties,
    );
    for (const key of Object.keys(searchSchema.shape))
      expect(search).toHaveProperty(key === 'q' ? 'query' : key);
  });

  it('round-trips shared due dates without enrolling personal reminders', async () => {
    const radar = await createRadar(owner, { name: 'MCP due dates' });
    const dueAt = '2030-04-05T16:30:00.000Z';
    const created = await data<{ id: string; dueAt: string }>(writer, 'create_blip', {
      radarId: radar.id,
      body: 'A shared deadline is not personal notification consent',
      dueAt,
    });
    expect(created.dueAt).toBe(dueAt);
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: created.id })).dueAt).toBe(dueAt);
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: created.id })).reminder).toBeNull();
    expect((await call(reader, 'update_blip', { blipId: created.id, dueAt: null })).error).toBe(
      true,
    );
    expect((await call(outsider, 'get_blip', { blipId: created.id })).error).toBe(true);
    await data(writer, 'update_blip', { blipId: created.id, body: 'Unrelated edit' });
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: created.id })).dueAt).toBe(dueAt);
    await data(writer, 'update_blip', { blipId: created.id, dueAt: null });
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: created.id })).dueAt).toBeNull();
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: created.id })).reminder).toBeNull();
    const { tools } = await manager.listTools();
    expect(tools.filter((tool) => /reminder/.test(tool.name))).toEqual([]);
    expect(
      tools.filter(
        (tool) =>
          /push_device|notification_settings|notification_preferences/.test(tool.name) &&
          tool.annotations?.readOnlyHint !== true,
      ),
    ).toEqual([]);
  });

  it('reacts idempotently over MCP, so a retried call keeps its mark', async () => {
    const radar = await createRadar(owner, { name: 'MCP reactions' });
    const blip = await createBlip(owner, radar.id, { body: 'retry me' });
    for (let i = 0; i < 2; i += 1) {
      const set = await data<{ reacted: boolean; reactions: Array<{ count: number }> }>(
        writer,
        'react_to_blip',
        { blipId: blip.id, reaction: 'up' },
      );
      expect(set).toMatchObject({ reacted: true, reactions: [{ count: 1 }] });
    }
    for (let i = 0; i < 2; i += 1) {
      const off = await data<{ reacted: boolean }>(writer, 'react_to_blip', {
        blipId: blip.id,
        reaction: 'up',
        on: false,
      });
      expect(off).toMatchObject({ reacted: false, reactions: [] });
    }
  });

  it('round-trips radar appearance, smart source filters and topic order through MCP', async () => {
    const radar = await data<{ id: string }>(writer, 'create_radar', {
      name: 'Config parity',
      template: 'microblog',
      templateConfig: { grouping: 'day' },
      commentsEnabled: true,
      reactionsEnabled: true,
      archiveAfterDays: 0,
    });
    let current = await data<{ radar: RadarDto }>(reader, 'read_radar', { radarId: radar.id });
    expect(current.radar.templateConfig).toMatchObject({ grouping: 'day' });
    expect(current.radar.commentsEnabled).toBe(true);
    expect(current.radar.archiveAfterDays).toBe(0);
    await data(manager, 'update_radar', {
      radarId: radar.id,
      templateConfig: { grouping: 'none' },
      archiveAfterDays: 12,
    });
    await data(manager, 'set_radar_theme', { radarId: radar.id, density: 'cosy' });
    // read_radar sends the theme only for a published radar (S4).
    current = await data<{ radar: RadarDto }>(reader, 'read_radar', { radarId: radar.id });
    expect(current.radar.theme).toBeUndefined();
    await data(manager, 'set_radar_visibility', { radarId: radar.id, visibility: 'public' });
    current = await data<{ radar: RadarDto }>(reader, 'read_radar', { radarId: radar.id });
    expect(current.radar.theme).toMatchObject({ density: 'cosy' });
    expect(current.radar.archiveAfterDays).toBe(12);
    for (const moved of [{ topic: 'ignored?' }, { theme: { preset: 'plain' } }])
      expect(
        (await call(manager, 'create_radar', { name: 'Invalid deprecated input', ...moved })).error,
      ).toBe(true);
    const smart = await data<{ id: string; filter: { radarIds: string[] } }>(
      writer,
      'create_radar',
      {
        name: 'Complete filter',
        filter: { tags: ['chosen'], radarIds: [radar.id], q: 'needle' },
        templateConfig: { grouping: 'day' },
      },
    );
    expect(smart.filter.radarIds).toEqual([radar.id]);
    await data(manager, 'update_radar', {
      radarId: smart.id,
      filter: { tags: ['changed'], radarIds: [radar.id] },
    });
    const edited = await data<{ radar: RadarDto }>(reader, 'read_radar', { radarId: smart.id });
    expect(edited.radar.filter?.tags).toEqual(['changed']);
    const topic = await data<{ id: string }>(writer, 'create_array', { name: 'Position parity' });
    await data(manager, 'update_array', { arrayId: topic.id, position: 23 });
    const [stored] = await getDb()
      .select()
      .from(schema.topics)
      .where(eq(schema.topics.id, topic.id));
    expect(stored?.position).toBe(23);
  });

  it('searches all accessible radars with exact smart membership priority and stable pagination', async () => {
    const current = await createRadar(owner, { name: 'Priority current' });
    const elsewhere = await createRadar(owner, { name: 'Priority elsewhere' });
    const favored = await createBlip(owner, current.id, { body: 'capabilityprobe #chosen' });
    const unchosen = await createBlip(owner, current.id, { body: 'capabilityprobe' });
    const external = await createBlip(owner, elsewhere.id, {
      body: 'capabilityprobe capabilityprobe',
    });
    const smart = await createSmartRadar(owner, { name: 'Chosen', filter: { tags: ['chosen'] } });
    type Page = {
      blips: BlipDto[];
      nextCursor: string | null;
      preferredRadar: { id: string };
      preferredBlipIds: string[];
    };
    const first = await data<Page>(reader, 'search_blips', {
      query: 'capabilityprobe',
      preferRadarId: smart.id,
      limit: 1,
    });
    expect(first.blips.map((b) => b.id)).toEqual([favored.id]);
    expect(first.preferredRadar.id).toBe(smart.id);
    expect(first.preferredBlipIds).toEqual([favored.id]);
    const second = await data<Page>(reader, 'search_blips', {
      query: 'capabilityprobe',
      preferRadarId: smart.id,
      limit: 10,
      cursor: first.nextCursor,
    });
    expect(new Set(second.blips.map((b) => b.id))).toEqual(new Set([unchosen.id, external.id]));
    expect(second.preferredBlipIds).toEqual([]);
    const negative = await data<Page & { combinationRules: string[] }>(reader, 'search_blips', {
      query: 'capabilityprobe -tag:chosen|absent',
    });
    expect(new Set(negative.blips.map((blip) => blip.id))).toEqual(
      new Set([unchosen.id, external.id]),
    );
    expect(negative.combinationRules.join(' ')).toContain('Negative filters intersect');
    const malformed = await data<{ blips: unknown[]; unresolved: boolean }>(
      reader,
      'search_blips',
      { query: 'capabilityprobe is:invalid' },
    );
    expect(malformed.blips).toEqual([]);
    expect(malformed.unresolved).toBe(true);
    const scoped = await data<Page>(reader, 'search_blips', {
      query: 'capabilityprobe',
      radarId: smart.id,
    });
    expect(scoped.blips.map((b) => b.id)).toEqual([favored.id]);
    expect(
      (
        await call(reader, 'search_blips', {
          query: 'capabilityprobe',
          preferRadarId: current.id,
          cursor: first.nextCursor,
        })
      ).error,
    ).toBe(true);
    expect((await call(outsider, 'search_blips', { preferRadarId: current.id })).error).toBe(true);
  });

  it('creates, pauses, removes and restores RSS subscriptions without losing deduplication', async () => {
    const radar = await createRadar(owner, { name: 'Feed tools' });
    expect(
      (
        await call(writer, 'set_feed', {
          radarId: radar.id,
          url: 'https://example.test/feed',
          lookback: 'week',
        })
      ).error,
    ).toBe(true);
    const feed = await data<FeedDto>(manager, 'set_feed', {
      radarId: radar.id,
      url: 'https://example.test/feed',
      lookback: 'week',
    });
    expect(
      (await data<FeedDto[]>(manager, 'list_feeds', { radarId: radar.id })).map((f) => f.id),
    ).toEqual([feed.id]);
    expect((await call(outsider, 'list_feeds', { radarId: radar.id })).error).toBe(true);
    const paused = await data<FeedDto>(manager, 'set_feed', {
      radarId: radar.id,
      feedId: feed.id,
      enabled: false,
      lookback: 'forever',
    });
    expect(paused.enabled).toBe(false);
    expect(paused.lookback).toBe('forever');
    expect((await call(manager, 'set_feed', { radarId: radar.id, feedId: feed.id })).error).toBe(
      true,
    );
    await data(manager, 'delete_feed', { radarId: radar.id, feedId: feed.id });
    expect(await data(manager, 'list_feeds', { radarId: radar.id })).toEqual([]);
    const restored = await data<FeedDto>(manager, 'set_feed', {
      radarId: radar.id,
      url: feed.url,
      lookback: 'day',
    });
    expect(restored.id).toBe(feed.id);
  });

  it('issues actual signed file tickets, captures uploaded bytes, and rechecks download access after a move', async () => {
    const radar = await createRadar(owner, { name: 'Upload tools' });
    const input = {
      radarId: radar.id,
      filename: 'proof.bin',
      contentType: 'application/octet-stream',
      size: 5,
    };
    expect((await call(reader, 'create_upload_ticket', input)).error).toBe(true);
    expect((await call(outsider, 'create_upload_ticket', input)).error).toBe(true);
    expect(
      (await call(writer, 'create_upload_ticket', { ...input, contentType: 'text/html' })).error,
    ).toBe(true);
    const ticket = await data<{ key: string; url: string; headers: Record<string, string> }>(
      writer,
      'create_upload_ticket',
      input,
    );
    expect(new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    const attachment = {
      key: ticket.key,
      filename: input.filename,
      contentType: input.contentType,
      size: 5,
    };
    expect(
      (await call(writer, 'create_blip', { radarId: radar.id, attachments: [attachment] })).error,
    ).toBe(true);
    expect(
      (await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: 'proof' })).status,
    ).toBe(200);
    const captured = await data<{ id: string }>(writer, 'create_blip', {
      radarId: radar.id,
      attachments: [attachment],
    });
    const blip = await data<BlipDto>(reader, 'get_blip', { blipId: captured.id });
    const attachmentId = must(blip.attachments[0]).id;
    const download = await data<{ url: string }>(reader, 'download_attachment', { attachmentId });
    expect(new URL(download.url).searchParams.get('response-content-disposition')).toContain(
      'attachment;',
    );
    expect(await (await fetch(download.url)).text()).toBe('proof');
    await shareRadar(owner, radar.id, other.user.email, 'viewer');
    await data(outsider, 'download_attachment', { attachmentId });
    const destination = await createRadar(owner, { name: 'Moved attachment' });
    await data(writer, 'update_blip', { blipId: captured.id, radarId: destination.id });
    expect((await call(outsider, 'download_attachment', { attachmentId })).error).toBe(true);
    await data(reader, 'download_attachment', { attachmentId });
  });

  it('reads original email text in bounded pages and offers retained MIME only to current readers', async () => {
    const radar = await createRadar(owner, { name: 'Email read tools' });
    const text = 'Email original '.repeat(2100).trim();
    const blip = await createBlip(owner, radar.id, { body: text });
    await getDb().insert(schema.blipEmails).values({
      blipId: blip.id,
      subject: 'Email',
      senderAddress: 'sender@example.test',
      receivedAt: new Date(),
      preview: 'Email original',
      hasHtml: false,
      legacy: true,
    });
    type EmailPage = {
      text: string;
      nextOffset: number | null;
      totalCharacters: number;
      legacy: boolean;
      radarUrl: string;
      originalVia: string | null;
    };
    const first = await data<EmailPage>(reader, 'get_email', { blipId: blip.id });
    expect(first.text).toBe(text.slice(0, 20_000));
    expect(first.nextOffset).toBe(20_000);
    expect(first.legacy).toBe(true);
    expect(first.originalVia).toBeNull();
    expect(first.radarUrl).toContain(`/radar/${radar.id}`);
    const second = await data<EmailPage>(reader, 'get_email', {
      blipId: blip.id,
      offset: first.nextOffset,
    });
    expect(first.text + second.text).toBe(text);
    expect(second.nextOffset).toBeNull();
    expect((await call(outsider, 'get_email', { blipId: blip.id })).error).toBe(true);
    expect((await call(reader, 'download_original_email', { blipId: blip.id })).error).toBe(true);
    // A retained original uses the same authorization and private attachment disposition.
    await getDb()
      .update(schema.blipEmails)
      .set({ originalKey: `radars/${radar.id}/original.eml` })
      .where(eq(schema.blipEmails.blipId, blip.id));
    const original = await data<{ url: string }>(reader, 'download_original_email', {
      blipId: blip.id,
    });
    expect(new URL(original.url).searchParams.get('response-content-disposition')).toContain(
      'attachment;',
    );
    expect((await call(outsider, 'download_original_email', { blipId: blip.id })).error).toBe(true);
  });

  it('removes direct membership and pending invites while deleting only the topic container', async () => {
    const topic = await createTopic(owner, { name: 'Management tools' });
    const radar = await createRadar(owner, { name: 'Topic content survives' });
    await setRadarTopic(owner, radar.id, topic.id);
    await shareTopic(owner, topic.id, other.user.email, 'viewer');
    await shareRadar(owner, radar.id, other.user.email, 'viewer');
    expect(
      (await call(writer, 'remove_radar_member', { radarId: radar.id, userId: other.user.id }))
        .error,
    ).toBe(true);
    await data(manager, 'remove_radar_member', { radarId: radar.id, userId: other.user.id });
    expect((await call(outsider, 'read_radar', { radarId: radar.id })).error).toBe(true);
    await data(manager, 'remove_array_member', { arrayId: topic.id, userId: other.user.id });
    expect((await call(outsider, 'read_array', { arrayId: topic.id })).error).toBe(true);
    await shareRadar(owner, radar.id, 'pending@capabilities.test', 'viewer');
    await shareTopic(owner, topic.id, 'pending@capabilities.test', 'viewer');
    await data(manager, 'remove_radar_member', {
      radarId: radar.id,
      email: 'pending@capabilities.test',
    });
    await data(manager, 'remove_array_member', {
      arrayId: topic.id,
      email: 'pending@capabilities.test',
    });
    expect(
      await getDb()
        .select()
        .from(schema.radarInvites)
        .where(eq(schema.radarInvites.radarId, radar.id)),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(schema.topicInvites)
        .where(eq(schema.topicInvites.topicId, topic.id)),
    ).toHaveLength(0);
    expect((await call(writer, 'delete_array', { arrayId: topic.id })).error).toBe(true);
    const removed = await data<{ radarsFreed: number }>(manager, 'delete_array', {
      arrayId: topic.id,
    });
    expect(removed.radarsFreed).toBe(1);
    const [survivor] = await getDb()
      .select()
      .from(schema.radars)
      .where(eq(schema.radars.id, radar.id));
    expect(survivor?.topicId).toBeNull();
  });

  it('lists the array tools only: the old topic names are not tools and the radar tools refuse an array', async () => {
    const names = (await reader.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      'list_arrays',
      'read_array',
      'create_array',
      'update_array',
      'delete_array',
      'share_array',
      'set_radar_array',
      'list_array_members',
      'remove_array_member',
    ])
      expect(names).toContain(name);
    // The old names are gone, not aliased.
    expect(names.filter((name) => /topic/.test(name))).toEqual([]);
    expect((await call(manager, 'create_topic', { name: 'Old name' })).error).toBe(true);

    const made = await data<{ id: string; url: string }>(manager, 'create_array', {
      name: 'Array name',
    });
    expect(made.url).toBe(`${env().APP_URL}/array/${made.id}`);
    const radar = await createRadar(owner, { name: 'Filed by set_radar_array' });
    await data(manager, 'set_radar_array', { radarId: radar.id, arrayId: made.id });
    const read = await data<{ array: { id: string }; radars: Array<{ id: string }> }>(
      reader,
      'read_array',
      { arrayId: made.id },
    );
    expect(read.array.id).toBe(made.id);
    // Reads take the owner-scoped slug as well as the id.
    const [row] = await getDb().select().from(schema.topics).where(eq(schema.topics.id, made.id));
    expect(
      (await data<{ array: { id: string } }>(manager, 'read_array', { arrayId: row?.slug })).array
        .id,
    ).toBe(made.id);
    expect(read.radars.map((r) => r.id)).toEqual([radar.id]);
    expect((await data<Array<{ id: string }>>(reader, 'list_arrays')).map((a) => a.id)).toContain(
      made.id,
    );
    const listed = await data<Array<{ id: string; array?: { id: string } }>>(reader, 'list_radars');
    expect(listed.find((r) => r.id === radar.id)?.array?.id).toBe(made.id);

    // The radar tools no longer file a radar: `topic`, `array`, `arrayId` and `topicId` are refused, not dropped.
    for (const key of ['topic', 'array', 'arrayId', 'topicId'])
      expect(
        (await call(manager, 'create_radar', { name: 'Not filed', [key]: made.id })).error,
      ).toBe(true);
    for (const moved of [{ arrayId: null }, { topicId: null }]) {
      const refused = await call(manager, 'update_radar', {
        radarId: radar.id,
        name: 'Renamed anyway',
        ...moved,
      });
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/set_radar_array/);
    }
    // Nothing was written: not the rename, and the radar is still in its array.
    const [kept] = await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id));
    expect(kept).toMatchObject({ name: 'Filed by set_radar_array', topicId: made.id });
  });

  it('updates webhook mappings and rotates the one-time URL without exposing secrets on read', async () => {
    const radar = await createRadar(owner, { name: 'Webhook tools' });
    const hook = await data<{ id: string; secretUrl: string }>(manager, 'create_webhook', {
      radarId: radar.id,
      name: 'Testing',
    });
    expect(
      (await call(writer, 'update_webhook', { webhookId: hook.id, enabled: false })).error,
    ).toBe(true);
    const updated = await data<WebhookDto>(manager, 'update_webhook', {
      webhookId: hook.id,
      enabled: false,
      format: 'template',
      bodyTemplate: '{{message}}',
      tags: ['test'],
    });
    expect(updated.enabled).toBe(false);
    expect(updated.tags).toEqual(['test']);
    expect(updated.secretUrl).toBeUndefined();
    expect((await call(manager, 'update_webhook', { webhookId: hook.id })).error).toBe(true);
    const rotated = await data<WebhookDto>(manager, 'rotate_webhook_secret', {
      webhookId: hook.id,
    });
    expect(rotated.secretUrl).toBeTruthy();
    expect(rotated.secretUrl).not.toBe(hook.secretUrl);
    const listed = await data<WebhookDto[]>(manager, 'list_webhooks', { radarId: radar.id });
    expect(must(listed[0]).secretUrl).toBeUndefined();
  });

  it('exposes read-only preference inspection and capability discovery without human-only mutations', async () => {
    await data(reader, 'get_notification_settings');
    const guide = await data<{ humanOnly: Array<{ feature: string }> }>(
      reader,
      'list_capabilities',
    );
    expect(guide.humanOnly.some((item) => item.feature.includes('Email'))).toBe(true);
    const catalog = await reader.listTools();
    expect(catalog.tools.map((tool) => tool.name)).not.toContain('claim_email_capture_identity');
    expect(catalog.tools.map((tool) => tool.name)).not.toContain('update_notification_settings');
    expect(catalog.tools.map((tool) => tool.name)).not.toContain('mark_notifications_seen');
    const resource = await reader.readResource({ uri: 'onmyradar://capabilities' });
    expect(resource.contents[0]).toHaveProperty('mimeType', 'application/json');
  });
});

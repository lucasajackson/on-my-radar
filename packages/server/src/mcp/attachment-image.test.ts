import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { must } from '../errors.js';
import { buildMcpServer } from './server.js';
import { createRadar } from '../services/radars.js';
import { createBlip } from '../services/blips.js';
import * as storage from '../services/storage.js';
import type { Actor } from '../http.js';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';

describe.skipIf(!process.env['DATABASE_URL'])('MCP attached image viewing', () => {
  let client: Client;
  let actor: Actor;
  beforeAll(async () => {
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `image-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    actor = { user: must(user), kind: 'user' };
    const server = buildMcpServer(actor);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'attachment-image-test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  }, 30000);
  afterAll(async () => {
    await client.close();
    await closeDb();
  });
  afterEach(() => vi.restoreAllMocks());
  it('advertises a direct read-only image tool beside the original download tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('download_attachment');
    expect(tools.map((tool) => tool.name)).toContain('read_attachment_image');
  });
  it('transports the real image block without JSON/textbase64 or private metadata, and REST uses the same bytes', async () => {
    const radar = await createRadar(actor, { name: 'Images' });
    const blip = await createBlip(actor, radar.id, { body: 'view it' });
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const [attachment] = await getDb()
      .insert(schema.attachments)
      .values({
        radarId: radar.id,
        blipId: blip.id,
        objectKey: `radars/${radar.id}/PRIVATEKEY.png`,
        filename: 'HOSTILE_FILENAME.png',
        contentType: 'image/png',
        size: bytes.length,
      })
      .returning();
    vi.spyOn(storage, 'readImageObject').mockResolvedValue({ bytes, contentType: 'image/png' });
    const result = await client.callTool({
      name: 'read_attachment_image',
      arguments: { attachmentId: must(attachment).id },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATEKEY|HOSTILE_FILENAME|https?:/);
    await getDb()
      .update(schema.radars)
      .set({ wasClientFacing: true })
      .where(eq(schema.radars.id, radar.id));
    const clientImage = await client.callTool({
      name: 'read_attachment_image',
      arguments: { attachmentId: must(attachment).id },
    });
    expect(JSON.stringify(clientImage.content)).toContain('client-supplied');
    expect(JSON.stringify(clientImage.content)).not.toMatch(/HOSTILE_FILENAME|PRIVATEKEY/);
    const session = await createSession(actor.user);
    const response = await createApp().request(`/api/attachments/${must(attachment).id}/image`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    await getDb()
      .update(schema.attachments)
      .set({ contentType: 'image/svg+xml' })
      .where(eq(schema.attachments.id, must(attachment).id));
    const refusal = await client.callTool({
      name: 'read_attachment_image',
      arguments: { attachmentId: must(attachment).id },
    });
    expect(refusal.isError).toBe(true);
    expect(JSON.stringify(refusal.content)).toContain('download_attachment');
    expect(refusal.content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
    );
  });
});

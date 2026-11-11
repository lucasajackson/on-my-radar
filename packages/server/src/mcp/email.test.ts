/** Email tools through real HTTP, bearer scopes and the shared Postgres services. */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { httpTransport } from './test-client.js';
import type { BlipDto, EmailSummaryDto } from '@onmyradar/contract';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar } from '../services/radars.js';
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

describe.skipIf(!process.env['DATABASE_URL'])('email tools over MCP', () => {
  const database = `omr_mcp_emails_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  const clients: Client[] = [];
  let owner: Actor;
  let other: Actor;
  let writer: Client;
  let reader: Client;
  let outsider: Client;
  let endpointOrigin: string;

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
        SESSION_SECRET: 'email-mcp-test-secret-not-used-in-production',
        PUBLIC_URL: 'http://localhost:3500',
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
    endpointOrigin = `http://127.0.0.1:${address.port}`;
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
    writer = await connect(owner, 'radars:write');
    reader = await connect(owner, 'radars:read');
    outsider = await connect(other, 'radars:write');
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    const openListener = listener;
    if (openListener) await new Promise<void>((resolve) => openListener.close(() => resolve()));
    await closeDb();
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  async function fixture() {
    const radar = await createRadar(owner, { name: 'Captured newsletter' });
    const blip = await createBlip(owner, radar.id, { body: 'Immutable newsletter body' });
    const notes = 'Annotation '.repeat(150);
    await getDb()
      .update(schema.blips)
      .set({ emailNotes: notes })
      .where(eq(schema.blips.id, blip.id));
    await getDb().insert(schema.blipEmails).values({
      blipId: blip.id,
      subject: 'September newsletter',
      senderName: 'Newsletter editor',
      senderAddress: 'private-sender@example.test',
      receivedAt: new Date(),
      preview: 'Newsletter preview',
      hasHtml: true,
      legacy: false,
    });
    return { radar, blip, notes };
  }

  it('exposes compact email notes through radar and search summaries, and full notes through get', async () => {
    const { radar, blip, notes } = await fixture();
    type Summary = {
      id: string;
      email: EmailSummaryDto & { notesTruncated?: boolean; fullNotesVia?: string };
    };
    for (const [name, args] of [
      ['read_radar', { radarId: radar.id }],
      ['search_blips', { radarId: radar.id }],
    ] as const) {
      const result = await data<{ blips: Summary[] }>(reader, name, args);
      const summary = must(result.blips.find((item) => item.id === blip.id));
      expect(summary.email.subject).toBe('September newsletter');
      expect(summary.email.notes).toBe(notes.slice(0, 1200));
      expect(summary.email.notesTruncated).toBe(true);
      expect(summary.email.fullNotesVia).toBe('get_blip');
    }
    const full = await data<BlipDto>(reader, 'get_blip', { blipId: blip.id });
    expect(full.email?.notes).toBe(notes);
    expect(full.email?.senderAddress).toBe('private-sender@example.test');
  });

  it('updates annotations without rewriting the original, and rejects body mutation atomically', async () => {
    const { blip } = await fixture();
    await data(writer, 'update_blip', { blipId: blip.id, emailNotes: 'Follow up on this offer' });
    const saved = await data<BlipDto>(reader, 'get_blip', { blipId: blip.id });
    expect(saved.body).toBe(blip.body);
    expect(saved.email?.notes).toBe('Follow up on this offer');
    const refusal = await call(writer, 'update_blip', {
      blipId: blip.id,
      body: 'Rewritten',
      emailNotes: 'Must roll back',
    });
    expect(refusal.error).toBe(true);
    const unchanged = await data<BlipDto>(reader, 'get_blip', { blipId: blip.id });
    expect(unchanged.body).toBe(blip.body);
    expect(unchanged.email?.notes).toBe('Follow up on this offer');
    await data(writer, 'update_blip', { blipId: blip.id, emailNotes: '' });
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: blip.id })).email?.notes).toBe('');
  });

  it('enforces read-only token ceilings and private radar access for annotations', async () => {
    const { blip, notes } = await fixture();
    const readOnly = await call(reader, 'update_blip', {
      blipId: blip.id,
      emailNotes: 'Forbidden',
    });
    expect(readOnly.error).toBe(true);
    expect(readOnly.text).toContain('radars:write');
    expect((await call(outsider, 'get_blip', { blipId: blip.id })).error).toBe(true);
    expect(
      (await call(outsider, 'update_blip', { blipId: blip.id, emailNotes: 'Forbidden' })).error,
    ).toBe(true);
    expect((await data<BlipDto>(reader, 'get_blip', { blipId: blip.id })).email?.notes).toBe(notes);
  });

  it('redacts sender addresses on the public-link read path while retaining attribution', async () => {
    const { radar, blip } = await fixture();
    const slug = `email-test-${radar.id}`;
    await getDb()
      .update(schema.radars)
      .set({ visibility: 'public', publicSlug: slug })
      .where(eq(schema.radars.id, radar.id));
    const response = await fetch(`${endpointOrigin}/api/public/radars/${slug}/blips`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { items: BlipDto[] };
    const published = must(result.items.find((item) => item.id === blip.id));
    expect(published.email?.senderAddress).toBeNull();
    expect(published.email?.senderName).toBe('Newsletter editor');
    expect(JSON.stringify(published)).not.toContain('private-sender@example.test');
    const publicMcp = await data<{ blips: BlipDto[] }>(outsider, 'read_radar', { radarId: slug });
    const publicSummary = must(publicMcp.blips.find((item) => item.id === blip.id));
    expect(publicSummary.email?.senderAddress).toBeNull();
    expect(publicSummary.email?.senderName).toBe('Newsletter editor');
    expect(JSON.stringify(publicSummary)).not.toContain('private-sender@example.test');
    expect(
      (await data<BlipDto>(reader, 'get_blip', { blipId: blip.id })).email?.senderAddress,
    ).toBe('private-sender@example.test');
  });
});

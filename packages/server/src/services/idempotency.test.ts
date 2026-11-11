/**
 * Idempotency-Key on blip and comment creation, plus the agent-write properties that
 * ship with it: the fan-out is the worker's, the radar touch is throttled, readers come in
 * a fixed order.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { hashSecret, newApiToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { createRadar } from './radars.js';
import { readersOfRadars } from './access.js';
import { purgeExpiredRequestKeys } from './idempotency.js';
import type * as StorageModule from './storage.js';
import { drainDue } from './outbox.js';
import './blips.js';
import './notifications.js';

// A HEAD against a bucket that has every object a test names: what is under test is the
// ordering of the database writes, not storage.
vi.mock('./storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageModule>()),
  headObject: () => Promise.resolve({ size: 10, contentType: 'image/png' }),
}));

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
process.env['DATABASE_URL'] ??= 'postgres://unused';

describe.skipIf(!hasDatabase)('idempotent creates', () => {
  let base: string;
  let listener: ReturnType<typeof serve>;
  let owner: typeof schema.users.$inferSelect;
  let radarId: string;
  let patA: string;
  let patB: string;
  let session: string;

  const post = (path: string, token: string, body: unknown, key?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    });
  const blipCount = async (marker: string) =>
    Number(
      (
        await getDb().execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM blips WHERE radar_id = ${radarId}::uuid AND body = ${marker}`,
        )
      ).rows[0]?.n,
    );

  async function makePat(userId: string): Promise<string> {
    const token = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({ userId, name: 'pat', prefix: token.slice(0, 14), tokenHash: hashSecret(token) });
    return token;
  }

  beforeAll(async () => {
    setEnvForTesting(loadEnv({ ...process.env, RATE_LIMIT_ENABLED: 'false' }));
    await runMigrations();
    owner = must(
      (
        await getDb()
          .insert(schema.users)
          .values({ email: `idem-${randomUUID()}@example.test`, name: 'Owner', state: 'active' })
          .returning()
      )[0],
    );
    radarId = (
      await createRadar(
        { user: owner, kind: 'user' },
        { name: `idem-${randomUUID()}`, template: 'stream' },
      )
    ).id;
    patA = await makePat(owner.id);
    patB = await makePat(owner.id);
    session = (await createSession(owner, { client: 'web', label: 'test' })).token;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await closeDb();
  });

  it('REST: a retried blip create returns the first blip and writes nothing new', async () => {
    const marker = `once-${randomUUID()}`;
    const key = randomUUID();
    const first = await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key);
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    const created = (await first.json()) as { blip: { id: string } };
    const again = await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(((await again.json()) as { blip: { id: string } }).blip.id).toBe(created.blip.id);
    expect(await blipCount(marker)).toBe(1);
  });

  it('REST: the same key with a different request is a 409 and writes nothing', async () => {
    const key = randomUUID();
    const marker = `diff-${randomUUID()}`;
    expect((await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key)).status).toBe(
      201,
    );
    const res = await post(`/api/radars/${radarId}/blips`, patA, { body: `${marker}-other` }, key);
    expect(res.status).toBe(409);
    expect(await blipCount(`${marker}-other`)).toBe(0);
  });

  it('REST: two connections of one person do not share keys', async () => {
    const key = randomUUID();
    const marker = `conn-${randomUUID()}`;
    const a = await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key);
    const b = await post(`/api/radars/${radarId}/blips`, patB, { body: marker }, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await blipCount(marker)).toBe(2);
  });

  it('REST: ten concurrent calls with one key make exactly one blip', async () => {
    const key = randomUUID();
    const marker = `race-${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 201));
    const ids = new Set(
      await Promise.all(
        responses.map(async (r) => ((await r.json()) as { blip: { id: string } }).blip.id),
      ),
    );
    expect(ids.size).toBe(1);
    expect(await blipCount(marker)).toBe(1);
  });

  it('REST: concurrent same-key creates with the same attachment replay instead of failing on the object key', async () => {
    // The attachment's object key is unique. The key must be claimed before that insert, or
    // the second request dies on `attachments_object_key_key` with a 500 instead of replaying.
    const key = `att-${randomUUID()}`;
    const body = {
      body: `with-attachment-${randomUUID()}`,
      attachments: [
        {
          key: `radars/${radarId}/${randomUUID()}/pic.png`,
          filename: 'pic.png',
          contentType: 'image/png',
          size: 10,
        },
      ],
    };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => post(`/api/radars/${radarId}/blips`, patA, body, key)),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const ids = new Set(
      (await Promise.all(responses.map((r) => r.json()))).map(
        (json) => (json as { blip: { id: string } }).blip.id,
      ),
    );
    expect(ids.size).toBe(1);
    const { rows } = await getDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM attachments WHERE object_key = ${body.attachments[0]?.key ?? ''}`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('REST: a malformed key is a 400, and no key behaves as before', async () => {
    const marker = `plain-${randomUUID()}`;
    expect(
      (await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, 'has space')).status,
    ).toBe(400);
    expect((await post(`/api/radars/${radarId}/blips`, patA, { body: marker })).status).toBe(201);
    expect((await post(`/api/radars/${radarId}/blips`, patA, { body: marker })).status).toBe(201);
    expect(await blipCount(marker)).toBe(2);
  });

  it('REST: comments replay the same way', async () => {
    const created = (await (
      await post(`/api/radars/${radarId}/blips`, patA, { body: `c-${randomUUID()}` })
    ).json()) as { blip: { id: string } };
    const key = randomUUID();
    const first = await post(
      `/api/blips/${created.blip.id}/comments`,
      patA,
      { body: 'hello' },
      key,
    );
    expect(first.status).toBe(201);
    const second = await post(
      `/api/blips/${created.blip.id}/comments`,
      patA,
      { body: 'hello' },
      key,
    );
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect(((await second.json()) as { comment: { id: string } }).comment.id).toBe(
      ((await first.json()) as { comment: { id: string } }).comment.id,
    );
    const { rows } = await getDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM blip_comments WHERE blip_id = ${created.blip.id}::uuid`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('MCP: create_blip and create_comment take idempotencyKey', async () => {
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${patA}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const text = await res.text();
      const data = text.split('\n').find((l) => l.startsWith('data:'));
      const message = JSON.parse(data ? data.slice(5) : text) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      return {
        isError: message.result.isError ?? false,
        text: must(message.result.content[0]).text,
      };
    };
    const marker = `mcp-${randomUUID()}`;
    const key = randomUUID();
    const one = await rpc('create_blip', { radarId, body: marker, idempotencyKey: key });
    const two = await rpc('create_blip', { radarId, body: marker, idempotencyKey: key });
    expect(one.isError).toBe(false);
    expect((JSON.parse(two.text) as { id: string }).id).toBe(
      (JSON.parse(one.text) as { id: string }).id,
    );
    expect(await blipCount(marker)).toBe(1);
    const conflict = await rpc('create_blip', { radarId, body: `${marker}!`, idempotencyKey: key });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/different request/);

    const blipId = (JSON.parse(one.text) as { id: string }).id;
    const ckey = randomUUID();
    const c1 = await rpc('create_comment', { blipId, body: 'thanks', idempotencyKey: ckey });
    const c2 = await rpc('create_comment', { blipId, body: 'thanks', idempotencyKey: ckey });
    expect((JSON.parse(c2.text) as { id: string }).id).toBe(
      (JSON.parse(c1.text) as { id: string }).id,
    );
  });

  it('forgets a key after 24 hours, and the sweep removes it', async () => {
    const key = randomUUID();
    const marker = `old-${randomUUID()}`;
    const first = (await (
      await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key)
    ).json()) as { blip: { id: string } };
    await getDb().execute(
      sql`UPDATE request_idempotency SET created_at = now() - interval '25 hours' WHERE key = ${key}`,
    );
    const second = (await (
      await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key)
    ).json()) as { blip: { id: string } };
    expect(second.blip.id).not.toBe(first.blip.id);
    await getDb().execute(
      sql`UPDATE request_idempotency SET created_at = now() - interval '25 hours' WHERE key = ${key}`,
    );
    expect(await purgeExpiredRequestKeys()).toBeGreaterThanOrEqual(1);
  });

  it('a key whose blip was deleted is spent, not silently written again', async () => {
    const key = randomUUID();
    const marker = `gone-${randomUUID()}`;
    const first = (await (
      await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key)
    ).json()) as { blip: { id: string } };
    await getDb().delete(schema.blips).where(eq(schema.blips.id, first.blip.id));
    expect((await post(`/api/radars/${radarId}/blips`, patA, { body: marker }, key)).status).toBe(
      409,
    );
    expect(await blipCount(marker)).toBe(0);
  });

  it('agent writes leave the notification fan-out to the worker; a person in the browser still gets it inline', async () => {
    const pending = async (blipId: string) =>
      Number(
        (
          await getDb().execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'notification-event' AND payload->>'blipId' = ${blipId}`,
          )
        ).rows[0]?.n,
      );
    const viaAgent = (await (
      await post(`/api/radars/${radarId}/blips`, patA, { body: `agent-${randomUUID()}` })
    ).json()) as { blip: { id: string } };
    expect(await pending(viaAgent.blip.id)).toBe(1);
    const viaBrowser = await fetch(`${base}/api/radars/${radarId}/blips`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ body: `person-${randomUUID()}` }),
    });
    const personBlip = (await viaBrowser.json()) as { blip: { id: string } };
    expect(viaBrowser.status).toBe(201);
    expect(await pending(personBlip.blip.id)).toBe(0);
  });

  it('three workers draining at once deliver a deferred notification exactly once; rows queued before the deploy drain too', async () => {
    const viaAgent = (await (
      await post(`/api/radars/${radarId}/blips`, patA, { body: `drain-${randomUUID()}` })
    ).json()) as { blip: { id: string } };
    const queued = async () =>
      Number(
        (
          await getDb().execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM outbox WHERE payload->>'blipId' = ${viaAgent.blip.id}`,
          )
        ).rows[0]?.n,
      );
    // The row is already in the outbox, exactly as a row left by the previous release would be.
    expect(await queued()).toBeGreaterThan(0);
    for (let round = 0; round < 100 && (await queued()) > 0; round += 1)
      await Promise.all([drainDue(5), drainDue(5), drainDue(5)]);
    expect(await queued()).toBe(0);
    const { rows } = await getDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE blip_id = ${viaAgent.blip.id} GROUP BY user_id, kind`,
    );
    for (const row of rows) expect(row.n).toBe(1);
  });

  it('touches radars.updated_at at most once a minute', async () => {
    const touched = async () =>
      (
        await getDb().execute<{ t: string }>(
          sql`SELECT updated_at::text AS t FROM radars WHERE id = ${radarId}::uuid`,
        )
      ).rows[0]?.t;
    await getDb().execute(
      sql`UPDATE radars SET updated_at = now() - interval '5 minutes' WHERE id = ${radarId}::uuid`,
    );
    const stale = await touched();
    await post(`/api/radars/${radarId}/blips`, patA, { body: `t1-${randomUUID()}` });
    const fresh = await touched();
    expect(fresh).not.toBe(stale);
    await post(`/api/radars/${radarId}/blips`, patA, { body: `t2-${randomUUID()}` });
    expect(await touched()).toBe(fresh);
  });

  it('lists the readers of a radar in a fixed order', async () => {
    const extra = await getDb()
      .insert(schema.users)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          email: `reader-${i}-${randomUUID()}@example.test`,
          state: 'active' as const,
        })),
      )
      .returning();
    await getDb()
      .insert(schema.radarMembers)
      .values(extra.map((u) => ({ radarId, userId: u.id, role: 'viewer' as const })));
    const ids = (await readersOfRadars([radarId])).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(7);
    expect(ids).toEqual([...ids].sort());
  });
});

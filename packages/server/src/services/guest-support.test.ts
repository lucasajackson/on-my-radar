import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guestSupportRequestSchema } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { hashSecret } from '../auth/crypto.js';
import { sweepAuthRetention } from '../auth/retention.js';
import { getDb, getPool, closeDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import { liveActor, requireActor, type Actor, type Ctx } from '../http.js';
import { createRadar, setVisibility } from './radars.js';
import { getBlip, updateBlip, createBlip } from './blips.js';
import { bodySha256, createComment, releaseComment } from './comments.js';
import { requireGuestSupportQueue, requireRadar, requireScope } from './access.js';
import { fenceClientSupplied } from './helpdesk-projection.js';
import {
  guestSecretHash,
  startGuestSupport,
  createGuestSupport,
  getGuestSupport,
  replyGuestSupport,
  recoverGuestSupport,
  revokeGuestSupport,
  revokeGuestSupportAsStaff,
  chargeGuestSupport,
} from './guest-support.js';
import type * as Outbox from './outbox.js';
vi.mock('./outbox.js', async (original) => ({
  ...(await original<typeof Outbox>()),
  drainOne: vi.fn(async () => false),
}));
const input = () => ({
  operationId: randomUUID(),
  category: 'account' as const,
  title: 'Cannot access email',
  body: 'A redacted issue @operator',
  email: 'not-proof@example.test',
});
describe('guest support validation', () => {
  it('refuses identities, nulls, overlength and unknown fields', () => {
    expect(guestSupportRequestSchema.safeParse(input()).success).toBe(true);
    for (const extra of [
      { userId: randomUUID() },
      { radarId: randomUUID() },
      { email: 'not-email' },
      { body: 'bad\u0000text' },
      { body: 'x'.repeat(8001) },
    ])
      expect(guestSupportRequestSchema.safeParse({ ...input(), ...extra }).success).toBe(false);
  });
});
describe.skipIf(!process.env['DATABASE_URL'])('guest support (isolated real PG)', () => {
  const database = `omr_guest_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool;
  let databaseUrl: string;
  const clientEnds: Promise<void>[] = [];
  let owner: Actor;
  let staff: Actor;
  let ownerCookie: string;
  let radarId: string;
  let app: ReturnType<typeof createApp>;
  function configure(extra: Record<string, string> = {}) {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'guest-support-synthetic-session-secret',
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        SUPPORT_OWNER_ID: owner.user.id,
        SUPPORT_RADAR_ID: radarId,
        ...extra,
      }),
    );
  }
  async function person(admin = false): Promise<{ actor: Actor; cookie: string }> {
    const [user] = await getDb()
      .insert(schema.users)
      .values({
        email: `${randomUUID()}@example.test`,
        name: 'Staff owner',
        state: 'active',
        isAdmin: admin,
      })
      .returning();
    const session = await createSession(must(user));
    const [row] = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hashSecret(session.token)));
    return {
      actor: { kind: 'user', user: must(user), sessionId: must(row).id },
      cookie: `${SESSION_COOKIE}=${session.token}`,
    };
  }
  async function wire(
    path: string,
    token?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.request(`/api/guest-support${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { authorization: `Support ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: must(process.env['DATABASE_URL']) });
    await pool.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'guest-support-synthetic-session-secret',
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
      }),
    );
    getPool().on('connect', (client) =>
      clientEnds.push(new Promise<void>((resolve) => client.once('end', resolve))),
    );
    await runMigrations();
    expect((await runMigrations()).applied).toEqual([]);
    app = createApp();
  }, 30_000);
  afterAll(async () => {
    await closeDb();
    await Promise.all(clientEnds);
    setEnvForTesting(null);
    await pool.query(`DROP DATABASE ${database}`);
    await pool.end();
  });
  beforeEach(async () => {
    await getDb().delete(schema.users);
    await getDb().delete(schema.guestSupportLimits);
    const personOwner = await person(true);
    owner = personOwner.actor;
    ownerCookie = personOwner.cookie;
    staff = (await person()).actor;
    radarId = (await createRadar(owner, { name: 'Private guest support', template: 'helpdesk' }))
      .id;
    configure();
  });
  it('durably receives signed-out intake, exposes only owner-reviewed replies, reopens and fences unverified provenance', async () => {
    const started = await wire('/start', undefined, {});
    expect(started.status).toBe(201);
    const creds = (await started.json()) as Awaited<ReturnType<typeof startGuestSupport>>;
    const created = await wire('/conversation', creds.token, input());
    expect(created.status).toBe(201);
    const result = (await created.json()) as Awaited<ReturnType<typeof getGuestSupport>>;
    const id = must(result.thread).request.id;
    expect(result.thread?.request.status).toBe('received');
    const internal = await createComment(owner, id, { body: 'INTERNAL-CANARY' });
    const pending = await createComment({ ...owner, kind: 'agent' }, id, {
      body: 'PENDING-CANARY',
      visibility: 'client',
    });
    expect((await getGuestSupport(creds.token)).thread?.replies).toEqual([]);
    await releaseComment(owner, pending.id, { bodySha256: bodySha256('PENDING-CANARY') });
    const shown = await getGuestSupport(creds.token);
    expect(shown.thread?.replies.map((r) => r.body)).toEqual(['PENDING-CANARY']);
    expect(JSON.stringify(shown)).not.toContain('INTERNAL-CANARY');
    expect(JSON.stringify(shown)).not.toContain(owner.user.email);
    await updateBlip(owner, id, { status: 'resolved' });
    const reply = await replyGuestSupport(creds.token, {
      operationId: randomUUID(),
      body: 'Unverified guest follow-up',
    });
    expect(reply.thread?.request.status).toBe('in_progress');
    const staffView = fenceClientSupplied(await getBlip(id, owner));
    expect(staffView.external?.via).toBe('guest');
    expect(staffView.external?.requesterName).toContain('unverified');
    expect(staffView.body).toContain('[client-supplied text');
    const audit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.actorKind, 'guest')));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBeNull();
    expect(internal.visibility).toBe('internal');
  });
  it('isolates every thread, rejects unrelated cursor/session/bearer and grants no general actor or account authority', async () => {
    const a = await startGuestSupport(null),
      b = await startGuestSupport(null);
    const created = await createGuestSupport(a.token, input());
    expect((await getGuestSupport(b.token)).thread).toBeNull();
    expect(
      (await wire('/conversation', undefined, undefined, { cookie: ownerCookie })).status,
    ).toBe(404);
    expect(
      (await wire('/conversation', undefined, undefined, { authorization: `Bearer ${a.token}` }))
        .status,
    ).toBe(404);
    const guest = (await requireGuestSupportQueue()).actor;
    await expect(requireRadar(radarId, guest, 'read')).rejects.toMatchObject({ status: 404 });
    await expect(requireScope(guest, 'write', 'create a radar')).rejects.toMatchObject({
      status: 403,
    });
    const ctx = { get: () => guest } as unknown as Ctx;
    expect(liveActor(ctx)).toBeNull();
    expect(() => requireActor(ctx)).toThrow();
    await expect(createBlip(guest, radarId, { body: 'Bypass' })).rejects.toMatchObject({
      status: 404,
    });
    const hidden = await createComment(owner, must(created.thread).request.id, {
      body: 'Invisible cursor',
    });
    await expect(getGuestSupport(a.token, hidden.id)).rejects.toMatchObject({ status: 404 });
    await expect(getGuestSupport(b.token, hidden.id)).resolves.toMatchObject({ thread: null });
    expect(
      (
        await app.request('/api/account/export', {
          headers: { authorization: `Support ${a.token}` },
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await app.request('/mcp', {
          method: 'POST',
          headers: { authorization: `Support ${a.token}`, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });
  it('accepts a requester with no mailbox and keeps guest identity unassociated with accounts', async () => {
    const creds = await startGuestSupport(null);
    const request = {
      operationId: randomUUID(),
      category: 'account' as const,
      title: 'No mailbox',
      body: 'I cannot receive email.',
    };
    const received = await wire('/conversation', creds.token, request);
    expect(received.status).toBe(201);
    const result = (await received.json()) as Awaited<ReturnType<typeof getGuestSupport>>;
    const [stored] = await getDb()
      .select()
      .from(schema.helpdeskRequests)
      .where(eq(schema.helpdeskRequests.blipId, must(result.thread).request.id));
    expect(stored).toMatchObject({
      origin: 'guest',
      requesterEmail: '',
      nativeRequesterUserId: null,
      integrationId: null,
    });
    const replied = await replyGuestSupport(creds.token, {
      operationId: randomUUID(),
      body: 'I still cannot access email.',
    });
    expect(replied.thread?.replies[0]?.body).toBe('I still cannot access email.');
  });
  it.each(['expired', 'revoked'] as const)(
    'retention prunes a populated %s capability without deleting or changing its guest thread',
    async (reason) => {
      const creds = await startGuestSupport(null);
      const created = await createGuestSupport(creds.token, input());
      const id = must(created.thread).request.id;
      const released = await createComment(owner, id, {
        body: 'Retained released reply',
        visibility: 'client',
      });
      await replyGuestSupport(creds.token, {
        operationId: randomUUID(),
        body: 'Retained guest follow-up',
      });
      const [before] = await getDb()
        .select()
        .from(schema.helpdeskRequests)
        .where(eq(schema.helpdeskRequests.blipId, id));
      const capId = must(must(before).guestCapabilityId);
      expect(
        await getDb()
          .select()
          .from(schema.guestSupportOperations)
          .where(eq(schema.guestSupportOperations.capabilityId, capId)),
      ).toHaveLength(2);
      if (reason === 'revoked') await revokeGuestSupport(creds.token);
      else
        await getDb()
          .update(schema.guestSupportCapabilities)
          .set({ expiresAt: sql`created_at + interval '1 millisecond'` })
          .where(eq(schema.guestSupportCapabilities.id, capId));
      const swept = await sweepAuthRetention();
      expect(swept.guest_support_capabilities).toBe(1);
      expect(
        await getDb()
          .select()
          .from(schema.guestSupportCapabilities)
          .where(eq(schema.guestSupportCapabilities.id, capId)),
      ).toEqual([]);
      expect(
        await getDb()
          .select()
          .from(schema.guestSupportOperations)
          .where(eq(schema.guestSupportOperations.capabilityId, capId)),
      ).toEqual([]);
      const [after] = await getDb()
        .select()
        .from(schema.helpdeskRequests)
        .where(eq(schema.helpdeskRequests.blipId, id));
      expect(after).toEqual({ ...before, guestCapabilityId: null });
      const [retainedReply] = await getDb()
        .select()
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, released.id));
      expect(retainedReply?.body).toBe('Retained released reply');
      expect(retainedReply?.releasedAt).not.toBeNull();
      const staffView = fenceClientSupplied(await getBlip(id, owner));
      expect(staffView.external?.via).toBe('guest');
      expect(staffView.external?.requesterName).toContain('unverified');
      await expect(getGuestSupport(creds.token)).rejects.toMatchObject({ status: 404 });
      await expect(recoverGuestSupport(creds.recoveryCode, null)).rejects.toMatchObject({
        status: 404,
      });
    },
  );
  it('stores hashes, rotates lost links using separate recovery, expires and never revives revoked links', async () => {
    const creds = await startGuestSupport(null);
    const created = await createGuestSupport(creds.token, input());
    const [row] = await getDb()
      .select()
      .from(schema.guestSupportCapabilities)
      .where(eq(schema.guestSupportCapabilities.tokenHash, guestSecretHash(creds.token)));
    expect(JSON.stringify(row)).not.toContain(creds.token);
    expect(JSON.stringify(row)).not.toContain(creds.recoveryCode);
    const recovered = await recoverGuestSupport(creds.recoveryCode, null);
    await expect(getGuestSupport(creds.token)).rejects.toMatchObject({ status: 404 });
    expect((await getGuestSupport(recovered.token)).thread?.request.id).toBe(
      created.thread?.request.id,
    );
    await revokeGuestSupport(recovered.token);
    await expect(recoverGuestSupport(creds.recoveryCode, null)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      getDb()
        .update(schema.guestSupportCapabilities)
        .set({ revokedAt: null })
        .where(eq(schema.guestSupportCapabilities.id, must(row).id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const expired = await startGuestSupport(null);
    await getDb()
      .update(schema.guestSupportCapabilities)
      .set({ expiresAt: sql`created_at + interval '1 millisecond'` })
      .where(eq(schema.guestSupportCapabilities.tokenHash, guestSecretHash(expired.token)));
    await expect(getGuestSupport(expired.token)).rejects.toMatchObject({ status: 404 });
  });
  it('makes request and reply replay atomic, refuses changed payload, one thread per capability and bounds writes', async () => {
    const creds = await startGuestSupport(null),
      raw = input();
    const results = await Promise.all([
      createGuestSupport(creds.token, raw),
      createGuestSupport(creds.token, raw),
    ]);
    expect(results[0].thread?.request.id).toBe(results[1].thread?.request.id);
    await expect(
      createGuestSupport(creds.token, { ...raw, body: 'changed' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(createGuestSupport(creds.token, input())).rejects.toMatchObject({ status: 409 });
    const reply = { operationId: randomUUID(), body: 'repeat once' };
    await Promise.all([
      replyGuestSupport(creds.token, reply),
      replyGuestSupport(creds.token, reply),
    ]);
    expect((await getGuestSupport(creds.token)).thread?.replies).toHaveLength(1);
    await expect(
      replyGuestSupport(creds.token, { ...reply, body: 'changed' }),
    ).rejects.toMatchObject({ status: 409 });
    for (let i = 0; i < 8; i++)
      await replyGuestSupport(creds.token, { operationId: randomUUID(), body: `Write ${i}` });
    await expect(
      replyGuestSupport(creds.token, { operationId: randomUUID(), body: 'too many' }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('pages public replies by exact PostgreSQL microseconds without repeating the boundary or exposing hidden rows', async () => {
    const creds = await startGuestSupport(null);
    const result = await createGuestSupport(creds.token, input());
    const id = must(result.thread).request.id;
    const rows = Array.from({ length: 55 }, (_, i) => ({
      blipId: id,
      radarId,
      body: `Public ${i}`,
      visibility: 'client' as const,
      externalAuthor: {
        via: 'guest' as const,
        ref: 'fixture',
        accountRef: 'fixture',
        name: 'Unverified fixture',
        email: '',
      },
      createdAt: sql`'2030-01-01 00:00:00.000001+00'::timestamptz + ${i} * interval '1 microsecond'`,
    }));
    await getDb().insert(schema.blipComments).values(rows);
    await createComment(owner, id, { body: 'Hidden paging canary' });
    const first = must((await getGuestSupport(creds.token)).thread);
    expect(first.replies.map((r) => r.body)).toEqual(rows.slice(0, 50).map((r) => r.body));
    const second = must((await getGuestSupport(creds.token, must(first.next))).thread);
    expect(second.replies.map((r) => r.body)).toEqual(rows.slice(50).map((r) => r.body));
    expect(second.next).toBeNull();
    expect(new Set([...first.replies, ...second.replies].map((r) => r.id)).size).toBe(55);
  });
  it('refuses disabled/stale queue before claiming delivery and preserves sticky never-public safety', async () => {
    const creds = await startGuestSupport(null);
    configure({ SUPPORT_RADAR_ID: randomUUID() });
    expect((await wire('/start', undefined, {})).status).toBe(503);
    await expect(createGuestSupport(creds.token, input())).rejects.toMatchObject({ status: 503 });
    configure();
    await expect(setVisibility(owner, radarId, 'public')).rejects.toThrow();
    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.id, owner.user.id));
    await expect(getGuestSupport(creds.token)).rejects.toMatchObject({ status: 503 });
  });
  it('offers staff revocation only to actual owner live browser session and freezes guest provenance', async () => {
    const creds = await startGuestSupport(null);
    const result = await createGuestSupport(creds.token, input());
    const id = must(result.thread).request.id;
    await expect(revokeGuestSupportAsStaff(staff, id)).rejects.toMatchObject({ status: 404 });
    await expect(revokeGuestSupportAsStaff({ ...owner, kind: 'agent' }, id)).rejects.toThrow();
    await expect(
      getDb()
        .update(schema.helpdeskRequests)
        .set({ origin: 'support', guestCapabilityId: null, nativeRequesterUserId: owner.user.id })
        .where(eq(schema.helpdeskRequests.blipId, id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await revokeGuestSupportAsStaff(owner, id);
    await expect(getGuestSupport(creds.token)).rejects.toMatchObject({ status: 404 });
  });
  it('caps trusted-network intake and global missing-IP traffic, emits private headers and rejects cross-site writes', async () => {
    expect(
      (
        await app.request('/api/guest-support/start', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect((await wire('/start', undefined, { userId: owner.user.id })).status).toBe(400);
    const creds = await startGuestSupport(null);
    const response = await wire('/conversation', creds.token);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(
      (
        await wire(
          '/start',
          undefined,
          {},
          { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' },
        )
      ).status,
    ).toBe(403);
    for (let i = 0; i < 5; i++)
      expect(
        (await wire('/start', undefined, {}, { 'cf-connecting-ip': '203.0.113.32' })).status,
      ).toBe(201);
    expect(
      (await wire('/start', undefined, {}, { 'cf-connecting-ip': '203.0.113.32' })).status,
    ).toBe(429);
    for (let i = 0; i < 3; i++)
      await chargeGuestSupport('bounded-test', 2, 3600).catch(() => undefined);
    const [limit] = await getDb()
      .select()
      .from(schema.guestSupportLimits)
      .where(eq(schema.guestSupportLimits.key, 'bounded-test'));
    expect(limit?.count).toBe(3);
    const ipRows = await getDb().select().from(schema.guestSupportLimits);
    expect(JSON.stringify(ipRows)).not.toContain('203.0.113.32');
  });
  it('keeps signed-out help from granting a guest any authority beyond the support thread', async () => {
    configure({
      S3_ENDPOINT: 'https://isolated-storage.example.test',
      S3_BUCKET: 'isolated-guest-fixture',
    });
    try {
      const started = await wire('/start', undefined, {});
      expect(started.status).toBe(201);
      const creds = (await started.json()) as Awaited<ReturnType<typeof startGuestSupport>>;
      const { email: _email, ...noEmail } = input();
      const created = await wire('/conversation', creds.token, noEmail);
      expect(created.status).toBe(201);
      const result = (await created.json()) as Awaited<ReturnType<typeof getGuestSupport>>;
      const requestId = must(result.thread).request.id;
      // Existing human support access survives; support does not create a Helpdesk grant.
      await expect(getBlip(requestId, owner)).resolves.toMatchObject({ id: requestId });
      const guest = (await requireGuestSupportQueue()).actor;
      await expect(requireRadar(radarId, guest)).rejects.toMatchObject({ status: 404 });
      await expect(requireScope(guest, 'write', 'create a radar')).rejects.toMatchObject({
        status: 403,
      });
      expect(
        (
          await app.request('/mcp', {
            method: 'POST',
            headers: {
              authorization: `Support ${creds.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          })
        ).status,
      ).toBe(401);
    } finally {
      configure();
    }
  });
});

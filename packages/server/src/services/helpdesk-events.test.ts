/**
 * Helpdesk slice 4: events to the portal (docs/HELPDESK.md §5.4, T6, T11).
 *
 * Three halves, each written as the promise it keeps:
 *
 * - **What is reported.** Triggers append an ids-only event in the same
 *   transaction as each change a client can see, and nothing for the portal's
 *   own writes (echo suppression). Every path that moves a lane, publishes or
 *   retracts a reply, or takes a request out of reach is driven here.
 * - **Pull.** `GET /api/v1/helpdesk/events?after=` is ascending by
 *   `(xid, seq)` and only below the snapshot watermark, so it never skips an
 *   event whose transaction was still open — proved with two real connections.
 * - **Push.** Signed, retried, and on exhaustion paused **with the queue kept**;
 *   resumed oldest first; re-checked against the integration's reach on the
 *   way out. No network: `publicRequest` is mocked, and the queue is drained
 *   by hand so retries and pauses are asserted, not waited for.
 *
 * The watermark is cluster-wide: another test file's open transaction can hold
 * it back for a moment, so every positive read of the pull feed polls.
 *
 * Skipped when DATABASE_URL is absent. CI sets it.
 */
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HELPDESK_EVENT_KINDS,
  RADAR_TEMPLATES,
  type HelpdeskEventDto,
  type HelpdeskRequestDto,
  type IntegrationDeliveriesDto,
  type IntegrationDto,
} from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { env, loadEnv, setEnvForTesting } from '../env.js';
import { ApiError, type Actor } from '../http.js';
import { buildMcpServer } from '../mcp/server.js';
import { updateBlip, deleteBlip } from './blips.js';
import { bodySha256, createComment, deleteComment, releaseComment } from './comments.js';
import { clientStatusOf } from './helpdesk-projection.js';
import {
  drainIntegrationDeliveries,
  listIntegrationDeliveries,
  MAX_DELIVERY_ATTEMPTS,
  pauseIntegrationDelivery,
  purgeExpiredIntegrationEvents,
  resumeIntegrationDelivery,
  rotateIntegrationDeliverySecret,
  setIntegrationDelivery,
  testIntegrationDelivery,
} from './integration-events.js';
import { createIntegration, enrolRadar, revokeIntegration, unenrolRadar } from './integrations.js';
import { publicRequest, UnsafeOutboundUrlError, vetPublicUrl } from './public-request.js';
import { createRadar, deleteRadar, updateRadar } from './radars.js';
import { decryptSubscriptionSecret, verifySubscription } from './subscription-signing.js';
import type * as PublicRequestModule from './public-request.js';

vi.mock('./public-request.js', async (original) => ({
  ...(await original<typeof PublicRequestModule>()),
  publicRequest: vi.fn(),
  vetPublicUrl: vi.fn(),
}));

const parentDatabaseUrl = process.env['DATABASE_URL'];
const hasDatabase = Boolean(parentDatabaseUrl);
const fixtureDatabase = `omr_helpdesk_events_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool | undefined;
let fixtureCreated = false;
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

// This owns only fixture work, not remote SQL cancellation. Keep every started
// operation until observed settlement, including after Vitest times out.
function signedCaseLifetime(signal: AbortSignal) {
  const stop = new AbortController();
  const stopped = AbortSignal.any([signal, stop.signal]);
  const work: Promise<unknown>[] = [];
  const requireActive = () => {
    if (stopped.aborted) throw new Error('Signed-event fixture dispatch refused');
  };
  function run<T>(operation: () => Promise<T>): Promise<T> {
    requireActive();
    // Registration and rejection handling happen before the callback runs.
    const pending = Promise.resolve().then(() => {
      requireActive();
      return operation();
    });
    work.push(pending);
    void pending.catch(() => undefined);
    return pending.then((value) => {
      requireActive();
      return value;
    });
  }
  const wait = (entered?: () => void) =>
    run(
      () =>
        new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            stopped.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 100);
          stopped.addEventListener('abort', finish, { once: true });
          entered?.();
          if (stopped.aborted) finish();
        }),
    );
  const lifetime = {
    run,
    wait,
    requireActive,
    stop: () => stop.abort(),
    async join() {
      const settled = await Promise.allSettled(work);
      if (settled.some((result) => result.status === 'rejected'))
        throw new Error('Signed-event fixture operation failed during join');
    },
  };
  return lifetime;
}
type SignedLifetime = ReturnType<typeof signedCaseLifetime>;
const signedLifetimes = new Set<SignedLifetime>();
async function joinSignedCases() {
  for (const lifetime of signedLifetimes) {
    lifetime.stop();
    await lifetime.join();
    signedLifetimes.delete(lifetime);
  }
}
// A nonsettling/failed join quarantines this file under the existing hook
// budget: neither another test/mock reset nor DB cleanup may race live work.
beforeEach(joinSignedCases);

// Generic subscriptions and helpdesk deliveries share publicRequest. A queue
// left in the parent database by another file (or the earlier full CI run) must
// never enter this file's transport assertions, even when its retry becomes due.
beforeAll(async () => {
  if (!parentDatabaseUrl) return;
  admin = new pg.Pool({ connectionString: parentDatabaseUrl });
  await admin.query(`CREATE DATABASE ${fixtureDatabase}`);
  fixtureCreated = true;
  const target = new URL(parentDatabaseUrl);
  target.pathname = `/${fixtureDatabase}`; // Keep options, including CI's TimeZone.
  setEnvForTesting(loadEnv({ ...process.env, DATABASE_URL: target.toString() }));
  await runMigrations();
}, 60_000);

afterAll(async () => {
  await joinSignedCases();
  await closeDb();
  if (fixtureCreated) await admin?.query(`DROP DATABASE ${fixtureDatabase}`);
  await admin?.end();
  setEnvForTesting(null);
});

describe('signed-event fixture lifetime', () => {
  it('joins pending work and cancels its wait before cleanup; refuses late dispatch and success', async ({
    signal,
    onTestFinished,
  }) => {
    const lifetime = signedCaseLifetime(signal);
    signedLifetimes.add(lifetime);
    onTestFinished(joinSignedCases);
    const steps: string[] = [];
    let enterOperation: () => void = () => undefined;
    const operationEntered = new Promise<void>((resolve) => {
      enterOperation = resolve;
    });
    let finishOperation: () => void = () => undefined;
    const operationPending = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const operation = lifetime.run(async () => {
      steps.push('operation-entered');
      enterOperation();
      await operationPending;
      steps.push('operation-settled');
    });
    const operationRefused = expect(operation).rejects.toThrow('dispatch refused');
    let enterWait: () => void = () => undefined;
    const waitEntered = new Promise<void>((resolve) => {
      enterWait = resolve;
    });
    const wait = lifetime.wait(() => {
      steps.push('wait-entered');
      enterWait();
    });
    const waitRefused = expect(wait).rejects.toThrow('dispatch refused');
    try {
      await operationEntered;
      await waitEntered;
      lifetime.stop();
      steps.push('aborted');
      await waitRefused;
      steps.push('wait-settled');
      expect(() => lifetime.run(async () => steps.push('late-dispatch'))).toThrow(
        'dispatch refused',
      );
      expect(() => {
        lifetime.requireActive();
        steps.push('late-positive');
      }).toThrow('dispatch refused');
      const joined = lifetime.join().then(() => {
        steps.push('joined', 'cleanup');
      });
      void joined.catch(() => undefined);
      await Promise.resolve();
      expect(steps).toEqual(['operation-entered', 'wait-entered', 'aborted', 'wait-settled']);
      finishOperation();
      await operationRefused;
      await joined;
      expect(steps).toEqual([
        'operation-entered',
        'wait-entered',
        'aborted',
        'wait-settled',
        'operation-settled',
        'joined',
        'cleanup',
      ]);
    } finally {
      lifetime.stop();
      finishOperation();
      await Promise.allSettled([operationRefused, waitRefused]);
      await lifetime.join();
    }
  });
});

const EVENT_KEYS = [
  'cursor',
  'event',
  'id',
  'integrationId',
  'occurredAt',
  'radarId',
  'replyId',
  'requestId',
];

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

function agentOf(human: Actor): Actor {
  return { ...human, kind: 'agent', ceiling: 'owner', tokenId: 'test-token' };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got success');
}

async function dbRefusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    let current: unknown = err;
    const parts: string[] = [];
    for (let i = 0; current && i < 5; i += 1) {
      const detail = current as { message?: string; constraint?: string; cause?: unknown };
      parts.push(`${detail.message ?? ''} ${detail.constraint ?? ''}`);
      current = detail.cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the database to refuse, got success');
}

describe('the client status in SQL agrees with the projection (real postgres)', () => {
  it.skipIf(!hasDatabase)(
    'omr_helpdesk_client_status matches clientStatusOf on every lane, custom lanes and unknowns',
    async () => {
      await runMigrations();
      const cases: Array<[Record<string, unknown>, string | null]> = [];
      const registry = RADAR_TEMPLATES.helpdesk.statuses;
      for (const lane of registry) cases.push([{}, lane.id]);
      cases.push(
        [{}, 'no-such-lane'],
        [{}, null],
        [{ lanes: [] }, 'new'],
        [{ lanes: null }, 'new'],
      );
      const custom = {
        lanes: [
          { id: 'triage', label: 'Triage', state: 'inbox', clientStatus: 'received' },
          { id: 'doing', label: 'Doing', state: 'active', clientStatus: 'in_progress' },
          { id: 'waiting', label: 'Waiting', state: 'later', clientStatus: 'waiting_on_you' },
          { id: 'new', label: 'Renamed new', state: 'done', clientStatus: 'resolved' },
        ],
      };
      for (const id of ['triage', 'doing', 'waiting', 'new', 'resolved', 'gone'])
        cases.push([custom, id]);
      for (const [config, status] of cases) {
        const result = await getDb().execute<{ s: string }>(
          sql`SELECT omr_helpdesk_client_status(${JSON.stringify(config)}::jsonb, ${status}) AS s`,
        );
        const expected = clientStatusOf({ template: 'helpdesk', templateConfig: config }, status);
        expect([config, status, result.rows[0]?.s]).toEqual([config, status, expected]);
      }
    },
  );
});

describe.skipIf(!hasDatabase)('helpdesk events (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let lucas: Actor;
  let lucasCookie: string;
  let integration: IntegrationDto;
  let token: string;

  type Hd = { scope?: string | null; body?: unknown; auth?: string };
  const hd = async (method: string, path: string, opts: Hd = {}) => {
    const headers: Record<string, string> = {};
    const auth = opts.auth ?? token;
    if (auth) headers['authorization'] = `Bearer ${auth}`;
    if (opts.scope !== null) headers['x-omr-requester-scope'] = opts.scope ?? 'acct-a';
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    return app.request(`/api/v1/helpdesk${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  };
  const requester = (account = 'acct-a') => ({
    ref: `cust-${account}`,
    accountRef: account,
    name: 'Pat Client',
    email: `${account}@client.example`,
  });
  const newRequest = async (radarId: string, auth = token, account = 'acct-a') => {
    const res = await hd('POST', `/radars/${radarId}/requests`, {
      scope: account,
      auth,
      body: { title: 'Fix the form', body: 'It does nothing.', requester: requester(account) },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { request: HelpdeskRequestDto }).request;
  };
  const clientReply = async (requestId: string, body: string, account = 'acct-a') => {
    const res = await hd('POST', `/requests/${requestId}/replies`, {
      scope: account,
      body: { body, requester: requester(account) },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item;
  };
  const newHelpdesk = async (name: string, owner = lucas) =>
    (await createRadar(owner, { name, template: 'helpdesk' })).id;
  const enrolled = async (name: string, which = integration) => {
    const radar = await newHelpdesk(name);
    await enrolRadar(lucas, which.id, { radarId: radar });
    return radar;
  };

  /** The raw log since a marker, for asserting what a change appended. */
  type Logged = {
    seq: string;
    event: string;
    integration_id: string;
    request_id: string | null;
    radar_id: string | null;
    reply_id: string | null;
  };
  const mark = async (): Promise<string> => {
    const r = await getDb().execute<{ seq: string | null }>(
      sql`SELECT max(seq)::text AS seq FROM integration_events`,
    );
    return r.rows[0]?.seq ?? '0';
  };
  const since = async (marker: string, integrationId = integration.id): Promise<Logged[]> =>
    (
      await getDb().execute<Logged>(sql`
        SELECT seq::text AS seq, event, integration_id, request_id, radar_id, reply_id
          FROM integration_events
         WHERE seq > ${marker}::bigint AND integration_id = ${integrationId}::uuid
         ORDER BY seq`)
    ).rows;
  const kinds = (rows: Logged[]) => rows.map((r) => r.event);

  /** The pull feed, polled until `until` holds: the watermark is cluster-wide. */
  const pull = async (after: string | null, auth = token, limit?: number) => {
    const qs = new URLSearchParams();
    if (after) qs.set('after', after);
    if (limit) qs.set('limit', String(limit));
    const res = await hd('GET', `/events${qs.size ? `?${qs.toString()}` : ''}`, {
      scope: null,
      auth,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      items: HelpdeskEventDto[];
      nextAfter: string | null;
      watermarkLagSeconds: number;
    };
  };
  const pullUntil = async (
    after: string | null,
    until: (items: HelpdeskEventDto[]) => boolean,
    auth = token,
    lifetime?: SignedLifetime,
    progress?: (attempt: number, count: number, matched: boolean, lag: number) => void,
  ) => {
    for (let i = 0; i < 100; i += 1) {
      const page = lifetime ? await lifetime.run(() => pull(after, auth)) : await pull(after, auth);
      lifetime?.requireActive();
      const matched = until(page.items);
      progress?.(i + 1, page.items.length, matched, page.watermarkLagSeconds);
      if (matched) return page;
      if (lifetime) await lifetime.wait();
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the pull feed never showed what was expected');
  };
  /** The cursor at the end of the feed right now. */
  const tail = async (auth = token): Promise<string | null> => {
    let after: string | null = null;
    for (;;) {
      const page = await pull(after, auth, 500);
      if (page.items.length === 0) return after;
      after = page.nextAfter;
    }
  };

  const drain = async (lifetime?: SignedLifetime, progress?: (completed: number) => void) => {
    for (let i = 0; i < 200; i += 1) {
      const delivered = lifetime
        ? await lifetime.run(drainIntegrationDeliveries)
        : await drainIntegrationDeliveries();
      lifetime?.requireActive();
      if (!delivered) break;
      progress?.(i + 1);
    }
  };
  const due = async (integrationId: string) => {
    await getDb().execute(
      sql`UPDATE integration_deliveries SET run_after = now() WHERE integration_id = ${integrationId}::uuid`,
    );
  };
  const sent = () =>
    vi.mocked(publicRequest).mock.calls.map(([url, options]) => {
      const body = String(options?.body ?? '');
      return {
        url: String(url),
        body,
        payload: JSON.parse(body) as HelpdeskEventDto,
        headers: options?.headers ?? {},
      };
    });

  /** A fresh integration with a receiver, its own helpdesk and a token. */
  const withReceiver = async (name: string, lifetime?: SignedLifetime) => {
    const dispatch = <T>(operation: () => Promise<T>) =>
      lifetime ? lifetime.run(operation) : operation();
    const minted = await dispatch(() => createIntegration(lucas, { name }));
    const { secret } = await dispatch(() =>
      setIntegrationDelivery(lucas, minted.id, 'https://portal.example/omr'),
    );
    const radar = await dispatch(() => newHelpdesk(`Helpdesk · ${name}`));
    await dispatch(() => enrolRadar(lucas, minted.id, { radarId: radar }));
    return { id: minted.id, token: minted.token ?? '', secret: secret ?? '', radar };
  };

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    lucas = await makeUser('ev-lucas');
    lucasCookie = `${SESSION_COOKIE}=${(await createSession(lucas.user)).token}`;
    integration = await createIntegration(lucas, { name: 'W&W portal' });
    token = integration.token ?? '';
  }, 60_000);

  beforeEach(() => {
    vi.mocked(publicRequest).mockReset().mockResolvedValue({ status: 204, headers: {}, body: '' });
    vi.mocked(vetPublicUrl).mockReset().mockResolvedValue(undefined);
  });

  it('isolates transport queues from the parent database and preserves its timezone', async () => {
    if (!admin) throw new Error('missing fixture administration connection');
    const parent = await admin.query<{ database: string; timezone: string }>(
      `SELECT current_database() AS database, current_setting('TimeZone') AS timezone`,
    );
    const fixture = await getDb().execute<{ database: string; timezone: string }>(
      sql`SELECT current_database() AS database, current_setting('TimeZone') AS timezone`,
    );
    expect(fixture.rows[0]?.database).toBe(fixtureDatabase);
    expect(fixture.rows[0]?.database).not.toBe(parent.rows[0]?.database);
    expect(fixture.rows[0]?.timezone).toBe(parent.rows[0]?.timezone);
  });

  /* ------------------------------ what is reported ---------------------------- */

  it("reports nothing for the portal's own writes: a new request and a client's reply", async () => {
    const radar = await enrolled('Helpdesk · Echo');
    const before = await mark();
    const request = await newRequest(radar);
    await clientReply(request.id, 'More detail from me');
    expect(await since(before)).toEqual([]);
  });

  it('reports a lane move between client statuses as request.status_changed, ids only', async () => {
    const radar = await enrolled('Helpdesk · Lanes');
    const request = await newRequest(radar);
    const after = await tail();
    const before = await mark();
    await updateBlip(lucas, request.id, { status: 'scheduled' });
    const rows = await since(before);
    expect(rows.map((r) => [r.event, r.request_id, r.radar_id, r.reply_id])).toEqual([
      ['request.status_changed', request.id, radar, null],
    ]);
    const page = await pullUntil(after, (items) => items.some((i) => i.requestId === request.id));
    const item = page.items.find((i) => i.requestId === request.id);
    expect(Object.keys(item ?? {}).sort()).toEqual(EVENT_KEYS);
    expect(item).toMatchObject({
      event: 'request.status_changed',
      integrationId: integration.id,
      radarId: radar,
      replyId: null,
    });
    expect(item?.id).toMatch(/^evt_[0-9a-f-]{36}$/);
  });

  it('reports nothing for a move between two lanes that show the client the same status', async () => {
    const radar = await newHelpdesk('Helpdesk · Same status');
    await updateRadar(lucas, radar, {
      templateConfig: {
        lanes: [
          { id: 'new', label: 'New', state: 'inbox', clientStatus: 'received' },
          { id: 'doing', label: 'Doing', state: 'active', clientStatus: 'in_progress' },
          { id: 'testing', label: 'Testing', state: 'active', clientStatus: 'in_progress' },
        ],
      },
    });
    await enrolRadar(lucas, integration.id, { radarId: radar });
    const request = await newRequest(radar);
    await updateBlip(lucas, request.id, { status: 'doing' });
    const before = await mark();
    await updateBlip(lucas, request.id, { status: 'testing' });
    expect(await since(before)).toEqual([]);
  });

  it("reports the status repair a client's reply causes, and not the reply itself", async () => {
    const radar = await enrolled('Helpdesk · Repair');
    const request = await newRequest(radar);
    await updateBlip(lucas, request.id, { status: 'waiting-on-client' });
    const before = await mark();
    await clientReply(request.id, 'Here is the screenshot');
    expect(kinds(await since(before))).toEqual(['request.status_changed']);
  });

  it("reports a reply when it becomes client-visible: the owner's own, or a release", async () => {
    const radar = await enrolled('Helpdesk · Replies');
    const request = await newRequest(radar);
    let before = await mark();
    const own = await createComment(lucas, request.id, {
      body: 'We are on it.',
      visibility: 'client',
    });
    expect((await since(before)).map((r) => [r.event, r.reply_id])).toEqual([
      ['request.reply', own.id],
    ]);

    before = await mark();
    const drafted = await createComment(agentOf(lucas), request.id, {
      body: 'Drafted by an agent.',
      visibility: 'client',
    });
    expect(drafted.visibility).toBe('client_pending');
    expect(await since(before)).toEqual([]);
    await releaseComment(lucas, drafted.id, { bodySha256: bodySha256('Drafted by an agent.') });
    expect((await since(before)).map((r) => [r.event, r.reply_id])).toEqual([
      ['request.reply', drafted.id],
    ]);

    before = await mark();
    await createComment(lucas, request.id, { body: 'Internal: check the logs.' });
    expect(await since(before)).toEqual([]);
  });

  it('reports a client-visible reply deleted as request.reply_retracted, and an internal note not at all', async () => {
    const radar = await enrolled('Helpdesk · Retract');
    const request = await newRequest(radar);
    const published = await createComment(lucas, request.id, {
      body: 'Sent too soon.',
      visibility: 'client',
    });
    const fromClient = await clientReply(request.id, 'Spam I sent by mistake');
    const note = await createComment(lucas, request.id, { body: 'a note' });
    const before = await mark();
    await deleteComment({ ...lucas, viaCookie: true }, published.id);
    await deleteComment({ ...lucas, viaCookie: true }, fromClient.id);
    await deleteComment({ ...lucas, viaCookie: true }, note.id);
    // Which deletions report, not their order (one unreproduced CI-load run
    // listed these two the other way round).
    expect(
      (await since(before))
        .map((r) => [r.event, r.reply_id])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual(
      [
        ['request.reply_retracted', published.id],
        ['request.reply_retracted', fromClient.id],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
  });

  it('reports a deleted request once as request.removed, not each of its replies', async () => {
    const radar = await enrolled('Helpdesk · Delete');
    const request = await newRequest(radar);
    await createComment(lucas, request.id, { body: 'Public', visibility: 'client' });
    await clientReply(request.id, 'Mine');
    const before = await mark();
    await deleteBlip(lucas, request.id);
    expect((await since(before)).map((r) => [r.event, r.request_id])).toEqual([
      ['request.removed', request.id],
    ]);
  });

  it("reports request.removed for each of the integration's requests when a radar is unenrolled, then nothing", async () => {
    const radar = await enrolled('Helpdesk · Unenrol');
    const staging = await createIntegration(lucas, { name: 'staging portal' });
    await enrolRadar(lucas, staging.id, { radarId: radar });
    const first = await newRequest(radar);
    const second = await newRequest(radar, token, 'acct-b');
    const stagingRequest = await newRequest(radar, staging.token ?? '');
    const before = await mark();
    await unenrolRadar(agentOf(lucas), integration.id, radar);
    expect((await since(before)).map((r) => [r.event, r.request_id])).toEqual([
      ['request.removed', first.id],
      ['request.removed', second.id],
    ]);
    // Staging's request was not this integration's, and staging still reaches it.
    expect(await since(before, staging.id)).toEqual([]);
    const after = await mark();
    await updateBlip(lucas, first.id, { status: 'resolved' });
    expect(await since(after)).toEqual([]);
    // Staging is told about its own request's moves, and only those.
    await updateBlip(lucas, stagingRequest.id, { status: 'resolved' });
    expect(kinds(await since(after, staging.id))).toEqual(['request.status_changed']);
  });

  it('holds in the database: a raw move reports request.removed, a raw re-release reports nothing more', async () => {
    // The service refuses both (a request never moves; a released reply never
    // changes). The triggers answer for any path that skips the service.
    const radar = await enrolled('Helpdesk · Raw writes');
    const elsewhere = await newHelpdesk('Helpdesk · Raw elsewhere');
    const request = await newRequest(radar);
    const released = await createComment(lucas, request.id, {
      body: 'Released once.',
      visibility: 'client',
    });
    const before = await mark();
    await getDb().execute(
      sql`UPDATE blip_comments SET visibility = 'client' WHERE id = ${released.id}::uuid`,
    );
    expect(await since(before)).toEqual([]);
    await getDb().execute(
      sql`UPDATE blips SET radar_id = ${elsewhere}::uuid WHERE id = ${request.id}::uuid`,
    );
    expect((await since(before)).map((r) => [r.event, r.request_id, r.radar_id])).toEqual([
      ['request.removed', request.id, radar],
    ]);
  });

  it('reports request.removed when the radar leaves the template, changes owner, or is deleted', async () => {
    const offTemplate = await enrolled('Helpdesk · Off template');
    const a = await newRequest(offTemplate);
    let before = await mark();
    await updateRadar(lucas, offTemplate, { template: 'kanban', templateConfig: { lanes: null } });
    expect((await since(before)).map((r) => [r.event, r.request_id])).toEqual([
      ['request.removed', a.id],
    ]);

    const givenAway = await enrolled('Helpdesk · Given away');
    const b = await newRequest(givenAway);
    const other = await makeUser('ev-new-owner');
    before = await mark();
    await getDb()
      .update(schema.radars)
      .set({ ownerId: other.user.id })
      .where(eq(schema.radars.id, givenAway));
    expect((await since(before)).map((r) => [r.event, r.request_id])).toEqual([
      ['request.removed', b.id],
    ]);

    const deleted = await enrolled('Helpdesk · Deleted');
    const c = await newRequest(deleted);
    const d = await newRequest(deleted, token, 'acct-b');
    before = await mark();
    await deleteRadar(lucas, deleted);
    expect((await since(before)).map((r) => [r.event, r.request_id])).toEqual([
      ['request.removed', c.id],
      ['request.removed', d.id],
    ]);
    const [enrolment] = await getDb()
      .select()
      .from(schema.integrationRadars)
      .where(eq(schema.integrationRadars.radarId, deleted));
    expect(enrolment).toBeUndefined();
  });

  it('reports request.status_changed for the requests in a lane whose client status is re-mapped', async () => {
    const radar = await enrolled('Helpdesk · Remap');
    const lanes = (doing: 'in_progress' | 'scheduled') => ({
      lanes: [
        { id: 'new', label: 'New', state: 'inbox' as const, clientStatus: 'received' as const },
        { id: 'doing', label: 'Doing', state: 'active' as const, clientStatus: doing },
      ],
    });
    await updateRadar(lucas, radar, { templateConfig: lanes('in_progress') });
    const moved = await newRequest(radar);
    const stayed = await newRequest(radar, token, 'acct-b');
    await updateBlip(lucas, moved.id, { status: 'doing' });
    const before = await mark();
    await updateRadar(lucas, radar, { templateConfig: lanes('scheduled') });
    expect((await since(before)).map((r) => [r.event, r.request_id])).toEqual([
      ['request.status_changed', moved.id],
    ]);
    expect((await since(before)).map((r) => r.request_id)).not.toContain(stayed.id);
  });

  it('tells a revoked integration nothing', async () => {
    const minted = await createIntegration(lucas, { name: 'to revoke' });
    const radar = await newHelpdesk('Helpdesk · Revoked');
    await enrolRadar(lucas, minted.id, { radarId: radar });
    const request = await newRequest(radar, minted.token ?? '');
    const before = await mark();
    await revokeIntegration(lucas, minted.id);
    await updateBlip(lucas, request.id, { status: 'resolved' });
    expect(await since(before, minted.id)).toEqual([]);
  });

  it('never rewrites an event, and allows each kind only the ids it carries', async () => {
    const radar = await enrolled('Helpdesk · Immutable');
    const request = await newRequest(radar);
    const before = await mark();
    await updateBlip(lucas, request.id, { status: 'resolved' });
    const [row] = await since(before);
    expect(
      await dbRefusal(
        getDb().execute(
          sql`UPDATE integration_events SET event = 'request.removed' WHERE seq = ${row?.seq ?? '0'}::bigint`,
        ),
      ),
    ).toContain('never rewritten');
    const insert = (
      event: string,
      request: string | null,
      radarId: string | null,
      reply: string | null,
    ) =>
      getDb().execute(sql`
        INSERT INTO integration_events (integration_id, event, request_id, radar_id, reply_id)
        VALUES (${integration.id}::uuid, ${event}, ${request}::uuid, ${radarId}::uuid, ${reply}::uuid)`);
    const id = request.id;
    for (const [event, req, rad, rep] of [
      ['request.reply', id, radar, null],
      ['request.status_changed', id, radar, id],
      ['integration.test', id, radar, null],
      ['request.removed', null, null, null],
      ['request.removed', id, null, null],
      ['request.title_changed', id, radar, null],
    ] as const) {
      expect(await dbRefusal(insert(event, req, rad, rep))).toMatch(
        /integration_events_shape|integration_events_event_valid/,
      );
    }
  });

  it('deletes an owner holding an integration, its log and queued deliveries', async () => {
    const owner = await makeUser('ev-deleted-owner');
    const minted = await createIntegration(owner, { name: 'doomed' });
    await setIntegrationDelivery(owner, minted.id, 'https://portal.example/omr');
    const radar = await newHelpdesk('Helpdesk · Doomed', owner);
    await enrolRadar(owner, minted.id, { radarId: radar });
    const request = await newRequest(radar, minted.token ?? '');
    await updateBlip(owner, request.id, { status: 'resolved' });
    await createComment(owner, request.id, { body: 'Done.', visibility: 'client' });
    expect((await since('0', minted.id)).length).toBeGreaterThan(0);
    await getDb().delete(schema.users).where(eq(schema.users.id, owner.user.id));
    expect(await since('0', minted.id)).toEqual([]);
    const queued = await getDb()
      .select()
      .from(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.integrationId, minted.id));
    expect(queued).toEqual([]);
  });

  /* ----------------------------------- pull ----------------------------------- */

  it('pages the feed ascending by an opaque cursor, with no scope header, and never shows another integration’s', async () => {
    const own = await withReceiver('pager');
    const other = await withReceiver('neighbour');
    const start = await tail(own.token);
    const request = await newRequest(own.radar, own.token);
    const neighbours = await newRequest(other.radar, other.token);
    for (const status of ['scheduled', 'in-progress', 'resolved'])
      await updateBlip(lucas, request.id, { status });
    await updateBlip(lucas, neighbours.id, { status: 'resolved' });
    const all = await pullUntil(start, (items) => items.length >= 3, own.token);
    expect(all.items.map((i) => i.event)).toEqual([
      'request.status_changed',
      'request.status_changed',
      'request.status_changed',
    ]);
    expect(all.items.every((i) => i.integrationId === own.id)).toBe(true);
    expect(all.items.map((i) => i.requestId)).not.toContain(neighbours.id);
    // Two at a time, and the pages meet exactly.
    const first = await pull(start, own.token, 2);
    expect(first.items.map((i) => i.id)).toEqual(all.items.slice(0, 2).map((i) => i.id));
    const second = await pull(first.nextAfter, own.token, 2);
    expect(second.items.map((i) => i.id)).toEqual([all.items[2]?.id]);
    // At the end, nextAfter stays where it was, so a poller never loses its place.
    const end = await pull(second.nextAfter, own.token, 2);
    expect(end.items).toEqual([]);
    expect(end.nextAfter).toBe(second.nextAfter);
    expect(typeof end.watermarkLagSeconds).toBe('number');
  });

  it('refuses a malformed cursor, and any credential but an integration’s', async () => {
    expect((await hd('GET', '/events?after=not-a-cursor!', { scope: null })).status).toBe(400);
    const cursor = (x: string, sq: string) =>
      Buffer.from(JSON.stringify({ x, s: sq })).toString('base64url');
    expect(
      (await hd('GET', `/events?after=${cursor('1; DROP', '2')}`, { scope: null })).status,
    ).toBe(400);
    // Out of each key's range: a 400 before SQL, never a 500 quoting the cast.
    for (const [x, sq] of [
      ['1', '1'.repeat(20)], // 20 digits: past a bigint
      ['1', String(2n ** 63n)], // 19 digits, one past 2^63 - 1
      ['1'.repeat(21), '1'], // 21 digits: past an xid8
      [String(2n ** 64n), '1'], // one past 2^64 - 1
    ] as const satisfies ReadonlyArray<readonly [string, string]>) {
      const res = await hd('GET', `/events?after=${cursor(x, sq)}`, { scope: null });
      const text = await res.text();
      expect([x, sq, res.status]).toEqual([x, sq, 400]);
      expect(text).not.toMatch(/SELECT|xid8|bigint/i);
    }
    // The largest of each is a cursor, past the end of the feed.
    const max = await hd(
      'GET',
      `/events?after=${cursor(String(2n ** 64n - 1n), String(2n ** 63n - 1n))}`,
      {
        scope: null,
      },
    );
    expect(max.status).toBe(200);
    expect(((await max.json()) as { items: unknown[] }).items).toEqual([]);
    expect(
      (await app.request('/api/v1/helpdesk/events', { headers: { cookie: lucasCookie } })).status,
    ).toBe(401);
  });

  it('holds back an event behind an open transaction and never skips it (the watermark)', async () => {
    // §5.4's test: A writes first and stays open; B writes later and commits.
    // A seq cursor would hand out B and move past A for good.
    const own = await withReceiver('watermark');
    const early = await newRequest(own.radar, own.token);
    const late = await newRequest(own.radar, own.token, 'acct-b');
    const start = await tail(own.token);
    const a = new pg.Client({ connectionString: env().DATABASE_URL });
    const b = new pg.Client({ connectionString: env().DATABASE_URL });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query('BEGIN');
      await a.query(`UPDATE blips SET status = 'scheduled' WHERE id = $1`, [early.id]);
      await b.query('BEGIN');
      await b.query(`UPDATE blips SET status = 'resolved' WHERE id = $1`, [late.id]);
      await b.query('COMMIT');
      const [aXid, bXid] = await Promise.all([
        getDb().execute<{ xid: string }>(
          sql`SELECT xid::text AS xid FROM integration_events WHERE request_id = ${late.id}::uuid`,
        ),
        a.query<{ xid: string }>(`SELECT pg_current_xact_id()::text AS xid`),
      ]);
      // A really is the older transaction, and B's event really is committed.
      expect(BigInt(bXid.rows[0]?.xid ?? '0')).toBeLessThan(BigInt(aXid.rows[0]?.xid ?? '0'));
      const held = await pull(start, own.token);
      expect(held.items).toEqual([]);
      expect(held.nextAfter).toBe(start);
      await a.query('COMMIT');
      const both = await pullUntil(start, (items) => items.length >= 2, own.token);
      expect(both.items.map((i) => i.requestId)).toEqual([early.id, late.id]);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("orders by the writing transaction, so an older transaction's later event is not skipped", async () => {
    // C takes its xid before A, A logs first (lower seq), C logs and commits
    // while A is open. A reader then has C. A seq cursor would now be past A's
    // event for good; the (xid, seq) cursor still has it ahead.
    const own = await withReceiver('xid order');
    const first = await newRequest(own.radar, own.token);
    const second = await newRequest(own.radar, own.token, 'acct-b');
    const start = await tail(own.token);
    const a = new pg.Client({ connectionString: env().DATABASE_URL });
    const c = new pg.Client({ connectionString: env().DATABASE_URL });
    await Promise.all([a.connect(), c.connect()]);
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_current_xact_id()');
      await a.query('BEGIN');
      await a.query('SELECT pg_current_xact_id()');
      await a.query(`UPDATE blips SET status = 'scheduled' WHERE id = $1`, [first.id]);
      await c.query(`UPDATE blips SET status = 'resolved' WHERE id = $1`, [second.id]);
      await c.query('COMMIT');
      const seen = await pullUntil(start, (items) => items.length >= 1, own.token);
      expect(seen.items.map((i) => i.requestId)).toEqual([second.id]);
      await a.query('COMMIT');
      const rest = await pullUntil(seen.nextAfter, (items) => items.length >= 1, own.token);
      expect(rest.items.map((i) => i.requestId)).toEqual([first.id]);
      const seqs = await getDb().execute<{ request_id: string; seq: string }>(sql`
        SELECT request_id, seq::text AS seq FROM integration_events
         WHERE integration_id = ${own.id}::uuid AND event = 'request.status_changed'`);
      const seqOf = (id: string) => Number(seqs.rows.find((r) => r.request_id === id)?.seq);
      // The case is real: the skipped-by-seq event has the lower seq.
      expect(seqOf(first.id)).toBeLessThan(seqOf(second.id));
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await c.query('ROLLBACK').catch(() => undefined);
      await Promise.all([a.end(), c.end()]);
    }
  });

  it("never projects another integration's request, or one off the radar its event names", async () => {
    // Rows the triggers never write, inserted by hand: the projection's own
    // checks, behind the triggers, still say "removed".
    const own = await withReceiver('forged rows');
    const other = await withReceiver('forged rows, other');
    const theirs = await newRequest(other.radar, other.token);
    const mine = await newRequest(own.radar, own.token);
    // Both reach the other radar, so only "filed through this integration"
    // stands between the first row and the other portal's request.
    await enrolRadar(lucas, own.id, { radarId: other.radar });
    const start = await tail(own.token);
    await getDb().execute(sql`
      INSERT INTO integration_events (integration_id, event, request_id, radar_id)
      VALUES (${own.id}::uuid, 'request.status_changed', ${theirs.id}::uuid, ${other.radar}::uuid),
             (${own.id}::uuid, 'request.status_changed', ${mine.id}::uuid, ${other.radar}::uuid)`);
    const page = await pullUntil(start, (items) => items.length >= 2, own.token);
    expect(page.items.map((i) => i.event)).toEqual(['request.removed', 'request.removed']);
  });

  it('shows an event whose request has since left reach as request.removed, without its reply id', async () => {
    const own = await withReceiver('rewrite');
    const request = await newRequest(own.radar, own.token);
    const start = await tail(own.token);
    const reply = await createComment(lucas, request.id, { body: 'Hello', visibility: 'client' });
    await unenrolRadar(lucas, own.id, own.radar);
    const page = await pullUntil(start, (items) => items.length >= 2, own.token);
    expect(page.items.map((i) => [i.event, i.requestId, i.replyId])).toEqual([
      ['request.removed', request.id, null],
      ['request.removed', request.id, null],
    ]);
    // The log itself still says what happened.
    const logged = await since('0', own.id);
    expect(logged.some((r) => r.event === 'request.reply' && r.reply_id === reply.id)).toBe(true);
  });

  it('keeps 30 days of events and purges older ones', async () => {
    const own = await withReceiver('retention');
    const request = await newRequest(own.radar, own.token);
    await updateBlip(lucas, request.id, { status: 'resolved' });
    await updateBlip(lucas, request.id, { status: 'declined' });
    const [old, recent] = await since('0', own.id);
    // Rewriting is refused by trigger, so age the row the way time would.
    await getDb().execute(
      sql`ALTER TABLE integration_events DISABLE TRIGGER integration_events_immutable`,
    );
    try {
      await getDb().execute(sql`
        UPDATE integration_events SET occurred_at = now() - interval '721 hours'
         WHERE seq = ${old?.seq ?? '0'}::bigint`);
      await getDb().execute(sql`
        UPDATE integration_events SET occurred_at = now() - interval '719 hours'
         WHERE seq = ${recent?.seq ?? '0'}::bigint`);
    } finally {
      await getDb().execute(
        sql`ALTER TABLE integration_events ENABLE TRIGGER integration_events_immutable`,
      );
    }
    await purgeExpiredIntegrationEvents();
    expect((await since('0', own.id)).map((r) => r.seq)).toEqual([recent?.seq]);
  });

  /* ----------------------------------- push ----------------------------------- */

  it('pushes each event signed with the receiver secret, with its durable id as X-OMR-Event-Id', async ({
    signal,
    onTestFinished,
  }) => {
    const lifetime = signedCaseLifetime(signal);
    signedLifetimes.add(lifetime);
    onTestFinished(joinSignedCases);
    const started = performance.now();
    type Phase =
      'receiver' | 'request' | 'status-update' | 'drain' | 'signed-assertions' | 'pull' | 'history';
    const progress = {
      drainCompleted: 0,
      pullAttempts: 0,
      pullItems: 0,
      pullMatched: false,
      watermarkLagSeconds: 0,
    };
    let current: Phase = 'receiver';
    const emit = (state: 'start' | 'complete' | 'failed' | 'aborted') => {
      process.stdout.write(
        `${JSON.stringify({ signedEventFixture: { phase: current, state, elapsedMs: Math.round(performance.now() - started), ...progress } })}\n`,
      );
    };
    const aborted = () => emit('aborted');
    signal.addEventListener('abort', aborted, { once: true });
    async function phase<T>(name: Phase, operation: () => Promise<T>): Promise<T> {
      lifetime.requireActive();
      current = name;
      emit('start');
      try {
        const value = await lifetime.run(operation);
        lifetime.requireActive();
        emit('complete');
        return value;
      } catch (error) {
        emit(signal.aborted ? 'aborted' : 'failed');
        throw error;
      }
    }
    try {
      const own = await phase('receiver', () => withReceiver('signed', lifetime));
      lifetime.requireActive();
      expect(own.secret).toMatch(/^omr_whsec_/);
      const request = await phase('request', () => newRequest(own.radar, own.token));
      await phase('status-update', () => updateBlip(lucas, request.id, { status: 'scheduled' }));
      await phase('drain', () =>
        drain(lifetime, (completed) => {
          progress.drainCompleted = completed;
        }),
      );
      lifetime.requireActive();
      const calls = sent().filter((c) => c.payload.integrationId === own.id);
      await phase('signed-assertions', async () => {
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call?.url).toBe('https://portal.example/omr');
        expect(Object.keys(call?.payload ?? {}).sort()).toEqual(EVENT_KEYS);
        expect(call?.payload).toMatchObject({
          event: 'request.status_changed',
          requestId: request.id,
        });
        expect(call?.headers['X-OMR-Event-Id']).toBe(call?.payload.id);
        expect(
          verifySubscription(own.secret, call?.body ?? '', call?.headers['X-OMR-Signature'] ?? ''),
        ).toBe(true);
      });
      const [call] = calls;
      // The same event, pulled, has the same durable id: the portal's dedupe key.
      const page = await phase('pull', () =>
        pullUntil(
          null,
          (items) => items.some((i) => i.id === call?.payload.id),
          own.token,
          lifetime,
          (attempt, count, matched, lag) => {
            progress.pullAttempts = attempt;
            progress.pullItems = count;
            progress.pullMatched = matched;
            progress.watermarkLagSeconds = Number.isFinite(lag)
              ? Math.min(2_147_483_647, Math.max(0, Math.round(lag)))
              : 0;
          },
        ),
      );
      lifetime.requireActive();
      expect(page.items.find((i) => i.id === call?.payload.id)?.event).toBe(
        'request.status_changed',
      );
      await phase('history', async () => {
        const history = await listIntegrationDeliveries(lucas, own.id);
        lifetime.requireActive();
        expect(history.attempts.map((a) => [a.eventId, a.status])).toEqual([
          [call?.payload.id, 204],
        ]);
        expect(history.delivery?.pending).toBe(0);
      });
      lifetime.requireActive();
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  });

  it('retries, then pauses and keeps the queue: nothing discarded, new events buffered, the owner told once', async () => {
    const own = await withReceiver('flaky');
    const request = await newRequest(own.radar, own.token);
    vi.mocked(publicRequest).mockResolvedValue({ status: 503, headers: {}, body: '' });
    await updateBlip(lucas, request.id, { status: 'scheduled' });
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await due(own.id);
      await drain();
    }
    const [paused] = await getDb()
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, own.id));
    expect(paused?.deliveryPausedAt).not.toBeNull();
    expect(paused?.deliveryLastError).toContain('503');
    // Still queued, and new events queue behind it while nothing is sent.
    await updateBlip(lucas, request.id, { status: 'in-progress' });
    vi.mocked(publicRequest).mockClear();
    await due(own.id);
    await drain();
    expect(sent().filter((c) => c.payload.integrationId === own.id)).toEqual([]);
    const history = await listIntegrationDeliveries(lucas, own.id);
    expect(history.delivery?.pending).toBe(2);
    expect(history.delivery?.pausedAt).not.toBeNull();
    expect(history.attempts).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const told = await getDb()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, lucas.user.id),
          eq(schema.notifications.subject, 'flaky'),
        ),
      );
    expect(told.map((n) => n.kind)).toEqual(['subscription_failed']);
    // Resuming sends the whole queue now, however far its retries had backed off.
    await getDb().execute(sql`
      UPDATE integration_deliveries SET run_after = now() + interval '3 hours'
       WHERE integration_id = ${own.id}::uuid`);
    vi.mocked(publicRequest).mockReset().mockResolvedValue({ status: 204, headers: {}, body: '' });
    await resumeIntegrationDelivery(lucas, own.id);
    await drain();
    expect(sent().filter((c) => c.payload.integrationId === own.id)).toHaveLength(2);
  });

  it('does not tell the owner again when delivery was already paused while an attempt was in flight', async () => {
    const own = await withReceiver('paused mid-flight');
    const request = await newRequest(own.radar, own.token);
    await updateBlip(lucas, request.id, { status: 'scheduled' });
    await getDb().execute(sql`
      UPDATE integration_deliveries SET attempts = ${MAX_DELIVERY_ATTEMPTS - 1}
       WHERE integration_id = ${own.id}::uuid`);
    vi.mocked(publicRequest).mockImplementationOnce(async () => {
      await pauseIntegrationDelivery(lucas, own.id);
      return { status: 503, headers: {}, body: '' };
    });
    await drain();
    const told = await getDb()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, lucas.user.id),
          eq(schema.notifications.subject, 'paused mid-flight'),
        ),
      );
    expect(told).toEqual([]);
    expect((await listIntegrationDeliveries(lucas, own.id)).delivery?.pending).toBe(1);
  });

  it('resumes oldest first, by hand or after a test ping that is answered', async () => {
    const own = await withReceiver('resumable');
    const request = await newRequest(own.radar, own.token);
    await pauseIntegrationDelivery(agentOf(lucas), own.id);
    for (const status of ['scheduled', 'in-progress', 'resolved'])
      await updateBlip(lucas, request.id, { status });
    await drain();
    expect(sent().filter((c) => c.payload.integrationId === own.id)).toEqual([]);
    const queued = (await since('0', own.id)).map((r) => r.seq);
    expect(queued).toHaveLength(3);

    // A failing test leaves it paused; an answered one resumes and sends the buffer.
    vi.mocked(publicRequest).mockResolvedValueOnce({ status: 500, headers: {}, body: '' });
    await testIntegrationDelivery(lucas, own.id);
    await drain();
    let [row] = await getDb()
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, own.id));
    expect(row?.deliveryPausedAt).not.toBeNull();
    await testIntegrationDelivery(lucas, own.id);
    await drain();
    [row] = await getDb()
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, own.id));
    expect(row?.deliveryPausedAt).toBeNull();
    const events = sent()
      .filter((c) => c.payload.integrationId === own.id)
      .map((c) => c.payload.event);
    expect(events).toEqual([
      'integration.test',
      'integration.test',
      'request.status_changed',
      'request.status_changed',
      'request.status_changed',
    ]);
    const pushedIds = sent()
      .filter(
        (c) => c.payload.event === 'request.status_changed' && c.payload.integrationId === own.id,
      )
      .map((c) => c.payload.id);
    const loggedIds = (
      await getDb().execute<{ id: string }>(
        sql`SELECT id FROM integration_events WHERE integration_id = ${own.id}::uuid AND event = 'request.status_changed' ORDER BY xid, seq`,
      )
    ).rows.map((r) => r.id);
    expect(pushedIds).toEqual(loggedIds);

    // By hand: pause, queue, resume.
    vi.mocked(publicRequest).mockClear();
    await pauseIntegrationDelivery(lucas, own.id);
    await updateBlip(lucas, request.id, { status: 'declined' });
    await drain();
    expect(sent()).toEqual([]);
    await resumeIntegrationDelivery(lucas, own.id);
    await drain();
    expect(sent().map((c) => c.payload.event)).toEqual(['request.status_changed']);
  });

  it('keeps receiver, secret, resume and test human-only; an agent may pause and read the history', async () => {
    const own = await withReceiver('guarded');
    const agent = agentOf(lucas);
    const said = async (p: Promise<unknown>) => (await refusal(p)).message;
    expect(await said(setIntegrationDelivery(agent, own.id, 'https://evil.example/x'))).toContain(
      'signed-in browser',
    );
    expect(await said(setIntegrationDelivery(agent, own.id, null))).toContain('signed-in browser');
    expect(await said(rotateIntegrationDeliverySecret(agent, own.id))).toContain(
      'signed-in browser',
    );
    expect(await said(resumeIntegrationDelivery(agent, own.id))).toContain('An agent may pause it');
    expect(await said(testIntegrationDelivery(agent, own.id))).toContain('An agent may pause it');
    await pauseIntegrationDelivery(agent, own.id);
    expect((await listIntegrationDeliveries(agent, own.id)).delivery?.pausedAt).not.toBeNull();
    // A read-only connection may read the history, not pause; the portal's own
    // credential may do neither.
    const reader: Actor = { ...lucas, kind: 'agent', ceiling: 'viewer', tokenId: 'reader' };
    await listIntegrationDeliveries(reader, own.id);
    expect((await refusal(pauseIntegrationDelivery(reader, own.id))).message).toContain(
      'radars:write',
    );
    const portalActor: Actor = {
      ...lucas,
      kind: 'integration',
      integrationId: own.id,
      ceiling: 'editor',
    };
    expect((await refusal(listIntegrationDeliveries(portalActor, own.id))).message).toContain(
      'integration credential',
    );
    expect((await refusal(pauseIntegrationDelivery(portalActor, own.id))).message).toContain(
      'integration credential',
    );
    // One test on its way at a time.
    await testIntegrationDelivery(lucas, own.id);
    expect((await refusal(testIntegrationDelivery(lucas, own.id))).message).toContain(
      'already on its way',
    );
    await drain();
    // Over MCP too, as the same service.
    const server = buildMcpServer(agent);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: 'events-test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.callTool({
        name: 'list_integrations',
        arguments: { integrationId: own.id },
      });
      const text = (listed.content as Array<{ text: string }>)[0]?.text ?? '';
      expect((JSON.parse(text) as IntegrationDeliveriesDto).delivery?.url).toBe(
        'https://portal.example/omr',
      );
      const paused = await client.callTool({
        name: 'pause_integration_delivery',
        arguments: { integrationId: own.id },
      });
      expect(paused.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    // Someone else's integration is a 404 to read or pause.
    const stranger = await makeUser('ev-stranger');
    expect((await refusal(listIntegrationDeliveries(stranger, own.id))).status).toBe(404);
    expect((await refusal(pauseIntegrationDelivery(stranger, own.id))).status).toBe(404);
  });

  it('sets the receiver only to a public https URL, keeps the secret on a URL change, and rotates it on request', async () => {
    const minted = await createIntegration(lucas, { name: 'receiver rules' });
    vi.mocked(vetPublicUrl).mockRejectedValueOnce(new UnsafeOutboundUrlError('private address'));
    expect(
      (await refusal(setIntegrationDelivery(lucas, minted.id, 'https://10.0.0.1/x'))).status,
    ).toBe(400);
    const put = (url: unknown) =>
      app.request(`/api/integrations/${minted.id}/delivery`, {
        method: 'PUT',
        headers: {
          cookie: lucasCookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ url }),
      });
    expect((await put('http://portal.example/omr')).status).toBe(400);
    expect((await put('https://portal.example/a\u0000b')).status).toBe(400);
    const first = await put('https://portal.example/omr');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { integration: IntegrationDto };
    expect(firstBody.integration.deliverySecret).toMatch(/^omr_whsec_/);
    expect(firstBody.integration.delivery?.url).toBe('https://portal.example/omr');
    const moved = (await (await put('https://portal.example/v2')).json()) as {
      integration: IntegrationDto;
    };
    expect(moved.integration.deliverySecret).toBeUndefined();
    const [row] = await getDb()
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, minted.id));
    expect(decryptSubscriptionSecret(row?.deliverySecretCiphertext ?? '')).toBe(
      firstBody.integration.deliverySecret,
    );
    const { secret } = await rotateIntegrationDeliverySecret(lucas, minted.id);
    expect(secret).not.toBe(firstBody.integration.deliverySecret);
  });

  it('removing the receiver drops the queue, and the log stays for pull', async () => {
    const own = await withReceiver('removable');
    const request = await newRequest(own.radar, own.token);
    await pauseIntegrationDelivery(lucas, own.id);
    await updateBlip(lucas, request.id, { status: 'resolved' });
    expect((await listIntegrationDeliveries(lucas, own.id)).delivery?.pending).toBe(1);
    await setIntegrationDelivery(lucas, own.id, null);
    const queued = await getDb()
      .select()
      .from(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.integrationId, own.id));
    expect(queued).toEqual([]);
    expect((await listIntegrationDeliveries(lucas, own.id)).delivery).toBeNull();
    const page = await pullUntil(
      null,
      (items) => items.some((i) => i.requestId === request.id),
      own.token,
    );
    expect(page.items.some((i) => i.event === 'request.status_changed')).toBe(true);
    // And with no receiver, events are logged but never queued.
    await updateBlip(lucas, request.id, { status: 'declined' });
    expect(
      await getDb()
        .select()
        .from(schema.integrationDeliveries)
        .where(eq(schema.integrationDeliveries.integrationId, own.id)),
    ).toEqual([]);
  });

  it('pushes nothing for a revoked integration or a suspended owner, and re-checks reach on the way out', async () => {
    const own = await withReceiver('rechecked');
    const request = await newRequest(own.radar, own.token);
    await pauseIntegrationDelivery(lucas, own.id);
    await createComment(lucas, request.id, { body: 'Hi', visibility: 'client' });
    await unenrolRadar(lucas, own.id, own.radar);
    await resumeIntegrationDelivery(lucas, own.id);
    await drain();
    // Queued as a reply; delivered as what it now is.
    expect(
      sent()
        .filter((c) => c.payload.integrationId === own.id)
        .map((c) => [c.payload.event, c.payload.replyId]),
    ).toEqual([
      ['request.removed', null],
      ['request.removed', null],
    ]);

    const owner = await makeUser('ev-suspended');
    const minted = await createIntegration(owner, { name: 'suspended owner' });
    await setIntegrationDelivery(owner, minted.id, 'https://portal.example/omr');
    const radar = await newHelpdesk('Helpdesk · Suspended', owner);
    await enrolRadar(owner, minted.id, { radarId: radar });
    const theirs = await newRequest(radar, minted.token ?? '');
    await pauseIntegrationDelivery(owner, minted.id);
    await updateBlip(owner, theirs.id, { status: 'resolved' });
    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.id, owner.user.id));
    await getDb()
      .update(schema.integrations)
      .set({ deliveryPausedAt: null })
      .where(eq(schema.integrations.id, minted.id));
    vi.mocked(publicRequest).mockClear();
    await drain();
    expect(sent()).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(schema.integrationDeliveries)
        .where(eq(schema.integrationDeliveries.integrationId, minted.id)),
    ).toEqual([]);

    const revoked = await withReceiver('revoked receiver');
    const r = await newRequest(revoked.radar, revoked.token);
    await pauseIntegrationDelivery(lucas, revoked.id);
    await updateBlip(lucas, r.id, { status: 'resolved' });
    await revokeIntegration(lucas, revoked.id);
    await getDb()
      .update(schema.integrations)
      .set({ deliveryPausedAt: null })
      .where(eq(schema.integrations.id, revoked.id));
    await drain();
    expect(sent()).toEqual([]);
  });

  it('lists every event kind the contract names, and nothing else', () => {
    expect([...HELPDESK_EVENT_KINDS].sort()).toEqual(
      [
        'integration.test',
        'request.removed',
        'request.reply',
        'request.reply_retracted',
        'request.status_changed',
      ].sort(),
    );
  });
});

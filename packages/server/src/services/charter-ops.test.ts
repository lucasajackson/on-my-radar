/**
 * Charter slices S3 and S4 against a real Postgres, REST and MCP over real HTTP: `edit_charter`
 * (exact-text edits), the save rate limit, the notice to an ADR's author, `reanchor` (and its
 * `dismiss`), and what every architecture write now takes (a `session`, an
 * `idempotencyKey`). Skipped without DATABASE_URL, apart from the pure edit function.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TOKEN_SCOPES, type EditCharterResult } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { httpTransport } from '../mcp/test-client.js';
import {
  decideAdr,
  dismiss,
  editCharter,
  proposeAdr,
  readArchitecture,
  reanchor,
  upsertBoundary,
  upsertContract,
  writeCharter,
} from './architecture.js';
import { applyEdits } from './charter-ops.js';
import { deleteBlip, updateBlip } from './blips.js';
import { drainDue } from './outbox.js';
import { createRadar, shareRadar } from './radars.js';
import { createRepoAgent } from './repo-agents.js';
import { resetTokenBucketsForTesting } from './token-bucket.js';

const TEXT = [
  '# Charter',
  '',
  '## Billing',
  '',
  'Commander holds all billing truth for plans.',
  '',
  '## Hosting',
  '',
  'Sites run on Kubernetes. Sites are deployed by GitOps.',
  '',
  '## Operations',
  '',
  'Runbooks name an owner.',
].join('\n');

describe('applyEdits', () => {
  it('splices every edit from the text as it stands, in any order', () => {
    const out = applyEdits(
      TEXT,
      [
        { find: 'Runbooks name an owner.', replace: 'Runbooks name two owners.' },
        { find: 'billing truth', replace: 'payment truth' },
      ],
      3,
    );
    expect(out).toContain('holds all payment truth for plans.');
    expect(out).toContain('Runbooks name two owners.');
    expect(out.length).toBe(TEXT.length + 2);
  });

  it('refuses a find that is missing, repeated, overlapping, or only in an earlier edit’s result', () => {
    const conflict = (edits: Array<{ find: string; replace: string }>) => {
      try {
        applyEdits(TEXT, edits, 7);
      } catch (error) {
        return error as { code: string; fields: { edit: string; revision: string } };
      }
      throw new Error('expected a conflict');
    };
    expect(conflict([{ find: 'nowhere', replace: 'x' }])).toMatchObject({
      code: 'charter_conflict',
      fields: { edit: '1', revision: '7' },
    });
    expect(conflict([{ find: 'Sites ', replace: 'x' }]).fields.edit).toBe('1');
    expect(
      conflict([
        { find: 'billing truth', replace: 'x' },
        { find: 'truth for plans', replace: 'y' },
      ]).fields.edit,
    ).toBe('2');
    expect(
      conflict([
        { find: 'billing truth', replace: 'payment truth' },
        { find: 'payment truth', replace: 'z' },
      ]).fields.edit,
    ).toBe('2');
    // The same text twice is an overlap with itself.
    expect(
      conflict([
        { find: 'Runbooks', replace: 'a' },
        { find: 'Runbooks', replace: 'b' },
      ]).fields.edit,
    ).toBe('2');
  });

  it('refuses a result past the document limit', () => {
    expect(() => applyEdits('x', [{ find: 'x', replace: 'y'.repeat(400_001) }], 1)).toThrow(
      /400000/,
    );
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('charter S3 and S4 (real postgres)', () => {
  const database = `omr_charter_ops_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let databaseUrl = '';
  let listener: ReturnType<typeof serve> | undefined;
  let origin = '';
  const clients: Client[] = [];
  let owner: Actor;
  let editor: Actor;
  let reader: Actor;
  let stranger: Actor;
  let ownerToken = '';
  let mcp: Client;

  const mint = async (actor: Actor, scope = TOKEN_SCOPES.join(' ')) => {
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_charter_ops_test',
        userId: actor.user.id,
        scope,
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    return access;
  };
  const user = async (label: string): Promise<Actor> => {
    const [row] = await getDb()
      .insert(schema.users)
      .values({ email: `${label}@charter-ops.test`, state: 'active', name: label })
      .returning();
    return { user: must(row), kind: 'user' };
  };
  const rest = (
    path: string,
    token: string,
    body?: unknown,
    options: { method?: string; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${origin}/api${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    return { error: result.isError === true, text, json: () => JSON.parse(text) as unknown };
  };
  const tool = (name: string, args: Record<string, unknown>) => call(mcp, name, args);
  const connect = async (token: string) => {
    const client = new Client({ name: 'charter-ops', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  /** A new Architecture radar holding TEXT, shared with an editor and a reader. */
  const fresh = async (text = TEXT) => {
    const radar = await createRadar(owner, {
      name: `Ops ${Math.random()}`,
      template: 'architecture',
    });
    await shareRadar(owner, radar.id, editor.user.email, 'editor');
    await shareRadar(owner, radar.id, reader.user.email, 'viewer');
    const read = await readArchitecture(owner, radar.id, { view: 'written' });
    await writeCharter(owner, radar.id, { markdown: text, baseRevision: read.revision ?? 0 });
    return radar.id;
  };
  const head = async (id: string) => {
    const read = await readArchitecture(owner, id, { view: 'written' });
    return { text: read.charter[0]?.markdown ?? '', revision: read.revision ?? 0, read };
  };
  const versions = async (id: string) =>
    (
      await getDb()
        .select()
        .from(schema.charterVersions)
        .where(eq(schema.charterVersions.radarId, id))
        .orderBy(schema.charterVersions.version)
    ).map((v) => ({ version: v.version, cause: v.cause, note: v.note }));
  const anchorOf = async (adrId: string) =>
    must(
      (
        await getDb()
          .select()
          .from(schema.charterAnchors)
          .where(eq(schema.charterAnchors.subjectId, adrId))
      )[0],
    );
  const events = async (anchorId: string) =>
    (
      await getDb()
        .select()
        .from(schema.charterAnchorEvents)
        .where(eq(schema.charterAnchorEvents.anchorId, anchorId))
        .orderBy(schema.charterAnchorEvents.createdAt)
    ).map((e) => e.kind);
  const propose = (id: string, quote: string, withText: string, actor: Actor = owner) =>
    proposeAdr(actor, id, {
      title: `Change ${quote}`,
      rationale: 'r',
      anchors: [{ quote, with: withText }],
    });
  const notices = async (actor: Actor) => {
    await drainDue(50);
    return getDb()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, actor.user.id),
          eq(schema.notifications.kind, 'charter_orphaned'),
        ),
      );
  };

  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'charter-ops-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    owner = await user('owner');
    editor = await user('editor');
    reader = await user('reader');
    stranger = await user('stranger');
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    origin = `http://127.0.0.1:${address.port}`;
    ownerToken = await mint(owner);
    mcp = await connect(ownerToken);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    const open = listener;
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    await closeDb();
    setEnvForTesting(null);
    if (admin) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  /* ------------------------------- edit_charter ------------------------------- */

  describe('edit_charter', () => {
    it('applies several edits at once and answers with a summary, never the text', async () => {
      const id = await fresh();
      const before = await head(id);
      const out = await editCharter(owner, id, {
        edits: [
          { find: 'Runbooks name an owner.', replace: 'Runbooks name two owners.' },
          { find: 'deployed by GitOps', replace: 'deployed by Fleet' },
        ],
        baseRevision: before.revision,
        note: 'tighten',
      });
      expect(out).toMatchObject({
        applied: 2,
        changed: true,
        revision: before.revision + 1,
        orphaned: [],
        healed: [],
        moved: [],
      });
      expect(out.rebased).toBeUndefined();
      expect(JSON.stringify(out).length).toBeLessThan(400);
      expect(out.chars).toBe((await head(id)).text.length);
      const after = await head(id);
      expect(after.text).toContain('Runbooks name two owners.');
      expect(after.text).toContain('deployed by Fleet');
      expect((await versions(id)).at(-1)).toMatchObject({ cause: 'edit', note: 'tighten' });
    });

    it('applies all of its edits or none: a miss changes nothing and names the edit and the revision', async () => {
      const id = await fresh();
      const before = await head(id);
      const versionsBefore = await versions(id);
      await expect(
        editCharter(owner, id, {
          edits: [
            { find: 'Runbooks name an owner.', replace: 'changed' },
            { find: 'this is not there', replace: 'x' },
          ],
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'charter_conflict',
        fields: { edit: '2', revision: String(before.revision) },
      });
      expect(await head(id)).toMatchObject({ text: before.text, revision: before.revision });
      expect(await versions(id)).toEqual(versionsBefore);
    });

    it('merges a writer who was behind: edits to different passages both land, the same passage conflicts', async () => {
      const id = await fresh();
      const base = (await head(id)).revision;
      // Somebody else changes Hosting after we read.
      await editCharter(editor, id, {
        edits: [{ find: 'Sites run on Kubernetes.', replace: 'Sites run on Rancher.' }],
        baseRevision: base,
      });
      const mine = await editCharter(owner, id, {
        edits: [{ find: 'Runbooks name an owner.', replace: 'Runbooks name two owners.' }],
        baseRevision: base,
      });
      expect(mine).toMatchObject({ applied: 1, rebased: true });
      const merged = (await head(id)).text;
      expect(merged).toContain('Sites run on Rancher.');
      expect(merged).toContain('Runbooks name two owners.');
      // The passage the other writer changed is no longer there to find.
      await expect(
        editCharter(owner, id, {
          edits: [{ find: 'Sites run on Kubernetes.', replace: 'Sites run on Nomad.' }],
          baseRevision: base,
        }),
      ).rejects.toMatchObject({ code: 'charter_conflict' });
    });

    it('answers like write_charter about amendments: orphaned, then healed by saying the words back', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const orphaning = await editCharter(owner, id, {
        edits: [{ find: 'all billing truth', replace: 'all of billing' }],
      });
      expect(orphaning.orphaned).toEqual([
        expect.objectContaining({
          kind: 'amend',
          subject: expect.objectContaining({ id: adr.id, label: 'ADR-0001' }) as unknown,
          quote: 'all billing truth',
          cause: 'text_changed',
        }),
      ]);
      await expect(decideAdr(owner, adr.id, { decision: 'accept' })).rejects.toMatchObject({
        code: 'adr_orphaned',
      });
      const healed = await editCharter(owner, id, {
        edits: [{ find: 'all of billing', replace: 'all billing truth' }],
      });
      expect(healed.healed.map((h) => h.subject.id)).toEqual([adr.id]);
      expect((await decideAdr(owner, adr.id, { decision: 'accept' })).adr.lane).toBe('accepted');
    });

    it('with checkpoint false saves the working text without a version', async () => {
      const id = await fresh();
      const sealed = (await versions(id)).length;
      const out = await editCharter(owner, id, {
        edits: [{ find: 'Runbooks name an owner.', replace: 'Runbooks name an owner today.' }],
        checkpoint: false,
      });
      expect(out.changed).toBe(true);
      expect((await versions(id)).length).toBe(sealed);
    });

    it('is a write: a viewer is refused, a stranger gets a 404, and it is on REST and MCP', async () => {
      const id = await fresh();
      const edits = [{ find: 'Runbooks name an owner.', replace: 'Runbooks name us.' }];
      await expect(editCharter(reader, id, { edits })).rejects.toMatchObject({ status: 403 });
      await expect(editCharter(stranger, id, { edits })).rejects.toMatchObject({ status: 404 });

      const viaRest = await rest(`/radars/${id}/charter/edits`, ownerToken, { edits });
      expect(viaRest.status).toBe(200);
      expect((await viaRest.json()) as EditCharterResult).toMatchObject({ applied: 1 });
      const viaMcp = await tool('edit_charter', {
        radarId: id,
        edits: [{ find: 'Runbooks name us.', replace: 'Runbooks name them.' }],
      });
      expect(viaMcp.error, viaMcp.text).toBe(false);
      expect(viaMcp.json()).toMatchObject({ applied: 1, changed: true });
      const conflict = await rest(`/radars/${id}/charter/edits`, ownerToken, {
        edits: [{ find: 'nope', replace: 'x' }],
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'charter_conflict' } });

      const readOnly = await connect(await mint(owner, 'radars:read'));
      expect((await call(readOnly, 'edit_charter', { radarId: id, edits })).error).toBe(true);
      const token = await mint(owner, 'radars:read');
      expect((await rest(`/radars/${id}/charter/edits`, token, { edits })).status).toBe(403);
      expect(
        (await rest(`/radars/${id}/charter/edits`, await mint(stranger), { edits })).status,
      ).toBe(404);
    });
  });

  /* --------------------------- session and idempotency -------------------------- */

  describe('session and idempotencyKey on the architecture writes', () => {
    it('numbers ADRs with four digits, and a retry with the same key is the same ADR', async () => {
      const id = await fresh();
      const input = {
        title: 'Plans live in Commander',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'payment truth only' }],
        idempotencyKey: 'propose-1',
      };
      const first = await proposeAdr(owner, id, input);
      const again = await proposeAdr(owner, id, input);
      expect(first.adr.label).toBe('ADR-0001');
      expect(again.adr.id).toBe(first.adr.id);
      const adrs = (await readArchitecture(owner, id, { view: 'written' })).adrs;
      expect(adrs.map((a) => a.label)).toEqual(['ADR-0001']);
      // One ADR, one anchor, one version for it.
      expect(
        await getDb()
          .select()
          .from(schema.charterAnchors)
          .where(eq(schema.charterAnchors.radarId, id)),
      ).toHaveLength(1);
      // The next one carries on from it.
      expect((await propose(id, 'Sites run on Kubernetes', 'x')).adr.label).toBe('ADR-0002');
    });

    it('refuses the same key with other arguments, even when only the anchors differ', async () => {
      const id = await fresh();
      const key = 'same-key';
      await proposeAdr(owner, id, {
        title: 'One',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'a' }],
        idempotencyKey: key,
      });
      await expect(
        proposeAdr(owner, id, {
          title: 'One',
          rationale: 'r',
          anchors: [{ quote: 'Runbooks name an owner.', with: 'b' }],
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await readArchitecture(owner, id, { view: 'written' })).adrs).toHaveLength(1);
    });

    it('does not let a key spent by create_blip stand in for an ADR, or the reverse', async () => {
      const id = await fresh();
      const { createBlip } = await import('./blips.js');
      await createBlip(owner, id, { body: 'a note', idempotencyKey: 'shared' });
      await expect(
        proposeAdr(owner, id, {
          title: 'ADR',
          rationale: 'r',
          anchors: [],
          idempotencyKey: 'shared',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('two concurrent proposals with one key make one ADR', async () => {
      const id = await fresh();
      const input = {
        title: 'Concurrent',
        rationale: 'r',
        anchors: [],
        idempotencyKey: 'race',
      };
      const results = await Promise.all([
        proposeAdr(owner, id, input),
        proposeAdr(owner, id, input),
        proposeAdr(owner, id, input),
      ]);
      expect(new Set(results.map((r) => r.adr.id)).size).toBe(1);
      expect((await readArchitecture(owner, id, { view: 'written' })).adrs).toHaveLength(1);
    });

    it('lets a retried edit_charter or write_charter succeed instead of failing against its own write', async () => {
      const id = await fresh();
      const base = (await head(id)).revision;
      const input = {
        edits: [{ find: 'Runbooks name an owner.', replace: 'Runbooks name an owner. Twice.' }],
        baseRevision: base,
        idempotencyKey: 'edit-once',
      };
      const first = await editCharter(owner, id, input);
      const retry = await editCharter(owner, id, input);
      // Applied once: the replacement contains the find, so a second application would repeat it.
      expect((await head(id)).text.match(/Twice\./g)).toHaveLength(1);
      expect(retry).toMatchObject({ replayed: true, revision: first.revision, changed: false });
      const rev = (await head(id)).revision;
      const whole = { markdown: 'x', baseRevision: rev, idempotencyKey: 'write-once' };
      expect(await writeCharter(owner, id, whole)).toMatchObject({ changed: true });
      // Its own retry is now stale by revision; the key turns that into the first call's success.
      expect(await writeCharter(owner, id, whole)).toMatchObject({ replayed: true });
      await expect(writeCharter(owner, id, { ...whole, markdown: 'y' })).rejects.toMatchObject({
        status: 409,
      });
      expect((await head(id)).text).toBe('x');
    });

    it('replays decide_adr and the upserts, and reads the Idempotency-Key header on REST', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const first = await decideAdr(owner, adr.id, { decision: 'accept', idempotencyKey: 'd1' });
      const second = await decideAdr(owner, adr.id, { decision: 'accept', idempotencyKey: 'd1' });
      expect(second.adr.id).toBe(first.adr.id);
      await expect(
        decideAdr(owner, adr.id, { decision: 'reject', idempotencyKey: 'd1' }),
      ).rejects.toMatchObject({ status: 409 });

      const edge = await upsertBoundary(owner, id, { title: 'Edge', idempotencyKey: 'b1' });
      const retry = await upsertBoundary(owner, id, { title: 'Edge', idempotencyKey: 'b1' });
      expect(edge.created).toBe(true);
      expect(retry).toMatchObject({ created: false, boundary: { id: edge.boundary.id } });

      const headers = { 'idempotency-key': 'rest-1' };
      const body = { title: 'ADR over REST', rationale: 'r' };
      const a = await (await rest(`/radars/${id}/adrs`, ownerToken, body, { headers })).json();
      const b = await (await rest(`/radars/${id}/adrs`, ownerToken, body, { headers })).json();
      expect((a as { adr: { id: string } }).adr.id).toBe((b as { adr: { id: string } }).adr.id);
      const c = await tool('propose_adr', { radarId: id, ...body, idempotencyKey: 'mcp-1' });
      const d = await tool('propose_adr', { radarId: id, ...body, idempotencyKey: 'mcp-1' });
      expect((c.json() as { adr: { id: string } }).adr.id).toBe(
        (d.json() as { adr: { id: string } }).adr.id,
      );
    });

    it('writes under the loaded agent’s name when a session is passed, on every architecture tool', async () => {
      const id = await fresh();
      const agent = await createRepoAgent(owner, { name: 'Builder', slug: 'builder', prompt: 'p' });
      const loaded = await mcp.callTool({ name: 'load_agent', arguments: { agent: agent.id } });
      const text = (loaded.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
      const session = must(/"session":\s*"([0-9a-f-]{36})"/.exec(text)?.[1]);
      const proposed = await tool('propose_adr', {
        radarId: id,
        title: 'By the agent',
        rationale: 'r',
        session,
      });
      expect(proposed.error, proposed.text).toBe(false);
      const adrId = (proposed.json() as { adr: { id: string } }).adr.id;
      const row = must(
        (await getDb().select().from(schema.blips).where(eq(schema.blips.id, adrId)))[0],
      );
      expect([row.agentId, row.authorId]).toEqual([agent.id, owner.user.id]);
      for (const [name, args] of [
        [
          'edit_charter',
          { radarId: id, edits: [{ find: 'Billing', replace: 'Billing and plans' }], session },
        ],
        ['write_charter', { radarId: id, markdown: TEXT, baseRevision: 0, session }],
        ['upsert_boundary', { radarId: id, title: 'Agent boundary', session }],
        ['decide_adr', { adrId, decision: 'accept', session }],
      ] as const) {
        const out = await tool(name, args);
        // write_charter at revision 0 is stale by design; the point is the session was accepted.
        expect(out.text, name).not.toMatch(/Unrecognized key|session/i);
      }
      // The boundary the agent wrote is the agent's, cosigned by the person.
      const made = must(
        (
          await getDb()
            .select()
            .from(schema.blips)
            .where(and(eq(schema.blips.radarId, id), eq(schema.blips.title, 'Agent boundary')))
        )[0],
      );
      expect([made.agentId, made.authorId]).toEqual([agent.id, owner.user.id]);
      const bad = await tool('propose_adr', {
        radarId: id,
        title: 'Forged',
        rationale: 'r',
        session: '11111111-1111-4111-8111-111111111111',
      });
      expect(bad.error).toBe(true);
    });
  });

  /* ------------------------------- decide_adr dates ------------------------------ */

  describe('decide_adr decidedAt and decidedBy', () => {
    it('keeps a historical decision’s date and decider, once, and audits it', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const out = await decideAdr(owner, adr.id, {
        decision: 'accept',
        decidedAt: '2026-08-26T00:00:00Z',
        decidedBy: 'Lucas',
      });
      expect(out.adr).toMatchObject({
        lane: 'accepted',
        ratifiedAt: '2026-08-26T00:00:00.000Z',
        decidedBy: 'Lucas',
      });
      const read = await readArchitecture(owner, id, { view: 'written' });
      expect(read.adrs[0]).toMatchObject({
        ratifiedAt: '2026-08-26T00:00:00.000Z',
        decidedBy: 'Lucas',
      });
      const audit = await getDb().execute<{ meta: Record<string, string> }>(
        sql`SELECT meta FROM audit_log WHERE action = 'adr.decide.dated' AND subject_id = ${adr.id}`,
      );
      expect(audit.rows[0]?.meta).toMatchObject({
        decidedAt: '2026-08-26T00:00:00.000Z',
        decidedBy: 'Lucas',
      });
      // Set once.
      await expect(
        decideAdr(owner, adr.id, { decision: 'accept', decidedAt: '2026-08-27T00:00:00Z' }),
      ).rejects.toMatchObject({ code: 'already_ratified' });
    });

    it('refuses a future date, a date before 2000, and a date on anything but accept', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await expect(
        decideAdr(owner, adr.id, { decision: 'accept', decidedAt: future }),
      ).rejects.toMatchObject({ code: 'decided_in_future' });
      await expect(
        decideAdr(owner, adr.id, { decision: 'accept', decidedAt: '1999-12-31T00:00:00Z' }),
      ).rejects.toMatchObject({ code: 'decided_too_early' });
      await expect(
        decideAdr(owner, adr.id, { decision: 'reject', decidedAt: '2026-08-26T00:00:00Z' }),
      ).rejects.toMatchObject({ code: 'decided_needs_accept' });
      // Nothing was decided by those.
      expect((await readArchitecture(owner, id, { view: 'written' })).adrs[0]?.lane).toBe(
        'proposed',
      );
      expect(
        (
          await tool('decide_adr', {
            adrId: adr.id,
            decision: 'accept',
            decidedAt: '2026-08-26T00:00:00Z',
          })
        ).error,
      ).toBe(false);
    });
  });

  /* ------------------------------ limits and notices ----------------------------- */

  describe('saves are limited, and an orphaning save tells the ADR’s author', () => {
    it('refuses a writer who saves faster than the budget with a 429 and when to retry', async () => {
      const id = await fresh();
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: process.env['DATABASE_URL'] ?? '',
          SESSION_SECRET: 'charter-ops-test-secret-not-used-anywhere',
          PUBLIC_URL: 'http://localhost:3500',
          RATE_LIMIT_ENABLED: 'true',
          RATE_LIMIT_LEASE: '1',
          CHARTER_SAVE_PER_MINUTE: '60',
          CHARTER_SAVE_BURST: '3',
          CHARTER_SEAL_PER_MINUTE: '60',
          CHARTER_SEAL_BURST: '2',
        }),
      );
      resetTokenBucketsForTesting();
      try {
        let n = 0;
        const save = () =>
          editCharter(owner, id, {
            edits: [
              { find: 'Runbooks name an owner.', replace: `Runbooks name an owner. ${(n += 1)}` },
            ],
            checkpoint: false,
          });
        // The URL of the scratch database is what the app already uses; the limiter is the point.
        await save();
        await save();
        await save();
        await expect(save()).rejects.toMatchObject({ status: 429 });
        // Over REST the writer is the connection, with a budget of its own; the same refusal comes
        // with the time to wait.
        const viaRest = async (to: string) =>
          rest(`/radars/${id}/charter/edits`, ownerToken, {
            edits: [{ find: 'Hosting', replace: to }],
            checkpoint: false,
          });
        expect((await viaRest('Hosting')).status).toBe(200);
        expect((await viaRest('Hosting')).status).toBe(200);
        expect((await viaRest('Hosting')).status).toBe(200);
        const refused = await viaRest('Hosting');
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
        // A sealing save draws on the smaller budget, per writer: the editor is not held up by it.
        resetTokenBucketsForTesting();
        await editCharter(editor, id, {
          edits: [{ find: 'Hosting', replace: 'Hosting and runtime' }],
        });
        await editCharter(editor, id, {
          edits: [{ find: 'Hosting and runtime', replace: 'Hosting' }],
        });
        await expect(
          editCharter(editor, id, { edits: [{ find: 'Hosting', replace: 'Runtime' }] }),
        ).rejects.toMatchObject({ status: 429 });
        // Nothing was changed by the refused saves.
        expect((await head(id)).text).toContain('## Hosting');
      } finally {
        setEnvForTesting(
          loadEnv({
            ...process.env,
            DATABASE_URL: process.env['DATABASE_URL'] ?? '',
            SESSION_SECRET: 'charter-ops-test-secret-not-used-anywhere',
            PUBLIC_URL: 'http://localhost:3500',
          }),
        );
        resetTokenBucketsForTesting();
      }
    });

    it('tells the ADR’s author once per save, never the person who made it', async () => {
      const id = await fresh();
      const mine = await propose(id, 'all billing truth', 'payment truth only', editor);
      const other = await propose(id, 'Runbooks name an owner.', 'Runbooks name nobody.', editor);
      // The owner saves; the editor wrote both ADRs and is told, once, for the save.
      await editCharter(owner, id, {
        edits: [
          { find: 'all billing truth', replace: 'all of billing' },
          { find: 'Runbooks name an owner.', replace: 'Runbooks exist.' },
        ],
      });
      const told = await notices(editor);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ kind: 'charter_orphaned', count: 1 });
      expect((await notices(owner)).length).toBe(0);
      expect([mine.adr.id, other.adr.id]).toContain(told[0]?.blipId);
      // The editor's own save that orphans their own ADR tells nobody.
      const before = (await notices(editor))[0];
      await editCharter(editor, id, {
        edits: [{ find: 'Sites run on Kubernetes.', replace: 'Sites run.' }],
      });
      expect((await notices(editor))[0]?.count).toBe(before?.count);
    });

    it('does not tell anyone about an ADR that is rejected, or an amendment that is healed before the notice runs', async () => {
      const id = await fresh();
      const kept = await propose(id, 'all billing truth', 'payment truth only', editor);
      const rejected = await propose(id, 'Runbooks name an owner.', 'x', editor);
      await decideAdr(owner, rejected.adr.id, { decision: 'reject' });
      await editCharter(owner, id, {
        edits: [
          { find: 'all billing truth', replace: 'all of billing' },
          { find: 'Runbooks name an owner.', replace: 'Runbooks exist.' },
        ],
      });
      // Healed before the worker runs.
      await editCharter(owner, id, {
        edits: [{ find: 'all of billing', replace: 'all billing truth' }],
      });
      expect(kept.adr.id).toBeTruthy();
      const counts = (await notices(editor)).filter((n) => n.radarId === id);
      expect(counts).toHaveLength(0);
    });
  });

  /* ---------------------------- reanchor and dismiss ----------------------------- */

  describe('reanchor and dismiss (reanchor with dismiss)', () => {
    const orphan = async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      await editCharter(owner, id, {
        edits: [
          {
            find: 'Commander holds all billing truth for plans.',
            replace: 'Commander holds every ledger and all payment records for plans.',
          },
        ],
      });
      const anchor = await anchorOf(adr.id);
      expect(anchor.state).toBe('orphaned');
      return { id, adr, anchor };
    };

    it('re-anchors an orphan to new words, clears the state, and keeps its history', async () => {
      const { id, adr, anchor } = await orphan();
      const out = await reanchor(owner, anchor.id, { quote: 'all payment records' });
      expect(out).toMatchObject({
        anchorId: anchor.id,
        kind: 'amend',
        state: 'anchored',
        quote: 'all payment records',
        was: { state: 'orphaned', quote: 'all billing truth' },
        subject: { id: adr.id, label: 'ADR-0001', lane: 'proposed' },
      });
      const after = await anchorOf(adr.id);
      expect(after).toMatchObject({
        state: 'anchored',
        orphanCause: null,
        orphanedVersion: null,
        quote: 'all payment records',
        resolvedVersion: out.version,
      });
      expect(await events(anchor.id)).toEqual(['created', 'orphaned', 'reanchored']);
      const event = await getDb()
        .select()
        .from(schema.charterAnchorEvents)
        .where(
          and(
            eq(schema.charterAnchorEvents.anchorId, anchor.id),
            eq(schema.charterAnchorEvents.kind, 'reanchored'),
          ),
        );
      expect(event[0]?.detail).toMatchObject({
        from: { state: 'orphaned', quote: 'all billing truth' },
        to: { quote: 'all payment records' },
      });
      expect((await versions(id)).at(-1)).toMatchObject({ version: out.version, cause: 'anchor' });
      // The earlier version still records where it stood and the old quote's text.
      const read = await readArchitecture(owner, id, { view: 'written' });
      expect(read.orphans).toBeUndefined();
      const audit = await getDb().execute(
        sql`SELECT 1 FROM audit_log WHERE action = 'charter.reanchor' AND subject_id = ${anchor.id}`,
      );
      expect(audit.rows).toHaveLength(1);
      // Accept is open again, and the amended text shows.
      await decideAdr(owner, adr.id, { decision: 'accept' });
      const amended = await readArchitecture(owner, id, { view: 'amended' });
      expect(amended.charter[0]?.markdown).toContain('payment truth only');
    });

    it('refuses what proposing would: not there, recurring, across blocks, in code, in a live amendment', async () => {
      const { id, anchor } = await orphan();
      const trial = (quote: string, extra: Record<string, string> = {}) =>
        reanchor(owner, anchor.id, { quote, ...extra });
      await expect(trial('words that are not there')).rejects.toMatchObject({
        code: 'quote_not_found',
      });
      await expect(trial('Sites')).rejects.toMatchObject({ code: 'quote_ambiguous' });
      await expect(trial('Hosting Sites run')).rejects.toMatchObject({
        code: expect.stringMatching(/quote_(not_found|spans_blocks)/) as unknown,
      });
      // A live amendment already holds "Runbooks name an owner".
      await propose(id, 'Runbooks name an owner', 'Runbooks name nobody');
      await expect(trial('Runbooks name an owner')).rejects.toMatchObject({
        code: 'quote_overlaps',
      });
      // Still orphaned after every refusal.
      expect((await anchorOf(anchor.subjectId)).state).toBe('orphaned');
      // With context, the recurring word is picked.
      const picked = await trial('Sites', { prefix: 'Hosting Sites run on Kubernetes. ' });
      expect(picked.state).toBe('anchored');
    });

    it('moves a placed anchor and revives a dismissed one', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const anchor = await anchorOf(adr.id);
      const moved = await reanchor(owner, anchor.id, { quote: 'Kubernetes' });
      expect(moved).toMatchObject({ state: 'anchored', was: { state: 'anchored' } });
      expect((await anchorOf(adr.id)).quote).toBe('Kubernetes');
      // Narrowing onto words it already holds is not an overlap with another amendment.
      const narrowed = await reanchor(owner, anchor.id, { quote: 'Kubernetes. Sites' });
      expect(narrowed.state).toBe('anchored');
      expect((await anchorOf(adr.id)).quote).toBe('Kubernetes. Sites');
    });

    it('dismisses an orphan: the ADR stands free, can be accepted and deleted-or-kept, and the anchor stays as history', async () => {
      const { id, adr, anchor } = await orphan();
      await expect(decideAdr(owner, adr.id, { decision: 'accept' })).rejects.toMatchObject({
        code: 'adr_orphaned',
      });
      await expect(updateBlip(owner, adr.id, { status: 'accepted' })).rejects.toMatchObject({
        code: 'adr_orphaned',
      });
      const out = await dismiss(owner, anchor.id, { reason: 'superseded by a rewrite' });
      expect(out).toMatchObject({ state: 'dismissed', was: { state: 'orphaned' } });
      const row = await anchorOf(adr.id);
      expect(row).toMatchObject({ state: 'dismissed', orphanCause: null, posStart: null });
      expect(await events(anchor.id)).toEqual(['created', 'orphaned', 'dismissed']);
      const audit = await getDb().execute<{ meta: { reason?: string } }>(
        sql`SELECT meta FROM audit_log WHERE action = 'charter.dismiss' AND subject_id = ${anchor.id}`,
      );
      expect(audit.rows[0]?.meta).toMatchObject({ reason: 'superseded by a rewrite' });
      const read = await readArchitecture(owner, id, { view: 'written' });
      expect(read.orphans).toBeUndefined();
      expect(read.adrs.find((a) => a.id === adr.id)?.anchors).toEqual([]);
      expect((await versions(id)).at(-1)).toMatchObject({ cause: 'anchor' });
      // Free-standing now: accepted without a word of the charter behind it.
      expect((await decideAdr(owner, adr.id, { decision: 'accept' })).adr.lane).toBe('accepted');
      // A second dismiss changes nothing.
      expect((await dismiss(owner, anchor.id, {})).state).toBe('dismissed');
      expect(await events(anchor.id)).toEqual(['created', 'orphaned', 'dismissed']);
    });

    it('does not bring a dismissed anchor back when its words are saved again, and lets the ADR be deleted', async () => {
      const { id, adr, anchor } = await orphan();
      await dismiss(owner, anchor.id, {});
      await editCharter(owner, id, {
        edits: [{ find: 'every ledger and all payment records', replace: 'all billing truth' }],
      });
      expect((await anchorOf(adr.id)).state).toBe('dismissed');
      await deleteBlip(owner, adr.id);
      expect(
        await getDb().select().from(schema.blips).where(eq(schema.blips.id, adr.id)),
      ).toHaveLength(0);
    });

    it('will not dismiss an amendment whose words are still there (reject or repeal the ADR instead)', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const anchor = await anchorOf(adr.id);
      await expect(dismiss(owner, anchor.id, {})).rejects.toMatchObject({
        status: 409,
        code: 'anchor_in_place',
      });
      expect((await anchorOf(adr.id)).state).toBe('anchored');
    });

    it('is a write on the anchor’s own radar: a viewer is refused, a stranger and another radar’s id are 404', async () => {
      const { anchor } = await orphan();
      await expect(reanchor(reader, anchor.id, { quote: 'Kubernetes' })).rejects.toMatchObject({
        status: 403,
      });
      await expect(dismiss(reader, anchor.id, {})).rejects.toMatchObject({ status: 403 });
      await expect(reanchor(stranger, anchor.id, { quote: 'Kubernetes' })).rejects.toMatchObject({
        status: 404,
      });
      await expect(dismiss(stranger, anchor.id, {})).rejects.toMatchObject({ status: 404 });
      await expect(
        reanchor(owner, '11111111-1111-4111-8111-111111111111', { quote: 'Kubernetes' }),
      ).rejects.toMatchObject({ status: 404 });
      expect((await anchorOf(anchor.subjectId)).state).toBe('orphaned');
    });

    it('serves both over REST and MCP, takes a key, and keeps them off a read-only connection', async () => {
      const a = await orphan();
      const viaRest = await rest(`/anchors/${a.anchor.id}/reanchor`, ownerToken, {
        quote: 'all payment records',
      });
      expect(viaRest.status).toBe(200);
      expect(await viaRest.json()).toMatchObject({
        state: 'anchored',
        quote: 'all payment records',
      });

      const b = await orphan();
      const first = await tool('reanchor', {
        anchorId: b.anchor.id,
        dismiss: 'gone',
        idempotencyKey: 'dismiss-1',
      });
      expect(first.error, first.text).toBe(false);
      expect(first.json()).toMatchObject({ state: 'dismissed' });
      const retry = await tool('reanchor', {
        anchorId: b.anchor.id,
        dismiss: 'gone',
        idempotencyKey: 'dismiss-1',
      });
      expect(retry.json()).toMatchObject({ state: 'dismissed', replayed: true });
      expect(await events(b.anchor.id)).toEqual(['created', 'orphaned', 'dismissed']);

      const c = await orphan();
      const keyedA = await rest(
        `/anchors/${c.anchor.id}/reanchor`,
        ownerToken,
        { quote: 'all payment records' },
        { headers: { 'idempotency-key': 'k-1' } },
      );
      const keyedB = await rest(
        `/anchors/${c.anchor.id}/reanchor`,
        ownerToken,
        { quote: 'all payment records' },
        { headers: { 'idempotency-key': 'k-1' } },
      );
      expect([keyedA.status, keyedB.status]).toEqual([200, 200]);
      expect((await keyedB.json()) as { replayed?: boolean }).toMatchObject({ replayed: true });
      expect((await events(c.anchor.id)).filter((k) => k === 'reanchored')).toHaveLength(1);

      const d = await orphan();
      const readOnly = await connect(await mint(owner, 'radars:read'));
      expect(
        (await call(readOnly, 'reanchor', { anchorId: d.anchor.id, quote: 'Kubernetes' })).error,
      ).toBe(true);
      expect((await call(readOnly, 'reanchor', { anchorId: d.anchor.id, dismiss: '' })).error).toBe(
        true,
      );
      const token = await mint(owner, 'radars:read');
      expect(
        (await rest(`/anchors/${d.anchor.id}/reanchor`, token, { quote: 'Kubernetes' })).status,
      ).toBe(403);
      expect((await rest(`/anchors/${d.anchor.id}/dismiss`, token, {})).status).toBe(403);
      expect((await anchorOf(d.anchor.subjectId)).state).toBe('orphaned');
    });
  });

  /* ------------------------------ read narrowing --------------------------------- */

  describe('read_architecture can be narrowed', () => {
    it('returns just the sections asked for, by slug, from the amended text', async () => {
      const id = await fresh();
      const outline = (await readArchitecture(owner, id, { view: 'amended', outline: true }))
        .charter[0];
      expect(outline?.outline?.map((o) => o.slug)).toEqual([
        'charter',
        'billing',
        'hosting',
        'operations',
      ]);
      const read = await readArchitecture(owner, id, {
        view: 'amended',
        sections: ['hosting', 'Operations'],
        include: ['charter'],
      });
      expect(read.charter[0]?.markdown).toBeUndefined();
      expect(read.charter[0]?.sections?.map((s) => s.slug)).toEqual(['hosting', 'operations']);
      expect(read.charter[0]?.sections?.[0]?.markdown).toBe(
        '## Hosting\n\nSites run on Kubernetes. Sites are deployed by GitOps.',
      );
      expect(read.adrs).toEqual([]);
      await expect(
        readArchitecture(owner, id, { view: 'amended', sections: ['nope'] }),
      ).rejects.toMatchObject({ code: 'section_not_found' });
      // Over MCP the list arrives as an array; over REST as a comma-separated string.
      const viaMcp = await tool('read_architecture', { radarId: id, sections: ['billing'] });
      expect(
        (viaMcp.json() as { charter: Array<{ sections: unknown[] }> }).charter[0]?.sections,
      ).toHaveLength(1);
      const viaRest = await rest(
        `/radars/${id}/architecture?sections=billing,hosting&include=charter`,
        ownerToken,
      );
      expect(
        ((await viaRest.json()) as { charter: Array<{ sections: unknown[] }> }).charter[0]
          ?.sections,
      ).toHaveLength(2);
    });

    it('filters ADRs by lane and id, drops owns, and stays small', async () => {
      const id = await fresh();
      const a = await propose(id, 'all billing truth', 'payment truth only');
      const b = await propose(id, 'Runbooks name an owner.', 'x');
      await decideAdr(owner, b.adr.id, { decision: 'accept' });
      await upsertBoundary(owner, id, { title: 'Edge', owns: ['edge.routes', 'edge.cache'] });
      const proposed = await readArchitecture(owner, id, {
        view: 'amended',
        include: ['adrs'],
        lanes: ['proposed'],
      });
      expect(proposed.adrs.map((x) => x.id)).toEqual([a.adr.id]);
      expect(proposed.charter).toEqual([]);
      expect(proposed.boundaries).toEqual([]);
      expect(JSON.stringify(proposed).length).toBeLessThan(2048);
      const one = await readArchitecture(owner, id, {
        view: 'amended',
        adr: [b.adr.id],
        include: ['adrs'],
      });
      expect(one.adrs.map((x) => x.id)).toEqual([b.adr.id]);
      const slim = await readArchitecture(owner, id, {
        view: 'amended',
        include: ['boundaries'],
        owns: false,
      });
      expect(slim.boundaries[0]).not.toHaveProperty('owns');
      const full = await readArchitecture(owner, id, { view: 'amended', include: ['boundaries'] });
      expect(full.boundaries[0]?.owns).toEqual(['edge.routes', 'edge.cache']);
      const viaRest = await rest(
        `/radars/${id}/architecture?include=adrs&lanes=proposed&owns=false`,
        ownerToken,
      );
      expect(((await viaRest.json()) as { adrs: unknown[] }).adrs).toHaveLength(1);
    });
  });

  /* --------------------------- review round 1 findings --------------------------- */

  const withLimits = async (overrides: Record<string, string>, run: () => Promise<void>) => {
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: process.env['DATABASE_URL'] ?? '',
        SESSION_SECRET: 'charter-ops-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_LEASE: '1',
        ...overrides,
      }),
    );
    resetTokenBucketsForTesting();
    try {
      await run();
    } finally {
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: process.env['DATABASE_URL'] ?? '',
          SESSION_SECRET: 'charter-ops-test-secret-not-used-anywhere',
          PUBLIC_URL: 'http://localhost:3500',
        }),
      );
      resetTokenBucketsForTesting();
    }
  };

  describe('review round 1', () => {
    const orphanedAdr = async (quote = 'all billing truth', as: Actor = owner) => {
      const id = await fresh();
      const { adr } = await propose(id, quote, 'payment truth only', as);
      await editCharter(owner, id, { edits: [{ find: quote, replace: 'something else' }] });
      return { id, adr, anchor: await anchorOf(adr.id) };
    };
    it('1: an ADR moved to a private radar takes its dismissed anchors with it; the old radar cannot reactivate them', async () => {
      const { id, adr, anchor } = await orphanedAdr();
      await dismiss(owner, anchor.id, {});
      const privateRadar = (
        await createRadar(owner, { name: `Private ${Math.random()}`, template: 'architecture' })
      ).id;
      await updateBlip(owner, adr.id, { radarId: privateRadar });
      // The anchor and its history now belong to the radar the ADR is on.
      expect((await anchorOf(adr.id)).radarId).toBe(privateRadar);
      const moved = await getDb()
        .select({ radarId: schema.charterAnchorEvents.radarId })
        .from(schema.charterAnchorEvents)
        .where(eq(schema.charterAnchorEvents.anchorId, anchor.id));
      expect(moved.length).toBeGreaterThan(0);
      expect(new Set(moved.map((m) => m.radarId))).toEqual(new Set([privateRadar]));
      // The editor of the original radar cannot touch it, and nothing changed.
      await expect(reanchor(editor, anchor.id, { quote: 'Kubernetes' })).rejects.toMatchObject({
        status: 404,
      });
      await expect(dismiss(editor, anchor.id, {})).rejects.toMatchObject({ status: 404 });
      expect((await anchorOf(adr.id)).state).toBe('dismissed');
      // The original radar's own reads and versions no longer carry it.
      const read = await readArchitecture(owner, id, { view: 'written' });
      expect(read.adrs.find((a) => a.id === adr.id)).toBeUndefined();
      expect(read.orphans).toBeUndefined();
    });

    it('1: whatever the anchor row says, the ADR must still live on the radar the caller was authorised on', async () => {
      const { id, adr, anchor } = await orphanedAdr();
      await dismiss(owner, anchor.id, {});
      const elsewhere = (
        await createRadar(owner, { name: `Elsewhere ${Math.random()}`, template: 'architecture' })
      ).id;
      // A move that did not re-home the anchor (the state a race would leave).
      await getDb().execute(
        sql`UPDATE blips SET radar_id = ${elsewhere}::uuid WHERE id = ${adr.id}::uuid`,
      );
      await expect(reanchor(editor, anchor.id, { quote: 'Kubernetes' })).rejects.toMatchObject({
        status: 404,
      });
      await expect(dismiss(editor, anchor.id, {})).rejects.toMatchObject({ status: 404 });
      expect((await anchorOf(adr.id)).state).toBe('dismissed');
      expect((await anchorOf(adr.id)).radarId).toBe(id);
    });

    it('2: two requests with one key claim it inside the write: one boundary, one contract, one decision', async () => {
      const id = await fresh();
      const [a, b] = await Promise.allSettled([
        upsertBoundary(owner, id, { title: 'Race A', idempotencyKey: 'bkey' }),
        upsertBoundary(owner, id, { title: 'Race B', idempotencyKey: 'bkey' }),
      ]);
      expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
      const loser = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ status: 409 });
      const boundaries = (await readArchitecture(owner, id, { view: 'written' })).boundaries;
      expect(
        boundaries.filter((x) => x.title.startsWith('Race ')).map((x) => x.title),
      ).toHaveLength(1);

      const x = (await upsertBoundary(owner, id, { title: 'Side X' })).boundary.id;
      const y = (await upsertBoundary(owner, id, { title: 'Side Y' })).boundary.id;
      const c = await Promise.allSettled([
        upsertContract(owner, id, { title: 'Contract A', a: x, b: y, idempotencyKey: 'ckey' }),
        upsertContract(owner, id, { title: 'Contract B', a: x, b: y, idempotencyKey: 'ckey' }),
      ]);
      expect(c.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const contracts = (await readArchitecture(owner, id, { view: 'written' })).contracts;
      expect(contracts.filter((k) => k.title.startsWith('Contract ')).length).toBe(1);

      const one = (await propose(id, 'all billing truth', 'p')).adr.id;
      const two = (await propose(id, 'Runbooks name an owner.', 'q')).adr.id;
      const d = await Promise.allSettled([
        decideAdr(owner, one, { decision: 'accept', idempotencyKey: 'dkey' }),
        decideAdr(owner, two, { decision: 'accept', idempotencyKey: 'dkey' }),
      ]);
      expect(d.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const lanes = (await readArchitecture(owner, id, { view: 'written' })).adrs
        .filter((r) => [one, two].includes(r.id))
        .map((r) => r.lane)
        .sort();
      expect(lanes).toEqual(['accepted', 'proposed']);
    });

    it('3: two agents on one connection with one key and one request each get their own ADR', async () => {
      const id = await fresh();
      const sessionOf = async (slug: string) => {
        const agent = await createRepoAgent(owner, { name: slug, slug, prompt: 'p' });
        const loaded = await mcp.callTool({ name: 'load_agent', arguments: { agent: agent.id } });
        const text = (loaded.content as Array<{ text?: string }>)
          .map((b) => b.text ?? '')
          .join('\n');
        return { agent, session: must(/"session":\s*"([0-9a-f-]{36})"/.exec(text)?.[1]) };
      };
      const first = await sessionOf('keyed-one');
      const second = await sessionOf('keyed-two');
      const args = {
        radarId: id,
        title: 'Same request',
        rationale: 'r',
        idempotencyKey: 'request-1',
      };
      const a = await tool('propose_adr', { ...args, session: first.session });
      const b = await tool('propose_adr', { ...args, session: second.session });
      expect(a.error, a.text).toBe(false);
      expect(b.error, b.text).toBe(false);
      const ids = [a, b].map((r) => (r.json() as { adr: { id: string } }).adr.id);
      expect(new Set(ids).size).toBe(2);
      const rows = await getDb().select().from(schema.blips).where(inArray(schema.blips.id, ids));
      expect(new Set(rows.map((r) => r.agentId))).toEqual(
        new Set([first.agent.id, second.agent.id]),
      );
      // Each agent's own retry is still its own ADR.
      const again = await tool('propose_adr', { ...args, session: first.session });
      expect((again.json() as { adr: { id: string } }).adr.id).toBe(ids[0]);
    });

    it('4: a save that did not ask to seal but orphans or heals an amendment draws on the seal budget', async () => {
      const id = await fresh();
      await propose(id, 'all billing truth', 'payment truth only');
      await withLimits(
        {
          CHARTER_SAVE_PER_MINUTE: '600',
          CHARTER_SAVE_BURST: '50',
          CHARTER_SEAL_PER_MINUTE: '60',
          CHARTER_SEAL_BURST: '1',
        },
        async () => {
          const orphaning = await editCharter(owner, id, {
            edits: [{ find: 'all billing truth', replace: 'all of billing' }],
            checkpoint: false,
          });
          expect(orphaning.orphaned).toHaveLength(1);
          const before = await head(id);
          const versionsBefore = await versions(id);
          // The heal seals too, and the seal budget (one) is spent.
          await expect(
            editCharter(owner, id, {
              edits: [{ find: 'all of billing', replace: 'all billing truth' }],
              checkpoint: false,
            }),
          ).rejects.toMatchObject({ status: 429 });
          expect(await head(id)).toMatchObject({ text: before.text, revision: before.revision });
          expect(await versions(id)).toEqual(versionsBefore);
          // A plain working-text save that seals nothing is not held up by it.
          const plain = await editCharter(owner, id, {
            edits: [{ find: 'Hosting', replace: 'Hosting today' }],
            checkpoint: false,
          });
          expect(plain.changed).toBe(true);
        },
      );
    });

    it('5: one save that orphans two of an author’s ADRs still tells them when only one is healed first', async () => {
      const id = await fresh();
      const first = await propose(id, 'all billing truth', 'payment truth only', editor);
      const second = await propose(id, 'Runbooks name an owner.', 'Runbooks name nobody.', editor);
      await editCharter(owner, id, {
        edits: [
          { find: 'all billing truth', replace: 'all of billing' },
          { find: 'Runbooks name an owner.', replace: 'Runbooks exist.' },
        ],
      });
      // The first is healed before the worker runs; the second stays orphaned.
      await editCharter(owner, id, {
        edits: [{ find: 'all of billing', replace: 'all billing truth' }],
      });
      const told = (await notices(editor)).filter((n) => n.radarId === id);
      expect(told).toHaveLength(1);
      expect(told[0]?.blipId).toBe(second.adr.id);
      expect(first.adr.id).not.toBe(told[0]?.blipId);
      // And the other way round: both healed, nobody is told.
      await editCharter(owner, id, {
        edits: [{ find: 'Runbooks exist.', replace: 'Runbooks name an owner.' }],
      });
    });

    it('6: a retried reanchor reports where the anchor stands now, not that it was anchored', async () => {
      const { anchor } = await orphanedAdr();
      const input = { quote: 'something else', idempotencyKey: 'again' };
      const first = await reanchor(owner, anchor.id, input);
      expect(first.state).toBe('anchored');
      // Another writer takes the words away.
      const id = anchor.radarId;
      await editCharter(editor, id, {
        edits: [{ find: 'something else', replace: 'nothing at all' }],
      });
      expect((await anchorOf(anchor.subjectId)).state).toBe('orphaned');
      const retry = await reanchor(owner, anchor.id, input);
      expect(retry).toMatchObject({ replayed: true, state: 'orphaned' });
      await dismiss(owner, anchor.id, {});
      expect((await reanchor(owner, anchor.id, input)).state).toBe('dismissed');
    });
  });

  describe('review round 2: one lock order', () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** Waits until `n` backends of the test database are blocked on a lock. */
    const blocked = async (n: number) => {
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await must(admin).query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = $1 AND wait_event_type = 'Lock'`,
          [database],
        );
        if ((rows[0]?.n ?? 0) >= n) return;
        await pause(25);
      }
      throw new Error(`fewer than ${n} backends are waiting on a lock`);
    };
    /**
     * Holds the charter document's lock from another connection while `first` and then `second`
     * queue up for it (in that order, which is the order the database grants it in), then lets go.
     * That puts `first` through the document before `second` has asked for anything it holds.
     */
    const queued = async (
      radarId: string,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ) => {
      const other = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      const held = await other.connect();
      try {
        await held.query('BEGIN');
        await held.query('SELECT 1 FROM charter_documents WHERE radar_id = $1 FOR UPDATE', [
          radarId,
        ]);
        const a = first().then(
          (value) => ({ ok: true as const, value }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
        await blocked(1);
        const b = second().then(
          (value) => ({ ok: true as const, value }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
        await blocked(2);
        await held.query('COMMIT');
        return await Promise.all([a, b]);
      } finally {
        held.release();
        await other.end();
      }
    };
    const orphaned = async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      await editCharter(owner, id, {
        edits: [{ find: 'all billing truth', replace: 'something else' }],
      });
      return { id, adr, anchor: await anchorOf(adr.id) };
    };

    it('1: reanchor against accept, and dismiss against reject, both complete (no deadlock, no 500)', async () => {
      const a = await orphaned();
      const [reanchored, accepted] = await queued(
        a.id,
        () => reanchor(owner, a.anchor.id, { quote: 'something else' }),
        () => decideAdr(owner, a.adr.id, { decision: 'accept' }),
      );
      expect(reanchored).toMatchObject({ ok: true });
      expect(accepted).toMatchObject({ ok: true });
      expect((await anchorOf(a.adr.id)).state).toBe('anchored');
      expect((await head(a.id)).read.adrs.find((x) => x.id === a.adr.id)?.lane).toBe('accepted');

      const b = await orphaned();
      const [dismissed, rejected] = await queued(
        b.id,
        () => dismiss(owner, b.anchor.id, {}),
        () => decideAdr(owner, b.adr.id, { decision: 'reject' }),
      );
      expect(dismissed).toMatchObject({ ok: true });
      expect(rejected).toMatchObject({ ok: true });
      expect((await anchorOf(b.adr.id)).state).toBe('dismissed');
    });

    it('2: edit_charter and decide_adr on one fresh key: the loser is a 409, never a deadlock', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const [edited, decided] = await queued(
        id,
        () =>
          editCharter(owner, id, {
            edits: [{ find: 'Runbooks name an owner.', replace: 'Runbooks name an owner today.' }],
            idempotencyKey: 'shared-key',
          }),
        () => decideAdr(owner, adr.id, { decision: 'accept', idempotencyKey: 'shared-key' }),
      );
      expect(edited).toMatchObject({ ok: true });
      expect(decided).toMatchObject({ ok: false, reason: { status: 409 } });
      // Nothing of the loser was kept: the ADR is where it was, the key belongs to the edit.
      expect((await head(id)).read.adrs.find((x) => x.id === adr.id)?.lane).toBe('proposed');
      expect((await head(id)).text).toContain('Runbooks name an owner today.');
    });

    it('3: a dated accept retried after its twin committed replays it, whatever the first lookup saw', async () => {
      const id = await fresh();
      const { adr } = await propose(id, 'all billing truth', 'payment truth only');
      const request = {
        decision: 'accept' as const,
        decidedAt: '2024-05-06T00:00:00.000Z',
        decidedBy: 'Dana',
        idempotencyKey: 'dated-once',
      };
      const first = await decideAdr(owner, adr.id, request);
      expect(first.adr.lane).toBe('accepted');
      // The retry's own lookup ran before the twin committed, so it found no key.
      const db = getDb();
      const real = db.execute.bind(db);
      let missed = false;
      const spy = vi.spyOn(db, 'execute').mockImplementation(((query: {
        queryChunks?: unknown[];
      }) => {
        const text = (query.queryChunks ?? [])
          .map((c) => (c && typeof c === 'object' && 'value' in c ? [c.value].flat().join('') : ''))
          .join('');
        if (!missed && text.includes('FROM request_idempotency')) {
          missed = true;
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return real(query as never);
      }) as never);
      try {
        const retry = await decideAdr(owner, adr.id, request);
        expect(missed).toBe(true);
        expect(retry.adr.id).toBe(adr.id);
        expect(retry.adr.lane).toBe('accepted');
        expect(retry.adr.ratifiedAt).toBe(first.adr.ratifiedAt);
      } finally {
        spy.mockRestore();
      }
      // Without the key it is still what it was: refused, and it leaves no key behind.
      await expect(
        decideAdr(owner, adr.id, { ...request, idempotencyKey: 'dated-twice' }),
      ).rejects.toMatchObject({ status: 409, code: 'already_ratified' });
      const left = await getDb().execute(
        sql`SELECT 1 FROM request_idempotency WHERE key = 'dated-twice'`,
      );
      expect(left.rows).toHaveLength(0);
    });

    it('4: a person typing for a minute never meets the save limit: 60 autosaves in 60 simulated seconds', async () => {
      // Tighter than the defaults (240 a minute, burst 120): one save a second, burst of 30.
      await withLimits({ CHARTER_SAVE_PER_MINUTE: '60', CHARTER_SAVE_BURST: '30' }, async () => {
        const type = async (id: string, text: string) =>
          writeCharter(owner, id, {
            markdown: text,
            baseRevision: (await head(id)).revision,
            checkpoint: false,
          });
        // The limiter is live here, and the check does not depend on the wall clock: the bucket is
        // emptied and stamped with the database's `now()` right before the save that must be refused,
        // and it refills one token a minute, so no pause in CI can hand it a token back.
        await withLimits({ CHARTER_SAVE_PER_MINUTE: '1', CHARTER_SAVE_BURST: '30' }, async () => {
          const burst = await fresh();
          for (let i = 1; i <= 29; i += 1) await type(burst, `${TEXT}\n\nBurst ${i}.`);
          await getDb().execute(
            sql`UPDATE rate_limit_buckets SET tokens = 0, refilled_at = now()
                 WHERE key LIKE ${`charter-save:${burst}:%`}`,
          );
          await expect(type(burst, `${TEXT}\n\nBurst 30.`)).rejects.toMatchObject({
            status: 429,
          });
        });

        // Time is the database's clock: a second passing is the bucket last refilled a second ago.
        const id = await fresh();
        for (let i = 1; i <= 60; i += 1) {
          await getDb().execute(
            sql`UPDATE rate_limit_buckets SET refilled_at = refilled_at - interval '1 second'
                 WHERE key LIKE ${`charter-save:${id}:%`}`,
          );
          await type(id, `${TEXT}\n\nTyped ${i}.`);
        }
        expect((await head(id)).text).toBe(`${TEXT}\n\nTyped 60.`);
      });
      // 89 real saves, each a transaction: sized to that work, not the 5 s default, which two
      // CI runners overran.
    }, 60_000);
  });
});

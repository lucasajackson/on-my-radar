/**
 * The architecture radar against a real Postgres, REST and MCP over real HTTP:
 * the lane guards, the marker guard, deferred supersession and the digest.
 * Fixtures are a synthetic architecture pack (`__fixtures__`). Skipped without DATABASE_URL.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TOKEN_SCOPES,
  headingTitle,
  parseMarkers,
  type ArchitectureDto,
  type WriteCharterResult,
} from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, getPool, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { httpTransport } from '../mcp/test-client.js';
import {
  ADR_HEADERS,
  ADR_TITLES,
  PAGE_02,
  PAGE_03,
  PAGE_04,
} from '../__fixtures__/acme-architecture.js';
import { ADR_0027_ANCHORS } from './architecture-import.js';
import {
  decideAdr,
  proposeAdr,
  readArchitecture,
  trace,
  upsertBoundary,
  upsertContract,
  writeCharter,
} from './architecture.js';
import { anchorAdr, ensureCharterDocument } from './charter.js';
import { createBlip, deleteBlip, listBlips, updateBlip } from './blips.js';
import { createRadar, shareRadar, updateRadar } from './radars.js';

const adrBody = (n: keyof typeof ADR_HEADERS) => `${ADR_HEADERS[n][0]}\n\n${ADR_HEADERS[n][1]}`;
const A_UUID = '11111111-1111-4111-8111-111111111111';
const RATIFIED = new Date('2026-10-14T00:00:00Z');

describe.skipIf(!process.env['DATABASE_URL'])('architecture radar (real postgres)', () => {
  const database = `omr_architecture_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let origin = '';
  const clients: Client[] = [];
  let owner: Actor;
  let stranger: Actor;
  let radarId: string;
  let ownerToken = '';
  let mcp: Client;

  const mint = async (actor: Actor, scope = TOKEN_SCOPES.join(' ')) => {
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(randomToken(32)),
        clientId: 'omr_arch_test',
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
      .values({ email: `${label}@architecture.test`, state: 'active', name: label })
      .returning();
    return { user: must(row), kind: 'user' };
  };
  const rest = (path: string, token: string, body?: unknown, method?: 'PUT') =>
    fetch(`${origin}/api${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    return { error: result.isError === true, text, json: () => JSON.parse(text) as unknown };
  };
  /** A new radar holding the Acme pack's pages 01 to 04 (as pages, until first read) and ADR-0005 (accepted). */
  const freshRadar = async (owner_: Actor = owner) => {
    const radar = await createRadar(owner_, {
      name: `Arch ${Math.random()}`,
      template: 'architecture',
    });
    // Today's shape, written straight to the table: pages the cutover moves into the document
    // (createBlip refuses the charter lane now). The first architecture read or write moves them.
    let at = Date.now() - 60_000;
    for (const body of ['# 01 · Principles', PAGE_02, PAGE_03, PAGE_04])
      await getDb()
        .insert(schema.blips)
        .values({
          radarId: radar.id,
          authorId: owner_.user.id,
          state: 'active',
          status: 'charter',
          title: headingTitle(body),
          body,
          createdAt: new Date((at += 1000)),
        });
    const adr5 = await createBlip(
      owner_,
      radar.id,
      { body: adrBody('0005'), status: 'accepted' },
      { ratifiedAt: RATIFIED },
    );
    return { id: radar.id, adr5: adr5.id };
  };
  const rows = async (id: string) =>
    (await getDb().select().from(schema.blips).where(eq(schema.blips.radarId, id))).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  const stateOf = async (id: string) => {
    const all = await rows(id);
    return JSON.stringify(all.map((r) => [r.id, r.status, r.state, r.body, r.ratifiedAt]));
  };
  const getBlipRow = async (id: string) =>
    (await getDb().select().from(schema.blips).where(eq(schema.blips.id, id)))[0];
  const mintedMcp = async (scope: string) => {
    const client = new Client({ name: 'architecture-read', version: '1' });
    clients.push(client);
    await client.connect(
      httpTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${await mint(owner, scope)}` } },
      }),
    );
    return client;
  };
  const refused = async (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code });

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
        SESSION_SECRET: 'architecture-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    owner = await user('owner');
    stranger = await user('stranger');
    radarId = (await freshRadar()).id;
    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    origin = `http://127.0.0.1:${address.port}`;
    ownerToken = await mint(owner);
    mcp = new Client({ name: 'architecture-test', version: '1' });
    clients.push(mcp);
    await mcp.connect(
      httpTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${ownerToken}` } },
      }),
    );
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

  describe('proposing and deciding', () => {
    it('leaves the replaced ADR alone until the replacement is accepted, then files it', async () => {
      const { id, adr5 } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, {
        title: 'ADR-0027: Acme owns the plan; Stripe executes it',
        rationale: 'Plans are decided in three places.',
        anchors: [{ quote: 'all billing truth', with: 'payment truth only' }],
        supersedes: adr5,
      });
      const before = (await rows(id)).find((r) => r.id === adr5);
      expect([before?.status, before?.ratifiedAt?.toISOString()]).toEqual([
        'accepted',
        RATIFIED.toISOString(),
      ]);

      const decided = await decideAdr(owner, adr.id, { decision: 'accept' });
      expect(decided.filed).toEqual([adr5]);
      const after = await rows(id);
      expect(after.find((r) => r.id === adr5)?.status).toBe('repealed');
      expect(after.find((r) => r.id === adr.id)).toMatchObject({ status: 'accepted' });
      expect(after.find((r) => r.id === adr.id)?.ratifiedAt).toBeInstanceOf(Date);

      const read = await readArchitecture(owner, id, { view: 'amended' });
      expect(read.charter.map((p) => p.markdown).join('\n')).toContain('**payment truth only**');
      expect(
        (await readArchitecture(owner, id, { view: 'written' })).charter
          .map((p) => p.markdown)
          .join('\n'),
      ).toContain('**all billing truth**');
      // Ledger order: 0005 was ratified first, the new ADR now.
      expect(read.adrs.map((a) => a.id)).toEqual([adr5, adr.id]);
      expect(read.adrs[0]).toMatchObject({ supersededBy: adr.id, lane: 'repealed' });
    });

    it('files the replaced ADR and stamps ratification on any path that accepts, not just decide_adr', async () => {
      const { id, adr5 } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, {
        title: 'Via triage',
        rationale: 'r',
        anchors: [],
        supersedes: adr5,
      });
      // `state: done` is repaired into the Accepted lane, which is a legal move.
      await updateBlip(owner, adr.id, { state: 'done' });
      const all = await rows(id);
      expect(all.find((r) => r.id === adr5)?.status).toBe('repealed');
      expect(all.find((r) => r.id === adr.id)?.ratifiedAt).toBeInstanceOf(Date);
    });

    it('refuses to accept a replacement whose target is no longer in force', async () => {
      const { id, adr5 } = await freshRadar();
      const first = await proposeAdr(owner, id, {
        title: 'First',
        rationale: 'r',
        anchors: [],
        supersedes: adr5,
      });
      const second = await proposeAdr(owner, id, {
        title: 'Second',
        rationale: 'r',
        anchors: [],
        supersedes: adr5,
      });
      await decideAdr(owner, first.adr.id, { decision: 'accept' });
      const snapshot = await stateOf(id);
      await refused(decideAdr(owner, second.adr.id, { decision: 'accept' }), 'conflict');
      expect(await stateOf(id)).toBe(snapshot);
    });

    it('only an accepted ADR can be superseded, and only within its own radar', async () => {
      const { id } = await freshRadar();
      const other = await freshRadar();
      const open = await proposeAdr(owner, id, { title: 'Open', rationale: 'r', anchors: [] });
      await refused(
        proposeAdr(owner, id, { title: 'X', rationale: 'r', anchors: [], supersedes: open.adr.id }),
        'conflict',
      );
      await refused(
        proposeAdr(owner, id, { title: 'X', rationale: 'r', anchors: [], supersedes: other.adr5 }),
        'not_found',
      );
    });

    it('rolls back whole when a later anchor is refused', async () => {
      const { id } = await freshRadar();
      const snapshot = await stateOf(id);
      await refused(
        proposeAdr(owner, id, {
          title: 'Half',
          rationale: 'r',
          anchors: [
            { quote: 'all billing truth', with: 'x' },
            { quote: 'ADR-0005', with: 'y' },
          ],
        }),
        'quote_ambiguous',
      );
      expect(await stateOf(id)).toBe(snapshot);
    });

    it('keeps both anchors when two proposals land at once, and seals a version for each', async () => {
      const { id } = await freshRadar();
      await Promise.all(
        ['all billing truth', 'Customers, subscriptions, invoices, payments, disputes'].map(
          (quote, n) =>
            proposeAdr(owner, id, {
              title: `P${n}`,
              rationale: 'r',
              anchors: [{ quote, with: `w${n}` }],
            }),
        ),
      );
      const anchors = await getDb()
        .select()
        .from(schema.charterAnchors)
        .where(eq(schema.charterAnchors.radarId, id));
      expect(anchors.map((a) => a.quote).sort()).toEqual([
        'Customers, subscriptions, invoices, payments, disputes',
        'all billing truth',
      ]);
      const versions = await getDb()
        .select()
        .from(schema.charterVersions)
        .where(eq(schema.charterVersions.radarId, id))
        .orderBy(schema.charterVersions.version);
      expect(versions.map((v) => [v.version, v.cause])).toEqual([
        [1, 'migration'],
        [2, 'adr'],
        [3, 'adr'],
      ]);
    });

    it('lets a repealed or rejected amendment be amended again, but not one still in force', async () => {
      const { id } = await freshRadar();
      const span = [{ quote: 'all billing truth', with: 'next' }];
      const a = await proposeAdr(owner, id, { title: 'A', rationale: 'r', anchors: span });
      await decideAdr(owner, a.adr.id, { decision: 'accept' });
      await decideAdr(owner, a.adr.id, { decision: 'repeal' });
      const b = await proposeAdr(owner, id, { title: 'B', rationale: 'r', anchors: span });
      await decideAdr(owner, b.adr.id, { decision: 'accept' });
      const c = await proposeAdr(owner, id, {
        title: 'C',
        rationale: 'r',
        anchors: span,
        supersedes: b.adr.id,
      });
      await decideAdr(owner, c.adr.id, { decision: 'reject' });
      // B is still in force below the rejected C: a plain proposal may not slip past it.
      await refused(
        proposeAdr(owner, id, { title: 'D', rationale: 'r', anchors: span }),
        'quote_overlaps',
      );
      const read = await readArchitecture(owner, id, { view: 'amended' });
      expect(read.charter.map((p) => p.markdown).join('\n')).toContain('**next**');
    });

    it('does not repeal the old target when accepting with the link cleared', async () => {
      const { id, adr5 } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, {
        title: 'Linked',
        rationale: 'r',
        anchors: [],
        supersedes: adr5,
      });
      await updateBlip(owner, adr.id, { status: 'accepted', supersedes: null });
      const all = await rows(id);
      expect(all.find((r) => r.id === adr5)?.status).toBe('accepted');
      expect(all.find((r) => r.id === adr.id)).toMatchObject({
        status: 'accepted',
        supersedesId: null,
      });
    });

    it('refuses a replacement that spans lines, so every replacement can be drawn on one line', async () => {
      const { id } = await freshRadar();
      const bad = await rest(`/radars/${id}/adrs`, ownerToken, {
        title: 'T',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'one\ntwo' }],
      });
      expect(bad.status).toBe(400);
      await expect(
        getDb().transaction((tx) =>
          anchorAdr(tx, id, A_UUID, [{ quote: 'all billing truth', with: 'one\ntwo' }], null, null),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('stacks a superseding ADR on the same span, but not any other', async () => {
      const { id } = await freshRadar();
      const a = await proposeAdr(owner, id, {
        title: 'A',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'one' }],
      });
      await refused(
        proposeAdr(owner, id, {
          title: 'B',
          rationale: 'r',
          anchors: [{ quote: 'all billing truth', with: 'two' }],
        }),
        'quote_overlaps',
      );
      await decideAdr(owner, a.adr.id, { decision: 'accept' });
      const b = await proposeAdr(owner, id, {
        title: 'B',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'two' }],
        supersedes: a.adr.id,
      });
      await decideAdr(owner, b.adr.id, { decision: 'accept' });
      const read = await readArchitecture(owner, id, { view: 'amended' });
      expect(read.charter.map((p) => p.markdown).join('\n')).toContain('**two**');
      expect(read.adrs.find((x) => x.id === a.adr.id)?.lane).toBe('repealed');
    });
  });

  describe('lane guards', () => {
    it('refuses every move the registry does not list, and changes nothing', async () => {
      const { id, adr5 } = await freshRadar();
      const open = (await proposeAdr(owner, id, { title: 'Open', rationale: 'r', anchors: [] })).adr
        .id;
      const rejected = (await proposeAdr(owner, id, { title: 'No', rationale: 'r', anchors: [] }))
        .adr.id;
      await decideAdr(owner, rejected, { decision: 'reject' });
      const page = must((await rows(id)).find((r) => r.status === 'charter')).id;
      const snapshot = await stateOf(id);
      const moves: Array<[string, Parameters<typeof updateBlip>[2]]> = [
        [rejected, { status: 'accepted' }],
        [open, { status: 'repealed' }],
        [open, { status: 'charter' }],
        [page, { status: 'proposed' }],
        [page, { status: 'accepted' }],
        [adr5, { status: 'proposed' }],
        // `state` alone repairs the lane on the shared path; it must not be a way round.
        [open, { state: 'active' }],
        [adr5, { state: 'inbox' }],
        [page, { state: 'done' }],
      ];
      for (const [blip, patch] of moves)
        await refused(updateBlip(owner, blip, patch), 'lane_move_refused');
      expect(await stateOf(id)).toBe(snapshot);
    });

    it('refuses to create straight into a decided lane or to move a blip in', async () => {
      const { id } = await freshRadar();
      for (const status of ['accepted', 'rejected', 'repealed'])
        await refused(createBlip(owner, id, { body: 'x', status }), 'lane_move_refused');
      await refused(createBlip(owner, id, { body: 'x', state: 'done' }), 'lane_move_refused');
      const stream = await createRadar(owner, { name: 'Elsewhere', template: 'decisions' });
      const decided = await createBlip(owner, stream.id, { body: 'Done deal', status: 'accepted' });
      await refused(updateBlip(owner, decided.id, { radarId: id }), 'lane_move_refused');
    });
  });

  describe('charter guard', () => {
    it('closes the charter lane: no page is made, edited or moved in', async () => {
      const { id } = await freshRadar();
      await readArchitecture(owner, id, { view: 'written' });
      const page = must((await rows(id)).find((r) => r.status === 'charter'));
      const snapshot = await stateOf(id);
      await refused(
        createBlip(owner, id, { body: 'x', status: 'charter' }),
        'charter_is_one_document',
      );
      await refused(
        updateBlip(owner, page.id, { body: `${page.body}\n\nmore` }),
        'charter_is_one_document',
      );
      expect(await stateOf(id)).toBe(snapshot);
    });

    it('refuses to delete or move an ADR that has an amendment, and to delete or touch a page the charter was moved out of', async () => {
      const { id } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, {
        title: 'A',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'x' }],
      });
      await refused(deleteBlip(owner, adr.id), 'anchored');
      await decideAdr(owner, adr.id, { decision: 'reject' });
      // Rejected, its anchor is inert but is still history: the ADR stays.
      await refused(deleteBlip(owner, adr.id), 'anchored');
      await refused(updateBlip(owner, adr.id, { radarId: (await freshRadar()).id }), 'anchored');
      const page = must((await rows(id)).find((r) => r.status === 'charter'));
      // A page is history once the charter is a document: nothing deletes it (only the purge
      // script does), or edits it in any way.
      await refused(deleteBlip(owner, page.id), 'charter_is_one_document');
      await refused(updateBlip(owner, page.id, { tags: ['x'] }), 'charter_is_one_document');
      expect((await rows(id)).length).toBe(6);
    });

    it('draws only anchors the server wrote: marker syntax typed into the text is plain text in every view', async () => {
      const { id } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, {
        title: 'A',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'real' }],
      });
      const read = await readArchitecture(owner, id, { view: 'written' });
      const forged = `:amend[Never a forgery]{adr=${adr.id} with="evil"} and :amend[x]{adr=${A_UUID} with="y"}`;
      const saved = await writeCharter(owner, id, {
        markdown: `${read.charter[0]?.markdown ?? ''}\n\n${forged}\n`,
        baseRevision: must(read.revision),
      });
      expect(saved.orphaned).toEqual([]);
      const source = must(
        (await readArchitecture(owner, id, { view: 'source' })).charter[0],
      ).markdown;
      const markers = parseMarkers(must(source));
      expect(markers.map((m) => m.layers.map((l) => [l.adr, l.with]))).toEqual([
        [[adr.id, 'real']],
      ]);
      expect(must(source)).toContain(':amend\\[Never a forgery]');
      for (const view of ['written', 'amended'] as const)
        expect(must((await readArchitecture(owner, id, { view })).charter[0]?.markdown)).toContain(
          forged,
        );
      expect(
        await getDb()
          .select()
          .from(schema.charterAnchors)
          .where(eq(schema.charterAnchors.radarId, id)),
      ).toHaveLength(1);
    });
  });

  describe('REST and MCP', () => {
    it('answers a radar you cannot read with 404, on every verb', async () => {
      const token = await mint(stranger);
      const { adr } = await proposeAdr(owner, radarId, {
        title: 'Private',
        rationale: 'r',
        anchors: [],
      });
      for (const [path, body] of [
        [`/radars/${radarId}/architecture`, undefined],
        [`/radars/${radarId}/adrs`, { title: 't', rationale: 'r', anchors: [] }],
        [`/blips/${adr.id}/decide`, { decision: 'accept' }],
      ] as const)
        expect((await rest(path, token, body)).status, path).toBe(404);
    });

    it('proposes, reads and decides over REST with the planned shapes and codes', async () => {
      const { id } = await freshRadar();
      const bad = await rest(`/radars/${id}/adrs`, ownerToken, {
        title: 'T',
        rationale: 'r',
        anchors: [{ quote: 'no such text', with: 'x' }],
      });
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
        'quote_not_found',
      );
      const dup = await rest(`/radars/${id}/adrs`, ownerToken, {
        title: 'T',
        rationale: 'r',
        anchors: [{ quote: 'ADR-0005', with: 'x' }],
      });
      expect(dup.status).toBe(409);
      expect(
        ((await dup.json()) as { error: { code: string; fields: Record<string, string> } }).error,
      ).toMatchObject({
        code: 'quote_ambiguous',
        fields: { 'match1.context': expect.any(String) as unknown },
      });

      const made = await rest(`/radars/${id}/adrs`, ownerToken, {
        title: 'T',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'x' }],
      });
      expect(made.status).toBe(201);
      const proposed = (await made.json()) as {
        adr: { id: string; lane: string };
        anchors: Array<{ pageId: string; quote: string; with: string }>;
      };
      expect(proposed.adr.lane).toBe('proposed');
      expect(proposed.anchors).toEqual([
        {
          id: expect.any(String) as unknown,
          pageId: id,
          quote: 'all billing truth',
          with: 'x',
        },
      ]);
      const decided = await rest(`/blips/${proposed.adr.id}/decide`, ownerToken, {
        decision: 'accept',
      });
      expect(await decided.json()).toMatchObject({ adr: { lane: 'accepted' }, filed: [] });
      const read = (await (
        await rest(`/radars/${id}/architecture?view=amended&outline=true`, ownerToken)
      ).json()) as ArchitectureDto;
      expect(read.charter[0]).toMatchObject({ id, headings: expect.any(Array) as unknown });
      expect(read.charter).toHaveLength(1);
      expect(read.adrs.map((a) => a.label)).toContain('ADR-0005');
    });

    it('serves the same three tools over MCP', async () => {
      const { id } = await freshRadar();
      const proposed = await tool('propose_adr', {
        radarId: id,
        title: 'T',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'x' }],
      });
      expect(proposed.error, proposed.text).toBe(false);
      const adrId = (proposed.json() as { adr: { id: string } }).adr.id;
      expect(
        (
          await tool('propose_adr', {
            radarId: id,
            title: 'T',
            rationale: 'r',
            anchors: [{ quote: 'ADR-0005', with: 'x' }],
          })
        ).text,
      ).toMatch(/more than once/);
      const decided = await tool('decide_adr', { adrId, decision: 'accept' });
      expect(decided.json()).toMatchObject({ adr: { id: adrId, lane: 'accepted' }, filed: [] });
      const refusedMove = await tool('decide_adr', { adrId, decision: 'reject' });
      expect(refusedMove.error).toBe(true);
      const read = await tool('read_architecture', { radarId: id, view: 'source', pages: [] });
      expect((read.json() as ArchitectureDto).charter).toEqual([]);
    });

    it('lets a radars:read connection read the charter but not propose or decide', async () => {
      const { id } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, { title: 'Open', rationale: 'r', anchors: [] });
      const token = await mint(owner, 'radars:read');
      expect((await rest(`/radars/${id}/architecture`, token)).status).toBe(200);
      for (const [path, body] of [
        [`/radars/${id}/adrs`, { title: 't', rationale: 'r', anchors: [] }],
        [`/blips/${adr.id}/decide`, { decision: 'accept' }],
      ] as const)
        expect((await rest(path, token, body)).status, path).toBe(403);
    });

    it('keeps the digest of 27 ADRs without charter text within 8 KB', async () => {
      const { id } = await freshRadar();
      await getDb()
        .delete(schema.blips)
        .where(sql`${schema.blips.radarId} = ${id} AND ${schema.blips.status} = 'accepted'`);
      const ids = new Map<string, string>();
      for (const [n, line] of ADR_TITLES.entries()) {
        const label = line.slice(2, 10);
        const supersedes = label === 'ADR-0027' ? ids.get('ADR-0005') : undefined;
        const created = await createBlip(
          owner,
          id,
          { body: line, status: 'accepted', ...(supersedes ? { supersedes } : {}) },
          { ratifiedAt: new Date(RATIFIED.getTime() + n * 86_400_000) },
        );
        ids.set(label, created.id);
      }
      await ensureCharterDocument(id);
      await getDb().transaction((tx) =>
        anchorAdr(tx, id, must(ids.get('ADR-0027')), ADR_0027_ANCHORS, null, null),
      );
      const digest = await tool('read_architecture', { radarId: id, pages: [] });
      const parsed = digest.json() as ArchitectureDto;
      expect(parsed.adrs).toHaveLength(27);
      expect(parsed.adrs.find((a) => a.label === 'ADR-0027')?.anchors).toHaveLength(3);
      expect(digest.text.length).toBeLessThanOrEqual(8 * 1024);
    });
  });

  describe('boundaries, contracts and trace', () => {
    /** A radar with the charter, three boundaries (one outside) and one contract. */
    const mapped = async (owner_: Actor = owner) => {
      const { id } = await freshRadar(owner_);
      const a = (await upsertBoundary(owner_, id, { title: 'Billing', owns: ['billing.links'] }))
        .boundary;
      const b = (await upsertBoundary(owner_, id, { title: 'Sites' })).boundary;
      const x = (await upsertBoundary(owner_, id, { title: 'Stripe', external: true })).boundary;
      const c = (
        await upsertContract(owner_, id, { title: 'Stripe', version: '1.0', a: a.id, b: x.id })
      ).contract;
      return { id, a, b, x, c };
    };
    const tally = async (id: string) =>
      JSON.stringify(
        (
          await getPool().query(
            `SELECT (SELECT count(*) FROM blips WHERE radar_id = $1) AS blips,
                    (SELECT count(*) FROM blip_relations WHERE radar_id = $1) AS relations,
                    (SELECT count(*) FROM blip_elements e JOIN blips b ON b.id = e.blip_id WHERE b.radar_id = $1) AS elements`,
            [id],
          )
        ).rows,
      );
    const pageOf = async (id: string) =>
      must((await rows(id)).find((r) => r.status === 'charter')).id;

    it('keeps boundaries and contracts out of the ADR index, and out of decide_adr', async () => {
      const { id, a, c } = await mapped();
      const read = await readArchitecture(owner, id, { view: 'written' });
      expect(read.adrs.map((x) => x.label)).toEqual(['ADR-0005']);
      expect(read.boundaries.map((x) => x.title)).toEqual(['Billing', 'Sites', 'Stripe']);
      expect(read.contracts).toEqual([
        {
          id: c.id,
          updatedAt: c.updatedAt,
          title: 'Stripe',
          version: '1.0',
          a: a.id,
          b: read.boundaries[2]?.id,
          amendedBy: [],
        },
      ]);
      for (const target of [a.id, c.id])
        await refused(decideAdr(owner, target, { decision: 'accept' }), 'lane_move_refused');
    });

    it('matches a boundary by title in any case, keeps what is left out, and finds it again by id', async () => {
      const { id, a } = await mapped();
      const again = await upsertBoundary(owner, id, { title: 'BILLING', body: 'Money.' });
      expect(again).toMatchObject({
        created: false,
        boundary: { id: a.id, owns: ['billing.links'] },
      });
      const renamed = await upsertBoundary(owner, id, {
        id: a.id,
        title: 'Payments',
        owns: [],
        external: false,
      });
      expect(renamed.boundary).toMatchObject({ id: a.id, title: 'Payments', owns: [] });
      expect((await getBlipRow(a.id))?.body).toBe('Money.');
      await refused(
        upsertBoundary(owner, id, { id: await pageOf(id), title: 'x' }),
        'not_a_boundary',
      );
      const theirs = await mapped(stranger);
      await refused(upsertBoundary(owner, id, { id: theirs.a.id, title: 'x' }), 'not_found');
      await refused(upsertBoundary(stranger, id, { title: 'Nope' }), 'not_found');
    });

    it('gives one boundary for concurrent upserts of one title', async () => {
      const { id } = await freshRadar();
      const made = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          upsertBoundary(owner, id, { title: i % 2 ? 'Edge' : 'edge' }),
        ),
      );
      expect(new Set(made.map((m) => m.boundary.id)).size).toBe(1);
      expect(made.filter((m) => m.created)).toHaveLength(1);
      expect((await readArchitecture(owner, id, { view: 'written' })).boundaries).toHaveLength(1);
    });

    it('replaces both sides of a contract in one transaction', async () => {
      const { id, a, b, x, c } = await mapped();
      const moved = await upsertContract(owner, id, {
        id: c.id,
        title: 'Stripe',
        a: b.id,
        b: x.id,
      });
      expect(moved).toMatchObject({
        created: false,
        contract: { id: c.id, version: '1.0', a: b.id, b: x.id },
      });
      const links = await getDb()
        .select()
        .from(schema.blipRelations)
        .where(eq(schema.blipRelations.fromBlipId, c.id));
      expect(links.map((l) => [l.side, l.toBlipId]).sort()).toEqual([
        ['a', b.id],
        ['b', x.id],
      ]);
      expect(a.id).not.toBe(b.id);
    });

    it('refuses a bad contract before writing anything', async () => {
      const { id, a, x, c } = await mapped();
      const y = (await upsertBoundary(owner, id, { title: 'Harbor', external: true })).boundary;
      const theirs = await mapped(stranger);
      const before = await tally(id);
      const cases: Array<[() => Promise<unknown>, string]> = [
        [() => upsertContract(owner, id, { title: 'Self', a: a.id, b: a.id }), 'same_boundary'],
        [() => upsertContract(owner, id, { title: 'Out', a: x.id, b: y.id }), 'outside_seam'],
        [
          async () => upsertContract(owner, id, { title: 'Page', a: await pageOf(id), b: a.id }),
          'not_a_boundary',
        ],
        [
          () => upsertContract(owner, id, { title: 'Contract as end', a: c.id, b: a.id }),
          'not_a_boundary',
        ],
        [
          () => upsertContract(owner, id, { id: a.id, title: 'x', a: a.id, b: x.id }),
          'not_an_element',
        ],
        [
          () => upsertContract(owner, id, { title: 'Theirs', a: theirs.a.id, b: a.id }),
          'not_found',
        ],
        [
          () =>
            upsertBoundary(owner, id, { id: x.id, title: 'Stripe', external: true }).then(() =>
              upsertContract(owner, id, { title: 'Wall', a: x.id, b: y.id }),
            ),
          'outside_seam',
        ],
      ];
      for (const [attempt, code] of cases) await refused(attempt(), code);
      expect(await tally(id)).toBe(before);
    });

    it('refuses to capture or move anything into an element lane, and every move in or out', async () => {
      const { id, a, c } = await mapped();
      const plain = await createRadar(owner, { name: 'Plain' });
      const note = await createBlip(owner, plain.id, { body: 'a note' });
      await refused(createBlip(owner, id, { body: 'x', status: 'boundary' }), 'element_lane');
      await refused(createBlip(owner, id, { title: 'x', status: 'contract' }), 'element_lane');
      await refused(
        updateBlip(owner, note.id, { radarId: id, status: 'boundary' }),
        'element_lane',
      );
      const adr = (await proposeAdr(owner, id, { title: 'Open', rationale: 'r', anchors: [] })).adr;
      for (const [blip, to] of [
        [adr.id, 'boundary'],
        [await pageOf(id), 'contract'],
        [a.id, 'accepted'],
        [c.id, 'proposed'],
        [a.id, 'contract'],
      ] as const)
        await refused(updateBlip(owner, blip, { status: to }), 'lane_move_refused');
      expect((await getBlipRow(a.id))?.status).toBe('boundary');
    });

    it('keeps its relations whatever template the radar is on: switch to Stream, move, switch back', async () => {
      const { id, a, c } = await mapped();
      const lonely = (await upsertBoundary(owner, id, { title: 'Lonely' })).boundary;
      const plain = await createRadar(owner, { name: 'Elsewhere' });
      // updateRadar now refuses this switch; radars already switched keep the rule.
      const switchTo = (t: string) =>
        getPool().query('UPDATE radars SET template = $2 WHERE id = $1', [id, t]);
      await switchTo('stream');
      for (const blip of [a.id, c.id, lonely.id])
        await refused(updateBlip(owner, blip, { radarId: plain.id }), 'anchored');
      await refused(deleteBlip(owner, a.id), 'boundary_in_use');
      // Nor can Stream's lane rules take an element out of its lane.
      await refused(updateBlip(owner, a.id, { status: null }), 'lane_move_refused');
      await refused(updateBlip(owner, lonely.id, { status: null }), 'lane_move_refused');
      await switchTo('architecture');
      const arch = await readArchitecture(owner, id, { view: 'written' });
      expect(arch.boundaries.map((x) => x.id)).toContain(a.id);
      expect(arch.contracts.map((x) => x.id)).toContain(c.id);
      const links = await getDb()
        .select()
        .from(schema.blipRelations)
        .where(eq(schema.blipRelations.fromBlipId, c.id));
      expect(links).toHaveLength(2);
      expect((await getBlipRow(a.id))?.radarId).toBe(id);
      expect((await getBlipRow(a.id))?.status).toBe('boundary');
      expect((await getBlipRow(c.id))?.status).toBe('contract');
      // Its title is still taken, so the index and the map agree.
      await refused(createBlip(owner, id, { title: 'x', status: 'boundary' }), 'element_lane');
    });

    it('refuses to leave the template while elements, seams or markers exist, and never files a boundary away', async () => {
      const { id, b } = await mapped();
      const template = async (of = id) =>
        (
          await getPool().query<{ template: string }>('SELECT template FROM radars WHERE id = $1', [
            of,
          ])
        ).rows[0]?.template;
      // Elements; and a radar whose only architecture data is one amendment marker.
      await refused(updateRadar(owner, id, { template: 'decisions' }), 'template_locked');
      await refused(
        updateRadar(owner, id, { template: 'stream', name: 'Renamed' }),
        'template_locked',
      );
      const marked = (await freshRadar()).id;
      await proposeAdr(owner, marked, {
        title: 'T',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'payment truth' }],
      });
      await refused(updateRadar(owner, marked, { template: 'decisions' }), 'template_locked');
      expect([await template(), await template(marked)]).toEqual(['architecture', 'architecture']);
      // Not over-broad: an empty or charter-only radar may switch, and a settings save may not name the template.
      const bare = (await freshRadar()).id;
      await updateRadar(owner, bare, { template: 'decisions' });
      await updateRadar(owner, bare, { template: 'architecture' });
      await updateRadar(owner, id, { template: 'architecture', name: 'Same template' });
      // A radar already switched by the old behaviour cannot supersede a boundary either.
      await getPool().query(`UPDATE radars SET template = 'decisions' WHERE id = $1`, [id]);
      await refused(createBlip(owner, id, { body: 'Replace it', supersedes: b.id }), 'anchored');
      await getPool().query(`UPDATE radars SET template = 'architecture' WHERE id = $1`, [id]);
      expect((await getBlipRow(b.id))?.status).toBe('boundary');
      expect(
        (await readArchitecture(owner, id, { view: 'written' })).boundaries.map((x) => x.id),
      ).toContain(b.id);
    });

    it('does not let a template change slip past a boundary being created, in either order', async () => {
      const { id } = await freshRadar();
      const make = (title: string, wait?: Promise<unknown>) =>
        createBlip(
          owner,
          id,
          { title, status: 'boundary' },
          {
            element: true,
            requireTemplate: 'architecture',
            authored: false,
            afterInsert: async (tx, blipId) => {
              await tx.insert(schema.blipElements).values({ blipId });
              await wait;
            },
          },
        );
      // The boundary is written but not committed when the combined template-and-topic save arrives.
      let release = () => {};
      const held = make('Mid-flight', new Promise<void>((resolve) => (release = resolve)));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const switching = updateRadar(owner, id, { template: 'stream', topicId: null });
      const outcome = expect(switching).rejects.toMatchObject({ code: 'template_locked' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await held;
      await outcome;
      // The other order: the radar was checked as Architecture, then switched before the write. The
      // creator's own read and the locked row both say stream, so only the template it expected can refuse.
      const bare = (await freshRadar()).id;
      await updateRadar(owner, bare, { template: 'stream' });
      await expect(
        createBlip(
          owner,
          bare,
          { title: 'Late' },
          {
            requireTemplate: 'architecture',
            authored: false,
            afterInsert: async (tx, blipId) => {
              await tx.insert(schema.blipElements).values({ blipId });
            },
          },
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await getPool().query(
            'SELECT count(*)::int AS n FROM blip_elements WHERE radar_id = $1',
            [bare],
          )
        ).rows[0],
      ).toEqual({ n: 0 });
    });

    it('lets an RSS-style insert that already holds the radar row finish beside a template switch, without a deadlock', async () => {
      const { id } = await freshRadar();
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let holding = () => {};
      const reached = new Promise<void>((resolve) => (holding = resolve));
      const rss = createBlip(
        owner,
        id,
        { body: 'An item from a feed' },
        {
          // Holds the row for share first, as the feed importer does, then asks for the capture lock.
          beforeInsert: async (tx) => {
            await tx
              .select({ id: schema.radars.id })
              .from(schema.radars)
              .where(eq(schema.radars.id, id))
              .for('share');
            holding();
            await held;
          },
        },
      );
      await reached;
      const switching = updateRadar(owner, id, { template: 'stream' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      // A lock-order inversion makes Postgres abort one of them (40P01) after its deadlock timeout.
      await expect(Promise.all([rss, switching])).resolves.toBeDefined();
      expect((await getBlipRow((await rss).id))?.radarId).toBe(id);
    });

    it('lists every ADR before any boundary or contract, so elements never push them off a page', async () => {
      const { id } = await mapped();
      for (let i = 0; i < 5; i++)
        await proposeAdr(owner, id, { title: `Open ${i}`, rationale: 'r', anchors: [] });
      const page = await listBlips([id], {}, null, null, {
        template: 'architecture',
        templateConfig: {},
      });
      const lanes = page.items.map((b) => b.status);
      const firstElement = lanes.findIndex((l) => l === 'boundary' || l === 'contract');
      expect(firstElement).toBeGreaterThan(0);
      expect(lanes.slice(firstElement).every((l) => l === 'boundary' || l === 'contract')).toBe(
        true,
      );
      expect(lanes.filter((l) => l === 'proposed')).toHaveLength(5);
    });

    it('stops a boundary with seams being deleted, in the service and in the database', async () => {
      const { id, a, b, c } = await mapped();
      await refused(deleteBlip(owner, a.id), 'boundary_in_use');
      await expect(
        getPool().query('DELETE FROM blips WHERE id = $1', [a.id]),
      ).rejects.toMatchObject({ code: '23503' });
      await deleteBlip(owner, b.id);
      await deleteBlip(owner, c.id);
      await deleteBlip(owner, a.id);
      expect(
        (await readArchitecture(owner, id, { view: 'written' })).boundaries.map((x) => x.title),
      ).toEqual(['Stripe']);
    });

    it('takes a radar’s elements and links with it when the radar goes', async () => {
      const { id } = await mapped();
      await proposeAdr(owner, id, {
        title: 'T',
        rationale: 'r',
        anchors: [],
        amends: [
          (await readArchitecture(owner, id, { view: 'written' })).boundaries[0]?.id as string,
        ],
      });
      expect((JSON.parse(await tally(id)) as Array<Record<string, number>>)[0]).toMatchObject({
        relations: 3,
        elements: 4,
      });
      await getPool().query('DELETE FROM radars WHERE id = $1', [id]);
      expect((JSON.parse(await tally(id)) as Array<Record<string, number>>)[0]).toEqual({
        blips: 0,
        relations: 0,
        elements: 0,
      });
    });

    it('writes what an ADR amends with the ADR, and refuses what is not an element', async () => {
      const { id, a, c } = await mapped();
      const theirs = await mapped(stranger);
      const before = await tally(id);
      await refused(
        proposeAdr(owner, id, {
          title: 'T',
          rationale: 'r',
          anchors: [],
          amends: [await pageOf(id)],
        }),
        'not_an_element',
      );
      await refused(
        proposeAdr(owner, id, { title: 'T', rationale: 'r', anchors: [], amends: [theirs.a.id] }),
        'not_found',
      );
      // A good element beside an anchor that cannot be placed: nothing is left behind.
      await refused(
        proposeAdr(owner, id, {
          title: 'T',
          rationale: 'r',
          amends: [a.id],
          anchors: [{ quote: 'no such words', with: 'x' }],
        }),
        'quote_not_found',
      );
      expect(await tally(id)).toBe(before);

      const { adr } = await proposeAdr(owner, id, {
        title: 'ADR-0030: Billing moves',
        rationale: 'r',
        anchors: [],
        amends: [a.id, c.id, a.id],
      });
      expect(adr.amends.sort()).toEqual([a.id, c.id].sort());
      const open = await readArchitecture(owner, id, { view: 'written' });
      expect(open.boundaries.find((x) => x.id === a.id)?.amendedBy).toEqual([adr.id]);
      expect(open.adrs.find((x) => x.id === adr.id)).toMatchObject({
        lane: 'proposed',
        amends: expect.arrayContaining([a.id]) as unknown,
      });
      await decideAdr(owner, adr.id, { decision: 'accept' });
      const done = await readArchitecture(owner, id, { view: 'written' });
      expect(done.adrs.find((x) => x.id === adr.id)?.lane).toBe('accepted');
      expect(done.contracts[0]?.amendedBy).toEqual([adr.id]);
    });

    it('will not delete or move anything an ADR amends, or an ADR that amends', async () => {
      const { id, a } = await mapped();
      const { adr } = await proposeAdr(owner, id, {
        title: 'T',
        rationale: 'r',
        anchors: [],
        amends: [a.id],
      });
      const plain = await createRadar(owner, { name: 'Elsewhere' });
      await refused(deleteBlip(owner, adr.id), 'anchored');
      await refused(updateBlip(owner, a.id, { radarId: plain.id }), 'anchored');
      await refused(updateBlip(owner, adr.id, { radarId: plain.id }), 'anchored');
      const loneBoundary = (await upsertBoundary(owner, id, { title: 'Lone' })).boundary;
      await refused(updateBlip(owner, loneBoundary.id, { radarId: plain.id }), 'anchored');
    });

    it('traces a boundary, a contract and an ADR, and refuses a page', async () => {
      const { id, a, x, c } = await mapped();
      const { adr } = await proposeAdr(owner, id, {
        title: 'ADR-0030: Billing moves',
        rationale: 'r',
        amends: [a.id],
        anchors: [{ quote: 'all billing truth', with: 'payment truth' }],
      });
      const label = { id: adr.id, label: 'ADR-0006', lane: 'proposed' };
      expect(await trace(owner, a.id)).toEqual({
        kind: 'boundary',
        id: a.id,
        title: 'Billing',
        external: false,
        owns: ['billing.links'],
        seams: [
          {
            contract: { id: c.id, title: 'Stripe' },
            version: '1.0',
            side: 'a',
            counterparty: { id: x.id, title: 'Stripe', external: true },
          },
        ],
        amendedBy: [label],
      });
      expect(await trace(owner, c.id)).toMatchObject({
        kind: 'contract',
        version: '1.0',
        a: { id: a.id, external: false },
        b: { id: x.id, external: true },
        amendedBy: [],
      });
      expect(await trace(owner, adr.id)).toMatchObject({
        kind: 'adr',
        label: 'ADR-0006',
        anchors: [{ quote: 'all billing truth' }],
        amends: [{ id: a.id, title: 'Billing', kind: 'boundary' }],
        supersedes: null,
        supersededBy: null,
      });
      await refused(trace(owner, await pageOf(id)), 'not_traceable');
      await refused(trace(stranger, a.id), 'not_found');
    });

    it('narrows read_architecture to one boundary, its seams and their ADRs', async () => {
      const { id, a, b, x } = await mapped();
      const { adr } = await proposeAdr(owner, id, {
        title: 'T',
        rationale: 'r',
        anchors: [],
        amends: [a.id],
      });
      await proposeAdr(owner, id, {
        title: 'Unrelated',
        rationale: 'r',
        anchors: [],
        amends: [b.id],
      });
      const one = await readArchitecture(owner, id, { view: 'written', boundary: a.id });
      expect(one.charter).toEqual([]);
      expect(one.boundaries.map((e) => e.id).sort()).toEqual([a.id, x.id].sort());
      expect(one.contracts).toHaveLength(1);
      expect(one.adrs.map((e) => e.id)).toEqual([adr.id]);
      expect(
        (await readArchitecture(owner, id, { view: 'written', boundary: a.id, outline: true }))
          .charter.length,
      ).toBeGreaterThan(0);
      await refused(
        readArchitecture(owner, id, { view: 'written', boundary: await pageOf(id) }),
        'not_a_boundary',
      );
      await refused(
        readArchitecture(stranger, id, { view: 'written', boundary: a.id }),
        'not_found',
      );
      const theirs = await mapped(stranger);
      await refused(
        readArchitecture(owner, id, { view: 'written', boundary: theirs.a.id }),
        'not_found',
      );
    });

    it('serves upsert_boundary, upsert_contract and trace over REST and MCP, and keeps them off a read-only connection', async () => {
      const { id } = await freshRadar();
      const made = await rest(`/radars/${id}/boundaries`, ownerToken, {
        title: 'Edge',
        owns: ['edge.routes'],
      });
      expect(made.status).toBe(201);
      const edge = ((await made.json()) as { boundary: { id: string } }).boundary;
      expect((await rest(`/radars/${id}/boundaries`, ownerToken, { title: 'edge' })).status).toBe(
        200,
      );
      const viaMcp = await tool('upsert_boundary', {
        radarId: id,
        title: 'Cloudflare',
        external: true,
      });
      expect(viaMcp.error, viaMcp.text).toBe(false);
      const cf = (viaMcp.json() as { boundary: { id: string } }).boundary;
      const contract = await tool('upsert_contract', {
        radarId: id,
        title: 'Cloudflare',
        a: edge.id,
        b: cf.id,
        version: '1.1',
      });
      expect(contract.json()).toMatchObject({ created: true, contract: { version: '1.1' } });
      expect(
        (await rest(`/radars/${id}/contracts`, ownerToken, { title: 'C', a: edge.id, b: edge.id }))
          .status,
      ).toBe(422);
      expect((await tool('trace', { id: edge.id })).json()).toMatchObject({
        kind: 'boundary',
        seams: [{ version: '1.1' }],
      });
      expect(
        (await (await rest(`/blips/${edge.id}/trace`, ownerToken)).json()) as object,
      ).toMatchObject({ kind: 'boundary' });
      const read = await mintedMcp('radars:read');
      expect((await read.callTool({ name: 'trace', arguments: { id: edge.id } })).isError).not.toBe(
        true,
      );
      const refusedWrite = await read.callTool({
        name: 'upsert_boundary',
        arguments: { radarId: id, title: 'No' },
      });
      expect(refusedWrite.isError).toBe(true);
      const token = await mint(owner, 'radars:read');
      expect((await rest(`/radars/${id}/boundaries`, token, { title: 'No' })).status).toBe(403);
      expect(
        (await rest(`/radars/${id}/contracts`, token, { title: 'No', a: edge.id, b: cf.id }))
          .status,
      ).toBe(403);
      expect((await rest(`/blips/${edge.id}/trace`, token)).status).toBe(200);
      expect((await rest(`/blips/${edge.id}/trace`, await mint(stranger))).status).toBe(404);
    });
  });
  describe('authoring: the charter document and who may write', () => {
    it('replaces the charter with write_charter and reads it back as one document', async () => {
      const { id } = await freshRadar();
      const read = await readArchitecture(owner, id, { view: 'written' });
      expect(read.charter).toHaveLength(1);
      expect([read.revision, read.charterVersion]).toEqual([1, 1]);
      const saved = await writeCharter(owner, id, {
        markdown: `${must(read.charter[0]?.markdown)}\n\n## Operations\n\nRunbooks name an owner.`,
        baseRevision: 1,
        note: 'add operations',
      });
      expect(saved).toMatchObject({ revision: 2, version: 2, changed: true, orphaned: [] });
      const again = await readArchitecture(owner, id, { view: 'written' });
      expect(must(again.charter[0]?.markdown).endsWith('Runbooks name an owner.')).toBe(true);
      expect([again.revision, again.charterVersion]).toEqual([2, 2]);
      // The same text again is a no-op: no revision, no version.
      expect(
        await writeCharter(owner, id, {
          markdown: must(again.charter[0]?.markdown),
          baseRevision: 2,
        }),
      ).toMatchObject({ revision: 2, version: 2, changed: false });
      const note = await getPool().query(
        `SELECT note, cause FROM charter_versions WHERE radar_id = $1 AND version = 2`,
        [id],
      );
      expect(note.rows[0]).toEqual({ note: 'add operations', cause: 'edit' });
    });

    it('never refuses a save over an amendment: the quote changed is orphaned, and the response says so', async () => {
      const { id } = await freshRadar();
      const { adr } = await proposeAdr(owner, id, {
        title: 'Payment truth only',
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'payment truth only' }],
      });
      const read = await readArchitecture(owner, id, { view: 'written' });
      const text = must(read.charter[0]?.markdown);
      const saved = await writeCharter(owner, id, {
        markdown: text.replace('all billing truth', 'all of billing'),
        baseRevision: must(read.revision),
      });
      expect(saved.orphaned).toEqual([
        expect.objectContaining({
          kind: 'amend',
          subject: expect.objectContaining({ id: adr.id, label: 'ADR-0006' }) as unknown,
          quote: 'all billing truth',
          cause: 'text_changed',
          resolvedVersion: 2,
          orphanedVersion: 3,
        }),
      ]);
      const after = await readArchitecture(owner, id, { view: 'source' });
      expect(after.orphans?.map((o) => o.quote)).toEqual(['all billing truth']);
      expect(after.adrs.find((a) => a.id === adr.id)?.anchors).toEqual([
        expect.objectContaining({ state: 'orphaned', cause: 'text_changed', resolvedVersion: 2 }),
      ]);
    });

    it('refuses a charter write on a radar that is not Architecture, in another radar, or retired page writes', async () => {
      const { id } = await freshRadar();
      const plain = await createRadar(owner, { name: 'Plain', template: 'stream' });
      await expect(
        writeCharter(owner, plain.id, { markdown: 'x', baseRevision: 0 }),
      ).rejects.toMatchObject({ status: 400 });
      const strangerRadar = await createRadar(stranger, {
        name: 'Theirs',
        template: 'architecture',
      });
      await expect(
        writeCharter(owner, strangerRadar.id, { markdown: 'x', baseRevision: 0 }),
      ).rejects.toMatchObject({ status: 404 });
      for (const body of [
        { title: 'T', body: 'x' },
        { id: A_UUID, title: 'T', body: 'x' },
      ]) {
        const gone = await rest(`/radars/${id}/charter-pages`, ownerToken, body);
        expect(gone.status).toBe(410);
        expect(((await gone.json()) as { error: { code: string } }).error.code).toBe(
          'charter_is_one_document',
        );
      }
    });

    it('refuses a viewer on every architecture write, and answers a stranger with 404', async () => {
      const { id } = await freshRadar();
      const viewer = await user('viewer');
      await shareRadar(owner, id, viewer.user.email, 'viewer');
      const edge = (await upsertBoundary(owner, id, { title: 'Edge' })).boundary;
      const viewerToken = await mint(viewer);
      const strangerToken = await mint(stranger);
      const writes = [
        [`/radars/${id}/charter`, { markdown: 'T', baseRevision: 1 }, 'PUT'],
        [`/radars/${id}/charter-pages`, { title: 'T', body: 'x' }, undefined],
        [`/radars/${id}/boundaries`, { title: 'Billing' }, undefined],
        [`/radars/${id}/contracts`, { title: 'C', a: edge.id, b: edge.id }, undefined],
        [`/radars/${id}/adrs`, { title: 'T', rationale: 'r', anchors: [] }, undefined],
      ] as const;
      for (const [path, body, method] of writes) {
        expect((await rest(path, viewerToken, body, method)).status, `viewer ${path}`).toBe(403);
        expect((await rest(path, strangerToken, body, method)).status, `stranger ${path}`).toBe(
          404,
        );
      }
      expect((await rest(`/radars/${id}/architecture`, viewerToken)).status).toBe(200);
      const before = await stateOf(id);
      expect(before).not.toContain('"T"');
    });

    it('writes the charter over REST and MCP, and the read-only scope cannot', async () => {
      const { id } = await freshRadar();
      const read = (await (
        await rest(`/radars/${id}/architecture?view=written`, ownerToken)
      ).json()) as ArchitectureDto;
      const text = must(read.charter[0]?.markdown);
      const made = await rest(
        `/radars/${id}/charter`,
        ownerToken,
        { markdown: `${text}\n\nTokens are scoped.`, baseRevision: read.revision },
        'PUT',
      );
      expect(made.status).toBe(200);
      expect(await made.json()).toMatchObject({ revision: 2, version: 2, changed: true });
      const viaMcp = await tool('write_charter', {
        radarId: id,
        markdown: `${text}\n\nTokens are scoped and short-lived.`,
        baseRevision: 2,
      });
      expect(viaMcp.error, viaMcp.text).toBe(false);
      expect((viaMcp.json() as WriteCharterResult).revision).toBe(3);
      // Based on an older revision: stale, over both transports, and nothing is written.
      const stale = await rest(
        `/radars/${id}/charter`,
        ownerToken,
        { markdown: 'lost', baseRevision: 1 },
        'PUT',
      );
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('stale');
      expect(
        (await tool('write_charter', { radarId: id, markdown: 'lost', baseRevision: 1 })).error,
      ).toBe(true);
      const readOnly = await mintedMcp('radars:read');
      expect(
        (
          await readOnly.callTool({
            name: 'write_charter',
            arguments: { radarId: id, markdown: 'No', baseRevision: 3 },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await rest(
            `/radars/${id}/charter`,
            await mint(owner, 'radars:read'),
            { markdown: 'No', baseRevision: 3 },
            'PUT',
          )
        ).status,
      ).toBe(403);
      expect(
        must((await readArchitecture(owner, id, { view: 'written' })).charter[0]?.markdown),
      ).toContain('short-lived');
    });

    it('removes an unamended boundary and a contract, and refuses a boundary that has a seam', async () => {
      const { id } = await freshRadar();
      const a = (await upsertBoundary(owner, id, { title: 'A' })).boundary;
      const b = (await upsertBoundary(owner, id, { title: 'B' })).boundary;
      const c = (await upsertContract(owner, id, { title: 'A to B', a: a.id, b: b.id })).contract;
      await refused(deleteBlip(owner, a.id), 'boundary_in_use');
      await deleteBlip(owner, c.id);
      await deleteBlip(owner, a.id);
      const read = await readArchitecture(owner, id, { view: 'source', outline: true });
      expect([read.boundaries.map((x) => x.title), read.contracts]).toEqual([['B'], []]);
    });

    it('lists a proposed ADR when there is no charter and nothing else', async () => {
      const empty = await createRadar(owner, { name: 'Empty', template: 'architecture' });
      const { adr } = await proposeAdr(owner, empty.id, {
        title: 'Pick a queue',
        rationale: 'Why',
        anchors: [],
      });
      const read = await readArchitecture(owner, empty.id, { view: 'source' });
      expect(read.charter).toEqual([]);
      expect(read.adrs.map((a) => [a.id, a.lane])).toEqual([[adr.id, 'proposed']]);
    });
  });
  describe('ADR numbers and which markers lock a page', () => {
    const propose = (
      id: string,
      title: string,
      anchors: Array<{ quote: string; with: string }> = [],
    ) => proposeAdr(owner, id, { title, rationale: 'r', anchors });

    it('numbers each ADR one after the highest, in the radar width, and never twice at once', async () => {
      const { id } = await freshRadar();
      const made = await Promise.all(['One', 'Two', 'Three', 'Four'].map((t) => propose(id, t)));
      expect(made.map((m) => m.adr.label).sort()).toEqual([
        'ADR-0006',
        'ADR-0007',
        'ADR-0008',
        'ADR-0009',
      ]);
      // A number typed into the title is not trusted; the radar hands out the next one.
      const typed = await propose(id, 'ADR-0003: Typed by hand');
      expect([typed.adr.label, typed.adr.title]).toEqual(['ADR-0010', 'Typed by hand']);
      // A rejected ADR keeps its number.
      await decideAdr(owner, typed.adr.id, { decision: 'reject' });
      expect((await propose(id, 'After a rejection')).adr.label).toBe('ADR-0011');
      // Over MCP it is the same service.
      const viaMcp = await tool('propose_adr', { radarId: id, title: 'Over MCP', rationale: 'r' });
      expect(viaMcp.error, viaMcp.text).toBe(false);
      expect((viaMcp.json() as { adr: { label: string } }).adr.label).toBe('ADR-0012');
      const read = await readArchitecture(owner, id, { view: 'source' });
      expect(new Set(read.adrs.map((a) => a.label)).size).toBe(read.adrs.length);
    });

    it('starts at ADR-0001 on a radar with none, and counts from there', async () => {
      const fresh = await createRadar(owner, { name: 'Numbers', template: 'architecture' });
      const [a, b] = await Promise.all([propose(fresh.id, 'First'), propose(fresh.id, 'Second')]);
      expect([a.adr.label, b.adr.label].sort()).toEqual(['ADR-0001', 'ADR-0002']);
      expect((await propose(fresh.id, 'Third')).adr.label).toBe('ADR-0003');
    });
  });
  describe('two writers', () => {
    it('refuses a charter, boundary or contract that was changed after the writer read it', async () => {
      const { id } = await freshRadar();
      const a = (await upsertBoundary(owner, id, { title: 'Billing', body: 'First.' })).boundary;
      const b = (await upsertBoundary(owner, id, { title: 'Sites' })).boundary;
      const c = (await upsertContract(owner, id, { title: 'Sync', a: a.id, b: b.id })).contract;
      const opened = await readArchitecture(owner, id, { view: 'written' });
      const text = must(opened.charter[0]?.markdown);

      // Both "tabs" opened the same revision; the first to save wins.
      const first = await writeCharter(owner, id, {
        markdown: `${text}\n\nv2 from tab one`,
        baseRevision: must(opened.revision),
      });
      await expect(
        writeCharter(owner, id, {
          markdown: `${text}\n\nv2 from tab two`,
          baseRevision: must(opened.revision),
        }),
      ).rejects.toMatchObject({ status: 409, code: 'stale' });
      expect(
        must((await readArchitecture(owner, id, { view: 'written' })).charter[0]?.markdown),
      ).toContain('tab one');
      // Saving against what the first save returned works.
      await writeCharter(owner, id, {
        markdown: `${text}\n\nv3`,
        baseRevision: first.revision,
      });

      const firstB = await upsertBoundary(owner, id, {
        id: a.id,
        title: 'Billing',
        body: 'Second.',
        expectedUpdatedAt: a.updatedAt,
      });
      await expect(
        upsertBoundary(owner, id, {
          id: a.id,
          title: 'Billing',
          body: 'Lost.',
          expectedUpdatedAt: a.updatedAt,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'stale' });
      expect((await getBlipRow(a.id))?.body).toBe('Second.');
      expect(firstB.boundary.updatedAt).not.toBe(a.updatedAt);

      await upsertContract(owner, id, {
        id: c.id,
        title: 'Sync',
        a: a.id,
        b: b.id,
        version: '2',
        expectedUpdatedAt: c.updatedAt,
      });
      await expect(
        upsertContract(owner, id, {
          id: c.id,
          title: 'Sync',
          a: a.id,
          b: b.id,
          version: '3',
          expectedUpdatedAt: c.updatedAt,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'stale' });
      const rest_ = await rest(
        `/radars/${id}/charter`,
        ownerToken,
        { markdown: 'x', baseRevision: must(opened.revision) },
        'PUT',
      );
      expect(rest_.status).toBe(409);
    });

    it('serialises two saves of one revision: one lands, one is stale, whichever runs first', async () => {
      const { id } = await freshRadar();
      const opened = await readArchitecture(owner, id, { view: 'written' });
      const text = must(opened.charter[0]?.markdown);
      const settled = await Promise.allSettled(
        ['A', 'B', 'C'].map((t) =>
          writeCharter(owner, id, {
            markdown: `${text}\n\n${t}`,
            baseRevision: must(opened.revision),
          }),
        ),
      );
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        settled.flatMap((r) =>
          r.status === 'rejected' ? [(r.reason as { code: string }).code] : [],
        ),
      ).toEqual(['stale', 'stale']);
    });

    it('reads an element and its own text in one snapshot, with the revision to save against', async () => {
      const { id } = await freshRadar();
      const a = (await upsertBoundary(owner, id, { title: 'Billing', body: 'Details.' })).boundary;
      await upsertBoundary(owner, id, { title: 'Sites', body: 'Other.' });
      const read = await readArchitecture(owner, id, { view: 'source', edit: a.id });
      expect(read.boundaries.map((b) => [b.title, b.body])).toEqual([
        ['Billing', 'Details.'],
        ['Sites', undefined],
      ]);
      expect(read.boundaries[0]?.updatedAt).toBe(a.updatedAt);
      expect(read.charter.every((p) => Boolean(p.updatedAt))).toBe(true);
      expect(read.charter).toHaveLength(1);
    });

    it('reads fields and revision in one snapshot, so a write between the reads is still refused as stale', async () => {
      const { id } = await freshRadar();
      const a = (await upsertBoundary(owner, id, { title: 'Billing', owns: ['old.rows'] }))
        .boundary;
      // A write commits after the rows are read and before the attributes are.
      const read = await readArchitecture(
        owner,
        id,
        { view: 'source', edit: a.id },
        {
          afterRows: async () => {
            await upsertBoundary(owner, id, { id: a.id, title: 'Billing', owns: ['new.rows'] });
          },
        },
      );
      const seen = must(read.boundaries.find((b) => b.id === a.id));
      // The old revision comes with the old fields, never the old revision with the new fields.
      expect([seen.updatedAt, seen.owns]).toEqual([a.updatedAt, ['old.rows']]);
      // Saving on that revision is refused: the form shown to the person was already out of date.
      await expect(
        upsertBoundary(owner, id, {
          id: a.id,
          title: 'Billing',
          owns: ['mine.rows'],
          expectedUpdatedAt: seen.updatedAt,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'stale' });
      expect((await readArchitecture(owner, id, { view: 'source' })).boundaries[0]?.owns).toEqual([
        'new.rows',
      ]);
    });
  });
});

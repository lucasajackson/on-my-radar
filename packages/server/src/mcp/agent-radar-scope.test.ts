/**
 * An agent limited to selected radars (plan 161d7453, T4), through every door, over real HTTP
 * and MCP on an isolated database.
 *
 * One person owns three radars: `granted`, `withheld` (shared with a second person, so the
 * reader lists have something to leak) and `open` (published). The scoped agent is given
 * `granted` at `write`. Its credentials are a PAT and an OAuth grant, both minted for it;
 * the control connection is the same person unscoped. Everything the scoped agent is refused
 * is read back through the control, so a pass cannot be a fixture that is empty.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { blockedBehind } from '../services/lock-graph.js';
import {
  adminListAgents,
  adminListTokens,
  adminRevokeAgent,
  adminRevokeGrant,
  adminRevokePat,
} from '../services/admin-agents.js';
import {
  fenceCaps,
  getRadarAccess,
  readableRadarIdsFor,
  readersOfRadars,
  requireRadar,
} from '../services/access.js';
import { editCharter, proposeAdr, writeCharter } from '../services/architecture.js';
import { createBlip } from '../services/blips.js';
import { createDashboard, updateDashboard } from '../services/dashboards.js';
import { listNotifications, markRead, notificationCounts } from '../services/notifications.js';
import { createRadar, listRadars, setVisibility, shareRadar } from '../services/radars.js';
import {
  createRepoAgent,
  deleteRepoAgent,
  listShares,
  acceptShare,
  setAgentRadars,
  shareAgent,
  updateRepoAgent,
} from '../services/repo-agents.js';
import { searchPeople, searchRadarNames, searchTopicNames } from '../services/search.js';
import { createToken, lockGrant } from '../services/tokens.js';
import {
  createTopic,
  listTopics,
  removeTopicMember,
  setCascade,
  setRadarTopic,
  shareTopic,
} from '../services/topics.js';

type Content = Array<{ type: string; text?: string }>;

describe.skipIf(!process.env['DATABASE_URL'])('an agent limited to selected radars', () => {
  const database = `omr_agent_scope_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let base: URL;
  const clients: Client[] = [];

  let owner: Actor;
  let bob: Actor;
  let platformAdmin: Actor;
  let adminCookie: string;
  let granted = '';
  let withheld = '';
  let open = '';
  let openSlug = '';
  let topicId = '';
  let scopedId = '';
  let wideId = '';
  let scopedPat = '';
  let scopedPatId = '';
  let widePat = '';
  let scoped: Client;
  let control: Client;
  let scopedActor: Actor;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const rest = (token: string, path: string, init: { method?: string; body?: string } = {}) =>
    fetch(new URL(path, base), {
      ...init,
      headers: { ...bearer(token), 'content-type': 'application/json' },
    });

  /** The bearer shape of a credential minted for `agentId`, as `attachActor` builds it. */
  const credentialFor = (agentId: string, tokenId = 'tok'): Actor => ({
    user: owner.user,
    kind: 'agent',
    ceiling: 'owner',
    tokenId,
    connection: { kind: 'pat', id: tokenId, label: null },
    agent: { agentId, ownerId: owner.user.id, name: 'Scoped', handle: 'scoped' },
    radarFence: [agentId],
  });

  async function oauthFor(
    agentId: string | null,
    clientId: string,
    bound = agentId !== null,
    who: Actor = owner,
  ) {
    const access = randomToken(32);
    const refresh = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        refreshTokenHash: hashSecret(refresh),
        clientId,
        userId: who.user.id,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        agentId,
        agentBound: bound,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    return { access, refresh };
  }

  async function connect(access: string) {
    const client = new Client({ name: 'agent-scope-test', version: '1' });
    clients.push(client);
    const { httpTransport } = await import('./test-client.js');
    await client.connect(
      httpTransport(new URL('/mcp', base), {
        requestInit: { headers: bearer(access) },
      }),
    );
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Content).map((block) => block.text ?? '').join('\n');
    return { error: result.isError === true, text };
  }
  const data = (result: { text: string }): unknown => JSON.parse(result.text);
  const NOT_FOUND = /not found/i;

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
        SESSION_SECRET: 'agent-scope-test-secret-not-used-anywhere',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const user = async (label: string, isAdmin = false): Promise<Actor> => {
      const [row] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@agent-scope.test`, state: 'active', name: label, isAdmin })
        .returning();
      return { user: must(row), kind: 'user' };
    };
    owner = await user('owner');
    bob = await user('bob');
    platformAdmin = await user('admin', true);
    adminCookie = `${SESSION_COOKIE}=${(await createSession(platformAdmin.user)).token}`;

    granted = (await createRadar(owner, { name: 'Granted radar' })).id;
    withheld = (await createRadar(owner, { name: 'Withheld radar' })).id;
    open = (await createRadar(owner, { name: 'Open radar' })).id;
    openSlug = must((await setVisibility(owner, open, 'public')).publicSlug);
    await shareRadar(owner, withheld, bob.user.email, 'viewer');
    const topic = await createTopic(owner, { name: 'Secret topic' });
    topicId = topic.id;
    await setCascade(owner, topicId, true);
    await setRadarTopic(owner, granted, topicId);
    await setRadarTopic(owner, withheld, topicId);
    await createBlip(owner, granted, { body: 'zebra in the granted radar #shared-tag' });
    await createBlip(owner, withheld, { body: 'zebra in the withheld radar #secret-tag' });
    await createBlip(owner, open, { body: 'zebra in the open radar #open-tag' });

    const scopedAgent = await createRepoAgent(owner, {
      name: 'Scoped',
      slug: 'scoped',
      prompt: 'p',
    });
    scopedId = scopedAgent.id;
    await setAgentRadars(owner, scopedId, {
      scope: 'selected',
      grants: [{ radarId: granted, ceiling: 'write' }],
    });
    wideId = (await createRepoAgent(owner, { name: 'Wide', slug: 'wide', prompt: 'p' })).id;
    // The agent is shared with the topic, so its sharing metadata names a topic.
    await shareAgent(owner, scopedId, { topicId, prompt: 'view' });

    const pat = await createToken(owner, { name: 'scoped pat', agentId: scopedId });
    scopedPat = must(pat.token);
    scopedPatId = pat.id;
    widePat = must((await createToken(owner, { name: 'wide pat', agentId: wideId })).token);
    scopedActor = credentialFor(scopedId);

    listener = serve({ fetch: createApp().fetch, port: 0 });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    base = new URL(`http://127.0.0.1:${address.port}`);
    scoped = await connect((await oauthFor(scopedId, 'omr_scoped_app')).access);
    control = await connect((await oauthFor(null, 'omr_control_app')).access);

    // The scoped agent's own queue: one notification per radar, and one that is a topic's.
    const note = (extra: Partial<typeof schema.notifications.$inferInsert>) =>
      getDb()
        .insert(schema.notifications)
        .values({
          userId: owner.user.id,
          agentId: scopedId,
          kind: 'comment',
          groupKey: `agent:${scopedId}:${randomToken(6)}`,
          subject: 'a note',
          ...extra,
        });
    await note({ radarId: granted });
    await note({ radarId: withheld });
    await note({ kind: 'topic_cascade', topicId });
  }, 60_000);

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

  /* ----------------------------------- REST ----------------------------------- */

  it('REST: the radar list and every lookup stop at the grants, a published radar included', async () => {
    const listed = (await (await rest(scopedPat, '/api/radars')).json()) as {
      radars: Array<{ id: string; access: { canWrite: boolean; canManage: boolean } }>;
    };
    expect(listed.radars.map((r) => r.id)).toEqual([granted]);
    // The grant's ceiling is write: the list says so too, as the lookup does.
    expect(listed.radars[0]?.access).toMatchObject({ canWrite: true, canManage: false });
    expect((await rest(scopedPat, `/api/radars/${granted}`)).status).toBe(200);
    for (const ident of [withheld, open, openSlug])
      expect((await rest(scopedPat, `/api/radars/${ident}`)).status, ident).toBe(404);
    // The control sees all three, so the 404s above are the fence and not an empty fixture.
    const all = (await (await rest(widePat, '/api/radars')).json()) as { radars: unknown[] };
    expect(all.radars).toHaveLength(3);
    expect((await rest(widePat, `/api/radars/${openSlug}`)).status).toBe(200);
  });

  it('REST: blips, their stream, capture and the tag vocabulary', async () => {
    const stream = await rest(scopedPat, `/api/radars/${withheld}/blips`);
    expect(stream.status).toBe(404);
    const capture = await rest(scopedPat, `/api/radars/${withheld}/blips`, {
      method: 'POST',
      body: JSON.stringify({ body: 'smuggled' }),
    });
    expect(capture.status).toBe(404);
    const blips = (await (await rest(scopedPat, '/api/blips')).json()) as {
      items: Array<{ radarId: string }>;
    };
    expect(blips.items.map((b) => b.radarId)).toEqual([granted]);
    const tags = (await (await rest(scopedPat, '/api/blips/tags')).json()) as {
      tags: Array<{ tag: string }>;
    };
    expect(tags.tags.map((t) => t.tag)).toEqual(['shared-tag']);
  });

  it('REST: search, and the completions that name radars and people', async () => {
    const found = (await (await rest(scopedPat, '/api/search?q=zebra')).json()) as {
      items: Array<{ radarId: string }>;
    };
    expect(found.items.map((i) => i.radarId)).toEqual([granted]);
    const controlFound = (await (await rest(widePat, '/api/search?q=zebra')).json()) as {
      items: unknown[];
    };
    expect(controlFound.items).toHaveLength(3);
    // Naming a radar it was not given is not a way in.
    const named = await rest(
      scopedPat,
      `/api/search?q=${encodeURIComponent('in:"Withheld radar" zebra')}`,
    );
    const body = (await named.json()) as { items?: unknown[] };
    expect(body.items ?? []).toHaveLength(0);
    expect((await searchRadarNames(scopedActor)).map((r) => r.name)).toEqual(['Granted radar']);
    expect(await searchTopicNames(scopedActor)).toEqual([]);
  });

  it('readers: who a from: filter may name is derived from the clamped set', async () => {
    // bob reads only the withheld radar; the agent must not learn he exists.
    expect((await searchPeople(scopedActor)).map((p) => p.id)).not.toContain(bob.user.id);
    expect((await searchPeople(owner)).map((p) => p.id)).toContain(bob.user.id);
    const ids = await readableRadarIdsFor(scopedActor);
    expect(ids).toEqual([granted]);
    expect((await readersOfRadars(ids)).map((r) => r.id)).not.toContain(bob.user.id);
  });

  it('topics: none is reachable, the one a granted radar sits in included', async () => {
    expect((await rest(scopedPat, `/api/topics/${topicId}`)).status).toBe(404);
    expect(await listTopics(scopedActor)).toEqual([]);
    expect(await listTopics(owner)).toHaveLength(1);
    // And the radar is not filed under a topic the agent is not shown.
    const radars = await listRadars(scopedActor);
    expect(radars.map((r) => r.topic)).toEqual([null]);
    const access = await getRadarAccess(granted, scopedActor);
    expect(access?.topicVisible).toBe(false);
  });

  it('notifications: list, counts and mark-read stop at the grants', async () => {
    const listed = await listNotifications(scopedActor, {});
    expect(listed.items.map((n) => n.radar?.id)).toEqual([granted]);
    const counts = await notificationCounts(scopedActor);
    expect(counts).toMatchObject({ total: 1, byRadar: { [granted]: 1 } });
    // Marking everything read touches only what the agent can see.
    expect((await markRead(scopedActor, {})).updated).toBe(1);
    const unread = await getDb()
      .select({ radarId: schema.notifications.radarId, topicId: schema.notifications.topicId })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.agentId, scopedId), isNull(schema.notifications.readAt)));
    expect(unread).toHaveLength(2);
    expect(unread.some((n) => n.radarId === granted)).toBe(false);
    await getDb()
      .update(schema.notifications)
      .set({ readAt: null })
      .where(eq(schema.notifications.agentId, scopedId));
  });

  /* ------------------------------------ MCP ----------------------------------- */

  it('MCP: list_radars, read_radar, capture and search stop at the grants', async () => {
    const radars = data(await call(scoped, 'list_radars')) as Array<{ id: string }>;
    expect(radars.map((r) => r.id)).toEqual([granted]);
    expect((await call(scoped, 'read_radar', { radarId: granted })).error).toBe(false);
    for (const ident of [withheld, open, openSlug]) {
      const read = await call(scoped, 'read_radar', { radarId: ident });
      expect(read.error, ident).toBe(true);
      expect(read.text).toMatch(NOT_FOUND);
    }
    const made = await call(scoped, 'create_blip', { radarId: withheld, body: 'smuggled' });
    expect(made.error).toBe(true);
    expect(made.text).toMatch(NOT_FOUND);
    expect((await call(scoped, 'create_blip', { radarId: granted, body: 'allowed' })).error).toBe(
      false,
    );
    const search = await call(scoped, 'search_blips', { query: 'zebra' });
    expect(search.text).not.toContain('withheld');
    expect(search.text).not.toContain('open radar');
    expect(search.text).toContain('granted');
    expect((await call(control, 'search_blips', { query: 'zebra' })).text).toContain('withheld');
    const scopedByRadar = await call(scoped, 'search_blips', { radarId: withheld });
    expect(scopedByRadar.error).toBe(true);
  });

  it('MCP: tags, topics and notifications stop at the grants', async () => {
    const tags = data(await call(scoped, 'list_tags')) as { tags: Array<{ tag: string }> };
    expect(tags.tags.map((t) => t.tag).sort()).not.toContain('secret-tag');
    const topic = await call(scoped, 'read_array', { arrayId: topicId });
    expect(topic.error).toBe(true);
    expect(topic.text).toMatch(NOT_FOUND);
    expect(data(await call(scoped, 'list_arrays'))).toEqual([]);
    const notes = await call(scoped, 'list_notifications');
    expect(notes.text).not.toContain(withheld);
  });

  it('MCP: dashboards read through the clamp, and the saved ones are not an unclamped way in', async () => {
    const dashboard = await createDashboard(owner, 'Everything');
    await updateDashboard(owner, dashboard.id, {
      append: [
        { radarId: withheld },
        { radarId: null, config: { type: 'query', title: 'zebras', query: 'zebra', limit: 10 } },
      ],
    });
    const preview = await call(scoped, 'preview_dashboard_query', { query: 'zebra' });
    expect(preview.error, preview.text).toBe(false);
    expect(preview.text).toContain('granted');
    expect(preview.text).not.toContain('withheld');
    expect(preview.text).not.toContain('open radar');
    // The layout is the owner's: a limited agent neither lists it nor reads a saved widget.
    expect((await call(scoped, 'list_dashboards')).error).toBe(true);
    const [widget] = await getDb()
      .select({ id: schema.dashboardWidgets.id })
      .from(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id))
      .limit(1);
    const read = await call(scoped, 'preview_dashboard_query', {
      dashboardId: dashboard.id,
      widgetId: must(widget).id,
    });
    expect(read.error).toBe(true);
    expect((await call(control, 'list_dashboards')).error).toBe(false);
  });

  it('sweep: no tool, with or without a radar id, lets a canary from the withheld radar out', async () => {
    const canary = 'CANARY-' + randomToken(4);
    const blip = await createBlip(owner, withheld, {
      body: `${canary} blip in the withheld radar`,
    });
    const grantedBlip = await createBlip(owner, granted, { body: `${canary} movable` });
    await call(control, 'create_comment', { blipId: blip.id, body: `${canary} comment` });
    await call(control, 'create_webhook', { radarId: withheld, name: `${canary} hook` });
    await call(control, 'set_feed', {
      radarId: withheld,
      url: `https://example.com/${canary}.xml`,
    });
    await call(control, 'create_blip', { body: `${canary} in the drop box` });
    // Moving into the withheld radar is not a way to read it either.
    const sweep: Array<[string, Record<string, unknown>]> = [
      ['get_blip', { blipId: blip.id }],
      ['list_comments', { blipId: blip.id }],
      ['update_blip', { blipId: grantedBlip.id, radarId: withheld }],
      ['read_drop_box', {}],
      ['list_subscriptions', { radarId: withheld }],
      ['list_feeds', { radarId: withheld }],
      ['list_webhooks', { radarId: withheld }],
      ['get_notification_settings', {}],
      ['whoami', {}],
      ['list_agents', {}],
      ['list_notifications', {}],
      ['list_radar_members', { radarId: withheld }],
      ['read_radar', { radarId: withheld }],
      ['agent_activity', { agent: scopedId, kind: 'sharing' }],
      ['agent_activity', { agent: scopedId }],
    ];
    const secrets = [canary, withheld, 'Withheld radar', 'Secret topic', topicId];
    for (const [tool, args] of sweep) {
      const out = await call(scoped, tool, args);
      for (const secret of secrets)
        expect(out.text, `${tool} leaked ${secret}`).not.toContain(secret);
    }
    // And the moved blip really stayed where it was.
    const [kept] = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.id, grantedBlip.id));
    expect(kept?.radarId).toBe(granted);
    // The control sees every canary, so the sweep above is not passing on an empty fixture.
    expect((await call(control, 'get_blip', { blipId: blip.id })).text).toContain(canary);
    expect((await call(control, 'read_drop_box', {})).text).toContain(canary);
    expect(
      (await call(control, 'agent_activity', { agent: scopedId, kind: 'sharing' })).text,
    ).toContain('Secret topic');
    expect(await (await rest(widePat, `/api/repo-agents/${scopedId}/shares`)).text()).toContain(
      topicId,
    );

    for (const path of [
      `/api/blips/${blip.id}`,
      `/api/blips/${blip.id}/comments`,
      '/api/radars/drop-box',
      `/api/repo-agents/${scopedId}/shares`,
    ]) {
      const res = await rest(scopedPat, path);
      const text = await res.text();
      for (const secret of secrets) expect(text, `${path} leaked ${secret}`).not.toContain(secret);
    }
  });

  it('a read grant is read-only: it reads and says why it cannot write', async () => {
    const reader = await createRepoAgent(owner, { name: 'Reader', slug: 'reader', prompt: 'p' });
    await setAgentRadars(owner, reader.id, {
      scope: 'selected',
      grants: [{ radarId: granted, ceiling: 'read' }],
    });
    const client = await connect((await oauthFor(reader.id, 'omr_reader_app')).access);
    expect((await call(client, 'read_radar', { radarId: granted })).error).toBe(false);
    const write = await call(client, 'create_blip', { radarId: granted, body: 'nope' });
    expect(write.error).toBe(true);
    expect(write.text).toMatch(/read-only access to this radar/);
    expect(write.text).not.toMatch(/radars:write/);
    const comment = await call(client, 'create_comment', {
      blipId: must(
        (
          await getDb()
            .select({ id: schema.blips.id })
            .from(schema.blips)
            .where(eq(schema.blips.radarId, granted))
            .limit(1)
        )[0],
      ).id,
      body: 'a comment',
    });
    expect(comment.error).toBe(true);
  });

  it('the charter doors (edit_charter, reanchor, reanchor with dismiss) stop at the grants, over REST and MCP', async () => {
    const TEXT =
      '# Charter\n\nCommander holds all billing truth for plans.\n\nRunbooks name an owner.';
    /** An architecture radar with an ADR whose amended words have been edited away. */
    const orphaned = async (name: string) => {
      const id = (await createRadar(owner, { name, template: 'architecture' })).id;
      await writeCharter(owner, id, { markdown: TEXT, baseRevision: 0 });
      const { adr } = await proposeAdr(owner, id, {
        title: `Amend ${name}`,
        rationale: 'r',
        anchors: [{ quote: 'all billing truth', with: 'payment truth only' }],
      });
      await editCharter(owner, id, {
        edits: [{ find: 'all billing truth', replace: 'all of billing' }],
      });
      const [anchor] = await getDb()
        .select()
        .from(schema.charterAnchors)
        .where(eq(schema.charterAnchors.subjectId, adr.id));
      expect(must(anchor).state).toBe('orphaned');
      return { id, anchorId: must(anchor).id, adrId: adr.id };
    };
    const mine = await orphaned('Charter granted');
    const theirs = await orphaned('Charter withheld CANARY');
    const limited = await createRepoAgent(owner, {
      name: 'Charterer',
      slug: 'charterer',
      prompt: 'p',
    });
    await setAgentRadars(owner, limited.id, {
      scope: 'selected',
      grants: [{ radarId: mine.id, ceiling: 'write' }],
    });
    const readOnly = await createRepoAgent(owner, { name: 'Peeker', slug: 'peeker', prompt: 'p' });
    const peek = await orphaned('Charter for the reader');
    await setAgentRadars(owner, readOnly.id, {
      scope: 'selected',
      grants: [{ radarId: peek.id, ceiling: 'read' }],
    });
    const client = await connect((await oauthFor(limited.id, 'omr_charterer_app')).access);
    const peeker = await connect((await oauthFor(readOnly.id, 'omr_peeker_app')).access);
    const pat = must(
      (await createToken(owner, { name: 'charterer pat', agentId: limited.id })).token,
    );
    const stateOf = async (id: string) =>
      (
        await getDb().select().from(schema.charterAnchors).where(eq(schema.charterAnchors.id, id))
      )[0]?.state;
    const bodyOf = async (id: string) =>
      (
        await getDb()
          .select({ body: schema.charterDocuments.body })
          .from(schema.charterDocuments)
          .where(eq(schema.charterDocuments.radarId, id))
      )[0]?.body;
    const edits = [{ find: 'Runbooks name an owner.', replace: 'Runbooks name nobody.' }];
    const before = await bodyOf(theirs.id);

    // The withheld radar: nothing to find, nothing changed, nothing named in the refusal.
    for (const [tool, args] of [
      ['edit_charter', { radarId: theirs.id, edits }],
      ['reanchor', { anchorId: theirs.anchorId, quote: 'Runbooks name an owner.' }],
      ['reanchor', { anchorId: theirs.anchorId, dismiss: '' }],
    ] as const) {
      const refused = await call(client, tool, args);
      expect(refused.error, tool).toBe(true);
      expect(refused.text, tool).toMatch(NOT_FOUND);
      expect(refused.text, tool).not.toContain('CANARY');
      expect(refused.text, tool).not.toContain(theirs.id);
    }
    for (const [path, body] of [
      [`/api/radars/${theirs.id}/charter/edits`, { edits }],
      [`/api/anchors/${theirs.anchorId}/reanchor`, { quote: 'Runbooks name an owner.' }],
      [`/api/anchors/${theirs.anchorId}/dismiss`, {}],
    ] as const) {
      const res = await rest(pat, path, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('CANARY');
    }
    expect(await bodyOf(theirs.id)).toBe(before);
    expect(await stateOf(theirs.anchorId)).toBe('orphaned');
    // The same acts on the granted radar do work, so none of the above passed on a broken fixture.
    expect((await call(client, 'edit_charter', { radarId: mine.id, edits })).error).toBe(false);
    expect(
      (await call(client, 'reanchor', { anchorId: mine.anchorId, quote: 'Runbooks name nobody.' }))
        .error,
    ).toBe(false);
    expect(await stateOf(mine.anchorId)).toBe('anchored');
    // The control sees the withheld one, and can settle it.
    expect(
      (await call(control, 'reanchor', { anchorId: theirs.anchorId, dismiss: '' })).error,
    ).toBe(false);
    expect(await stateOf(theirs.anchorId)).toBe('dismissed');

    // A read grant reads the charter and cannot change it, by any of the three.
    expect((await call(peeker, 'read_architecture', { radarId: peek.id })).error).toBe(false);
    for (const [tool, args] of [
      ['edit_charter', { radarId: peek.id, edits }],
      ['reanchor', { anchorId: peek.anchorId, quote: 'Runbooks name an owner.' }],
      ['reanchor', { anchorId: peek.anchorId, dismiss: '' }],
    ] as const) {
      const refused = await call(peeker, tool, args);
      expect(refused.error, tool).toBe(true);
      expect(refused.text, tool).toMatch(/read-only access to this radar/);
    }
    expect(await stateOf(peek.anchorId)).toBe('orphaned');
    expect(await bodyOf(peek.id)).not.toContain('nobody');
  });

  it('the acts that name no radar are refused, so it cannot make itself one', async () => {
    for (const [tool, args] of [
      ['create_radar', { name: 'Mine now' }],
      ['create_array', { name: 'A topic' }],
      ['create_agent', { name: 'Offspring', prompt: 'p' }],
      ['create_dashboard', { name: 'Tab' }],
      ['create_blip', { body: 'a thought' }],
    ] as const) {
      const refused = await call(scoped, tool, args);
      expect(refused.error, tool).toBe(true);
      // A capture with no radar on an account that already has a drop box finds it a radar it was not given.
      expect(refused.text, tool).toMatch(
        tool === 'create_blip'
          ? /limited to selected radars|not found/
          : /limited to selected radars/,
      );
    }
    const made = await getDb()
      .select({ id: schema.radars.id })
      .from(schema.radars)
      .where(eq(schema.radars.name, 'Mine now'));
    expect(made).toHaveLength(0);
  });

  /* --------------------------------- widening --------------------------------- */

  it('widening: update_agent carries no scope, and an agent cannot set its own', async () => {
    const before = await updateRepoAgent(owner, scopedId, {});
    const viaTool = await call(scoped, 'update_agent', {
      agent: scopedId,
      description: 'sneaky',
      radarScope: 'all',
      radarGrants: [{ radarId: withheld, ceiling: 'manage' }],
    });
    expect(viaTool.error, viaTool.text).toBe(false);
    const [row] = await getDb().select().from(schema.agents).where(eq(schema.agents.id, scopedId));
    expect(row?.radarScope).toBe('selected');
    const grants = await getDb()
      .select()
      .from(schema.agentRadarGrants)
      .where(eq(schema.agentRadarGrants.agentId, scopedId));
    expect(grants.map((g) => g.radarId)).toEqual([granted]);
    expect(before.radarScope).toBe('selected');
    await updateRepoAgent(owner, scopedId, { description: '' });

    // The service refuses anything that is not a signed-in owner...
    await expect(
      setAgentRadars(scopedActor, scopedId, { scope: 'all', grants: [] }),
    ).rejects.toMatchObject({ status: 403 });
    // ...and so does the route, over the agent's own credential.
    const put = await rest(scopedPat, `/api/repo-agents/${scopedId}/radars`, {
      method: 'PUT',
      body: JSON.stringify({ scope: 'all', grants: [] }),
    });
    expect(put.status).toBe(403);
    // A recipient the agent is shared with cannot change what its owner chose.
    await shareAgent(owner, scopedId, { email: bob.user.email, preset: 'edit' });
    await expect(setAgentRadars(bob, scopedId, { scope: 'all', grants: [] })).rejects.toMatchObject(
      { status: expect.any(Number) as number },
    );
    expect(await requireRadarStatus(withheld, scopedActor)).toBe(404);
  });

  async function requireRadarStatus(radarId: string, actor: Actor) {
    try {
      await requireRadar(radarId, actor, 'read');
      return 200;
    } catch (err) {
      return (err as { status?: number }).status ?? 500;
    }
  }

  it('widening: a token cannot be minted under it, and the owner can only grant radars they read', async () => {
    const minted = await rest(scopedPat, '/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'widen me', agentId: wideId }),
    });
    expect(minted.status).toBe(403);
    await expect(
      createToken(scopedActor, { name: 'widen me', agentId: wideId }),
    ).rejects.toMatchObject({
      status: 403,
    });
    // A grant on a radar its owner cannot read is a 404, like any unreadable radar.
    const [stranger] = await getDb()
      .insert(schema.users)
      .values({ email: 'stranger@agent-scope.test', state: 'active' })
      .returning();
    const foreign = await createRadar(
      { user: must(stranger), kind: 'user' },
      { name: 'Not yours' },
    );
    await expect(
      setAgentRadars(owner, scopedId, {
        scope: 'selected',
        grants: [{ radarId: foreign.id, ceiling: 'read' }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    // The credential minted for the agent by its owner is still the narrow one.
    expect((await rest(scopedPat, `/api/radars/${withheld}`)).status).toBe(404);
  });

  it('widening: loading a wider agent through the limited connection sheds nothing', async () => {
    // `wide` is `all`. A limited connection loads it and writes as it: the limit rides along.
    const loaded = await scoped.callTool({ name: 'load_agent', arguments: { agent: wideId } });
    const blocks = loaded.content as Content;
    expect(loaded.isError, blocks[0]?.text).not.toBe(true);
    const { session } = JSON.parse(must(must(blocks[blocks.length - 1]).text)) as {
      session: string;
    };
    const refused = await call(scoped, 'create_blip', {
      radarId: withheld,
      body: 'as wide',
      session,
    });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(NOT_FOUND);
    const allowed = await call(scoped, 'create_blip', {
      radarId: granted,
      body: 'as wide',
      session,
    });
    expect(allowed.error, allowed.text).toBe(false);
    // The same session on an unscoped connection is unaffected by anyone's limit.
    const wideClient = await connect((await oauthFor(null, 'omr_wide_app')).access);
    const wide = await wideClient.callTool({ name: 'load_agent', arguments: { agent: wideId } });
    const wideBlocks = wide.content as Content;
    const wideSession = (
      JSON.parse(must(must(wideBlocks[wideBlocks.length - 1]).text)) as { session: string }
    ).session;
    expect(
      (
        await call(wideClient, 'create_blip', {
          radarId: withheld,
          body: 'ok',
          session: wideSession,
        })
      ).error,
    ).toBe(false);
  });

  it('a recipient running a shared limited agent is held to its limit, and to their own access', async () => {
    // The owner's choice follows the agent into the recipient's session writes (pinned: the
    // grants name the owner's radars, so the recipient reaches only those they can also read).
    const shared = await createRepoAgent(owner, { name: 'Shared', slug: 'shared', prompt: 'p' });
    await setAgentRadars(owner, shared.id, {
      scope: 'selected',
      grants: [{ radarId: granted, ceiling: 'write' }],
    });
    await shareAgent(owner, shared.id, { email: bob.user.email, preset: 'use' });
    await acceptShare(bob, shared.id);
    await shareRadar(owner, granted, bob.user.email, 'editor');
    const client = await connect((await oauthFor(null, 'omr_bob_app', false, bob)).access);
    const loaded = await client.callTool({ name: 'load_agent', arguments: { agent: shared.id } });
    const blocks = loaded.content as Content;
    const { session } = JSON.parse(must(must(blocks[blocks.length - 1]).text)) as {
      session: string;
    };
    // bob reads the withheld radar, but not as this agent.
    const asAgent = await call(client, 'create_blip', { radarId: withheld, body: 'x', session });
    expect(asAgent.text).toMatch(NOT_FOUND);
    expect(
      (await call(client, 'create_blip', { radarId: granted, body: 'ok', session })).error,
    ).toBe(false);
    // Loading narrowed his whole connection, with or without the session on the call.
    expect((await call(client, 'create_blip', { radarId: withheld, body: 'x' })).text).toMatch(
      NOT_FOUND,
    );
    // The recipient is not told which radars the owner chose.
    const seen = await call(client, 'get_agent_brief', { agent: shared.id, name: 'none' });
    expect(seen.text).not.toContain(granted);
  });

  it('load_agent of a limited agent narrows an unbound connection, reads and writes, for good', async () => {
    // A person's own sign-in (agent-setup login), not a credential minted for the agent.
    const client = await connect((await oauthFor(null, 'omr_login_app')).access);
    expect((data(await call(client, 'list_radars')) as unknown[]).length).toBeGreaterThan(1);
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(false);

    const loaded = await client.callTool({ name: 'load_agent', arguments: { agent: scopedId } });
    expect(loaded.isError).not.toBe(true);

    const radars = data(await call(client, 'list_radars')) as Array<{ id: string }>;
    expect(radars.map((r) => r.id)).toEqual([granted]);
    for (const ident of [withheld, open, openSlug]) {
      const read = await call(client, 'read_radar', { radarId: ident });
      expect(read.error, ident).toBe(true);
      expect(read.text).toMatch(NOT_FOUND);
    }
    const search = await call(client, 'search_blips', { query: 'zebra' });
    expect(search.text).toContain('granted');
    expect(search.text).not.toContain('withheld');
    expect((await call(client, 'read_radar', { radarId: granted })).error).toBe(false);

    // Loading a wider agent afterwards sheds nothing.
    const wide = await client.callTool({ name: 'load_agent', arguments: { agent: wideId } });
    expect(wide.isError).not.toBe(true);
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(true);

    // The owner lifting the limit lifts it for the connection; narrowing it again narrows it.
    await setAgentRadars(owner, scopedId, { scope: 'all', grants: [] });
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(false);
    await setAgentRadars(owner, scopedId, {
      scope: 'selected',
      grants: [{ radarId: granted, ceiling: 'write' }],
    });
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(true);
  });

  it('the limit is read on every request: narrowing it applies to the connection already open', async () => {
    const live = await createRepoAgent(owner, { name: 'Live', slug: 'live', prompt: 'p' });
    const client = await connect((await oauthFor(live.id, 'omr_live_app')).access);
    // `all`: the control case, the limit does not exist yet.
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(false);
    await setAgentRadars(owner, live.id, {
      scope: 'selected',
      grants: [{ radarId: granted, ceiling: 'read' }],
    });
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(true);
    expect((await call(client, 'read_radar', { radarId: granted })).error).toBe(false);
    await setAgentRadars(owner, live.id, { scope: 'selected', grants: [] });
    expect((await call(client, 'read_radar', { radarId: granted })).error).toBe(true);
    expect(data(await call(client, 'list_radars'))).toEqual([]);
    await setAgentRadars(owner, live.id, { scope: 'all', grants: [] });
    expect((await call(client, 'read_radar', { radarId: withheld })).error).toBe(false);
  });

  it('fenceCaps: the lowest ceiling wins, and a limit that cannot be read fails closed', async () => {
    const other = await createRepoAgent(owner, { name: 'Other', slug: 'other', prompt: 'p' });
    await setAgentRadars(owner, other.id, {
      scope: 'selected',
      grants: [
        { radarId: granted, ceiling: 'read' },
        { radarId: open, ceiling: 'manage' },
      ],
    });
    const both = { ...scopedActor, radarFence: [scopedId, other.id] };
    // Only `granted` is allowed by both, at the lower of write and read.
    expect([...must(await fenceCaps(both))]).toEqual([[granted, 'viewer']]);
    // An agent in the fence that no longer exists allows nothing.
    const ghost = {
      ...scopedActor,
      radarFence: [scopedId, '00000000-0000-4000-8000-00000000dead'],
    };
    expect(must(await fenceCaps(ghost)).size).toBe(0);
    expect(await fenceCaps({ ...scopedActor, radarFence: [wideId] })).toBeNull();
    expect(await fenceCaps(owner)).toBeNull();
  });

  /* ------------------------------------ admin ---------------------------------- */

  it('admin: the inventory lists agents and tokens, and nothing it should not', async () => {
    await getDb().insert(schema.repoAgentMemories).values({
      agentId: scopedId,
      name: 'memory-canary',
      type: 'reference',
      description: 'DESCRIPTION-CANARY',
      body: 'MEMORY-BODY-CANARY',
      source: 'agent',
    });
    const { agents } = await adminListAgents(platformAdmin);
    const row = agents.find((a) => a.id === scopedId);
    expect(row).toMatchObject({
      radarScope: 'selected',
      radarGrantCount: 1,
      owner: { email: owner.user.email },
    });
    expect(row?.liveTokens).toBeGreaterThanOrEqual(1);
    const { tokens } = await adminListTokens(platformAdmin);
    expect(tokens.some((t) => t.kind === 'pat' && t.id === scopedPatId)).toBe(true);
    expect(tokens.some((t) => t.kind === 'oauth' && t.id === 'omr_scoped_app')).toBe(true);

    // Over the wire, as the admin's browser gets it: every secret-shaped value is absent.
    const http = await Promise.all(
      ['/api/admin/agents', '/api/admin/tokens'].map(async (path) => {
        const res = await fetch(new URL(path, base), { headers: { cookie: adminCookie } });
        expect(res.status, path).toBe(200);
        return res.text();
      }),
    );
    const everything = http.join('\n');
    const [secrets] = await Promise.all([
      getDb()
        .select({
          hash: schema.apiTokens.tokenHash,
          prefix: schema.apiTokens.prefix,
        })
        .from(schema.apiTokens),
    ]);
    for (const s of secrets) {
      expect(everything).not.toContain(s.hash);
      expect(everything).not.toContain(s.prefix);
    }
    const oauth = await getDb().select().from(schema.oauthTokens);
    for (const t of oauth) {
      expect(everything).not.toContain(t.accessTokenHash);
      if (t.refreshTokenHash) expect(everything).not.toContain(t.refreshTokenHash);
    }
    expect(everything).not.toContain(scopedPat);
    for (const canary of ['MEMORY-BODY-CANARY', 'DESCRIPTION-CANARY', 'memory-canary'])
      expect(everything).not.toContain(canary);
    // The owner's radar names are the owner's; the console counts grants, it does not name them.
    expect(everything).not.toContain('Granted radar');
    expect(everything).not.toMatch(/token_?hash|refresh|previous|code_challenge/i);
  });

  it('admin: only a signed-in admin, never a token and never an ordinary account', async () => {
    for (const path of ['/api/admin/agents', '/api/admin/tokens']) {
      expect((await rest(scopedPat, path)).status, path).toBe(403);
      expect((await rest(widePat, path)).status, path).toBe(403);
      const plain = await fetch(new URL(path, base), {
        headers: { cookie: `${SESSION_COOKIE}=${(await createSession(owner.user)).token}` },
      });
      expect(plain.status, path).toBe(403);
    }
    const revoke = await rest(widePat, `/api/admin/agents/${wideId}/revoke`, { method: 'POST' });
    expect(revoke.status).toBe(403);
    await expect(adminRevokeAgent(owner, scopedId)).rejects.toMatchObject({ status: 403 });
    await expect(adminRevokeAgent(scopedActor, scopedId)).rejects.toMatchObject({ status: 403 });
    expect((await rest(scopedPat, '/api/radars')).status).toBe(200);
  });

  it('admin revoke: a live MCP session and a PAT stop at the next request', async () => {
    const agent = await createRepoAgent(owner, { name: 'Doomed', slug: 'doomed', prompt: 'p' });
    const pat = await createToken(owner, { name: 'doomed pat', agentId: agent.id });
    const { access } = await oauthFor(agent.id, 'omr_doomed_app');
    const session = await connect(access);
    expect((await call(session, 'list_radars')).error).toBe(false);
    expect((await rest(must(pat.token), '/api/radars')).status).toBe(200);

    await adminRevokeAgent(platformAdmin, agent.id);

    // The same MCP connection, still open: the next call is refused at the door.
    await expect(session.callTool({ name: 'list_radars', arguments: {} })).rejects.toThrow(
      /401|Authentication|authoriz/i,
    );
    expect((await rest(must(pat.token), '/api/radars')).status).toBe(401);
    // The agent itself stays; so do the owner's radars.
    const [stillThere] = await getDb()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, agent.id));
    expect(stillThere).toBeDefined();
    const audited = await getDb()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'admin.agent.revoke'),
          eq(schema.auditLog.subjectId, agent.id),
        ),
      );
    expect(audited).toHaveLength(1);
  });

  it('admin revoke: a single PAT, and one connected app of one person', async () => {
    const pat = await createToken(owner, { name: 'one pat' });
    expect((await rest(must(pat.token), '/api/radars')).status).toBe(200);
    await adminRevokePat(platformAdmin, pat.id);
    expect((await rest(must(pat.token), '/api/radars')).status).toBe(401);
    await expect(adminRevokePat(platformAdmin, pat.id)).rejects.toMatchObject({ status: 404 });

    const { access } = await oauthFor(null, 'omr_one_app');
    expect((await rest(access, '/api/radars')).status).toBe(200);
    await adminRevokeGrant(platformAdmin, owner.user.id, 'omr_one_app');
    expect((await rest(access, '/api/radars')).status).toBe(401);
    const bad = await fetch(new URL('/api/admin/agents/not-a-uuid/revoke', base), {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(bad.status).toBe(404);
  });

  it('admin revoke: an OAuth refresh already in flight mints nothing', async () => {
    const connection = must(process.env['DATABASE_URL']);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    const staging = new pg.Client({ connectionString: url.toString() });
    await staging.connect();
    try {
      for (let round = 0; round < 3; round += 1) {
        const agent = await createRepoAgent(owner, {
          name: `Race ${round}`,
          slug: `race-${round}`,
          prompt: 'p',
        });
        const clientId = `omr_refresh_race_${round}`;
        const { refresh } = await oauthFor(agent.id, clientId);
        // Hold the grant's lock, so the refresh is demonstrably in flight, past its lookup
        // and queued on the lock, when the admin's revoke arrives behind it.
        await staging.query('BEGIN');
        await staging.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `oauth-grant:${owner.user.id}:${clientId}`,
        ]);
        const refreshing = fetch(new URL('/oauth/token', base), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh,
          }).toString(),
        });
        await waitFor(async () => (await blockedBehind(staging)) >= 1);
        const revoking = adminRevokeAgent(platformAdmin, agent.id);
        await waitFor(async () => (await blockedBehind(staging)) >= 2);
        await staging.query('COMMIT');
        const [response] = await Promise.all([refreshing, revoking]);
        expect([200, 400], `round ${round}`).toContain(response.status);
        const live = await getDb()
          .select({ id: schema.oauthTokens.id })
          .from(schema.oauthTokens)
          .where(
            and(eq(schema.oauthTokens.clientId, clientId), isNull(schema.oauthTokens.revokedAt)),
          );
        expect(live, `round ${round}: refresh answered ${response.status}`).toHaveLength(0);
        if (response.status === 200) {
          // It rotated first; the token it issued is dead on arrival.
          const issued = (await response.json()) as { access_token: string };
          expect((await rest(issued.access_token, '/api/radars')).status).toBe(401);
        }
      }
    } finally {
      await staging.end();
    }
    expect(typeof lockGrant).toBe('function');
  });

  /* ------------------------- Codex round 1 ------------------------- */

  it('load_agent: the unread mentions of a limited agent stop at its grants', async () => {
    const mention = (agentId: string, radarId: string, subject: string) =>
      getDb()
        .insert(schema.notifications)
        .values({
          userId: owner.user.id,
          agentId,
          radarId,
          kind: 'mention',
          groupKey: `agent:${agentId}:${randomToken(6)}`,
          subject,
          excerpt: `${subject} excerpt`,
        });
    await mention(scopedId, granted, 'MENTION-GRANTED');
    await mention(scopedId, withheld, 'MENTION-WITHHELD-CANARY');
    const nothing = await createRepoAgent(owner, { name: 'Nothing', slug: 'nothing', prompt: 'p' });
    await setAgentRadars(owner, nothing.id, { scope: 'selected', grants: [] });
    await mention(nothing.id, granted, 'MENTION-ZERO-GRANTS-CANARY');
    await mention(wideId, withheld, 'MENTION-WIDE-UNCHANGED');

    // From a person's own unbound connection, and from one minted for the agent.
    const unbound = await connect((await oauthFor(null, 'omr_mentions_app')).access);
    const own = await call(unbound, 'load_agent', { agent: scopedId });
    expect(own.error).toBe(false);
    expect(own.text).toContain('MENTION-GRANTED');
    expect(own.text).not.toContain('MENTION-WITHHELD-CANARY');
    expect(own.text).not.toContain(withheld);
    const bound = await call(scoped, 'load_agent', { agent: scopedId });
    expect(bound.text).toContain('MENTION-GRANTED');
    expect(bound.text).not.toContain('MENTION-WITHHELD-CANARY');
    expect(bound.text).toMatch(/Mentioned since[^\n]*\b\d+ unread/);

    // No grants, no mentions at all.
    const empty = await call(
      await connect((await oauthFor(null, 'omr_mentions_zero')).access),
      'load_agent',
      {
        agent: nothing.id,
      },
    );
    expect(empty.text).not.toContain('MENTION-ZERO-GRANTS-CANARY');
    expect(empty.text).not.toContain('Mentioned since');

    // Today's behaviour for an unlimited agent: every one of its mentions.
    const wide = await call(
      await connect((await oauthFor(null, 'omr_mentions_wide')).access),
      'load_agent',
      {
        agent: wideId,
      },
    );
    expect(wide.text).toContain('MENTION-WIDE-UNCHANGED');
  });

  /** A limited agent, a person's own connection that loads it, and the way to tell it is fenced. */
  async function limitedAgentWithLoader(slug: string) {
    const agent = await createRepoAgent(owner, { name: slug, slug, prompt: 'p' });
    await setAgentRadars(owner, agent.id, {
      scope: 'selected',
      grants: [{ radarId: granted, ceiling: 'write' }],
    });
    const oauth = await oauthFor(null, `omr_${slug}_app`);
    const mcp = await connect(oauth.access);
    const pat = must((await createToken(owner, { name: `${slug} pat` })).token);
    expect((await call(mcp, 'load_agent', { agent: agent.id })).error).toBe(false);
    // The PAT loads over REST? Loading is an MCP act; a second MCP connection on the PAT.
    const patMcp = await connect(pat);
    expect((await call(patMcp, 'load_agent', { agent: agent.id })).error).toBe(false);
    const fenced = async (client: Client) =>
      (await call(client, 'read_radar', { radarId: withheld })).error;
    return { agent, oauth, pat, mcp, patMcp, fenced };
  }

  it('the narrowing outlives the load session: idle days and deleted sessions change nothing', async () => {
    const { agent, oauth, pat, mcp, patMcp, fenced } = await limitedAgentWithLoader('sticky');
    expect(await fenced(mcp)).toBe(true);
    expect(await fenced(patMcp)).toBe(true);

    // Seven idle days (and then some) on the load session.
    await getDb()
      .update(schema.repoAgentSessions)
      .set({ lastSeenAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(schema.repoAgentSessions.agentId, agent.id));
    expect(await fenced(mcp)).toBe(true);
    expect((await rest(oauth.access, `/api/radars/${withheld}`)).status).toBe(404);
    expect((await rest(pat, `/api/radars/${withheld}`)).status).toBe(404);

    // The sessions gone altogether, as a revoke leaves them.
    await getDb()
      .delete(schema.repoAgentSessions)
      .where(eq(schema.repoAgentSessions.agentId, agent.id));
    expect(await fenced(mcp)).toBe(true);
    expect(await fenced(patMcp)).toBe(true);
    expect((await rest(oauth.access, `/api/radars/${withheld}`)).status).toBe(404);

    // Only its owner lifting the limit lifts it.
    await setAgentRadars(owner, agent.id, { scope: 'all', grants: [] });
    expect(await fenced(mcp)).toBe(false);
    expect((await rest(pat, `/api/radars/${withheld}`)).status).toBe(200);
  });

  it('admin revoke of a limited agent disconnects the connections that ran it, never widening one', async () => {
    const { agent, oauth, pat, mcp, patMcp, fenced } = await limitedAgentWithLoader('carrier');
    const { agents } = await adminListAgents(platformAdmin);
    expect(agents.find((a) => a.id === agent.id)).toMatchObject({
      fencedConnections: 2,
      liveSessions: 2,
    });

    await adminRevokeAgent(platformAdmin, agent.id);

    // Not one of them is left standing, so none is left wider than it was.
    expect((await rest(oauth.access, '/api/radars')).status).toBe(401);
    expect((await rest(pat, '/api/radars')).status).toBe(401);
    await expect(fenced(mcp)).rejects.toThrow(/401|Authentication|authoriz/i);
    await expect(fenced(patMcp)).rejects.toThrow(/401|Authentication|authoriz/i);
    const [audit] = await getDb()
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'admin.agent.revoke'),
          eq(schema.auditLog.subjectId, agent.id),
        ),
      );
    expect(audit?.meta).toMatchObject({ connections: 2 });
    // Another person's connection that never ran it is untouched.
    expect((await rest(scopedPat, '/api/radars')).status).toBe(200);
  });

  it('a connection that ran an agent later set to all is not disconnected by revoking it', async () => {
    const { agent, pat } = await limitedAgentWithLoader('lifted');
    await setAgentRadars(owner, agent.id, { scope: 'all', grants: [] });
    await adminRevokeAgent(platformAdmin, agent.id);
    expect((await rest(pat, '/api/radars')).status).toBe(200);
  });

  it('setAgentRadars: ownership is checked again once the agent is locked', async () => {
    const connection = must(process.env['DATABASE_URL']);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    const staging = new pg.Client({ connectionString: url.toString() });
    await staging.connect();
    try {
      const agent = await createRepoAgent(owner, { name: 'Handed', slug: 'handed', prompt: 'p' });
      await staging.query('BEGIN');
      await staging.query('SELECT 1 FROM agents WHERE id = $1 FOR UPDATE', [agent.id]);
      const setting = setAgentRadars(owner, agent.id, {
        scope: 'selected',
        grants: [{ radarId: granted, ceiling: 'manage' }],
      });
      const outcome = setting.then(
        () => 'set',
        (error: unknown) => `refused ${(error as { status?: number }).status ?? '?'}`,
      );
      await waitFor(async () => (await blockedBehind(staging)) >= 1);
      await staging.query('UPDATE agents SET owner_id = $1 WHERE id = $2', [bob.user.id, agent.id]);
      await staging.query('COMMIT');
      expect(await outcome).toBe('refused 404');
      const [row] = await getDb()
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, agent.id));
      expect(row?.radarScope).toBe('all');
      const grants = await getDb()
        .select()
        .from(schema.agentRadarGrants)
        .where(eq(schema.agentRadarGrants.agentId, agent.id));
      expect(grants).toHaveLength(0);
    } finally {
      await staging.end();
    }
  });

  it('list_radar_members: a limited connection is not told the topic a member came through', async () => {
    // Somebody who is on the radar only because the topic cascades to it.
    const [carol] = await getDb()
      .insert(schema.users)
      .values({ email: 'carol@agent-scope.test', state: 'active', name: 'carol' })
      .returning();
    await shareTopic(owner, topicId, 'carol@agent-scope.test', 'viewer');
    try {
      const members = async (client: Client) => {
        const result = await call(client, 'list_radar_members', { radarId: granted });
        expect(result.error).toBe(false);
        return result;
      };
      const open = await members(control);
      expect(open.text).toContain('Secret topic');
      const limited = await members(scoped);
      expect(limited.text).not.toContain('Secret topic');
      expect(limited.text).not.toContain(topicId);
      expect(limited.text).toContain('carol@agent-scope.test');
      const viaRest = await (await rest(scopedPat, `/api/radars/${granted}/members`)).text();
      expect(viaRest).not.toContain('Secret topic');
      expect(viaRest).not.toContain(topicId);
    } finally {
      await removeTopicMember(owner, topicId, must(carol).id);
    }
  });

  it('admin inventory: pages, searches, and says how many there are', async () => {
    const before = (await adminListAgents(platformAdmin)).total;
    // Past the per-owner quota, so straight into the table.
    await getDb()
      .insert(schema.agents)
      .values(
        Array.from({ length: 103 }, (_, i) => ({
          ownerId: bob.user.id,
          name: `Bulk ${i}`,
          slug: `bulk-${i}`,
        })),
      );
    const first = await adminListAgents(platformAdmin);
    expect(first.total).toBe(before + 103);
    expect(first.agents).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await adminListAgents(platformAdmin, { cursor: must(first.nextCursor) });
    const seen = new Set([...first.agents, ...second.agents].map((a) => a.id));
    expect(seen.size).toBe(first.agents.length + second.agents.length);
    expect(first.agents.length + second.agents.length).toBeGreaterThan(100);
    const found = await adminListAgents(platformAdmin, { q: 'bulk-7' });
    expect(found.agents.map((a) => a.handle)).toContain('bulk-7');
    expect(found.total).toBeLessThan(first.total);
    const over = await fetch(new URL('/api/admin/agents?q=bulk-9', base), {
      headers: { cookie: adminCookie },
    });
    expect(((await over.json()) as { total: number }).total).toBeGreaterThan(0);
    await getDb().delete(schema.agents).where(like(schema.agents.slug, 'bulk-%'));
  });

  it('admin inventory: a busy connected app is one row, and the 501st token is still reachable', async () => {
    // One app with many rotations is one grant, deduplicated before the page is cut.
    for (let i = 0; i < 5; i += 1) await oauthFor(null, 'omr_busy_app');
    for (let i = 0; i < 101; i += 1) await createToken(owner, { name: `many ${i}` });
    const first = await adminListTokens(platformAdmin);
    expect(
      first.tokens.filter((t) => t.kind === 'oauth' && t.id === 'omr_busy_app').length,
    ).toBeLessThanOrEqual(1);
    expect(first.tokens).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await adminListTokens(platformAdmin, { cursor: must(first.nextCursor) });
    const keys = [...first.tokens, ...second.tokens].map((t) => `${t.kind}:${t.owner.id}:${t.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(first.total).toBeGreaterThan(100);
    const named = await adminListTokens(platformAdmin, { q: 'many 100' });
    expect(named.tokens.map((t) => t.name)).toContain('many 100');
    expect(named.total).toBe(1);
  });

  /* ------------------------- Codex round 2 ------------------------- */

  /** A second connection for the staged races, holding the agent row's lock on request. */
  async function staging() {
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  it('sharing metadata: a limited connection is told of no topic share, even with no grants', async () => {
    const nothing = await createRepoAgent(owner, { name: 'Zero', slug: 'zero', prompt: 'p' });
    await shareAgent(owner, nothing.id, { topicId, prompt: 'view' });
    await setAgentRadars(owner, nothing.id, { scope: 'selected', grants: [] });
    const zero = await connect((await oauthFor(nothing.id, 'omr_zero_app')).access);
    for (const [client, id] of [
      [scoped, scopedId],
      [zero, nothing.id],
    ] as const) {
      for (const kind of ['sharing', 'all']) {
        const out = await call(client, 'agent_activity', { agent: id, kind });
        expect(out.error, `${id} ${kind}`).toBe(false);
        expect(out.text).not.toContain('Secret topic');
        expect(out.text).not.toContain(topicId);
      }
    }
    const pat = must((await createToken(owner, { name: 'zero pat', agentId: nothing.id })).token);
    const shares = await rest(pat, `/api/repo-agents/${nothing.id}/shares`);
    expect(shares.status).toBe(200);
    const text = await shares.text();
    expect(text).not.toContain(topicId);
    expect(text).not.toContain('Secret topic');
    expect(text).not.toMatch(/memberCount"?:\s*[1-9]/);
    // The owner's own screen still lists it.
    expect((await listShares(owner, nothing.id)).map((x) => x.subjectId)).toEqual([topicId]);
    expect(
      (await call(control, 'agent_activity', { agent: nothing.id, kind: 'sharing' })).text,
    ).toContain('Secret topic');
  });

  it('load_agent waits for the agent lock, so a carrier is never recorded behind a revoke or a delete', async () => {
    const hold = await staging();
    try {
      const agent = await createRepoAgent(owner, { name: 'Raced', slug: 'raced', prompt: 'p' });
      await setAgentRadars(owner, agent.id, {
        scope: 'selected',
        grants: [{ radarId: granted, ceiling: 'write' }],
      });
      const oauth = await oauthFor(null, 'omr_raced_app');
      const mcp = await connect(oauth.access);

      // A revoke or delete holds the agent row, past having read its carriers.
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM agents WHERE id = $1 FOR NO KEY UPDATE', [agent.id]);
      let settled = false;
      const loading = call(mcp, 'load_agent', { agent: agent.id }).finally(() => {
        settled = true;
      });
      await waitFor(async () => (await blockedBehind(hold)) >= 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled, 'load_agent must wait for the lock').toBe(false);

      // The delete commits first: the load finds no agent, and no carrier is left behind.
      await hold.query('DELETE FROM connection_agent_fences WHERE agent_id = $1', [agent.id]);
      await hold.query('DELETE FROM agents WHERE id = $1', [agent.id]);
      await hold.query('COMMIT');
      const result = await loading;
      expect(result.error).toBe(true);
      const carriers = await getDb()
        .select({ id: schema.connectionAgentFences.id })
        .from(schema.connectionAgentFences)
        .where(eq(schema.connectionAgentFences.connectionId, 'omr_raced_app'));
      expect(carriers).toHaveLength(0);
    } finally {
      await hold.end();
    }
  });

  it('revoke-all waits for a load in flight, and then revokes the carrier it recorded', async () => {
    const hold = await staging();
    try {
      const agent = await createRepoAgent(owner, { name: 'Raced2', slug: 'raced-2', prompt: 'p' });
      await setAgentRadars(owner, agent.id, {
        scope: 'selected',
        grants: [{ radarId: granted, ceiling: 'write' }],
      });
      const oauth = await oauthFor(null, 'omr_raced2_app');
      const mcp = await connect(oauth.access);
      // A load holds the agent row (as startSession does, between locking and committing).
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM agents WHERE id = $1 FOR NO KEY UPDATE', [agent.id]);
      await hold.query(
        `INSERT INTO connection_agent_fences (user_id, connection_kind, connection_id, agent_id)
         VALUES ($1, 'oauth', 'omr_raced2_app', $2)`,
        [owner.user.id, agent.id],
      );
      let settled = false;
      const revoking = adminRevokeAgent(platformAdmin, agent.id).finally(() => {
        settled = true;
      });
      await waitFor(async () => (await blockedBehind(hold)) >= 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled, 'revoke-all must wait for the lock').toBe(false);
      await hold.query('COMMIT');
      await revoking;
      // The carrier the load recorded was seen by the revoke, not missed by its snapshot.
      expect((await rest(oauth.access, '/api/radars')).status).toBe(401);
      await expect(call(mcp, 'list_radars')).rejects.toThrow(/401|Authentication|authoriz/i);
    } finally {
      await hold.end();
    }
  });

  it('a credential that was limited by an agent that is gone is refused, never unrestricted', async () => {
    const { agent, oauth, pat } = await limitedAgentWithLoader('vanished');
    expect((await rest(oauth.access, `/api/radars/${withheld}`)).status).toBe(404);
    // A raw delete, the way nothing in the application does it: the fence row survives as a
    // tombstone instead of cascading away.
    await getDb().execute(sql`DELETE FROM agents WHERE id = ${agent.id}::uuid`);
    expect((await rest(oauth.access, '/api/radars')).status).toBe(401);
    expect((await rest(pat, '/api/radars')).status).toBe(401);
    // Somebody who only ever loaded an unlimited agent is not locked out by deleting it.
    const wideOne = await createRepoAgent(owner, { name: 'Roomy', slug: 'roomy', prompt: 'p' });
    const own = await oauthFor(null, 'omr_roomy_app');
    const client = await connect(own.access);
    expect((await call(client, 'load_agent', { agent: wideOne.id })).error).toBe(false);
    await deleteRepoAgent(owner, wideOne.id);
    expect((await rest(own.access, '/api/radars')).status).toBe(200);
  });

  it('deleting a limited agent disconnects the connections that ran it', async () => {
    const { agent, oauth, pat } = await limitedAgentWithLoader('erased');
    await deleteRepoAgent(owner, agent.id);
    expect((await rest(oauth.access, '/api/radars')).status).toBe(401);
    expect((await rest(pat, '/api/radars')).status).toBe(401);
  });

  it('deleting an agent revokes through the same door', async () => {
    const agent = await createRepoAgent(owner, { name: 'Deleted', slug: 'deleted', prompt: 'p' });
    const pat = await createToken(owner, { name: 'deleted pat', agentId: agent.id });
    await deleteRepoAgent(owner, agent.id);
    expect((await rest(must(pat.token), '/api/radars')).status).toBe(401);
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached');
}

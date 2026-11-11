/** Dashboard tools through real HTTP, bearer scopes and the shared Postgres services. */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { httpTransport } from './test-client.js';
import type { DashboardDto, SearchResultDto, WidgetLayout } from '@onmyradar/contract';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from '../services/blips.js';
import { createRadar, removeMember, shareRadar } from '../services/radars.js';
import { must } from '../errors.js';

const queryWidget = (query: string): WidgetLayout => ({
  radarId: null,
  x: 0,
  y: 0,
  w: 6,
  h: 8,
  config: { type: 'query', title: 'Live work', query, limit: 12 },
});

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

describe.skipIf(!process.env['DATABASE_URL'])('dashboard tools over MCP', () => {
  const database = `omr_mcp_dashboards_${Date.now()}`;
  let admin: pg.Pool | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  const clients: Client[] = [];
  let owner: Actor;
  let other: Actor;
  let writer: Client;
  let reader: Client;
  let outsider: Client;

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
        SESSION_SECRET: 'dashboard-mcp-test-secret-not-used-in-production',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    for (const label of ['owner', 'other']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@dashboard-mcp.test`, state: 'active' })
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
          clientId: 'omr_dashboard_test',
          userId: actor.user.id,
          scope,
          scopeConsented: true,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      const client = new Client({ name: 'dashboard-regression', version: '1' });
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

  it('discovers complete widget schemas and the replacement semantics', async () => {
    const { tools } = await writer.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'list_dashboards',
        'create_dashboard',
        'update_dashboard',
        'delete_dashboard',
        'preview_dashboard_query',
      ]),
    );
    const update = must(tools.find((tool) => tool.name === 'update_dashboard'));
    expect(update.description).toContain('REPLACES THE ENTIRE LAYOUT');
    expect(JSON.stringify(update.inputSchema)).toContain('radarId');
    expect(JSON.stringify(update.inputSchema)).toContain('query');
    expect(update.annotations?.destructiveHint).toBe(true);
  });

  it('builds, rearranges and removes a dashboard while preserving its source blips', async () => {
    const a = await createRadar(owner, { name: 'MCP Work' });
    const b = await createRadar(owner, { name: 'MCP Reading' });
    const blip = await createBlip(owner, a.id, { body: 'Keep this source thought #mcpdash' });
    await createBlip(owner, b.id, { body: 'Another source thought #mcpdash' });
    const query = 'in:"MCP Work" in:"MCP Reading" tag:mcpdash';
    const preview = await data<SearchResultDto>(writer, 'preview_dashboard_query', { query });
    expect(preview.items).toHaveLength(2);
    const tab = await data<DashboardDto>(writer, 'create_dashboard', { name: 'Agent workspace' });
    const saved = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: tab.revision,
      widgets: [queryWidget(query), { radarId: a.id, x: 6, y: 0, w: 6, h: 8 }],
    });
    const widget = must(saved.widgets.find((item) => item.config.type === 'query'));
    const moved = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: saved.revision,
      name: 'Organised workspace',
      widgets: saved.widgets.map((item) => ({ ...item, y: 2 })),
    });
    expect(moved.widgets.map((item) => item.id).sort()).toEqual(
      saved.widgets.map((item) => item.id).sort(),
    );
    const results = await data<SearchResultDto>(reader, 'preview_dashboard_query', {
      dashboardId: tab.id,
      widgetId: widget.id,
    });
    expect(results.items.map((item) => item.id)).toContain(blip.id);
    expect(
      (await data<DashboardDto[]>(reader, 'list_dashboards')).find((item) => item.id === tab.id)
        ?.name,
    ).toBe('Organised workspace');
    await data(writer, 'delete_dashboard', { dashboardId: tab.id });
    expect(
      (await data<DashboardDto[]>(writer, 'list_dashboards')).some((item) => item.id === tab.id),
    ).toBe(false);
    expect(
      (await data<SearchResultDto>(writer, 'preview_dashboard_query', { query })).items,
    ).toHaveLength(2);
  });

  it('enforces token ceilings and owner isolation on every dashboard operation', async () => {
    const tab = await data<DashboardDto>(writer, 'create_dashboard', { name: 'Private tab' });
    const saved = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: tab.revision,
      widgets: [queryWidget('')],
    });
    for (const [name, args] of [
      ['create_dashboard', { name: 'Forbidden' }],
      ['update_dashboard', { dashboardId: tab.id, name: 'Forbidden' }],
      ['delete_dashboard', { dashboardId: tab.id }],
    ] as const) {
      const result = await call(reader, name, args);
      expect(result.error).toBe(true);
      expect(result.text).toContain('radars:write');
    }
    expect(await data<DashboardDto[]>(outsider, 'list_dashboards')).toEqual([]);
    for (const [name, args] of [
      ['update_dashboard', { dashboardId: tab.id, name: 'Stolen' }],
      ['delete_dashboard', { dashboardId: tab.id }],
      ['preview_dashboard_query', { dashboardId: tab.id, widgetId: must(saved.widgets[0]).id }],
    ] as const) {
      const result = await call(outsider, name, args);
      expect(result.error).toBe(true);
      expect(result.text).toBe('Dashboard not found');
    }
    expect(
      (await data<DashboardDto[]>(writer, 'list_dashboards')).find((item) => item.id === tab.id)
        ?.name,
    ).toBe('Private tab');
  });

  it('refuses malformed layouts and unresolved queries without altering the saved tab', async () => {
    const tab = await data<DashboardDto>(writer, 'create_dashboard', { name: 'Unchanged' });
    const saved = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: tab.revision,
      widgets: [queryWidget('')],
    });
    const another = await data<DashboardDto>(writer, 'create_dashboard', { name: 'Another' });
    const preview = await data<SearchResultDto>(writer, 'preview_dashboard_query', {
      query: 'is:blue',
    });
    expect(preview.problems.length).toBeGreaterThan(0);
    for (const input of [
      { widgets: [queryWidget('is:blue')] },
      { widgets: [{ ...queryWidget(''), x: 10, w: 6 }] },
      { widgets: [{ ...queryWidget(''), w: 1, h: 1 }] },
      { widgets: [queryWidget(''), { ...queryWidget(''), x: 2, y: 2 }] },
      { widgets: [{ ...queryWidget(''), radarId: owner.user.id }] },
      { widgets: Array.from({ length: 13 }, () => queryWidget('')) },
      { widgets: [saved.widgets[0], saved.widgets[0]] },
      {},
    ]) {
      const result = await call(writer, 'update_dashboard', {
        dashboardId: tab.id,
        expectedRevision: saved.revision,
        ...input,
      });
      expect(result.error, result.text).toBe(true);
    }
    expect(
      (
        await call(writer, 'update_dashboard', {
          dashboardId: another.id,
          expectedRevision: another.revision,
          widgets: saved.widgets,
        })
      ).error,
    ).toBe(true);
    expect(
      (await data<DashboardDto[]>(writer, 'list_dashboards')).find((item) => item.id === tab.id),
    ).toEqual(saved);
  });

  it('rechecks radar access when an existing saved query runs', async () => {
    const radar = await createRadar(other, { name: 'Temporary collaboration' });
    await createBlip(other, radar.id, { body: 'Visible only while shared' });
    await shareRadar(other, radar.id, owner.user.email, 'viewer');
    const tab = await data<DashboardDto>(writer, 'create_dashboard', { name: 'Shared source' });
    const saved = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: tab.revision,
      widgets: [queryWidget(`in:${radar.id}`)],
    });
    const args = { dashboardId: tab.id, widgetId: must(saved.widgets[0]).id };
    expect(
      (await data<SearchResultDto>(reader, 'preview_dashboard_query', args)).items,
    ).toHaveLength(1);
    await removeMember(other, radar.id, owner.user.id);
    const after = await data<SearchResultDto>(reader, 'preview_dashboard_query', args);
    expect(after.items).toEqual([]);
    expect(after.unresolved).toBe(true);
  });
  it('appends aggregate tiles, patches individual widgets and rejects stale replacements through MCP', async () => {
    const radar = await createRadar(owner, { name: 'Aggregate MCP source' });
    await createBlip(owner, radar.id, { body: 'First aggregate blip #patchmcp' });
    await createBlip(owner, radar.id, { body: 'Second aggregate blip #patchmcp' });
    const tab = await data<DashboardDto>(writer, 'create_dashboard', {
      name: 'Safe agent patches',
    });
    const first = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      append: [
        {
          radarId: null,
          config: {
            type: 'query',
            title: 'Count',
            query: 'tag:patchmcp',
            display: 'count',
            limit: 1,
          },
        },
      ],
    });
    const tile = must(first.widgets[0]);
    const count = await data<{ total: number; items: unknown[] }>(
      reader,
      'preview_dashboard_query',
      {
        dashboardId: tab.id,
        widgetId: tile.id,
      },
    );
    expect(count.total).toBe(2);
    expect(count.items).toEqual([]);
    const second = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      operations: [
        { op: 'add', widget: { radarId: radar.id } },
        {
          op: 'update',
          id: tile.id,
          config: {
            type: 'query',
            title: 'By project',
            query: 'tag:patchmcp',
            display: 'list',
            groupByRadar: true,
            limit: 1,
          },
        },
        { op: 'move', id: tile.id, x: 6, y: 8, w: 6, h: 8 },
      ],
    });
    expect(second.widgets).toHaveLength(2);
    const grouped = await data<{
      total: number;
      items: unknown[];
      radarGroups: Array<{ total: number }>;
    }>(reader, 'preview_dashboard_query', { dashboardId: tab.id, widgetId: tile.id });
    expect(grouped.total).toBe(2);
    expect(grouped.items).toHaveLength(1);
    expect(must(grouped.radarGroups[0]).total).toBe(2);
    const missing = await call(writer, 'update_dashboard', { dashboardId: tab.id, widgets: [] });
    expect(missing.error).toBe(true);
    expect(missing.text).toContain('expectedRevision');
    const unknownMode = await call(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: second.revision,
      widgets: [],
      mode: 'append',
    });
    expect(unknownMode.error).toBe(true);
    expect(unknownMode.text).toMatch(/Unrecognized|unrecognized/);
    const stale = await call(writer, 'update_dashboard', {
      dashboardId: tab.id,
      expectedRevision: first.revision,
      widgets: [],
    });
    expect(stale.error).toBe(true);
    expect(stale.text).toContain('changed since');
    expect(
      (await data<DashboardDto[]>(writer, 'list_dashboards')).find((item) => item.id === tab.id),
    ).toEqual(second);
    expect(
      (
        await call(reader, 'update_dashboard', {
          dashboardId: tab.id,
          append: [{ radarId: radar.id }],
        })
      ).error,
    ).toBe(true);
    const removed = await data<DashboardDto>(writer, 'update_dashboard', {
      dashboardId: tab.id,
      operations: [{ op: 'remove', id: tile.id }],
    });
    expect(removed.widgets.map((widget) => widget.radarId)).toEqual([radar.id]);
    const chart = await data<{
      activity: Array<{ date: string; count: number }>;
      activityRange: { days: number };
    }>(reader, 'preview_dashboard_query', {
      query: 'tag:patchmcp',
      display: 'activity',
      activityDays: 7,
    });
    expect(chart.activity).toHaveLength(7);
    expect(chart.activity.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
    const lanes = await data<{ laneGroups: unknown[]; total: number }>(
      reader,
      'preview_dashboard_query',
      { query: 'tag:patchmcp', display: 'lanes' },
    );
    expect(lanes.total).toBe(2);
    expect(lanes.laneGroups.length).toBeGreaterThan(0);
  });
});

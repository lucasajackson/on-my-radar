import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateDashboardSchema, type WidgetLayout } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import { createBlip } from './blips.js';
import { createRadar, shareRadar, removeMember } from './radars.js';
import {
  listDashboards,
  createDashboard,
  updateDashboard,
  previewDashboardQuery,
  dashboardWidgetResults,
} from './dashboards.js';
import { must } from '../errors.js';

const queryWidget = (query: string): WidgetLayout => ({
  radarId: null,
  x: 0,
  y: 0,
  w: 6,
  h: 8,
  config: { type: 'query', title: 'My live work', query, limit: 12 },
});

describe('dashboard query validation', () => {
  it('refuses unknown update modes rather than interpreting them as replacement', () => {
    expect(
      updateDashboardSchema.safeParse({ widgets: [], expectedRevision: 0, mode: 'append' }).success,
    ).toBe(false);
  });
  it('distinguishes a composite query from a single radar and bounds results', () => {
    expect(updateDashboardSchema.safeParse({ widgets: [queryWidget('is:active')] }).success).toBe(
      true,
    );
    expect(
      updateDashboardSchema.safeParse({ widgets: [{ ...queryWidget(''), radarId: randomUUID() }] })
        .success,
    ).toBe(false);
    expect(
      updateDashboardSchema.safeParse({ widgets: [{ ...queryWidget(''), config: {} }] }).success,
    ).toBe(false);
    expect(
      updateDashboardSchema.safeParse({
        widgets: [
          {
            ...queryWidget(''),
            config: { type: 'query', title: 'Too much', query: '', limit: 5000 },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('live dashboard queries', () => {
  let admin: pg.Pool;
  const name = `omr_dashboard_queries_${Date.now()}`;
  let owner: Actor;
  let other: Actor;
  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(connection);
    url.pathname = `/${name}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'dashboard-tests-only-not-a-real-secret',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    const actors: Actor[] = [];
    for (const label of ['owner', 'other']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@dashboards.test`, state: 'active' })
        .returning();
      actors.push({ user: must(user), kind: 'user' });
    }
    [owner, other] = actors as [Actor, Actor];
  }, 30_000);
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('migrates legacy opaque widget configuration before enforcing query types', async () => {
    const radar = await createRadar(owner, { name: 'Legacy widget' });
    const tab = await createDashboard(owner, 'Legacy configuration');
    await getDb().execute(
      sql`ALTER TABLE dashboard_widgets DROP CONSTRAINT dashboard_widget_source_check`,
    );
    await getDb()
      .insert(schema.dashboardWidgets)
      .values({
        dashboardId: tab.id,
        radarId: radar.id,
        config: { type: 'custom-legacy', density: 'compact' },
      });
    const migration = await readFile(
      new URL('../../drizzle/0023_query_widgets.sql', import.meta.url),
      'utf8',
    );
    await getDb().execute(sql.raw(migration));
    expect(
      (await listDashboards(owner)).find((item) => item.id === tab.id)?.widgets[0]?.config,
    ).toEqual({});
  });

  it('composes multiple radars, refreshes new data and excludes private radars', async () => {
    const a = await createRadar(owner, { name: 'Project one' });
    const b = await createRadar(owner, { name: 'Project two' });
    const hidden = await createRadar(other, { name: 'Private project' });
    await createBlip(owner, a.id, { body: 'First live match #widget' });
    await createBlip(other, hidden.id, { body: 'Private match #widget' });
    const tab = await createDashboard(owner, 'Composite');
    const saved = await updateDashboard(owner, tab.id, {
      expectedRevision: tab.revision,
      widgets: [queryWidget(`in:${a.id} in:${b.id} tag:widget`)],
    });
    const id = must(saved.widgets[0]).id;
    expect((await dashboardWidgetResults(owner, tab.id, id)).items).toHaveLength(1);
    await createBlip(owner, b.id, { body: 'Second live match #widget' });
    const live = await dashboardWidgetResults(owner, tab.id, id);
    expect(live.items).toHaveLength(2);
    expect(new Set(live.items.map((blip) => blip.radarId))).toEqual(new Set([a.id, b.id]));
    expect((await previewDashboardQuery(owner, { query: 'tag:widget' })).items).toHaveLength(2);
    await expect(dashboardWidgetResults(other, tab.id, id)).rejects.toThrow('Dashboard not found');
  });

  it('rechecks access after sharing is removed', async () => {
    const shared = await createRadar(other, { name: 'Temporary access' });
    await shareRadar(other, shared.id, owner.user.email, 'viewer');
    await createBlip(other, shared.id, { body: 'Visible only until revoked' });
    const tab = await createDashboard(owner, 'Revocation');
    const saved = await updateDashboard(owner, tab.id, {
      expectedRevision: tab.revision,
      widgets: [queryWidget(`in:${shared.id}`)],
    });
    expect(
      (await dashboardWidgetResults(owner, tab.id, must(saved.widgets[0]).id)).items,
    ).toHaveLength(1);
    await removeMember(other, shared.id, owner.user.id);
    const after = await dashboardWidgetResults(owner, tab.id, must(saved.widgets[0]).id);
    expect(after.items).toEqual([]);
    expect(after.unresolved).toBe(true);
  });

  it('lets a dashboard be rearranged while one of its widgets points at a lost radar', async () => {
    const shared = await createRadar(other, { name: 'Lent for a while' });
    await shareRadar(other, shared.id, owner.user.email, 'viewer');
    const tab = await createDashboard(owner, 'Arranged around a stale panel');
    const saved = await updateDashboard(owner, tab.id, {
      expectedRevision: tab.revision,
      widgets: [
        { radarId: shared.id, x: 0, y: 0, w: 6, h: 8, config: {} },
        { ...queryWidget(`in:${shared.id}`), x: 6 },
      ],
    });
    await removeMember(other, shared.id, owner.user.id);

    // A drag is a full layout replace. The two stale widgets are unchanged, so
    // they are not re-validated; only a widget that is new or re-pointed is.
    const dragged = await updateDashboard(owner, tab.id, {
      expectedRevision: saved.revision,
      widgets: saved.widgets.map((widget) => ({ ...widget, y: widget.y + 2 })),
    });
    expect(dragged.widgets.map((widget) => widget.y)).toEqual([2, 2]);
    await expect(
      updateDashboard(owner, tab.id, {
        expectedRevision: dragged.revision,
        widgets: [...dragged.widgets, { radarId: shared.id, x: 0, y: 12, w: 6, h: 8, config: {} }],
      }),
    ).rejects.toThrow('That radar is not on your list');
    await expect(
      updateDashboard(owner, tab.id, {
        operations: [
          {
            op: 'update',
            id: must(dragged.widgets[1]).id,
            config: must(queryWidget(`in:${shared.id} #x`).config),
          },
        ],
      }),
    ).rejects.toThrow('matched no radar you can read');
  });

  it('gives tabs created at the same moment distinct positions', async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `tabs-${randomUUID()}@dashboards.test`, state: 'active' })
      .returning();
    const actor: Actor = { user: must(user), kind: 'user' };
    const tabs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createDashboard(actor, `Tab ${i}`)),
    );
    expect(new Set(tabs.map((tab) => tab.position)).size).toBe(5);
  });

  it('preserves widget identity and query configuration across layout and name edits', async () => {
    const tab = await createDashboard(owner, 'Stable widgets');
    const saved = await updateDashboard(owner, tab.id, {
      expectedRevision: tab.revision,
      widgets: [queryWidget('after:7d')],
    });
    const original = must(saved.widgets[0]);
    const moved = await updateDashboard(owner, tab.id, {
      expectedRevision: saved.revision,
      name: 'Renamed',
      widgets: [{ ...original, x: 3, y: 2 }],
    });
    expect(moved.widgets[0]).toMatchObject({
      id: original.id,
      config: original.config,
      x: 3,
      y: 2,
    });
    const another = await createDashboard(owner, 'Another tab');
    await expect(
      updateDashboard(owner, another.id, {
        expectedRevision: another.revision,
        widgets: [{ ...original }],
      }),
    ).rejects.toThrow('does not belong');
    await expect(
      updateDashboard(owner, tab.id, {
        expectedRevision: moved.revision,
        widgets: [original, { ...original, y: original.y + original.h }],
      }),
    ).rejects.toThrow('only appear once');
    expect((await dashboardWidgetResults(owner, tab.id, original.id)).problems).toEqual([]);
  });

  it('reports query mistakes in previews and refuses to persist them', async () => {
    const tab = await createDashboard(owner, 'Errors');
    expect(
      (await previewDashboardQuery(owner, { query: 'is:blue' })).problems.length,
    ).toBeGreaterThan(0);
    await expect(
      updateDashboard(owner, tab.id, {
        expectedRevision: tab.revision,
        widgets: [queryWidget('is:blue')],
      }),
    ).rejects.toThrow('not a state');
    await expect(
      updateDashboard(owner, tab.id, {
        expectedRevision: tab.revision,
        widgets: [queryWidget(`in:${randomUUID()}`)],
      }),
    ).rejects.toThrow('matched no radar');
    await expect(previewDashboardQuery(owner, { query: '', limit: 5000 })).rejects.toThrow();
  });
  it('packs six compact count tiles and merges concurrent appends without losing panels', async () => {
    const tab = await createDashboard(owner, 'Concurrent append');
    const draft = (title: string) => ({
      radarId: null,
      config: { type: 'query' as const, title, query: '', display: 'count' as const, limit: 12 },
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        updateDashboard(owner, tab.id, { append: [draft(`Count ${i}`)] }),
      ),
    );
    const current = must((await listDashboards(owner)).find((item) => item.id === tab.id));
    expect(current.revision).toBe(6);
    expect(current.widgets).toHaveLength(6);
    expect(current.widgets.map((item) => item.x).sort((a, b) => a - b)).toEqual([
      0, 2, 4, 6, 8, 10,
    ]);
    expect(current.widgets.every((item) => item.y === 0 && item.w === 2 && item.h === 2)).toBe(
      true,
    );
    expect(updateDashboardSchema.safeParse({ widgets: current.widgets }).success).toBe(true);
  });

  it('rejects missing and stale replacement revisions, including simultaneous writers', async () => {
    const tab = await createDashboard(owner, 'Revision guard');
    await expect(updateDashboard(owner, tab.id, { widgets: [] })).rejects.toThrow(
      'expectedRevision',
    );
    const attempts = await Promise.allSettled([
      updateDashboard(owner, tab.id, {
        expectedRevision: tab.revision,
        widgets: [queryWidget('tag:first')],
      }),
      updateDashboard(owner, tab.id, {
        expectedRevision: tab.revision,
        widgets: [queryWidget('tag:second')],
      }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const saved = must((await listDashboards(owner)).find((item) => item.id === tab.id));
    await expect(
      updateDashboard(owner, tab.id, {
        expectedRevision: tab.revision,
        widgets: [],
        name: 'Lost update',
      }),
    ).rejects.toThrow('changed since');
    expect((await listDashboards(owner)).find((item) => item.id === tab.id)).toEqual(saved);
  });

  it('applies operations atomically and preserves unrelated panels and widget identity', async () => {
    const tab = await createDashboard(owner, 'Operations');
    const saved = await updateDashboard(owner, tab.id, {
      append: [
        { radarId: null, config: { type: 'query', title: 'First', query: '', limit: 12 } },
        { radarId: null, config: { type: 'query', title: 'Second', query: '', limit: 12 } },
      ],
    });
    const first = must(saved.widgets.find((widget) => widget.x === 0));
    const second = must(saved.widgets.find((widget) => widget.x === 6));
    const moved = await updateDashboard(owner, tab.id, {
      operations: [
        { op: 'move', id: first.id, x: 6, y: 0 },
        { op: 'move', id: second.id, x: 0, y: 0 },
        {
          op: 'update',
          id: first.id,
          config: { type: 'query', title: 'Renamed', query: '', limit: 12, groupByRadar: true },
        },
      ],
    });
    expect(moved.widgets.find((widget) => widget.id === first.id)).toMatchObject({
      x: 6,
      config: { title: 'Renamed', groupByRadar: true },
    });
    expect(moved.widgets.find((widget) => widget.id === second.id)).toMatchObject({
      x: 0,
      config: second.config,
    });
    await expect(
      updateDashboard(owner, tab.id, {
        name: 'Must roll back',
        operations: [
          { op: 'remove', id: first.id },
          { op: 'move', id: randomUUID(), x: 0, y: 0 },
        ],
      }),
    ).rejects.toThrow('does not belong');
    expect((await listDashboards(owner)).find((item) => item.id === tab.id)).toEqual(moved);
    const removed = await updateDashboard(owner, tab.id, {
      operations: [{ op: 'remove', id: first.id }],
    });
    expect(removed.widgets.map((widget) => widget.id)).toEqual([second.id]);
    await expect(
      updateDashboard(other, tab.id, {
        append: [{ radarId: null, config: { type: 'query', title: 'No', query: '', limit: 12 } }],
      }),
    ).rejects.toThrow('not found');
  });

  it('validates the merged result for limits, source ownership and geometry', async () => {
    const tab = await createDashboard(owner, 'Merged validation');
    const privateRadar = await createRadar(other, { name: 'Private source for patch' });
    await expect(
      updateDashboard(owner, tab.id, { append: [{ radarId: privateRadar.id }] }),
    ).rejects.toThrow('not on your list');
    await expect(
      updateDashboard(owner, tab.id, {
        operations: [
          {
            op: 'add',
            widget: { radarId: null, config: { type: 'query', title: 'No', query: '', limit: 12 } },
            x: 1,
          },
        ],
      }),
    ).rejects.toThrow('both x and y');
    const saved = await updateDashboard(owner, tab.id, {
      append: Array.from({ length: 12 }, (_, i) => ({
        radarId: null,
        config: {
          type: 'query',
          title: `Count ${i}`,
          query: '',
          display: 'count',
          limit: 12,
        } as const,
      })),
    });
    await expect(
      updateDashboard(owner, tab.id, {
        append: [
          {
            radarId: null,
            config: { type: 'query', title: 'Too many', query: '', display: 'count', limit: 12 },
          },
        ],
      }),
    ).rejects.toThrow('12 live');
    await expect(
      updateDashboard(owner, tab.id, {
        operations: [
          {
            op: 'update',
            id: must(saved.widgets[0]).id,
            config: {
              type: 'query',
              title: 'Too short list',
              query: '',
              display: 'list',
              limit: 12,
            },
          },
        ],
      }),
    ).rejects.toThrow('at least');
    expect((await listDashboards(owner)).find((item) => item.id === tab.id)).toEqual(saved);
  });
  it('can rename a legacy overlapping layout without changing its widgets', async () => {
    const radar = await createRadar(owner, { name: 'Legacy overlap source' });
    const tab = await createDashboard(owner, 'Legacy overlap');
    await getDb()
      .insert(schema.dashboardWidgets)
      .values(
        Array.from({ length: 2 }, () => ({
          dashboardId: tab.id,
          radarId: radar.id,
          x: 0,
          y: 0,
          w: 6,
          h: 8,
        })),
      );
    const renamed = await updateDashboard(owner, tab.id, { name: 'Renamed legacy' });
    expect(renamed.name).toBe('Renamed legacy');
    expect(renamed.widgets).toHaveLength(2);
    expect(renamed.revision).toBe(1);
  });
});

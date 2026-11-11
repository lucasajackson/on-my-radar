import { randomUUID } from 'node:crypto';
/** Personal dashboard tabs with radar and live-query widgets. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  idSchema,
  dashboardWidgetConfigSchema,
  updateDashboardSchema,
  type dashboardPreviewSchema,
  type DashboardDto,
  type DashboardQueryResultDto,
  type DashboardUpdateInput,
  type DashboardWidgetConfig,
  type WidgetDraft,
  type WidgetLayout,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { badRequest, conflict, notFound, type Actor } from '../http.js';
import { orgAllows, readableRadarIdsFor, requireScope } from './access.js';
import { resolveSearchQuery } from './search.js';
import { aggregateDashboardQuery } from './dashboard-aggregates.js';
import type { z } from 'zod';
import { must } from '../errors.js';

type DashboardRow = typeof schema.dashboards.$inferSelect;
type WidgetRow = typeof schema.dashboardWidgets.$inferSelect;

function toDto(row: DashboardRow, widgets: WidgetRow[]): DashboardDto {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    position: row.position,
    widgets: widgets.map((w) => ({
      id: w.id,
      radarId: w.radarId,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      config: dashboardWidgetConfigSchema.parse(w.config),
    })),
  };
}

/** The caller's own dashboards, in an organization that still lets them own things (`access.ts`). */
const ownedBy = (actor: Actor) =>
  and(
    eq(schema.dashboards.ownerId, actor.user.id),
    orgAllows(schema.dashboards.organizationId, actor.user.id, 'owner'),
  );

export async function listDashboards(actor: Actor): Promise<DashboardDto[]> {
  await requireScope(actor, 'read', 'read dashboards');
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.dashboards)
    .where(ownedBy(actor))
    .orderBy(asc(schema.dashboards.position), asc(schema.dashboards.createdAt));

  if (rows.length === 0) return [];

  const widgets = await db
    .select()
    .from(schema.dashboardWidgets)
    .where(
      inArray(
        schema.dashboardWidgets.dashboardId,
        rows.map((r) => r.id),
      ),
    );

  const byDashboard = new Map<string, WidgetRow[]>();
  for (const widget of widgets) {
    const list = byDashboard.get(widget.dashboardId) ?? [];
    list.push(widget);
    byDashboard.set(widget.dashboardId, list);
  }

  return rows.map((row) => toDto(row, byDashboard.get(row.id) ?? []));
}

export async function createDashboard(actor: Actor, name: string): Promise<DashboardDto> {
  // A dashboard belongs to nobody but its owner, so there is no radar for the
  // clamp to narrow; the ceiling is asked about directly. Arranging somebody's
  // workspace is a change to what they see every time they open the app, and a
  // connection granted `radars:read` should not be able to make it.
  await requireScope(actor, 'write', 'create a dashboard');
  // Serialised per owner, so two tabs created at once do not both take the
  // next position and then sort by accident.
  const row = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dashboards:${actor.user.id}`}, 0))`,
    );
    const [top] = await tx
      .select({ next: sql<number>`coalesce(max(${schema.dashboards.position}) + 1, 0)::int` })
      .from(schema.dashboards)
      .where(ownedBy(actor));
    const [inserted] = await tx
      .insert(schema.dashboards)
      .values({ ownerId: actor.user.id, name, position: top?.next ?? 0 })
      .returning();
    if (!inserted) throw new Error('dashboard insert returned no row');
    return inserted;
  });
  return toDto(row, []);
}

/** Require the appropriate scope and return only the caller's own dashboard. */
async function ownDashboard(
  actor: Actor,
  dashboardId: string,
  need: 'read' | 'write' = 'write',
): Promise<DashboardRow> {
  await requireScope(actor, need, need === 'write' ? 'change a dashboard' : 'read a dashboard');
  if (!idSchema.safeParse(dashboardId).success) throw badRequest('Invalid dashboard ID');
  const rows = await getDb()
    .select()
    .from(schema.dashboards)
    .where(and(eq(schema.dashboards.id, dashboardId), ownedBy(actor)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Dashboard not found');
  return row;
}

export async function updateDashboard(
  actor: Actor,
  dashboardId: string,
  raw: DashboardUpdateInput,
): Promise<DashboardDto> {
  const parsed = updateDashboardSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid dashboard');
  const input = parsed.data;
  const dashboard = await ownDashboard(actor, dashboardId);
  if (input.widgets !== undefined && input.expectedRevision === undefined)
    throw conflict(
      'Replacing a layout requires expectedRevision. Read the dashboard again, or use append/operations to change individual widgets.',
    );

  return getDb().transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.dashboards)
      .where(and(eq(schema.dashboards.id, dashboard.id), ownedBy(actor)))
      .for('update');
    if (!locked) throw notFound('Dashboard not found');
    if (input.expectedRevision !== undefined && input.expectedRevision !== locked.revision)
      throw conflict(
        'This dashboard changed since you read it. Reload it before applying your changes.',
      );
    const existing = await tx
      .select()
      .from(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id));
    await assertSourcesReadable(actor, changedSources(input, existing));
    const ownIds = new Set(existing.map((widget) => widget.id));
    if (input.widgets?.some((widget) => widget.id && !ownIds.has(widget.id)))
      throw badRequest('That widget does not belong to this dashboard');
    // Every widget has its id from here on, which the insert below relies on.
    const widgets: Array<WidgetLayout & { id: string }> = (
      input.widgets ?? toDto(locked, existing).widgets
    ).map((widget) => ({ ...widget, id: widget.id ?? randomUUID() }));

    const add = (draft: WidgetDraft, x?: number, y?: number) => {
      const count = draft.config?.type === 'query' && draft.config.display === 'count';
      const widget: WidgetLayout & { id: string } = {
        id: randomUUID(),
        radarId: draft.radarId,
        config: dashboardWidgetConfigSchema.parse(draft.config ?? {}),
        x: x ?? 0,
        y: y ?? 0,
        w: draft.w ?? (count ? 2 : 6),
        h: draft.h ?? (count ? 2 : 8),
      };
      if ((x === undefined) !== (y === undefined))
        throw badRequest('Supply both x and y, or omit both for automatic placement.');
      if (x === undefined) {
        let found = false;
        for (let row = 0; row <= 400 && !found; row++) {
          for (let column = 0; column <= 12 - widget.w; column++) {
            if (
              !widgets.some(
                (other) =>
                  column < other.x + other.w &&
                  column + widget.w > other.x &&
                  row < other.y + other.h &&
                  row + widget.h > other.y,
              )
            ) {
              widget.x = column;
              widget.y = row;
              found = true;
              break;
            }
          }
        }
        if (!found) throw badRequest('There is no room for that widget in this dashboard.');
      }
      widgets.push(widget);
    };
    for (const draft of input.append ?? []) add(draft);
    for (const op of input.operations ?? []) {
      if (op.op === 'add') {
        add(op.widget, op.x, op.y);
        continue;
      }
      const index = widgets.findIndex((widget) => widget.id === op.id);
      const widget = widgets[index];
      if (!widget) throw badRequest('That widget does not belong to this dashboard');
      if (op.op === 'remove') widgets.splice(index, 1);
      if (op.op === 'move')
        widgets[index] = {
          ...widget,
          x: op.x,
          y: op.y,
          ...(op.w !== undefined ? { w: op.w } : {}),
          ...(op.h !== undefined ? { h: op.h } : {}),
        };
      if (op.op === 'update') {
        if (op.config === undefined && op.radarId === undefined)
          throw badRequest('Name a widget configuration or radar to update.');
        widgets[index] = {
          ...widget,
          ...(op.config !== undefined ? { config: op.config } : {}),
          ...(op.radarId !== undefined ? { radarId: op.radarId } : {}),
        };
      }
    }
    const changesLayout =
      input.widgets !== undefined || input.append !== undefined || input.operations !== undefined;
    if (changesLayout) {
      const layout = updateDashboardSchema.safeParse({ widgets });
      if (!layout.success)
        throw badRequest(layout.error.issues[0]?.message ?? 'Invalid widget layout');
      const ids = widgets.map((widget) => widget.id);
      if (new Set(ids).size !== ids.length) throw badRequest('A widget can only appear once');
    }
    if (changesLayout) {
      // The row lock and a single transaction make the merged layout atomic.
      // IDs survive; concurrent appends read the just-committed current layout.
      await tx
        .delete(schema.dashboardWidgets)
        .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id));
      if (widgets.length)
        await tx.insert(schema.dashboardWidgets).values(
          widgets.map((w) => ({
            id: w.id,
            dashboardId: dashboard.id,
            radarId: w.radarId,
            x: w.x,
            y: w.y,
            w: w.w,
            h: w.h,
            config: w.config ?? {},
          })),
        );
    }
    const [updated] = await tx
      .update(schema.dashboards)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        revision: locked.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.dashboards.id, dashboard.id))
      .returning();
    const saved = changesLayout
      ? await tx
          .select()
          .from(schema.dashboardWidgets)
          .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id))
      : existing;
    return toDto(must(updated, 'the locked dashboard row'), saved);
  });
}

type WidgetSource = {
  id?: string | undefined;
  radarId?: string | null | undefined;
  config?: DashboardWidgetConfig | undefined;
};

/**
 * The widgets this update introduces or points somewhere new — and only those.
 *
 * A widget already on the dashboard whose radar and configuration are unchanged
 * is not re-validated. The SPA saves a drag as a full layout replace, so
 * validating every widget in `input.widgets` meant one widget whose radar had
 * since been unshared (or whose saved query no longer resolves) refused every
 * drag of every other panel — and re-resolved each query widget on every drag.
 * An inaccessible widget still shows as unavailable, and can still be removed.
 */
function changedSources(
  input: z.infer<typeof updateDashboardSchema>,
  existing: WidgetRow[],
): WidgetSource[] {
  const before = new Map(existing.map((widget) => [widget.id, widget]));
  const moved = (widget: WidgetSource) => {
    const prior = widget.id ? before.get(widget.id) : undefined;
    if (!prior) return true;
    if (widget.radarId !== undefined && widget.radarId !== prior.radarId) return true;
    return (
      widget.config !== undefined &&
      JSON.stringify(dashboardWidgetConfigSchema.parse(widget.config)) !==
        JSON.stringify(dashboardWidgetConfigSchema.parse(prior.config))
    );
  };
  const sources: WidgetSource[] = [...(input.widgets ?? []).filter(moved), ...(input.append ?? [])];
  for (const op of input.operations ?? []) {
    if (op.op === 'add') sources.push(op.widget);
    if (op.op === 'update' && moved(op)) sources.push(op);
  }
  return sources;
}

async function assertSourcesReadable(actor: Actor, sources: WidgetSource[]): Promise<void> {
  if (sources.length === 0) return;
  const allowed = new Set(await readableRadarIdsFor(actor));
  for (const widget of sources) {
    if (widget.radarId !== undefined && widget.radarId !== null && !allowed.has(widget.radarId))
      throw badRequest('That radar is not on your list');
    if (widget.config?.type === 'query') {
      const { metadata: preview } = await resolveSearchQuery(actor, {
        q: widget.config.query,
        limit: 1,
      });
      if (preview.unresolved || preview.problems.length)
        throw badRequest(preview.problems[0]?.message ?? 'Resolve the query filters before saving');
    }
  }
}

export async function deleteDashboard(actor: Actor, dashboardId: string): Promise<void> {
  const dashboard = await ownDashboard(actor, dashboardId);
  await getDb().delete(schema.dashboards).where(eq(schema.dashboards.id, dashboard.id));
}

/** Preview and widgets use the same grammar and current readable set as Search. */
export async function previewDashboardQuery(
  actor: Actor,
  input: z.input<typeof dashboardPreviewSchema>,
): Promise<DashboardQueryResultDto> {
  // `aggregateDashboardQuery` asks for the scope and parses the input itself.
  return aggregateDashboardQuery(actor, input);
}

export async function dashboardWidgetResults(
  actor: Actor,
  dashboardId: string,
  widgetId: string,
): Promise<DashboardQueryResultDto> {
  await ownDashboard(actor, dashboardId, 'read');
  if (!idSchema.safeParse(widgetId).success) throw badRequest('Invalid widget ID');
  const [widget] = await getDb()
    .select()
    .from(schema.dashboardWidgets)
    .where(
      and(
        eq(schema.dashboardWidgets.id, widgetId),
        eq(schema.dashboardWidgets.dashboardId, dashboardId),
      ),
    )
    .limit(1);
  if (!widget) throw notFound('Widget not found');
  const config = dashboardWidgetConfigSchema.parse(widget.config);
  if (config.type !== 'query') throw badRequest('This widget displays a single radar');
  return previewDashboardQuery(actor, config);
}

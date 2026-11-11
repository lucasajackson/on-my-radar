/** Dashboard measures use the same resolved, authorized predicate as Search. */
import { and, inArray, sql } from 'drizzle-orm';
import {
  dashboardPreviewSchema,
  statusesFor,
  type DashboardQueryResultDto,
} from '@onmyradar/contract';
import type { z } from 'zod';
import { getDb, schema } from '../db/client.js';
import { badRequest, type Actor } from '../http.js';
import { requireScopeWithinGrants } from './access.js';
import { buildBlipFilterClauses } from './blips.js';
import { executeResolvedSearch, resolveSearchQuery } from './search.js';

/** Inclusive UTC calendar days, ending today; upper bound is exclusive. */
function activityRange(days: 7 | 30 | 90): NonNullable<DashboardQueryResultDto['activityRange']> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const to = new Date(today);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  return { days, timezone: 'UTC', from: from.toISOString(), to: to.toISOString() };
}

/**
 * Counts cover the full query, independent of the list's display limit. Charts
 * query grouped scalar rows, never hydrate or download all matching blips.
 *
 * The activity chart alone applies its displayed UTC window. `total` still
 * describes the query; the explicit range prevents a seven-day chart from
 * quietly redefining an all-time count.
 */
export async function aggregateDashboardQuery(
  actor: Actor,
  input: z.input<typeof dashboardPreviewSchema>,
): Promise<DashboardQueryResultDto> {
  requireScopeWithinGrants(actor, 'read', 'read dashboard results');
  const parsed = dashboardPreviewSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
  const config = parsed.data;
  const display = config.display ?? 'list';
  const resolved = await resolveSearchQuery(actor, { q: config.query, limit: config.limit });
  const result: DashboardQueryResultDto = {
    ...resolved.metadata,
    items: [],
    nextCursor: null,
    total: 0,
  };
  if (config.groupByRadar) result.radarGroups = [];
  // Held as locals as well as on the result, so the code filling them in below
  // does not have to re-prove that the optional fields were set.
  const laneGroups: NonNullable<DashboardQueryResultDto['laneGroups']> = [];
  if (display === 'lanes') result.laneGroups = laneGroups;
  const range = display === 'activity' ? activityRange(config.activityDays ?? 30) : null;
  const activity: NonNullable<DashboardQueryResultDto['activity']> = [];
  if (range) {
    result.activityRange = range;
    const first = new Date(range.from);
    for (let index = 0; index < range.days; index += 1) {
      const date = new Date(first);
      date.setUTCDate(date.getUTCDate() + index);
      activity.push({ date: date.toISOString().slice(0, 10), count: 0 });
    }
    result.activity = activity;
  }
  // Failed filters must never become a reassuring zero, nor run with a filter
  // omitted. Carry Search's diagnostics unchanged and make no aggregate query.
  if (
    resolved.metadata.unresolved ||
    resolved.metadata.problems.length ||
    !resolved.radarIds.length
  )
    return result;

  const db = getDb();
  const predicate = and(
    ...buildBlipFilterClauses(resolved.radarIds, resolved.query, resolved.saved, resolved.search),
  );

  if (display === 'lanes' || config.groupByRadar) {
    // The finest requested grouping also gives an exact total and radar
    // subtotals from the same statement snapshot, without another count scan.
    const rows = await db
      .select({
        radarId: schema.blips.radarId,
        status: display === 'lanes' ? schema.blips.status : sql<null>`NULL`,
        total: sql<number>`count(*)::int`,
      })
      .from(schema.blips)
      .where(predicate)
      .groupBy(schema.blips.radarId, ...(display === 'lanes' ? [schema.blips.status] : []));
    const matchedRadarIds = [...new Set(rows.map((row) => row.radarId))];
    const radarRows = matchedRadarIds.length
      ? await db
          .select({
            id: schema.radars.id,
            name: schema.radars.name,
            template: schema.radars.template,
            templateConfig: schema.radars.templateConfig,
          })
          .from(schema.radars)
          .where(inArray(schema.radars.id, matchedRadarIds))
          .orderBy(schema.radars.name, schema.radars.id)
      : [];
    const totals = new Map<string, number>();
    for (const row of rows) {
      result.total += row.total;
      totals.set(row.radarId, (totals.get(row.radarId) ?? 0) + row.total);
    }
    if (config.groupByRadar) {
      result.radarGroups = radarRows.flatMap((radar) => {
        const total = totals.get(radar.id) ?? 0;
        return total > 0 ? [{ radarId: radar.id, name: radar.name, total }] : [];
      });
    }
    if (display === 'lanes') {
      const byRadar = new Map<string, Map<string | null, number>>();
      for (const row of rows) {
        const lanes = byRadar.get(row.radarId) ?? new Map<string | null, number>();
        lanes.set(row.status, row.total);
        byRadar.set(row.radarId, lanes);
      }
      for (const radar of radarRows) {
        const remaining = new Map(byRadar.get(radar.id));
        // Only matching boards appear. Preserve each board's own vocabulary
        // and zero-count lanes within its distribution. A
        // renamed custom lane must not become another board's generic status.
        for (const lane of statusesFor(radar.template, radar.templateConfig)) {
          laneGroups.push({
            radarId: radar.id,
            name: radar.name,
            status: lane.id,
            label: lane.label,
            total: remaining.get(lane.id) ?? 0,
          });
          remaining.delete(lane.id);
        }
        // Historical or unassigned statuses still contribute to the total;
        // silently discarding them would make the distribution lie.
        for (const [status, total] of remaining) {
          laneGroups.push({
            radarId: radar.id,
            name: radar.name,
            status,
            label: status ?? 'No lane',
            total,
          });
        }
      }
    }
  } else {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.blips)
      .where(predicate);
    result.total = row?.total ?? 0;
  }

  if (range) {
    const day = sql<string>`(${schema.blips.createdAt} AT TIME ZONE 'UTC')::date::text`;
    const rows = await db
      .select({ date: day, count: sql<number>`count(*)::int` })
      .from(schema.blips)
      .where(
        and(
          predicate,
          sql`${schema.blips.createdAt} >= ${range.from}::timestamptz`,
          sql`${schema.blips.createdAt} < ${range.to}::timestamptz`,
        ),
      )
      .groupBy(day);
    const counts = new Map(rows.map((row) => [row.date, row.count]));
    for (const bucket of activity) bucket.count = counts.get(bucket.date) ?? 0;
  }

  if (display === 'list') {
    const page = await executeResolvedSearch(
      actor,
      { q: config.query, limit: config.limit },
      resolved,
    );
    result.items = page.items;
    result.nextCursor = page.nextCursor;
  }
  return result;
}

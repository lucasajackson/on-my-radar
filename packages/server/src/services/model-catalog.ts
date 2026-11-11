/**
 * The model catalog: the models each tool can be told to use, kept current by
 * an admin rather than by a deploy (§V2.7). Seeded from `MODEL_CATALOG_SEED` by
 * `drizzle/0038`. A profile picks from here or types a custom id — the catalog
 * is a menu, never a whitelist, because tools ship models faster than anybody
 * edits a list, and `validateProfileSettings` checks only the id's shape.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  resolveHarness,
  type AdminOverviewDto,
  type Harness,
  type ModelCatalogEntryDto,
} from '@onmyradar/contract';
import type { z } from 'zod';
import { getDb, schema } from '../db/client.js';
import { badRequest, conflict, notFound, type Actor } from '../http.js';
import { recordAudit } from './audit.js';
import { isUniqueViolation } from './slugs.js';
import type { modelCatalogEntrySchema, updateModelCatalogEntrySchema } from '@onmyradar/contract';

type Row = typeof schema.modelCatalog.$inferSelect;

const dto = (row: Row): ModelCatalogEntryDto => ({
  id: row.id,
  harness: row.harness as Harness,
  modelId: row.modelId,
  displayName: row.displayName,
  family: row.family,
  hidden: row.hidden,
  deprecated: row.deprecated,
  sortOrder: row.sortOrder,
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * What a profile editor offers: visible models, for one tool or all. Admins see
 * hidden rows through `listAllModels` instead.
 */
export async function listModels(harness?: string): Promise<ModelCatalogEntryDto[]> {
  const resolved = harness ? resolveHarness(harness) : null;
  if (harness && !resolved) throw badRequest(`'${harness}' is not a tool On My Radar knows.`);
  const rows = await getDb()
    .select()
    .from(schema.modelCatalog)
    .where(
      and(
        eq(schema.modelCatalog.hidden, false),
        resolved ? eq(schema.modelCatalog.harness, resolved) : undefined,
      ),
    )
    .orderBy(
      asc(schema.modelCatalog.harness),
      asc(schema.modelCatalog.sortOrder),
      asc(schema.modelCatalog.displayName),
    );
  return rows.map(dto);
}

export async function listAllModels(): Promise<ModelCatalogEntryDto[]> {
  const rows = await getDb()
    .select()
    .from(schema.modelCatalog)
    .orderBy(
      asc(schema.modelCatalog.harness),
      asc(schema.modelCatalog.sortOrder),
      asc(schema.modelCatalog.displayName),
    );
  return rows.map(dto);
}

const duplicate = (err: unknown) => {
  if (isUniqueViolation(err, 'model_catalog_harness_model_key'))
    throw conflict('That tool already lists a model with that id.');
  throw err;
};

export async function createModel(
  actor: Actor,
  input: z.infer<typeof modelCatalogEntrySchema>,
): Promise<ModelCatalogEntryDto> {
  const [row] = await getDb()
    .insert(schema.modelCatalog)
    .values(input)
    .returning()
    .catch(duplicate);
  if (!row) throw conflict('The model was not saved.');
  await recordAudit(actor, 'model_catalog.create', 'model_catalog', row.id, {
    harness: row.harness,
    modelId: row.modelId,
  });
  return dto(row);
}

export async function updateModel(
  actor: Actor,
  id: string,
  input: z.infer<typeof updateModelCatalogEntrySchema>,
): Promise<ModelCatalogEntryDto> {
  const [row] = await getDb()
    .update(schema.modelCatalog)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(schema.modelCatalog.id, id))
    .returning()
    .catch(duplicate);
  if (!row) throw notFound('Model not found');
  await recordAudit(actor, 'model_catalog.update', 'model_catalog', row.id, {
    fields: Object.keys(input),
  });
  return dto(row);
}

/**
 * Removing a model changes no profile: a profile stores the id it was given,
 * and the editor shows an id the catalog no longer lists as a custom value.
 */
export async function deleteModel(actor: Actor, id: string): Promise<void> {
  const removed = await getDb()
    .delete(schema.modelCatalog)
    .where(eq(schema.modelCatalog.id, id))
    .returning({ id: schema.modelCatalog.id, modelId: schema.modelCatalog.modelId });
  if (removed.length === 0) throw notFound('Model not found');
  await recordAudit(actor, 'model_catalog.delete', 'model_catalog', id, {
    modelId: removed[0]?.modelId,
  });
}

export async function adminOverview(): Promise<AdminOverviewDto> {
  const db = getDb();
  const users = await db
    .select({ state: schema.users.state, n: sql<number>`count(*)::int` })
    .from(schema.users)
    .groupBy(schema.users.state);
  const [agents] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.agents);
  const [memories] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.repoAgentMemories)
    .where(sql`${schema.repoAgentMemories.forgottenAt} IS NULL`);
  const [models] = await db
    .select({
      total: sql<number>`count(*)::int`,
      hidden: sql<number>`count(*) FILTER (WHERE hidden)::int`,
    })
    .from(schema.modelCatalog);
  const sessions = await db.execute<{ harness: string; count: number }>(sql`
    SELECT coalesce(harness, 'unknown') AS harness, count(*)::int AS count
      FROM agent_sessions WHERE started_at > now() - interval '7 days'
     GROUP BY 1 ORDER BY 2 DESC`);
  const byState = (s: string) => users.find((u) => u.state === s)?.n ?? 0;
  return {
    users: {
      active: byState('active'),
      pending: byState('pending'),
      suspended: byState('suspended'),
    },
    agents: agents?.n ?? 0,
    memories: memories?.n ?? 0,
    models: { total: models?.total ?? 0, hidden: models?.hidden ?? 0 },
    sessionsByHarness: sessions.rows,
  };
}

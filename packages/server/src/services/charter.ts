/**
 * The architecture charter as one versioned document, and the anchors that point into it.
 *
 * `charter_documents` holds the head text; `charter_anchors` holds every ADR amendment (later,
 * element links) as a quote with context, resolved against the text's projection (see
 * `contract/anchor.ts`); `charter_versions` seals the history. Everything that changes the
 * document, an anchor or the lane of an ADR that has an anchor runs under one row lock on the
 * document (`FOR UPDATE`), so the numbering of versions, the standing of every anchor and the
 * revision a save is checked against can never be seen half-written.
 *
 * A save never fails because of an anchor. It re-resolves them all in the same transaction: an
 * anchor whose words were removed or changed is `orphaned` (flagged, remembering the last sealed
 * version where it resolved); saving the words back heals it. Accepting an ADR with an orphaned
 * anchor is the one thing refused (`adr_orphaned`), on the shared path every lane move takes.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  AMEND_LIMITS,
  CHARTER_LIMITS,
  LIVE_ADR_LANES,
  blockAt,
  parseMarkers,
  projectMarkdown,
  resolveAnchors,
  replaceMarkers,
  resolveSelection,
  withProblem,
  type CharterAnchorDto,
  type CharterAnchorRefDto,
  type CharterOrphanDto,
  type WriteCharterResult,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { retryOnConflict } from '../errors.js';
import { ApiError, badRequest, conflict, type Actor } from '../http.js';
import { chargeCharterSave, chargeCharterSeal } from './charter-limits.js';
import { cutsCode, planMigration, projectionOf, sha256 } from './charter-model.js';
import { enqueueNotificationEvent } from './notifications.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Doc = typeof schema.charterDocuments.$inferSelect;
export type AnchorRow = typeof schema.charterAnchors.$inferSelect;

const ADR_LANE_IDS = ['proposed', 'accepted', 'rejected', 'repealed'];

/**
 * An ADR's label, computed from the number in its title and always at least four digits wide
 * (`ADR-0001`), so a radar's old `ADR-1` titles read the way its charter and repository cite them.
 */
export const adrLabel = (title: string | null, id: string): string => {
  const digits = /^ADR-(\d+)/i.exec(title ?? '')?.[1];
  return digits ? `ADR-${digits.padStart(4, '0')}` : `ADR ${id.slice(0, 8)}`;
};

export const isLive = (lane: string | null | undefined): boolean =>
  LIVE_ADR_LANES.some((l) => l === lane);

/** Who a write is, for the version and the event it leaves. */
export interface Provenance {
  userId: string | null;
  sessionId: string | null;
  label: string | null;
  /** The agent writing, when one is (the person is `userId`). */
  agentId?: string | null;
  /** Who is writing: see `writerOf`. Null for the system (the move of an old charter). */
  writer: string | null;
}

/**
 * The identity text written without a seal belongs to: the user, the connection they came in by
 * (a browser session, or a PAT or OAuth client by its id: two tokens of one user are two writers),
 * and the agent they write as, when there is one.
 */
const writerOf = (actor: Actor | null): string | null =>
  actor
    ? [
        actor.user.id,
        actor.connection
          ? `${actor.connection.kind}:${actor.connection.id}`
          : `session:${actor.sessionId ?? ''}`,
        actor.agent?.agentId ?? '',
      ].join('|')
    : null;

export const provenance = (actor: Actor | null): Provenance => ({
  userId: actor?.user.id ?? null,
  sessionId: actor?.sessionId ?? null,
  label: actor?.connection?.label ?? null,
  agentId: actor?.agent?.agentId ?? null,
  writer: writerOf(actor),
});

/** The agent a `writerOf` string names, if it names one (its third part). */
const agentOfWriter = (writer: string | null): string | null => {
  const id = writer?.split('|')[2];
  return id ? id : null;
};

/* --------------------------------- ensuring -------------------------------- */

/** Radars known to hold a document. Documents are only ever deleted with their radar. */
const known = new Set<string>();
const remember = (radarId: string): void => {
  if (known.size > 5000) known.clear();
  known.add(radarId);
};

/** The pages of earlier versions: refused for good, with the way forward. */
/**
 * A page blip of a radar whose charter has been moved into its document is history: nothing
 * writes it, comments on it included (a comment would be lost when the page is purged).
 */
export async function assertNotCharterPage(
  db: Pick<Db, 'select'>,
  blip: { radarId: string; status: string | null },
): Promise<void> {
  if (blip.status !== 'charter') return;
  const [doc] = await db
    .select({ radarId: schema.charterDocuments.radarId })
    .from(schema.charterDocuments)
    .where(eq(schema.charterDocuments.radarId, blip.radarId));
  if (doc) throw charterIsOneDocument();
}

export const charterIsOneDocument = () =>
  new ApiError(
    410,
    'charter_is_one_document',
    'The charter is one document now. Read it with read_architecture and replace it with write_charter (baseRevision from that read); an ADR amends it with propose_adr.',
  );

const notReady = () =>
  new ApiError(
    409,
    'charter_not_ready',
    "This radar's charter is still being moved into its single document. Read the architecture once (or try again in a moment) and retry.",
  );

/**
 * The document row, locked, creating an empty one for a radar that never had pages. A radar that
 * still has pages and no document has not been moved yet: that is `charter_not_ready`, never a
 * silent empty document.
 */
export async function lockCharter(tx: Tx, radarId: string): Promise<Doc> {
  const lock = () =>
    tx
      .select()
      .from(schema.charterDocuments)
      .where(eq(schema.charterDocuments.radarId, radarId))
      .for('update');
  const [have] = await lock();
  if (have) return have;
  const [page] = await tx
    .select({ id: schema.blips.id })
    .from(schema.blips)
    .where(and(eq(schema.blips.radarId, radarId), eq(schema.blips.status, 'charter')))
    .limit(1);
  if (page) throw notReady();
  await tx.insert(schema.charterDocuments).values({ radarId }).onConflictDoNothing();
  const [made] = await lock();
  if (!made) throw new Error('charter document missing after insert');
  return made;
}

/**
 * Before anything reads or writes a charter outside a transaction: move the radar into its
 * document if it has not been moved. One query once it has (and none after the first).
 */
export async function ensureCharterDocument(radarId: string): Promise<void> {
  if (known.has(radarId)) return;
  const [row] = await getDb()
    .select({ radarId: schema.charterDocuments.radarId })
    .from(schema.charterDocuments)
    .where(eq(schema.charterDocuments.radarId, radarId));
  if (!row) {
    const report = await migrateRadar(radarId);
    if (report.status === 'refused')
      throw new ApiError(
        409,
        'charter_migration_refused',
        `This radar's charter cannot be moved into a single document yet: ${report.reason ?? 'unknown'}`,
      );
  }
  remember(radarId);
}

/** Whether an architecture radar still has pages and no document (guards refuse until it is moved). */
export async function assertCharterReady(db: Pick<Db, 'select'>, radarId: string): Promise<void> {
  if (known.has(radarId)) return;
  const [doc] = await db
    .select({ radarId: schema.charterDocuments.radarId })
    .from(schema.charterDocuments)
    .where(eq(schema.charterDocuments.radarId, radarId));
  if (doc) {
    remember(radarId);
    return;
  }
  const [page] = await db
    .select({ id: schema.blips.id })
    .from(schema.blips)
    .where(and(eq(schema.blips.radarId, radarId), eq(schema.blips.status, 'charter')))
    .limit(1);
  if (page) throw notReady();
}

/* -------------------------------- migration -------------------------------- */

export interface MigrationReport {
  radarId: string;
  status: 'migrated' | 'already' | 'empty' | 'refused' | 'skipped';
  reason?: string;
  pages: number;
  characters: number;
  anchors: number;
  versions: number;
  /** Charter-lane blips written after the document was made (an older pod, mid-rollout). */
  stalePages?: number;
}

/**
 * Today's pages and markers into the document, its anchors and version 1. One radar, one
 * transaction, under a per-radar advisory lock; a radar that already has a document is left
 * alone, so running it twice is the same as running it once. It reads pages and writes new rows
 * only: **no page is deleted or changed** (the pages stay as the way back, see
 * `purgeMigratedPages`). With `dryRun` it computes the same plan and writes nothing.
 */
export async function migrateRadar(
  radarId: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`charter-migrate:${radarId}`}, 0))`,
    );
    const empty = { radarId, pages: 0, characters: 0, anchors: 0, versions: 0 };
    const [radar] = await tx
      .select({ template: schema.radars.template })
      .from(schema.radars)
      .where(eq(schema.radars.id, radarId));
    if (!radar || radar.template !== 'architecture')
      return { ...empty, status: 'skipped', reason: 'not an Architecture radar' };
    const readDocument = async () =>
      (
        await tx
          .select()
          .from(schema.charterDocuments)
          .where(eq(schema.charterDocuments.radarId, radarId))
      )[0];
    const already = async (doc: NonNullable<Awaited<ReturnType<typeof readDocument>>>) => {
      const [stale] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.blips)
        .where(
          and(
            eq(schema.blips.radarId, radarId),
            eq(schema.blips.status, 'charter'),
            sql`${schema.blips.updatedAt} > ${doc.createdAt}`,
          ),
        );
      return {
        ...empty,
        status: 'already' as const,
        characters: doc.body.length,
        versions: doc.sealedVersion,
        stalePages: stale?.n ?? 0,
      };
    };
    const head = await readDocument();
    if (head) return already(head);
    // Hold off every writer of a page before reading one. An older pod (a rolling deploy) can
    // still write pages and markers; whatever it commits after this read would be in neither the
    // document nor its anchors, and the purge would later delete the only copy. The radar lock
    // conflicts with the key-share an insert of a page takes on its radar; the page locks block
    // updates and deletes. Once this commits, the database fence (migration 0091) refuses them.
    await tx.execute(sql`SELECT 1 FROM radars WHERE id = ${radarId} FOR UPDATE`);
    await tx.execute(
      sql`SELECT 1 FROM blips WHERE radar_id = ${radarId} AND status = 'charter' ORDER BY id FOR UPDATE`,
    );
    const landed = await readDocument();
    if (landed) return already(landed);
    const pages = await tx
      .select({ id: schema.blips.id, body: schema.blips.body })
      .from(schema.blips)
      .where(and(eq(schema.blips.radarId, radarId), eq(schema.blips.status, 'charter')))
      .orderBy(asc(schema.blips.createdAt), asc(schema.blips.id));
    const refuse = (reason: string): MigrationReport => ({
      ...empty,
      pages: pages.length,
      status: 'refused',
      reason,
    });
    if (pages.length > 0) {
      const [commented] = await tx
        .select({ id: schema.blipComments.id })
        .from(schema.blipComments)
        .where(
          inArray(
            schema.blipComments.blipId,
            pages.map((p) => p.id),
          ),
        )
        .limit(1);
      if (commented) return refuse('a charter page has comments, which a document cannot keep');
    }
    const adrs = await tx
      .select({ id: schema.blips.id, status: schema.blips.status })
      .from(schema.blips)
      .where(and(eq(schema.blips.radarId, radarId), inArray(schema.blips.status, ADR_LANE_IDS)));
    const plan = planMigration(pages, new Set(adrs.map((a) => a.id)));
    if (!plan.ok) return refuse(plan.reason);
    const report: MigrationReport = {
      ...empty,
      status: pages.length === 0 ? 'empty' : 'migrated',
      pages: pages.length,
      characters: plan.body.length,
      anchors: plan.anchors.length,
      versions: pages.length === 0 ? 0 : 1,
    };
    if (options.dryRun) return report;
    if (pages.length === 0) {
      await tx.insert(schema.charterDocuments).values({ radarId });
      return report;
    }
    // Verified before anything is kept: every anchor's quote is the text at its place.
    const projection = projectionOf(plan.body);
    for (const a of plan.anchors)
      if (projection.text.slice(a.start, a.end) !== a.selector.quote)
        throw new Error(`migration of ${radarId}: an anchor does not sit on its quote`);
    const now = new Date();
    await tx.insert(schema.charterDocuments).values({
      radarId,
      body: plan.body,
      revision: 1,
      sealedVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const laneOf = new Map(adrs.map((a) => [a.id, a.status as string]));
    const ids = plan.anchors.map(() => randomUUID());
    if (plan.anchors.length > 0) {
      await tx.insert(schema.charterAnchors).values(
        plan.anchors.map((a, i) => ({
          id: ids[i] as string,
          radarId,
          kind: 'amend' as const,
          subjectId: a.adr,
          withText: a.with,
          quote: a.selector.quote,
          prefix: a.selector.prefix,
          suffix: a.selector.suffix,
          posStart: a.start,
          posEnd: a.end,
          state: 'anchored' as const,
          resolvedVersion: 1,
          // Layers on one span keep their order: created_at is the stacking order.
          createdAt: new Date(now.getTime() + i),
          updatedAt: now,
        })),
      );
      await tx.insert(schema.charterAnchorEvents).values(
        plan.anchors.map((a, i) => ({
          radarId,
          anchorId: ids[i] as string,
          kind: 'created' as const,
          version: 1,
          detail: { via: 'migration', page: a.pageId },
        })),
      );
    }
    await sealVersion(tx, {
      radarId,
      body: plan.body,
      version: 1,
      cause: 'migration',
      by: provenance(null),
      note: `moved from ${pages.length} pages`,
      anchors: Object.fromEntries(
        plan.anchors.map((a, i): [string, [number, number]] => [ids[i] ?? '', [a.start, a.end]]),
      ),
      adrLanes: Object.fromEntries(
        [...new Set(plan.anchors.map((a) => a.adr))].map((id) => [id, laneOf.get(id) ?? '']),
      ),
    });
    return report;
  });
}

/** Every Architecture radar that has no document yet, moved (or refused, with the reason). Best effort per radar. */
export async function migrateAllRadars(
  options: { dryRun?: boolean; only?: string } = {},
): Promise<MigrationReport[]> {
  const radars = await getDb()
    .select({ id: schema.radars.id, hasDocument: schema.charterDocuments.radarId })
    .from(schema.radars)
    .leftJoin(schema.charterDocuments, eq(schema.charterDocuments.radarId, schema.radars.id))
    .where(eq(schema.radars.template, 'architecture'))
    .orderBy(asc(schema.radars.createdAt), asc(schema.radars.id));
  const reports: MigrationReport[] = [];
  for (const radar of radars) {
    if (options.only && radar.id !== options.only) continue;
    if (radar.hasDocument && !options.dryRun && !options.only) continue;
    try {
      reports.push(await migrateRadar(radar.id, options));
    } catch (error) {
      reports.push({
        radarId: radar.id,
        status: 'refused',
        reason: error instanceof Error ? error.message : String(error),
        pages: 0,
        characters: 0,
        anchors: 0,
        versions: 0,
      });
    }
  }
  return reports;
}

/**
 * Every column that references a blip, from the catalog, so a table added later is covered. Not
 * the blip's own edit log (`blip_revisions`): it is the page's history, not something else that
 * points at it, and it goes with the page.
 */
async function blipDependents(tx: Tx) {
  const rows = await tx.execute<{ schema: string; table: string; column: string }>(sql`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
     WHERE k.contype = 'f' AND k.confrelid = 'blips'::regclass AND c.relname <> 'blip_revisions'
     ORDER BY 2, 3`);
  return rows.rows;
}

export interface KeptPage {
  id: string;
  reason: string;
}

/**
 * Delete the page blips of radars whose charter has been moved. A page goes only when
 *  - its written text (markers reduced to their quote) is wholly inside the document's first
 *    version;
 *  - every marker in its text, read again now, has its anchor (a marker written after the move
 *    would otherwise be lost with the page);
 *  - nothing refers to it: no comment, attachment, reaction, mention, notification, relation or
 *    any other row with a foreign key to blips (found in the catalog, so a table added later is
 *    covered). Deleting the page would delete or null those.
 * Everything else is kept and listed with its reason. Not run by the deploy: it is the one
 * irreversible step and waits for the radar's owner (`scripts/charter-one-document.ts --purge-pages`).
 */
export async function purgeMigratedPages(
  radarId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ deleted: number; kept: number; commented: number; keptPages: KeptPage[] }> {
  return getDb().transaction(async (tx) => {
    const none = { deleted: 0, kept: 0, commented: 0, keptPages: [] };
    const [first] = await tx
      .select({ body: schema.charterTexts.body })
      .from(schema.charterVersions)
      .innerJoin(
        schema.charterTexts,
        and(
          eq(schema.charterTexts.radarId, schema.charterVersions.radarId),
          eq(schema.charterTexts.sha256, schema.charterVersions.sha256),
        ),
      )
      .where(
        and(eq(schema.charterVersions.radarId, radarId), eq(schema.charterVersions.version, 1)),
      );
    if (!first) return none;
    // The pages, then the anchors, under the pages' locks: whatever else writes a page or hangs a
    // row on one waits (a comment or a reaction takes the blip's lock or key-share).
    const pages = await tx
      .select({ id: schema.blips.id, body: schema.blips.body })
      .from(schema.blips)
      .where(and(eq(schema.blips.radarId, radarId), eq(schema.blips.status, 'charter')))
      .orderBy(asc(schema.blips.id))
      .for('update');
    const anchors = await tx
      .select({
        subjectId: schema.charterAnchors.subjectId,
        quote: schema.charterAnchors.quote,
        withText: schema.charterAnchors.withText,
      })
      .from(schema.charterAnchors)
      .where(
        and(eq(schema.charterAnchors.radarId, radarId), eq(schema.charterAnchors.kind, 'amend')),
      );
    const ids = pages.map((p) => p.id);
    const dependents = new Map<string, Set<string>>();
    if (ids.length > 0)
      for (const d of await blipDependents(tx)) {
        const hit = await tx.execute<{ id: string }>(sql`
          SELECT DISTINCT ${sql.identifier(d.column)}::text AS id
            FROM ${sql.identifier(d.schema)}.${sql.identifier(d.table)}
           WHERE ${sql.identifier(d.column)} = ANY (${`{${ids.join(',')}}`}::uuid[])`);
        for (const row of hit.rows) {
          const set = dependents.get(row.id) ?? new Set<string>();
          set.add(d.table);
          dependents.set(row.id, set);
        }
      }
    const kept: KeptPage[] = [];
    const safe: string[] = [];
    for (const page of pages) {
      const used = dependents.get(page.id);
      const unmatched = parseMarkers(page.body).some((m) =>
        m.layers.some(
          (l) =>
            !anchors.some(
              (a) =>
                a.subjectId === l.adr &&
                a.quote === projectMarkdown(m.quote).text &&
                a.withText === l.with,
            ),
        ),
      );
      if (used) kept.push({ id: page.id, reason: `referenced by ${[...used].sort().join(', ')}` });
      else if (unmatched) kept.push({ id: page.id, reason: 'has a marker with no anchor' });
      else if (!first.body.includes(replaceMarkers(page.body, (m) => m.quote)))
        kept.push({ id: page.id, reason: 'its text is not in version 1' });
      else safe.push(page.id);
    }
    if (!options.dryRun && safe.length > 0) {
      // The one writer the page fence (migration 0091) lets through.
      await tx.execute(sql`SELECT set_config('omr.charter_purge', 'on', true)`);
      await tx.delete(schema.blips).where(inArray(schema.blips.id, safe));
    }
    return {
      deleted: safe.length,
      kept: kept.length,
      commented: ids.filter((id) => dependents.get(id)?.has('blip_comments')).length,
      keptPages: kept,
    };
  });
}

/* --------------------------------- sealing --------------------------------- */

export interface SealArgs {
  radarId: string;
  body: string;
  version: number;
  cause: 'edit' | 'adr' | 'anchor' | 'migration' | 'restore';
  causeBlipId?: string | null;
  note?: string | null;
  by: Provenance;
  anchors: Record<string, [number, number] | null>;
  adrLanes: Record<string, string>;
}

/** The agent's id when it still exists, else null. */
async function liveAgent(tx: Tx, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .for('key share');
  return row?.id ?? null;
}

/** One immutable version. The text is stored once per radar however many versions share it. */
export async function sealVersion(tx: Tx, a: SealArgs): Promise<void> {
  const hash = sha256(a.body);
  await tx
    .insert(schema.charterTexts)
    .values({ radarId: a.radarId, sha256: hash, body: a.body })
    .onConflictDoNothing();
  // The writer of a working text can be an agent that has been deleted since. The version is
  // sealed under its person alone, rather than failing on a foreign key every later save would hit.
  const agentId = a.by.agentId ? await liveAgent(tx, a.by.agentId) : null;
  await tx.insert(schema.charterVersions).values({
    radarId: a.radarId,
    version: a.version,
    sha256: hash,
    cause: a.cause,
    causeBlipId: a.causeBlipId ?? null,
    note: a.note ?? null,
    authorId: a.by.userId,
    sessionId: a.by.sessionId,
    clientLabel: a.by.label,
    agentId,
    anchors: a.anchors,
    adrLanes: a.adrLanes,
  });
}

/** Where every anchor stands now and the lane of each ADR that has one: what a version records. */
export async function snapshotOf(tx: Tx, radarId: string) {
  const rows = await tx
    .select()
    .from(schema.charterAnchors)
    .where(eq(schema.charterAnchors.radarId, radarId))
    .orderBy(asc(schema.charterAnchors.createdAt), asc(schema.charterAnchors.id));
  const subjects = [...new Set(rows.filter((r) => r.kind === 'amend').map((r) => r.subjectId))];
  const lanes =
    subjects.length === 0
      ? []
      : await tx
          .select({ id: schema.blips.id, status: schema.blips.status })
          .from(schema.blips)
          .where(inArray(schema.blips.id, subjects));
  return {
    rows,
    anchors: Object.fromEntries(
      rows.map((r) => [
        r.id,
        r.state === 'anchored' && r.posStart !== null && r.posEnd !== null
          ? ([r.posStart, r.posEnd] as [number, number])
          : null,
      ]),
    ),
    adrLanes: Object.fromEntries(lanes.map((l) => [l.id, l.status ?? ''])),
  };
}

/**
 * Seals the head as it stands when it is not already the last version (text written without a
 * seal, which only a path that does not seal itself can leave). Returns the last version number.
 */
export async function sealHeadIfDirty(tx: Tx, doc: Doc, by: Provenance): Promise<number> {
  if (doc.sealedVersion === 0 && doc.body.length === 0) return 0;
  // A working text is its writer's: it is sealed under their name, whoever is writing now.
  const owner: Provenance =
    doc.updatedBy === null && doc.updatedSession === null && doc.updatedWriter === null
      ? by
      : {
          userId: doc.updatedBy,
          sessionId: doc.updatedSession,
          label: doc.updatedLabel,
          writer: doc.updatedWriter,
          agentId: agentOfWriter(doc.updatedWriter),
        };
  const [last] = await tx
    .select({ sha256: schema.charterVersions.sha256 })
    .from(schema.charterVersions)
    .where(
      and(
        eq(schema.charterVersions.radarId, doc.radarId),
        eq(schema.charterVersions.version, doc.sealedVersion),
      ),
    );
  if (last?.sha256 === sha256(doc.body)) return doc.sealedVersion;
  const snap = await snapshotOf(tx, doc.radarId);
  const version = doc.sealedVersion + 1;
  await sealVersion(tx, {
    radarId: doc.radarId,
    body: doc.body,
    version,
    cause: 'edit',
    note: 'text as it stood before the next change',
    by: owner,
    anchors: snap.anchors,
    adrLanes: snap.adrLanes,
  });
  await tx
    .update(schema.charterDocuments)
    .set({ sealedVersion: version })
    .where(eq(schema.charterDocuments.radarId, doc.radarId));
  doc.sealedVersion = version;
  return version;
}

/* ------------------------------- full-text save ------------------------------ */

export const staleCharter = (revision: number) =>
  new ApiError(
    409,
    'stale',
    `The charter is at revision ${revision}; yours was based on an older one. Read it again and merge before saving.`,
    { revision: String(revision) },
  );

/** The architecture template's settings lock, shared, then the radar row key-shared: as `createBlip` does. */
export async function holdArchitectureRadar(tx: Tx, radarId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`radar-settings:${radarId}`}, 0))`,
  );
  const [radar] = await tx
    .select({ template: schema.radars.template })
    .from(schema.radars)
    .where(eq(schema.radars.id, radarId))
    .for('key share');
  if (radar?.template !== 'architecture')
    throw conflict('This radar is no longer on the architecture template.');
}

export async function labelsOf(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { title: string | null; lane: string | null }>();
  const rows = await tx
    .select({ id: schema.blips.id, title: schema.blips.title, status: schema.blips.status })
    .from(schema.blips)
    .where(inArray(schema.blips.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { title: r.title, lane: r.status }]));
}

export const toRef = (
  row: AnchorRow,
  subjects: Map<string, { title: string | null; lane: string | null }>,
): CharterAnchorRefDto => {
  const s = subjects.get(row.subjectId);
  return {
    anchorId: row.id,
    kind: row.kind,
    subject: {
      id: row.subjectId,
      // A link's subject is a boundary or contract: it is named by its title, not by an ADR number.
      label:
        row.kind === 'link'
          ? (s?.title ?? `element ${row.subjectId.slice(0, 8)}`)
          : adrLabel(s?.title ?? null, row.subjectId),
      lane: s?.lane ?? null,
    },
    // A link can quote a whole section; a to-do list names it by its first words.
    quote: row.kind === 'link' ? row.quote.slice(0, 240) : row.quote,
  };
};

export const toOrphan = (
  row: AnchorRow,
  subjects: Map<string, { title: string | null; lane: string | null }>,
): CharterOrphanDto => {
  return {
    ...toRef(row, subjects),
    cause: row.orphanCause ?? 'text_changed',
    resolvedVersion: row.resolvedVersion,
    orphanedVersion: row.orphanedVersion,
  };
};

/** A working text (written without a seal) is sealed by the next write once its writer has been quiet this long. */
export const WORKING_TEXT_IDLE_MS = 10 * 60 * 1000;

/**
 * Orphaned amendments of live ADRs, told to each ADR's author, once per save: the author is the
 * person (the cosigner of an agent that wrote the ADR), never the actor, who has the list in
 * their own response (`fanOut` also drops the actor when the same person). Enqueued in the save's
 * transaction so a notice exists exactly when the orphaning does; the worker re-checks that the
 * ADR is still orphaned and that the recipient can still read the radar.
 */
async function tellAuthors(
  tx: Tx,
  actor: Actor,
  radarId: string,
  orphaned: readonly AnchorRow[],
): Promise<void> {
  if (orphaned.length === 0) return;
  const adrs = await tx
    .select({ id: schema.blips.id, authorId: schema.blips.authorId })
    .from(schema.blips)
    .where(
      inArray(
        schema.blips.id,
        orphaned.map((r) => r.subjectId),
      ),
    );
  const mine = new Map<string, string[]>();
  for (const row of orphaned) {
    const author = adrs.find((a) => a.id === row.subjectId)?.authorId;
    if (!author) continue;
    const list = mine.get(author) ?? [];
    if (!list.includes(row.subjectId)) mine.set(author, [...list, row.subjectId]);
  }
  for (const [recipientId, blipIds] of mine)
    await enqueueNotificationEvent(tx, {
      type: 'charter-orphaned',
      actor,
      radarId,
      blipId: blipIds[0] as string,
      blipIds,
      recipientId,
    });
}

/**
 * Replace the whole charter. `baseRevision` must be the revision the writer read (409 `stale`
 * otherwise). Always succeeds past that: every anchor is re-resolved against the new text in this
 * transaction, and the response says what was orphaned (with its cause, the last version where it
 * resolved, and its quote), moved or healed.
 *
 * Unless `checkpoint` is false the result is sealed as a version. An editor that saves as the
 * person types sends `checkpoint: false`: the text becomes the head (and a new revision) but no
 * version is made, so a morning's typing is one version rather than hundreds. That working text is
 * sealed, under its writer's name, when the writer checkpoints, when anyone else writes, when it
 * has sat for `WORKING_TEXT_IDLE_MS`, and by any save that orphans or heals an amendment (those
 * point at a version, which has to exist).
 */
export async function writeCharterText(
  actor: Actor,
  radarId: string,
  input: {
    /**
     * The text, or a function that reads it inside the save's transaction (after the document is
     * locked and `baseRevision` checked): a restore reads its version there.
     */
    markdown: string | ((tx: Tx) => Promise<string>);
    baseRevision: number;
    note?: string | undefined;
    checkpoint?: boolean | undefined;
    /** Why the version exists; `restore` for a put-back of an earlier version. */
    cause?: 'edit' | 'restore' | undefined;
  },
  arbitrate?: (tx: Tx) => Promise<void>,
): Promise<WriteCharterResult> {
  return saveCharter(actor, radarId, {
    note: input.note,
    checkpoint: input.checkpoint,
    ...(arbitrate ? { arbitrate } : {}),
    ...(input.cause ? { cause: input.cause } : {}),
    next: (doc, tx) => {
      if (input.baseRevision !== doc.revision) throw staleCharter(doc.revision);
      return typeof input.markdown === 'string' ? input.markdown : input.markdown(tx);
    },
  });
}

/**
 * The one save path: `write_charter` (the whole text) and `edit_charter` (exact-text edits) both
 * come through here, so the orphan response, the sealing, the notifications and the limits are
 * written once. `next` is called under the document lock with the head as it stands and returns
 * the text to save (or throws: `stale`, `charter_conflict`).
 */
export async function saveCharter(
  actor: Actor,
  radarId: string,
  input: {
    next: (doc: Doc, tx: Tx) => string | Promise<string>;
    note?: string | undefined;
    checkpoint?: boolean | undefined;
    /** Why the version exists; `restore` for a put-back of an earlier version. */
    cause?: 'edit' | 'restore' | undefined;
    /** Runs first in the transaction, before any lock is taken: where an idempotency key is claimed. */
    arbitrate?: (tx: Tx) => Promise<void>;
  },
): Promise<WriteCharterResult> {
  await ensureCharterDocument(radarId);
  const by = provenance(actor);
  const checkpoint = input.checkpoint !== false;
  await chargeCharterSave(actor, radarId, checkpoint);
  // A save that did not ask to seal can still make a version (it orphaned or healed an amendment,
  // or sealed another writer's working text). Found out under the lock; the attempt is rolled
  // back, the seal budget is charged, and the save is made again having paid.
  let paid = checkpoint;
  for (;;) {
    try {
      return await retryOnConflict(() => saveOnce(actor, radarId, input, by, checkpoint, paid));
    } catch (error) {
      if (!(error instanceof SealNotPaid) || paid) throw error;
      await chargeCharterSeal(actor, radarId);
      paid = true;
    }
  }
}

class SealNotPaid extends Error {}

async function saveOnce(
  actor: Actor,
  radarId: string,
  input: {
    next: (doc: Doc, tx: Tx) => string | Promise<string>;
    note?: string | undefined;
    checkpoint?: boolean | undefined;
    cause?: 'edit' | 'restore' | undefined;
    arbitrate?: (tx: Tx) => Promise<void>;
  },
  by: Provenance,
  checkpoint: boolean,
  paid: boolean,
): Promise<WriteCharterResult> {
  return getDb().transaction(async (tx) => {
    // Lock order (charter-ops.ts): the idempotency key is claimed before the document is locked.
    await input.arbitrate?.(tx);
    await holdArchitectureRadar(tx, radarId);
    const doc = await lockCharter(tx, radarId);
    const sealedBefore = doc.sealedVersion;
    /** Refuses (rolling back) a save that made a version it has not paid the seal budget for. */
    const owe = (sealedNow: number) => {
      if (!paid && sealedNow !== sealedBefore) throw new SealNotPaid();
    };
    const markdown = await input.next(doc, tx);
    const sameWriter = doc.updatedWriter === by.writer;
    const quiet = Date.now() - doc.updatedAt.getTime() >= WORKING_TEXT_IDLE_MS;
    if (!sameWriter || quiet) await sealHeadIfDirty(tx, doc, by);
    if (markdown === doc.body) {
      const version = checkpoint ? await sealHeadIfDirty(tx, doc, by) : doc.sealedVersion;
      owe(version);
      return {
        revision: doc.revision,
        version,
        changed: false,
        orphaned: [],
        healed: [],
        moved: [],
        inertOrphaned: 0,
        chars: markdown.length,
      };
    }
    const rows = await tx
      .select()
      .from(schema.charterAnchors)
      .where(eq(schema.charterAnchors.radarId, radarId))
      .orderBy(asc(schema.charterAnchors.createdAt), asc(schema.charterAnchors.id));
    const hash = sha256(markdown);
    const before = projectionOf(doc.body);
    const after = projectionOf(markdown, hash);
    const resolved = resolveAnchors(
      before,
      after,
      rows.map((r) => ({
        id: r.id,
        state: r.state,
        selector: { quote: r.quote, prefix: r.prefix, suffix: r.suffix },
        start: r.posStart,
        end: r.posEnd,
      })),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    // A save that orphans or heals an amendment is preceded by a seal of the text it started from,
    // so "the last version where it resolved" always names a version that exists. Moving an
    // amendment along with the text above it is not one: typing would seal on every pause.
    const pointsAtVersion = resolved.anchors.some(
      (r) => r.outcome === 'orphaned' || r.outcome === 'healed',
    );
    const seal = checkpoint || pointsAtVersion;
    const resolvedAt = pointsAtVersion ? await sealHeadIfDirty(tx, doc, by) : doc.sealedVersion;
    /** The number this text has, or will have when it is sealed. */
    const version = doc.sealedVersion + 1;
    const events: Array<typeof schema.charterAnchorEvents.$inferInsert> = [];
    const changed = {
      orphaned: [] as AnchorRow[],
      healed: [] as AnchorRow[],
      moved: [] as AnchorRow[],
    };
    for (const r of resolved.anchors) {
      const row = byId.get(r.id) as AnchorRow;
      const same =
        r.state === row.state &&
        r.start === row.posStart &&
        r.end === row.posEnd &&
        r.selector.quote === row.quote &&
        r.selector.prefix === row.prefix &&
        r.selector.suffix === row.suffix;
      if (same && r.outcome !== 'orphaned' && r.outcome !== 'healed') continue;
      const patch: Partial<typeof schema.charterAnchors.$inferInsert> = {
        state: r.state,
        posStart: r.start,
        posEnd: r.end,
        quote: r.selector.quote,
        prefix: r.selector.prefix,
        suffix: r.selector.suffix,
        updatedAt: new Date(),
      };
      if (r.outcome === 'orphaned') {
        patch.orphanCause = r.cause ?? 'text_changed';
        patch.resolvedVersion = resolvedAt;
        patch.orphanedVersion = version;
      } else if (r.outcome === 'healed') {
        patch.orphanCause = null;
        patch.orphanedVersion = null;
        patch.resolvedVersion = version;
      } else if (r.outcome === 'moved' && seal) patch.resolvedVersion = version;
      if (r.outcome === 'still-orphaned') continue;
      await tx.update(schema.charterAnchors).set(patch).where(eq(schema.charterAnchors.id, r.id));
      const updated: AnchorRow = { ...row, ...(patch as Partial<AnchorRow>) };
      if (r.outcome === 'orphaned') changed.orphaned.push(updated);
      if (r.outcome === 'healed') changed.healed.push(updated);
      if (r.outcome === 'moved') changed.moved.push(updated);
      if (r.outcome === 'orphaned' || r.outcome === 'healed' || r.outcome === 'moved')
        events.push({
          radarId,
          anchorId: r.id,
          kind: r.outcome,
          version,
          actorId: by.userId,
          sessionId: by.sessionId,
          detail:
            r.outcome === 'orphaned'
              ? { cause: r.cause, resolvedVersion: resolvedAt }
              : { from: [row.posStart, row.posEnd], to: [r.start, r.end] },
        });
    }
    if (events.length > 0) await tx.insert(schema.charterAnchorEvents).values(events);
    const revision = doc.revision + 1;
    await tx
      .update(schema.charterDocuments)
      .set({
        body: markdown,
        revision,
        ...(seal ? { sealedVersion: version } : {}),
        updatedAt: new Date(),
        updatedBy: by.userId,
        updatedSession: by.sessionId,
        updatedWriter: by.writer,
        updatedLabel: by.label,
      })
      .where(eq(schema.charterDocuments.radarId, radarId));
    if (seal) {
      const snap = await snapshotOf(tx, radarId);
      await sealVersion(tx, {
        radarId,
        body: markdown,
        version,
        cause: input.cause ?? 'edit',
        note: input.note ?? null,
        by,
        anchors: snap.anchors,
        adrLanes: snap.adrLanes,
      });
    }
    const subjects = await labelsOf(
      tx,
      [...changed.orphaned, ...changed.healed, ...changed.moved].map((r) => r.subjectId),
    );
    // A link has no lane to be live in: its orphaning always matters.
    const live = (r: AnchorRow) => r.kind === 'link' || isLive(subjects.get(r.subjectId)?.lane);
    owe(seal ? version : doc.sealedVersion);
    await tellAuthors(tx, actor, radarId, changed.orphaned.filter(live));
    return {
      revision,
      version: seal ? version : doc.sealedVersion,
      changed: true,
      orphaned: changed.orphaned.filter(live).map((r) => toOrphan(r, subjects)),
      healed: changed.healed.map((r) => toRef(r, subjects)),
      moved: changed.moved.map((r) => toRef(r, subjects)),
      inertOrphaned: changed.orphaned.filter((r) => !live(r)).length,
      chars: markdown.length,
    };
  });
}

/* ------------------------------ ADR amendments ------------------------------- */

/**
 * Where a quote may sit for the kind of anchor it is. An amendment replaces text in place, so it
 * stays inside one paragraph, heading or table cell, at most `AMEND_LIMITS.quote` characters; a
 * link only points, so it may cover several blocks, up to `CHARTER_LIMITS.linkQuote`. Neither may
 * cut inline code open or sit in it. Throws the refusal; shared by proposing and re-anchoring.
 */
export function checkPlacement(
  projection: ReturnType<typeof projectionOf>,
  start: number,
  end: number,
  quote: string,
  kind: 'amend' | 'link',
): void {
  if (kind === 'amend') {
    const first = blockAt(projection, start);
    const last = blockAt(projection, end - 1);
    if (!first || first !== last)
      throw new ApiError(
        422,
        'quote_spans_blocks',
        'An amendment replaces text inside one paragraph, heading or table cell. Select less.',
      );
  }
  const limit = kind === 'amend' ? AMEND_LIMITS.quote : CHARTER_LIMITS.linkQuote;
  if (quote.length > limit)
    throw new ApiError(422, 'quote_too_long', `A quote is at most ${limit} characters.`);
  if (cutsCode(projection, start, end) || projection.code.some(([f, t]) => start >= f && end <= t))
    throw new ApiError(
      422,
      'quote_in_code',
      kind === 'amend'
        ? "Code can't be amended; select the surrounding text."
        : "Code can't be linked; select the surrounding text.",
    );
}

export interface AdrAnchorInput {
  quote: string;
  with: string;
  prefix?: string | undefined;
  suffix?: string | undefined;
  occurrence?: number | undefined;
  seen?: number | undefined;
}

export function selectionRefusal(
  code: string,
  matches: ReadonlyArray<{ context: string }> = [],
): ApiError {
  const detail = matches.map((m, i) => `${i + 1}. …${m.context}…`).join('\n');
  const fields = Object.fromEntries(matches.map((m, i) => [`match${i + 1}.context`, m.context]));
  switch (code) {
    case 'quote_ambiguous':
      return new ApiError(
        409,
        code,
        `That quote appears more than once. Select more text, or send the words before and after it as prefix and suffix.\n${detail}`,
        fields,
      );
    case 'quote_moved':
      return new ApiError(409, code, 'The text changed since you selected it. Select it again.');
    case 'invalid_selection':
      return new ApiError(422, code, 'occurrence and seen go together, as whole numbers.');
    default:
      return new ApiError(
        422,
        'quote_not_found',
        'That text is not in the charter, exactly as quoted.',
      );
  }
}

/**
 * Write one ADR's anchors into the charter's table, in the caller's transaction (the ADR's
 * `createBlip`). The charter is locked first. A quote is found on the projection, must sit in one
 * block, may not cut inline code open, and may not overlap text a live ADR already amends unless
 * it is exactly that span and the ADR it replaces (`supersedes`) is the newest live layer on it.
 * Seals a version (`cause: 'adr'`) when anything was anchored. Any refusal throws, so the whole
 * proposal rolls back.
 */
export async function anchorAdr(
  tx: Tx,
  radarId: string,
  adrId: string,
  anchors: readonly AdrAnchorInput[],
  supersedes: string | null | undefined,
  actor: Actor | null,
): Promise<CharterAnchorDto[]> {
  if (anchors.length === 0) return [];
  for (const anchor of anchors) {
    const bad = withProblem(anchor.with);
    if (bad) throw badRequest(bad);
  }
  const by = provenance(actor);
  const doc = await lockCharter(tx, radarId);
  const projection = projectionOf(doc.body);
  const existing = await tx
    .select()
    .from(schema.charterAnchors)
    .where(and(eq(schema.charterAnchors.radarId, radarId), eq(schema.charterAnchors.kind, 'amend')))
    .orderBy(asc(schema.charterAnchors.createdAt), asc(schema.charterAnchors.id));
  if (existing.length + anchors.length > CHARTER_LIMITS.anchorsPerRadar)
    throw new ApiError(
      422,
      'too_many_anchors',
      'This charter already carries as many amendments as it can.',
    );
  const subjects = await labelsOf(
    tx,
    existing.map((r) => r.subjectId),
  );
  await sealHeadIfDirty(tx, doc, by);
  const version = doc.sealedVersion + 1;
  const placed: AnchorRow[] = [];
  const stamp = new Date();
  for (const anchor of anchors) {
    const found = resolveSelection(projection, { ...anchor, ignore: projection.code });
    if (!found.ok) {
      if (found.code === 'quote_not_found') {
        const inside = existing.find(
          (r) => r.state === 'anchored' && r.withText?.includes(anchor.quote),
        );
        if (inside)
          throw new ApiError(
            409,
            'quote_in_amendment',
            `That text is replacement text from ${inside.subjectId}. Supersede that ADR to change it.`,
            { adr: inside.subjectId },
          );
      }
      throw selectionRefusal(found.code, 'matches' in found ? found.matches : []);
    }
    const { start, end, selector } = found;
    checkPlacement(projection, start, end, selector.quote, 'amend');
    // Live amendments that hold any of these words.
    const overlapping = [...existing, ...placed].filter(
      (r) =>
        r.state === 'anchored' &&
        r.posStart !== null &&
        r.posEnd !== null &&
        start < r.posEnd &&
        end > r.posStart &&
        isLive(subjects.get(r.subjectId)?.lane ?? (r.subjectId === adrId ? 'proposed' : null)),
    );
    if (overlapping.length > 0) {
      const exact = overlapping.every((r) => r.posStart === start && r.posEnd === end);
      const newest = overlapping[overlapping.length - 1] as AnchorRow;
      if (!exact || newest.subjectId !== supersedes)
        throw new ApiError(
          409,
          'quote_overlaps',
          exact
            ? `That span is already amended by ${newest.subjectId}. Propose with supersedes set to it.`
            : `That text is already part of an amendment (${newest.subjectId}). Select the whole amended span and supersede that ADR.`,
          { adr: newest.subjectId },
        );
    }
    const [row] = await tx
      .insert(schema.charterAnchors)
      .values({
        radarId,
        kind: 'amend',
        subjectId: adrId,
        withText: anchor.with,
        quote: selector.quote,
        prefix: selector.prefix,
        suffix: selector.suffix,
        posStart: start,
        posEnd: end,
        state: 'anchored',
        resolvedVersion: version,
        createdBy: by.userId,
        // Layers on one span stack in this order; one transaction has one `now()`, so spread it.
        createdAt: new Date(stamp.getTime() + placed.length),
      })
      .returning();
    if (!row) throw new Error('anchor insert returned nothing');
    placed.push(row);
    await tx.insert(schema.charterAnchorEvents).values({
      radarId,
      anchorId: row.id,
      kind: 'created',
      version,
      actorId: by.userId,
      sessionId: by.sessionId,
      detail: { adr: adrId },
    });
  }
  const snap = await snapshotOf(tx, radarId);
  await sealVersion(tx, {
    radarId,
    body: doc.body,
    version,
    cause: 'adr',
    causeBlipId: adrId,
    by,
    anchors: snap.anchors,
    adrLanes: snap.adrLanes,
  });
  await tx
    .update(schema.charterDocuments)
    .set({ sealedVersion: version })
    .where(eq(schema.charterDocuments.radarId, radarId));
  return placed.map(toAnchorDto);
}

export function toAnchorDto(row: AnchorRow): CharterAnchorDto {
  return {
    id: row.id,
    pageId: row.radarId,
    quote: row.quote,
    with: row.withText ?? '',
    // Anchored is the norm and left unsaid: a client reads a missing state as anchored.
    ...(row.state === 'anchored' ? {} : { state: row.state }),
    ...(row.state === 'orphaned' && row.orphanCause
      ? {
          cause: row.orphanCause,
          resolvedVersion: row.resolvedVersion,
          orphanedVersion: row.orphanedVersion,
        }
      : {}),
  };
}

/* ------------------------- lane changes of anchored ADRs ----------------------- */

/**
 * Called by the shared lane-move path (`updateBlip`), in its transaction, for an ADR on an
 * Architecture radar that is moving into the accepted lane: refused while any of its anchors is
 * orphaned. Takes the document lock first, so a save that orphans an anchor either lands before
 * this reads (and the accept is refused) or after this commits.
 */
export async function assertAdrAcceptable(tx: Tx, radarId: string, adrId: string): Promise<void> {
  await lockCharter(tx, radarId);
  const [orphan] = await tx
    .select({ quote: schema.charterAnchors.quote })
    .from(schema.charterAnchors)
    .where(
      and(
        eq(schema.charterAnchors.subjectId, adrId),
        eq(schema.charterAnchors.kind, 'amend'),
        eq(schema.charterAnchors.state, 'orphaned'),
      ),
    )
    .limit(1);
  if (orphan)
    throw new ApiError(
      409,
      'adr_orphaned',
      `The text this ADR amends ("${orphan.quote.slice(0, 80)}") is no longer in the charter. Save it back into the charter, re-anchor the ADR, or reject it instead.`,
      { quote: orphan.quote },
    );
}

/**
 * After an ADR's lane (or one it replaced) changed: records it as a version when any ADR with an
 * anchor now sits in a different lane from the last version's record. Taken under the document
 * lock; does nothing on a charter with no anchors.
 */
export async function sealAfterLaneChange(
  tx: Tx,
  radarId: string,
  causeBlipId: string,
  actor: Actor | null,
): Promise<void> {
  // Locked first: a save in flight moves anchors, and a snapshot taken before it commits would
  // be sealed against the text it left.
  const doc = await lockCharter(tx, radarId);
  const snap = await snapshotOf(tx, radarId);
  if (snap.rows.length === 0) return;
  const [last] = await tx
    .select({ adrLanes: schema.charterVersions.adrLanes })
    .from(schema.charterVersions)
    .where(
      and(
        eq(schema.charterVersions.radarId, radarId),
        eq(schema.charterVersions.version, doc.sealedVersion),
      ),
    );
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([k, v]) => b[k] === v);
  if (last && same(last.adrLanes, snap.adrLanes)) return;
  const by = provenance(actor);
  await sealHeadIfDirty(tx, doc, by);
  const version = doc.sealedVersion + 1;
  await sealVersion(tx, {
    radarId,
    body: doc.body,
    version,
    cause: 'adr',
    causeBlipId,
    by,
    anchors: snap.anchors,
    adrLanes: snap.adrLanes,
  });
  await tx
    .update(schema.charterDocuments)
    .set({ sealedVersion: version })
    .where(eq(schema.charterDocuments.radarId, radarId));
}

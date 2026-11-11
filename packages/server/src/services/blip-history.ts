/**
 * Who changed a blip, from `blip_revisions` (0095, ADR-0028). The table is written by a trigger;
 * this file names the editor for it and reads the log back.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import {
  hasFacet,
  type BlipDto,
  type BlipHolderDto,
  type BlipRevisionDto,
  type ListBlipRevisionsQuery,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { notFound, type Actor } from '../http.js';
import { requireRadar } from './access.js';

type Executor = Pick<Db, 'execute'>;

/**
 * Name the editor for the revision trigger. Transaction-local, so a write made outside a
 * transaction, or by a writer that never calls this (a client's reply through the portal), records
 * no editor: blank, never somebody else's name.
 */
export async function setEditor(
  db: Executor,
  userId: string | null,
  agentId: string | null,
): Promise<void> {
  await db.execute(
    sql`SELECT set_config('omr.actor_user', ${userId ?? ''}, true), set_config('omr.actor_agent', ${agentId ?? ''}, true)`,
  );
}

type RevisionRow = {
  blip_id: string;
  revision: number;
  at: string | Date;
  editor_user_id: string | null;
  editor_agent_id: string | null;
  changed: BlipRevisionDto['changed'];
  prior_title: string | null;
  prior_body: string | null;
};

/**
 * The revisions of these blips, each only while it is still on the radar the caller authorized for
 * it, decided in the same statement: a move between the access check and this read returns nothing.
 * The one read behind both card hydration and the list.
 */
async function revisionsOf(scope: Array<{ id: string; radarId: string }>): Promise<RevisionRow[]> {
  if (scope.length === 0) return [];
  const pairs = sql.join(
    scope.map((s) => sql`(${s.id}::uuid, ${s.radarId}::uuid)`),
    sql`, `,
  );
  const { rows } = await getDb().execute<RevisionRow>(sql`
    SELECT r.* FROM blip_revisions r
    JOIN blips b ON b.id = r.blip_id
    WHERE (b.id, b.radar_id) IN (${pairs})`);
  return rows;
}

/** Display names for the editors on a page of revisions, in two lookups. */
export async function holders(
  rows: Array<Pick<RevisionRow, 'editor_user_id' | 'editor_agent_id'>>,
) {
  const present = (v: string | null): v is string => v !== null;
  const userIds = [...new Set(rows.map((r) => r.editor_user_id).filter(present))];
  const agentIds = [...new Set(rows.map((r) => r.editor_agent_id).filter(present))];
  const [users, agents] = await Promise.all([
    userIds.length > 0
      ? getDb()
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds))
      : [],
    agentIds.length > 0
      ? getDb()
          .select({ id: schema.agents.id, name: schema.agents.name })
          .from(schema.agents)
          .where(inArray(schema.agents.id, agentIds))
      : [],
  ]);
  const people = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  const names = new Map(agents.map((a) => [a.id, a.name]));
  return (row: Pick<RevisionRow, 'editor_user_id' | 'editor_agent_id'>): BlipHolderDto | null =>
    row.editor_user_id || row.editor_agent_id
      ? {
          userId: row.editor_user_id,
          agentId: row.editor_agent_id,
          name:
            (row.editor_agent_id ? names.get(row.editor_agent_id) : undefined) ??
            (row.editor_user_id ? people.get(row.editor_user_id) : undefined) ??
            null,
        }
      : null;
}

type Creator = { id: string; radarId: string; authorId: string | null; agentId: string | null };

/**
 * `lastEditedBy` (omitted when the creator made the last edit) and `lastMovedBy` (only where the
 * radar's template declares the `moved` facet) for a page of blips. Signed-in readers only: the
 * public routes pass no viewer and never carry either.
 */
export async function historyFor(
  rows: Creator[],
  viewerId: string | null,
): Promise<Map<string, Pick<BlipDto, 'lastEditedBy' | 'lastMovedBy'>>> {
  const out = new Map<string, Pick<BlipDto, 'lastEditedBy' | 'lastMovedBy'>>();
  if (!viewerId || rows.length === 0) return out;
  const revisions = await revisionsOf(rows);
  if (revisions.length === 0) return out;
  const newest = (id: string, fields: string[]) =>
    revisions
      .filter((r) => r.blip_id === id && r.changed.some((f) => fields.includes(f)))
      .reduce<RevisionRow | undefined>((a, r) => (a && a.revision > r.revision ? a : r), undefined);
  const moveRadars = new Map<string, string | null>();
  const wanted = rows.map((row) => ({
    row,
    edit: newest(row.id, ['title', 'body']),
    move: newest(row.id, ['status', 'radar']),
  }));
  const movedIds = [...new Set(wanted.filter((w) => w.move).map((w) => w.row.radarId))];
  if (movedIds.length > 0)
    for (const radar of await getDb()
      .select({ id: schema.radars.id, template: schema.radars.template })
      .from(schema.radars)
      .where(inArray(schema.radars.id, movedIds)))
      moveRadars.set(radar.id, radar.template);
  const named = await holders(
    wanted.flatMap((w) => [w.edit, w.move]).filter((r): r is RevisionRow => r !== undefined),
  );
  for (const { row, edit, move } of wanted) {
    const by = (r: RevisionRow) => {
      const holder = named(r);
      return holder ? { ...holder, at: new Date(r.at).toISOString() } : undefined;
    };
    const creatorEdit =
      edit &&
      edit.editor_user_id === row.authorId &&
      (edit.editor_agent_id ?? null) === (row.agentId ?? null);
    const lastEditedBy = edit && !creatorEdit ? by(edit) : undefined;
    const lastMovedBy =
      move && hasFacet(moveRadars.get(row.radarId), 'moved') ? by(move) : undefined;
    if (lastEditedBy || lastMovedBy)
      out.set(row.id, {
        ...(lastEditedBy ? { lastEditedBy } : {}),
        ...(lastMovedBy ? { lastMovedBy } : {}),
      });
  }
  return out;
}

/** The recorded changes to a blip, newest first, for anyone who can read its radar. */
export async function listBlipRevisions(
  actor: Actor,
  blipId: string,
  query: ListBlipRevisionsQuery,
): Promise<BlipRevisionDto[]> {
  const [blip] = await getDb()
    .select({ radarId: schema.blips.radarId })
    .from(schema.blips)
    .where(eq(schema.blips.id, blipId))
    .limit(1);
  if (!blip) throw notFound('Blip not found');
  await requireRadar(blip.radarId, actor, 'read');
  return revisionsIn(blip.radarId, blipId, query.limit);
}

/** The log of a blip while it is on `radarId` (nothing once it has moved away). */
export async function revisionsIn(
  radarId: string,
  blipId: string,
  limit = 25,
): Promise<BlipRevisionDto[]> {
  const rows = (await revisionsOf([{ id: blipId, radarId }]))
    .sort((a, b) => b.revision - a.revision)
    .slice(0, limit);
  const holder = await holders(rows);
  return rows.map((r) => ({
    revision: r.revision,
    at: new Date(r.at).toISOString(),
    editor: holder(r),
    changed: r.changed,
    priorTitle: r.prior_title,
    priorBody: r.prior_body,
  }));
}

/**
 * How a sealed version of the charter reads (plan e715ea20, S6): who wrote it and why, its text,
 * and the anchors as they stood in it. Reads only; `architecture.ts` (a past version of the
 * architecture) and `charter-versions.ts` (the list, the diff, restore) both use it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { CharterVersionDto } from '@onmyradar/contract';
import { schema, type Db } from '../db/client.js';
import { notFound } from '../http.js';
import { adrLabel } from './charter.js';

type Reader = Pick<Db, 'select'>;
export type VersionRow = typeof schema.charterVersions.$inferSelect;

/** One sealed version and its text. Another radar's number, or one that does not exist, is not found. */
export async function readVersion(
  db: Reader,
  radarId: string,
  version: number,
): Promise<{ row: VersionRow; body: string }> {
  const [found] = await db
    .select({ row: schema.charterVersions, body: schema.charterTexts.body })
    .from(schema.charterVersions)
    .innerJoin(
      schema.charterTexts,
      and(
        eq(schema.charterTexts.radarId, schema.charterVersions.radarId),
        eq(schema.charterTexts.sha256, schema.charterVersions.sha256),
      ),
    )
    .where(
      and(eq(schema.charterVersions.radarId, radarId), eq(schema.charterVersions.version, version)),
    );
  if (!found) throw notFound('Version not found');
  return found;
}

const WHY: Record<VersionRow['cause'], string> = {
  edit: 'edit',
  adr: 'ADR',
  anchor: 'link',
  migration: 'moved from pages',
  restore: 'restore',
};

/** The people, agents and blips a set of versions name, read together. */
export async function versionDtos(
  db: Reader,
  rows: readonly VersionRow[],
): Promise<CharterVersionDto[]> {
  const ids = <T>(pick: (r: VersionRow) => T | null): T[] => [
    ...new Set(rows.flatMap((r) => pick(r) ?? [])),
  ];
  const authorIds = ids((r) => r.authorId);
  const agentIds = ids((r) => r.agentId);
  const blipIds = ids((r) => r.causeBlipId);
  const [people, agents, blips] = await Promise.all([
    authorIds.length === 0
      ? []
      : db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, authorIds)),
    agentIds.length === 0
      ? []
      : db
          .select({
            id: schema.agents.id,
            name: schema.agents.name,
            handle: schema.agents.slug,
          })
          .from(schema.agents)
          .where(inArray(schema.agents.id, agentIds)),
    blipIds.length === 0
      ? []
      : db
          .select({
            id: schema.blips.id,
            title: schema.blips.title,
            status: schema.blips.status,
          })
          .from(schema.blips)
          .where(inArray(schema.blips.id, blipIds)),
  ]);
  const person = new Map(people.map((p) => [p.id, p.name]));
  const agent = new Map(agents.map((a) => [a.id, a]));
  const blip = new Map(blips.map((b) => [b.id, b]));
  return rows.map((r): CharterVersionDto => {
    const subjectBlip = r.causeBlipId ? blip.get(r.causeBlipId) : undefined;
    const subject =
      r.causeBlipId && subjectBlip
        ? {
            id: r.causeBlipId,
            // An ADR is named by its number; a boundary or contract by its title.
            label:
              subjectBlip.status === 'boundary' || subjectBlip.status === 'contract'
                ? (subjectBlip.title ?? 'element')
                : adrLabel(subjectBlip.title, r.causeBlipId),
            lane: subjectBlip.status,
          }
        : null;
    const author = r.authorId ? (person.get(r.authorId) ?? null) : null;
    const ag = r.agentId ? agent.get(r.agentId) : undefined;
    const by: CharterVersionDto['by'] = ag
      ? { kind: 'agent', id: ag.id, name: ag.name, handle: ag.handle, onBehalfOf: author }
      : { kind: 'person', id: r.authorId, name: author };
    const lane = r.causeBlipId ? r.adrLanes[r.causeBlipId] : undefined;
    const note = r.note && r.note.length > 60 ? `${r.note.slice(0, 59)}…` : r.note;
    const why =
      subject && r.cause === 'adr'
        ? [subject.label, lane].filter(Boolean).join(' ')
        : subject && r.cause === 'anchor'
          ? `${WHY.anchor} ${subject.label}`
          : (note ?? WHY[r.cause]);
    return {
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      cause: r.cause,
      label: [`v${r.version}`, why, by.name ?? (by.kind === 'agent' ? 'an agent' : 'someone')].join(
        ' · ',
      ),
      note: r.note,
      by,
      via: r.clientLabel,
      subject,
      lane: lane ?? null,
      // A restore's note is "Restored version N" unless the person wrote their own.
      restoredFrom:
        r.cause === 'restore'
          ? Number(/^Restored version (\d+)$/.exec(r.note ?? '')?.[1]) || null
          : null,
    };
  });
}

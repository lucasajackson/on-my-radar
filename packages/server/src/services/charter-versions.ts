/**
 * The charter's history for a reader (plan e715ea20, S6): the list of sealed versions, the diff
 * between two, and restoring one as a new version. Sealing itself is `charter.ts`; how one version
 * reads is `charter-version-view.ts`.
 *
 * History is append-only: restoring adds a version and rewrites nothing. It is also **members
 * only**. A radar published by a public link shows its current charter and nothing of how it got
 * there, so every door here refuses a public-link reader as if the radar were not there.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import {
  blockAt,
  diffText,
  type CharterDiffDto,
  type CharterDiffHunk,
  type CharterVersionsDto,
  type RestoreCharterResult,
  type TextProjection,
  type diffCharterQuerySchema,
  type listCharterVersionsQuerySchema,
  type restoreCharterSchema,
} from '@onmyradar/contract';
import type { z } from 'zod';
import { getDb, schema } from '../db/client.js';
import type { Actor } from '../http.js';
import { writeAsAgent } from './agents.js';
import { architectureRadar, charterNow, keyed } from './architecture.js';
import { ensureCharterDocument, writeCharterText } from './charter.js';
import { projectionOf, sha256 } from './charter-model.js';
import { readVersion, versionDtos } from './charter-version-view.js';

/* ---------------------------------- list ---------------------------------- */

export async function listCharterVersions(
  actor: Actor,
  radarId: string,
  query: z.infer<typeof listCharterVersionsQuerySchema>,
): Promise<CharterVersionsDto> {
  const radar = await architectureRadar(radarId, actor, 'read', getDb(), { members: true });
  await ensureCharterDocument(radar.id);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.charterVersions)
    .where(
      and(
        eq(schema.charterVersions.radarId, radar.id),
        query.before === undefined ? undefined : lt(schema.charterVersions.version, query.before),
      ),
    )
    .orderBy(desc(schema.charterVersions.version))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const [doc] = await db
    .select()
    .from(schema.charterDocuments)
    .where(eq(schema.charterDocuments.radarId, radar.id));
  const [newest] =
    doc && doc.sealedVersion > 0
      ? await db
          .select({ sha256: schema.charterVersions.sha256 })
          .from(schema.charterVersions)
          .where(
            and(
              eq(schema.charterVersions.radarId, radar.id),
              eq(schema.charterVersions.version, doc.sealedVersion),
            ),
          )
      : [];
  return {
    versions: await versionDtos(db, page),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.version ?? null) : null,
    head: {
      revision: doc?.revision ?? 0,
      version: doc?.sealedVersion ?? 0,
      // Text written since the newest version was sealed: a working text, not yet history.
      unsealed: doc ? (newest ? newest.sha256 !== sha256(doc.body) : doc.body.length > 0) : false,
    },
  };
}

/* ---------------------------------- diff ---------------------------------- */

/** Hunks listed, and the longest struck or inserted text shown, per diff: the counts always cover everything. */
export const DIFF_LIMITS = { hunks: 200, text: 400 } as const;

const sectionAt = (projection: TextProjection, at: number): string[] | null => {
  const block =
    blockAt(projection, at) ?? blockAt(projection, at + 2) ?? blockAt(projection, at - 1);
  return block ? [...block.headingPath] : null;
};

const shown = (text: string): string =>
  text.length > DIFF_LIMITS.text ? `${text.slice(0, DIFF_LIMITS.text - 1)}…` : text;

/**
 * Struck and inserted ranges between two versions (or `head`), on the words a reader sees: the
 * projections are compared with the anchors' own word diff, so a re-escaped table or a changed
 * bullet shows nothing. Offsets are into each side's projection.
 */
export async function diffCharter(
  actor: Actor,
  radarId: string,
  query: z.infer<typeof diffCharterQuerySchema>,
): Promise<CharterDiffDto> {
  const radar = await architectureRadar(radarId, actor, 'read', getDb(), { members: true });
  await ensureCharterDocument(radar.id);
  const side = async (ref: number | 'head'): Promise<string> => {
    if (ref !== 'head') return (await readVersion(getDb(), radar.id, ref)).body;
    const [doc] = await getDb()
      .select({ body: schema.charterDocuments.body })
      .from(schema.charterDocuments)
      .where(eq(schema.charterDocuments.radarId, radar.id));
    return doc?.body ?? '';
  };
  const [before, after] = [
    projectionOf(await side(query.from)),
    projectionOf(await side(query.to)),
  ];
  const diff = diffText(before.text, after.text);
  const hunks: CharterDiffHunk[] = [];
  const stats = { hunks: 0, struckChars: 0, insertedChars: 0 };
  const gap = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
    if (aTo <= aFrom && bTo <= bFrom) return;
    stats.hunks++;
    stats.struckChars += Math.max(0, aTo - aFrom);
    stats.insertedChars += Math.max(0, bTo - bFrom);
    if (hunks.length >= DIFF_LIMITS.hunks) return;
    hunks.push({
      section: bTo > bFrom ? sectionAt(after, bFrom) : sectionAt(before, aFrom),
      struck:
        aTo > aFrom ? { start: aFrom, end: aTo, text: shown(before.text.slice(aFrom, aTo)) } : null,
      inserted:
        bTo > bFrom ? { start: bFrom, end: bTo, text: shown(after.text.slice(bFrom, bTo)) } : null,
    });
  };
  let a = 0;
  let b = 0;
  for (const run of diff.runs) {
    gap(a, run.oldStart, b, run.newStart);
    a = run.oldStart + run.length;
    b = run.newStart + run.length;
  }
  gap(a, before.text.length, b, after.text.length);
  return {
    from: { version: query.from },
    to: { version: query.to },
    identical: before.text === after.text,
    exact: diff.exact,
    truncated: stats.hunks > hunks.length,
    stats,
    hunks,
  };
}

/* --------------------------------- restore -------------------------------- */

/**
 * Puts an earlier version's text back as a new version. It goes through the same save as
 * `write_charter` (so `baseRevision` is checked, and amendments and links whose words come back
 * heal), sealed with cause `restore`. Nothing in history changes. Restoring text that is already
 * the head changes nothing and adds nothing.
 */
export async function restoreCharter(
  actor: Actor,
  radarId: string,
  version: number,
  input: z.infer<typeof restoreCharterSchema>,
): Promise<RestoreCharterResult> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  // `saveCharter` claims the key first, locks the document, and retries a deadlock once: a
  // restore is one more way to write the charter (charter-ops.ts, lock order).
  return keyed(
    actor,
    'charter.write',
    radar.id,
    idempotencyKey,
    { op: 'restore', version, ...request },
    async (record) => {
      const result = await writeCharterText(
        actor,
        radar.id,
        {
          // Read in the save's own transaction, under the document lock and after `baseRevision`
          // has been checked against the head: not before, where the head could move on.
          markdown: async (tx) => (await readVersion(tx, radar.id, version)).body,
          baseRevision: request.baseRevision,
          note: request.note ?? `Restored version ${version}`,
          cause: 'restore',
        },
        (tx) => record(tx, radar.id),
      );
      return { ...result, restoredFrom: version };
    },
    async () => ({ ...(await charterNow(radar.id)), restoredFrom: version }),
  );
}

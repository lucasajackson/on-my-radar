/**
 * What is done to a charter after it exists: exact-text edits (`edit_charter`), and the two ways an
 * orphaned anchor is settled, `reanchor` and `dismiss`. The save path, the sealing and the anchor
 * model are `charter.ts`; this file only adds verbs on top of its exports, so the two can change
 * independently.
 *
 * LOCK ORDER. Every path that can touch the charter, an ADR or an anchor takes its locks in this
 * one order, and never goes back:
 *
 *   1. the idempotency key (`record` / `arbitrate`: an INSERT that a twin holding the key waits on),
 *   2. the charter document row (`lockCharter`; the radar's settings lock, shared, and the radar
 *      row, key-shared, come just before it, and nothing else waits on them),
 *   3. the ADR row (`updateBlip`'s FOR UPDATE, `lockedAnchor`'s FOR SHARE),
 *   4. the anchor rows.
 *
 * `saveCharter` (write_charter, edit_charter), `reanchorAnchor` and `dismissAnchor` claim the key
 * first and then lock the document; `updateBlip` (decide_adr, accept, reject, repeal, any lane
 * move on a ratifying radar) claims it first, takes the document lock before the ADR's FOR UPDATE,
 * and only then reads the ADR. A deadlock the order cannot prevent (the database picks a victim)
 * is retried once as a whole (`retryOnConflict`) and otherwise answers 503 with Retry-After.
 *
 * Everything that changes an anchor runs under the document's row lock (`lockCharter`), after the
 * architecture settings lock is held shared, the order every charter writer takes. Re-anchoring
 * and dismissing seal a version (`cause: 'anchor'`) so the history of "where did this amendment
 * stand" is a real version, and write an event row and an audit row in the same transaction.
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  CHARTER_LIMITS,
  resolveSelection,
  type AnchorActionResult,
  type EditCharterResult,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { retryOnConflict } from '../errors.js';
import { ApiError, notFound, type Actor } from '../http.js';
import { chargeCharterSave } from './charter-limits.js';
import { projectionOf } from './charter-model.js';
import {
  adrLabel,
  checkPlacement,
  holdArchitectureRadar,
  isLive,
  lockCharter,
  provenance,
  saveCharter,
  sealHeadIfDirty,
  sealVersion,
  selectionRefusal,
  snapshotOf,
  type AnchorRow,
  type Tx,
} from './charter.js';
import { recordAudit } from './audit.js';

/* ------------------------------- exact edits ------------------------------- */

const conflict = (index: number, why: string, revision: number) =>
  new ApiError(
    409,
    'charter_conflict',
    `Edit ${index + 1}: ${why} Nothing was changed; read the charter again (revision ${revision}) and resend.`,
    { edit: String(index + 1), revision: String(revision) },
  );

/** Start positions of `needle` in `text`, overlapping ones included, stopping at `limit`. */
function occurrencesOf(text: string, needle: string, limit: number): number[] {
  const at: number[] = [];
  for (let from = text.indexOf(needle); from !== -1 && at.length < limit;) {
    at.push(from);
    from = text.indexOf(needle, from + 1);
  }
  return at;
}

/**
 * Apply `edits` to `body`, all or none. Every `find` is matched against the text as it stands
 * (never against the result of an earlier edit), must occur exactly once, and must not overlap
 * another edit's text; they are then spliced from the back so positions never shift. Throws
 * `charter_conflict` (409), naming the edit, on a miss, a repeat or an overlap.
 */
export function applyEdits(
  body: string,
  edits: ReadonlyArray<{ find: string; replace: string }>,
  revision: number,
): string {
  const placed = edits.map((edit, index) => {
    const at = occurrencesOf(body, edit.find, 2);
    if (at.length === 0)
      throw conflict(index, 'that text is not in the charter, exactly as given.', revision);
    if (at.length > 1)
      throw conflict(
        index,
        'that text occurs more than once. Include more of the words around it.',
        revision,
      );
    return { index, start: at[0] as number, end: (at[0] as number) + edit.find.length, edit };
  });
  const byPosition = [...placed].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byPosition.length; i++) {
    const [before, after] = [byPosition[i - 1], byPosition[i]];
    if (before && after && after.start < before.end)
      throw conflict(after.index, `it overlaps edit ${before.index + 1}.`, revision);
  }
  let text = body;
  for (const p of [...byPosition].reverse())
    text = text.slice(0, p.start) + p.edit.replace + text.slice(p.end);
  if (text.length > CHARTER_LIMITS.document)
    throw new ApiError(
      422,
      'charter_too_large',
      `The charter would be ${text.length} characters; the most is ${CHARTER_LIMITS.document}.`,
    );
  return text;
}

/**
 * `edit_charter`: exact-text edits to the head. `baseRevision` is advisory by design: edits are
 * found by their text, so two writers' changes to different passages both land, and when the
 * charter has moved on since `baseRevision` the answer says `rebased`. An edit whose text moved
 * or changed is the conflict.
 */
export async function editCharterText(
  actor: Actor,
  radarId: string,
  input: {
    edits: ReadonlyArray<{ find: string; replace: string }>;
    baseRevision?: number | undefined;
    note?: string | undefined;
    checkpoint?: boolean | undefined;
  },
  arbitrate?: (tx: Tx) => Promise<void>,
): Promise<EditCharterResult> {
  const seen = { rebased: false };
  const result = await saveCharter(actor, radarId, {
    note: input.note,
    checkpoint: input.checkpoint,
    ...(arbitrate ? { arbitrate } : {}),
    next: (doc) => {
      seen.rebased = input.baseRevision !== undefined && input.baseRevision !== doc.revision;
      return applyEdits(doc.body, input.edits, doc.revision);
    },
  });
  return {
    ...result,
    applied: input.edits.length,
    ...(seen.rebased ? { rebased: true as const } : {}),
  };
}

/* ----------------------- re-anchoring and dismissing ----------------------- */

/** The anchor's radar, for the caller to authorise against before anything is touched. */
export async function anchorRadarId(anchorId: string): Promise<string> {
  const [row] = await getDb()
    .select({ radarId: schema.charterAnchors.radarId })
    .from(schema.charterAnchors)
    .where(eq(schema.charterAnchors.id, anchorId));
  if (!row) throw notFound('Anchor not found');
  return row.radarId;
}

const wasOf = (row: AnchorRow): AnchorActionResult['was'] => ({
  state: row.state,
  quote: row.quote,
  ...(row.state === 'orphaned' ? { orphanedVersion: row.orphanedVersion } : {}),
});

/**
 * The anchor locked, and the ADR (or element) it belongs to. Called under the charter lock of
 * `radarId`, the radar the caller was authorised on. The subject is locked first (shared, so a
 * move of it waits) and must still live on that radar, and the anchor must still be that radar's:
 * an ADR moved to another radar after the caller was authorised is not theirs to settle. Moving an
 * ADR re-homes its dismissed anchors with it (`rehomeAnchors`), so an anchor never points back at
 * a radar its ADR has left. Anything else is not found.
 */
async function lockedAnchor(tx: Tx, radarId: string, anchorId: string) {
  const [peek] = await tx
    .select({ subjectId: schema.charterAnchors.subjectId })
    .from(schema.charterAnchors)
    .where(and(eq(schema.charterAnchors.id, anchorId), eq(schema.charterAnchors.radarId, radarId)));
  if (!peek) throw notFound('Anchor not found');
  const [subject] = await tx
    .select({
      title: schema.blips.title,
      status: schema.blips.status,
      radarId: schema.blips.radarId,
    })
    .from(schema.blips)
    .where(eq(schema.blips.id, peek.subjectId))
    .for('share');
  if (!subject || subject.radarId !== radarId) throw notFound('Anchor not found');
  const [row] = await tx
    .select()
    .from(schema.charterAnchors)
    .where(and(eq(schema.charterAnchors.id, anchorId), eq(schema.charterAnchors.radarId, radarId)))
    .for('update');
  if (!row) throw notFound('Anchor not found');
  return {
    row,
    subject: {
      id: row.subjectId,
      label: adrLabel(subject.title, row.subjectId),
      lane: subject.status,
    },
  };
}

/**
 * An ADR is moving from one radar to another (`updateBlip`, in its transaction). Only a dismissed
 * amendment can be left on an ADR that moves (a placed or orphaned one refuses the move), and it
 * is history: its row and its events go with the ADR, so every anchor is on the radar its subject
 * is on, and nobody with access to the radar it left can reach it.
 */
export async function rehomeAnchors(
  tx: Pick<Tx, 'update'>,
  adrId: string,
  toRadarId: string,
): Promise<void> {
  const moved = await tx
    .update(schema.charterAnchors)
    .set({ radarId: toRadarId })
    .where(
      and(eq(schema.charterAnchors.subjectId, adrId), ne(schema.charterAnchors.radarId, toRadarId)),
    )
    .returning({ id: schema.charterAnchors.id });
  if (moved.length === 0) return;
  await tx
    .update(schema.charterAnchorEvents)
    .set({ radarId: toRadarId })
    .where(
      inArray(
        schema.charterAnchorEvents.anchorId,
        moved.map((m) => m.id),
      ),
    );
}

/**
 * Point an anchor at new words in the charter as it stands. Works on an orphaned, a dismissed or a
 * placed anchor (moving it). The old place is kept in the event it writes, and in the versions
 * that already recorded it. Refuses what `propose_adr` would refuse for the same words (a quote
 * that is not there, that recurs, that crosses a block, sits in code or in another live
 * amendment).
 */
export async function reanchorAnchor(
  actor: Actor,
  radarId: string,
  anchorId: string,
  input: { quote: string; prefix?: string | undefined; suffix?: string | undefined },
  arbitrate?: (tx: Tx) => Promise<void>,
): Promise<AnchorActionResult> {
  await chargeCharterSave(actor, radarId, true);
  return retryOnConflict(() =>
    getDb().transaction(async (tx) => {
      await arbitrate?.(tx);
      await holdArchitectureRadar(tx, radarId);
      const doc = await lockCharter(tx, radarId);
      const { row, subject } = await lockedAnchor(tx, radarId, anchorId);
      const by = provenance(actor);
      const projection = projectionOf(doc.body);
      const found = resolveSelection(projection, { ...input, ignore: projection.code });
      if (!found.ok) throw selectionRefusal(found.code, 'matches' in found ? found.matches : []);
      const { start, end, selector } = found;
      checkPlacement(projection, start, end, selector.quote, row.kind);
      if (row.kind === 'amend') {
        // Words a live amendment already replaces are not ours to take (the same rule as proposing),
        // other than a stretch this very anchor already sits on.
        const others = await tx
          .select()
          .from(schema.charterAnchors)
          .where(
            and(
              eq(schema.charterAnchors.radarId, radarId),
              eq(schema.charterAnchors.kind, 'amend'),
              eq(schema.charterAnchors.state, 'anchored'),
              ne(schema.charterAnchors.id, row.id),
            ),
          )
          .orderBy(asc(schema.charterAnchors.createdAt));
        const lanes = new Map<string, string | null>();
        for (const other of others) {
          if (other.posStart === null || other.posEnd === null) continue;
          if (!(start < other.posEnd && end > other.posStart)) continue;
          if (!lanes.has(other.subjectId)) {
            const [lane] = await tx
              .select({ status: schema.blips.status })
              .from(schema.blips)
              .where(eq(schema.blips.id, other.subjectId));
            lanes.set(other.subjectId, lane?.status ?? null);
          }
          if (isLive(lanes.get(other.subjectId)))
            throw new ApiError(
              409,
              'quote_overlaps',
              `That text is already part of an amendment (${other.subjectId}). Select other words.`,
              { adr: other.subjectId },
            );
        }
      }
      await sealHeadIfDirty(tx, doc, by);
      const version = doc.sealedVersion + 1;
      await tx
        .update(schema.charterAnchors)
        .set({
          state: 'anchored',
          orphanCause: null,
          orphanedVersion: null,
          resolvedVersion: version,
          posStart: start,
          posEnd: end,
          quote: selector.quote,
          prefix: selector.prefix,
          suffix: selector.suffix,
          updatedAt: new Date(),
        })
        .where(eq(schema.charterAnchors.id, row.id));
      const detail = {
        from: {
          state: row.state,
          quote: row.quote,
          prefix: row.prefix,
          suffix: row.suffix,
          start: row.posStart,
          end: row.posEnd,
          cause: row.orphanCause,
          resolvedVersion: row.resolvedVersion,
          orphanedVersion: row.orphanedVersion,
        },
        to: {
          quote: selector.quote,
          prefix: selector.prefix,
          suffix: selector.suffix,
          start,
          end,
        },
        ...(actor.agent ? { agent: actor.agent.agentId } : {}),
      };
      await tx.insert(schema.charterAnchorEvents).values({
        radarId,
        anchorId: row.id,
        kind: 'reanchored',
        version,
        actorId: by.userId,
        sessionId: by.sessionId,
        detail,
      });
      await sealOn(tx, doc, by, version, row.subjectId, `re-anchored ${subject.label}`);
      await recordAudit(
        actor,
        'charter.reanchor',
        'charter_anchor',
        row.id,
        { radarId, subject: row.subjectId, version, ...detail },
        tx,
      );
      return {
        anchorId: row.id,
        kind: row.kind,
        subject,
        state: 'anchored',
        version,
        was: wasOf(row),
        quote: selector.quote,
      };
    }),
  );
}

/**
 * Let an anchor go. An amendment can be dismissed only once it is orphaned (its words are gone):
 * dismissing a placed one would quietly change what an accepted ADR strikes, and the way to end
 * an ADR's effect is to repeal or reject it. The ADR then stands free of the charter, which a
 * proposal may be. A link has no such consequence and may be dismissed at any time (unlinking).
 * The anchor row stays as history.
 */
export async function dismissAnchor(
  actor: Actor,
  radarId: string,
  anchorId: string,
  input: { reason?: string | undefined },
  arbitrate?: (tx: Tx) => Promise<void>,
): Promise<AnchorActionResult> {
  await chargeCharterSave(actor, radarId, true);
  return retryOnConflict(() =>
    getDb().transaction(async (tx) => {
      await arbitrate?.(tx);
      await holdArchitectureRadar(tx, radarId);
      const doc = await lockCharter(tx, radarId);
      const { row, subject } = await lockedAnchor(tx, radarId, anchorId);
      const by = provenance(actor);
      if (row.state === 'dismissed')
        return {
          anchorId: row.id,
          kind: row.kind,
          subject,
          state: 'dismissed',
          version: doc.sealedVersion,
          was: wasOf(row),
          quote: row.quote,
        };
      if (row.kind === 'amend' && row.state === 'anchored')
        throw new ApiError(
          409,
          'anchor_in_place',
          'The words this amendment replaces are still in the charter. Reject or repeal the ADR to end its effect; only an orphaned amendment is dismissed.',
        );
      await sealHeadIfDirty(tx, doc, by);
      const version = doc.sealedVersion + 1;
      await tx
        .update(schema.charterAnchors)
        .set({
          state: 'dismissed',
          orphanCause: null,
          posStart: null,
          posEnd: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.charterAnchors.id, row.id));
      const detail = {
        from: {
          state: row.state,
          quote: row.quote,
          cause: row.orphanCause,
          resolvedVersion: row.resolvedVersion,
          orphanedVersion: row.orphanedVersion,
        },
        ...(input.reason ? { reason: input.reason } : {}),
        ...(actor.agent ? { agent: actor.agent.agentId } : {}),
      };
      await tx.insert(schema.charterAnchorEvents).values({
        radarId,
        anchorId: row.id,
        kind: 'dismissed',
        version,
        actorId: by.userId,
        sessionId: by.sessionId,
        detail,
      });
      await sealOn(tx, doc, by, version, row.subjectId, `dismissed ${subject.label}`);
      await recordAudit(
        actor,
        'charter.dismiss',
        'charter_anchor',
        row.id,
        { radarId, subject: row.subjectId, version, ...detail },
        tx,
      );
      return {
        anchorId: row.id,
        kind: row.kind,
        subject,
        state: 'dismissed',
        version,
        was: wasOf(row),
        quote: row.quote,
      };
    }),
  );
}

/** Records the anchors as they now stand as version `version` of the unchanged head. */
async function sealOn(
  tx: Tx,
  doc: Awaited<ReturnType<typeof lockCharter>>,
  by: ReturnType<typeof provenance>,
  version: number,
  causeBlipId: string,
  note: string,
): Promise<void> {
  const snap = await snapshotOf(tx, doc.radarId);
  await sealVersion(tx, {
    radarId: doc.radarId,
    body: doc.body,
    version,
    cause: 'anchor',
    causeBlipId,
    note,
    by,
    anchors: snap.anchors,
    adrLanes: snap.adrLanes,
  });
  await tx
    .update(schema.charterDocuments)
    .set({ sealedVersion: version })
    .where(eq(schema.charterDocuments.radarId, doc.radarId));
}

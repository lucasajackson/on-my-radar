/**
 * `link_charter`: a selection of the charter, tied to a boundary or contract (plan e715ea20, S5).
 *
 * A link is a row in `charter_anchors` (kind `link`, the element as its subject), so it moves with
 * the text, orphans when its words are removed or changed, and is versioned exactly as an ADR's
 * amendment is (`charter.ts`). It never rewrites the text. A link may span paragraphs (up to 4,000
 * characters); an amendment may not.
 *
 * The element is either an existing boundary or contract of the radar, or a new one made in the
 * same transaction: a selection that does not resolve leaves no boundary behind.
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import {
  CHARTER_LIMITS,
  resolveSelection,
  type CharterLinkDto,
  type linkCharterSchema,
} from '@onmyradar/contract';
import type { z } from 'zod';
import { getDb, schema } from '../db/client.js';
import { ApiError, notFound, type Actor } from '../http.js';
import { retryOnConflict } from '../errors.js';
import { writeAsAgent } from './agents.js';
import {
  architectureRadar,
  keyed,
  upsertBoundaryOnce,
  upsertContractOnce,
  type Record_,
} from './architecture.js';
import {
  checkPlacement,
  ensureCharterDocument,
  holdArchitectureRadar,
  lockCharter,
  provenance,
  sealHeadIfDirty,
  sealVersion,
  selectionRefusal,
  snapshotOf,
  type Tx,
} from './charter.js';
import { buildLinks } from './charter-link-view.js';
import { chargeCharterSave } from './charter-limits.js';
import { projectionOf } from './charter-model.js';

type LinkInput = z.infer<typeof linkCharterSchema>;

export interface LinkCharterResult {
  link: CharterLinkDto;
  /** The boundary or contract the passage is tied to; `created` when this call made it. */
  element: { id: string; title: string; kind: 'boundary' | 'contract'; created: boolean };
}

const unprocessable = (code: string, message: string) => new ApiError(422, code, message);

/**
 * Writes the link, in the caller's transaction, under the document lock. Seals a version
 * (`cause: 'anchor'`) so the link's `resolvedVersion` names a version that holds its words.
 */
async function placeLink(
  tx: Tx,
  id: string,
  radarId: string,
  element: { id: string; title: string; kind: 'boundary' | 'contract' },
  selection: Pick<LinkInput, 'quote' | 'prefix' | 'suffix'>,
  actor: Actor,
): Promise<CharterLinkDto> {
  const by = provenance(actor);
  const doc = await lockCharter(tx, radarId);
  const projection = projectionOf(doc.body);
  const found = resolveSelection(projection, { ...selection, ignore: projection.code });
  if (!found.ok) throw selectionRefusal(found.code, 'matches' in found ? found.matches : []);
  const { start, end, selector } = found;
  // The same placement rules as re-anchoring a link: at most `linkQuote`, not in or across code.
  checkPlacement(projection, start, end, selector.quote, 'link');
  const [held] = await tx
    .select({ n: count() })
    .from(schema.charterAnchors)
    .where(eq(schema.charterAnchors.radarId, radarId));
  if ((held?.n ?? 0) >= CHARTER_LIMITS.anchorsPerRadar)
    throw unprocessable(
      'too_many_anchors',
      'This charter already carries as many amendments and links as it can.',
    );
  const [twin] = await tx
    .select({ id: schema.charterAnchors.id })
    .from(schema.charterAnchors)
    .where(
      and(
        eq(schema.charterAnchors.radarId, radarId),
        eq(schema.charterAnchors.kind, 'link'),
        eq(schema.charterAnchors.subjectId, element.id),
        eq(schema.charterAnchors.state, 'anchored'),
        eq(schema.charterAnchors.posStart, start),
        eq(schema.charterAnchors.posEnd, end),
      ),
    );
  if (twin)
    throw new ApiError(
      409,
      'already_linked',
      `That passage is already linked to "${element.title}".`,
      { anchor: twin.id },
    );
  await sealHeadIfDirty(tx, doc, by);
  const version = doc.sealedVersion + 1;
  const [row] = await tx
    .insert(schema.charterAnchors)
    .values({
      id,
      radarId,
      kind: 'link',
      subjectId: element.id,
      quote: selector.quote,
      prefix: selector.prefix,
      suffix: selector.suffix,
      posStart: start,
      posEnd: end,
      state: 'anchored',
      resolvedVersion: version,
      createdBy: by.userId,
    })
    .returning();
  if (!row) throw new Error('link insert returned nothing');
  await tx.insert(schema.charterAnchorEvents).values({
    radarId,
    anchorId: row.id,
    kind: 'created',
    version,
    actorId: by.userId,
    sessionId: by.sessionId,
    detail: { element: element.id },
  });
  const snap = await snapshotOf(tx, radarId);
  await sealVersion(tx, {
    radarId,
    body: doc.body,
    version,
    cause: 'anchor',
    causeBlipId: element.id,
    by,
    anchors: snap.anchors,
    adrLanes: snap.adrLanes,
  });
  await tx
    .update(schema.charterDocuments)
    .set({ sealedVersion: version })
    .where(eq(schema.charterDocuments.radarId, radarId));
  const [link] = buildLinks(
    [row],
    new Map([[element.id, { title: element.title, lane: element.kind }]]),
    projection,
  );
  if (!link) throw new Error('link did not read back');
  return link;
}

type Element = { id: string; title: string; kind: 'boundary' | 'contract' };

/** An existing element of this radar, key-shared so a delete of it waits for the link (or finds it gone). */
async function existingElement(tx: Tx, radarId: string, id: string): Promise<Element> {
  const [row] = await tx
    .select({
      id: schema.blips.id,
      title: schema.blips.title,
      status: schema.blips.status,
      radarId: schema.blips.radarId,
    })
    .from(schema.blips)
    .where(eq(schema.blips.id, id))
    .for('key share');
  // Another radar's blip is as unknown as none.
  if (!row || row.radarId !== radarId) throw notFound('Blip not found');
  const kind =
    row.status === 'boundary' ? 'boundary' : row.status === 'contract' ? 'contract' : null;
  if (!kind)
    throw unprocessable('not_an_element', 'A link ties a passage to a boundary or a contract.');
  return { id: row.id, title: row.title ?? '', kind };
}

/**
 * Lock order (charter-ops.ts): the idempotency key, then the charter document, then the element,
 * then the anchors. A new element is made by the same upsert `upsert_boundary` runs, whose
 * `afterInsert` places the link in the same transaction, so a selection that does not resolve
 * leaves no boundary behind.
 */
async function linkOnce(
  actor: Actor,
  radarId: string,
  linkId: string,
  input: Omit<LinkInput, 'session' | 'idempotencyKey'>,
  record: Record_,
): Promise<LinkCharterResult> {
  const { element } = input;
  if (typeof element === 'string') {
    return getDb().transaction(async (tx) => {
      await record(tx, linkId);
      await holdArchitectureRadar(tx, radarId);
      await lockCharter(tx, radarId);
      const target = await existingElement(tx, radarId, element);
      return {
        link: await placeLink(tx, linkId, radarId, target, input, actor),
        element: { ...target, created: false },
      };
    });
  }
  let made: CharterLinkDto | undefined;
  const hook = {
    afterCreate: async (tx: Tx, id: string) => {
      made = await placeLink(
        tx,
        linkId,
        radarId,
        { id, title: element.title, kind: element.kind },
        input,
        actor,
      );
    },
  };
  // The key is claimed against the link, not the new element, so a replay reads the link back.
  const claim: Record_ = (tx) => record(tx, linkId);
  const radar = await architectureRadar(radarId, actor, 'write');
  const result =
    element.kind === 'boundary'
      ? await upsertBoundaryOnce(
          actor,
          radar,
          {
            title: element.title,
            ...(element.owns ? { owns: element.owns } : {}),
            ...(element.body === undefined ? {} : { body: element.body }),
            ...(element.external === undefined ? {} : { external: element.external }),
          },
          claim,
          hook,
        ).then((r) => ({ id: r.boundary.id, title: r.boundary.title }))
      : await upsertContractOnce(
          actor,
          radar,
          {
            title: element.title,
            a: element.a,
            b: element.b,
            ...(element.version === undefined ? {} : { version: element.version }),
            ...(element.body === undefined ? {} : { body: element.body }),
          },
          claim,
          hook,
        ).then((r) => ({ id: r.contract.id, title: r.contract.title }));
  if (!made) throw new Error('the element was made without its link');
  return { link: made, element: { ...result, kind: element.kind, created: true } };
}

/** The link as it stands, for a retry that finds its key spent. */
async function linkNow(radarId: string, linkId: string): Promise<LinkCharterResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.charterAnchors)
    .where(and(eq(schema.charterAnchors.id, linkId), eq(schema.charterAnchors.radarId, radarId)));
  if (!row || row.kind !== 'link') throw notFound('Blip not found');
  const target = await existingElement(db as unknown as Tx, radarId, row.subjectId);
  const [doc] = await db
    .select({ body: schema.charterDocuments.body })
    .from(schema.charterDocuments)
    .where(eq(schema.charterDocuments.radarId, radarId));
  const [link] = buildLinks(
    [row],
    new Map([[target.id, { title: target.title, lane: target.kind }]]),
    projectionOf(doc?.body ?? ''),
  );
  if (!link) throw notFound('Blip not found');
  return { link, element: { ...target, created: false } };
}

export async function linkCharter(
  actor: Actor,
  radarId: string,
  input: LinkInput,
): Promise<LinkCharterResult> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  await ensureCharterDocument(radar.id);
  // A link seals a version, so it is paid for like any other save (a refusal is a 429).
  await chargeCharterSave(actor, radar.id, true);
  const linkId = randomUUID();
  return keyed(
    actor,
    'charter.link',
    radar.id,
    idempotencyKey,
    { op: 'link', ...request },
    (record) => retryOnConflict(() => linkOnce(actor, radar.id, linkId, request, record)),
    (id) => linkNow(radar.id, id),
  );
}

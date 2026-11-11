/**
 * The architecture radar: a charter (one document), amended by ADRs.
 *
 * The charter is `charter_documents`; an ADR's amendments are rows in `charter_anchors` that
 * point at quotes in it (`charter.ts`). ADRs, boundaries and contracts are ordinary blips (the
 * decision and element lanes), so comments, search and sharing apply to them unchanged. What this
 * file adds is the verbs.
 *
 * `propose` is one transaction: the ADR is created through `createBlip`, and its anchors are
 * written (the document locked `FOR UPDATE`) by the `afterInsert` hook. Any refusal throws inside
 * that transaction, so nothing is left behind. `decide` is a thin wrapper over `updateBlip`: the
 * lane guards, the orphan guard, the ratified stamp and the deferred filing of the replaced ADR
 * all live on that shared path.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ARCHITECTURE_ADR_LANES,
  LIVE_ADR_LANES,
  ratifiedLane,
  type ArchitectureAdrDto,
  type ArchitectureBoundaryDto,
  type ArchitectureContractDto,
  type ArchitectureDto,
  type CharterHighlightDto,
  type CharterOrphanDto,
  type AnchorActionResult,
  type EditCharterResult,
  type ElementCharterDto,
  type TraceDto,
  type WriteCharterResult,
} from '@onmyradar/contract';
import type { z } from 'zod';
import type {
  decideAdrSchema,
  dismissAnchorSchema,
  editCharterSchema,
  proposeAdrSchema,
  reanchorSchema,
  readArchitectureQuerySchema,
  upsertBoundarySchema,
  upsertContractSchema,
  writeCharterSchema,
} from '@onmyradar/contract';
import { env } from '../env.js';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, notFound, type Actor } from '../http.js';
import { requireRadar, type RadarRow } from './access.js';
import { authorshipOf, writeAsAgent } from './agents.js';
import { setEditor } from './blip-history.js';
import { recordAudit } from './audit.js';
import { createBlip, getBlip, staleRefusal, updateBlip } from './blips.js';
import {
  adrLabel,
  anchorAdr,
  charterIsOneDocument,
  ensureCharterDocument,
  toAnchorDto,
  toOrphan,
  writeCharterText,
} from './charter.js';
import { projectionOf, renderCharter } from './charter-model.js';
import {
  anchorRadarId,
  dismissAnchor as dismissCharterAnchor,
  editCharterText,
  reanchorAnchor,
} from './charter-ops.js';
import { sectionsOf } from './charter-sections.js';
import { idempotencySubject, withIdempotency, type IdempotencyScope } from './idempotency.js';
import { buildLinks, elementCharter } from './charter-link-view.js';
import { readVersion, versionDtos } from './charter-version-view.js';
import { isUniqueViolation } from './slugs.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function architectureRadar(
  radarId: string,
  actor: Actor,
  need: 'read' | 'write' | 'manage',
  db: Parameters<typeof requireRadar>[3] = getDb(),
  /**
   * `members`: a person with a grant on the radar, not a visitor with its public link. A public
   * page shows the current charter; how it changed is for members.
   */
  options: { members?: boolean } = {},
): Promise<RadarRow> {
  return (await architectureAccess(radarId, actor, need, db, options)).radar;
}

/**
 * `architectureRadar`, and whether the caller reads it only through its public link. A public-link
 * reader sees what the current charter says and nothing that has been removed from it, so the
 * reads that carry an anchor's words (`load`) are told.
 */
async function architectureAccess(
  radarId: string,
  actor: Actor,
  need: 'read' | 'write' | 'manage',
  db: Parameters<typeof requireRadar>[3],
  options: { members?: boolean },
): Promise<{ radar: RadarRow; publicReader: boolean }> {
  const access = await requireRadar(radarId, actor, need, db);
  // Answered as a radar that is not there, like every other refusal to read.
  if (options.members && access.viaPublicLink) throw notFound('Radar not found');
  const { radar } = access;
  if (!ratifiedLane(radar.template, radar.templateConfig))
    throw badRequest(`"${radar.name}" is not an Architecture radar.`);
  return { radar, publicReader: access.viaPublicLink };
}

export type Record_ = (tx: Pick<Tx, 'execute'>, resourceId: string) => Promise<void>;
const noRecord: Record_ = () => Promise.resolve();

/**
 * Runs an architecture write once per `idempotencyKey` (none: just runs it). `run` records the key
 * through the `record` it is given, inside the write's own transaction where it has one; `replay`
 * answers a repeat from what the first call left behind. The payload binds the key to the request:
 * the same key with other arguments is a 409. `actor` is the one already bound to the session.
 */
export async function keyed<T>(
  actor: Actor,
  scope: IdempotencyScope,
  target: string,
  key: string | undefined,
  payload: unknown,
  run: (record: Record_) => Promise<T>,
  replay: (resourceId: string) => Promise<T>,
): Promise<T> {
  const subject = idempotencySubject(actor, scope, target, key, payload);
  if (!subject) return run(noRecord);
  return withIdempotency(subject, run, replay);
}

/** The fewest digits an ADR number is written with (`ADR-0001`). */
const ADR_NUMBER_WIDTH = 4;

/**
 * The title of the next ADR on a radar: one more than the highest number any ADR has taken
 * (imported ADRs keep theirs, and the new ones continue after them), in the width the radar
 * already uses and never narrower than four digits (`ADR-0027` then `ADR-0028`; `ADR-0001` on a
 * radar that has none, the form repositories cite). The radar's numbers
 * are handed out under one advisory lock held to the end of the proposing transaction, so two
 * proposals at once read each other's committed number rather than the same one.
 */
async function numberedTitle(tx: Tx, radarId: string, title: string): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`adr-number:${radarId}`}, 0))`,
  );
  const rows = await tx
    .select({ title: schema.blips.title })
    .from(schema.blips)
    .where(
      and(
        eq(schema.blips.radarId, radarId),
        inArray(schema.blips.status, [...ARCHITECTURE_ADR_LANES]),
      ),
    );
  let top = { n: 0, width: ADR_NUMBER_WIDTH };
  for (const row of rows) {
    const digits = /^ADR-(\d+)/i.exec(row.title ?? '')?.[1];
    if (digits && Number(digits) > top.n) top = { n: Number(digits), width: digits.length };
  }
  const bare = title.replace(/^ADR-\d+:?\s*/i, '').trim() || title;
  return `ADR-${String(top.n + 1).padStart(Math.max(top.width, ADR_NUMBER_WIDTH), '0')}: ${bare}`;
}

export const labelOf = adrLabel;
const titleOf = (title: string | null) => (title ?? '').replace(/^ADR-\d+:?\s*/i, '');

type ProposeResult = { adr: ArchitectureAdrDto; anchors: ArchitectureAdrDto['anchors'] };

/**
 * Propose an ADR. With an `idempotencyKey` a retry returns the ADR the first call made (found
 * again by id, so it shows the ADR as it is now) instead of numbering a second one. The key is
 * recorded in the capture's own transaction, and bound to the whole request, anchors included.
 */
export async function proposeAdr(
  actor: Actor,
  radarId: string,
  input: z.infer<typeof proposeAdrSchema>,
): Promise<ProposeResult> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  return keyed(
    actor,
    'adr.propose',
    radar.id,
    idempotencyKey,
    request,
    (record) => proposeOnce(actor, radar, request, record),
    async (adrId) => {
      const adr = (await load(radar)).adrs.find((a) => a.id === adrId);
      if (!adr) throw notFound('Blip not found');
      return { adr, anchors: adr.anchors };
    },
  );
}

async function proposeOnce(
  actor: Actor,
  radar: RadarRow,
  input: Omit<z.infer<typeof proposeAdrSchema>, 'session' | 'idempotencyKey'>,
  record: Record_,
): Promise<ProposeResult> {
  await ensureCharterDocument(radar.id);
  if (input.supersedes) {
    // Same answer as an unreadable radar: say nothing about blips elsewhere.
    const [target] = await getDb()
      .select({ radarId: schema.blips.radarId })
      .from(schema.blips)
      .where(eq(schema.blips.id, input.supersedes));
    if (target?.radarId !== radar.id) throw notFound('Blip not found');
  }
  const amends = [...new Set(input.amends ?? [])];
  await checkElements(radar.id, amends, 'element');
  let anchors: ArchitectureAdrDto['anchors'] = [];
  const blip = await createBlip(
    actor,
    radar.id,
    {
      title: input.title,
      body: input.rationale,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    },
    {
      requireTemplate: 'architecture',
      titleFor: (tx) => numberedTitle(tx, radar.id, input.title),
      arbitrate: (tx, adrId) => record(tx, adrId),
      afterInsert: async (tx, adrId) => {
        anchors = await anchorAdr(tx, radar.id, adrId, input.anchors, input.supersedes, actor);
        if (amends.length > 0)
          await tx.insert(schema.blipRelations).values(
            amends.map((to) => ({
              radarId: radar.id,
              fromBlipId: adrId,
              toBlipId: to,
              kind: 'amends' as const,
            })),
          );
      },
    },
  );
  return {
    adr: {
      id: blip.id,
      label: labelOf(blip.title, blip.id),
      title: titleOf(blip.title),
      lane: blip.status,
      ratifiedAt: null,
      supersedes: blip.supersedes,
      supersededBy: null,
      anchors,
      amends,
    },
    anchors,
  };
}

const LANE_FOR = { accept: 'accepted', reject: 'rejected', repeal: 'repealed' } as const;

const ADR_LANES = new Set<string | null>(ARCHITECTURE_ADR_LANES);
const READ_LANES = ['boundary', 'contract', ...ARCHITECTURE_ADR_LANES];

/** The charter in reading order, every ADR in ledger order, and the boundaries and contracts. */
/** Service-only seam for tests: runs between the reads of one `load`, where a write can land. */
export interface ReadHooks {
  afterRows?: () => Promise<void>;
}

async function load(
  radar: RadarRow,
  edit?: string,
  hooks: ReadHooks = {},
  /** A public-link reader: the words of an anchor that has lost its place are left out. */
  publicReader = false,
) {
  await ensureCharterDocument(radar.id);
  const rule = ratifiedLane(radar.template, radar.templateConfig)?.id;
  const max = env().ARCHITECTURE_MAX_BLIPS;
  // One snapshot: the fields, the seams and the `updatedAt` each form saves against are read
  // together, so a write that commits between the reads cannot pair old fields with a new revision.
  const [rows, links, attrs, doc, anchorRows] = await getDb().transaction(
    async (tx) => {
      const rows = await tx
        .select({
          id: schema.blips.id,
          title: schema.blips.title,
          status: schema.blips.status,
          // Only the one element being edited is read whole: a contract can be 60,000 characters.
          body: sql<string>`case when ${schema.blips.id} = ${edit ?? null} then ${schema.blips.body} else '' end`.as(
            'body',
          ),
          updatedAt: schema.blips.updatedAt,
          ratifiedAt: schema.blips.ratifiedAt,
          ratifiedByName: schema.blips.ratifiedByName,
          supersedesId: schema.blips.supersedesId,
        })
        .from(schema.blips)
        // Only the lanes this reader uses (charter, ADRs, boundaries, contracts), and one more
        // than the cap, so "over" is known without counting the rest.
        .where(and(eq(schema.blips.radarId, radar.id), inArray(schema.blips.status, READ_LANES)))
        .orderBy(asc(schema.blips.createdAt), asc(schema.blips.id))
        .limit(max + 1);
      await hooks.afterRows?.();
      const links = await tx
        .select({
          from: schema.blipRelations.fromBlipId,
          to: schema.blipRelations.toBlipId,
          kind: schema.blipRelations.kind,
          side: schema.blipRelations.side,
        })
        .from(schema.blipRelations)
        .where(eq(schema.blipRelations.radarId, radar.id));
      const attrs = await tx
        .select({
          id: schema.blipElements.blipId,
          external: schema.blipElements.external,
          owns: schema.blipElements.owns,
          version: schema.blipElements.version,
        })
        .from(schema.blipElements)
        .innerJoin(schema.blips, eq(schema.blips.id, schema.blipElements.blipId))
        .where(eq(schema.blips.radarId, radar.id));
      const [doc] = await tx
        .select()
        .from(schema.charterDocuments)
        .where(eq(schema.charterDocuments.radarId, radar.id));
      const anchorRows = await tx
        .select()
        .from(schema.charterAnchors)
        .where(eq(schema.charterAnchors.radarId, radar.id))
        .orderBy(asc(schema.charterAnchors.createdAt), asc(schema.charterAnchors.id));
      return [rows, links, attrs, doc ?? null, anchorRows] as const;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  if (rows.length > max)
    throw unprocessable(
      'architecture_too_large',
      `This architecture radar has more than ${max} blips in its charter, decision, boundary and contract lanes, ` +
        'which is more than one read will load. Read it in parts (pages, boundary) or archive what is settled.',
    );
  const lanes = new Map(rows.map((r) => [r.id, r.status]));
  const titles = new Map(rows.map((r) => [r.id, { title: r.title, lane: r.status }]));
  const anchors = new Map<string, ArchitectureAdrDto['anchors']>();
  // An ADR's amendments read in the order of the text (an orphan, which has no place, last).
  const placed = anchorRows
    .filter((r) => r.kind === 'amend' && r.state !== 'dismissed')
    .sort((a, b) => (a.posStart ?? Infinity) - (b.posStart ?? Infinity));
  for (const row of placed) {
    const dto = toAnchorDto(row);
    anchors.set(row.subjectId, [
      ...(anchors.get(row.subjectId) ?? []),
      publicReader && row.state !== 'anchored' ? { ...dto, quote: '', with: '' } : dto,
    ]);
  }
  const live = (lane: string | null | undefined) => LIVE_ADR_LANES.some((l) => l === lane);
  const orphans = anchorRows
    .filter(
      (r) =>
        r.state === 'orphaned' &&
        // A link has no lane to be live in: an element's lost passage always matters.
        (r.kind === 'link' || live(lanes.get(r.subjectId))),
    )
    .map<CharterOrphanDto>((r) => {
      const orphan = toOrphan(r, titles);
      return publicReader ? { ...orphan, quote: '' } : orphan;
    });
  const anyLink = anchorRows.some((r) => r.kind === 'link' && r.state === 'anchored');
  const charterLinks = buildLinks(
    anchorRows,
    titles,
    anyLink && doc ? projectionOf(doc.body) : null,
  ).map((l) => (publicReader && l.state !== 'anchored' ? { ...l, excerpt: '' } : l));
  const charterOf = elementCharter(charterLinks);
  const replacedBy = new Map(
    rows.flatMap((r) => (r.supersedesId ? [[r.supersedesId, r.id] as const] : [])),
  );
  const amends = new Map<string, string[]>();
  const amendedBy = new Map<string, string[]>();
  for (const l of links.filter((x) => x.kind === 'amends')) {
    amends.set(l.from, [...(amends.get(l.from) ?? []), l.to]);
    amendedBy.set(l.to, [...(amendedBy.get(l.to) ?? []), l.from]);
  }
  // Ratified (accepted or repealed) first, in the order they were ratified; then what is open; then what was refused.
  const rank = (r: (typeof rows)[number]) => (r.ratifiedAt ? 0 : r.status === 'rejected' ? 2 : 1);
  const adrs = rows
    .filter((r) => ADR_LANES.has(r.status))
    .sort(
      (a, b) =>
        rank(a) - rank(b) || (a.ratifiedAt?.getTime() ?? 0) - (b.ratifiedAt?.getTime() ?? 0),
    )
    .map<ArchitectureAdrDto>((r) => ({
      id: r.id,
      label: labelOf(r.title, r.id),
      title: titleOf(r.title),
      lane: r.status,
      ratifiedAt: r.ratifiedAt?.toISOString() ?? null,
      supersedes: r.supersedesId,
      supersededBy: replacedBy.get(r.id) ?? null,
      anchors: anchors.get(r.id) ?? [],
      amends: amends.get(r.id) ?? [],
      ...(r.ratifiedByName ? { decidedBy: r.ratifiedByName } : {}),
    }));
  const attr = new Map(attrs.map((a) => [a.id, a]));
  const boundaries = rows
    .filter((r) => r.status === 'boundary')
    .map<ArchitectureBoundaryDto>((r) => ({
      id: r.id,
      title: r.title ?? '',
      updatedAt: r.updatedAt.toISOString(),
      ...(r.id === edit ? { body: r.body } : {}),
      external: attr.get(r.id)?.external ?? false,
      owns: attr.get(r.id)?.owns ?? [],
      amendedBy: amendedBy.get(r.id) ?? [],
      ...(charterOf.has(r.id) ? { charter: charterOf.get(r.id) as ElementCharterDto } : {}),
    }));
  const seam = (contract: string, side: 'a' | 'b') =>
    links.find((l) => l.kind === 'seam_side' && l.from === contract && l.side === side)?.to ?? '';
  const contracts = rows
    .filter((r) => r.status === 'contract')
    .map<ArchitectureContractDto>((r) => ({
      id: r.id,
      title: r.title ?? '',
      updatedAt: r.updatedAt.toISOString(),
      ...(r.id === edit ? { body: r.body } : {}),
      version: attr.get(r.id)?.version ?? null,
      a: seam(r.id, 'a'),
      b: seam(r.id, 'b'),
      amendedBy: amendedBy.get(r.id) ?? [],
      ...(charterOf.has(r.id) ? { charter: charterOf.get(r.id) as ElementCharterDto } : {}),
    }));
  return {
    doc,
    anchorRows,
    orphans,
    charterLinks,
    adrs,
    boundaries,
    contracts,
    inForce: (adr: string) => lanes.get(adr) === rule,
    live: (adr: string) => LIVE_ADR_LANES.some((l) => l === lanes.get(adr)),
  };
}

/** A date this early is a typing mistake, not a decision date. */
const EARLIEST_DECISION = Date.parse('2000-01-01T00:00:00Z');

/**
 * Accept, reject or repeal an ADR. `decidedAt` and `decidedBy` are for an ADR decided before it was
 * written down (an import, a repository's history): they apply to the accept that first ratifies
 * it, so `ratified_at` stays what it always was, set once. A decision date in the future, before
 * 2000, or on an ADR already ratified is refused. A dated decision is audited with both the date
 * given and the day it was recorded.
 */
export async function decideAdr(
  actor: Actor,
  adrId: string,
  input: z.infer<typeof decideAdrSchema>,
): Promise<{ adr: ArchitectureAdrDto; filed: string[] }> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const before = await getBlip(adrId, actor);
  const radar = await architectureRadar(before.radarId, actor, 'write');
  return keyed(
    actor,
    'adr.decide',
    adrId,
    idempotencyKey,
    request,
    // The key is claimed first thing in the move's own transaction: a twin holding it waits there,
    // and the one that loses rolls back having decided nothing.
    (record) => decideOnce(actor, radar, before.status, adrId, request, record),
    async () => {
      const adr = (await load(radar)).adrs.find((a) => a.id === adrId);
      if (!adr) throw notFound('Blip not found');
      return { adr, filed: [] };
    },
  );
}

async function decideOnce(
  actor: Actor,
  radar: RadarRow,
  laneBefore: string | null,
  adrId: string,
  input: Omit<z.infer<typeof decideAdrSchema>, 'session' | 'idempotencyKey'>,
  record: Record_,
): Promise<{ adr: ArchitectureAdrDto; filed: string[] }> {
  const status = LANE_FOR[input.decision];
  const [row] = await getDb()
    .select({ supersedesId: schema.blips.supersedesId, ratifiedAt: schema.blips.ratifiedAt })
    .from(schema.blips)
    .where(eq(schema.blips.id, adrId));
  /*
    A refusal that depends on the ADR's state is made after the key is looked up under its
    claim: a retry whose twin committed between the caller's lookup and this read would
    otherwise be told "already accepted" instead of being handed the decision it asked for.
    The claim and the refusal share one transaction that is rolled back, so a refused call
    leaves no key behind; a key already held by the twin throws the loser's race, and the
    caller replays the winner's result.
  */
  const refuse = async (error: ApiError): Promise<never> => {
    await getDb().transaction(async (tx) => {
      await record(tx, adrId);
      throw error;
    });
    throw error;
  };
  const dated = input.decidedAt !== undefined || input.decidedBy !== undefined;
  let decided: { at: Date; by?: string } | undefined;
  if (dated) {
    if (input.decision !== 'accept')
      return refuse(
        unprocessable(
          'decided_needs_accept',
          'decidedAt and decidedBy record when and by whom an ADR was accepted; they go with accept.',
        ),
      );
    if (row?.ratifiedAt || laneBefore === status)
      return refuse(
        new ApiError(
          409,
          'already_ratified',
          'This ADR was already accepted, and the date it was decided is set once.',
        ),
      );
    const at = input.decidedAt === undefined ? new Date() : new Date(input.decidedAt);
    if (at.getTime() > Date.now() + 60_000)
      return refuse(
        unprocessable('decided_in_future', 'A decision cannot be dated in the future.'),
      );
    if (at.getTime() < EARLIEST_DECISION)
      return refuse(
        unprocessable('decided_too_early', 'A decision date before the year 2000 is a mistake.'),
      );
    decided = { at, ...(input.decidedBy ? { by: input.decidedBy } : {}) };
  }
  await updateBlip(
    actor,
    adrId,
    { status },
    {
      ...(decided ? { decided } : {}),
      arbitrate: (tx) => record(tx, adrId),
    },
  );
  if (decided && input.decidedAt !== undefined)
    await recordAudit(actor, 'adr.decide.dated', 'blip', adrId, {
      radarId: radar.id,
      decidedAt: decided.at.toISOString(),
      ...(decided.by ? { decidedBy: decided.by } : {}),
      recordedAt: new Date().toISOString(),
    });
  const adr = (await load(radar)).adrs.find((a) => a.id === adrId);
  if (!adr) throw notFound('Blip not found');
  const files = input.decision === 'accept' && laneBefore !== status && row?.supersedesId;
  return { adr, filed: files ? [row.supersedesId as string] : [] };
}

const headingsOf = (markdown: string): string[] => {
  let fence = false;
  return markdown.split('\n').filter((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    return !fence && /^#{1,6}\s/.test(line);
  });
};

export async function readArchitecture(
  actor: Actor,
  radarId: string,
  query: z.infer<typeof readArchitectureQuerySchema>,
  hooks: ReadHooks = {},
): Promise<ArchitectureDto> {
  // A past version is history: members only (a public link reads the current charter).
  const { radar, publicReader } = await architectureAccess(radarId, actor, 'read', getDb(), {
    members: query.version !== undefined,
  });
  const all = await load(radar, query.edit, hooks, publicReader);
  const { doc, anchorRows, orphans, charterLinks } = all;
  let { inForce, live } = all;
  let { adrs, boundaries, contracts } = all;
  if (query.boundary) {
    // One boundary, its seams, whoever is on the other side, and the ADRs that amend any of them.
    const focus = boundaries.find((b) => b.id === query.boundary);
    if (!focus) {
      // Another radar's blip is as unknown here as none at all.
      const here = (await elementRows([query.boundary])).some((r) => r.radarId === radar.id);
      throw here ? notABoundary() : notFound('Blip not found');
    }
    contracts = contracts.filter((c) => c.a === focus.id || c.b === focus.id);
    const ends = new Set(contracts.flatMap((c) => [c.a, c.b]));
    boundaries = boundaries.filter((b) => b.id === focus.id || ends.has(b.id));
    const shown = new Set([...boundaries, ...contracts].map((e) => e.id));
    adrs = adrs.filter((a) => a.amends.some((id) => shown.has(id)));
  }
  // Narrowing: which ADRs, then which parts of the answer (the default stays everything, so a
  // plain read is the same as it was).
  if (query.lanes) adrs = adrs.filter((a) => query.lanes?.some((l) => l === a.lane));
  if (query.adr) adrs = adrs.filter((a) => query.adr?.includes(a.id));
  const parts = query.include ? new Set<string>(query.include) : null;
  const part = (name: string) => !parts || parts.has(name);
  if (!part('adrs')) adrs = [];
  if (!part('boundaries')) boundaries = [];
  if (!part('contracts')) contracts = [];
  if (query.owns === false) boundaries = boundaries.map(({ owns: _owns, ...rest }) => rest);
  const wanted = query.pages ? new Set(query.pages) : null;
  const wantsCharter =
    part('charter') &&
    (!query.boundary || Boolean(wanted) || query.outline === true || Boolean(query.sections));
  // An earlier version reads as it was: its text, the anchors where they stood in it, and each
  // ADR in the lane it was in then.
  const past =
    query.version === undefined ? null : await readVersion(getDb(), radar.id, query.version);
  if (past) {
    const rule = ratifiedLane(radar.template, radar.templateConfig)?.id;
    inForce = (adr) => past.row.adrLanes[adr] === rule;
    live = (adr) => LIVE_ADR_LANES.some((l) => l === past.row.adrLanes[adr]);
  }
  // The charter is one document. Clients that still list pages get one, named by the radar id.
  const body = past ? past.body : (doc?.body ?? '');
  const placed = past
    ? anchorRows.flatMap((r) => {
        const at = past.row.anchors[r.id];
        return r.kind === 'amend' && at
          ? [{ adr: r.subjectId, with: r.withText ?? '', start: at[0], end: at[1] }]
          : [];
      })
    : anchorRows.flatMap((r) =>
        r.kind === 'amend' && r.state === 'anchored' && r.posStart !== null && r.posEnd !== null
          ? [{ adr: r.subjectId, with: r.withText ?? '', start: r.posStart, end: r.posEnd }]
          : [],
      );
  const charter =
    wantsCharter && (!wanted || wanted.has(radar.id)) && body.length > 0
      ? [
          charterPage(
            radar.id,
            past ? past.row.createdAt : (doc?.updatedAt ?? new Date(0)),
            body,
            placed,
            query,
            inForce,
            live,
          ),
        ]
      : [];
  const highlight = query.anchor
    ? highlightOf(anchorRows, query.anchor, body, past ? past.row.anchors : null, publicReader)
    : undefined;
  const asOf = past ? (await versionDtos(getDb(), [past.row]))[0] : undefined;
  return {
    radar: { id: radar.id, name: radar.name },
    charter,
    // The index stays small: an anchor id is given where one needs attention (an orphan, which is
    // also in `orphans`); `trace` on the ADR lists every id.
    adrs: adrs.map((a) => ({
      ...a,
      anchors: a.anchors.map((x) =>
        x.state === undefined ? { pageId: x.pageId, quote: x.quote, with: x.with } : x,
      ),
    })),
    boundaries,
    contracts,
    // A past version has no revision: nothing can be saved on top of it.
    ...(past ? {} : { revision: doc?.revision ?? 0 }),
    charterVersion: doc?.sealedVersion ?? 0,
    ...(orphans.length > 0 ? { orphans } : {}),
    // A past version shows head's links; head's offsets mean nothing in an earlier text.
    ...(charterLinks.length > 0
      ? { links: past ? charterLinks.map(({ start: _s, end: _e, ...rest }) => rest) : charterLinks }
      : {}),
    ...(asOf ? { asOf, readOnly: true as const } : {}),
    ...(highlight !== undefined ? { highlight } : {}),
  };
}

/**
 * Where an anchor stands in the text that was read: its projection offsets and the span of the
 * markdown that holds them. `at` is a past version's own record of every anchor; without it the
 * head's cache is read. An anchor with no place there has nulls (an orphan reads at the version
 * it last resolved in). Another radar's anchor is not found.
 */
function highlightOf(
  anchorRows: ReadonlyArray<typeof schema.charterAnchors.$inferSelect>,
  anchorId: string,
  body: string,
  at: Record<string, [number, number] | null> | null,
  publicReader: boolean,
): CharterHighlightDto {
  const row = anchorRows.find((r) => r.id === anchorId);
  if (!row) throw notFound('Anchor not found');
  const range: [number, number] | null = at
    ? (at[anchorId] ?? null)
    : row.state === 'anchored' && row.posStart !== null && row.posEnd !== null
      ? [row.posStart, row.posEnd]
      : null;
  const projection = projectionOf(body);
  const whole = range && range[0] >= 0 && range[1] > range[0] && range[1] <= projection.text.length;
  const source = whole ? projection.sourceRange(range[0], range[1]) : null;
  return {
    anchorId,
    state: whole && at ? 'anchored' : row.state,
    // Words that are no longer in the charter are not a public reader's to read.
    quote: publicReader && row.state !== 'anchored' ? '' : row.quote,
    start: whole ? range[0] : null,
    end: whole ? range[1] : null,
    sourceStart: source ? source[0] : null,
    sourceEnd: source ? source[1] : null,
  };
}

function charterPage(
  radarId: string,
  updatedAt: Date,
  body: string,
  here: ReadonlyArray<{ adr: string; with: string; start: number; end: number }>,
  query: z.infer<typeof readArchitectureQuerySchema>,
  inForce: (adr: string) => boolean,
  live: (adr: string) => boolean,
): ArchitectureDto['charter'][number] {
  const projection = projectionOf(body);
  const markdown = renderCharter(body, here, query.view, inForce, projection, live);
  if (query.sections) {
    // Cut from the whole rendered text: an amendment's place is global, a section is a slice of it.
    const all = sectionsOf(markdown);
    const picked = query.sections.map((want) => {
      const hit = all.find((x) => x.slug === want || x.heading === want);
      if (!hit)
        throw unprocessable(
          'section_not_found',
          `There is no section "${want}". Sections: ${all
            .slice(0, 60)
            .map((x) => x.slug)
            .join(', ')}.`,
        );
      return hit;
    });
    const unique = [...new Map(picked.map((x) => [x.slug, x])).values()];
    return {
      id: radarId,
      title: 'Charter',
      updatedAt: updatedAt.toISOString(),
      sections: all
        .filter((x) => unique.includes(x))
        .map(({ slug, heading, markdown: text }) => ({ slug, heading, markdown: text })),
    };
  }
  return query.outline === true
    ? {
        id: radarId,
        title: 'Charter',
        headings: headingsOf(markdown),
        outline: sectionsOf(markdown).map(({ slug, level, heading }) => ({ slug, level, heading })),
      }
    : { id: radarId, title: 'Charter', updatedAt: updatedAt.toISOString(), markdown };
}

/* ------------------------------ the charter text ----------------------------- */

/** The charter as a retry sees it: where it stands now, and that this is not the first answer. */
export async function charterNow(radarId: string): Promise<WriteCharterResult> {
  const [doc] = await getDb()
    .select()
    .from(schema.charterDocuments)
    .where(eq(schema.charterDocuments.radarId, radarId));
  return {
    revision: doc?.revision ?? 0,
    version: doc?.sealedVersion ?? 0,
    changed: false,
    orphaned: [],
    healed: [],
    moved: [],
    inertOrphaned: 0,
    chars: doc?.body.length ?? 0,
    replayed: true,
  };
}

/**
 * Replace the whole charter (`write_charter`, `PUT /radars/:id/charter`). Needs write access;
 * everything else is `charter.ts`. A retry with the same `idempotencyKey` answers with where the
 * charter stands (`replayed: true`) instead of failing as `stale` against its own first write; it
 * cannot give back the first answer's orphan list, which is in the first answer.
 */
export async function writeCharter(
  actor: Actor,
  radarId: string,
  input: z.infer<typeof writeCharterSchema>,
): Promise<WriteCharterResult> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  return keyed(
    actor,
    'charter.write',
    radar.id,
    idempotencyKey,
    { op: 'write', ...request },
    (record) => writeCharterText(actor, radar.id, request, (tx) => record(tx, radar.id)),
    () => charterNow(radar.id),
  );
}

/** `edit_charter`, `POST /radars/:id/charter/edits`: exact-text edits (see `charter-ops.ts`). */
export async function editCharter(
  actor: Actor,
  radarId: string,
  input: z.infer<typeof editCharterSchema>,
): Promise<EditCharterResult> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  return keyed(
    actor,
    'charter.write',
    radar.id,
    idempotencyKey,
    { op: 'edit', ...request },
    (record) => editCharterText(actor, radar.id, request, (tx) => record(tx, radar.id)),
    async () => ({ ...(await charterNow(radar.id)), applied: request.edits.length }),
  );
}

/** The anchor's current standing, for a retry that finds its key already used. */
async function anchorNow(radarId: string, anchorId: string): Promise<AnchorActionResult> {
  const [row] = await getDb()
    .select()
    .from(schema.charterAnchors)
    .where(and(eq(schema.charterAnchors.id, anchorId), eq(schema.charterAnchors.radarId, radarId)));
  if (!row) throw notFound('Anchor not found');
  const [subject] = await getDb()
    .select({ title: schema.blips.title, status: schema.blips.status })
    .from(schema.blips)
    .where(eq(schema.blips.id, row.subjectId));
  const [event] = await getDb()
    .select({ version: schema.charterAnchorEvents.version })
    .from(schema.charterAnchorEvents)
    .where(eq(schema.charterAnchorEvents.anchorId, anchorId))
    .orderBy(sql`${schema.charterAnchorEvents.createdAt} desc`)
    .limit(1);
  return {
    anchorId,
    kind: row.kind,
    subject: {
      id: row.subjectId,
      label: adrLabel(subject?.title ?? null, row.subjectId),
      lane: subject?.status ?? null,
    },
    state: row.state,
    version: event?.version ?? row.resolvedVersion,
    was: { state: row.state, quote: row.quote },
    quote: row.quote,
    replayed: true,
  };
}

/**
 * `reanchor` (and its `dismiss`): an anchor is found by its own id, and acted on only by someone
 * who may write its radar (another radar's id, or none, is a 404 like any unreadable thing).
 */
async function anchorAct(
  actor: Actor,
  anchorId: string,
  session: string | undefined,
  idempotencyKey: string | undefined,
  op: 'reanchor' | 'dismiss',
  request: unknown,
  act: (
    actor: Actor,
    radarId: string,
    record: (tx: Tx) => Promise<void>,
  ) => Promise<AnchorActionResult>,
): Promise<AnchorActionResult> {
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(await anchorRadarId(anchorId), actor, 'write');
  return keyed(
    actor,
    'anchor.act',
    anchorId,
    idempotencyKey,
    { op, request },
    (record) => act(actor, radar.id, (tx) => record(tx, anchorId)),
    () => anchorNow(radar.id, anchorId),
  );
}

export function reanchor(
  actor: Actor,
  anchorId: string,
  input: z.infer<typeof reanchorSchema>,
): Promise<AnchorActionResult> {
  const { session, idempotencyKey, ...request } = input;
  return anchorAct(
    actor,
    anchorId,
    session,
    idempotencyKey,
    'reanchor',
    request,
    (a, radarId, record) => reanchorAnchor(a, radarId, anchorId, request, record),
  );
}

export function dismiss(
  actor: Actor,
  anchorId: string,
  input: z.infer<typeof dismissAnchorSchema>,
): Promise<AnchorActionResult> {
  const { session, idempotencyKey, ...request } = input;
  return anchorAct(
    actor,
    anchorId,
    session,
    idempotencyKey,
    'dismiss',
    request,
    (a, radarId, record) => dismissCharterAnchor(a, radarId, anchorId, request, record),
  );
}

/** `POST /radars/:id/charter-pages`: retired. Same access rules, then 410. */
export async function retiredCharterPage(actor: Actor, radarId: string): Promise<never> {
  await architectureRadar(radarId, actor, 'write');
  throw charterIsOneDocument();
}

/* ------------------------- boundaries and contracts ------------------------ */

const unprocessable = (code: string, message: string) => new ApiError(422, code, message);
const notABoundary = () =>
  unprocessable('not_a_boundary', 'That blip is not a boundary of this radar.');

async function elementRows(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: schema.blips.id, status: schema.blips.status, radarId: schema.blips.radarId })
    .from(schema.blips)
    .where(inArray(schema.blips.id, [...ids]));
}

/**
 * Each id must be an element of this radar. Another radar's blip, or none, is a
 * 404 (it says nothing about blips elsewhere); a blip here of the wrong kind is
 * a 422 naming what was expected.
 */
async function checkElements(
  radarId: string,
  ids: readonly string[],
  want: 'boundary' | 'element',
): Promise<void> {
  const rows = await elementRows(ids);
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.radarId !== radarId) throw notFound('Blip not found');
    if (want === 'boundary' && row.status !== 'boundary') throw notABoundary();
    if (want === 'element' && row.status !== 'boundary' && row.status !== 'contract')
      throw unprocessable('not_an_element', 'An ADR amends a boundary or a contract.');
  }
}

/** Create or update one element, retrying once if a concurrent upsert of the same title won the index. */
async function upsertElement<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isUniqueViolation(error, 'blips_element_title_key')) throw error;
    try {
      return await attempt();
    } catch (again) {
      if (!isUniqueViolation(again, 'blips_element_title_key')) throw again;
      throw new ApiError(
        409,
        'title_taken',
        'Another boundary or contract already has that title.',
      );
    }
  }
}

/** The element this upsert means: by id, else by title (case-insensitive), else none. */
async function findElement(
  db: Pick<Db, 'select'>,
  radarId: string,
  lane: 'boundary' | 'contract',
  input: { id?: string | undefined; title: string },
): Promise<string | null> {
  if (input.id) {
    const [row] = await db
      .select({ status: schema.blips.status, radarId: schema.blips.radarId })
      .from(schema.blips)
      .where(eq(schema.blips.id, input.id));
    if (!row || row.radarId !== radarId) throw notFound('Blip not found');
    if (row.status !== lane)
      throw lane === 'boundary'
        ? notABoundary()
        : unprocessable('not_an_element', 'That blip is not a contract of this radar.');
    return input.id;
  }
  const [row] = await db
    .select({ id: schema.blips.id })
    .from(schema.blips)
    .where(
      and(
        eq(schema.blips.radarId, radarId),
        eq(schema.blips.status, lane),
        sql`lower(${schema.blips.title}) = lower(${input.title})`,
      ),
    );
  return row?.id ?? null;
}

const amendedByOf = async (id: string): Promise<string[]> =>
  (
    await getDb()
      .select({ from: schema.blipRelations.fromBlipId })
      .from(schema.blipRelations)
      .where(and(eq(schema.blipRelations.toBlipId, id), eq(schema.blipRelations.kind, 'amends')))
  ).map((r) => r.from);

/** Title and body of an existing element, written in the caller's transaction. */
async function rewrite(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { title: string; body?: string | undefined },
): Promise<void> {
  await setEditor(tx, actor.user.id, authorshipOf(actor).agentId);
  await tx
    .update(schema.blips)
    .set({
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body.trim() }),
      updatedAt: new Date(),
    })
    .where(eq(schema.blips.id, id));
}

/**
 * Lock an element and refuse (409 `stale`) when it was written after the caller read it. The
 * check and the write share the row lock, so nothing can land between them.
 */
async function lockedFresh(tx: Tx, id: string, expected: string | undefined): Promise<void> {
  const [row] = await tx.select().from(schema.blips).where(eq(schema.blips.id, id)).for('update');
  if (expected && row && row.updatedAt.getTime() !== new Date(expected).getTime())
    throw staleRefusal();
}

type ElementInput<S extends z.ZodTypeAny> = Omit<z.infer<S>, 'session' | 'idempotencyKey'>;

/**
 * `afterCreate` (`link_charter`) runs in the transaction that makes a NEW boundary or contract,
 * and turns "matched an existing one by title" into `title_taken`: the caller meant a new element.
 */
export interface CreateHook {
  afterCreate?: (tx: Tx, id: string) => Promise<void>;
}

const titleTaken = () =>
  new ApiError(409, 'title_taken', 'Another boundary or contract already has that title.');

/**
 * `title_taken` for a link that meant a NEW element, made after the idempotency key is looked up
 * under its claim: a retry whose twin made the element between the caller's lookup and this read
 * is handed the twin's link, not told the title is taken. The claim and the refusal share one
 * transaction that is rolled back, so a refused call leaves no key behind (as `decideAdr`'s refuse).
 */
async function takenUnderClaim(record: Record_, existing: string): Promise<never> {
  const refusal = titleTaken();
  await getDb().transaction(async (tx) => {
    await record(tx, existing);
    throw refusal;
  });
  throw refusal;
}

/**
 * Create or change a boundary. With an `idempotencyKey` a retry returns the boundary as it is now
 * (`created` is then false: it says whether *this* call created it) instead of writing again.
 */
export async function upsertBoundary(
  actor: Actor,
  radarId: string,
  input: z.infer<typeof upsertBoundarySchema>,
): Promise<{ boundary: ArchitectureBoundaryDto; created: boolean }> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  return keyed(
    actor,
    'element.upsert',
    radar.id,
    idempotencyKey,
    { op: 'boundary', ...request },
    (record) => upsertBoundaryOnce(actor, radar, request, record),
    async (id) => {
      const boundary = (await load(radar)).boundaries.find((b) => b.id === id);
      if (!boundary) throw notFound('Blip not found');
      return { boundary, created: false };
    },
  );
}

export async function upsertBoundaryOnce(
  actor: Actor,
  radar: RadarRow,
  input: ElementInput<typeof upsertBoundarySchema>,
  record: Record_,
  hook: CreateHook = {},
): Promise<{ boundary: ArchitectureBoundaryDto; created: boolean }> {
  const result = await upsertElement(async () => {
    const existing = await findElement(getDb(), radar.id, 'boundary', input);
    if (!existing) {
      const blip = await createBlip(
        actor,
        radar.id,
        { title: input.title, body: input.body ?? '', status: 'boundary' },
        {
          element: true,
          requireTemplate: 'architecture',
          authored: false,
          arbitrate: (tx, id) => record(tx, id),
          afterInsert: async (tx, id) => {
            await tx.insert(schema.blipElements).values({
              blipId: id,
              external: input.external ?? false,
              owns: input.owns ?? [],
            });
            await hook.afterCreate?.(tx, id);
          },
        },
      );
      return { id: blip.id, created: true };
    }
    if (hook.afterCreate) return takenUnderClaim(record, existing);
    await getDb().transaction(async (tx) => {
      await record(tx, existing);
      await lockedFresh(tx, existing, input.expectedUpdatedAt);
      await rewrite(tx, actor, existing, input);
      const attrs = {
        ...(input.external === undefined ? {} : { external: input.external }),
        ...(input.owns === undefined ? {} : { owns: input.owns }),
      };
      if (Object.keys(attrs).length > 0)
        await tx
          .update(schema.blipElements)
          .set(attrs)
          .where(eq(schema.blipElements.blipId, existing));
    });
    return { id: existing, created: false };
  });
  const [row] = await getDb()
    .select({
      title: schema.blips.title,
      updatedAt: schema.blips.updatedAt,
      external: schema.blipElements.external,
      owns: schema.blipElements.owns,
    })
    .from(schema.blips)
    .innerJoin(schema.blipElements, eq(schema.blipElements.blipId, schema.blips.id))
    .where(eq(schema.blips.id, result.id));
  return {
    created: result.created,
    boundary: {
      id: result.id,
      title: row?.title ?? input.title,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
      external: row?.external ?? false,
      owns: row?.owns ?? [],
      amendedBy: await amendedByOf(result.id),
    },
  };
}

export async function upsertContract(
  actor: Actor,
  radarId: string,
  input: z.infer<typeof upsertContractSchema>,
): Promise<{ contract: ArchitectureContractDto; created: boolean }> {
  const { session, idempotencyKey, ...request } = input;
  actor = await writeAsAgent(actor, session);
  const radar = await architectureRadar(radarId, actor, 'write');
  return keyed(
    actor,
    'element.upsert',
    radar.id,
    idempotencyKey,
    { op: 'contract', ...request },
    (record) => upsertContractOnce(actor, radar, request, record),
    async (id) => {
      const contract = (await load(radar)).contracts.find((c) => c.id === id);
      if (!contract) throw notFound('Blip not found');
      return { contract, created: false };
    },
  );
}

export async function upsertContractOnce(
  actor: Actor,
  radar: RadarRow,
  input: ElementInput<typeof upsertContractSchema>,
  record: Record_,
  hook: CreateHook = {},
): Promise<{ contract: ArchitectureContractDto; created: boolean }> {
  if (input.a === input.b)
    throw unprocessable('same_boundary', 'A contract joins two different boundaries.');
  await checkElements(radar.id, [input.a, input.b], 'boundary');
  const ends = await getDb()
    .select({ id: schema.blipElements.blipId, external: schema.blipElements.external })
    .from(schema.blipElements)
    .where(inArray(schema.blipElements.blipId, [input.a, input.b]));
  if (ends.length === 2 && ends.every((e) => e.external))
    throw unprocessable(
      'outside_seam',
      'A contract needs a boundary inside the application on at least one side.',
    );
  const seams = (id: string) => [
    {
      radarId: radar.id,
      fromBlipId: id,
      toBlipId: input.a,
      kind: 'seam_side' as const,
      side: 'a' as const,
    },
    {
      radarId: radar.id,
      fromBlipId: id,
      toBlipId: input.b,
      kind: 'seam_side' as const,
      side: 'b' as const,
    },
  ];
  const result = await upsertElement(async () => {
    const existing = await findElement(getDb(), radar.id, 'contract', input);
    if (!existing) {
      const blip = await createBlip(
        actor,
        radar.id,
        { title: input.title, body: input.body ?? '', status: 'contract' },
        {
          element: true,
          requireTemplate: 'architecture',
          authored: false,
          arbitrate: (tx, id) => record(tx, id),
          afterInsert: async (tx, id) => {
            await tx
              .insert(schema.blipElements)
              .values({ blipId: id, version: input.version ?? null });
            await tx.insert(schema.blipRelations).values(seams(id));
            await hook.afterCreate?.(tx, id);
          },
        },
      );
      return { id: blip.id, created: true };
    }
    if (hook.afterCreate) return takenUnderClaim(record, existing);
    await getDb().transaction(async (tx) => {
      await record(tx, existing);
      await lockedFresh(tx, existing, input.expectedUpdatedAt);
      await rewrite(tx, actor, existing, input);
      if (input.version !== undefined)
        await tx
          .update(schema.blipElements)
          .set({ version: input.version })
          .where(eq(schema.blipElements.blipId, existing));
      await tx
        .delete(schema.blipRelations)
        .where(
          and(
            eq(schema.blipRelations.fromBlipId, existing),
            eq(schema.blipRelations.kind, 'seam_side'),
          ),
        );
      await tx.insert(schema.blipRelations).values(seams(existing));
    });
    return { id: existing, created: false };
  });
  const [row] = await getDb()
    .select({
      title: schema.blips.title,
      updatedAt: schema.blips.updatedAt,
      version: schema.blipElements.version,
    })
    .from(schema.blips)
    .innerJoin(schema.blipElements, eq(schema.blipElements.blipId, schema.blips.id))
    .where(eq(schema.blips.id, result.id));
  return {
    created: result.created,
    contract: {
      id: result.id,
      title: row?.title ?? input.title,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
      version: row?.version ?? null,
      a: input.a,
      b: input.b,
      amendedBy: await amendedByOf(result.id),
    },
  };
}

/** Everything touching a boundary, a contract or an ADR. */
export async function trace(actor: Actor, id: string): Promise<TraceDto> {
  const [blip] = await getDb()
    .select({ radarId: schema.blips.radarId, status: schema.blips.status })
    .from(schema.blips)
    .where(eq(schema.blips.id, id));
  if (!blip) throw notFound('Blip not found');
  const { radar, publicReader } = await architectureAccess(
    blip.radarId,
    actor,
    'read',
    getDb(),
    {},
  );
  const { adrs, boundaries, contracts, charterLinks } = await load(
    radar,
    undefined,
    {},
    publicReader,
  );
  const linksOf = (elementId: string) => {
    const mine = charterLinks.filter((l) => l.element.id === elementId);
    return mine.length > 0 ? { links: mine } : {};
  };
  const adrRef = (adrId: string | null) => {
    const adr = adrs.find((a) => a.id === adrId);
    return adr ? { id: adr.id, label: adr.label, lane: adr.lane } : null;
  };
  const amendedBy = (ids: readonly string[]) => ids.flatMap((adrId) => adrRef(adrId) ?? []);
  const end = (boundaryId: string) => {
    const b = boundaries.find((x) => x.id === boundaryId);
    return { id: boundaryId, title: b?.title ?? '', external: b?.external ?? false };
  };
  const boundary = boundaries.find((b) => b.id === id);
  if (boundary)
    return {
      kind: 'boundary',
      id,
      title: boundary.title,
      external: boundary.external,
      owns: boundary.owns ?? [],
      seams: contracts.flatMap((c) =>
        c.a === id || c.b === id
          ? [
              {
                contract: { id: c.id, title: c.title },
                version: c.version,
                side: c.a === id ? ('a' as const) : ('b' as const),
                counterparty: end(c.a === id ? c.b : c.a),
              },
            ]
          : [],
      ),
      amendedBy: amendedBy(boundary.amendedBy),
      ...linksOf(id),
    };
  const contract = contracts.find((c) => c.id === id);
  if (contract)
    return {
      kind: 'contract',
      id,
      title: contract.title,
      version: contract.version,
      a: end(contract.a),
      b: end(contract.b),
      amendedBy: amendedBy(contract.amendedBy),
      ...linksOf(id),
    };
  const adr = adrs.find((a) => a.id === id);
  if (!adr)
    throw unprocessable('not_traceable', 'Only a boundary, a contract or an ADR can be traced.');
  const element = (elementId: string) => {
    const b = boundaries.find((x) => x.id === elementId);
    const c = contracts.find((x) => x.id === elementId);
    return {
      id: elementId,
      title: b?.title ?? c?.title ?? '',
      kind: b ? ('boundary' as const) : ('contract' as const),
    };
  };
  return {
    kind: 'adr',
    id,
    label: adr.label,
    lane: adr.lane,
    anchors: adr.anchors,
    amends: adr.amends.map(element),
    supersedes: adrRef(adr.supersedes),
    supersededBy: adrRef(adr.supersededBy),
  };
}

/**
 * The architecture import: an architecture folder into an Architecture radar.
 * `scripts/import-architecture.ts` is its command line.
 *
 * `<dir>` holds `01-*.md` … `04-*.md` (the charter, one document) and `adr/*.md`
 * (imported verbatim, lane and ratification date read from the `Status:` line,
 * `Supersedes:` becoming the link). ADR-0027's three anchors are Commander's, hand-written
 * below (git carries no anchors, only prose) and applied only to a charter that quotes them. `components/*.md` become boundaries
 * and `contracts/*.md` become contracts (see `parseComponent`, `parseContract`),
 * and an ADR's `Amends:` line links it to the ones it names.
 *
 * An empty radar gets everything. A radar that already has its charter and ADRs
 * but no boundaries or contracts gets only those (the ADRs are matched by their
 * label). A radar with any boundary or contract is refused. Read-only on the source.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { ARCHITECTURE_ADR_LANES, LIMITS, isElementLane, ratifiedLane } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { labelOf, upsertBoundary, upsertContract } from './architecture.js';
import { createBlip } from './blips.js';
import { anchorAdr, ensureCharterDocument, writeCharterText } from './charter.js';

export interface AdrHeader {
  lane: 'proposed' | 'accepted';
  ratifiedAt: Date | null;
  supersedes: string | null;
}

/** `Status: Accepted (the product owner, 2026-10-15) · Date: 2026-10-15 · Supersedes: ADR-0005 (…)` and its kin. */
export function parseAdrHeader(markdown: string): AdrHeader {
  const line = /^Status:.*$/m.exec(markdown)?.[0];
  const word = line && /^Status:\s*(Accepted|Proposed)\b/i.exec(line)?.[1]?.toLowerCase();
  if (!line || (word !== 'accepted' && word !== 'proposed'))
    throw new Error(`Unrecognised ADR status line: ${line ?? '(none)'}`);
  const day =
    /^Status:\s*Accepted\s*\([^)]*?(\d{4}-\d{2}-\d{2})/i.exec(line)?.[1] ??
    /\bDate:\s*(\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
  if (word === 'accepted' && !day) throw new Error(`Accepted ADR without a date: ${line}`);
  return {
    lane: word,
    ratifiedAt: word === 'accepted' && day ? new Date(`${day}T00:00:00Z`) : null,
    supersedes: /\bSupersedes:\s*(ADR-\d+)/.exec(line)?.[1] ?? null,
  };
}

/** ADR-0027's amendments, from its Decision section 3 (payment truth only; service level from the clock). */
export const ADR_0027_ANCHORS = [
  { quote: 'all billing truth', with: 'payment truth only' },
  {
    quote: 'Never acts on its own (ADR-0005)',
    with: 'Derives the service level from payment truth and the clock, then suspends or resumes (ADR-0027)',
  },
  {
    quote: 'A lost dispute keeps billing at no opinion (ADR-0005)',
    with: 'A lost dispute is payment truth like any other: billing derives the service level from it and the clock (ADR-0027)',
  },
] as const;

/* ------------------------- boundaries and contracts ------------------------ */

export const EVERY_MODULE = 'Every module';
const clean = (text: string) => text.replace(/\\/g, '').replace(/`/g, '').trim();
const h1Of = (markdown: string) => /^#\s+(.*)$/m.exec(markdown)?.[1] ?? '';

export interface ParsedBoundary {
  slug: string;
  code: string | null;
  title: string;
  owns: string[];
  body: string;
}

/** `# Component: M8 Billing` and its §2 "Owned data" table: the first backticked cell of each row. */
export function parseComponent(slug: string, markdown: string): ParsedBoundary {
  const title = clean(h1Of(markdown).replace(/^Component:\s*/, ''));
  const code = /^([MC]\d+)\b/.exec(title)?.[1] ?? (/\(A\*\)/.test(title) ? 'A*' : null);
  const lines = markdown.split('\n');
  const from = lines.findIndex((l) => /^##\s+2[.\s]/.test(l));
  const to = from < 0 ? -1 : lines.findIndex((l, i) => i > from && /^##\s/.test(l));
  const section = from < 0 ? [] : lines.slice(from, to < 0 ? undefined : to);
  const owns = section.flatMap((l) => /^\|\s*`([^`]+)`/.exec(l)?.[1] ?? []);
  const head = lines
    .slice(0, to < 0 ? undefined : to)
    .join('\n')
    .trimEnd();
  return {
    slug,
    code,
    title,
    owns: owns.map((o) => o.slice(0, 200)).slice(0, 100),
    body: `${head}\n\nSource: docs/architecture/components/${slug}.md`.slice(0, LIMITS.blipBody),
  };
}

/** Split at depth 0 on `;`, `,` and ` and `, so what sits in brackets or backticks stays with its clause. */
function clauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let tick = false;
  let at = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '`') tick = !tick;
    else if (!tick && ch === '(') depth += 1;
    else if (!tick && ch === ')') depth = Math.max(0, depth - 1);
    else if (!tick && depth === 0) {
      const cut = ch === ';' || ch === ',' ? 1 : text.startsWith(' and ', i) ? 5 : 0;
      if (cut) {
        out.push(text.slice(at, i));
        at = i + cut;
        i += cut - 1;
      }
    }
  }
  return [...out, text.slice(at)];
}

/** The first component a text names: `M8`, `C1`, `A*` or `components/x.md`. */
const firstRef = (text: string): string | null => {
  const m = /components\/([a-z][a-z-]*)\.md|\b([MC]\d+)\b|(A\\?\*)/.exec(text);
  return m ? (m[1] ? `slug:${m[1]}` : m[2] ? m[2] : 'A*') : null;
};

export type SideB = { ref: string } | { external: string } | { everyModule: true };
export interface ParsedContract {
  slug: string;
  title: string;
  version: string | null;
  a: string;
  b: SideB;
  body: string;
}

/**
 * A contract's two sides from its `Status:` line. Side a is the first component
 * on the Commander (or OMR) side. Side b drops fan-out clauses (`every…`, `each…`,
 * `modules…`) and takes the first component left that is not side a; with none
 * left, a fan-out only means "Every module" and anything else is an external
 * system named from the contract's title. Null when it names no Commander component.
 */
export function parseContract(slug: string, markdown: string): ParsedContract | null {
  const status = /^Status:.*$/m.exec(markdown)?.[0] ?? '';
  const sides =
    /Owner \((?:Commander|OMR) side\):\s*(.*?)\s*·\s*Owner \(other side\):\s*(.*?)(?:\s*·\s*Provider ref|$)/.exec(
      status,
    );
  const a = sides?.[1] ? firstRef(sides[1]) : null;
  if (!sides || !a) return null;
  const rest = clauses(sides[2] ?? '').filter((c) => c.trim() !== '');
  const kept = rest.filter((c) => !/^\s*(every|each|modules)\b/i.test(c));
  const b = kept.map(firstRef).find((r) => r && r !== a);
  const title = clean(h1Of(markdown).replace(/^Contract:\s*/, ''));
  return {
    slug,
    title,
    version: /Version\s+([0-9][0-9.]*)/.exec(status)?.[1] ?? null,
    a,
    b: b
      ? { ref: b }
      : kept.length === 0 && rest.length > 0
        ? { everyModule: true }
        : { external: title.replace(/\s*\(.*$/, '').trim() },
    body: markdown.trim().slice(0, LIMITS.blipBody),
  };
}

/** What an ADR's `Amends:` names: components and contracts by file, and the rest as written. */
export function parseAmends(markdown: string): { files: string[]; other: string[] } {
  const line = /^Status:.*$/m.exec(markdown)?.[0] ?? '';
  const text = /\bAmends:\s*(.*?)(?:\s+·\s|$)/.exec(line)?.[1] ?? '';
  const files = [...text.matchAll(/`(components|contracts)\/([a-z-]+)\.md`/g)].map(
    (m) => `${m[1] ?? ''}/${m[2] ?? ''}`,
  );
  const other = text
    .split(/,\s*/)
    .map((t) => t.replace(/^and\s+/, '').trim())
    .filter((t) => t && !/^`(components|contracts)\//.test(t));
  return { files, other };
}

const md = async (dir: string, pattern: RegExp) =>
  (await readdir(dir).catch(() => [] as string[])).filter((f) => pattern.test(f)).sort();

export async function importArchitecture(dir: string, radarId: string): Promise<string> {
  const db = getDb();
  const [radar] = await db.select().from(schema.radars).where(eq(schema.radars.id, radarId));
  if (!radar || !ratifiedLane(radar.template, radar.templateConfig))
    throw new Error('Not an Architecture radar.');
  const rows = await db
    .select({ id: schema.blips.id, title: schema.blips.title, status: schema.blips.status })
    .from(schema.blips)
    .where(eq(schema.blips.radarId, radarId));
  const componentFiles = await md(join(dir, 'components'), /^[a-z][a-z-]*\.md$/);
  if (rows.length > 0 && componentFiles.length === 0)
    throw new Error('That radar is not empty; the folder has no components or contracts to add.');
  if (rows.some((r) => isElementLane(radar.template, r.status, radar.templateConfig)))
    throw new Error('That radar already has boundaries or contracts; the import does not merge.');
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, radar.ownerId));
  if (!owner) throw new Error('The radar has no owner.');
  const actor = { kind: 'user' as const, user: owner };
  const ids = new Map<string, string>();

  if (rows.length === 0) {
    // The pages 01 to 04 are one document, in order, a blank line between them.
    const charter: string[] = [];
    for (const file of await md(dir, /^0[1-4]-.*\.md$/))
      charter.push(await readFile(join(dir, file), 'utf8'));
    await ensureCharterDocument(radarId);
    if (charter.length > 0)
      await writeCharterText(actor, radarId, {
        markdown: charter.join('\n\n'),
        baseRevision: 0,
        note: 'imported from the architecture folder',
      });
    for (const file of await md(join(dir, 'adr'), /^\d{4}-.*\.md$/)) {
      const body = await readFile(join(dir, 'adr', file), 'utf8');
      const header = parseAdrHeader(body);
      const supersedes = header.supersedes ? ids.get(header.supersedes) : undefined;
      if (header.supersedes && !supersedes)
        throw new Error(`${file} supersedes ${header.supersedes}, not imported yet.`);
      const blip = await createBlip(
        actor,
        radarId,
        { body, status: header.lane, ...(supersedes ? { supersedes } : {}) },
        header.ratifiedAt ? { ratifiedAt: header.ratifiedAt } : {},
      );
      ids.set(`ADR-${file.slice(0, 4)}`, blip.id);
    }
    // The anchors are Commander's own text: another folder's ADR-0027 is left alone
    // unless its charter quotes all three.
    const adr27 = ids.get('ADR-0027');
    const commanders = ADR_0027_ANCHORS.every((a) =>
      charter.some((page) => page.includes(a.quote)),
    );
    if (adr27 && commanders)
      await db.transaction((tx) => anchorAdr(tx, radarId, adr27, ADR_0027_ANCHORS, null, actor));
  } else {
    // Charter and ADRs are already here: match the ADRs by label and add only the elements.
    for (const r of rows)
      if (ARCHITECTURE_ADR_LANES.some((lane) => lane === r.status))
        ids.set(labelOf(r.title, r.id), r.id);
  }
  const adrs = ids.size;

  const parts = new Map<string, ParsedBoundary>();
  const boundaryIds = new Map<string, string>();
  const make = async (title: string, owns: string[], body: string, external: boolean) =>
    (await upsertBoundary(actor, radarId, { title, owns, body, external })).boundary.id;
  for (const file of componentFiles) {
    const slug = file.slice(0, -3);
    const part = parseComponent(slug, await readFile(join(dir, 'components', file), 'utf8'));
    if (part.code) parts.set(part.code, part);
    parts.set(`slug:${slug}`, part);
    boundaryIds.set(slug, await make(part.title, part.owns, part.body, false));
  }
  const refId = (ref: string): string => {
    const part = parts.get(ref);
    const id = part && boundaryIds.get(part.slug);
    if (!id) throw new Error(`A contract names ${ref}, which has no component file.`);
    return id;
  };
  const named = new Map<string, string>();
  const contractIds = new Map<string, string>();
  const skipped: string[] = [];
  for (const file of await md(join(dir, 'contracts'), /^[a-z][a-z-]*\.md$/)) {
    const slug = file.slice(0, -3);
    const contract = parseContract(slug, await readFile(join(dir, 'contracts', file), 'utf8'));
    if (!contract) {
      skipped.push(slug);
      continue;
    }
    const side = async (name: string, body: string): Promise<string> => {
      const id = named.get(name) ?? (await make(name, [], body, name !== EVERY_MODULE));
      named.set(name, id);
      return id;
    };
    const b =
      'ref' in contract.b
        ? refId(contract.b.ref)
        : 'external' in contract.b
          ? await side(contract.b.external, `External system, named from contracts/${slug}.md.`)
          : await side(EVERY_MODULE, 'Stands for every module that registers with the contract.');
    const made = await upsertContract(actor, radarId, {
      title: contract.title,
      body: contract.body,
      a: refId(contract.a),
      b,
      ...(contract.version ? { version: contract.version } : {}),
    });
    contractIds.set(slug, made.contract.id);
  }

  // Which ADR amends which boundary or contract, from each `Amends:` line.
  const unresolved: string[] = [];
  let links = 0;
  for (const file of boundaryIds.size > 0 ? await md(join(dir, 'adr'), /^\d{4}-.*\.md$/) : []) {
    const from = ids.get(`ADR-${file.slice(0, 4)}`);
    const { files, other } = parseAmends(await readFile(join(dir, 'adr', file), 'utf8'));
    unresolved.push(...other.map((o) => `${file.slice(0, 4)}: ${o}`));
    for (const target of files) {
      const [kind, slug] = target.split('/') as [string, string];
      const to = kind === 'components' ? boundaryIds.get(slug) : contractIds.get(slug);
      if (!from || !to) {
        unresolved.push(`${file.slice(0, 4)}: ${target}`);
        continue;
      }
      await db
        .insert(schema.blipRelations)
        .values({ radarId, fromBlipId: from, toBlipId: to, kind: 'amends' })
        .onConflictDoNothing();
      links += 1;
    }
  }
  const everyModule = named.has(EVERY_MODULE) ? 1 : 0;
  return [
    `${rows.length === 0 ? 'Imported' : 'Matched'} ${adrs} ADRs.`,
    boundaryIds.size > 0
      ? `${boundaryIds.size + named.size} boundaries (${boundaryIds.size + everyModule} internal, ${named.size - everyModule} external), ${contractIds.size} contracts, ${links} amends links.`
      : '',
    skipped.length ? `Skipped (no Commander component): ${skipped.join(', ')}.` : '',
    unresolved.length ? `Not linked: ${unresolved.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

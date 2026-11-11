/**
 * `docs/architecture` is imported into an Architecture radar by
 * `scripts/import-architecture.ts`. This test parses the folder with the
 * importer's own parsers so it cannot drift into a shape the importer silently
 * skips, and it checks that what the components claim to own exists.
 *
 * It is pure: no database. It deliberately does not require that every table
 * has an owner (that would fail every future migration until someone edits the
 * docs); it requires that no claimed table is invented and none is claimed twice.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS, extractInlineTags, extractMentions } from '@onmyradar/contract';
import { ALL_TABLE_NAMES } from '../db/schema.js';
import {
  parseAdrHeader,
  parseAmends,
  parseComponent,
  parseContract,
} from './architecture-import.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const DIR = join(REPO, 'docs', 'architecture');
const read = (...parts: string[]) => readFileSync(join(DIR, ...parts), 'utf8');
const list = (sub: string) =>
  existsSync(join(DIR, sub)) ? readdirSync(join(DIR, sub)).sort() : [];

const adrFiles = list('adr');
const componentFiles = list('components');
const contractFiles = list('contracts');

/** The rows of a component's section 2, as the importer reads them, with the kind column. */
function ownedRows(markdown: string): Array<{ item: string; kind: string }> {
  const lines = markdown.split('\n');
  const from = lines.findIndex((l) => /^##\s+2[.\s]/.test(l));
  const to = lines.findIndex((l, i) => i > from && /^##\s/.test(l));
  return lines.slice(from, to < 0 ? undefined : to).flatMap((l) => {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([a-z-]+)\s*\|/.exec(l);
    return m ? [{ item: m[1] ?? '', kind: m[2] ?? '' }] : [];
  });
}

describe('docs/architecture layout', () => {
  it('has the four charter pages, each opening with its own H1', () => {
    const charter = readdirSync(DIR).filter((f) => /^0[1-4]-.*\.md$/.test(f));
    expect(charter.map((f) => f.slice(0, 2))).toEqual(['01', '02', '03', '04']);
    for (const f of charter) expect(read(f).split('\n')[0]).toMatch(/^# 0[1-4] · \S/);
  });

  it('names component and contract files so the importer does not skip them', () => {
    // The importer's own filter is /^[a-z][a-z-]*\.md$/: a digit drops a file without an error.
    for (const f of [...componentFiles, ...contractFiles]) expect(f).toMatch(/^[a-z][a-z-]*\.md$/);
    expect(componentFiles.length).toBeGreaterThan(0);
    expect(contractFiles.length).toBeGreaterThan(0);
  });

  it('keeps every page inside what a blip can hold, with no mention and few hashtags', () => {
    const pages = [
      ...readdirSync(DIR).filter((f) => f.endsWith('.md')),
      ...adrFiles.map((f) => `adr/${f}`),
      ...componentFiles.map((f) => `components/${f}`),
      ...contractFiles.map((f) => `contracts/${f}`),
    ];
    for (const page of pages) {
      const body = read(page);
      expect(body.length, page).toBeLessThanOrEqual(LIMITS.blipBody);
      // The import runs as the radar's owner, so a bare @handle would notify a real person or agent.
      expect(extractMentions(body), `${page} has an @mention`).toEqual([]);
      expect(extractInlineTags(body).length, `${page} has too many hashtags`).toBeLessThanOrEqual(
        24,
      );
      expect(body.split('\n')[0], page).toMatch(/^# \S/);
    }
  });
});

describe('docs/architecture ADRs', () => {
  const numbers = adrFiles.map((f) => Number(f.slice(0, 4)));

  it('are numbered 0001 upward without gaps', () => {
    expect(adrFiles.length).toBeGreaterThanOrEqual(10);
    expect(adrFiles.length).toBeLessThanOrEqual(20);
    for (const f of adrFiles) expect(f).toMatch(/^\d{4}-[a-z0-9-]+\.md$/);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it.each(adrFiles)('%s has a Status line the importer accepts and is Accepted', (file) => {
    const body = read('adr', file);
    // The importer labels an ADR from its H1, so the H1 number must be the file's.
    expect(body.split('\n')[0]).toMatch(new RegExp(`^# ADR-${file.slice(0, 4)}: \\S`));
    const header = parseAdrHeader(body);
    expect(header.lane).toBe('accepted');
    expect(header.ratifiedAt).not.toBeNull();
    // Dated from the git log, never in the future of the folder's own date.
    expect(header.ratifiedAt?.getTime() ?? 0).toBeLessThanOrEqual(
      Date.parse('2026-10-30T00:00:00Z'),
    );
    expect(body.match(/^Status:/gm)?.length).toBe(1);
    expect(body).toMatch(/^## Decision$/m);
    expect(body).toMatch(/^## Evidence$/m);
  });

  it('supersede only an earlier ADR and amend only files that exist', () => {
    const compSlugs = new Set(componentFiles.map((f) => f.slice(0, -3)));
    const contractSlugs = new Set(contractFiles.map((f) => f.slice(0, -3)));
    for (const f of adrFiles) {
      const body = read('adr', f);
      const { supersedes } = parseAdrHeader(body);
      if (supersedes) expect(Number(supersedes.slice(4))).toBeLessThan(Number(f.slice(0, 4)));
      const { files, other } = parseAmends(body);
      expect(other, `${f} Amends: names something the importer cannot link`).toEqual([]);
      for (const target of files) {
        const [kind, slug] = target.split('/') as [string, string];
        expect((kind === 'components' ? compSlugs : contractSlugs).has(slug), target).toBe(true);
      }
    }
  });
});

describe('docs/architecture components', () => {
  const parsed = componentFiles.map((f) => parseComponent(f.slice(0, -3), read('components', f)));

  it('each carry a unique M code and a non-empty owned-data list', () => {
    const codes = parsed.map((p) => p.code);
    for (const p of parsed) {
      expect(p.code, p.slug).toMatch(/^M\d+$/);
      expect(p.owns.length, `${p.slug} owns nothing`).toBeGreaterThan(0);
      expect(p.title, p.slug).not.toMatch(/^Component:/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('claim only tables that exist, only once, and only files that exist', () => {
    const claimed = new Map<string, string>();
    for (const f of componentFiles) {
      const rows = ownedRows(read('components', f));
      expect(rows.length, f).toBeGreaterThan(0);
      for (const { item, kind } of rows) {
        expect(['table', 'file', 'elsewhere'], `${f}: ${item} has kind "${kind}"`).toContain(kind);
        if (kind === 'table') {
          expect(ALL_TABLE_NAMES as readonly string[], `${f} claims table ${item}`).toContain(item);
          expect(
            claimed.get(item),
            `${item} is claimed by ${claimed.get(item) ?? '?'} and ${f}`,
          ).toBe(undefined);
          claimed.set(item, f);
        }
        if (kind === 'file') expect(existsSync(join(REPO, item)), `${f}: ${item}`).toBe(true);
      }
    }
  });

  it('are listed, with their codes, on the components page', () => {
    const page = read('03-components.md');
    for (const p of parsed) {
      expect(page, p.slug).toContain(`\`components/${p.slug}.md\``);
      expect(page, p.slug).toMatch(new RegExp(`\\| ${p.code ?? ''}\\s+\\|`));
    }
  });
});

/**
 * A table row is split on every `|` that is not escaped as `\\|`, even inside a
 * code span. An unescaped pipe in a cell therefore adds a column in the app's
 * renderer and the notes that follow it are lost. Count cells per row against
 * the header of the same table.
 */
function badTableRows(markdown: string): string[] {
  const cells = (line: string) => line.replace(/\\\|/g, '').split('|').length - 2;
  const lines = markdown.split('\n');
  const bad: string[] = [];
  let fence = false;
  let width = 0;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (!isRow) {
      width = 0;
      return;
    }
    const next = lines[i + 1] ?? '';
    if (width === 0 && /^\s*\|[\s:|-]+\|\s*$/.test(next)) {
      width = cells(line);
      return;
    }
    if (width > 0 && cells(line) !== width)
      bad.push(`line ${i + 1}: ${cells(line)} cells, expected ${width}`);
  });
  return bad;
}

describe('docs/architecture tables', () => {
  const pages = [
    ...[
      'README.md',
      '01-principles.md',
      '02-system-context.md',
      '03-components.md',
      '04-domain-model.md',
    ].map((f) => [f, read(f)] as const),
    ...adrFiles.map((f) => [`adr/${f}`, read('adr', f)] as const),
    ...componentFiles.map((f) => [`components/${f}`, read('components', f)] as const),
    ...contractFiles.map((f) => [`contracts/${f}`, read('contracts', f)] as const),
  ];

  it('have the same number of cells in every row as in their header (escape | as \\|)', () => {
    const problems = pages.flatMap(([file, body]) => badTableRows(body).map((m) => `${file} ${m}`));
    expect(problems).toEqual([]);
  });

  it('detects a pipe that was not escaped', () => {
    const table = '| A | B |\n| - | - |\n| `x|y` | z |\n';
    expect(badTableRows(table)).toHaveLength(1);
    expect(badTableRows('| A | B |\n| - | - |\n| `x\\|y` | z |\n')).toEqual([]);
  });
});

describe('docs/architecture contracts', () => {
  const components = new Map(
    componentFiles.map((f) => {
      const p = parseComponent(f.slice(0, -3), read('components', f));
      return [p.code, p.slug] as const;
    }),
  );
  const contracts = contractFiles.map((f) => ({
    file: f,
    parsed: parseContract(f.slice(0, -3), read('contracts', f)),
  }));

  it('are all read by the importer (none skipped), with a version', () => {
    for (const { file, parsed } of contracts) {
      expect(parsed, `${file} would be skipped: no recognisable Status line`).not.toBeNull();
      expect(parsed?.version, file).toMatch(/^\d+\.\d+$/);
    }
    const titles = contracts.map((c) => c.parsed?.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('start at a component and end at a component or a named external system', () => {
    for (const { file, parsed } of contracts) {
      if (!parsed) continue;
      expect(components.has(parsed.a), `${file}: side a ${parsed.a}`).toBe(true);
      if ('ref' in parsed.b) {
        expect(components.has(parsed.b.ref), `${file}: side b ${parsed.b.ref}`).toBe(true);
        expect(parsed.b.ref).not.toBe(parsed.a);
      } else {
        expect('external' in parsed.b, `${file} falls back to "Every module"`).toBe(true);
        if ('external' in parsed.b) expect(parsed.b.external.length).toBeGreaterThan(2);
      }
    }
  });

  it('use one spelling per external system', () => {
    const externals = contracts.flatMap(({ parsed }) =>
      parsed && 'external' in parsed.b ? [parsed.b.external] : [],
    );
    const folded = new Map<string, Set<string>>();
    for (const name of externals) {
      const key = name.toLowerCase().replace(/[^a-z]/g, '');
      folded.set(key, (folded.get(key) ?? new Set()).add(name));
    }
    for (const [key, names] of folded) expect([...names], key).toHaveLength(1);
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ADR_HEADERS,
  ADR_STATUSES,
  ADR_TITLES,
  COMPONENT_H1S,
  COMPONENT_SECTIONS,
  CONTRACT_HEADERS,
  PAGE_02,
  PAGE_03,
  PAGE_04,
} from '../src/__fixtures__/acme-architecture.js';
import { closeDb, getDb, getPool, schema } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { readArchitecture } from '../src/services/architecture.js';
import { listBlips } from '../src/services/blips.js';
import { createRadar } from '../src/services/radars.js';
import {
  importArchitecture,
  parseAdrHeader,
  parseContract,
} from '../src/services/architecture-import.js';

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const status = (n: keyof typeof ADR_HEADERS) => ADR_HEADERS[n][1];

describe('the Status line of an architecture folder’s ADRs', () => {
  it('reads all five real variants', () => {
    expect(parseAdrHeader(status('0001'))).toMatchObject({
      lane: 'proposed',
      ratifiedAt: null,
      supersedes: null,
    });
    expect(parseAdrHeader(status('0005'))).toMatchObject({
      lane: 'accepted',
      ratifiedAt: new Date('2026-10-14T00:00:00Z'),
    });
    // A trailing note after the parenthetical.
    expect(parseAdrHeader(status('0021')).ratifiedAt).toEqual(new Date('2026-10-14T00:00:00Z'));
    // "Accepted (standing rule: …)" names no date: the Date field stands in.
    expect(parseAdrHeader(status('0025'))).toMatchObject({
      lane: 'accepted',
      ratifiedAt: new Date('2026-10-14T00:00:00Z'),
    });
    expect(parseAdrHeader(status('0026')).ratifiedAt).toEqual(new Date('2026-10-15T00:00:00Z'));
    expect(parseAdrHeader(status('0027'))).toMatchObject({ supersedes: 'ADR-0005' });
  });

  it('refuses a status it does not know rather than guessing a lane', () => {
    expect(() => parseAdrHeader('Status: Deprecated · Date: 2026-10-14')).toThrow(/Unrecognised/);
  });
});

describe('a contract Status line from a folder that names its own side differently', () => {
  it('reads Owner (OMR side) like Owner (Commander side)', () => {
    const doc = (side: string) =>
      `# Contract: Stripe (webhooks)\n\nStatus: Draft · Version 1.0 · Owner (${side} side): M3 Billing · Owner (other side): Stripe (third party) · Provider ref: x\n`;
    expect(parseContract('stripe', doc('OMR'))).toMatchObject({
      a: 'M3',
      b: { external: 'Stripe' },
      version: '1.0',
    });
    expect(parseContract('stripe', doc('Commander'))).toMatchObject({ a: 'M3' });
  });
});

describe.skipIf(!process.env['DATABASE_URL'])(
  'importing a charter and its ADRs (real postgres)',
  () => {
    let dir = '';
    afterAll(async () => {
      await closeDb();
      if (dir) await rm(dir, { recursive: true, force: true });
    });
    const fingerprint = async () =>
      JSON.stringify(
        await Promise.all(
          [...(await readdir(dir, { recursive: true }))].sort().map(async (f) => {
            const bytes = await readFile(join(dir, f)).catch(() => Buffer.alloc(0));
            return [f, createHash('sha256').update(bytes).digest('hex')];
          }),
        ),
      );

    it('fills an empty radar in reading order, repeals ADR-0005, anchors ADR-0027, and leaves the source alone', async () => {
      await runMigrations();
      dir = await mkdtemp(join(tmpdir(), 'omr-architecture-'));
      await mkdir(join(dir, 'adr'));
      const files: Record<string, string> = {
        '01-principles.md': '# 01 · Principles',
        '02-system-context.md': PAGE_02,
        '03-components.md': PAGE_03,
        '04-domain-model.md': PAGE_04,
      };
      for (const n of ['0001', '0005', '0027'] as const)
        files[`adr/${n}-x.md`] = `${ADR_HEADERS[n][0]}\n\n${status(n)}\n`;
      for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
      const before = await fingerprint();

      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `seed-${Date.now()}@architecture.test`, state: 'active' })
        .returning();
      const owner = { kind: 'user' as const, user: must(user) };
      const radar = await createRadar(owner, { name: 'Acme', template: 'architecture' });

      expect(await importArchitecture(dir, radar.id)).toBe('Imported 3 ADRs.');
      const read = await readArchitecture(owner, radar.id, { view: 'written' });
      // The four pages are one document, in order, a blank line between them; no page blip is made.
      expect(read.charter.map((p) => p.markdown)).toEqual([
        ['# 01 · Principles', PAGE_02, PAGE_03, PAGE_04].join('\n\n'),
      ]);
      expect(read.revision).toBe(1);
      expect(read.adrs.map((a) => [a.label, a.lane])).toEqual([
        ['ADR-0005', 'repealed'],
        ['ADR-0027', 'accepted'],
        ['ADR-0001', 'proposed'],
      ]);
      expect(read.adrs[1]?.anchors.map((a) => a.quote)).toEqual([
        'all billing truth',
        'Never acts on its own (ADR-0005)',
        'A lost dispute keeps billing at no opinion (ADR-0005)',
      ]);
      expect(
        (await readArchitecture(owner, radar.id, { view: 'amended' })).charter
          .map((p) => p.markdown)
          .join('\n'),
      ).toContain('**payment truth only**');

      await expect(importArchitecture(dir, radar.id)).rejects.toThrow(/not empty/);
      expect(await fingerprint()).toBe(before);
    }, 30_000);

    it('leaves another folder’s ADR-0027 alone: the anchors are the Acme pack’s', async () => {
      await runMigrations();
      const base = await mkdtemp(join(tmpdir(), 'omr-architecture-0027-'));
      try {
        await mkdir(join(base, 'adr'));
        await writeFile(join(base, '01-principles.md'), '# 01 · Principles\n\nOne page.');
        await writeFile(
          join(base, 'adr/0027-other.md'),
          '# ADR-0027: Something else\n\nStatus: Accepted · Date: 2026-10-30\n',
        );
        const [user] = await getDb()
          .insert(schema.users)
          .values({ email: `adr0027-${Date.now()}@architecture.test`, state: 'active' })
          .returning();
        const owner = { kind: 'user' as const, user: must(user) };
        const radar = await createRadar(owner, { name: 'Other', template: 'architecture' });
        expect(await importArchitecture(base, radar.id)).toBe('Imported 1 ADRs.');
        const read = await readArchitecture(owner, radar.id, { view: 'written' });
        expect(read.adrs.map((a) => [a.label, a.lane, a.anchors.length])).toEqual([
          ['ADR-0027', 'accepted', 0],
        ]);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }, 30_000);

    it('adds the Acme pack’s 24 boundaries inside, 16 outside and 26 contracts, to an empty radar or to a seeded one', async () => {
      await runMigrations();
      const base = await mkdtemp(join(tmpdir(), 'omr-architecture-elements-'));
      try {
        await mkdir(join(base, 'adr'));
        await mkdir(join(base, 'components'));
        await mkdir(join(base, 'contracts'));
        const files: Record<string, string> = {
          '01-principles.md': '# 01 · Principles',
          '02-system-context.md': PAGE_02,
          '03-components.md': PAGE_03,
          '04-domain-model.md': PAGE_04,
        };
        for (const n of ['0005', '0026', '0027'] as const)
          files[`adr/${n}-x.md`] = `${ADR_HEADERS[n][0]}\n\n${status(n)}\n`;
        for (const [slug, h1] of Object.entries(COMPONENT_H1S))
          files[`components/${slug}.md`] = COMPONENT_SECTIONS[slug] ?? `${h1}\n`;
        for (const [slug, [h1, line]] of Object.entries(CONTRACT_HEADERS))
          files[`contracts/${slug}.md`] = `${h1}\n\n${line}\n`;
        for (const [name, body] of Object.entries(files)) await writeFile(join(base, name), body);
        dir = base;
        const before = await fingerprint();
        const [user] = await getDb()
          .insert(schema.users)
          .values({ email: `elements-${Date.now()}@architecture.test`, state: 'active' })
          .returning();
        const owner = { kind: 'user' as const, user: must(user) };
        const names = (read: Awaited<ReturnType<typeof readArchitecture>>) =>
          new Map([...read.boundaries, ...read.contracts].map((e) => [e.id, e.title]));

        // Empty radar: everything.
        const empty = await createRadar(owner, { name: 'Whole', template: 'architecture' });
        const summary = await importArchitecture(base, empty.id);
        expect(summary).toBe(
          'Imported 3 ADRs. 40 boundaries (24 internal, 16 external), 26 contracts, 6 amends links. ' +
            'Skipped (no Commander component): capability-manifest. ' +
            'Not linked: 0027: ADR-0024; 0027: ADR-0026; 0027: `plan/slices-1-2.md` A4.',
        );
        const read = await readArchitecture(owner, empty.id, { view: 'written' });
        const title = names(read);
        expect(
          read.adrs
            .map((a) => [a.label, a.amends.map((id) => title.get(id)).sort()] as const)
            .filter(([, t]) => t.length > 0)
            .map(([label, t]) => [label, t]),
        ).toEqual([
          ['ADR-0026', ['Admin UI', 'Checks and findings', 'M4 Delivery', 'M9 Health']],
          ['ADR-0027', ['Acme portal', 'M8 Billing']],
        ]);
        // ADR-0027's Amends names components/billing.md and contracts/portal.md; stripe.md stays unmarked.
        const adr27 = must(read.adrs.find((a) => a.label === 'ADR-0027')).id;
        expect(
          read.boundaries.filter((b) => b.amendedBy.includes(adr27)).map((b) => b.title),
        ).toEqual(['M8 Billing']);
        expect(
          read.contracts.filter((c) => c.amendedBy.includes(adr27)).map((c) => c.title),
        ).toEqual(['Acme portal']);
        expect(read.contracts.find((c) => /stripe/i.test(c.title))?.amendedBy).toEqual([]);
        expect(read.boundaries.find((b) => b.title === 'M8 Billing')?.owns).toHaveLength(9);
        expect(read.boundaries.find((b) => b.title === 'Every module')).toMatchObject({
          external: false,
        });
        expect(read.boundaries.filter((b) => b.external)).toHaveLength(16);
        // Measured: the plan allowed 16 KB; the digest without the charter is about 17 KB.
        const { charter: _charter, ...digest } = read;
        expect(JSON.stringify(digest).length).toBeLessThan(22_000);

        // A radar that already has its charter and ADRs: only the elements, matched by label.
        const seeded = await createRadar(owner, { name: 'Seeded', template: 'architecture' });
        await rm(join(base, 'components'), { recursive: true });
        await rm(join(base, 'contracts'), { recursive: true });
        expect(await importArchitecture(base, seeded.id)).toBe('Imported 3 ADRs.');
        await mkdir(join(base, 'components'));
        await mkdir(join(base, 'contracts'));
        for (const [name, body] of Object.entries(files))
          if (/^(components|contracts)\//.test(name)) await writeFile(join(base, name), body);
        const added = await importArchitecture(base, seeded.id);
        expect(added).toMatch(
          /^Matched 3 ADRs\. 40 boundaries \(24 internal, 16 external\), 26 contracts, 6 amends links\./,
        );
        const after = await readArchitecture(owner, seeded.id, { view: 'written' });
        expect(after.adrs.filter((a) => a.amends.length).map((a) => a.label)).toEqual([
          'ADR-0026',
          'ADR-0027',
        ]);
        expect(after.charter).toHaveLength(1);

        await expect(importArchitecture(base, seeded.id)).rejects.toThrow(/already has boundaries/);
        const rows = await getPool().query(
          'SELECT count(*)::int AS n FROM blips WHERE radar_id = $1',
          [seeded.id],
        );
        expect((rows.rows as Array<{ n: number }>)[0]?.n).toBe(3 + 40 + 26);
        expect(await fingerprint()).toBe(before);
      } finally {
        await rm(base, { recursive: true, force: true });
        dir = '';
      }
    }, 30_000);

    it('imports all 27 ADRs (21 Proposed, 6 Accepted) and lists every one before the 66 elements', async () => {
      await runMigrations();
      const base = await mkdtemp(join(tmpdir(), 'omr-architecture-all-'));
      try {
        await mkdir(join(base, 'adr'));
        await mkdir(join(base, 'components'));
        await mkdir(join(base, 'contracts'));
        const files: Record<string, string> = {
          '01-principles.md': '# 01 · Principles',
          '02-system-context.md': PAGE_02,
          '03-components.md': PAGE_03,
          '04-domain-model.md': PAGE_04,
        };
        ADR_TITLES.forEach((title, i) => {
          files[`adr/${String(i + 1).padStart(4, '0')}-x.md`] =
            `${title}\n\n${must(ADR_STATUSES[i])}\n`;
        });
        for (const [slug, h1] of Object.entries(COMPONENT_H1S))
          files[`components/${slug}.md`] = COMPONENT_SECTIONS[slug] ?? `${h1}\n`;
        for (const [slug, [h1, line]] of Object.entries(CONTRACT_HEADERS))
          files[`contracts/${slug}.md`] = `${h1}\n\n${line}\n`;
        for (const [name, body] of Object.entries(files)) await writeFile(join(base, name), body);
        const [user] = await getDb()
          .insert(schema.users)
          .values({ email: `all-adrs-${Date.now()}@architecture.test`, state: 'active' })
          .returning();
        const owner = { kind: 'user' as const, user: must(user) };
        const radar = await createRadar(owner, { name: 'All', template: 'architecture' });
        await importArchitecture(base, radar.id);

        const read = await readArchitecture(owner, radar.id, { view: 'written' });
        const count = (lane: string) => read.adrs.filter((a) => a.lane === lane).length;
        expect([count('proposed'), count('accepted') + count('repealed')]).toEqual([21, 6]);

        // The stream pages 50 at a time, lane by lane: every ADR is on the first page.
        const page = await listBlips([radar.id], {}, null, null, {
          template: 'architecture',
          templateConfig: {},
        });
        const lanes = page.items.map((b) => b.status);
        expect(lanes.filter((l) => l === 'proposed')).toHaveLength(21);
        expect(lanes.filter((l) => l === 'accepted' || l === 'repealed')).toHaveLength(6);
        expect(lanes.indexOf('boundary')).toBeGreaterThan(lanes.lastIndexOf('repealed'));
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

/**
 * Boundaries and contracts read from the Acme pack's headers (`__fixtures__`),
 * and the map drawn from them. Pure: no database.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { layoutMap, seamLabel, type MapBoundary, type MapContract } from '@onmyradar/contract';
import {
  ADR_HEADERS,
  COMPONENT_H1S,
  COMPONENT_SECTIONS,
  CONTRACT_HEADERS,
} from '../__fixtures__/acme-architecture.js';
import {
  EVERY_MODULE,
  parseAmends,
  parseComponent,
  parseContract,
  type ParsedBoundary,
  type ParsedContract,
} from './architecture-import.js';

const contract = (slug: string): ParsedContract | null => {
  const [h1, status] = CONTRACT_HEADERS[slug] ?? ['', ''];
  return parseContract(slug, `${h1}\n\n${status}\n`);
};
const component = (slug: string): ParsedBoundary =>
  parseComponent(slug, COMPONENT_SECTIONS[slug] ?? `${COMPONENT_H1S[slug] ?? ''}\n`);

describe('what a contract’s Status line says', () => {
  // [slug, side a, side b]: all 27 of the Acme pack's, pinned.
  const TABLE: Array<[string, string | null, object | null]> = [
    ['capability-manifest', null, null],
    ['capacity', 'M3', { ref: 'M1' }],
    ['checks', 'M9', { ref: 'C4' }],
    ['cdn', 'M5', { external: 'Edge CDN' }],
    ['commands', 'C3', { ref: 'C1' }],
    ['email', 'M10', { external: 'Transactional email' }],
    ['events', 'C8', { ref: 'C4' }],
    ['secrets-sync', 'M6', { external: 'Secrets sync operator' }],
    ['build-ci', 'C1', { external: 'Build CI → Acme' }],
    ['git-host', 'M4', { external: 'Git host API' }],
    ['gitops', 'M4', { external: 'Deployment repository layout and agent' }],
    ['registry', 'M4', { external: 'Image registry' }],
    ['platform', 'M4', { external: 'Container platform' }],
    ['mcp', 'C1', { external: 'MCP task tools' }],
    ['secret-store', 'M6', { external: 'Secret store' }],
    ['operator-api', 'C1', { ref: 'slug:ui' }],
    ['plugin-hosts', 'M11', { external: 'Shared plugin hosts' }],
    ['policy', 'C5', { ref: 'C3' }],
    ['portal', 'C1', { external: 'Acme portal' }],
    ['ports', 'A*', { everyModule: true }],
    ['registrar', 'M5', { external: 'Domain registrar' }],
    ['renderer', 'M4', { everyModule: true }],
    ['search', 'M1', { external: 'Search index' }],
    ['run-engine', 'C6', { ref: 'C3' }],
    ['notes-chart', 'M4', { external: 'notes-site Helm chart' }],
    ['step-spi', 'C6', { everyModule: true }],
    ['stripe', 'M8', { external: 'Stripe' }],
  ];

  it.each(TABLE)('%s', (slug, a, b) => {
    const parsed = contract(slug);
    expect(parsed ? parsed.a : null).toBe(a);
    expect(parsed ? parsed.b : null).toEqual(b);
  });

  it('covers every contract, skips the one with no component of ours, and keeps 16 external names distinct', () => {
    expect(TABLE.map(([slug]) => slug).sort()).toEqual(Object.keys(CONTRACT_HEADERS).sort());
    const externals = TABLE.flatMap(([, , b]) => (b && 'external' in b ? [b] : []));
    expect(new Set(externals.map((b) => (b as { external: string }).external)).size).toBe(16);
    expect(contract('capability-manifest')).toBeNull();
    expect(EVERY_MODULE).toBe('Every module');
  });

  it('reads the version and the full title', () => {
    expect(contract('search')).toMatchObject({ version: '1.2', title: 'Search index' });
    expect(contract('capacity')?.version).toBe('0.2');
    expect(contract('cdn')?.title).toBe(
      'Edge CDN (zones, DNS, load balancers, custom hostnames, rules, cache)',
    );
  });
});

describe('what a component says', () => {
  it('takes its code and title from the H1, including Adapters and the code-less Admin UI', () => {
    expect(component('billing')).toMatchObject({ code: 'M8', title: 'M8 Billing' });
    expect(component('adapters')).toMatchObject({ code: 'A*', title: 'Adapters and fakes (A*)' });
    expect(component('ui')).toMatchObject({ code: null, title: 'Admin UI' });
    expect(Object.keys(COMPONENT_H1S)).toHaveLength(23);
  });

  it('owns the first backticked cell of each §2 row, and nothing when §2 says None', () => {
    expect(component('billing').owns).toEqual([
      'billing.billing_links',
      'billing.billing_observations',
      'billing.link_history',
      'billing.plan_revisions',
      'billing.entitlements',
      'billing.identity_tombstones',
      'billing.observation_hints',
      'billing.checkout_sessions',
      'billing.purchases',
    ]);
    expect(component('adapters').owns).toEqual([]);
    expect(component('ui').owns).toEqual([]);
    expect(component('billing').body).toMatch(/^# Component: M8 Billing\n[\s\S]*## 2\. Owned data/);
    expect(component('billing').body).toMatch(
      /\n\nSource: docs\/architecture\/components\/billing\.md$/,
    );
  });
});

describe('what an ADR amends', () => {
  it('names the components and contracts of ADR-0026, and says what ADR-0027 names that is not one', () => {
    expect(parseAmends(ADR_HEADERS['0026'][1])).toEqual({
      files: ['components/health', 'contracts/checks', 'components/delivery', 'components/ui'],
      other: [],
    });
    expect(parseAmends(ADR_HEADERS['0027'][1])).toEqual({
      files: ['components/billing', 'contracts/portal'],
      other: ['ADR-0024', 'ADR-0026', '`plan/slices-1-2.md` A4'],
    });
    // "amends the global secrets standard" is prose, not a link.
    expect(parseAmends(ADR_HEADERS['0021'][1])).toEqual({ files: [], other: [] });
  });
});

describe('the map', () => {
  /** The Acme pack as the importer sees it: 24 boundaries inside, 16 outside, 26 contracts. */
  const real = () => {
    const parts = Object.keys(COMPONENT_H1S).map(component);
    const byRef = new Map(
      parts.flatMap((p) => [
        [p.slug, p.slug] as const,
        ...(p.code ? [[p.code, p.slug] as const] : []),
      ]),
    );
    const boundaries: MapBoundary[] = parts.map((p) => ({
      id: p.slug,
      title: p.title,
      external: false,
    }));
    const named = new Set<string>();
    const contracts: MapContract[] = [];
    for (const slug of Object.keys(CONTRACT_HEADERS)) {
      const c = contract(slug);
      if (!c) continue;
      const side = (name: string, external: boolean) => {
        if (!named.has(name)) boundaries.push({ id: `ext:${name}`, title: name, external });
        named.add(name);
        return `ext:${name}`;
      };
      const b =
        'ref' in c.b
          ? (byRef.get(c.b.ref.replace(/^slug:/, '')) ?? c.b.ref)
          : 'external' in c.b
            ? side(c.b.external, true)
            : side(EVERY_MODULE, false);
      contracts.push({ id: slug, title: c.title, version: c.version, a: byRef.get(c.a) ?? c.a, b });
    }
    return { boundaries, contracts };
  };
  const shuffled = <T>(list: readonly T[], seed: number): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  const touches = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('draws the same picture whatever order the input arrives in', () => {
    const { boundaries, contracts } = real();
    expect(boundaries).toHaveLength(40);
    expect(contracts).toHaveLength(26);
    const first = JSON.stringify(layoutMap(boundaries, contracts));
    for (const seed of [1, 2, 3])
      expect(JSON.stringify(layoutMap(shuffled(boundaries, seed), shuffled(contracts, seed)))).toBe(
        first,
      );
  });

  it('draws the default layout exactly as before (the iOS port checks these numbers)', () => {
    const { boundaries, contracts } = real();
    const json = JSON.stringify(layoutMap(boundaries, contracts));
    expect(createHash('sha256').update(json).digest('hex')).toBe(
      '34365418aa564ccd0f5c7e8d87ebecaf684a1410026c34607db3a8a62ba32aa5',
    );
  });

  it('fits the drawing to a box when it is given its aspect, without breaking any rule above', () => {
    const { boundaries, contracts } = real();
    const same = JSON.stringify(layoutMap(boundaries, contracts, { aspect: 1.4 }));
    for (const seed of [1, 2, 3])
      expect(
        JSON.stringify(
          layoutMap(shuffled(boundaries, seed), shuffled(contracts, seed), { aspect: 1.4 }),
        ),
      ).toBe(same);
    for (const aspect of [0.8, 1.4, 1.6, 2.4]) {
      const map = layoutMap(boundaries, contracts, { aspect });
      const everything = [...map.boxes, ...map.seams.map((s) => s.pill)];
      for (const [i, one] of everything.entries()) {
        expect(one.x).toBeGreaterThanOrEqual(0);
        expect(one.x + one.w).toBeLessThanOrEqual(map.width);
        expect(one.y).toBeGreaterThanOrEqual(0);
        expect(one.y + one.h).toBeLessThanOrEqual(map.height);
        for (const other of everything.slice(i + 1))
          expect(touches(one, other), `aspect ${aspect}`).toBe(false);
      }
      for (const box of map.boxes) expect(touches(box, map.frame)).toBe(!box.external);
      expect(map.seams).toHaveLength(26);
    }
  });

  it('makes a drawing of this size about as wide as it is tall for a box that is, and reads at scale', () => {
    const { boundaries, contracts } = real();
    expect(boundaries.filter((b) => !b.external)).toHaveLength(24);
    expect(boundaries.filter((b) => b.external)).toHaveLength(16);
    const fixed = layoutMap(boundaries, contracts);
    expect(fixed.width / fixed.height).toBeGreaterThan(2.5);
    const map = layoutMap(boundaries, contracts, { aspect: 1.4 });
    expect(map.width / map.height).toBeGreaterThan(1.2);
    expect(map.width / map.height).toBeLessThan(1.7);
    // The box at 1440x900 is about 810x570: 12px labels draw at 9px or more.
    expect(Math.min(810 / map.width, 570 / map.height)).toBeGreaterThanOrEqual(0.75);
    // A wider box (1920x1080) reads larger still.
    const wide = layoutMap(boundaries, contracts, { aspect: 1190 / 750 });
    expect(Math.min(1190 / wide.width, 750 / wide.height)).toBeGreaterThanOrEqual(0.9);
  });

  it('reads at scale whatever the ids are (the app’s are uuids, which break ties differently)', () => {
    const { boundaries, contracts } = real();
    const opaque = (id: string) => createHash('sha1').update(id).digest('hex');
    const bs = boundaries.map((b) => ({ ...b, id: opaque(b.id) }));
    const cs = contracts.map((c) => ({ ...c, id: opaque(c.id), a: opaque(c.a), b: opaque(c.b) }));
    const map = layoutMap(bs, cs, { aspect: 1.4 });
    expect(Math.min(810 / map.width, 570 / map.height)).toBeGreaterThanOrEqual(0.75);
    const everything = [...map.boxes, ...map.seams.map((x) => x.pill)];
    for (const [i, one] of everything.entries())
      for (const other of everything.slice(i + 1)) expect(touches(one, other)).toBe(false);
  });

  it('ignores an aspect that is not a positive number', () => {
    const { boundaries, contracts } = real();
    const fixed = JSON.stringify(layoutMap(boundaries, contracts));
    for (const aspect of [0, -1, Number.NaN, Infinity])
      expect(JSON.stringify(layoutMap(boundaries, contracts, { aspect }))).toBe(fixed);
    expect(layoutMap([], [], { aspect: 1.4 }).boxes).toEqual([]);
  });

  it('puts no box on another box and no pill on a box or another pill, inside the canvas', () => {
    const { boundaries, contracts } = real();
    const map = layoutMap(boundaries, contracts);
    const everything = [...map.boxes, ...map.seams.map((s) => s.pill)];
    for (const [i, one] of everything.entries()) {
      expect(one.x).toBeGreaterThanOrEqual(0);
      expect(one.y).toBeGreaterThanOrEqual(0);
      expect(one.x + one.w).toBeLessThanOrEqual(map.width);
      expect(one.y + one.h).toBeLessThanOrEqual(map.height);
      for (const other of everything.slice(i + 1)) expect(touches(one, other)).toBe(false);
    }
    expect(map.seams).toHaveLength(26);
  });

  it('keeps our boundaries inside the frame and external systems outside it', () => {
    const { boundaries, contracts } = real();
    const map = layoutMap(boundaries, contracts);
    for (const box of map.boxes) expect(touches(box, map.frame)).toBe(!box.external);
    // A seam to an outside system is flagged, an internal one is not.
    expect(map.seams.filter((s) => s.external)).toHaveLength(16);
  });

  it('copes with nothing, and with a boundary that has no seams', () => {
    expect(layoutMap([], []).boxes).toEqual([]);
    const lone = layoutMap(
      [
        { id: 'a', title: 'A', external: false },
        { id: 'x', title: 'X', external: true },
      ],
      [],
    );
    expect(lone.boxes.map((b) => b.id)).toEqual(['a', 'x']);
  });

  it('labels a seam with the start of its title, not its parenthetical', () => {
    expect(seamLabel({ title: 'Cloudflare (zones, DNS, load balancers)' })).toBe('Cloudflare');
    expect(seamLabel({ title: 'Shared-delivery platform apps (Roving Express)' })).toBe(
      'Shared-delivery…',
    );
  });
});

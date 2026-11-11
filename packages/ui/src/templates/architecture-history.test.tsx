// @vitest-environment jsdom
/**
 * The charter's history from the page (plan e715ea20, U3): the panel, a version read in the
 * document's place, a comparison, a deep link, and a restore. The server is mocked at `api`; the
 * viewer is a recorder, so what the page asks it to draw (the version's words, the changes, the
 * flashed passage) is what is asserted. The viewer's own placement of marks is tested on the real
 * editor in `lib/milkdown-history.test.ts`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ArchitectureDto,
  CharterDiffDto,
  CharterOrphanDto,
  CharterVersionDto,
  CharterVersionsDto,
  RadarDto,
  RestoreCharterResult,
} from '@onmyradar/contract';
import { ToastHost } from '../components/primitives';
import { ApiError, api } from '../lib/api';
import { must } from '../lib/must';
import { DESKTOP_QUERY, WIDE_QUERY } from '../lib/viewport';
import { SessionProvider } from '../lib/session';
import { fakeMilkdown } from '../lib/milkdown-fake';
import type { ViewerMarks } from '../lib/milkdown-history';
import { ArchitectureView } from './architecture';
import { LinkActionsProvider, LinkedSections, type LinkActions } from './architecture-links';
import { OrphanTray } from './architecture-orphans';

vi.mock('../lib/milkdown', async () => (await import('../lib/milkdown-fake')).fakeMilkdown);
void fakeMilkdown;

/** A viewer that records what the page opened it on and what it was told to draw. */
const viewers = vi.hoisted(() => ({
  made: [] as Array<{
    markdown: string;
    marks: ViewerMarks[];
    scrolled: unknown[];
    destroyed: boolean;
  }>,
}));
vi.mock('../lib/milkdown-history', () => ({
  createViewer: (_root: HTMLElement, markdown: string) => {
    const entry = {
      markdown,
      marks: [] as ViewerMarks[],
      scrolled: [] as unknown[],
      destroyed: false,
    };
    viewers.made.push(entry);
    return Promise.resolve({
      text: () => markdown,
      setMarks: (marks: ViewerMarks) => entry.marks.push(marks),
      scrollTo: (target: unknown) => {
        entry.scrolled.push(target);
        return true;
      },
      destroy: () => {
        entry.destroyed = true;
        return Promise.resolve();
      },
    });
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ME = '99999999-9999-4999-8999-999999999999';
const ANCHOR = 'a1111111-1111-4111-8111-111111111111';
const LINK = 'b2222222-2222-4222-8222-222222222222';

const TEXT_NOW = '# Principles\n\nBilling owns every billing decision, and Stripe only reports.';
const TEXT_V4 = '# Principles\n\nBilling owns all billing truth, and Stripe only reports.';

const person = (name: string) => ({ kind: 'person' as const, id: 'u1', name });
const version = (
  n: number,
  extra: Partial<CharterVersionDto> & { why?: string } = {},
): CharterVersionDto => ({
  version: n,
  createdAt: new Date(Date.now() - n * 3_600_000).toISOString(),
  cause: 'edit',
  label: `v${n} · edit · Lucas`,
  note: null,
  by: person('Lucas'),
  via: null,
  subject: null,
  ...extra,
});
const VERSIONS: CharterVersionDto[] = [
  version(7, { cause: 'restore', restoredFrom: 3, note: 'Restored version 3' }),
  version(6, {
    by: { kind: 'agent', id: 'ag1', name: 'Scout', onBehalfOf: 'Lucas', handle: 'scout' },
  }),
  version(5, {
    cause: 'adr',
    lane: 'accepted',
    subject: { id: 'adr1', label: 'ADR-0027', lane: 'proposed' },
  }),
  version(4, {
    cause: 'adr',
    lane: 'proposed',
    subject: { id: 'adr1', label: 'ADR-0027', lane: 'accepted' },
  }),
  version(3),
  version(2, { cause: 'migration' }),
];
const list = (versions: CharterVersionDto[] = VERSIONS, unsealed = false): CharterVersionsDto => ({
  versions,
  nextCursor: null,
  head: { revision: 9, version: versions[0]?.version ?? 0, unsealed },
});

const arch = (markdown: string, extra: Partial<ArchitectureDto> = {}): ArchitectureDto => ({
  radar: { id: 'r', name: 'Arch' },
  charter: [{ id: 'r', title: 'Charter', markdown }],
  boundaries: [],
  contracts: [],
  adrs: [],
  revision: 9,
  charterVersion: 7,
  ...extra,
});
const diffOf = (count: number, over: Partial<CharterDiffDto> = {}): CharterDiffDto => ({
  from: { version: 4 },
  to: { version: 'head' },
  identical: false,
  exact: true,
  truncated: false,
  stats: { hunks: count, struckChars: 0, insertedChars: 0 },
  hunks: Array.from({ length: count }, (_, i) => ({
    section: ['Principles'],
    struck: { start: 20 + i, end: 21 + i, text: 'x' },
    inserted: null,
  })),
  ...over,
});

let host: HTMLElement;
let root: Root;
const viewport = (desktop: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop && (query === DESKTOP_QUERY || query === WIDE_QUERY),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
beforeEach(() => {
  viewers.made.length = 0;
  viewport(true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const access = (over: Partial<RadarDto['access']> = {}): RadarDto['access'] => ({
  role: 'owner',
  canRead: true,
  canWrite: true,
  canManage: true,
  viaPublicLink: false,
  via: null,
  directRole: 'owner',
  topicRole: null,
  ...over,
});
const changed = vi.fn();
async function show(
  options: { access?: Partial<RadarDto['access']>; head?: ArchitectureDto } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.radars, 'architecture').mockResolvedValue(options.head ?? arch(TEXT_NOW));
  vi.spyOn(api.auth, 'session').mockResolvedValue({ user: { id: ME } } as never);
  const radar = {
    id: 'r',
    template: 'architecture',
    commentsEnabled: true,
    access: access(options.access),
  } as RadarDto;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <ToastHost />
          <ArchitectureView
            radar={radar}
            blips={[]}
            readOnly={!radar.access.canWrite}
            loading={false}
            loadingMore={false}
            hasMore={false}
            onLoadMore={vi.fn()}
            onChanged={changed}
            emptyTitle="Nothing on this radar yet"
            emptyHint="Type in the box above"
          />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  await tick();
  return client;
}
/** Let the queries and the viewer's dynamic import land (a few turns, each with its renders). */
const tick = async () => {
  for (let turn = 0; turn < 10; turn += 1)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
};
const find = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLElement>('button, a')].find((b) =>
    b.textContent.trim().startsWith(label),
  );
const press = async (label: string, scope: ParentNode = document) => {
  const target = must(find(label, scope), label);
  await act(async () => target.click());
  await tick();
};
const row = (n: number) =>
  must(document.querySelector<HTMLElement>(`button[aria-label^="Version ${n}:"]`), `v${n}`);
const pick = async (n: number) => {
  const target = row(n);
  await act(async () => target.click());
  await tick();
};
const text = () => document.body.textContent;
const key = (name: string) =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });

function serve(over: { head?: CharterVersionsDto } = {}) {
  vi.spyOn(api.radars, 'charterVersions').mockResolvedValue(over.head ?? list());
  const at = vi.spyOn(api.radars, 'architectureAt').mockImplementation(async (_id, v, anchor) => ({
    ...arch(TEXT_V4, {
      asOf: VERSIONS.find((x) => x.version === v) ?? version(v),
      readOnly: true,
    }),
    ...(anchor
      ? {
          highlight: {
            anchorId: anchor,
            state: 'anchored' as const,
            quote: 'all billing truth',
            start: 20,
            end: 37,
            sourceStart: 20,
            sourceEnd: 37,
          },
        }
      : {}),
  }));
  return { at };
}

it('credits the migration seed to the migration, not to "someone"', async () => {
  serve({
    head: list([
      version(3),
      version(1, { cause: 'migration', by: { kind: 'person', id: null, name: null } }),
    ]),
  });
  await show();
  await press('History');
  expect(row(1).querySelector('.chist-who')?.textContent).toBe('Migration');
  expect(row(1).getAttribute('aria-label')).toContain('Migration');
  expect(text()).not.toContain('someone');
});

it('lists versions newest first: who (an agent badged), when, and why', async () => {
  serve();
  await show();
  await press('History');
  const rows = [...document.querySelectorAll('.chist-row')].map((r) => r.textContent);
  expect(rows[0]).toContain('Current charter');
  expect(rows[1]).toContain('v7');
  expect(rows[1]).toContain('Restored from v3');
  expect(rows[2]).toContain('v6');
  expect(rows[2]).toContain('Scout');
  expect(rows[2]).toContain('Agent');
  expect(rows[3]).toContain('Accepted ADR-0027');
  expect(rows[4]).toContain('Proposed ADR-0027');
  expect(rows[5]).toContain('v3');
  expect(rows[5]).toContain('Edited');
  expect(rows[6]).toContain('Migrated');
  expect(rows[1]).toMatch(/\d+ h ago/);
  // a person is not badged
  expect(rows[5]).not.toContain('Agent');
  expect(row(3).title).toBe('v3 · edit · Lucas');
});

it('is not there for a reader who came by the public link', async () => {
  const listed = vi.spyOn(api.radars, 'charterVersions').mockResolvedValue(list());
  await show({ access: { viaPublicLink: true, canWrite: false } });
  expect(find('History')).toBeUndefined();
  expect(listed).not.toHaveBeenCalled();
});

it('closes on Esc, and an open dialog has the key first', async () => {
  serve();
  await show();
  await press('History');
  expect(document.querySelector('.side-panel')).not.toBeNull();
  await key('Escape');
  expect(document.querySelector('.side-panel')).toBeNull();
});

it('reads a version in the document place, with its banner, and the editor is off', async () => {
  const { at } = serve();
  await show();
  await press('History');
  await press('', row(4).parentElement as HTMLElement);
  expect(at).toHaveBeenCalledWith('r', 4, undefined);
  const banner = must(document.querySelector('.chist-banner'));
  expect(banner.textContent).toMatch(/Viewing version 4/);
  expect(banner.textContent).toContain(' by Lucas');
  expect(banner.textContent).toContain('Proposed ADR-0027');
  for (const action of ['Back to current', 'Compare with current', 'Restore this version'])
    expect(find(action, banner)).toBeDefined();
  // nothing to edit or propose against old text
  expect(find('Edit charter')).toBeUndefined();
  expect(find('Propose ADR')).toBeUndefined();
  expect(find('Reading history', document)).toBeUndefined();
  expect(text()).toContain('Reading history');
  // the version's own words, in the viewer
  expect(viewers.made.at(-1)?.markdown).toBe(TEXT_V4);
  expect(window.location.search).toContain('version=4');
  await press('Back to current');
  expect(document.querySelector('.chist-banner')).toBeNull();
  expect(find('Edit charter')).toBeDefined();
  expect(window.location.search).not.toContain('version=');
});

it('closes the sheet on Esc even while focus is still on the button that opened it', async () => {
  viewport(false);
  serve();
  await show();
  await press('History');
  expect(document.querySelector('[role="dialog"].side-panel')).not.toBeNull();
  await key('Escape');
  expect(document.querySelector('.side-panel')).toBeNull();
  // a dialog over the panel has the key first: the panel stays when the dialog is closed with it
  await press('History');
  await pick(4);
  await press('History');
  await press('Restore this version');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await key('Escape');
  expect(document.querySelector('.side-panel')).not.toBeNull();
});

it('closes the sheet on a phone when a version is picked, so the version is not hidden', async () => {
  viewport(false);
  serve();
  await show();
  await press('History');
  expect(document.querySelector('[role="dialog"].side-panel')).not.toBeNull();
  await pick(4);
  expect(document.querySelector('.side-panel')).toBeNull();
  expect(document.querySelector('.chist-banner')).not.toBeNull();
});

it('compares with the current charter: the count, previous and next, and a note when cut', async () => {
  serve();
  const diff = vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(diffOf(3));
  await show();
  await press('History');
  await pick(4);
  await press('Compare with current');
  expect(diff).toHaveBeenCalledWith('r', 4, 'head');
  expect(document.querySelector('.chist-count')?.textContent).toBe('1 of 3');
  const last = viewers.made.at(-1);
  expect(last?.marks.at(-1)?.changes).toHaveLength(3);
  expect(last?.marks.at(-1)?.current).toBe(0);
  await act(async () =>
    must(document.querySelector<HTMLElement>('button[aria-label="Next change"]')).click(),
  );
  await tick();
  expect(document.querySelector('.chist-count')?.textContent).toBe('2 of 3');
  expect(viewers.made.at(-1)?.scrolled.at(-1)).toEqual({ change: 1 });
  await act(async () =>
    must(document.querySelector<HTMLElement>('button[aria-label="Previous change"]')).click(),
  );
  await act(async () =>
    must(document.querySelector<HTMLElement>('button[aria-label="Previous change"]')).click(),
  );
  // wraps round to the last
  expect(document.querySelector('.chist-count')?.textContent).toBe('3 of 3');
});

it('says when a comparison lists fewer changes than it found', async () => {
  serve();
  vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(
    diffOf(200, { truncated: true, stats: { hunks: 250, struckChars: 0, insertedChars: 0 } }),
  );
  window.history.replaceState(null, '', '/?version=4&compare=head');
  await show();
  await tick();
  expect(text()).toContain('Showing the first 200 of 250 changes.');
});

it('compares any two versions from the banner: From and To', async () => {
  serve();
  const diff = vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(diffOf(1));
  window.history.replaceState(null, '', '/?version=3&compare=6');
  await show();
  await tick();
  expect(diff).toHaveBeenCalledWith('r', 3, 6);
  expect(document.querySelector('[aria-label="Compare from"]')?.textContent).toContain('Version 3');
  expect(document.querySelector('[aria-label="Compare to"]')?.textContent).toContain('Version 6');
  // Both bars say which versions: the banner, and the sticky one that stays in view.
  expect(document.querySelector('.chist-banner')?.textContent).toContain('Comparing v3 → v6');
  expect(document.querySelector('.chist-pair')?.textContent).toBe('v3 → v6');
});

it('retries the other version of a comparison when reading it failed', async () => {
  const { at } = serve();
  vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(diffOf(1));
  window.history.replaceState(null, '', '/?version=3&compare=6');
  // The version being compared against fails once; the page's own version reads.
  const read = at.getMockImplementation();
  at.mockImplementation(async (id, v, anchor) => {
    if (v === 6 && at.mock.calls.filter(([, n]) => n === 6).length === 1)
      throw new ApiError(500, 'internal', 'Boom');
    return must(read)(id, v, anchor);
  });
  await show();
  await tick();
  expect(at.mock.calls.filter(([, n]) => n === 6)).toHaveLength(1);
  expect(text()).toContain('could not be shown');
  await press('Retry');
  expect(at.mock.calls.filter(([, n]) => n === 6)).toHaveLength(2);
  expect(text()).not.toContain('could not be shown');
});

it('labels a comparison with the current charter', async () => {
  serve();
  vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(diffOf(2));
  window.history.replaceState(null, '', '/?version=4&compare=head');
  await show();
  await tick();
  expect(document.querySelector('.chist-banner')?.textContent).toContain('Comparing v4 → current');
  expect(document.querySelector('.chist-pair')?.textContent).toBe('v4 → current');
});

it('draws nothing of a deletion-only comparison on a head it was not made on', async () => {
  serve();
  // The diff was made on revision 10; the page holds revision 9. A deletion leaves no inserted
  // words to check the document against, so the revision is what says the two are not the same.
  const behind = list();
  vi.spyOn(api.radars, 'charterVersions').mockResolvedValue({
    ...behind,
    head: { ...behind.head, revision: 10 },
  });
  vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(diffOf(2, { exact: true }));
  window.history.replaceState(null, '', '/?version=4&compare=head');
  await show();
  const read = vi.mocked(api.radars.architecture);
  await tick();
  expect(viewers.made.flatMap((v) => v.marks).some((m) => m.changes?.length)).toBe(false);
  expect(document.querySelector('.chist-count')?.textContent).toBe('Comparing…');
  // and the page reads the head again rather than trust the one it has
  expect(read.mock.calls.length).toBeGreaterThan(1);
});

it('makes the comparison again when the charter was written while it was being made', async () => {
  serve();
  // The charter is written while the first comparison is made: revision 9, then 10 after it.
  let moved = 0;
  vi.spyOn(api.radars, 'charterVersions').mockImplementation(async () => {
    const base = list();
    const revision = moved === 1 ? 10 : 9;
    if (moved === 1) moved = 2;
    return { ...base, head: { ...base.head, revision } };
  });
  const diff = vi.spyOn(api.radars, 'charterDiff').mockImplementation(async () => {
    if (moved === 0) moved = 1;
    return diffOf(2);
  });
  window.history.replaceState(null, '', '/?version=4&compare=head');
  await show();
  await tick();
  expect(diff).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.chist-count')?.textContent).toBe('1 of 2');
});

it('says so when a version has no words, instead of drawing it forever', async () => {
  serve();
  vi.spyOn(api.radars, 'architectureAt').mockResolvedValue({
    ...arch('', { asOf: version(2), readOnly: true }),
    charter: [],
  });
  window.history.replaceState(null, '', '/?version=2');
  await show();
  await tick();
  expect(text()).toContain('This version was empty');
  expect(text()).not.toContain('Drawing the version');
});

it('keeps History on a cleared charter: that is where it comes back from', async () => {
  serve();
  const cleared = (charterVersion: number) => arch('', { charterVersion, charter: [] });
  await show({ head: cleared(7) });
  expect(text()).toContain('Write the charter');
  await press('History');
  expect(document.querySelectorAll('.chist-row').length).toBeGreaterThan(1);
  await pick(4);
  expect(document.querySelector('.chist-banner')?.textContent).toMatch(/Viewing version 4/);
  // a charter that was never written has nothing to go back to
  await act(async () => root.unmount());
  root = createRoot(host);
  window.history.replaceState(null, '', '/');
  await show({ head: cleared(0) });
  expect(find('History')).toBeUndefined();
});

it('says nothing changed when two versions are the same words', async () => {
  serve();
  vi.spyOn(api.radars, 'charterDiff').mockResolvedValue(
    diffOf(0, {
      identical: true,
      hunks: [],
      stats: { hunks: 0, struckChars: 0, insertedChars: 0 },
    }),
  );
  window.history.replaceState(null, '', '/?version=4&compare=head');
  await show();
  await tick();
  expect(document.querySelector('.chist-count')?.textContent).toBe('No changes');
});

it('opens a deep link on the version and flashes the passage', async () => {
  const { at } = serve();
  window.history.replaceState(null, '', `/?version=4&anchor=${ANCHOR}`);
  await show();
  await tick();
  expect(at).toHaveBeenCalledWith('r', 4, ANCHOR);
  const drawn = viewers.made.at(-1);
  expect(drawn?.marks.at(-1)?.flash).toEqual({ start: 20, end: 37 });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  expect(drawn?.scrolled.at(-1)).toEqual({ flash: true });
});

it('says so when a deep link finds no such version, and offers the way back', async () => {
  vi.spyOn(api.radars, 'charterVersions').mockResolvedValue(list());
  vi.spyOn(api.radars, 'architectureAt').mockRejectedValue(
    new ApiError(404, 'not_found', 'Version not found'),
  );
  window.history.replaceState(null, '', '/?version=99');
  await show();
  await tick();
  expect(must(document.querySelector('.chist-banner')).textContent).toContain(
    'Version 99 could not be opened',
  );
  await press('Back to current');
  expect(document.querySelector('.chist-banner')).toBeNull();
});

it('restores after a confirmation that says nothing is lost; the new version tops the panel and the toast says what healed and orphaned', async () => {
  serve();
  const restored: RestoreCharterResult = {
    revision: 10,
    version: 8,
    changed: true,
    restoredFrom: 4,
    orphaned: [
      {
        anchorId: 'o1',
        kind: 'amend',
        subject: { id: 'adr2', label: 'ADR-0029', lane: 'accepted' },
        quote: 'x',
        cause: 'text_changed',
        resolvedVersion: 7,
        orphanedVersion: 8,
      } as unknown as CharterOrphanDto,
    ],
    healed: [
      {
        anchorId: 'h1',
        kind: 'amend',
        subject: { id: 'adr1', label: 'ADR-0027', lane: 'accepted' },
        quote: 'y',
      } as never,
    ],
    moved: [],
    inertOrphaned: 0,
  };
  const restore = vi.spyOn(api.radars, 'restoreCharter').mockResolvedValue(restored);
  await show();
  await press('History');
  await pick(4);
  await press('Restore this version');
  const dialog = must(document.querySelector('[role="dialog"]'));
  expect(dialog.textContent).toContain('Restore version 4?');
  expect(dialog.textContent).toContain('adds a new version');
  expect(dialog.textContent).toContain('Nothing is lost');
  expect(restore).not.toHaveBeenCalled();
  // the list the panel shows next has the new version at the top
  vi.spyOn(api.radars, 'charterVersions').mockResolvedValue(
    list([version(8, { cause: 'restore', restoredFrom: 4 }), ...VERSIONS]),
  );
  await press('Restore version 4', dialog);
  expect(restore).toHaveBeenCalledWith('r', 4, 9);
  expect(document.querySelector('.chist-banner')).toBeNull();
  const toast = must(document.querySelector('.toast-host')).textContent;
  expect(toast).toContain('Restored version 4 as version 8.');
  expect(toast).toContain('Anchored again: ADR-0027.');
  expect(toast).toContain('Orphaned: ADR-0029.');
  const top = document.querySelectorAll('.chist-row')[1];
  expect(top?.textContent).toContain('v8');
  expect(top?.textContent).toContain('Restored from v4');
  expect(changed).toHaveBeenCalled();
});

it('says the charter changed when a restore is refused as stale', async () => {
  serve();
  vi.spyOn(api.radars, 'restoreCharter').mockRejectedValue(
    new ApiError(409, 'stale', 'The charter changed'),
  );
  window.history.replaceState(null, '', '/?version=4');
  await show();
  await tick();
  await press('Restore this version');
  await press('Restore version 4', must(document.querySelector('[role="dialog"]')));
  expect(must(document.querySelector('.toast-host')).textContent).toContain(
    'changed while you were looking',
  );
});

it('leaves Restore to those who can write', async () => {
  serve();
  window.history.replaceState(null, '', '/?version=4');
  await show({ access: { canWrite: false, role: 'viewer' } });
  await tick();
  expect(find('Compare with current')).toBeDefined();
  expect(find('Restore this version')).toBeUndefined();
});

it('links an orphan to the version that last had its words, and only for a member', async () => {
  const orphan = {
    anchorId: ANCHOR,
    kind: 'amend',
    subject: { id: 'adr1', label: 'ADR-0027', lane: 'accepted' },
    quote: 'all billing truth',
    cause: 'text_changed',
    resolvedVersion: 5,
    orphanedVersion: 6,
  } as unknown as CharterOrphanDto;
  const link = {
    id: LINK,
    element: { id: 'b1', title: 'Billing', kind: 'boundary' as const },
    state: 'orphaned' as const,
    excerpt: 'Stripe only reports',
    section: null,
    resolvedVersion: 3,
  };
  const data = arch(TEXT_NOW, {
    orphans: [orphan, { ...orphan, anchorId: LINK, kind: 'link', resolvedVersion: 3 } as never],
    boundaries: [
      { id: 'b1', title: 'Billing', charter: { links: [LINK], amendedBy: [] } } as never,
    ],
    links: [link],
  });
  const actions = (historyRadarId?: string): LinkActions =>
    ({ canWrite: false, historyRadarId }) as unknown as LinkActions;
  const onPage = document.createElement('div');
  document.body.append(onPage);
  const tray = createRoot(onPage);
  const draw = (historyRadarId?: string) =>
    act(async () =>
      tray.render(
        <LinkActionsProvider value={actions(historyRadarId)}>
          <OrphanTray data={data} />
          <LinkedSections data={data} id="b1" />
        </LinkActionsProvider>,
      ),
    );
  await draw('r');
  const hrefs = [...onPage.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  // An ADR's orphan, a link's orphan in the tray, and the link in the boundary's linked passages.
  expect(hrefs).toEqual([
    `/radar/r?tab=charter&version=5&anchor=${ANCHOR}`,
    `/radar/r?tab=charter&version=3&anchor=${LINK}`,
    `/radar/r?tab=charter&version=3&anchor=${LINK}`,
  ]);
  await draw(undefined);
  expect(find('See it in version', onPage)).toBeUndefined();
  await act(async () => tray.unmount());
  onPage.remove();
});

it('opens the version in place when "See it in version" is pressed on the page', async () => {
  const { at } = serve();
  await show();
  const orphan = {
    anchorId: ANCHOR,
    kind: 'amend',
    subject: { id: 'adr1', label: 'ADR-0027', lane: 'accepted' },
    quote: 'q',
    cause: 'text_changed',
    resolvedVersion: 5,
    orphanedVersion: 6,
  };
  void orphan;
  const { openVersion } = await import('./architecture-history');
  await act(async () => openVersion(5, ANCHOR));
  await tick();
  expect(at).toHaveBeenCalledWith('r', 5, ANCHOR);
  expect(document.querySelector('.chist-banner')?.textContent).toContain('Viewing version 5');
});

// @vitest-environment jsdom
/**
 * Linking the charter to the map, each flow as a person does it: select words and link them
 * (reading and editing), the underline and the popover on a linked passage, the passages listed on
 * a boundary or contract, and the orphan tray with its re-anchor mode.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  projectMarkdown,
  type AnchorActionResult,
  type ArchitectureDto,
  type CharterLinkDto,
  type CharterOrphanDto,
  type RadarDto,
} from '@onmyradar/contract';
import { ToastHost } from '../components/primitives';
import { ApiError, api, type LinkCharterResult } from '../lib/api';
import { DESKTOP_QUERY, WIDE_QUERY } from '../lib/viewport';
import { must, setNativeValue } from '../lib/must';
import { SessionProvider } from '../lib/session';
import { fakeEditors } from '../lib/milkdown-fake';
import { ArchitectureView } from './architecture';

vi.mock('../lib/milkdown', async () => (await import('../lib/milkdown-fake')).fakeMilkdown);
vi.mock('@tanstack/react-router', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ME = '99999999-9999-4999-8999-999999999999';
const B1 = 'b1111111-1111-4111-8111-111111111111';
const B2 = 'b2222222-2222-4222-8222-222222222222';
const X1 = 'c1111111-1111-4111-8111-111111111111';
const C1 = 'd1111111-1111-4111-8111-111111111111';
const ADR = 'a1111111-1111-4111-8111-111111111111';
const T0 = '2026-10-30T12:00:00.000Z';

const MARKDOWN = [
  '# Principles',
  'Billing owns all billing truth. It mirrors Stripe state.',
  'Sites are published by the run engine. Every run is idempotent.',
  '## Credentials',
  'Credentials never rest in Acme. Tokens are read from `Secret store` with the job identity.',
].join('\n\n');
const TEXT = projectMarkdown(MARKDOWN).text;
const at = (quote: string) => {
  const start = TEXT.indexOf(quote);
  return { start, end: start + quote.length };
};
const BILLING = 'Billing owns all billing truth.';
const link = (patch: Partial<CharterLinkDto> = {}): CharterLinkDto => ({
  id: 'l1',
  element: { id: B1, title: 'Billing', kind: 'boundary' },
  state: 'anchored',
  excerpt: BILLING,
  section: ['Principles'],
  resolvedVersion: 3,
  ...at(BILLING),
  ...patch,
});
const base = (patch: Partial<ArchitectureDto> = {}): ArchitectureDto => ({
  radar: { id: 'r', name: 'Arch' },
  revision: 3,
  charterVersion: 4,
  charter: [{ id: 'r', title: 'Charter', updatedAt: T0, markdown: MARKDOWN }],
  adrs: [],
  boundaries: [
    { id: B1, updatedAt: T0, title: 'Billing', external: false, owns: ['plans'], amendedBy: [] },
    { id: B2, updatedAt: T0, title: 'Sites', external: false, owns: [], amendedBy: [] },
    { id: X1, updatedAt: T0, title: 'Stripe', external: true, owns: [], amendedBy: [] },
  ],
  contracts: [
    { id: C1, updatedAt: T0, title: 'Stripe webhooks', version: '1', a: B1, b: X1, amendedBy: [] },
  ],
  ...patch,
});
/** Billing is linked to the first sentence. */
const linked = (): ArchitectureDto => {
  const dto = base({ links: [link()] });
  dto.boundaries[0] = { ...must(dto.boundaries[0]), charter: { state: 'linked', links: ['l1'] } };
  return dto;
};
const orphanLink = (): CharterLinkDto =>
  link({
    id: 'l2',
    state: 'orphaned',
    excerpt: 'Entitlements are checked on every run.',
    cause: 'text_changed',
    orphanedVersion: 5,
    resolvedVersion: 4,
  });
const orphaned = (): ArchitectureDto => {
  const dto = base({
    links: [orphanLink()],
    adrs: [
      {
        id: ADR,
        label: 'ADR-0031',
        title: 'Retry deploys',
        lane: 'proposed',
        ratifiedAt: null,
        supersedes: null,
        supersededBy: null,
        amends: [],
        anchors: [{ pageId: 'r', quote: 'Every run', with: 'Each run', state: 'orphaned' }],
      },
    ],
    orphans: [
      {
        anchorId: 'l2',
        kind: 'link',
        subject: { id: B1, label: 'Billing', lane: null },
        quote: 'Entitlements are checked on every run.',
        cause: 'text_changed',
        resolvedVersion: 4,
        orphanedVersion: 5,
      } satisfies CharterOrphanDto,
      {
        anchorId: 'a1',
        kind: 'amend',
        subject: { id: ADR, label: 'ADR-0031', lane: 'proposed' },
        quote: 'Every run',
        cause: 'text_changed',
        resolvedVersion: 2,
        orphanedVersion: 5,
      } satisfies CharterOrphanDto,
    ],
  });
  dto.boundaries[0] = { ...must(dto.boundaries[0]), charter: { state: 'orphaned', links: ['l2'] } };
  return dto;
};

let host: HTMLElement;
let root: Root;
let client: QueryClient;
const changed = vi.fn();
const highlights = new Map<string, { ranges: Range[] }>();
const viewport = (desktop: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop && (query === DESKTOP_QUERY || query === WIDE_QUERY),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
const RECT = { left: 0, right: 600, top: 0, bottom: 20, width: 600, height: 20 };
const scrolled = vi.fn();
beforeEach(() => {
  fakeEditors.length = 0;
  highlights.clear();
  viewport(true);
  vi.stubGlobal('CSS', {
    highlights,
    escape: (value: string) => value,
    supports: () => false,
  });
  vi.stubGlobal(
    'Highlight',
    class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
  );
  Range.prototype.getBoundingClientRect = () => RECT as DOMRect;
  Range.prototype.getClientRects = () => [RECT] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView = scrolled;
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
  changed.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  window.sessionStorage.clear();
  host.remove();
  window.getSelection()?.removeAllRanges();
  // jsdom has no layout: it has neither of these on a range.
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let served: ArchitectureDto;
async function show(dto: ArchitectureDto, readOnly = false) {
  served = dto;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.radars, 'architecture').mockImplementation(async (_id, _edit, view) => ({
    ...served,
    charter: served.charter,
    ...(view === 'written' ? {} : {}),
  }));
  vi.spyOn(api.auth, 'session').mockResolvedValue({ user: { id: ME } } as never);
  const radar = {
    id: 'r',
    template: 'architecture',
    commentsEnabled: true,
    access: { role: 'owner', canRead: true, canWrite: true, canManage: true, viaPublicLink: false },
  } as RadarDto;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <ToastHost />
          <ArchitectureView
            radar={radar}
            blips={[]}
            readOnly={readOnly}
            loading={false}
            loadingMore={false}
            hasMore={false}
            onLoadMore={vi.fn()}
            onChanged={changed}
            emptyTitle="Nothing"
            emptyHint=""
          />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  await idle(0);
}
const idle = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const bar = () => host.ownerDocument.querySelector('.amend-bar');
const barButton = (label: string) =>
  must(
    [...document.querySelectorAll<HTMLButtonElement>('.amend-bar button')].find(
      (b) => b.textContent === label,
    ),
    label,
  );
const button = (label: string, scope: ParentNode = document) =>
  must(
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label),
    label,
  );
const click = (el: HTMLElement) => act(async () => el.click());
const tab = (label: string) =>
  click(
    must(
      [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((t) =>
        t.textContent.startsWith(label),
      ),
      label,
    ),
  );
const toast = () => document.querySelector('.toast-host')?.textContent ?? '';
const picker = () => must(document.querySelector<HTMLElement>('.link-picker'), 'the picker');
const field = () => must(picker().querySelector<HTMLInputElement>('input'));
const typeInto = (el: HTMLInputElement, value: string) =>
  act(async () => {
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const press = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
const rows = () => [...picker().querySelectorAll('[role=option]')].map((r) => r.textContent);

/** Select `quote` (the nth time it is drawn) inside `scope`, and let the page notice. */
async function select(
  quote: string,
  scope: Element = must(host.querySelector('.arch-pages')),
  nth = 0,
) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let seen = 0;
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    for (let from = text.indexOf(quote); from >= 0; from = text.indexOf(quote, from + 1))
      if (seen++ === nth) {
        range.setStart(node, from);
        range.setEnd(node, from + quote.length);
      }
  }
  expect(seen, quote).toBeGreaterThan(nth);
  const selection = must(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const made = (patch: Partial<LinkCharterResult['element']> = {}): LinkCharterResult => ({
  link: link({ id: 'new1', element: { id: B2, title: 'Sites', kind: 'boundary' } }),
  element: { id: B2, title: 'Sites', kind: 'boundary', created: false, ...patch },
});
const action = (patch: Partial<AnchorActionResult> = {}): AnchorActionResult => ({
  anchorId: 'x',
  kind: 'link',
  subject: { id: B1, label: 'Billing', lane: null },
  state: 'dismissed',
  version: 6,
  was: { state: 'anchored', quote: 'x' },
  quote: 'x',
  ...patch,
});

/* ------------------------------- the toolbar ------------------------------- */

it('offers Link to boundary and Link to contract beside Propose ADR on a selection', async () => {
  await show(base());
  await tab('Charter');
  await select(BILLING);
  const labels = [...document.querySelectorAll('.amend-bar button')].map((b) => b.textContent);
  expect(labels).toEqual(['Show as written to propose', 'Link to boundary…', 'Link to contract…']);
  expect(barButton('Link to boundary…').disabled).toBe(false);
});

it('keeps the links on when an ADR cannot be proposed, and says why in the toolbar', async () => {
  await show(base());
  await click(button('As written'));
  // Across two paragraphs: too much for an ADR, fine for a link.
  const second = 'Sites are published';
  const range = document.createRange();
  const [p1, p2] = [...host.querySelectorAll('.arch-pages p')];
  range.setStart(must(p1?.firstChild), 0);
  range.setEnd(must(p2?.firstChild), second.length);
  const selection = must(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(barButton('Propose ADR').disabled).toBe(true);
  expect(barButton('Link to boundary…').disabled).toBe(false);
  expect(must(document.querySelector('.amend-bar-note')).textContent).toContain(
    'An ADR changes one paragraph',
  );
});

it('turns the links off on code alone, with the reason inside the toolbar', async () => {
  await show(base());
  await select('Secret store');
  expect(barButton('Link to boundary…').disabled).toBe(true);
  expect(barButton('Link to contract…').disabled).toBe(true);
  expect(must(document.querySelector('.amend-bar-note')).textContent).toContain(
    "Code can't be anchored",
  );
});

it('Enter on Cancel is Cancel, not a pick of the highlighted row', async () => {
  await show(base());
  const link_ = vi.spyOn(api.radars, 'linkCharter').mockResolvedValue(made());
  await select('Sites are published by the run engine.');
  await click(barButton('Link to boundary…'));
  const cancel = button('Cancel', picker());
  await press(cancel, 'Enter');
  await idle(0);
  expect(link_).not.toHaveBeenCalled();
});

it('offers nothing to a reader who cannot write', async () => {
  await show(base(), true);
  await select(BILLING);
  expect(bar()).toBeNull();
});

/* -------------------------------- the picker -------------------------------- */

it('links to an existing boundary: type to narrow, Enter picks, the words and their context are sent', async () => {
  await show(base());
  const link_ = vi.spyOn(api.radars, 'linkCharter').mockResolvedValue(made());
  await select('Sites are published by the run engine.');
  await click(barButton('Link to boundary…'));
  // Not a dialog: the toolbar's own box, with nothing over the text and the keyboard in the field.
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(picker().closest('.amend-bar')).not.toBeNull();
  expect(document.activeElement).toBe(field());
  expect(rows()).toEqual(['Billingplans', 'Sites', 'StripeOutside our system']);
  await typeInto(field(), 'sit');
  expect(rows()).toEqual(['Sites', '+ New boundary named “sit”']);
  await press(field(), 'Enter');
  await idle(0);
  expect(link_).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({
      quote: 'Sites are published by the run engine.',
      element: B2,
      prefix: expect.stringContaining('Billing owns') as string,
      suffix: expect.stringMatching(/^Every run is idempotent/) as string,
      idempotencyKey: expect.any(String) as string,
    }),
  );
  expect(toast()).toContain('Linked to Sites');
  expect(document.querySelector('.link-picker')).toBeNull();
  expect(changed).toHaveBeenCalled();
});

it('undoes a link from the toast', async () => {
  await show(base());
  vi.spyOn(api.radars, 'linkCharter').mockResolvedValue(made());
  const dismiss = vi.spyOn(api.anchors, 'dismiss').mockResolvedValue(action());
  const remove = vi.spyOn(api.blips, 'remove').mockResolvedValue(undefined);
  await select(BILLING);
  await click(barButton('Link to boundary…'));
  await press(field(), 'Enter');
  await idle(0);
  await click(must(document.querySelector<HTMLElement>('.toast-undo')));
  await idle(0);
  expect(dismiss).toHaveBeenCalledWith('new1', expect.anything());
  // The element was there before the link: it stays.
  expect(remove).not.toHaveBeenCalled();
});

it('makes a boundary in the same call, and undo takes the boundary back with the link', async () => {
  await show(base());
  const link_ = vi
    .spyOn(api.radars, 'linkCharter')
    .mockResolvedValue(made({ id: 'nb', title: 'Run engine', created: true }));
  const dismiss = vi.spyOn(api.anchors, 'dismiss').mockResolvedValue(action());
  const remove = vi.spyOn(api.blips, 'remove').mockResolvedValue(undefined);
  await select('Sites are published by the run engine.');
  await click(barButton('Link to boundary…'));
  await typeInto(field(), 'Run engine');
  expect(rows()).toEqual(['+ New boundary named “Run engine”']);
  await click(must(picker().querySelector<HTMLElement>('[role=option]')));
  await idle(0);
  expect(link_).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ element: { kind: 'boundary', title: 'Run engine' } }),
  );
  await click(must(document.querySelector<HTMLElement>('.toast-undo')));
  await idle(0);
  expect(dismiss).toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('nb');
});

it('makes a contract by naming it and choosing its two boundaries, one list after the other', async () => {
  await show(base());
  const link_ = vi
    .spyOn(api.radars, 'linkCharter')
    .mockResolvedValue(
      made({ id: 'nc', title: 'Billing and Sites', kind: 'contract', created: true }),
    );
  await select('Sites are published by the run engine.');
  await click(barButton('Link to contract…'));
  expect(rows()).toEqual(['Stripe webhooksStripe webhooks · v1']);
  await typeInto(field(), 'Billing and Sites');
  await press(field(), 'ArrowDown');
  await press(field(), 'Enter');
  // The first boundary, then the second (the first is not offered again).
  expect(field().placeholder).toContain('first boundary');
  await typeInto(field(), 'bill');
  await press(field(), 'Enter');
  expect(field().placeholder).toContain('second boundary');
  expect(rows().some((r) => r.startsWith('Billing'))).toBe(false);
  await typeInto(field(), 'sit');
  await press(field(), 'Enter');
  await idle(0);
  expect(link_).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({
      element: { kind: 'contract', title: 'Billing and Sites', a: B1, b: B2 },
    }),
  );
});

it('cancels on Esc and gives the selection back; nothing is sent', async () => {
  await show(base());
  const link_ = vi.spyOn(api.radars, 'linkCharter');
  await select(BILLING);
  await click(barButton('Link to boundary…'));
  await typeInto(field(), 'bil');
  await press(field(), 'Escape');
  expect(document.querySelector('.link-picker')).toBeNull();
  expect(window.getSelection()?.toString()).toBe(BILLING);
  expect(link_).not.toHaveBeenCalled();
});

it('says in plain words when the words recur, and keeps the picker open', async () => {
  await show(base());
  vi.spyOn(api.radars, 'linkCharter').mockRejectedValue(
    new ApiError(409, 'quote_ambiguous', 'That quote appears more than once.\n1. …'),
  );
  await select(BILLING);
  await click(barButton('Link to boundary…'));
  await press(field(), 'Enter');
  await idle(0);
  expect(must(picker().querySelector('[role=alert]')).textContent).toBe(
    'That text appears more than once in the charter. Select a few more words.',
  );
});

it('links while editing: saves first, then sends the words selected in the editor', async () => {
  await show(base());
  vi.spyOn(api.radars, 'writeCharter').mockResolvedValue({
    revision: 4,
    version: 5,
    changed: true,
    orphaned: [],
    healed: [],
    moved: [],
    inertOrphaned: 0,
  });
  const link_ = vi.spyOn(api.radars, 'linkCharter').mockResolvedValue(made());
  await click(button('Edit charter'));
  await idle(30);
  // The fake editor draws nothing; stand in for ProseMirror's document.
  const prose = document.createElement('div');
  prose.className = 'ProseMirror';
  prose.innerHTML = `<p>${BILLING} It mirrors Stripe state.</p><p>Sites are published by the run engine.</p>`;
  must(document.querySelector('.charter-edit')).append(prose);
  await select(BILLING, prose);
  expect(barButton('Propose ADR').disabled).toBe(true);
  expect(must(document.querySelector('.amend-bar-note')).textContent).toContain('Click Done');
  await click(barButton('Link to boundary…'));
  await typeInto(field(), 'sit');
  await press(field(), 'Enter');
  await idle(0);
  expect(link_).toHaveBeenCalledWith('r', expect.objectContaining({ quote: BILLING, element: B2 }));
});

/* ----------------------- a linked passage in the document ----------------------- */

it('underlines a linked passage without touching the page, boundary and contract apart', async () => {
  const dto = linked();
  dto.links = [
    ...(dto.links ?? []),
    link({
      id: 'l3',
      element: { id: C1, title: 'Stripe webhooks', kind: 'contract' },
      ...at('Every run is idempotent.'),
    }),
  ];
  const html = (await show(dto), must(host.querySelector('.arch-pages')).innerHTML);
  const boundary = must(highlights.get('charter-link-boundary'));
  const contract = must(highlights.get('charter-link-contract'));
  expect(boundary.ranges).toHaveLength(1);
  expect(contract.ranges).toHaveLength(1);
  expect(boundary.ranges[0]?.toString()).toBe(BILLING);
  expect(contract.ranges[0]?.toString()).toBe('Every run is idempotent.');
  expect(must(host.querySelector('.arch-pages')).innerHTML).toBe(html);
});

it('opens a popover on a linked passage with its element, Open in Map and Unlink', async () => {
  await show(linked());
  const page = must(host.querySelector('.arch-pages'));
  await act(async () => {
    page.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  const pop = must(document.querySelector<HTMLElement>('.passage-pop'));
  expect(pop.textContent).toContain('Linked to boundary');
  expect(pop.textContent).toContain('Billing');
  expect(document.querySelector('[role=dialog]')).toBeNull();
  const dismiss = vi.spyOn(api.anchors, 'dismiss').mockResolvedValue(action());
  await click(button('Unlink', pop));
  await idle(0);
  expect(dismiss).toHaveBeenCalledWith('l1', expect.anything());
  expect(toast()).toContain('Unlinked from Billing');
  expect(document.querySelector('.passage-pop')).toBeNull();
});

it('goes to the element in the Map from the popover', async () => {
  await show(linked());
  await act(async () => {
    must(host.querySelector('.arch-pages')).dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
  await click(button('Open in Map'));
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Map');
  expect(must(host.querySelector('.arch-detail h3')).textContent).toBe('Billing');
  expect(document.querySelector('.passage-pop')).toBeNull();
});

it('closes the popover on Escape, and leaves nothing behind when the tab changes', async () => {
  await show(linked());
  const open = () =>
    act(async () => {
      must(host.querySelector('.arch-pages')).dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }),
      );
    });
  await open();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(document.querySelector('.passage-pop')).toBeNull();
  await open();
  await tab('Map');
  expect(document.querySelector('.passage-pop')).toBeNull();
  expect(highlights.get('charter-link-boundary')).toBeUndefined();
});

it('draws links as marks in the editor, and a click on one opens the popover', async () => {
  await show(linked());
  await click(button('Edit charter'));
  await idle(30);
  const drawn = must(must(fakeEditors.at(-1)).anchors());
  expect(drawn.spans).toEqual([
    expect.objectContaining({ ...at(BILLING), link: { ids: ['l1'], kind: 'boundary' } }),
  ]);
  const mark = document.createElement('span');
  mark.className = 'charter-link is-boundary';
  mark.setAttribute('data-links', 'l1');
  mark.textContent = BILLING;
  must(document.querySelector('.charter-edit')).append(mark);
  await click(mark);
  expect(must(document.querySelector('.passage-pop')).textContent).toContain('Billing');
});

/* ---------------------------- the map and the matrix ---------------------------- */

it('lists the linked passages on a boundary in the Map, and Show in charter flashes the words', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(linked());
  const sections = must(host.querySelector('.linked-sections'));
  expect(sections.textContent).toContain('Linked charter text · 1');
  expect(sections.textContent).toContain(BILLING);
  await click(button('Show in charter', sections));
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Charter');
  await idle(0);
  expect(scrolled).toHaveBeenCalled();
  expect(must(highlights.get('charter-flash')).ranges[0]?.toString()).toBe(BILLING);
});

it('shows an orphaned link as removed text, with re-anchor, unlink and the version that had it', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(orphaned());
  const section = must(host.querySelector<HTMLElement>('.linked-section.is-orphan'));
  expect(section.textContent).toContain('Text removed from charter');
  expect(section.textContent).toContain('Entitlements are checked on every run.');
  expect(section.querySelector('a')?.getAttribute('href')).toBe(
    '/radar/r?tab=charter&version=4&anchor=l2',
  );
  expect(section.querySelector('a')?.textContent).toBe('See it in version 4');
  const dismiss = vi.spyOn(api.anchors, 'dismiss').mockResolvedValue(action({ anchorId: 'l2' }));
  await click(button('Unlink', section));
  await idle(0);
  expect(dismiss).toHaveBeenCalledWith('l2', expect.anything());
  await click(button('Re-anchor', section));
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toContain(
    'Charter',
  );
  expect(host.querySelector('.reanchor-banner')?.textContent).toContain(
    'Select the passage that now says this.',
  );
});

it('lists the passages on a contract in the matrix panel too', async () => {
  const dto = linked();
  dto.links = [link({ id: 'l9', element: { id: C1, title: 'Stripe webhooks', kind: 'contract' } })];
  dto.contracts[0] = { ...must(dto.contracts[0]), charter: { state: 'linked', links: ['l9'] } };
  await show(dto);
  await tab('Matrix');
  await click(must(host.querySelector<HTMLElement>('.arch-cell-link')));
  await idle(30);
  expect(document.querySelector('.side-panel')?.textContent).toContain('Linked charter text · 1');
});

/* ------------------------------ orphans and re-anchor ------------------------------ */

it('re-anchors a link: a banner, the selected passage, then Re-anchor here', async () => {
  await show(orphaned());
  const tray = must(host.querySelector<HTMLElement>('.charter-orphans'));
  expect(tray.textContent).toContain('Orphaned · 2');
  await click(button('Re-anchor', must(tray.querySelectorAll<HTMLElement>('.charter-orphan')[0])));
  expect(host.querySelector('.reanchor-banner')?.textContent).toContain('Re-anchoring Billing.');
  expect(host.querySelector('.reanchor-banner')?.textContent).toContain(
    'Select the passage that now says this.',
  );
  const reanchor = vi.spyOn(api.anchors, 'reanchor').mockResolvedValue(
    action({
      anchorId: 'l2',
      state: 'anchored',
      subject: { id: B1, label: 'Billing', lane: null },
    }),
  );
  await select('Sites are published by the run engine.');
  // The toolbar offers one thing now.
  expect([...document.querySelectorAll('.amend-bar button')].map((b) => b.textContent)).toEqual([
    'Re-anchor here',
    'Cancel',
  ]);
  await click(barButton('Re-anchor here'));
  await idle(0);
  expect(reanchor).toHaveBeenCalledWith(
    'l2',
    expect.objectContaining({ quote: 'Sites are published by the run engine.' }),
  );
  expect(host.querySelector('.reanchor-banner')).toBeNull();
  expect(toast()).toContain('Billing is anchored to the new text.');
});

it('cancels re-anchoring from the banner and on Escape', async () => {
  await show(orphaned());
  const card = () => must(host.querySelectorAll<HTMLElement>('.charter-orphan')[0]);
  await click(button('Re-anchor', card()));
  await click(button('Cancel', must(host.querySelector<HTMLElement>('.reanchor-banner'))));
  expect(host.querySelector('.reanchor-banner')).toBeNull();
  await click(button('Re-anchor', card()));
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(host.querySelector('.reanchor-banner')).toBeNull();
});

it('lets an ADR go free-standing and a link be unlinked, from the tray', async () => {
  await show(orphaned());
  const dismiss = vi.spyOn(api.anchors, 'dismiss').mockResolvedValue(action());
  const [linkCard, adrCard] = [...host.querySelectorAll<HTMLElement>('.charter-orphan')];
  expect(button('Unlink', must(linkCard))).toBeTruthy();
  await click(button('Make free-standing', must(adrCard)));
  await idle(0);
  expect(dismiss).toHaveBeenCalledWith('a1', expect.anything());
  await click(button('Unlink', must(linkCard)));
  await idle(0);
  expect(dismiss).toHaveBeenCalledWith('l2', expect.anything());
});

it('links each orphan in the tray to the version that last had its words', async () => {
  await show(orphaned());
  const hrefs = [...host.querySelectorAll('.charter-orphan a')].map((a) => a.getAttribute('href'));
  expect(hrefs).toEqual([
    '/radar/r?tab=charter&version=4&anchor=l2',
    '/radar/r?tab=charter&version=2&anchor=a1',
  ]);
});

it('keeps Accept off for an orphaned ADR, and the tooltip points at re-anchor', async () => {
  await show(orphaned());
  const accept = button('Accept');
  expect(accept.disabled).toBe(true);
  expect(accept.parentElement?.getAttribute('title')).toContain('Re-anchor it');
  expect(
    document.getElementById(must(accept.getAttribute('aria-describedby')))?.textContent,
  ).toContain('make it free-standing');
});

// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  anchorQuote,
  findQuote,
  projectMarkdown,
  quoteProblem,
  replaceMarkers,
  resolveSelection,
  type ArchitectureDto,
  type BlipDto,
  type QuoteMatch,
  type RadarDto,
} from '@onmyradar/contract';
import {
  PAGE_02,
  PAGE_02_ADR_0024,
  PAGE_03,
  PAGE_04,
} from '../../../server/src/__fixtures__/acme-architecture';
import { api } from '../lib/api';
import { DESKTOP_QUERY, WIDE_QUERY } from '../lib/viewport';
import { must, setNativeValue } from '../lib/must';
import { PanelHostProvider, usePanelHost } from '../components/side-panel';
import { AdrPanel, emptyAdrDraft, type AdrDraft } from '../components/adr-panel';
import { fakeEditors } from '../lib/milkdown-fake';
import { ArchitectureView, seenText } from './architecture';
import { keepInReach, laidOut, wrapLabel } from './architecture-map';
import { TemplateView } from './index';
import { StreamView } from './stream';

vi.mock('../lib/milkdown', async () => (await import('../lib/milkdown-fake')).fakeMilkdown);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const page = anchorQuote(
  PAGE_02,
  'all billing truth',
  findQuote([{ id: 'p02', markdown: PAGE_02 }], 'all billing truth') as QuoteMatch,
  { adr: A, with: 'payment truth only' },
);
const adr = (id: string, label: string, lane: string, extra = {}) => ({
  id,
  label,
  title: `${label} title`,
  lane,
  ratifiedAt: lane === 'accepted' ? '2026-10-15T00:00:00.000Z' : null,
  supersedes: null,
  supersededBy: null,
  anchors: [],
  amends: [],
  ...extra,
});
const data = (lane: string): ArchitectureDto => ({
  radar: { id: 'r', name: 'Arch' },
  charter: [{ id: 'p02', title: '02', markdown: page }],
  boundaries: [],
  contracts: [],
  adrs: [
    adr(A, 'ADR-0027', lane, {
      anchors: [{ pageId: 'p02', quote: 'all billing truth', with: 'x' }],
    }),
  ],
});

let host: HTMLElement;
/** The panel with its draft kept the way the charter keeps it. */
function DraftedPanel(
  props: Omit<React.ComponentProps<typeof AdrPanel>, 'radarId' | 'draft' | 'onDraft'>,
) {
  const [draft, setDraft] = useState<AdrDraft>(emptyAdrDraft(props.quote ?? 'free'));
  const panelHost = usePanelHost();
  return (
    <PanelHostProvider value={panelHost.value}>
      <AdrPanel
        radarId="r"
        {...props}
        draft={draft}
        onDraft={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    </PanelHostProvider>
  );
}

let root: Root;
/** jsdom has no media queries: answer the desktop and wide ones (together), and nothing else. */
const viewport = (desktop: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop && (query === DESKTOP_QUERY || query === WIDE_QUERY),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
beforeEach(() => {
  fakeEditors.length = 0;
  viewport(false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState(null, '', '/');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function show(
  lane: string,
  readOnly = false,
  dto: ArchitectureDto = data(lane),
  paging: { blips?: BlipDto[]; hasMore?: boolean; onLoadMore?: () => void } = {},
) {
  vi.spyOn(api.radars, 'architecture').mockResolvedValue(dto);
  const radar = {
    id: 'r',
    template: 'architecture',
    commentsEnabled: true,
    reactionsEnabled: true,
    access: { role: 'owner', canRead: true, canWrite: true, canManage: true, viaPublicLink: false },
  } as RadarDto;
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ArchitectureView
          radar={radar}
          blips={paging.blips ?? []}
          readOnly={readOnly}
          loading={false}
          loadingMore={false}
          hasMore={paging.hasMore ?? false}
          onLoadMore={paging.onLoadMore ?? vi.fn()}
          onChanged={vi.fn()}
          emptyTitle="Empty"
          emptyHint=""
        />
      </QueryClientProvider>,
    ),
  );
  // The charter arrives from the (mocked) query on the next turn.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
const labelled = (label: string) =>
  must(document.querySelector<HTMLElement>(`[aria-label="${label}"]`), label);
const button = (label: string) =>
  must(
    [...document.querySelectorAll('button')].find((b) => b.textContent === label),
    label,
  );
/** A button on the selection toolbar: "Propose ADR" is also the tab bar's. */
const inBar = (label: string) =>
  must(
    [...document.querySelectorAll<HTMLButtonElement>('.amend-bar button')].find(
      (b) => b.textContent === label,
    ),
    label,
  );
/** Type into the open form's Milkdown "Why", and let the form read it. */
const typeWhy = async (text: string) => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => must(fakeEditors.at(-1), 'an open editor').type(text));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
};
const fill = async (field: Element, value: string) =>
  act(async () => {
    setNativeValue(field as HTMLInputElement, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const titleField = () => must(document.querySelector<HTMLInputElement>('input[id$="-title"]'));
const withField = () => must(document.querySelector<HTMLInputElement>('input[id$="-with"]'));
/** A button in the open dialog: "Propose ADR" is also the tab bar's. */
const inDialog = (label: string) =>
  must(
    [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(
      (b) => b.textContent === label,
    ),
    label,
  );

it('toggles between the struck original and the replacement, and keeps the choice in the URL', async () => {
  await show('accepted');
  expect(host.querySelector('.amend-with')?.textContent).toBe('payment truth only');
  await act(async () => button('As written').click());
  expect(host.querySelector('.amend-struck')?.textContent).toBe('all billing truth');
  expect(host.querySelector('.amend-with')).toBeNull();
  expect(window.location.search).toBe('?view=written');
});

it('highlights a proposed ADR and draws a rejected one as plain text', async () => {
  await show('proposed');
  expect(host.querySelector('mark.amend-proposed')?.textContent).toBe('all billing truth');
  await act(async () => root.unmount());
  root = createRoot(host);
  await show('rejected');
  expect(host.querySelector('.arch-pages :is(mark, del, ins)')).toBeNull();
});

it('offers Propose ADR on a selection inside the charter and opens the panel with the quote filled in', async () => {
  await show('accepted');
  await act(async () => button('As written').click());
  const text = must(host.querySelector('.arch-page td:nth-child(3)'));
  const range = document.createRange();
  range.selectNodeContents(text);
  range.getBoundingClientRect = () => ({ left: 10, top: 200, bottom: 220 }) as DOMRect;
  const selection = must(window.getSelection());
  await act(async () => {
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => inBar('Propose ADR').click());
  // The quote is shown as it will read once struck, with what replaces it beside it.
  expect(document.querySelector('.panel-quote del')?.textContent).toBe(text.textContent.trim());
  const propose = vi
    .spyOn(api.radars, 'proposeAdr')
    .mockResolvedValue({ adr: adr(B, 'ADR', 'proposed') });
  await fill(titleField(), 'Payment truth only');
  await fill(withField(), 'payment truth');
  expect(document.querySelector('.panel-quote ins')?.textContent).toBe('payment truth');
  await typeWhy('Plans move to Acme.');
  await act(async () => inDialog('Propose ADR').click());
  const sent = must(propose.mock.calls[0]?.[1]);
  expect(sent).toMatchObject({
    title: 'Payment truth only',
    rationale: 'Plans move to Acme.',
    anchors: [{ quote: text.textContent.trim(), with: 'payment truth' }],
  });
  // The neighbouring cells either side, across the block boundary, to tell it from a twin.
  expect(sent.anchors[0]?.prefix).toMatch(/disputes: all billing truth$/);
  expect(sent.anchors[0]?.suffix).toMatch(/^In · webhook/);
});

it('removes the text when asked to: the replacement is empty and the field is gone', async () => {
  viewport(true);
  await show('accepted');
  await act(async () => button('As written').click());
  const text = must(host.querySelector('.arch-page td:nth-child(3)'));
  const range = document.createRange();
  range.selectNodeContents(text);
  range.getBoundingClientRect = () => ({ left: 10, top: 200, bottom: 220 }) as DOMRect;
  await act(async () => {
    const selection = must(window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => inBar('Propose ADR').click());
  // At desktop width the panel takes the ledger's place in the card, and is not a dialog.
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(must(host.querySelector('.arch-charter')).classList.contains('has-panel')).toBe(true);
  const propose = vi
    .spyOn(api.radars, 'proposeAdr')
    .mockResolvedValue({ adr: adr(B, 'ADR', 'proposed') });
  await act(async () => button('Remove it').click());
  expect(document.querySelector('input[id$="-with"]')).toBeNull();
  expect(document.querySelector('.panel-quote ins')).toBeNull();
  await fill(titleField(), 'Drop it');
  await typeWhy('Not true any more.');
  const panel = must(host.querySelector<HTMLElement>('.side-panel'));
  await act(async () =>
    must(
      [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Propose ADR'),
    ).click(),
  );
  expect(propose).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ anchors: [expect.objectContaining({ with: '' })] }),
  );
});

it('gives a reader who cannot write no Amend bar and no decision buttons', async () => {
  await show('accepted', true);
  expect(host.textContent).not.toContain('Repeal');
  expect(host.querySelector('.amend-bar')).toBeNull();
});

it('draws a layout this build does not know, and a public architecture radar, as the stream', () => {
  const props = { radar: {}, blips: [], readOnly: true, loading: true } as never;
  const unknown = TemplateView({ ...(props as object), layout: 'from-the-future' } as never);
  expect(unknown.type).toBe(StreamView);
  const shared = TemplateView({
    ...(props as object),
    layout: 'architecture',
    publicSlug: 'x',
  } as never);
  expect(shared.type).toBe(StreamView);
});

it('shows what each ADR changes, and opens an accepted one to read its decision', async () => {
  await show('accepted');
  const get = vi
    .spyOn(api.blips, 'get')
    .mockResolvedValue({ blip: { body: '## Decision\nPlans live in Acme.' } } as Awaited<
      ReturnType<typeof api.blips.get>
    >);
  await act(async () => must(host.querySelector<HTMLElement>('.arch-adr-head')).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(get).toHaveBeenCalledWith(A);
  const detail = must(host.querySelector('.arch-adr-detail'));
  expect(detail.querySelector('del')?.textContent).toBe('all billing truth');
  expect(detail.querySelector('ins')?.textContent).toBe('x');
  expect(detail.textContent).toContain('Plans live in Acme.');
});

it('says in plain words when the text is in the charter more than once, and sends nothing', async () => {
  const propose = vi
    .spyOn(api.radars, 'proposeAdr')
    .mockResolvedValue({ adr: adr(B, 'ADR', 'proposed') });
  const shared = 'Everything is read through one service layer';
  const dto: ArchitectureDto = {
    radar: { id: 'r', name: 'Arch' },
    charter: [
      {
        id: 'r',
        title: 'Charter',
        markdown: `# 01\n\n${shared} and nothing else.\n\n# 03\n\n${shared}, always.`,
      },
    ],
    adrs: [],
    boundaries: [],
    contracts: [],
  };
  await act(async () =>
    root.render(
      <DraftedPanel
        quote={shared}
        pageId="r"
        architecture={dto}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    ),
  );
  await fill(titleField(), 'x');
  await act(async () => button('Remove it').click());
  await typeWhy('x');
  await act(async () => inDialog('Propose ADR').click());
  expect(propose).not.toHaveBeenCalled();
  expect(must(document.querySelector('[role=alert]')).textContent).toBe(
    'That text appears 2 times in the charter. Select a longer phrase that appears once.',
  );
  expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-|pageId|\*\*/);
});

/* ------------------------- boundaries, contracts, map, matrix ------------------------- */

const B1 = '33333333-3333-4333-8333-333333333333';
const B2 = '44444444-4444-4444-8444-444444444444';
const X1 = '55555555-5555-4555-8555-555555555555';
const C1 = '66666666-6666-4666-8666-666666666666';
const T0 = '2026-10-30T12:00:00.000Z';
const mapped = (): ArchitectureDto => ({
  radar: { id: 'r', name: 'Arch' },
  charter: [{ id: 'p02', title: '02', markdown: '# 02\n\nBilling owns the plan.' }],
  adrs: [adr(A, 'ADR-0027', 'proposed', { amends: [B1] })],
  boundaries: [
    {
      id: B1,
      updatedAt: T0,
      title: 'M8 Billing',
      external: false,
      owns: ['billing.links'],
      amendedBy: [A],
    },
    { id: B2, updatedAt: T0, title: 'M1 Sites', external: false, owns: [], amendedBy: [] },
    { id: X1, updatedAt: T0, title: 'Stripe', external: true, owns: [], amendedBy: [] },
  ],
  contracts: [
    { id: C1, updatedAt: T0, title: 'Stripe', version: '1.0', a: B1, b: X1, amendedBy: [] },
  ],
});
const tab = async (label: string) => {
  await act(async () =>
    must(
      [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === label),
    ).click(),
  );
};

it('draws the map with a focus panel on a desktop, marks what an ADR amends, and dims the rest', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  expect(host.querySelectorAll('.map-node')).toHaveLength(3);
  expect(host.querySelectorAll('.map-seam')).toHaveLength(1);
  expect(host.querySelector('.map-node .map-badge.is-proposed')).not.toBeNull();
  await act(async () =>
    must(
      [...host.querySelectorAll<SVGElement>('.map-node')].find((n) => n.textContent.includes('M8')),
    ).dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  const panel = must(host.querySelector('.arch-focus')).textContent;
  expect(panel).toContain('billing.links');
  expect(panel).toContain('Stripe v1.0 → Stripe');
  expect(panel).toContain('ADR-0027');
  expect(host.querySelectorAll('.map-node.is-dim')).toHaveLength(1);
  expect(window.location.search).toContain(`focus=${B1}`);
});

it('has no Open map button on a wide screen: the map is already beside its detail', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  expect(
    [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Open map')),
  ).toBe(false);
  expect(host.textContent).not.toContain('Open map');
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(host.querySelector('.arch-seams')).toBeNull();
});

it('puts the detail rail beside the map in one grid, and zooms the drawing in place', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const grid = must(host.querySelector('.arch-mapgrid'));
  expect([...grid.children].map((c) => c.className.split(' ')[0])).toEqual([
    'arch-mapbox',
    'arch-focus',
  ]);
  const box = must(grid.querySelector('.arch-mapbox'));
  expect(box.querySelectorAll('.map-node')).toHaveLength(3);
  expect(box.contains(must(grid.querySelector('.arch-focus')))).toBe(false);
  const zoom = () => must(box.querySelector('[data-zoom]')).getAttribute('data-zoom');
  expect(zoom()).toBe('1.00');
  await act(async () => labelled('Zoom in').click());
  expect(Number(zoom())).toBeGreaterThan(1);
  await act(async () => labelled('Fit to box').click());
  expect(zoom()).toBe('1.00');
});

/* ---------------------- fitting the card, wheel and drag on the map ---------------------- */

const pane = (scope: ParentNode = document) =>
  must(scope.querySelector<HTMLElement>('.arch-pinch'));
const zoomOf = (scope: ParentNode = document) => pane(scope).getAttribute('data-zoom');
const viewBoxOf = (scope: ParentNode = document) =>
  must(pane(scope).querySelector('svg')).getAttribute('viewBox');
const wheel = (target: HTMLElement, init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
/** jsdom has no PointerEvent: a mouse event that carries what React reads from one. */
const pointer = (
  target: Element,
  type: string,
  init: {
    x?: number;
    y?: number;
    buttons?: number;
    to?: Element | null;
    id?: number;
    kind?: 'mouse' | 'touch';
  } = {},
) =>
  act(() => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.x ?? 0,
      clientY: init.y ?? 0,
      buttons: init.buttons ?? 0,
      relatedTarget: init.to ?? null,
    });
    Object.defineProperties(event, {
      pointerId: { value: init.id ?? 1 },
      pointerType: { value: init.kind ?? 'mouse' },
    });
    target.dispatchEvent(event);
  });
const viewParts = (scope: ParentNode = document) =>
  (viewBoxOf(scope) ?? '').split(' ').map(Number) as [number, number, number, number];

it('starts fitting the map to the screen even when the charter arrived before the stream', async () => {
  viewport(true);
  const observed: Element[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(node: Element) {
        observed.push(node);
      }
      disconnect() {}
    },
  );
  // No charter pages, so the Map is the first tab: the fill is wanted from the first render.
  vi.spyOn(api.radars, 'architecture').mockResolvedValue({ ...mapped(), charter: [] });
  const radar = {
    id: 'r',
    template: 'architecture',
    commentsEnabled: true,
    access: { role: 'owner', canRead: true, canWrite: true, canManage: true, viaPublicLink: false },
  } as RadarDto;
  const view = (loading: boolean) => (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ArchitectureView
        radar={radar}
        blips={[]}
        readOnly={false}
        loading={loading}
        loadingMore={false}
        hasMore={false}
        onLoadMore={vi.fn()}
        onChanged={vi.fn()}
        emptyTitle="Empty"
        emptyHint=""
      />
    </QueryClientProvider>
  );
  // The card mounts when the architecture arrives, whatever the stream is doing: it is measured from then.
  await act(async () => root.render(view(true)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const card = must(host.querySelector<HTMLElement>('.arch'));
  expect(card.style.getPropertyValue('--arch-fill')).toMatch(/^\d+px$/);
  expect(observed).toContain(card.parentElement);
});

it('zooms on ctrl or ⌘ and wheel at any width, and says how on a desktop', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  expect(must(host.querySelector('.arch-hint')).textContent).toBe('Pinch or ⌘-scroll to zoom');
  const target = pane();
  const pinch = wheel(target, { deltaY: -100, ctrlKey: true });
  expect(pinch.defaultPrevented).toBe(true);
  const zoomed = Number(zoomOf());
  expect(zoomed).toBeGreaterThan(1);
  const command = wheel(target, { deltaY: -100, metaKey: true });
  expect(command.defaultPrevented).toBe(true);
  expect(Number(zoomOf())).toBeGreaterThan(zoomed);
});

it('pans on a plain wheel over the map on a desktop, where the page does not scroll', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const before = viewBoxOf();
  const plain = wheel(pane(), { deltaY: 120, deltaX: 30 });
  expect(plain.defaultPrevented).toBe(true);
  expect(zoomOf()).toBe('1.00');
  expect(viewBoxOf()).not.toBe(before);
});

it('leaves a plain wheel to the page below 1024, but still zooms on a pinch', async () => {
  await show('accepted', false, mapped());
  await tab('Map');
  await act(async () => button('Open map').click());
  const dialog = must(document.querySelector<HTMLElement>('[role=dialog]'));
  expect(dialog.querySelector('.arch-hint')).toBeNull();
  const before = viewBoxOf(dialog);
  const plain = wheel(pane(dialog), { deltaY: 120 });
  expect(plain.defaultPrevented).toBe(false);
  expect(viewBoxOf(dialog)).toBe(before);
  expect(zoomOf(dialog)).toBe('1.00');
  const pinch = wheel(pane(dialog), { deltaY: -100, ctrlKey: true });
  expect(pinch.defaultPrevented).toBe(true);
  expect(Number(zoomOf(dialog))).toBeGreaterThan(1);
});

it('drags the map, and a press released outside it does not leave the next move dragging', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const target = pane();
  const fitted = viewBoxOf();
  // A real drag pans.
  pointer(target, 'pointerdown', { x: 100, y: 100, buttons: 1 });
  pointer(target, 'pointermove', { x: 140, y: 120, buttons: 1 });
  pointer(target, 'pointerup', { x: 140, y: 120 });
  const dragged = viewBoxOf();
  expect(dragged).not.toBe(fitted);
  // Pressed, left the pane and let go out there: no pointerup is heard here. Coming back with
  // nothing held must not carry on dragging.
  pointer(target, 'pointerdown', { x: 100, y: 100, buttons: 1 });
  pointer(target, 'pointerout', { x: 400, y: 400, buttons: 1, to: document.body });
  pointer(target, 'pointermove', { x: 180, y: 160, buttons: 0 });
  pointer(target, 'pointermove', { x: 220, y: 200, buttons: 0 });
  expect(viewBoxOf()).toBe(dragged);
  // Left with nothing held (released while still moving out): the press is over.
  pointer(target, 'pointerdown', { x: 100, y: 100, buttons: 1 });
  pointer(target, 'pointerout', { x: 400, y: 400, buttons: 0, to: document.body });
  pointer(target, 'pointermove', { x: 300, y: 300, buttons: 1 });
  expect(viewBoxOf()).toBe(dragged);
  // A lost capture ends it as well.
  pointer(target, 'pointerdown', { x: 100, y: 100, buttons: 1 });
  pointer(target, 'lostpointercapture', { x: 100, y: 100 });
  pointer(target, 'pointermove', { x: 300, y: 300, buttons: 1 });
  expect(viewBoxOf()).toBe(dragged);
});

it('keeps panning when a finger lands on a box and the drag hands capture to the pane', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const node = must(host.querySelector('.map-node'));
  // The finger is on a box: its implicit capture is the box's. A move past the threshold gives
  // capture to the pane, so the box loses it, and that event bubbles up through the pane.
  pointer(node, 'pointerdown', { x: 100, y: 100, buttons: 1, kind: 'touch' });
  let seen = viewBoxOf();
  let panned = 0;
  for (let i = 1; i <= 12; i += 1) {
    pointer(node, 'pointermove', { x: 100 + i * 12, y: 100 + i * 5, buttons: 1, kind: 'touch' });
    if (i === 1) pointer(node, 'lostpointercapture', { kind: 'touch' });
    if (viewBoxOf() !== seen) panned += 1;
    seen = viewBoxOf();
  }
  // Every move after the first (which only crossed the threshold) moved the drawing.
  expect(panned).toBeGreaterThanOrEqual(11);
  pointer(pane(), 'pointerup', { x: 244, y: 160, kind: 'touch' });
  // The click that ends the drag does not pick the box.
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(window.location.search).not.toContain('focus=');
});

it('still lets go when the pane itself loses the pointer', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  pointer(pane(), 'pointerdown', { x: 100, y: 100, buttons: 1, kind: 'touch' });
  pointer(pane(), 'pointermove', { x: 130, y: 120, buttons: 1, kind: 'touch' });
  pointer(pane(), 'lostpointercapture', { kind: 'touch' });
  const after = viewBoxOf();
  pointer(pane(), 'pointermove', { x: 200, y: 200, buttons: 1, kind: 'touch' });
  expect(viewBoxOf()).toBe(after);
});

it('zooms on a two-finger pinch, with the fingers on boxes', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const [first, second] = [...host.querySelectorAll('.map-node')];
  expect(zoomOf()).toBe('1.00');
  pointer(must(first), 'pointerdown', { x: 150, y: 300, buttons: 1, id: 1, kind: 'touch' });
  pointer(must(second), 'pointerdown', { x: 240, y: 300, buttons: 1, id: 2, kind: 'touch' });
  pointer(must(first), 'pointermove', { x: 100, y: 300, buttons: 1, id: 1, kind: 'touch' });
  pointer(must(second), 'pointermove', { x: 290, y: 300, buttons: 1, id: 2, kind: 'touch' });
  expect(Number(zoomOf())).toBeGreaterThan(1.5);
  pointer(pane(), 'pointerup', { x: 100, y: 300, id: 1, kind: 'touch' });
  pointer(pane(), 'pointerup', { x: 290, y: 300, id: 2, kind: 'touch' });
});

it('selects a box that is tapped without moving', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const node = must(
    [...host.querySelectorAll('.map-node')].find((n) => n.textContent.includes('M1')),
  );
  pointer(node, 'pointerdown', { x: 100, y: 100, buttons: 1, kind: 'touch' });
  pointer(node, 'pointermove', { x: 101, y: 100, buttons: 1, kind: 'touch' });
  pointer(node, 'pointerup', { x: 101, y: 100, kind: 'touch' });
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(window.location.search).toContain(`focus=${B2}`);
});

it('keeps the drawing in reach of the box however it is panned', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  const [w, h] = (pane().getAttribute('data-extent') ?? '').split('x').map(Number) as [
    number,
    number,
  ];
  // In jsdom the box has no size, so the drawing is shown at 1:1 in a box its own size.
  const covered = () => {
    const [x, y, vw, vh] = viewParts();
    const across = Math.max(0, Math.min(x + vw, w) - Math.max(x, 0));
    const down = Math.max(0, Math.min(y + vh, h) - Math.max(y, 0));
    return { across: across / vw, down: down / vh };
  };
  for (let i = 0; i < 20; i += 1) wheel(pane(), { deltaY: 120 });
  expect(covered().down).toBeGreaterThanOrEqual(0.4 - 1e-9);
  for (let i = 0; i < 40; i += 1) wheel(pane(), { deltaY: -120 });
  expect(covered().down).toBeGreaterThanOrEqual(0.4 - 1e-9);
  for (let i = 0; i < 30; i += 1) wheel(pane(), { deltaX: 200 });
  expect(covered().across).toBeGreaterThanOrEqual(0.4 - 1e-9);
  for (let i = 0; i < 60; i += 1) wheel(pane(), { deltaX: -200 });
  expect(covered().across).toBeGreaterThanOrEqual(0.4 - 1e-9);
  // A drag does the same, a long way.
  pointer(pane(), 'pointerdown', { x: 100, y: 100, buttons: 1 });
  for (let i = 1; i <= 30; i += 1)
    pointer(pane(), 'pointermove', { x: 100 + i * 400, y: 100 + i * 400, buttons: 1 });
  pointer(pane(), 'pointerup', { x: 100, y: 100 });
  expect(covered().across).toBeGreaterThanOrEqual(0.4 - 1e-9);
  expect(covered().down).toBeGreaterThanOrEqual(0.4 - 1e-9);
  // Zoomed all the way in, a pan still cannot lose it; and Fit brings back the whole drawing.
  for (let i = 0; i < 12; i += 1) await act(async () => labelled('Zoom in').click());
  for (let i = 0; i < 30; i += 1) wheel(pane(), { deltaY: 400, deltaX: 400 });
  expect(covered().across).toBeGreaterThanOrEqual(0.4 - 1e-9);
  expect(covered().down).toBeGreaterThanOrEqual(0.4 - 1e-9);
  await act(async () => labelled('Fit to box').click());
  expect(zoomOf()).toBe('1.00');
  expect(covered()).toEqual({ across: 1, down: 1 });
});

it('clamps a camera so the drawing keeps 40% of the box, or all of itself when it is smaller', () => {
  const box = { w: 800, h: 600 };
  // Fitted: centred, untouched.
  expect(keepInReach({ k: 1, cx: 400, cy: 300 }, box, 800, 600)).toEqual({
    k: 1,
    cx: 400,
    cy: 300,
  });
  // Far off any side: at least 40% of the box along that axis is still the drawing.
  const low = keepInReach({ k: 1, cx: 400, cy: 9000 }, box, 800, 600);
  expect(low.cy).toBe(600 - 240 + 300);
  expect(keepInReach({ k: 1, cx: 400, cy: -9000 }, box, 800, 600).cy).toBe(240 - 300);
  expect(keepInReach({ k: 1, cx: 9000, cy: 300 }, box, 800, 600).cx).toBe(800 - 320 + 400);
  expect(keepInReach({ k: 1, cx: -9000, cy: 300 }, box, 800, 600).cx).toBe(320 - 400);
  // Zoomed out so the drawing is half the box: it may go until 40% of the box is covered.
  expect(keepInReach({ k: 0.5, cx: 9000, cy: 300 }, box, 800, 600).cx).toBe(800 - 640 + 800);
  // A drawing smaller than 40% of the box on screen is kept whole instead.
  expect(keepInReach({ k: 1, cx: 9000, cy: 300 }, box, 100, 600).cx).toBe(100 - 100 + 400);
  expect(keepInReach({ k: 1, cx: -9000, cy: 300 }, box, 100, 600).cx).toBe(100 - 400);
  // The fitted camera is always inside the range, at any zoom.
  for (const k of [0.25, 0.5, 1, 2, 10])
    expect(keepInReach({ k, cx: 400, cy: 300 }, box, 800, 600)).toEqual({ k, cx: 400, cy: 300 });
});

it('lays the map out once per data and box shape, however often the tab is opened', () => {
  const one = mapped();
  expect(laidOut(one, 1.4)).toBe(laidOut(one, 1.4));
  expect(laidOut(one, null)).toBe(laidOut(one, null));
  expect(laidOut(one, 1.4)).not.toBe(laidOut(one, 0.8));
  expect(laidOut(mapped(), 1.4)).not.toBe(laidOut(one, 1.4));
});

it('says so under Seams, Owns and Amended by when a boundary has none', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Map');
  await act(async () =>
    must(
      [...host.querySelectorAll<SVGElement>('.map-node')].find((n) => n.textContent.includes('M1')),
    ).dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  const panel = must(host.querySelector('.arch-focus'));
  expect(must(panel.querySelector('[aria-label="Seams"]')).textContent).toBe(
    'No contract touches this boundary.',
  );
  expect(must(panel.querySelector('[aria-label="Owns"]')).textContent).toBe('Nothing recorded.');
  expect(must(panel.querySelector('[aria-label="Amended by"]')).textContent).toBe(
    'No ADR amends this.',
  );
});

it('keeps the views in the card’s top bar as a rounded segmented control, and the ledger in a rail', async () => {
  viewport(true);
  await show('accepted');
  const bar = must(host.querySelector('.arch-bar'));
  const tabs = must(bar.querySelector('.segmented[role=tablist]'));
  expect([...tabs.querySelectorAll('[role=tab]')].map((t) => t.textContent)).toEqual([
    'Charter',
    'Map',
    'Matrix',
  ]);
  expect(must(bar.querySelector('[aria-label="Charter text"]')).classList).toContain('segmented');
  const charter = must(host.querySelector('.arch-charter'));
  expect([...charter.children].map((c) => c.className)).toEqual(['arch-doc', 'arch-rail']);
  expect(must(charter.querySelector('.arch-rail')).textContent).toContain('ADR-0027');
});

it('lays every boundary against every other, with an add button in an empty cell and the version in a filled one', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Matrix');
  // Three boundaries by three: the diagonal is hatched, and two outside ones never pair.
  expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(host.querySelectorAll('td.is-self')).toHaveLength(3);
  const empty = [...host.querySelectorAll('td.is-none button')];
  expect(empty.map((b) => b.getAttribute('aria-label'))).toEqual([
    'Add a contract between M8 Billing and M1 Sites',
    'Add a contract between M1 Sites and M8 Billing',
    'Add a contract between M1 Sites and Stripe',
    'Add a contract between Stripe and M1 Sites',
  ]);
  // Both halves of the pair show the contract, as its version.
  expect([...host.querySelectorAll('td.is-hit')].map((c) => c.textContent)).toEqual([
    'v1.0',
    'v1.0',
  ]);
  // The headers are the grid's own sticky ones: a row head and a column head per boundary.
  expect(host.querySelectorAll('thead th[scope=col]')).toHaveLength(4);
  expect(host.querySelectorAll('tbody th[scope=row]')).toHaveLength(3);
});

it('opens the contract between two boundaries in a panel beside the matrix, from an empty cell or a filled one', async () => {
  viewport(true);
  await show('accepted', false, mapped());
  await tab('Matrix');
  const upsert = vi.spyOn(api.radars, 'upsertContract').mockResolvedValue({
    contract: {
      id: 'nc',
      title: 'Plans',
      updatedAt: T0,
      version: '2',
      a: B1,
      b: B2,
      amendedBy: [],
    },
    created: true,
  });
  await act(async () =>
    must(
      host.querySelector<HTMLElement>(
        '[aria-label="Add a contract between M8 Billing and M1 Sites"]',
      ),
    ).click(),
  );
  // The card stays on the Matrix; the panel is a column of it, with the pair already named.
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Matrix');
  const panel = must(
    host.querySelector<HTMLElement>('.arch-matrixgrid > .side-panel-slot .side-panel'),
  );
  expect([...panel.querySelectorAll('.panel-between .chip')].map((c) => c.textContent)).toEqual([
    'M8 Billing',
    'M1 Sites',
  ]);
  expect(panel.textContent).toContain('What it promises');
  await fill(must(panel.querySelector('input[id$="-name"]')), 'Plans');
  await fill(must(panel.querySelector('input[id$="-version"]')), '2');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => must(fakeEditors.at(-1)).type('Billing reads plans.'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await act(async () =>
    must([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Swap')).click(),
  );
  await act(async () =>
    must(
      [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Create contract'),
    ).click(),
  );
  // Swap turned the two ends round; nothing else was added to what was typed.
  expect(upsert).toHaveBeenCalledWith('r', {
    title: 'Plans',
    version: '2',
    a: B2,
    b: B1,
    body: 'Billing reads plans.',
  });
  expect(host.querySelector('.side-panel')).toBeNull();

  // A filled cell opens the contract that is there, with Remove in the footer.
  await act(async () => must(host.querySelector<HTMLElement>('td.is-hit button')).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const open = must(
    host.querySelector<HTMLElement>('.arch-matrixgrid > .side-panel-slot .side-panel'),
  );
  expect(must(open.querySelector<HTMLInputElement>('input[id$="-name"]')).value).toBe('Stripe');
  expect([...open.querySelectorAll('button')].map((b) => b.textContent)).toContain(
    'Remove contract',
  );
});

it('shows a phone the boundaries as a list that opens onto their seams, and the map one tap away', async () => {
  await show('accepted', false, mapped());
  await tab('Map');
  expect(host.querySelector('.arch-map-svg')).toBeNull();
  const heads = [...host.querySelectorAll<HTMLButtonElement>('.arch-seam-head')];
  expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);
  await act(async () => must(heads[0]).click());
  expect(must(host.querySelector('.arch-seam-row')).textContent).toContain('Stripe v1.0 → Stripe');
  await act(async () => button('Open map').click());
  const dialog = must(document.querySelector('[role=dialog]'));
  expect(dialog.querySelectorAll('.map-node')).toHaveLength(3);
  const zoom = () => must(dialog.querySelector('[data-zoom]')).getAttribute('data-zoom');
  const before = zoom();
  await act(async () => labelled('Zoom in').click());
  expect(Number(zoom())).toBeGreaterThan(Number(before));
  await act(async () => button('Close map').click());
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

it('shows one boundary at a time on a phone matrix: its seams and "no seam"', async () => {
  await show('accepted', false, mapped());
  await tab('Matrix');
  const names = [...host.querySelectorAll('.arch-links li')].map((li) => li.textContent);
  expect(names).toEqual(['M1 Sites+ Add a contract', 'Stripev1.0']);
});

const seamAmended = (): ArchitectureDto => {
  const dto = mapped();
  return { ...dto, contracts: dto.contracts.map((c) => ({ ...c, amendedBy: [A] })) };
};
const seamPanel = (where: Element | null) => {
  const text = must(where?.querySelector('.arch-detail')).textContent;
  expect(text).toContain('Contract · v1.0');
  expect(text).toContain('M8 Billing');
  expect(text).toContain('Stripe');
  expect(text).toContain('ADR-0027');
};

it('keeps a seam open on a phone list when it is tapped, with both sides, version and ADRs', async () => {
  await show('accepted', false, seamAmended());
  await tab('Map');
  await act(async () => must(host.querySelector<HTMLButtonElement>('.arch-seam-head')).click());
  await act(async () =>
    must(
      [...host.querySelectorAll('.arch-seam-row .arch-links button')].find((b) =>
        b.textContent.includes('Stripe v1.0'),
      ),
    ).dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  expect(window.location.search).toContain(`focus=${C1}`);
  seamPanel(host.querySelector('.arch-seam-row'));
  // A side leads back to that boundary's own panel.
  await act(async () =>
    must(
      [...host.querySelectorAll<HTMLButtonElement>('.arch-detail button')].find(
        (b) => b.textContent === 'M8 Billing',
      ),
    ).click(),
  );
  expect(must(host.querySelector('.arch-seam-row')).textContent).toContain('billing.links');
});

it('keeps a seam open on a phone matrix for a reader, and the chosen boundary with it', async () => {
  await show('accepted', true, seamAmended());
  await tab('Matrix');
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('.arch-cell-link')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    ),
  );
  seamPanel(host.querySelector('.arch-matrix-one'));
  expect(must(host.querySelector('.select-trigger')).textContent).toContain('M8 Billing');
});

it('lists every Proposed ADR from the architecture response, even when pinned elements fill the stream page', async () => {
  const pinned = Array.from(
    { length: 50 },
    (_, i) => ({ id: `b${i}`, status: 'boundary' }) as unknown as BlipDto,
  );
  const dto = {
    ...data('proposed'),
    adrs: [adr(A, 'ADR-0027', 'proposed'), adr(B, 'ADR-0028', 'proposed')],
  };
  await show('proposed', false, dto, { blips: pinned, hasMore: true });
  const section = must(document.querySelector('section[aria-label=proposed]'));
  expect(section.textContent).not.toContain('None');
  expect(section.querySelectorAll('.arch-open')).toHaveLength(2);
  expect(section.textContent).toContain('ADR-0028');
  expect(section.querySelectorAll('.arch-decide')).toHaveLength(2);

  // A row, closed until it is opened: a card each would make the rail a wall.
  expect(must(section.querySelector('.arch-adr-head')).getAttribute('aria-expanded')).toBe('false');

  // Its text is fetched when the row is opened, with a retry when that fails.
  const get = vi.spyOn(api.blips, 'get').mockRejectedValue(new Error('offline'));
  await act(async () => must(section.querySelector<HTMLElement>('.arch-adr-head')).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(get).toHaveBeenCalledWith(A);
  expect(section.textContent).toContain('Retry');
});

it('wraps a box’s title to two lines before it cuts it', () => {
  expect(wrapLabel('M1 Sites', 20)).toEqual(['M1 Sites']);
  expect(wrapLabel('External Secrets Operator', 18)).toEqual(['External Secrets', 'Operator']);
  expect(wrapLabel('GitOps repository layout and Fleet', 18)).toEqual([
    'GitOps repository',
    'layout and Fleet',
  ]);
  const cut = wrapLabel('Shared-delivery platform apps for every Roving Express site', 18);
  expect(cut).toHaveLength(2);
  expect(cut[1]).toMatch(/…$/);
  expect(wrapLabel('Supercalifragilisticexpialidocious', 12)).toEqual([
    'Supercalifra',
    'gilisticexp…',
  ]);
});

it('draws the Map for a radar that has boundaries but no charter', async () => {
  viewport(true);
  await show('accepted', false, { ...mapped(), charter: [] });
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Map');
  await tab('Charter');
  expect(host.textContent).toContain('No charter yet');
});

it('says so, with a Retry, when an ADR will not load, and when the radar will not', async () => {
  vi.spyOn(api.radars, 'architecture').mockRejectedValueOnce(new Error('down'));
  await show('accepted');
  expect(host.textContent).toContain("Couldn't read this architecture");
  expect(host.querySelector('.arch-page')).toBeNull();
  await act(async () => button('Retry').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(host.querySelector('.arch-page')).not.toBeNull();

  vi.spyOn(api.blips, 'get')
    .mockRejectedValueOnce(new Error('down'))
    .mockResolvedValue({ blip: { body: 'Plans live in Acme.' } } as Awaited<
      ReturnType<typeof api.blips.get>
    >);
  await act(async () => must(host.querySelector<HTMLElement>('.arch-adr-head')).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(host.querySelector('.arch-adr-detail')?.textContent).toContain("Couldn't read this ADR");
  await act(async () => button('Retry').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(host.querySelector('.arch-adr-detail')?.textContent).toContain('Plans live in Acme.');
});

/** Select the nth text occurrence of `quote` in the rendered charter (code included). */
async function selectNth(quote: string, nth: number) {
  const walker = document.createTreeWalker(
    must(host.querySelector('.arch-pages')),
    NodeFilter.SHOW_TEXT,
  );
  let seen = 0;
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1))
      if (seen++ === nth) {
        range.setStart(node, at);
        range.setEnd(node, at + quote.length);
      }
  }
  await selectRange(range);
}
async function selectRange(range: Range) {
  range.getBoundingClientRect = () => ({ left: 10, top: 200, bottom: 220 }) as DOMRect;
  const selection = must(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const showPage = (markdown: string) =>
  show('accepted', false, { ...data('accepted'), charter: [{ id: 'p02', title: '02', markdown }] });

/** Select the nth occurrence of `quote` in the rendered charter, amend it, and return what was sent. */
async function amendFrom(markdown: string, quote: string, nth: number) {
  await showPage(markdown);
  const select = () => selectNth(quote, nth);
  await select();
  expect(host.querySelector('.amend-bar button')?.textContent).toBe('Show as written to propose');
  await act(async () => must(host.querySelector<HTMLElement>('.amend-bar button')).click());
  await select();
  await act(async () => inBar('Propose ADR').click());
  const propose = vi
    .spyOn(api.radars, 'proposeAdr')
    .mockResolvedValue({ adr: adr(B, 'ADR', 'proposed') });
  await fill(titleField(), 'T');
  await fill(withField(), 'R');
  await typeWhy('R');
  await act(async () => inDialog('Propose ADR').click());
  const sent = must(propose.mock.calls[0]?.[1].anchors[0]);
  // What the server will do with it: its own resolver, on the charter's plain text.
  const projection = projectMarkdown(replaceMarkers(markdown, (m) => m.quote));
  const hit = resolveSelection(projection, sent);
  return { sent, hit, projection, markdown };
}

it('sends the words around the quote, so the server picks the selected match, and only offers to amend from As written', async () => {
  const markdown = 'First, the rate is 5 here. Second, the rate is 5 there. Third.';
  const { sent, hit, projection } = await amendFrom(markdown, 'the rate is 5', 1);
  expect(sent).toMatchObject({ quote: 'the rate is 5' });
  expect(sent.prefix).toMatch(/ Second, $/);
  expect(sent.suffix).toMatch(/^ there\./);
  expect(sent).not.toHaveProperty('pageId');
  expect(sent).not.toHaveProperty('occurrence');
  expect(hit).toMatchObject({ ok: true, start: projection.text.lastIndexOf('the rate is 5') });
});

const TWINS = '# One\n\nStatus: Draft\n\n# Two\n\nStatus: Draft';
it.each([
  ['second', 1, 'lastIndexOf'],
  ['first', 0, 'indexOf'],
] as const)(
  'tells the same sentence under two headings apart: the %s one',
  async (_name, nth, find) => {
    const { hit, projection } = await amendFrom(TWINS, 'Status: Draft', nth);
    expect(hit).toMatchObject({ ok: true, start: projection.text[find]('Status: Draft') });
  },
);

it('agrees with the server on a numbered list item, which the source writes as "2. "', async () => {
  const { hit, projection } = await amendFrom('1. Use TLS.\n2. Rotate keys.', 'Use TLS.', 0);
  expect(hit).toMatchObject({ ok: true, start: projection.text.indexOf('Use TLS.') });
});

it('agrees with the server when inline code and a fenced block repeat the phrase, selecting link text after them', async () => {
  const markdown = [
    '1. Use TLS. Always.',
    '2. Never write `Use TLS.` in a config.',
    '```\nUse TLS.\n```',
    '3. Read [Use TLS.](https://example.com/tls) first.',
  ].join('\n\n');
  // The DOM holds four matches and the charter's text three (a fence is not prose): the link text
  // is the last of both, and the words around it say so.
  const { hit, projection } = await amendFrom(markdown, 'Use TLS.', 3);
  expect(hit).toMatchObject({ ok: true, start: projection.text.lastIndexOf('Use TLS.') });
});

it('disables the action on code with the reason inside the toolbar, and anchors a mixed selection on its prose', async () => {
  await showPage('Use `TLS.` always.\n\n```\nUse TLS.\n```\n\nUse TLS. here.');
  await act(async () => button('As written').click());
  const propose = vi.spyOn(api.radars, 'proposeAdr');
  const reason = "Code can't be anchored. Select the sentence around it.";
  const inline = must(host.querySelector('.arch-page p code'));
  const across = document.createRange();
  across.setStart(must(inline.previousSibling), 0);
  across.setEnd(must(inline.firstChild), 4);
  const codeOnly: Array<() => Promise<void>> = [
    () => selectNth('TLS.', 0), // inside the inline code
    () => selectNth('Use TLS.', 0), // inside the fenced block
  ];
  for (const select of codeOnly) {
    await select();
    const bar = must(host.querySelector('.amend-bar'));
    // The action is there and off, and the reason is a line of the same toolbar, not a layer over the text.
    expect(inBar('Propose ADR').disabled).toBe(true);
    expect(must(bar.querySelector('.amend-bar-note')).textContent).toBe(reason);
    expect(inBar('Propose ADR').getAttribute('aria-describedby')).toBe('amend-reason');
    expect(bar.closest('.arch-pages')).toBeNull();
  }
  // Plain text running into code anchors on the prose: "Use", the text before the code.
  await selectRange(across);
  expect(inBar('Propose ADR').disabled).toBe(false);
  expect(must(host.querySelector('.amend-bar-note')).textContent).toContain(
    'Anchored on the text beside the code: Use',
  );
  // The prose after the code is amendable: the only match the server sees.
  await selectNth('Use TLS.', 1);
  expect(inBar('Propose ADR').disabled).toBe(false);
  expect(host.querySelector('.amend-bar-note')).toBeNull();
  expect(propose).not.toHaveBeenCalled();
});

it('sends the longer prose run when a selection holds a sentence, inline code, and more of the sentence', async () => {
  const markdown = 'Static builds read the content token from `Vault` with the CI job identity.';
  await showPage(markdown);
  await act(async () => button('As written').click());
  const text = must(host.querySelector('.arch-page p'));
  const code = must(text.querySelector('code'));
  const range = document.createRange();
  range.setStart(must(text.firstChild), 7);
  range.setEnd(must(text.lastChild), ' with the CI job'.length);
  await selectRange(range);
  await act(async () => inBar('Propose ADR').click());
  expect(document.querySelector('.panel-quote del')?.textContent).toBe(
    'builds read the content token from',
  );
  expect(code.isConnected).toBe(true);
  const propose = vi
    .spyOn(api.radars, 'proposeAdr')
    .mockResolvedValue({ adr: adr(B, 'ADR', 'proposed') });
  await fill(titleField(), 'T');
  await fill(withField(), 'x');
  await typeWhy('R');
  await act(async () => inDialog('Propose ADR').click());
  expect(propose).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({
      anchors: [
        expect.objectContaining({ quote: 'builds read the content token from', with: 'x' }),
      ],
    }),
  );
});

it('refuses a selection that spans formatting rather than anchoring another match', async () => {
  const propose = vi.spyOn(api.radars, 'proposeAdr');
  await showPage('Use **TLS.** here. Use TLS. there.');
  const bold = must(host.querySelector('.arch-page p strong'));
  const across = document.createRange();
  across.setStart(must(bold.parentElement?.firstChild), 0); // "Use " ...
  across.setEnd(must(bold.firstChild), 4); // ... through the bold "TLS."
  await selectRange(across);
  expect(must(host.querySelector('.amend-bar')).textContent).toContain('crosses formatting');
  expect(inBar('Propose ADR').disabled).toBe(true);
  // The plain one is the only literal "Use TLS." and is offered.
  await selectNth('Use TLS.', 0);
  expect(host.querySelector('.amend-bar button')?.textContent).toBe('Show as written to propose');
  expect(propose).not.toHaveBeenCalled();
});

it('does not join the text either side of code into a match', async () => {
  const markdown = 'Use `mandatory `TLS. Use TLS. too.';
  const { hit, projection } = await amendFrom(markdown, 'Use TLS.', 0);
  expect(hit).toMatchObject({ ok: true, start: projection.text.lastIndexOf('Use TLS.') });
});

it('counts every quote in the Acme pages the way the server does', async () => {
  // The charter is one document: the Acme pages, one after the other.
  const charter = [
    { id: 'r', title: 'Charter', markdown: [PAGE_02, PAGE_03, PAGE_04].join('\n\n') },
  ];
  await act(async () => root.unmount());
  root = createRoot(host);
  await show('accepted', false, { ...data('accepted'), charter });
  let checked = 0;
  let code = 0;
  for (const page of host.querySelectorAll<HTMLElement>('[data-page-id]')) {
    const id = must(page.dataset['pageId']);
    const whole = seenText(page);
    // Quotes a reader can select inside one run of text: every two-word phrase of it.
    const phrases = new Set<string>();
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = (node.textContent ?? '').split(/\s+/).filter(Boolean);
      if (node.parentElement?.closest('code, pre')) code += 1;
      else for (let i = 0; i + 1 < words.length; i += 1) phrases.add(`${words[i]} ${words[i + 1]}`);
    }
    for (const quote of phrases) {
      if (quoteProblem(quote)) continue;
      const n = whole.split(quote).length - 1;
      const asked = (seen: number) => findQuote(charter, quote, id, { occurrence: 0, seen });
      const outcome = (seen: number) => {
        const found = asked(seen);
        return 'code' in found ? found.code : 'found';
      };
      expect(outcome(n), quote).not.toMatch(/quote_moved|quote_not_found/);
      expect(outcome(n + 1), quote).toBe('quote_moved');
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(code).toBeGreaterThan(3);
});

it('agrees with the server when a code fence label repeats the phrase', async () => {
  const markdown = '```Use TLS.\ncode\n```\n\nUse TLS. Always.';
  const { hit, projection } = await amendFrom(markdown, 'Use TLS.', 0);
  expect(hit).toMatchObject({ ok: true, start: projection.text.lastIndexOf('Use TLS.') });
});

it('agrees with the server on a cell of the Acme table, naming ADR-0024 in two rows', async () => {
  const markdown = PAGE_02_ADR_0024.join('\n');
  const { hit, projection } = await amendFrom(markdown, 'ADR-0024', 1);
  expect(hit).toMatchObject({ ok: true, start: projection.text.lastIndexOf('ADR-0024') });
});

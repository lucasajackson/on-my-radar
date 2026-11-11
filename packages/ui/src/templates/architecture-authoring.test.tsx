// @vitest-environment jsdom
/**
 * Writing an Architecture radar from the page: an empty one still shows its card and
 * a ledger, each tab says what goes in it and offers the way to fill it, and the
 * charter, the map and the proposal all have a form.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  anchorQuote,
  findQuote,
  replaceMarkers,
  type ArchitectureDto,
  type CharterOrphanDto,
  type QuoteMatch,
  type RadarDto,
  type WriteCharterResult,
} from '@onmyradar/contract';
import { ToastHost } from '../components/primitives';
import { ApiError, api } from '../lib/api';
import { DESKTOP_QUERY, WIDE_QUERY } from '../lib/viewport';
import { must, setNativeValue } from '../lib/must';
import { writeDraft } from '../lib/drafts';
import { SessionProvider } from '../lib/session';
import { fakeEditors, fakeMilkdown } from '../lib/milkdown-fake';
import { ArchitectureView } from './architecture';

vi.mock('../lib/milkdown', async () => (await import('../lib/milkdown-fake')).fakeMilkdown);
void fakeMilkdown;

/** The router's blocker, as the editor's leave guard sees it: what it asks, and what it answers. */
const router = vi.hoisted(() => ({
  ask: null as
    null | ((args: { current: { pathname: string }; next: { pathname: string } }) => boolean),
  beforeUnload: null as null | (() => boolean),
  status: 'idle',
  proceed: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('@tanstack/react-router', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useBlocker: (options: {
    shouldBlockFn: NonNullable<typeof router.ask>;
    enableBeforeUnload: () => boolean;
  }) => {
    router.ask = options.shouldBlockFn;
    router.beforeUnload = options.enableBeforeUnload;
    return { status: router.status, proceed: router.proceed, reset: router.reset };
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ADR = '11111111-1111-4111-8111-111111111111';
const B1 = 'b1111111-1111-4111-8111-111111111111';
const B2 = 'b2222222-2222-4222-8222-222222222222';
/** Who is signed in, in these tests. */
const ME = '99999999-9999-4999-8999-999999999999';
const DRAFT = `omr:draft:charter-draft:${ME}:r`;
const X1 = 'c1111111-1111-4111-8111-111111111111';
const C1 = 'd1111111-1111-4111-8111-111111111111';

/** What the server last wrote, and what a later write leaves. */
const T0 = '2026-10-30T12:00:00.000Z';
const T1 = '2026-10-30T12:05:00.000Z';

const nothing = (): ArchitectureDto => ({
  radar: { id: 'r', name: 'Arch' },
  revision: 0,
  charter: [],
  adrs: [],
  boundaries: [],
  contracts: [],
});
const proposed = {
  id: ADR,
  label: 'ADR-0001',
  title: 'Pick a queue',
  lane: 'proposed',
  ratifiedAt: null,
  supersedes: null,
  supersededBy: null,
  anchors: [],
  amends: [],
};
const drawn = (): ArchitectureDto => ({
  ...nothing(),
  revision: 3,
  charter: [
    {
      id: 'p1',
      title: 'Principles',
      updatedAt: T0,
      markdown: '# Principles\n\nBilling owns all billing truth.',
    },
  ],
  boundaries: [
    {
      id: B1,
      updatedAt: T0,
      title: 'Billing',
      external: false,
      owns: ['billing.links'],
      amendedBy: [],
    },
    { id: B2, updatedAt: T0, title: 'Sites', external: false, owns: [], amendedBy: [] },
    { id: X1, updatedAt: T0, title: 'Stripe', external: true, owns: [], amendedBy: [] },
  ],
  contracts: [
    {
      id: C1,
      updatedAt: T0,
      title: 'Stripe webhooks',
      version: '1.0',
      a: B1,
      b: X1,
      amendedBy: [],
    },
  ],
});
/** A page an ADR has amended: "all billing truth" is struck. */
const amendedPage = () => {
  const source = '# Principles\n\nBilling owns all billing truth.';
  return anchorQuote(
    source,
    'all billing truth',
    findQuote([{ id: 'p1', markdown: source }], 'all billing truth') as QuoteMatch,
    { adr: ADR, with: 'payment truth only' },
  );
};

let host: HTMLElement;
let root: Root;
const changed = vi.fn();
const viewport = (desktop: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop && (query === DESKTOP_QUERY || query === WIDE_QUERY),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
beforeEach(() => {
  fakeEditors.length = 0;
  viewport(true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
  writtenFails = false;
  router.status = 'idle';
  router.proceed.mockClear();
  router.reset.mockClear();
  changed.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  // Leaving the radar writes what is left; let that finish, and leave nothing for the next test.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  window.sessionStorage.clear();
  for (const key of [
    `charter-draft:${ME}:r`,
    `charter-mine:${ME}:r`,
    'charter-draft:other:r',
    'charter-mine:other:r',
  ])
    writeDraft(key, '');
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What the (mocked) server answers with now; `serve` changes it and has the page refetch. */
let served: ArchitectureDto;
let client: QueryClient;
/** The stored text has no markers: the written view is the source with them taken out. */
const writtenOf = (dto: ArchitectureDto): ArchitectureDto => ({
  ...dto,
  charter: dto.charter.map((p) => ({
    ...p,
    markdown: replaceMarkers(p.markdown ?? '', (m) => m.quote),
  })),
});
/** While true, reading the charter as stored (what editing starts from) fails. */
let writtenFails = false;
const architecture = () =>
  vi.spyOn(api.radars, 'architecture').mockImplementation(async (_id, _edit, view) => {
    if (view === 'written' && writtenFails) throw new ApiError(503, 'unavailable', 'Try later.');
    return view === 'written' ? writtenOf(served) : served;
  });
async function serve(next: ArchitectureDto) {
  served = next;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['architecture', 'r'] });
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function show(dto: ArchitectureDto, readOnly = false) {
  served = dto;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  architecture();
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
            emptyTitle="Nothing on this radar yet"
            emptyHint="Type in the box above"
          />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string, scope: ParentNode = document) =>
  must(
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label),
    label,
  );
const has = (label: string) => buttons().some((b) => b.textContent === label);
const click = (el: HTMLElement) => act(async () => el.click());
const tab = (label: string) =>
  click(
    must(
      [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === label),
      label,
    ),
  );
const type = async (field: Element, value: string) =>
  act(async () => {
    setNativeValue(field as HTMLInputElement, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const labelled = (text: string) => {
  const label = must(
    [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith(text)),
    text,
  );
  return must(document.getElementById(label.htmlFor), text) as HTMLInputElement;
};
/** Let a form's Milkdown editor finish loading (a dynamic import, then the editor itself). */
const settle = async () => {
  // Until every editor the page has drawn is made and standing (a dynamic import, however slow the
  // machine). One that was destroyed, as a refetch does to make another, does not count.
  for (let waited = 0; waited < 5000; waited += 10) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const standing = fakeEditors.filter((fake) => !fake.destroyed).length;
    if (standing >= document.querySelectorAll('.md-rich').length && waited >= 10) return;
  }
};
/** The editor the open form is using: what it opened with, and typing into it. */
const editor = () => must(fakeEditors.at(-1), 'an open editor');
const typeIn = async (text: string) => {
  await settle();
  await act(async () => editor().type(text));
  // The form reads the text a moment after each change.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
};
const chips = () => [...document.querySelectorAll('.chip-body')].map((c) => c.textContent);
const chipBox = () => must(document.querySelector<HTMLInputElement>('.chip-text'));
const press = (field: Element, key: string) =>
  act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
const addChip = async (text: string) => {
  await type(chipBox(), text);
  await press(chipBox(), 'Enter');
};
const choose = async (aria: string, value: string) => {
  const trigger = must(document.querySelector(`[role=combobox][aria-label="${aria}"]`), aria);
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  const option = must(document.querySelector<HTMLElement>(`[role=option][data-value="${value}"]`));
  await act(async () => option.focus());
  await act(async () =>
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
};

/* --------------------------------- empty states ---------------------------- */

it('keeps the card and its three tabs on an empty radar, each saying what goes in it', async () => {
  await show(nothing());
  expect(host.textContent).not.toContain('Nothing on this radar yet');
  expect(host.querySelectorAll('[role=tab]')).toHaveLength(3);
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Charter');
  expect(host.textContent).toContain('No charter yet');
  expect(has('Write the charter')).toBe(true);

  await tab('Map');
  expect(host.textContent).toContain('No boundaries yet');
  expect(has('Add boundary')).toBe(true);
  expect(button('Add contract').disabled).toBe(true);

  await tab('Matrix');
  expect(host.textContent).toContain('Nothing to compare yet');
  expect(has('Add boundary')).toBe(true);
});

it('lists a proposed ADR when the radar has no charter and no boundaries', async () => {
  await show({ ...nothing(), adrs: [proposed] });
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Charter');
  const rail = must(host.querySelector('.arch-rail')).textContent;
  expect(rail).toContain('ADR-0001');
  expect(rail).toContain('Pick a queue');
  expect(host.textContent).toContain('No charter yet');
});

it('shows accepted and rejected ADRs in the ledger with no charter', async () => {
  await show({
    ...nothing(),
    adrs: [
      {
        ...proposed,
        id: 'a2',
        label: 'ADR-0002',
        title: 'Use Postgres',
        lane: 'accepted',
        ratifiedAt: '2026-10-01T00:00:00.000Z',
      },
      { ...proposed, id: 'a3', label: 'ADR-0003', title: 'Use Mongo', lane: 'rejected' },
    ],
  });
  const rail = must(host.querySelector('.arch-rail')).textContent;
  expect(rail).toContain('Use Postgres');
  expect(rail).toContain('Use Mongo');
});

it('explains an empty tab to a reader without offering to write', async () => {
  await show(nothing(), true);
  expect(host.textContent).toContain('No charter yet');
  for (const label of [
    'Write the charter',
    'Edit charter',
    'Add boundary',
    'Add contract',
    'Propose ADR',
  ])
    expect(has(label), label).toBe(false);
  await tab('Map');
  expect(host.textContent).toContain('Nobody has drawn it yet');
  expect(has('Add boundary')).toBe(false);
});

/* ----------------------------------- charter ------------------------------- */

const result = (patch: Partial<WriteCharterResult> = {}): WriteCharterResult => ({
  revision: 4,
  version: 5,
  changed: true,
  orphaned: [],
  healed: [],
  moved: [],
  inertOrphaned: 0,
  ...patch,
});
const orphan = (patch: Partial<CharterOrphanDto> = {}): CharterOrphanDto => ({
  anchorId: 'an1',
  kind: 'amend',
  subject: { id: ADR, label: 'ADR-0001', lane: 'accepted' },
  quote: 'all billing truth',
  cause: 'text_changed',
  resolvedVersion: 2,
  orphanedVersion: 5,
  ...patch,
});
/** Typed into the open editor, and given the moment the editor takes to report it. */
const typed = async (text: string) => {
  await settle();
  await act(async () => editor().type(text));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
};
const idle = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
/** Longer than the autosave's idle time, so a write has happened by the end of it. */
const autosaved = () => idle(2300);
const toast = () => document.querySelector('.toast-host')?.textContent ?? '';

it('writes the charter from empty, in the editor, with no form and no page', async () => {
  await show(nothing());
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result({ revision: 1 }));
  await click(button('Write the charter'));
  await settle();
  expect(host.textContent).not.toContain('No charter yet');
  expect(host.querySelector('.arch-form')).toBeNull();
  expect(document.querySelector('label')).toBeNull();
  expect(editor().initial).toBe('');
  expect(has('Add page')).toBe(false);
  await typed('# Principles\n\nBilling owns the plan.');
  await click(button('Done'));
  // Typing is written as a working text; Done seals it, as a write of the same text.
  expect(write).toHaveBeenNthCalledWith(1, 'r', {
    markdown: '# Principles\n\nBilling owns the plan.',
    baseRevision: 0,
    checkpoint: false,
  });
  expect(write).toHaveBeenLastCalledWith('r', {
    markdown: '# Principles\n\nBilling owns the plan.',
    baseRevision: 1,
    checkpoint: true,
  });
  expect(document.querySelector('.charter-edit')).toBeNull();
  expect(changed).toHaveBeenCalled();
});

it('edits the charter in place at the document revision, locked to As written, with no pages', async () => {
  await show(drawn());
  expect(has('Add page')).toBe(false);
  expect(has('Edit page')).toBe(false);
  expect(has('Write the charter')).toBe(false);
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result());
  await click(button('Edit charter'));
  await settle();
  expect(editor().initial).toBe('# Principles\n\nBilling owns all billing truth.');
  expect(host.querySelector('.arch-pages')).toBeNull();
  const locked = [...host.querySelectorAll<HTMLButtonElement>('.segmented.is-locked button')];
  expect(locked.map((b) => [b.textContent, b.disabled])).toEqual([
    ['As written', true],
    ['As amended', true],
  ]);
  expect(has('Propose ADR')).toBe(false);
  await typed('# Principles\n\nBilling owns the plan.');
  await click(button('Done'));
  expect(write).toHaveBeenNthCalledWith(1, 'r', {
    markdown: '# Principles\n\nBilling owns the plan.',
    baseRevision: 3,
    checkpoint: false,
  });
  expect(write).toHaveBeenLastCalledWith('r', {
    markdown: '# Principles\n\nBilling owns the plan.',
    baseRevision: 4,
    checkpoint: true,
  });
  // Closed again: the page is read, with Edit charter back.
  expect(has('Edit charter')).toBe(true);
});

it('saves on its own once typing stops, and says so', async () => {
  await show(drawn());
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result());
  await click(button('Edit charter'));
  await typed('Typed.');
  expect(write).not.toHaveBeenCalled();
  expect(must(host.querySelector('.charter-save')).textContent).toBe('Saving…');
  await autosaved();
  expect(write).toHaveBeenCalledOnce();
  expect(must(host.querySelector('.charter-save')).textContent).toBe('Saved just now');
  // Still open: autosave is not Done.
  expect(editor().text()).toBe('Typed.');
  expect(has('Done')).toBe(true);
});

it('keeps what was typed when the page is left and come back to', async () => {
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result());
  await click(button('Edit charter'));
  await typed('Typed on the charter.');
  await tab('Map');
  await tab('Charter');
  await settle();
  expect(editor().initial).toBe('Typed on the charter.');
  expect(host.querySelector('.charter-edit')).not.toBeNull();
});

it('keeps what was typed when somebody else saved first, and offers the latest or a copy', async () => {
  await show(drawn());
  const write = vi
    .spyOn(api.radars, 'writeCharter')
    .mockRejectedValueOnce(
      new ApiError(409, 'stale', 'The charter is at revision 4.', { revision: '4' }),
    )
    .mockResolvedValue(result({ revision: 5 }));
  await click(button('Edit charter'));
  await typed('Mine.');
  await click(button('Done'));
  // Not closed, not saved, not lost.
  expect(host.querySelector('.charter-edit')).not.toBeNull();
  expect(must(document.querySelector('[role=alert]')).textContent).toContain(
    'The charter was changed elsewhere',
  );
  expect(must(host.querySelector('.charter-save')).textContent).toBe('Changed elsewhere');
  expect(editor().text()).toBe('Mine.');
  await autosaved();
  expect(write).toHaveBeenCalledOnce();

  // Reload takes the whole document (the server has no per-block save); mine is only kept by Copy mine.
  served = {
    ...drawn(),
    revision: 4,
    charter: [{ id: 'p1', title: 'Principles', updatedAt: T1, markdown: 'Theirs.' }],
  };
  await click(button('Reload latest'));
  await settle();
  expect(editor().initial).toBe('Theirs.');
  expect(toast()).toContain('Loaded the latest charter');
  // Their save is the head: there is no Undo that would write mine over it.
  expect(document.querySelector('.toast-undo')).toBeNull();
  expect(write).toHaveBeenCalledOnce();
});

it('Done keeps words typed in the last moment, before the editor has reported them', async () => {
  await show(drawn());
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result({ revision: 4 }));
  await click(button('Edit charter'));
  await settle();
  // Typed, and Done pressed at once: no time has passed for the editor to report it.
  await act(async () => editor().type('Quickly typed.'));
  await click(button('Done'));
  await settle();
  expect(write).toHaveBeenNthCalledWith(1, 'r', {
    markdown: 'Quickly typed.',
    baseRevision: 3,
    checkpoint: false,
  });
  expect(host.querySelector('.charter-edit')).toBeNull();
});

/** A clipboard that remembers what it was given. */
const clipboard = () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
};

it('holds the document still while Done saves, and goes again with what got in anyway', async () => {
  await show(drawn());
  let release: (r: WriteCharterResult) => void = () => undefined;
  const write = vi
    .spyOn(api.radars, 'writeCharter')
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockResolvedValue(result({ revision: 5 }));
  await click(button('Edit charter'));
  await settle();
  await act(async () => editor().type('First.'));
  await click(button('Done'));
  // The first write is on its way: the editor is held, and says so.
  expect(editor().locked()).toBe(true);
  expect(button('Saving…').disabled).toBe(true);
  await act(async () => editor().type('Lost?'));
  expect(editor().text()).toBe('First.');
  // Something got in regardless (an input method, a paste). It must not be closed over.
  await act(async () => editor().force('First. And more.'));
  await act(async () => release(result({ revision: 4 })));
  await settle();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const sent = write.mock.calls.map(([, input]) => [input.markdown, input.checkpoint]);
  expect(sent).toContainEqual(['First. And more.', false]);
  // It closed only once what is in the editor is what is saved and sealed.
  expect(sent.at(-1)).toEqual(['First. And more.', true]);
  expect(host.querySelector('.charter-edit')).toBeNull();
});

it('keeps the editor open, held no longer, when Done cannot save', async () => {
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter').mockRejectedValue(new TypeError('Failed to fetch'));
  await click(button('Edit charter'));
  await settle();
  await act(async () => editor().type('Offline.'));
  await click(button('Done'));
  await settle();
  expect(host.querySelector('.charter-edit')).not.toBeNull();
  expect(editor().locked()).toBe(false);
  expect(editor().text()).toBe('Offline.');
  expect(has('Done')).toBe(true);
});

it('copies what is in the editor now, not what it last reported', async () => {
  const copied = clipboard();
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter')
    .mockRejectedValueOnce(new ApiError(409, 'stale', 'at 4', { revision: '4' }))
    .mockResolvedValue(result({ revision: 5 }));
  await click(button('Edit charter'));
  await typed('Mine.');
  await click(button('Done'));
  await click(button('Copy mine').closest('button') as HTMLElement);
  // Pasted, and Copy mine pressed before the editor has reported it.
  await act(async () => editor().type('Mine. Pasted just now.'));
  await click(button('Copy mine'));
  expect(copied).toHaveBeenLastCalledWith('Mine. Pasted just now.');
});

it('never reloads over unsaved text: it is set aside first, with the words typed a moment ago', async () => {
  const copied = clipboard();
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter').mockRejectedValue(
    new ApiError(409, 'stale', 'at 4', { revision: '4' }),
  );
  await click(button('Edit charter'));
  await typed('Mine.');
  await click(button('Done'));
  served = {
    ...drawn(),
    revision: 4,
    charter: [{ id: 'p1', title: 'Principles', updatedAt: T1, markdown: 'Theirs.' }],
  };
  await act(async () => editor().type('Mine. And the last word.'));
  await click(button('Reload latest'));
  await settle();
  expect(editor().initial).toBe('Theirs.');
  expect(document.querySelector('.toast-undo')).toBeNull();
  expect(host.textContent).toContain('Your version from before the reload is kept');
  await click(button('Copy it'));
  expect(copied).toHaveBeenLastCalledWith('Mine. And the last word.');
  await click(button('Dismiss'));
  expect(host.textContent).not.toContain('is kept');
  expect(window.sessionStorage.length).toBe(0);
});

it('keeps an unsaved draft when the radar is left, asks first, and offers it back to save or discard', async () => {
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter').mockRejectedValue(
    new ApiError(422, 'too_long', 'Too long.'),
  );
  await click(button('Edit charter'));
  await typed('A draft I must keep.');
  await autosaved();
  expect(host.textContent).toContain('The charter was not saved');
  // Inside the app, leaving asks; moving between tabs of the radar does not.
  const leave = { current: { pathname: '/radar/r' }, next: { pathname: '/' } };
  expect(router.ask?.(leave)).toBe(true);
  expect(router.ask?.({ current: leave.current, next: leave.current })).toBe(false);
  expect(router.beforeUnload?.()).toBe(true);
  router.status = 'blocked';
  await act(async () => root.render(<></>));
  await show(drawn());
  await act(async () => root.unmount());
  // Gone from the page, but not from this browser.
  root = createRoot(host);
  router.status = 'idle';
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result({ revision: 4 }));
  await show(drawn());
  await settle();
  expect(host.textContent).toContain('Unsaved changes restored');
  expect(editor().initial).toBe('A draft I must keep.');
  await click(button('Save'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(write).toHaveBeenCalledWith('r', {
    markdown: 'A draft I must keep.',
    baseRevision: 3,
    checkpoint: false,
  });
  expect(host.textContent).not.toContain('Unsaved changes restored');
});

it('never restores or shows what another account left in this browser', async () => {
  const theirs = JSON.stringify({
    markdown: 'Alice, privately.',
    baseRevision: 3,
    userId: 'other',
  });
  window.sessionStorage.setItem('omr:draft:charter-draft:other:r', theirs);
  window.sessionStorage.setItem('omr:draft:charter-mine:other:r', theirs);
  // Even filed under this person's key, a text written for somebody else is not theirs.
  window.sessionStorage.setItem(DRAFT, theirs);
  window.sessionStorage.setItem(`omr:draft:charter-mine:${ME}:r`, theirs);
  await show(drawn());
  await settle();
  expect(host.querySelector('.charter-edit')).toBeNull();
  expect(has('Edit charter')).toBe(true);
  await click(button('Edit charter'));
  await settle();
  expect(document.body.textContent).not.toContain('Alice');
  expect(host.textContent).not.toContain('Unsaved changes restored');
  expect(host.textContent).not.toContain('is kept');
});

it('keeps a stored draft, and the editor off, while the charter cannot be read to bring it back', async () => {
  window.sessionStorage.setItem(
    DRAFT,
    JSON.stringify({ markdown: 'The only copy.', baseRevision: 3, userId: ME }),
  );
  writtenFails = true;
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result({ revision: 4 }));
  await show(drawn());
  await settle();
  expect(host.textContent).toContain('Unsaved changes from earlier are kept');
  expect(button('Edit charter').disabled).toBe(true);
  await click(button('Edit charter'));
  await settle();
  // Nothing opened on the server's text, and the copy in this browser is where it was.
  expect(host.querySelector('.charter-edit')).toBeNull();
  expect(window.sessionStorage.getItem(DRAFT)).toContain('The only copy.');
  // Once it can be read, it comes back, and still nothing clears it until it is saved.
  writtenFails = false;
  await click(button('Retry'));
  await settle();
  expect(host.textContent).toContain('Unsaved changes restored');
  expect(editor().initial).toBe('The only copy.');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(window.sessionStorage.getItem(DRAFT)).toContain('The only copy.');
  await click(button('Save'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(write).toHaveBeenCalledWith('r', {
    markdown: 'The only copy.',
    baseRevision: 3,
    checkpoint: false,
  });
  expect(window.sessionStorage.getItem(DRAFT)).toBeNull();
});

it('does not close on Done when a lost answer left the server holding other text', async () => {
  await show(drawn());
  let lost = true;
  const write = vi
    .spyOn(api.radars, 'writeCharter')
    .mockImplementation(() =>
      lost
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.reject(new ApiError(409, 'stale', 'at 4', { revision: '4' })),
    );
  await click(button('Edit charter'));
  await typed('B, committed and unanswered.');
  await autosaved();
  expect(write).toHaveBeenCalledOnce();
  // The person puts it back to what they opened on, which is what was last acknowledged.
  lost = false;
  served = {
    ...drawn(),
    revision: 4,
    charter: [{ id: 'p1', title: 'P', updatedAt: T1, markdown: 'B, committed and unanswered.' }],
  };
  await act(async () => editor().type('# Principles\n\nBilling owns all billing truth.'));
  await click(button('Done'));
  await settle();
  expect(host.querySelector('.charter-edit')).not.toBeNull();
  expect(host.querySelector('.charter-save')?.textContent).toBe('Changed elsewhere');
});

it('discards a restored draft when asked to, and keeps nothing', async () => {
  window.sessionStorage.setItem(
    DRAFT,
    JSON.stringify({ markdown: 'Left behind.', baseRevision: 3, userId: ME }),
  );
  const write = vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result());
  await show(drawn());
  await settle();
  expect(host.textContent).toContain('Unsaved changes restored');
  await click(button('Discard'));
  expect(host.querySelector('.charter-edit')).toBeNull();
  expect(window.sessionStorage.getItem(DRAFT)).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it('asks before leaving the app with text the server does not have, and not when it has it', async () => {
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result());
  await click(button('Edit charter'));
  await settle();
  const leave = { current: { pathname: '/radar/r' }, next: { pathname: '/' } };
  expect(router.ask?.(leave)).toBe(false);
  await act(async () => editor().type('Not yet reported.'));
  // Read from the editor, not from the report that trails it.
  expect(router.ask?.(leave)).toBe(true);
  router.status = 'blocked';
  await show(drawn());
  expect(document.body.textContent).toContain('Leave with unsaved changes?');
  await click(button('Leave'));
  expect(router.proceed).toHaveBeenCalled();
  await click(button('Cancel'));
  expect(router.reset).toHaveBeenCalled();
});

it('says what a save orphaned, and Undo puts the previous text back and heals it', async () => {
  await show({
    ...drawn(),
    charter: [{ id: 'p1', title: 'Principles', updatedAt: T0, markdown: amendedPage() }],
    adrs: [{ ...proposed, lane: 'accepted', ratifiedAt: '2026-10-01T00:00:00.000Z' }],
  });
  const before = '# Principles\n\nBilling owns all billing truth.';
  const write = vi
    .spyOn(api.radars, 'writeCharter')
    .mockResolvedValueOnce(result({ orphaned: [orphan()] }))
    .mockResolvedValueOnce(
      result({
        revision: 5,
        healed: [{ anchorId: 'an1', kind: 'amend', subject: orphan().subject, quote: 'x' }],
      }),
    );
  await click(button('Edit charter'));
  await typed('# Principles\n\nBilling owns all of billing.');
  await autosaved();
  expect(toast()).toContain('Saved. This orphaned ADR-0001.');
  await click(must(document.querySelector<HTMLElement>('.toast-undo')));
  await settle();
  // The text goes back in the editor and on the server, together.
  expect(editor().initial).toBe(before);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(write).toHaveBeenLastCalledWith('r', {
    markdown: before,
    baseRevision: 4,
    checkpoint: false,
  });
  expect(toast()).toContain('ADR-0001 anchored again');
});

it('does not undo over text typed since the save that orphaned', async () => {
  await show(drawn());
  vi.spyOn(api.radars, 'writeCharter').mockResolvedValue(result({ orphaned: [orphan()] }));
  await click(button('Edit charter'));
  await typed('First.');
  await autosaved();
  await typed('First. And then more.');
  const calls = vi.mocked(api.radars.writeCharter).mock.calls.length;
  await click(must(document.querySelector<HTMLElement>('.toast-undo')));
  expect(toast()).toContain('You have typed since that save');
  expect(editor().text()).toBe('First. And then more.');
  expect(vi.mocked(api.radars.writeCharter).mock.calls.length).toBe(calls);
});

it('lists what is orphaned in the rail, with the cause and the words, and counts it on the tab', async () => {
  await show({ ...drawn(), orphans: [orphan(), orphan({ anchorId: 'an2', cause: 'ambiguous' })] });
  const tray = must(host.querySelector('.charter-orphans'));
  expect(tray.textContent).toContain('Orphaned · 2');
  expect(tray.textContent).toContain('ADR-0001');
  expect(tray.textContent).toContain('Its words were changed or removed.');
  expect(tray.textContent).toContain('cannot tell which one it meant');
  expect(tray.querySelector('blockquote')?.textContent).toBe('all billing truth');
  expect(
    must(host.querySelector('[role=tab][aria-selected=true] .arch-tab-count')).textContent,
  ).toBe('2');
  // Each can be pointed at new words or let go, or looked at in the version that had it.
  expect(tray.querySelectorAll('button')).toHaveLength(4);
  for (const label of ['Re-anchor', 'Make free-standing']) expect(has(label), label).toBe(true);
  expect(tray.querySelectorAll('a')).toHaveLength(2);
});

it('turns Accept off for an ADR whose text is orphaned, and says why', async () => {
  await show({
    ...drawn(),
    adrs: [
      {
        ...proposed,
        anchors: [{ pageId: 'r', quote: 'all billing truth', with: 'x', state: 'orphaned' }],
      },
    ],
  });
  const accept = button('Accept');
  expect(accept.disabled).toBe(true);
  const why = must(document.getElementById(must(accept.getAttribute('aria-describedby'))));
  expect(why.textContent).toBe(
    'Accept is off while this ADR has lost its text. Re-anchor it to the passage that now says this, or make it free-standing.',
  );
  expect(button('Reject').disabled).toBe(false);
});

it('shows the outline of the charter and scrolls to a heading', async () => {
  await show({
    ...drawn(),
    charter: [
      {
        id: 'p1',
        title: 'Charter',
        updatedAt: T0,
        markdown: '# 01 · Principles\n\nText.\n\n## Credentials\n\nMore.\n\n# 02 · System\n\nEnd.',
      },
    ],
  });
  await click(button('Outline'));
  const items = [...host.querySelectorAll<HTMLButtonElement>('.charter-outline button')];
  expect(items.map((i) => i.textContent)).toEqual([
    '01 · Principles',
    'Credentials',
    '02 · System',
  ]);
  const scroll = vi.fn();
  const heads = [...host.querySelectorAll<HTMLElement>('.arch-pages :is(h1, h2, h3)')];
  must(heads[2]).scrollIntoView = scroll;
  await click(must(items[2]));
  expect(scroll).toHaveBeenCalledOnce();
});

it('gives a reader who cannot write no way to edit the charter', async () => {
  await show(drawn(), true);
  expect(has('Edit charter')).toBe(false);
  expect(has('Propose ADR')).toBe(false);
});

/* ------------------------------------ map ---------------------------------- */

it('adds a boundary from the tab bar, in the detail rail rather than over the map', async () => {
  await show(drawn());
  await tab('Map');
  const add = vi.spyOn(api.radars, 'upsertBoundary').mockResolvedValue({
    boundary: {
      id: 'nb',
      title: 'Search',
      updatedAt: T1,
      external: false,
      owns: [],
      amendedBy: [],
    },
    created: true,
  });
  await click(button('Add boundary'));
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(must(host.querySelector('.arch-focus')).querySelector('.side-panel')).not.toBeNull();
  expect(host.querySelector('.map-node')).not.toBeNull();

  await type(labelled('Name'), 'billing');
  expect(must(document.querySelector('[role=alert]')).textContent).toContain(
    'already has that name',
  );
  expect(
    must(document.querySelector<HTMLButtonElement>('.side-panel-foot .btn-accent')).disabled,
  ).toBe(true);

  await type(labelled('Name'), 'Search');
  const outside = must(document.querySelector('[role=switch]'));
  expect(outside.getAttribute('aria-checked')).toBe('false');
  await click(outside as HTMLElement);
  expect(outside.getAttribute('aria-checked')).toBe('true');
  await addChip('search.index');
  await type(chipBox(), '  search.queries ');
  // Text still in the box when it loses focus is an item too: nothing typed is lost.
  await act(async () => chipBox().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await click(button('Create boundary'));
  expect(add).toHaveBeenCalledWith('r', {
    title: 'Search',
    external: true,
    owns: ['search.index', 'search.queries'],
  });
  expect(changed).toHaveBeenCalled();
  expect(host.querySelector('.side-panel')).toBeNull();
});

it('adds chips with Enter or a comma, from a pasted list, skipping repeats; renames, reorders and removes them', async () => {
  await show(drawn());
  await tab('Map');
  await click(button('Add boundary'));
  await type(chipBox(), 'runs,steps,');
  expect(chips()).toEqual(['runs', 'steps']);
  await addChip('Runs');
  expect(chips()).toEqual(['runs', 'steps']);
  await addChip('compensation');
  // A pasted list is added whole, after what was already typed; blank lines and repeats are dropped.
  await type(chipBox(), 'idempotency key');
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.assign(paste, {
    clipboardData: { getData: () => 'ordered steps\n\nretries, steps\nlocks' },
  });
  await act(async () => chipBox().dispatchEvent(paste));
  expect(chips()).toEqual([
    'runs',
    'steps',
    'compensation',
    'idempotency key',
    'ordered steps',
    'retries',
    'locks',
  ]);
  // Alt with an arrow moves a chip, for a keyboard and for a screen reader.
  const body = (text: string) =>
    must(
      [...document.querySelectorAll<HTMLElement>('.chip-body')].find((c) => c.textContent === text),
    );
  await act(async () =>
    body('locks').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(chips().slice(-2)).toEqual(['locks', 'retries']);
  // A click renames: the chip becomes a field, and Enter keeps what was typed.
  await click(body('runs'));
  const rename = must(document.querySelector<HTMLInputElement>('.chip-edit'));
  await type(rename, 'executions');
  await press(rename, 'Enter');
  expect(chips()[0]).toBe('executions');
  // Dragging one chip onto another puts it there.
  const rects = new Map<Element, DOMRect>();
  [...document.querySelectorAll('.chip-item')].forEach((chip, i) =>
    rects.set(chip, { left: i * 100, right: i * 100 + 90, top: 0, bottom: 20 } as DOMRect),
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    return rects.get(this) ?? rects.get(this.closest('.chip-item') as Element) ?? ({} as DOMRect);
  });
  const first = body('executions');
  const pointer = (type: string, x: number) =>
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10, button: 0 });
  await act(async () => first.dispatchEvent(pointer('pointerdown', 40)));
  await act(async () => first.dispatchEvent(pointer('pointermove', 650)));
  await act(async () => first.dispatchEvent(pointer('pointerup', 650)));
  expect(chips().at(-1)).toBe('executions');
  vi.restoreAllMocks();
  await click(must(document.querySelector<HTMLElement>('[aria-label="Remove locks"]')));
  expect(chips()).not.toContain('locks');
});

it('adds a contract between two boundaries, refusing one that is outside on both sides', async () => {
  await show(drawn());
  await tab('Map');
  const add = vi.spyOn(api.radars, 'upsertContract').mockResolvedValue({
    contract: {
      id: 'nc',
      title: 'Sync',
      updatedAt: T1,
      version: '2',
      a: B1,
      b: B2,
      amendedBy: [],
    },
    created: true,
  });
  await click(button('Add contract'));
  await type(labelled('Name'), 'Sync');
  await type(labelled('Version'), '2');
  await choose('From boundary', B1);
  await choose('To boundary', B1);
  expect(must(document.querySelector('[role=alert]')).textContent).toContain(
    'two different boundaries',
  );
  await choose('To boundary', B2);
  expect(document.querySelector('[role=alert]')).toBeNull();
  await typeIn('Owner: Billing');
  await click(button('Create contract'));
  expect(add).toHaveBeenCalledWith('r', {
    title: 'Sync',
    version: '2',
    a: B1,
    b: B2,
    body: 'Owner: Billing',
  });
});

/** The architecture with Billing carrying its own text, as the server answers an edit. */
const billing = (body: string, updatedAt: string): ArchitectureDto => ({
  ...drawn(),
  boundaries: drawn().boundaries.map((x) => (x.id === B1 ? { ...x, body, updatedAt } : x)),
});
const saved = (title: string, updatedAt: string) => ({
  boundary: { id: B1, title, updatedAt, external: false, owns: ['billing.links'], amendedBy: [] },
  created: false,
});
const openBilling = async () => {
  await click(button('Edit', must(host.querySelector('.arch-focus'))));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

it('edits a boundary from its detail, with the text it already has, and sends only what changed', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(billing('Money.', T0));
  const add = vi
    .spyOn(api.radars, 'upsertBoundary')
    .mockResolvedValue(saved('Billing and plans', T1));
  await openBilling();
  await settle();
  expect(labelled('Name').value).toBe('Billing');
  expect(chips()).toEqual(['billing.links']);
  expect(editor().initial).toBe('Money.');
  // Opening the editor does not make the form changed.
  expect(button('Save boundary').disabled).toBe(true);
  await type(labelled('Name'), 'Billing and plans');
  await click(button('Save boundary'));
  expect(add).toHaveBeenCalledWith('r', {
    id: B1,
    expectedUpdatedAt: T0,
    title: 'Billing and plans',
    external: false,
    owns: ['billing.links'],
  });
});

it('follows a refetch while untouched, so the next save is made on the new text and revision', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(billing('Money.', T0));
  const add = vi.spyOn(api.radars, 'upsertBoundary').mockResolvedValue(saved('Billing', T1));
  await openBilling();
  await settle();
  expect(editor().initial).toBe('Money.');
  await serve(billing('Money, and the plans.', T1));
  await settle();
  expect(editor().initial).toBe('Money, and the plans.');
  await typeIn('Money, and the plans. Then more.');
  await click(button('Save boundary'));
  expect(add).toHaveBeenCalledWith('r', {
    id: B1,
    expectedUpdatedAt: T1,
    title: 'Billing',
    external: false,
    owns: ['billing.links'],
    body: 'Money, and the plans. Then more.',
  });
});

it('saves, reopens, and saves again on what the first save wrote', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(billing('One.', T0));
  const add = vi
    .spyOn(api.radars, 'upsertBoundary')
    .mockResolvedValueOnce(saved('Billing', T1))
    .mockResolvedValueOnce(saved('Billing', '2026-10-30T12:10:00.000Z'));
  await openBilling();
  await typeIn('One. Two.');
  served = billing('One. Two.', T1);
  await click(button('Save boundary'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(host.querySelector('.side-panel')).toBeNull();
  await openBilling();
  await settle();
  expect(editor().initial).toBe('One. Two.');
  await typeIn('One. Two. Three.');
  await click(button('Save boundary'));
  expect(add).toHaveBeenLastCalledWith(
    'r',
    expect.objectContaining({ expectedUpdatedAt: T1, body: 'One. Two. Three.' }),
  );
});

it('keeps what was typed when the server moves on, says so, and loads theirs on request', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(billing('Original.', T0));
  const add = vi.spyOn(api.radars, 'upsertBoundary').mockResolvedValue(saved('Billing', T1));
  await openBilling();
  await typeIn('Mine.');
  await serve(billing('Theirs.', T1));
  // What was typed is kept: the form does not reopen on their text under the person typing.
  expect(editor().text()).toBe('Mine.');
  expect(must(document.querySelector('[role=alert]')).textContent).toContain(
    'changed by someone else',
  );
  expect(button('Save boundary').disabled).toBe(true);
  await click(button('Load their version'));
  await settle();
  expect(editor().initial).toBe('Theirs.');
  expect(document.querySelector('[role=alert]')).toBeNull();
  await typeIn('Theirs. And mine.');
  await click(button('Save boundary'));
  expect(add).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ expectedUpdatedAt: T1, body: 'Theirs. And mine.' }),
  );
});

it('shows the refusal when the server finds the boundary changed, and fetches their version', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(billing('Original.', T0));
  const get = architecture();
  vi.spyOn(api.radars, 'upsertBoundary').mockRejectedValue(
    new ApiError(409, 'stale', 'This was changed by someone else after you opened it.'),
  );
  await openBilling();
  await typeIn('Mine.');
  const before = get.mock.calls.length;
  served = billing('Theirs.', T1);
  await click(button('Save boundary'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(host.textContent).toContain('This was changed by someone else after you opened it.');
  expect(get.mock.calls.length).toBeGreaterThan(before);
  expect(editor().text()).toBe('Mine.');
});

it('removes a contract after asking, and says why when the server will not', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${C1}`);
  await show(drawn());
  const remove = vi
    .spyOn(api.blips, 'remove')
    .mockRejectedValueOnce(new ApiError(409, 'anchored', 'An ADR amends this.'))
    .mockResolvedValue(undefined);
  await click(button('Remove', must(host.querySelector('.arch-focus'))));
  expect(remove).not.toHaveBeenCalled();
  const confirm = () => button('Remove', must(document.querySelector('[role=dialog]')));
  await click(confirm());
  expect(remove).toHaveBeenCalledWith(C1);
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  await click(button('Remove', must(host.querySelector('.arch-focus'))));
  await click(confirm());
  expect(changed).toHaveBeenCalled();
});

it('offers no edit or remove to a reader', async () => {
  window.history.replaceState(null, '', `/?tab=map&focus=${B1}`);
  await show(drawn(), true);
  expect(must(host.querySelector('.arch-focus')).textContent).toContain('billing.links');
  expect(has('Edit')).toBe(false);
  expect(has('Remove')).toBe(false);
  expect(has('Add boundary')).toBe(false);
});

it('opens the form as a full-height sheet on a phone, not in the list', async () => {
  viewport(false);
  await show(drawn());
  await tab('Map');
  await click(button('Add boundary'));
  const sheet = must(document.querySelector('.modal-panel.is-side'));
  expect(sheet.getAttribute('role')).toBe('dialog');
  expect(sheet.textContent).toContain('New boundary');
  expect(must(host.querySelector('.arch-seams')).querySelector('.side-panel')).toBeNull();
});

/* --------------------------------- proposing ------------------------------- */

it("proposes an ADR from the tab bar in the charter's panel, with a title and why, and lands on the ledger", async () => {
  await show(drawn());
  await tab('Map');
  const propose = vi.spyOn(api.radars, 'proposeAdr').mockResolvedValue({ adr: proposed });
  await click(button('Propose ADR'));
  // From any tab it opens on the Charter, in the ledger's place, not over the page.
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Charter');
  const panel = must(
    host.querySelector<HTMLElement>('.arch-charter > .side-panel-slot .side-panel'),
  );
  expect(host.querySelector('.arch-rail')).toBeNull();
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(panel.querySelector('.panel-quote')).toBeNull();
  expect(panel.textContent).not.toContain('Replace with');
  expect(panel.textContent).toContain('Stays Proposed until decided');
  await type(must(panel.querySelector('input')), 'Pick a queue');
  await typeIn('Jobs need retries.');
  await click(button('Propose ADR', panel));
  expect(propose).toHaveBeenCalledWith('r', {
    title: 'Pick a queue',
    rationale: 'Jobs need retries.',
    anchors: [],
  });
  expect(must(host.querySelector('[role=tab][aria-selected=true]')).textContent).toBe('Charter');
  expect(changed).toHaveBeenCalled();
  expect(host.querySelector('.side-panel')).toBeNull();
});

it('names what an ADR also affects, and sends those boundaries and contracts as what it amends', async () => {
  await show(drawn());
  const propose = vi.spyOn(api.radars, 'proposeAdr').mockResolvedValue({ adr: proposed });
  await click(button('Propose ADR'));
  const panel = must(host.querySelector<HTMLElement>('.side-panel'));
  await type(must(panel.querySelector('input')), 'Pick a queue');
  await typeIn('Jobs need retries.');
  await choose('Also affects', B1);
  await choose('Also affects', C1);
  const names = () => [...panel.querySelectorAll('.chip-row .chip')].map((c) => c.textContent);
  expect(names()).toHaveLength(2);
  await click(must(panel.querySelector<HTMLElement>('.chip-row .chip button')));
  expect(names()).toHaveLength(1);
  await click(button('Propose ADR', panel));
  expect(propose).toHaveBeenCalledWith('r', expect.objectContaining({ amends: [C1] }));
});

/* ------------------------------ what is typed is kept ----------------------- */

it('keeps an unfinished ADR across a tab switch, and asks before discarding it', async () => {
  await show(drawn());
  const propose = vi.spyOn(api.radars, 'proposeAdr').mockResolvedValue({ adr: proposed });
  await click(button('Propose ADR'));
  await type(must(host.querySelector('.side-panel input')), 'Pick a queue');
  await settle();
  // Typed and left at once, before the editor has reported its text.
  await act(async () => editor().type('Jobs need retries.'));
  await tab('Map');
  expect(host.querySelector('.side-panel')).toBeNull();
  await tab('Charter');
  // The same title and Why are there, and the editor opened on them.
  expect(must(host.querySelector<HTMLInputElement>('.side-panel input')).value).toBe(
    'Pick a queue',
  );
  await settle();
  expect(editor().initial).toBe('Jobs need retries.');
  // Closing with text in it asks first; keeping it leaves the panel as it was.
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  const ask = must(document.querySelector('[role=dialog]'));
  expect(ask.textContent).toContain('Discard draft?');
  await click(button('Cancel', ask));
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(must(host.querySelector<HTMLInputElement>('.side-panel input')).value).toBe(
    'Pick a queue',
  );
  // The draft is what is sent.
  await click(button('Propose ADR', must(host.querySelector('.side-panel'))));
  expect(propose).toHaveBeenCalledWith('r', {
    title: 'Pick a queue',
    rationale: 'Jobs need retries.',
    anchors: [],
  });
  // Saved, it is gone: the next proposal starts empty.
  await click(button('Propose ADR'));
  expect(must(host.querySelector<HTMLInputElement>('.side-panel input')).value).toBe('');
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(host.querySelector('.side-panel')).toBeNull();
});

it('discards a draft only when asked to, and a blank panel closes without asking', async () => {
  await show(drawn());
  await click(button('Propose ADR'));
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(host.querySelector('.side-panel')).toBeNull();
  await click(button('Propose ADR'));
  await type(must(host.querySelector('.side-panel input')), 'Pick a queue');
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  await click(button('Discard', must(document.querySelector('[role=dialog]'))));
  expect(host.querySelector('.side-panel')).toBeNull();
  await click(button('Propose ADR'));
  expect(must(host.querySelector<HTMLInputElement>('.side-panel input')).value).toBe('');
});

it('leaves every field alone while a save runs, and keeps the panel if it fails', async () => {
  await show(drawn());
  await tab('Map');
  let finish: (value: never) => void = () => undefined;
  const add = vi.spyOn(api.radars, 'upsertBoundary').mockReturnValue(
    new Promise((resolve, reject) => {
      finish = reject as (value: never) => void;
      void resolve;
    }),
  );
  await click(button('Add boundary'));
  await type(labelled('Name'), 'Search');
  await typeIn('Finds things.');
  const body = () => must(host.querySelector('.side-panel .panel-stack'));
  expect(body().hasAttribute('inert')).toBe(false);
  await click(button('Create boundary'));
  expect(add).toHaveBeenCalled();
  // Nothing can be typed into the panel until the request is answered.
  expect(body().hasAttribute('inert')).toBe(true);
  await act(async () => finish(new Error('offline') as never));
  expect(body().hasAttribute('inert')).toBe(false);
  expect(must(host.querySelector<HTMLInputElement>('.side-panel input')).value).toBe('Search');
});

/* ------------------- a boundary or contract survives the map being redrawn ------------------- */

/** A window whose width can change under a mounted page: a tablet turned on its side. */
function resizable(width: number) {
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return (
        (query === DESKTOP_QUERY && width >= 1024) ||
        (query === WIDE_QUERY && width >= 820) ||
        query === `(min-width: ${width}px)`
      );
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return async (next: number) => {
    width = next;
    await act(async () => listeners.forEach((listener) => listener()));
    await settle();
  };
}

it('keeps an unsaved contract across the same change, and Cancel throws a draft away', async () => {
  const resize = resizable(1100);
  await show(drawn());
  await tab('Map');
  await click(button('Add contract'));
  await type(labelled('Name'), 'Site billing');
  await type(labelled('Version'), '2.1');
  await resize(700);
  expect(labelled('Name').value).toBe('Site billing');
  expect(labelled('Version').value).toBe('2.1');
  await click(button('Cancel'));
  expect(host.querySelector('.side-panel, .modal-panel.is-side')).toBeNull();
  await click(button('Add contract'));
  expect(labelled('Name').value).toBe('');
});

/* ---------------- one panel, whatever the window does: the four Codex round 2 findings ---------------- */

it('keeps text pasted into the Why when the window is resized before the editor has reported it', async () => {
  const resize = resizable(1100);
  await show(drawn());
  const propose = vi.spyOn(api.radars, 'proposeAdr').mockResolvedValue({ adr: proposed });
  await click(button('Propose ADR'));
  await type(must(host.querySelector('.side-panel input')), 'Pick a queue');
  await settle();
  // Pasted, and the window resized inside the 150ms before the editor tells the form.
  await act(async () => editor().type('Jobs need retries.'));
  const before = fakeEditors.length;
  await resize(700);
  await resize(1100);
  // The same editor, still holding it: nothing was made again for the text to be lost between.
  expect(fakeEditors).toHaveLength(before);
  expect(editor().text()).toBe('Jobs need retries.');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await click(button('Propose ADR', must(host.querySelector('.side-panel'))));
  expect(propose).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ title: 'Pick a queue', rationale: 'Jobs need retries.' }),
  );
});

it('keeps the lock on a panel that is saving when the window is resized, and the text typed after', async () => {
  const resize = resizable(1100);
  await show(drawn());
  await tab('Map');
  let fail: (reason: Error) => void = () => undefined;
  const add = vi.spyOn(api.radars, 'upsertBoundary').mockReturnValue(
    new Promise((_, reject) => {
      fail = reject as (reason: Error) => void;
    }),
  );
  await click(button('Add boundary'));
  await type(labelled('Name'), 'Search');
  await click(button('Create boundary'));
  const stack = () => must(document.querySelector('.side-panel .panel-stack'));
  expect(stack().hasAttribute('inert')).toBe(true);
  await resize(700);
  await resize(1100);
  // Still saving: still locked, and Create cannot be pressed a second time.
  expect(stack().hasAttribute('inert')).toBe(true);
  expect(
    must(document.querySelector<HTMLButtonElement>('.side-panel-foot .btn-accent')).disabled,
  ).toBe(true);
  expect(add).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error('offline')));
  // Answered: unlocked, and what is typed now is kept (the request's answer does not clear it).
  expect(stack().hasAttribute('inert')).toBe(false);
  await type(labelled('Name'), 'Search 2');
  expect(labelled('Name').value).toBe('Search 2');
});

it('opens empty after Cancel, though the editor had text it had not yet reported', async () => {
  await show(drawn());
  await click(button('Propose ADR'));
  await settle();
  await act(async () => editor().type('Never sent.'));
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  expect(host.querySelector('.side-panel')).toBeNull();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await click(button('Propose ADR'));
  await settle();
  expect(editor().initial).toBe('');

  await tab('Map');
  await click(button('Add boundary'));
  await type(labelled('Name'), 'Search');
  await settle();
  await act(async () => editor().type('Also never saved.'));
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await click(button('Add boundary'));
  await settle();
  expect(labelled('Name').value).toBe('');
  expect(editor().initial).toBe('');
});

it('keeps text in the chip box that is not a chip yet, through a resize and through a tab switch', async () => {
  const resize = resizable(1100);
  await show(drawn());
  await tab('Map');
  await click(button('Add boundary'));
  await type(chipBox(), 'search.in');
  const box = chipBox();
  await resize(700);
  await resize(1100);
  // The same box, with the same text in it.
  expect(chipBox()).toBe(box);
  expect(chipBox().value).toBe('search.in');
  await tab('Charter');
  expect(host.querySelector('.side-panel')).toBeNull();
  await tab('Map');
  await click(button('Add boundary'));
  expect(chipBox().value).toBe('search.in');
});

it('leaves a chip being renamed alone when a keyboard move of another chip settles after it', async () => {
  await show(drawn());
  await tab('Map');
  await click(button('Add boundary'));
  const body = (text: string) =>
    must(
      [...document.querySelectorAll<HTMLElement>('.chip-body')].find((c) => c.textContent === text),
    );
  await addChip('runs');
  await addChip('steps');
  await addChip('locks');
  // Alt+Left moves "locks" up, and the keyboard is to follow it on the next frame. Before then, a
  // click starts renaming "runs": the frame must not take the focus out of that box.
  await act(async () =>
    body('locks').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await click(body('runs'));
  const rename = must(document.querySelector<HTMLInputElement>('.chip-edit'));
  expect(document.activeElement).toBe(rename);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(document.querySelector('.chip-edit')).toBe(rename);
  expect(document.activeElement).toBe(rename);
});

it('knows which editors are still standing: one is gone once its form closes or is replaced', async () => {
  await show(drawn());
  await tab('Map');
  await click(button('Add boundary'));
  await settle();
  const first = editor();
  expect(first.destroyed).toBe(false);
  await click(button('Cancel', must(host.querySelector('.side-panel'))));
  await settle();
  expect(first.destroyed).toBe(true);
  // A second form's editor is the one settle() waits for, whatever the first left behind.
  await click(button('Add boundary'));
  await settle();
  expect(fakeEditors.filter((fake) => !fake.destroyed)).toHaveLength(
    document.querySelectorAll('.md-rich').length,
  );
});

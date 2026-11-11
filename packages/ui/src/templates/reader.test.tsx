// @vitest-environment jsdom
/** The reader: mail's read state, the full-screen story, its keys, and the deep link. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import type { TemplateViewProps } from './index';
import { ReaderView } from './reader';

const router = vi.hoisted(() => {
  const search: Record<string, unknown> = {};
  return { search, navigate: vi.fn(), back: vi.fn() };
});
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: router.navigate, history: { back: router.back } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { search: router.search } }),
}));
vi.mock('../lib/api', () => ({
  api: { blips: { get: vi.fn(), update: vi.fn() } },
  ApiError: class extends Error {},
}));

// The full-message viewer is its own suite; here it only has to be the thing drawn for an email.
vi.mock('../components/email-content', () => ({
  EmailContent: ({ blip }: { blip: BlipDto }) => <div data-testid="email">{blip.id}</div>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const blip = (id: string, patch: Partial<BlipDto> = {}) =>
  ({
    id,
    radarId: 'r1',
    title: `Story ${id}`,
    body: `Body of ${id}`,
    url: `https://news.example.com/${id}`,
    preview: null,
    status: 'unread',
    state: 'inbox',
    tags: [],
    attachments: [],
    commentCount: 0,
    createdAt: '2026-11-02T12:00:00.000Z',
    ...patch,
  }) as unknown as BlipDto;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const onChanged = vi.fn();
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.blips.get).mockReset();
  vi.mocked(api.blips.update)
    .mockReset()
    .mockResolvedValue({ blip: blip('x') });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  router.search = {};
  router.navigate.mockClear();
  router.back.mockClear();
  onChanged.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = (blips: BlipDto[], extra: Partial<TemplateViewProps> = {}) =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ReaderView
          radar={{ id: 'r1', template: 'reading', templateConfig: null } as unknown as RadarDto}
          blips={blips}
          readOnly={false}
          loading={false}
          loadingMore={false}
          hasMore={false}
          onLoadMore={vi.fn()}
          onChanged={onChanged}
          emptyTitle="Nothing"
          emptyHint=""
          {...extra}
        />
      </QueryClientProvider>,
    ),
  );
const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const press = (key: string) =>
  act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

it('draws unread stories with a dot and read ones muted, with Mark unread only on the read', () => {
  show([blip('a'), blip('b', { status: 'reading' })]);
  const rows = host.querySelectorAll('.read-row');
  expect(rows[0]?.hasAttribute('data-unread')).toBe(true);
  expect(rows[1]?.hasAttribute('data-unread')).toBe(false);
  expect(rows[0]?.querySelector('.read-row-act')).toBeNull();
  expect(rows[1]?.querySelector('.read-row-act')?.textContent).toBe('Mark unread');
  // No lane dropdown, and no comment affordance, in the list.
  expect(host.querySelector('select, [role=combobox], .select-trigger')).toBeNull();
  expect(host.textContent).not.toMatch(/comment/i);
});

it('opens the story ?sel= names in a full-screen layer and reads it', () => {
  router.search = { sel: 'a' };
  show([blip('a'), blip('b')]);
  expect(q('.reader[role=dialog]')).not.toBeNull();
  expect(q('.reader-title')?.textContent).toBe('Story a');
  expect(q('.reader-meta')?.textContent).toContain('news.example.com');
  expect(q('.reader a[href="https://news.example.com/a"]')?.textContent).toContain('Open original');
  expect(q('.reader-body')?.textContent).toContain('Body of a');
  expect(q('.reader')?.textContent).not.toMatch(/comment/i);
  expect(api.blips.update).toHaveBeenCalledWith('a', { status: 'reading' });
});

it('does not re-read a story that is already read, and never reads in a read-only view', () => {
  router.search = { sel: 'a' };
  show([blip('a', { status: 'reading' })]);
  expect(api.blips.update).not.toHaveBeenCalled();
  show([blip('a')], { readOnly: true });
  expect(api.blips.update).not.toHaveBeenCalled();
  expect(q('.reader-bar')?.textContent).not.toContain('Mark unread');
});

it('u marks the open story unread, once, and does not read it again', async () => {
  router.search = { sel: 'a' };
  show([blip('a', { status: 'reading' })]);
  press('u');
  expect(api.blips.update).toHaveBeenCalledWith('a', { status: 'unread' });
  expect(api.blips.update).toHaveBeenCalledTimes(1);
});

it('steps with arrows and j/k by replacing the address, and Esc closes', () => {
  router.search = { sel: 'b' };
  show([blip('a'), blip('b'), blip('c')]);
  const step = (key: string) => {
    router.navigate.mockClear();
    press(key);
    const call = router.navigate.mock.calls[0]?.[0] as {
      search: (p: object) => { sel: string };
      replace: boolean;
    };
    return { sel: call.search({}).sel, replace: call.replace };
  };
  expect(step('ArrowRight')).toEqual({ sel: 'c', replace: true });
  expect(step('j')).toEqual({ sel: 'c', replace: true });
  expect(step('ArrowLeft')).toEqual({ sel: 'a', replace: true });
  expect(step('k')).toEqual({ sel: 'a', replace: true });
  // Opened from a deep link (nothing pushed), Esc clears `sel` rather than leaving the app.
  router.navigate.mockClear();
  press('Escape');
  expect(router.navigate).toHaveBeenCalledOnce();
});

it('fetches an id beyond the loaded page alone, and never shows a different story', async () => {
  router.search = { sel: 'far' };
  vi.mocked(api.blips.get).mockResolvedValue({ blip: blip('far') });
  show([blip('a')]);
  expect(q('.reader-title')).toBeNull();
  expect(q('.reader')?.textContent).not.toContain('Story a');
  await act(async () => void (await new Promise((done) => setTimeout(done, 20))));
  expect(api.blips.get).toHaveBeenCalledWith('far');
  expect(q('.reader-title')?.textContent).toBe('Story far');
});

it('says so when the named story is on another radar or gone, and shows nothing else', async () => {
  router.search = { sel: 'elsewhere' };
  vi.mocked(api.blips.get).mockResolvedValue({ blip: blip('elsewhere', { radarId: 'r2' }) });
  show([blip('a')]);
  await act(async () => void (await new Promise((done) => setTimeout(done, 20))));
  expect(q('.reader-title')).toBeNull();
  expect(q('.reader')?.textContent).toContain('not available');
});

it('moves focus into the reader, traps Tab inside it, and leaves the list inert', () => {
  router.search = { sel: 'a' };
  show([blip('a'), blip('b')]);
  const layer = q('.reader');
  expect(layer?.contains(document.activeElement)).toBe(true);
  // The list behind is inert, so Tab and Enter cannot reach it.
  expect(host.querySelector('.read-list')?.closest('[inert]')).not.toBeNull();
  const stops = [
    ...(layer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []),
  ];
  const tab = (shiftKey: boolean) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    act(() => void document.activeElement?.dispatchEvent(event));
    return event.defaultPrevented;
  };
  stops.at(-1)?.focus();
  expect(tab(false)).toBe(true);
  expect(document.activeElement).toBe(stops[0]);
  expect(tab(true)).toBe(true);
  expect(document.activeElement).toBe(stops.at(-1));
});

it('gives focus back to the story row when the reader closes', () => {
  router.search = { sel: 'b' };
  show([blip('a'), blip('b')]);
  router.search = {};
  show([blip('a'), blip('b')]);
  expect(q('.reader')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[data-blip-id="b"] .read-row-main'));
});

it('ignores the shortcuts typed into a field or held with a modifier', () => {
  router.search = { sel: 'a' };
  show([blip('a', { status: 'reading' }), blip('b')]);
  const field = Object.assign(document.createElement('input'), { type: 'text' });
  document.body.append(field);
  const send = (target: Element, init: KeyboardEventInit) =>
    act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })));
  send(field, { key: 'u' });
  send(field, { key: 'j' });
  send(document.body, { key: 'u', ctrlKey: true });
  send(document.body, { key: 'j', metaKey: true });
  send(document.body, { key: 'J', shiftKey: true });
  field.remove();
  expect(api.blips.update).not.toHaveBeenCalled();
  expect(router.navigate).not.toHaveBeenCalled();
});

it('draws a captured email with its full-message viewer, not the truncated body', () => {
  router.search = { sel: 'm' };
  show([
    blip('m', {
      status: 'reading',
      body: 'truncated original',
      email: { subject: 'Hi', notes: 'my note' } as unknown as NonNullable<BlipDto['email']>,
    }),
  ]);
  expect(q('.reader [data-testid=email]')?.textContent).toBe('m');
  expect(q('.reader')?.textContent).toContain('my note');
  expect(q('.reader')?.textContent).not.toContain('truncated original');
});

it('keeps the shared due date on a story, in the list and in the reader', () => {
  router.search = { sel: 'd' };
  show([blip('d', { status: 'reading', dueAt: '2099-01-01T12:00:00.000Z' })]);
  expect(host.querySelector('[data-blip-id="d"] .due-chip')?.textContent).toContain('Due');
  expect(q('.reader .due-chip')?.textContent).toContain('Due');
});

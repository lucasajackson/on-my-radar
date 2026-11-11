// @vitest-environment jsdom
/** The decision log's index / open decision / context, and which decision is open when. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import type { TemplateViewProps } from './index';
import { LogView } from './log';

const router = vi.hoisted(() => {
  const search: Record<string, unknown> = {};
  return { search, navigate: vi.fn() };
});
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: router.navigate, history: { back: vi.fn() } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { search: router.search } }),
}));
vi.mock('../components/blips', () => ({
  BlipCard: ({ blip }: { blip: BlipDto }) => <div data-testid="card">{blip.id}</div>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const T0 = '2026-11-02T12:00:00.000Z';
const entry = (id: string, status: string, patch: Partial<BlipDto> = {}) =>
  ({
    id,
    title: `Decision ${id}`,
    body: '',
    status,
    state: 'inbox',
    tags: [],
    pinned: false,
    createdAt: T0,
    lastActivityAt: T0,
    author: { id: 'u', name: 'Lucas', email: 'l@example.com' },
    agent: null,
    voice: null,
    supersedes: null,
    supersededBy: null,
    ...patch,
  }) as unknown as BlipDto;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  router.search = {};
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = (blips: BlipDto[]) =>
  act(() =>
    root.render(
      <LogView
        {...({
          radar: { id: 'r1', template: 'decisions', templateConfig: null } as unknown as RadarDto,
          blips,
          readOnly: false,
          loading: false,
          loadingMore: false,
          hasMore: false,
          onLoadMore: vi.fn(),
          onChanged: vi.fn(),
          emptyTitle: 'Nothing',
          emptyHint: '',
        } satisfies TemplateViewProps)}
      />,
    ),
  );
const rows = () => [...host.querySelectorAll('.cols-index .disc-topic')];

it('indexes every entry under its lane, keeps the ledger whole, and opens the first', () => {
  show([entry('a', 'proposed'), entry('b', 'accepted'), entry('c', 'rejected')]);
  expect(rows()).toHaveLength(3);
  expect(host.querySelector('.cols')?.getAttribute('data-view')).toBe('ledger');
  // The ledger below 1000px still carries every card; only one is the open one.
  expect(host.querySelectorAll('.log-entry')).toHaveLength(3);
  expect(host.querySelector('.log-entry[data-open]')?.textContent).toContain('a');
  expect(host.querySelector('.cols-panel')?.textContent).toContain('Proposed');
});

it('opens the decision the address names, and choosing a row writes it to the address', () => {
  router.search = { sel: 'b' };
  show([entry('a', 'proposed'), entry('b', 'accepted')]);
  expect(host.querySelector('.log-entry[data-open]')?.textContent).toContain('b');
  expect(rows()[1]?.getAttribute('aria-current')).toBe('true');
  act(() => (rows()[0] as HTMLElement).click());
  expect(router.navigate).toHaveBeenCalledOnce();
});

it('holds the open decision when the radar reorders itself under the reader', () => {
  show([entry('a', 'proposed'), entry('b', 'accepted')]);
  show([entry('b', 'accepted'), entry('a', 'proposed')]);
  expect(host.querySelector('.log-entry[data-open]')?.textContent).toContain('a');
});

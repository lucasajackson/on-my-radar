// @vitest-environment jsdom
/**
 * A card's swipe does what the contract says (`triage.ts`), not what the card
 * used to decide for itself: the lane on a lane template, a gradient for
 * defer, and no gesture on the timeline.
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { BlipCard } from './blips';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const blip = (fields: Partial<BlipDto>) =>
  ({
    id: 'b1',
    radarId: 'r1',
    kind: 'note',
    title: null,
    body: 'Something',
    url: null,
    preview: null,
    state: 'inbox',
    status: null,
    pinned: false,
    tags: [],
    attachments: [],
    commentCount: 0,
    reactions: [],
    author: null,
    agent: null,
    voice: null,
    mentions: [],
    email: null,
    dueAt: null,
    reminder: null,
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...fields,
  }) as unknown as BlipDto;

function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 });
  Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 1 } });
  return event;
}

async function swipe(card: BlipDto, template: string, direction: 'right' | 'left') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.setPointerCapture = () => undefined;
  const update = vi.spyOn(api.blips, 'update').mockResolvedValue({ blip: card });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <BlipCard
          blip={card}
          readOnly={false}
          onChanged={vi.fn()}
          swipe
          template={{ template, templateConfig: {} }}
        />
      </QueryClientProvider>,
    ),
  );
  const surface = host.querySelector<HTMLElement>('.swipe-surface');
  const to = direction === 'right' ? 220 : -220;
  if (surface) {
    await act(async () => surface.dispatchEvent(pointer('pointerdown', 0)));
    await act(async () => surface.dispatchEvent(pointer('pointermove', to / 10)));
    await act(async () => surface.dispatchEvent(pointer('pointermove', to)));
    await act(async () => surface.dispatchEvent(pointer('pointerup', to)));
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => root.unmount());
  host.remove();
  return update;
}

it('moves a reading-list blip to its Finished lane, not a bare state', async () => {
  const update = await swipe(blip({ status: 'unread' }), 'reading', 'right');
  expect(update).toHaveBeenCalledWith('b1', { status: 'finished' });
});

it('drops a blip already filed Later, rather than bringing it back', async () => {
  const update = await swipe(blip({ state: 'later' }), 'stream', 'left');
  expect(update).toHaveBeenCalledWith('b1', { state: 'dropped' });
});

it('reopens a done blip to active, not to the inbox', async () => {
  const update = await swipe(blip({ state: 'done' }), 'stream', 'right');
  expect(update).toHaveBeenCalledWith('b1', { state: 'active' });
});

it('does nothing on a timeline post, where triage shows nowhere', async () => {
  const update = await swipe(blip({}), 'microblog', 'right');
  expect(update).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { QuickDropDialog } from './quick-drop';
import { Composer } from './composer';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
  vi.spyOn(api.radars, 'members').mockResolvedValue({ members: [], agents: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>),
  );
  return {
    unmount: () => act(async () => root.unmount()),
  };
}

async function type(selector: string, text: string) {
  const field = must(document.querySelector<HTMLTextAreaElement>(selector), selector);
  await act(async () => {
    setNativeValue(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps the quick drop text through Escape and reopening, and clears it once sent', async () => {
  const first = await mount(<QuickDropDialog dropBoxId="drop" onClose={vi.fn()} />);
  await type('#quick-drop', 'call the plumber');
  await first.unmount(); // Escape closes the dialog, which unmounts it.

  const second = await mount(<QuickDropDialog dropBoxId="drop" onClose={vi.fn()} />);
  expect(must(document.querySelector<HTMLTextAreaElement>('#quick-drop')).value).toBe(
    'call the plumber',
  );
  vi.spyOn(api.radars, 'createBlip').mockResolvedValue({ blip: { id: 'b1' } as BlipDto });
  const send = must(document.querySelector<HTMLButtonElement>('[data-omr="drop-submit"]'));
  await act(async () => send.click());
  await second.unmount();

  await mount(<QuickDropDialog dropBoxId="drop" onClose={vi.fn()} />);
  expect(must(document.querySelector<HTMLTextAreaElement>('#quick-drop')).value).toBe('');
});

it("keeps each radar's unsent capture when you leave it, and only that radar's", async () => {
  const onA = await mount(<Composer radarId="a" onCaptured={vi.fn()} />);
  await type('#composer', 'half a thought');
  await onA.unmount();

  const onB = await mount(<Composer radarId="b" onCaptured={vi.fn()} />);
  expect(must(document.querySelector<HTMLTextAreaElement>('#composer')).value).toBe('');
  await onB.unmount();

  await mount(<Composer radarId="a" onCaptured={vi.fn()} />);
  expect(must(document.querySelector<HTMLTextAreaElement>('#composer')).value).toBe(
    'half a thought',
  );
});

// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PanelHostProvider, SidePanel, usePanelHost } from '../components/side-panel';
import { DESKTOP_QUERY } from './viewport';
import { useSidePanelOpen } from './side-panel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLElement;
let root: Root;
let desktop = true;
const listeners = new Set<() => void>();
const resize = async (next: boolean) => {
  desktop = next;
  await act(async () => listeners.forEach((listener) => listener()));
};
beforeEach(() => {
  desktop = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return desktop && query === DESKTOP_QUERY;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  listeners.clear();
  vi.unstubAllGlobals();
});

function Watch() {
  return <output>{useSidePanelOpen() ? 'open' : 'closed'}</output>;
}
/** A card with a slot for the panel, as a radar tab draws one, and the panel drawn once. */
function Card({ open, onClose = vi.fn() }: { open: boolean; onClose?: () => void }) {
  const panelHost = usePanelHost();
  const [typed, setTyped] = useState('');
  return (
    <PanelHostProvider value={panelHost.value}>
      <Watch />
      <div className="card">
        {panelHost.desktop && open ? (
          <div ref={panelHost.setSlot} className="side-panel-slot" />
        ) : null}
      </div>
      {open ? (
        <SidePanel title="Contract" onClose={onClose} footer={<button type="button">Save</button>}>
          <input aria-label="Name" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </SidePanel>
      ) : null}
    </PanelHostProvider>
  );
}
const state = () => host.querySelector('output')?.textContent;

it('is a column of the card from 1024px, is announced to the shell while open, and closes on Escape', async () => {
  const close = vi.fn();
  await act(async () => root.render(<Card open onClose={close} />));
  expect(state()).toBe('open');
  expect(host.querySelector('.side-panel-slot section.side-panel')).not.toBeNull();
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await act(async () =>
    host
      .querySelector('input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(close).toHaveBeenCalled();
  await act(async () => root.render(<Card open={false} />));
  // Closed, the shell is told, so a sidebar furled for the panel opens again.
  expect(state()).toBe('closed');
});

it('is a full-height sheet below 1024px, which the shell is not told about', async () => {
  desktop = false;
  await act(async () => root.render(<Card open />));
  expect(state()).toBe('closed');
  const sheet = document.querySelector('.modal-panel.is-side');
  expect(sheet?.getAttribute('role')).toBe('dialog');
  expect(sheet?.textContent).toContain('Save');
});

it('is the same panel, not a new one, when the window crosses 1024px, with its DOM and focus moved', async () => {
  await act(async () => root.render(<Card open />));
  const input = host.querySelector('input') as HTMLInputElement;
  input.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'half typed',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const next of [false, true, false]) {
    await resize(next);
    // The very same element: it was moved, never made again.
    expect(document.querySelector('input')).toBe(input);
    expect(input.value).toBe('half typed');
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('.modal-panel.is-side') !== null).toBe(!next);
    expect(state()).toBe(next ? 'open' : 'closed');
  }
});

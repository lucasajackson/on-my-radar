// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRadarHeaderHeight } from './header-height';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLElement;
let root: Root;
let height = 99.75;
let observed: (() => void) | null = null;
let disconnected = 0;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {
        disconnected += 1;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ height }) as DOMRect,
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observed = null;
  disconnected = 0;
});

function Radar({ shown }: { shown: boolean }) {
  const ref = useRadarHeaderHeight();
  return (
    <div data-radar-column>
      {shown ? <header ref={ref}>Architecture</header> : null}
      <div className="bar">the sticky bar</div>
    </div>
  );
}
const column = () => host.querySelector<HTMLElement>('[data-radar-column]');

it('publishes the header height, rounded up, on the radar column the bar is also in', async () => {
  await act(async () => root.render(<Radar shown />));
  expect(column()?.style.getPropertyValue('--radar-header-h')).toBe('100px');
  // The tagline wrapped: the header is 118px and the bar follows it.
  height = 118;
  await act(async () => observed?.());
  expect(column()?.style.getPropertyValue('--radar-header-h')).toBe('118px');
});

it('lets the property go when the header does, so nothing is placed by a stale height', async () => {
  height = 100;
  await act(async () => root.render(<Radar shown />));
  expect(column()?.style.getPropertyValue('--radar-header-h')).toBe('100px');
  await act(async () => root.render(<Radar shown={false} />));
  expect(column()?.style.getPropertyValue('--radar-header-h')).toBe('');
  expect(disconnected).toBeGreaterThan(0);
});

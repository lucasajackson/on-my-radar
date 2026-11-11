// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { must } from '../lib/must';
import { ToastHost, notify } from './primitives';

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ToastHost />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const undo = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Undo');

it('keeps an undo on screen for at least six seconds', async () => {
  await act(async () => notify('Moved to Done', 'ok', { label: 'Undo', run: vi.fn() }));
  await act(async () => {
    vi.advanceTimersByTime(6_000);
  });
  expect(undo()).toBeDefined();
});

it('holds an undo while the pointer or focus is on it, and lets it go after', async () => {
  await act(async () => notify('Moved to Done', 'ok', { label: 'Undo', run: vi.fn() }));
  const toast = must(must(undo()).parentElement);
  await act(async () => {
    vi.advanceTimersByTime(5_000);
    toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(undo()).toBeDefined();
  await act(async () => {
    toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(undo()).toBeUndefined();
});

it('lets an acknowledgement go quickly', async () => {
  await act(async () => notify('Saved'));
  await act(async () => {
    vi.advanceTimersByTime(3_300);
  });
  expect(document.body.textContent).not.toContain('Saved');
});

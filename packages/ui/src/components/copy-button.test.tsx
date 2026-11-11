// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button';
import { ToastHost } from './primitives';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount(writeText: (value: string) => Promise<void>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <>
        <CopyButton value="omr_secret" />
        <ToastHost />
      </>,
    ),
  );
  return { host, root };
}

it('says Copied only when the clipboard actually took it', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const { host, root } = await mount(writeText);
  await act(async () => host.querySelector('button')?.click());
  expect(writeText).toHaveBeenCalledWith('omr_secret');
  expect(host.querySelector('button')?.textContent).toBe('Copied');
  await act(async () => root.unmount());
});

it('tells the person when the clipboard refuses, instead of doing nothing', async () => {
  const { host, root } = await mount(() => Promise.reject(new DOMException('Denied')));
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelector('button')?.textContent).toBe('Copy');
  expect(document.body.textContent).toContain('Could not copy');
  await act(async () => root.unmount());
});

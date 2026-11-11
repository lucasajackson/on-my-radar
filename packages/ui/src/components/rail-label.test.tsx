// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { RailLabel } from './rail-label';

afterEach(() => {
  document.body.innerHTML = '';
});

function pointerOver(target: Element) {
  const event = new MouseEvent('pointerover', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  target.dispatchEvent(event);
}

function Rail({ enabled }: { enabled: boolean }) {
  const rail = useRef<HTMLElement>(null);
  return (
    <aside ref={rail}>
      <RailLabel enabled={enabled} container={rail} />
      <a href="/a" data-rail-label="Activity" data-rail-meta="4" data-rail-hot="true">
        bell
      </a>
      <a href="/b" data-rail-label="Quick drop" data-rail-meta="⌘K">
        pen
      </a>
    </aside>
  );
}

async function render(enabled: boolean) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Rail enabled={enabled} />));
  return host;
}

it('floats the name and count of the item under the pointer, out of the page flow', async () => {
  const host = await render(true);
  await act(async () => pointerOver(host.querySelector('[data-rail-label="Activity"]') as Element));
  const label = document.querySelector('.rail-label');
  expect(label?.textContent).toBe('Activity4');
  expect(label?.querySelector('.is-hot')?.textContent).toBe('4');
  // Portaled to the body, and silent: the item's own name is the spoken one.
  expect(label?.parentElement).toBe(document.body);
  expect(label?.getAttribute('aria-hidden')).toBe('true');
  await act(async () =>
    pointerOver(host.querySelector('[data-rail-label="Quick drop"]') as Element),
  );
  expect(document.querySelector('.rail-label')?.textContent).toBe('Quick drop⌘K');
  await act(async () => host.querySelector('aside')?.dispatchEvent(new Event('pointerleave')));
  expect(document.querySelector('.rail-label')).toBeNull();
});

it('shows nothing while the sidebar is expanded, where the names are already there', async () => {
  const host = await render(false);
  await act(async () => pointerOver(host.querySelector('[data-rail-label="Activity"]') as Element));
  expect(document.querySelector('.rail-label')).toBeNull();
});

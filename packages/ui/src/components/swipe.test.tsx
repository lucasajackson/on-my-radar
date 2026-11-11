// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SwipeRow } from './swipe';

afterEach(() => {
  document.body.innerHTML = '';
});

/** jsdom has no PointerEvent; React reads these fields off whatever arrives. */
function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 });
  Object.defineProperties(event, {
    pointerType: { value: 'touch' },
    pointerId: { value: 1 },
  });
  return event;
}

async function swipePastTheLineThen(ending: 'pointerup' | 'pointercancel') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.setPointerCapture = () => undefined;
  const run = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SwipeRow left={{ label: 'Done', icon: null, run }}>
        <p>A blip</p>
      </SwipeRow>,
    ),
  );
  const surface = host.querySelector<HTMLElement>('.swipe-surface');
  await act(async () => {
    surface?.dispatchEvent(pointer('pointerdown', 0));
  });
  await act(async () => {
    surface?.dispatchEvent(pointer('pointermove', 20));
  });
  await act(async () => {
    surface?.dispatchEvent(pointer('pointermove', 200));
  });
  await act(async () => {
    surface?.dispatchEvent(pointer(ending, 200));
  });
  await act(async () => root.unmount());
  return run;
}

it('commits a swipe released past the line', async () => {
  expect(await swipePastTheLineThen('pointerup')).toHaveBeenCalledOnce();
});

it('never commits when the system cancels the gesture, however far it had gone', async () => {
  expect(await swipePastTheLineThen('pointercancel')).not.toHaveBeenCalled();
});

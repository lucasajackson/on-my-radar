// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './primitives';
import { must } from '../lib/must';

let root: Root;
let host: HTMLDivElement;
let trigger: HTMLButtonElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  trigger.remove();
});

const show = async (onClose = vi.fn()) => {
  await act(async () =>
    root.render(
      <Modal title="Create radar" onClose={onClose} footer={<button>Save</button>}>
        <input aria-label="Name" autoFocus />
        <input aria-label="Description" />
      </Modal>,
    ),
  );
};

const press = (key: string, shiftKey = false) =>
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  );

describe('Modal keyboard navigation', () => {
  it('keeps keyboard and programmatic focus inside the dialog, then restores the trigger', async () => {
    await show();
    expect(document.activeElement).toBe(document.querySelector('[role=dialog] input'));
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role=dialog] button');
    must(buttons[buttons.length - 1]).focus();
    press('Tab');
    expect(document.activeElement).toBe(buttons[0]);
    press('Tab', true);
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    trigger.focus();
    expect(document.querySelector('[role=dialog]')?.contains(document.activeElement)).toBe(true);
    expect(host.inert).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(trigger);
    expect(host.inert).not.toBe(true);
    expect(host.hasAttribute('aria-hidden')).toBe(false);
  });

  it('keeps the current field focused on rerender and calls the latest close callback', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    await show(first);
    const secondField = must(document.querySelectorAll<HTMLInputElement>('[role=dialog] input')[1]);
    secondField.focus();
    await show(latest);
    expect(document.activeElement).toBe(secondField);
    press('Escape');
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
});

it('isolates only the top nested dialog and restores the enclosing dialog on close', async () => {
  const render = (nested: boolean) => (
    <Modal title="Outer" onClose={vi.fn()}>
      <input aria-label="Outer field" />
      {nested ? (
        <Modal title="Inner" onClose={vi.fn()}>
          <input aria-label="Inner field" autoFocus />
        </Modal>
      ) : null}
    </Modal>
  );
  await act(async () => root.render(render(true)));
  const outer = must(document.querySelector<HTMLElement>('[aria-label="Outer"]'));
  const inner = must(document.querySelector<HTMLElement>('[aria-label="Inner"]'));
  expect(must(outer.parentElement).inert).toBe(true);
  expect(must(inner.parentElement).inert).not.toBe(true);
  expect(document.activeElement).toBe(inner.querySelector('input'));
  await act(async () => root.render(render(false)));
  expect(must(outer.parentElement).inert).not.toBe(true);
  expect(host.inert).toBe(true);
  expect(outer.contains(document.activeElement)).toBe(true);
});

it('leaves a key alone that something inside the dialog already handled', async () => {
  // A mention menu or a completion list closes itself on Escape and accepts on
  // Tab. The dialog must not also close, or move focus, on the same keystroke.
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <Modal title="Reply" onClose={onClose} footer={<button>Send</button>}>
        <input
          aria-label="Reply"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') event.preventDefault();
          }}
        />
      </Modal>,
    ),
  );
  const field = document.querySelector<HTMLInputElement>('[role=dialog] input');
  field?.focus();
  for (const key of ['Escape', 'Tab']) {
    field?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(field);
});

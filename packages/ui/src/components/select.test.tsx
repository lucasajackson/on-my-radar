// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Select } from './select';
import { Modal } from './primitives';
import { must } from '../lib/must';
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const options = [
  { value: '', label: 'No topic' },
  { value: 'work', label: 'Work' },
  { value: 'locked', label: 'Locked', disabled: true },
];
const key = async (node: Element, value: string) => {
  await act(async () =>
    node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })),
  );
};
it('keeps empty choices selectable and submits the application value', async () => {
  function Form() {
    const [value, setValue] = useState('work');
    return (
      <form>
        <Select
          name="topic"
          aria-label="Topic"
          value={value}
          onValueChange={setValue}
          options={options}
        />
      </form>
    );
  }
  await act(async () => root.render(<Form />));
  const trigger = must(host.querySelector('[role=combobox]'));
  await key(trigger, 'ArrowDown');
  const empty = document.querySelector('[role=option][data-value=""]') as HTMLElement;
  expect(empty).not.toBeNull();
  await act(async () => empty.focus());
  await key(empty, 'Enter');
  expect(trigger.textContent).toContain('No topic');
  expect(new FormData(must(host.querySelector('form'))).get('topic')).toBe('');
});
it('keeps options inside the modal and Escape closes only the menu before restoring focus', async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <Modal title="Settings" onClose={close}>
        <Select aria-label="Topic" value="work" onValueChange={() => {}} options={options} />
      </Modal>,
    ),
  );
  const trigger = document.querySelector('[role=combobox]') as HTMLElement;
  await key(trigger, 'ArrowDown');
  const list = must(document.querySelector('[role=listbox]'));
  expect(list.closest('[role=dialog]')).not.toBeNull();
  await key(must(document.activeElement), 'Escape');
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role=listbox]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await key(trigger, 'Escape');
  expect(close).toHaveBeenCalledOnce();
});
it('retains required validation for an empty placeholder', async () => {
  await act(async () =>
    root.render(
      <form>
        <Select
          required
          aria-label="History"
          value=""
          onValueChange={() => {}}
          options={[
            { value: '', label: 'Choose history', disabled: true },
            { value: 'week', label: 'Past week' },
          ]}
        />
      </form>,
    ),
  );
  expect(must(host.querySelector('form')).checkValidity()).toBe(false);
  expect(must(host.querySelector('[role=combobox]')).textContent).toContain('Choose history');
});

it('leaves nothing hidden or inert after a menu opens and closes inside a dialog', async () => {
  // Radix hides everything outside an open menu, and the dialog makes the rest
  // of the page inert. The two restore in different orders; the page must end
  // up exactly as it began either way.
  const render = (open: boolean) =>
    root.render(
      open ? (
        <Modal title="Settings" onClose={() => undefined}>
          <input aria-label="Name" />
          <Select
            aria-label="Topic"
            value="work"
            onValueChange={() => undefined}
            options={options}
          />
        </Modal>
      ) : null,
    );
  await act(async () => render(true));
  const field = must(document.querySelector('[role=dialog] input'), 'the dialog field');
  await key(must(document.querySelector('[role=combobox]'), 'the select'), 'ArrowDown');
  expect(document.querySelector('[role=listbox]')).not.toBeNull();
  await key(must(document.activeElement, 'the open menu'), 'Escape');
  expect(document.querySelector('[role=listbox]')).toBeNull();
  // The dialog is usable again: its own contents are not hidden from assistive tech.
  expect(field.closest('[aria-hidden="true"]')).toBeNull();
  await act(async () => render(false));
  // aria-hidden only: jsdom does not reflect `.inert` to an attribute, so an
  // `[inert]` query here would pass whatever happened. Checked to fail when the
  // isolation stops restoring aria-hidden.
  const hidden = Array.from(document.body.querySelectorAll('[aria-hidden="true"]'));
  expect(hidden.filter((element) => !element.matches('svg, svg *'))).toEqual([]);
  expect(
    Array.from(document.body.children).some(
      (element) => element instanceof HTMLElement && element.inert,
    ),
  ).toBe(false);
});

it('labels groups, shows a description only in the menu, and picks across groups', async () => {
  const picked = vi.fn();
  await act(async () =>
    root.render(
      <Select
        aria-label="Tool"
        value="codex"
        onValueChange={picked}
        groups={[
          {
            label: 'This agent’s profiles',
            options: [{ value: 'codex', label: 'Codex CLI', description: 'reads AGENTS.md' }],
          },
          {
            label: 'Add a profile for…',
            options: [{ value: 'cursor', label: 'Cursor', description: 'reads .cursor/rules' }],
          },
        ]}
      />,
    ),
  );
  const trigger = must(host.querySelector('[role=combobox]'));
  // The trigger carries the label, never the description line.
  expect(trigger.textContent).toContain('Codex CLI');
  expect(trigger.textContent).not.toContain('reads AGENTS.md');
  await key(trigger, 'ArrowDown');
  const labels = Array.from(document.querySelectorAll('.select-group-label')).map(
    (node) => node.textContent,
  );
  expect(labels).toEqual(['This agent’s profiles', 'Add a profile for…']);
  const cursor = must(document.querySelector<HTMLElement>('[role=option][data-value="cursor"]'));
  expect(cursor.textContent).toContain('reads .cursor/rules');
  await act(async () => cursor.focus());
  await key(cursor, 'Enter');
  expect(picked).toHaveBeenCalledWith('cursor');
});

it('keeps a primary menu on its placeholder, so it reads as an action rather than a value', async () => {
  await act(async () =>
    root.render(
      <Select
        aria-label="Use in a tool"
        tone="primary"
        value=""
        placeholder="Use in…"
        onValueChange={() => undefined}
        options={[{ value: 'codex', label: 'Codex CLI' }]}
      />,
    ),
  );
  const trigger = must(host.querySelector('[role=combobox]'));
  expect(trigger.className).toContain('is-primary');
  expect(trigger.textContent).toContain('Use in…');
});

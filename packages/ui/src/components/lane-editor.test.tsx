// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { LaneEditor } from './lane-editor';

let root: Root;
let host: HTMLDivElement;
const radar = { id: 'r1', template: 'kanban', templateConfig: {} };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = (text: string) =>
  must(
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text,
    ),
    text,
  );
const nameField = (n: number) =>
  must(document.querySelector<HTMLInputElement>(`input[aria-label="Lane ${n} name"]`));
const rows = () => document.querySelectorAll('ol.lane-editor > .lane-editor-row').length;

async function rename(n: number, value: string) {
  await act(async () => {
    setNativeValue(nameField(n), value);
    nameField(n).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function open(onSaved = vi.fn()) {
  await act(async () =>
    root.render(<LaneEditor radar={radar} onClose={vi.fn()} onSaved={onSaved} />),
  );
}

it('renames in place, adds a lane named from its label, and sends the set in board order', async () => {
  const update = vi.spyOn(api.radars, 'update').mockResolvedValue({} as never);
  const onSaved = vi.fn();
  await open(onSaved);
  await rename(1, 'Someday');
  await act(async () => button('Add lane').click());
  await rename(rows(), 'Review');
  await act(async () => button('Save lanes').click());
  const lanes = must(must(update.mock.calls[0])[1].templateConfig?.lanes);
  expect(lanes[0]).toEqual({ id: 'backlog', label: 'Someday', state: 'inbox' });
  expect(lanes.at(-1)).toEqual({ id: 'review', label: 'Review', state: 'active' });
  expect(onSaved).toHaveBeenCalled();
});

it("shows the contract's own problems and will not send a set it refuses", async () => {
  const update = vi.spyOn(api.radars, 'update');
  await open();
  // Down to one lane: below the minimum the contract allows.
  while (rows() > 1) {
    const remove = must(document.querySelector<HTMLButtonElement>('[aria-label^="Remove"]'));
    await act(async () => remove.click());
  }
  expect(must(document.querySelector('.lane-editor-problems')).textContent).toContain(
    'at least 2 lanes',
  );
  await act(async () => button('Save lanes').click());
  expect(update).not.toHaveBeenCalled();
});

it('puts the caret in a new lane, and says nothing about it until it has been left', async () => {
  await open();
  await act(async () => button('Add lane').click());
  const fresh = nameField(rows());
  expect(document.activeElement).toBe(fresh);
  // Empty and untouched: no complaint yet.
  expect(document.body.textContent).not.toContain('needs a name');
  await act(async () => fresh.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(document.body.textContent).toContain(`Lane ${rows()} needs a name`);
  // Never a minted id.
  expect(document.body.textContent).not.toMatch(/lane-\d/);
  expect(fresh.getAttribute('aria-invalid')).toBe('true');
});

it('names every unnamed lane on a Save attempt, and sends nothing', async () => {
  const update = vi.spyOn(api.radars, 'update');
  await open();
  await act(async () => button('Add lane').click());
  await act(async () => button('Save lanes').click());
  expect(document.body.textContent).toContain(`Lane ${rows()} needs a name`);
  expect(update).not.toHaveBeenCalled();
});

it('moves focus to the next lane when one is removed', async () => {
  await open();
  await act(async () => button('Remove Blocked').click());
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Lane \d name$/);
  expect((document.activeElement as HTMLInputElement).value).toBe('Done');
});

it('says a refused save beside the lanes, and keeps the draft', async () => {
  vi.spyOn(api.radars, 'update').mockRejectedValue(
    new ApiError(400, 'bad_request', 'Blocked still holds 3 blips. Move them first.'),
  );
  await open();
  await act(async () => button('Remove Blocked').click());
  await act(async () => button('Save lanes').click());
  expect(must(document.querySelector('[role=alert]')).textContent).toBe(
    'Blocked still holds 3 blips. Move them first.',
  );
  expect(document.querySelector('[aria-label="Remove Blocked"]')).toBeNull();
});

it('keeps focus on the move button, at the lane’s new place, however far it is moved', async () => {
  await open();
  const later = () => button('Move Backlog later');
  later().focus();
  await act(async () => later().click());
  expect(nameField(2).value).toBe('Backlog');
  expect(document.activeElement).toBe(later());
  // All the way down: at the end "later" is disabled, so focus is on "earlier".
  for (let i = 0; i < rows(); i += 1) {
    if (later().disabled) break;
    await act(async () => later().click());
  }
  expect(later().disabled).toBe(true);
  expect(document.activeElement).toBe(button('Move Backlog earlier'));
});

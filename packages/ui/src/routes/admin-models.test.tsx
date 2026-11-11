// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HARNESSES, type ModelCatalogEntryDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { AdminModelsRoute } from './admin-models';

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

const model = (over: Partial<ModelCatalogEntryDto>): ModelCatalogEntryDto => ({
  id: 'm1',
  harness: 'claude-code',
  modelId: 'opus',
  displayName: 'Opus',
  family: 'Claude',
  hidden: false,
  deprecated: false,
  sortOrder: 10,
  updatedAt: '2026-09-26T00:00:00Z',
  ...over,
});

const catalog = [
  model({ id: 'm2', modelId: 'sonnet', displayName: 'Sonnet', sortOrder: 20 }),
  model({ id: 'm1' }),
  model({ id: 'm3', harness: 'codex', modelId: 'gpt-5-codex', displayName: 'GPT-5 Codex' }),
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api.admin, 'models').mockResolvedValue({ models: catalog });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AdminModelsRoute />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
const buttonLabelled = (label: string) =>
  must(document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`));
const buttonText = (scope: ParentNode, text: string) =>
  must(
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent.trim() === text,
    ),
  );
const group = (label: string) =>
  must(host.querySelector<HTMLElement>(`section[aria-label="${label}"]`));
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('groups models by tool in tool order, sorted within, with an empty state for a tool with none', async () => {
  await render();
  const sections = Array.from(host.querySelectorAll('section[aria-label]')).map((s) =>
    s.getAttribute('aria-label'),
  );
  expect(sections.slice(0, 3)).toEqual([
    HARNESSES['claude-code'].label,
    HARNESSES.codex.label,
    HARNESSES.cursor.label,
  ]);
  const claude = group(HARNESSES['claude-code'].label);
  expect(claude.textContent).toContain(HARNESSES['claude-code'].reads);
  const names = Array.from(claude.querySelectorAll('li')).map((li) => li.textContent);
  expect(must(names[0])).toContain('Opus');
  expect(must(names[1])).toContain('Sonnet');
  expect(group(HARNESSES.cursor.label).textContent).toContain('No models listed');
  expect(host.textContent).toContain('Profiles offer these, plus Custom…');
});

it('adds a model with the fields typed, trimmed', async () => {
  const create = vi
    .spyOn(api.admin, 'createModel')
    .mockResolvedValue({ model: model({ id: 'new', modelId: 'haiku', displayName: 'Haiku' }) });
  await render();
  expect(host.querySelector('form[aria-label="Add a model"]')).toBeNull();
  await act(async () => buttonText(host, 'Add a model').click());
  const form = must(host.querySelector<HTMLFormElement>('form[aria-label="Add a model"]'));
  const inputs = form.querySelectorAll<HTMLInputElement>('input:not([type=hidden])');
  const add = buttonText(form, 'Add model');
  expect(add.disabled).toBe(true);
  await type(must(inputs[0]), ' haiku ');
  await type(must(inputs[1]), 'Haiku');
  await type(must(inputs[2]), 'Claude');
  await type(must(inputs[3]), '30');
  await act(async () => add.click());
  await settle();
  expect(create).toHaveBeenCalledWith({
    harness: 'claude-code',
    modelId: 'haiku',
    displayName: 'Haiku',
    family: 'Claude',
    sortOrder: 30,
  });
});

it('toggles Hidden without touching anything else', async () => {
  const update = vi
    .spyOn(api.admin, 'updateModel')
    .mockResolvedValue({ model: model({ hidden: true }) });
  await render();
  const row = must(buttonLabelled('Edit Opus').closest('li'));
  const hidden = buttonText(row, 'Hidden');
  expect(hidden.getAttribute('aria-pressed')).toBe('false');
  await act(async () => hidden.click());
  await settle();
  expect(update).toHaveBeenCalledWith('m1', { hidden: true });
});

it('edits inline and sends only what changed', async () => {
  const update = vi.spyOn(api.admin, 'updateModel').mockResolvedValue({ model: model({}) });
  await render();
  await act(async () => buttonLabelled('Edit Opus').click());
  const form = must(host.querySelector<HTMLFormElement>('form[aria-label="Edit Opus"]'));
  const inputs = form.querySelectorAll<HTMLInputElement>('input');
  await type(must(inputs[0]), 'Opus 4.5');
  await act(async () => buttonText(form, 'Save').click());
  await settle();
  expect(update).toHaveBeenCalledWith('m1', { displayName: 'Opus 4.5' });
});

it('deletes only after the confirmation', async () => {
  const remove = vi.spyOn(api.admin, 'removeModel').mockResolvedValue(undefined);
  await render();
  await act(async () => buttonLabelled('Delete Opus').click());
  expect(remove).not.toHaveBeenCalled();
  const dialog = must(document.querySelector<HTMLElement>('[role=dialog]'));
  expect(dialog.textContent).toContain('keep it');
  await act(async () => buttonText(dialog, 'Delete model').click());
  await settle();
  expect(remove).toHaveBeenCalledWith('m1');
});

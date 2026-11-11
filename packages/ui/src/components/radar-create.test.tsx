// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TopicDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { NewRadarDialog } from './radar-create';
import { must, setNativeValue } from '../lib/must';

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  must(
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (element) => element.textContent.trim() === text,
    ),
  );
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

it('creates an array inline without losing the radar name, description, layout or form', async () => {
  const topic = {
    id: 'topic-1',
    name: 'Research',
    archived: false,
    cascade: false,
    access: { canManage: true },
  } as TopicDto;
  let topics: TopicDto[] = [];
  vi.spyOn(api.topics, 'list').mockImplementation(async () => ({ topics }));
  const create = vi.spyOn(api.topics, 'create').mockImplementation(async () => {
    topics = [topic];
    return { topic };
  });
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NewRadarDialog onClose={onClose} onCreated={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  const name = must(document.querySelector<HTMLInputElement>('input[placeholder="New app ideas"]'));
  const tagline = must(
    document.querySelector<HTMLInputElement>('input[placeholder="Optional — what belongs here?"]'),
  );
  await type(name, 'Reading notes');
  await type(tagline, 'Interesting articles');
  const layout = must(
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="combobox"]')).find((element) =>
      element.parentElement?.textContent.startsWith('Layout'),
    ),
  );
  await act(async () => layout.click());
  const microblog = must(
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'Microblog',
    ),
  );
  await act(async () => microblog.click());
  await act(async () => button('New array').click());
  await type(
    must(document.querySelector<HTMLInputElement>('input[placeholder="Project or interest"]')),
    'Research',
  );
  await act(async () => button('Create array').click());
  expect(create).toHaveBeenCalledWith({ name: 'Research' });
  expect(name.value).toBe('Reading notes');
  expect(tagline.value).toBe('Interesting articles');
  expect(layout.textContent).toBe('Microblog');
  expect(document.querySelector('[aria-label="New radar"]')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="combobox"]')).find((element) =>
      element.parentElement?.textContent.startsWith('Array'),
    )?.textContent,
  ).toBe('Research');
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlipDto, EmailDetailDto } from '@onmyradar/contract';
import { EmailContent, emailDocument } from './email-content';
import { BlipCard } from './blips';
import { api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';

const summary = {
  subject: 'Weekend offers',
  senderName: 'Lucas',
  senderAddress: 'lucas@example.test',
  sentAt: null,
  receivedAt: '2026-09-19T10:00:00Z',
  preview: 'Tools for the workshop',
  hasHtml: true,
  legacy: false,
  notes: 'Compare prices first',
  attachmentCount: 0,
};
const blip: BlipDto = {
  id: 'email-1',
  revision: 1,
  radarId: 'radar',
  kind: 'note',
  state: 'inbox',
  status: null,
  supersedes: null,
  supersedesTitle: null,
  supersededBy: null,
  pinned: false,
  lastActivityAt: summary.receivedAt,
  archivedAt: null,
  title: 'Weekend offers',
  body: 'Original text that must stay immutable',
  url: null,
  preview: null,
  tags: [],
  attachments: [],
  reactions: [],
  commentCount: 0,
  author: null,
  agent: null,
  voice: null,
  createdAt: summary.receivedAt,
  updatedAt: summary.receivedAt,
  email: summary,
};
const detail: EmailDetailDto = {
  ...summary,
  text: blip.body,
  html: '<p>Formatted offer</p>',
  attachments: [],
  originalHref: null,
  remoteImagesBlocked: 1,
  imageOrigins: ['https://files.example.test'],
};
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
const render = async (node: React.ReactNode) =>
  act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
const flush = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
const button = (label: string) =>
  must(
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.getAttribute('aria-label') || b.textContent).trim() === label,
    ),
  );
it('loads email only when opened, isolates it, and asks before loading remote images', async () => {
  const read = vi.spyOn(api.blips, 'email').mockResolvedValue({ email: detail });
  await render(<EmailContent blip={blip} />);
  expect(read).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(blip.body);
  const trigger = button('Read email: Weekend offers');
  trigger.focus();
  await act(async () => trigger.click());
  await flush();
  expect(read).toHaveBeenCalledWith('email-1', false);
  const frame = must(document.querySelector('iframe'));
  expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin|allow-forms/);
  expect(frame.srcdoc).toContain('img-src https://files.example.test;');
  await act(async () => button('Load remote images').click());
  await flush();
  expect(read).toHaveBeenLastCalledWith('email-1', true);
  await act(async () => button('Text').click());
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('.email-reader-text')?.textContent).toBe(blip.body);
  await act(async () => button('Close email').click());
  expect(document.activeElement).toBe(trigger);
});
it('uses public authorization and gives older captures a truthful text-only fallback', async () => {
  const privateRead = vi.spyOn(api.blips, 'email');
  const publicRead = vi.spyOn(api.publicRadars, 'email').mockResolvedValue({
    email: {
      ...detail,
      legacy: true,
      hasHtml: false,
      html: null,
      senderAddress: null,
      remoteImagesBlocked: 0,
    },
  });
  await render(<EmailContent blip={blip} publicSlug="published" />);
  await act(async () => button('Read email: Weekend offers').click());
  await flush();
  expect(publicRead).toHaveBeenCalledWith('published', 'email-1', false);
  expect(privateRead).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('original layout was not saved');
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.body.textContent).not.toContain('lucas@example.test');
});
it('edits separate email notes without sending a replacement body', async () => {
  const update = vi.spyOn(api.blips, 'update').mockResolvedValue({ blip });
  await render(
    <BlipCard
      blip={blip}
      readOnly={false}
      conversation={false}
      linkTags={false}
      onChanged={vi.fn()}
    />,
  );
  await act(async () =>
    must(document.querySelector<HTMLButtonElement>('button[title="Edit"]')).click(),
  );
  const input = must(document.querySelector('textarea'));
  expect(input.value).toBe(summary.notes);
  await act(async () => {
    setNativeValue(input, 'Keep the receipt');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Save').click());
  expect(update).toHaveBeenCalledWith('email-1', {
    emailNotes: 'Keep the receipt',
    title: 'Weekend offers',
    expectedRevision: 1,
  });
});
it('builds a deny-by-default document and never grants script or form capability', () => {
  const doc = emailDocument(
    '<p>Safe server fragment</p>',
    ['https://files.example.test/path', 'http://unsafe.test', 'not a url'],
    false,
  );
  expect(doc).toContain("default-src 'none'");
  expect(doc).toContain("script-src 'none'");
  expect(doc).toContain("form-action 'none'");
  expect(doc).toContain('img-src https://files.example.test;');
  expect(doc).not.toContain('unsafe.test');
  expect(emailDocument('', [], true)).toContain('img-src https:;');
});

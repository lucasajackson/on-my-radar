// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it } from 'vitest';
import { ReadingBody } from './reading-body';
import { renderMarkdown } from '../lib/markdown';
import { must } from '../lib/must';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it('keeps long reading queues compact and reveals full accessible links on demand', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const body = `${'A useful article about gardening. '.repeat(40)} [Source](https://example.test/article)`;
  await act(async () =>
    root.render(<ReadingBody body={body} html={renderMarkdown(body)} collapsible />),
  );
  const toggle = must(host.querySelector('button'));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.textContent.length).toBeLessThan(400);
  expect(host.querySelector('a')).toBeNull();
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/article');
  expect(host.textContent).toContain('Show less');
  await act(async () => root.unmount());
  host.remove();
});

it('leaves short reading notes and other template bodies fully visible', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  for (const [body, collapsible] of [
    ['Short note', true],
    ['Long post. '.repeat(150), false],
  ] as const) {
    await act(async () =>
      root.render(
        <ReadingBody body={body} html={renderMarkdown(body)} collapsible={collapsible} />,
      ),
    );
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain(body.trim());
  }
  await act(async () => root.unmount());
});

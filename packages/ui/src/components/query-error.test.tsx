// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { QueryError } from './query-error';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

async function render(error: unknown) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryError error={error} resource="Thing" retry={vi.fn()} />));
  const text = host.textContent;
  await act(async () => root.unmount());
  host.remove();
  return text;
}

it('shows a refusal in the server’s words, without a retry that cannot help', async () => {
  const text = await render(new ApiError(400, 'bad_request', 'Unknown client'));
  expect(text).toContain('Unknown client');
  expect(text).not.toContain('Try again');
  expect(text).not.toContain('Check your connection');
});

it('still offers a retry when there was no answer at all', async () => {
  expect(await render(new TypeError('Failed to fetch'))).toContain('Try again');
  expect(await render(new ApiError(503, 'unavailable', 'Unavailable'))).toContain('Try again');
});

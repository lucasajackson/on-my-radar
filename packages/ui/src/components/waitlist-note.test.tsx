// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { WaitlistNote } from './waitlist-note';

afterEach(() => {
  document.body.innerHTML = '';
});

it('says what the form said — use case, source, when — and that it is unverified', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <WaitlistNote
        waitlist={{
          name: 'Ada',
          useCase: 'agent_builder',
          source: 'launch-post',
          requestedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
        }}
      />,
    ),
  );
  const text = host.textContent;
  expect(text).toContain('waitlist form · unverified');
  expect(text).toContain('Agent builder');
  expect(text).toContain('via launch-post');
  expect(text).toMatch(/requested \S/);
  await act(async () => root.unmount());
});

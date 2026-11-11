// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OnboardPill, onboardText } from './onboard-pill';
import { ToastHost } from './primitives';

const ID = '9e08dc2a-8069-4dfd-92c8-1424eae5c9b9';
const BASE = `Fetch and execute the appropriate instructions to set me up for On My Radar from ${window.location.origin}/agent-setup/prompt.md`;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount(writeText: (value: string) => Promise<void>, agentId?: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <>
        <OnboardPill {...(agentId ? { agentId } : {})} />
        <ToastHost />
      </>,
    ),
  );
  return host;
}

it('copies the exact sentence, word for word', () => {
  expect(onboardText()).toBe(BASE);
  expect(onboardText(ID)).toBe(`${BASE} — agent id: ${ID}`);
});

it('copies the general sentence from the agents list, and says it did', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  const host = await mount(writeText);
  const button = host.querySelector('button');
  expect(button?.textContent).toContain('Copy setup prompt');
  await act(async () => button?.click());
  expect(writeText).toHaveBeenCalledWith(BASE);
  expect(button?.textContent).toContain('Copied');
});

it('appends the agent id on an agent page', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  const host = await mount(writeText, ID);
  await act(async () => host.querySelector('button')?.click());
  expect(writeText).toHaveBeenCalledWith(`${BASE} — agent id: ${ID}`);
});

it('names the selected tool without changing the trailing agent identity', () => {
  expect(onboardText(ID, 'codex')).toBe(`${BASE} for Codex — agent id: ${ID}`);
  expect(onboardText(ID, 'claude-code')).toBe(`${BASE} for Claude Code — agent id: ${ID}`);
});

it('says so, with the text to copy by hand, when the clipboard refuses', async () => {
  const host = await mount(() => Promise.reject(new Error('denied')));
  const button = host.querySelector('button');
  await act(async () => button?.click());
  expect(button?.textContent).not.toContain('Copied');
  expect(document.body.textContent).toContain('Could not copy');
  expect(document.body.textContent).toContain('agent-setup/prompt.md');
});

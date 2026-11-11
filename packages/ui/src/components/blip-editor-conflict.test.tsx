// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { BlipEditor } from './blips';
import { must, setNativeValue } from '../lib/must';
import real409 from './fixtures/stale-revision-409.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

// The body the server really sends (captured from a REST PATCH), and the card as the editor opened it.
const current = real409.error.current as unknown as BlipDto;
const opened: BlipDto = { ...current, revision: 1, body: 'my first words' };

/** Answers each PATCH from `replies` in turn: a status and a body. Returns the sent payloads. */
function server(...replies: Array<[number, unknown]>) {
  const sent: Array<{ expectedRevision?: number; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as never);
      const [status, json] = must(replies.shift());
      return Promise.resolve(new Response(JSON.stringify(json), { status }));
    }),
  );
  return sent;
}

async function open(blip: BlipDto) {
  const onSaved = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (b: BlipDto) =>
    act(async () => root.render(<BlipEditor blip={b} onCancel={vi.fn()} onSaved={onSaved} />));
  await render(blip);
  const field = must(host.querySelector('textarea'));
  await act(async () => {
    setNativeValue(field, 'my draft');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const press = (label: string) =>
    act(async () =>
      must([...host.querySelectorAll('button')].find((b) => b.textContent === label)).click(),
    );
  return { host, field, onSaved, render, press };
}

it('keeps the draft and shows their text when the words changed, then overwrites on request', async () => {
  const sent = server([409, real409], [200, { blip: { ...current, revision: 3 } }]);
  const { host, field, onSaved, press } = await open(opened);
  await press('Save');
  expect(sent.map((s) => s.expectedRevision)).toEqual([1]);
  expect(field.value).toBe('my draft');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('A wins');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('by Agent A');
  expect(onSaved).not.toHaveBeenCalled();
  await press('Save mine over it');
  expect(sent.map((s) => s.expectedRevision)).toEqual([1, 2]);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('retries silently when only metadata moved', async () => {
  const same = { error: { ...real409.error, current: { ...current, body: 'my first words' } } };
  const sent = server([409, same], [200, { blip: current }]);
  const { host, onSaved, press } = await open(opened);
  await press('Save');
  expect(sent.map((s) => s.expectedRevision)).toEqual([1, 2]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('sends the revision it opened at even after a poll moved the prop', async () => {
  const sent = server([409, real409]);
  const { render, press } = await open(opened);
  await render({ ...opened, revision: 2, body: 'A wins' });
  await press('Save');
  expect(sent.map((s) => s.expectedRevision)).toEqual([1]);
});

it('use theirs replaces the draft with their version', async () => {
  server([409, real409]);
  const { field, press } = await open(opened);
  await press('Save');
  await press('Use theirs');
  expect(field.value).toBe('A wins');
});

it('save mine over it still sends when the draft was edited back to the opened text', async () => {
  const sent = server([409, real409], [200, { blip: { ...current, revision: 3 } }]);
  const { field, onSaved, press } = await open(opened);
  await press('Save');
  await act(async () => {
    setNativeValue(field, opened.body);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await press('Save mine over it');
  expect(sent.map((s) => [s.expectedRevision, s.body])).toEqual([
    [1, 'my draft'],
    [2, opened.body],
  ]);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

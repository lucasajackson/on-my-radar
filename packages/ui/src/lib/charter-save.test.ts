import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WriteCharterResult } from '@onmyradar/contract';
import { ApiError } from './api';
import { AUTOSAVE_IDLE_MS, CHECKPOINT_IDLE_MS, CharterSaver, type SaveState } from './charter-save';

const result = (revision: number): WriteCharterResult => ({
  revision,
  version: revision,
  changed: true,
  orphaned: [],
  healed: [],
  moved: [],
  inertOrphaned: 0,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A write that answers when the test says so. */
function slowServer() {
  const calls: Array<{ markdown: string; baseRevision: number; checkpoint: boolean }> = [];
  const pending: Array<{ ok: (r: WriteCharterResult) => void; fail: (e: unknown) => void }> = [];
  const write = (input: { markdown: string; baseRevision: number; checkpoint: boolean }) => {
    calls.push(input);
    return new Promise<WriteCharterResult>((ok, fail) => pending.push({ ok, fail }));
  };
  return { calls, pending, write };
}

it('waits for typing to stop, then writes once at the revision it was read at', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 3 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 100);
  saver.push('abc');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 100);
  expect(server.calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(200);
  expect(server.calls).toEqual([{ markdown: 'abc', baseRevision: 3, checkpoint: false }]);
  server.pending[0]?.ok(result(4));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('saved');
  expect(saver.baseRevision).toBe(4);
});

it('never has two writes in flight: text typed during one follows it, at the new revision', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  expect(server.calls).toHaveLength(1);
  // Typed while the first is still on its way, and long enough for the idle time to pass.
  saver.push('abc');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
  expect(server.calls).toHaveLength(1);
  expect(saver.snapshot.state).toBe('saving');
  server.pending[0]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  expect(server.calls).toEqual([
    { markdown: 'ab', baseRevision: 1, checkpoint: false },
    { markdown: 'abc', baseRevision: 2, checkpoint: false },
  ]);
  server.pending[1]?.ok(result(3));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('saved');
});

it('flush writes now, and waits for the write already in flight, in order', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  saver.push('abc');
  let done = false;
  void saver.flush().then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(false);
  server.pending[0]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(server.calls.map((c) => [c.markdown, c.baseRevision])).toEqual([
    ['ab', 1],
    ['abc', 2],
  ]);
  server.pending[1]?.ok(result(3));
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(true);
  expect(saver.dirty).toBe(false);
});

it('a conflict stops writing and keeps every word that was typed', async () => {
  const server = slowServer();
  const states: SaveState[] = [];
  const saver = new CharterSaver(
    { markdown: 'a', revision: 1 },
    { write: server.write, onChange: (s) => states.push(s.state) },
  );
  saver.push('mine');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new ApiError(409, 'stale', 'at 5', { revision: '5' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot).toMatchObject({ state: 'conflict', headRevision: 5 });
  saver.push('mine, and more');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 3);
  expect(server.calls).toHaveLength(1);
  expect(saver.latest).toBe('mine, and more');
  // Taking their version is the only way out, and it replaces what was typed on purpose.
  saver.adopt({ markdown: 'theirs', revision: 5 });
  expect(saver.snapshot.state).toBe('saved');
  expect(saver.latest).toBe('theirs');
  expect(saver.baseRevision).toBe(5);
});

it('a network failure pauses and retries on its own with the same text', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('paused');
  expect(saver.latest).toBe('ab');
  await vi.advanceTimersByTimeAsync(2100);
  expect(server.calls).toHaveLength(2);
  expect(server.calls[1]).toEqual({ markdown: 'ab', baseRevision: 1, checkpoint: false });
  server.pending[1]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('saved');
});

it('a refusal (too long, no access) stops without retrying, saying why', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new ApiError(422, 'too_long', 'Too long.'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(saver.snapshot).toMatchObject({ state: 'refused', message: 'Too long.' });
  expect(server.calls).toHaveLength(1);
});

it('typing the text back to what the server holds is nothing to save', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  saver.push('a');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
  expect(server.calls).toEqual([]);
  expect(saver.snapshot.state).toBe('saved');
});

it('reports what each write was: the text it carried and the text it replaced', async () => {
  const server = slowServer();
  const seen: Array<[string, string]> = [];
  const saver = new CharterSaver(
    { markdown: 'before', revision: 1 },
    { write: server.write, onSaved: (w) => seen.push([w.before, w.sent]) },
  );
  saver.push('after');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([['before', 'after']]);
});

it('typing after a refusal is a new try', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('too long');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new ApiError(422, 'too_long', 'Too long.'));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('refused');
  saver.push('shorter');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  expect(server.calls.map((c) => c.markdown)).toEqual(['too long', 'shorter']);
});

it('a retry told it is stale because its first try landed is saved, not a conflict', async () => {
  const server = slowServer();
  const saver = new CharterSaver(
    { markdown: 'a', revision: 1 },
    { write: server.write, head: () => Promise.resolve({ markdown: 'ab', revision: 2 }) },
  );
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(2100);
  server.pending[1]?.fail(new ApiError(409, 'stale', 'at 2', { revision: '2' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('saved');
  expect(saver.baseRevision).toBe(2);
});

it('a retry that is stale because somebody else saved is still a conflict', async () => {
  const server = slowServer();
  const saver = new CharterSaver(
    { markdown: 'a', revision: 1 },
    { write: server.write, head: () => Promise.resolve({ markdown: 'theirs', revision: 2 }) },
  );
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(2100);
  server.pending[1]?.fail(new ApiError(409, 'stale', 'at 2', { revision: '2' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot).toMatchObject({ state: 'conflict', headRevision: 2 });
});

it('autosave writes working text; finish seals it once, with the text that is on the server', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(server.calls.map((c) => c.checkpoint)).toEqual([false]);
  let sealed: string | null | undefined;
  void saver.finish().then((text) => {
    sealed = text;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(server.calls[1]).toEqual({ markdown: 'ab', baseRevision: 2, checkpoint: true });
  server.pending[1]?.ok({ ...result(2), changed: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(sealed).toBe('ab');
  // Nothing typed since: finishing again writes nothing more.
  await saver.finish();
  expect(server.calls).toHaveLength(2);
});

it('finish writes what is typed, then seals, and says null when it cannot', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  let outcome: string | null | undefined;
  void saver.finish().then((text) => {
    outcome = text;
  });
  await vi.advanceTimersByTimeAsync(0);
  server.pending[0]?.fail(new ApiError(409, 'stale', 'at 3', { revision: '3' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(outcome).toBeNull();
  expect(saver.latest).toBe('ab');
  expect(saver.snapshot.state).toBe('conflict');
});

it('typing while the seal is on its way is written next, not lost', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  void saver.finish();
  await vi.advanceTimersByTimeAsync(0);
  saver.push('abc');
  server.pending[1]?.ok({ ...result(2), changed: false });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  expect(server.calls.at(-1)).toEqual({ markdown: 'abc', baseRevision: 2, checkpoint: false });
});

it('seals the working text on its own after it has been left alone with the editor open', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(CHECKPOINT_IDLE_MS - 1000);
  expect(server.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect(server.calls[1]).toEqual({ markdown: 'ab', baseRevision: 2, checkpoint: true });
});

it('after a lost answer the server is unknown: typing back to the old text still writes, and does not close over a different head', async () => {
  const server = slowServer();
  const saver = new CharterSaver(
    { markdown: 'A', revision: 1 },
    { write: server.write, head: () => Promise.resolve({ markdown: 'B', revision: 2 }) },
  );
  saver.push('B');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  // The server committed B, and the answer never arrived.
  server.pending[0]?.fail(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(0);
  // Back to A, which is what was last acknowledged: that no longer means the server has A.
  saver.push('A');
  expect(saver.dirty).toBe(true);
  let outcome: string | null | undefined;
  void saver.finish().then((text) => {
    outcome = text;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(server.calls.at(-1)).toMatchObject({ markdown: 'A', baseRevision: 1 });
  // The server moved on (it holds B): the write is stale, and it is a conflict, not a close.
  server.pending.at(-1)?.fail(new ApiError(409, 'stale', 'at 2', { revision: '2' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(outcome).toBeNull();
  expect(saver.snapshot.state).toBe('conflict');
  expect(saver.latest).toBe('A');
});

it('after a lost answer, a retry that lands saves and Done may close', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'A', revision: 1 }, { write: server.write });
  saver.push('B');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  server.pending[0]?.fail(new TypeError('Failed to fetch'));
  await vi.advanceTimersByTimeAsync(0);
  saver.push('A');
  void saver.flush();
  await vi.advanceTimersByTimeAsync(0);
  server.pending.at(-1)?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.dirty).toBe(false);
  expect(saver.snapshot.state).toBe('saved');
});

it('a 429 is a pause, not an error: the text is kept and the next try waits for Retry-After', async () => {
  const server = slowServer();
  const saver = new CharterSaver({ markdown: 'a', revision: 1 }, { write: server.write });
  saver.push('ab');
  await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
  expect(server.calls).toHaveLength(1);
  server.pending[0]?.fail(new ApiError(429, 'rate_limited', 'Slow down.', undefined, 45));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('paused');
  // Neither the first back-off nor the longest one is enough: the server asked for 45 seconds.
  await vi.advanceTimersByTimeAsync(44_000);
  expect(server.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(server.calls).toEqual([
    { markdown: 'ab', baseRevision: 1, checkpoint: false },
    { markdown: 'ab', baseRevision: 1, checkpoint: false },
  ]);
  server.pending[1]?.ok(result(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(saver.snapshot.state).toBe('saved');
  expect(saver.baseRevision).toBe(2);
});

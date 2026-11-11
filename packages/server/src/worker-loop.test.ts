import { expect, it, vi } from 'vitest';
import { runEach, runWorkerLoop } from './worker-loop.js';

it('runs every housekeeping task even when an earlier one keeps failing', async () => {
  const broken = new Error('sweep is broken');
  const later = vi.fn(async () => 3);
  const error = vi.fn();
  const results = await runEach(
    [
      ['first', () => Promise.reject(broken)],
      ['second', later],
    ],
    error,
  );
  expect(later).toHaveBeenCalledOnce();
  expect(results).toEqual({ second: 3 });
  expect(error).toHaveBeenCalledWith('first', broken);
});

it('drains notifications while one feed waits, and joins both lanes on shutdown', async () => {
  const stop = new AbortController();
  let finishFeed!: () => void;
  let thirdDrain!: () => void;
  const pendingFeed = new Promise<void>((resolve) => {
    finishFeed = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    thirdDrain = resolve;
  });
  const feed = vi.fn(async () => {
    await pendingFeed;
    return true;
  });
  const drain = vi.fn(async () => {
    if (drain.mock.calls.length === 3) thirdDrain();
    return false;
  });
  const error = vi.fn();
  const work = Promise.all([
    runWorkerLoop(drain, stop.signal, error, 10),
    runWorkerLoop(feed, stop.signal, error, 10),
  ]);
  let finished = false;
  void work.then(() => {
    finished = true;
  });
  await drained;
  expect(drain).toHaveBeenCalledTimes(3);
  expect(feed).toHaveBeenCalledTimes(1);
  stop.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  finishFeed();
  await work;
  expect(finished).toBe(true);
  expect(feed).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});
it('backs off after an error and cancels an idle wait immediately on shutdown', async () => {
  const stop = new AbortController();
  const failure = new Error('temporary failure');
  let retried!: () => void;
  const nextAttempt = new Promise<void>((resolve) => {
    retried = resolve;
  });
  const step = vi
    .fn<() => Promise<boolean>>()
    .mockRejectedValueOnce(failure)
    .mockImplementation(async () => {
      retried();
      return false;
    });
  const error = vi.fn();
  const started = Date.now();
  const work = runWorkerLoop(step, stop.signal, error, 25);
  await nextAttempt;
  expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  expect(step).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledWith(failure);
  stop.abort();
  await work;
  expect(step).toHaveBeenCalledTimes(2);
});

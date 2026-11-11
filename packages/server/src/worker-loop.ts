import { setTimeout as delay } from 'node:timers/promises';

/**
 * Runs every task in order even when an earlier one throws, returning what each
 * that succeeded produced.
 *
 * The housekeeping lane used to run its sweeps as one chain ahead of the outbox
 * drain, so a sweep that failed every time — one bad row, one broken query —
 * silently stopped every sweep after it *and* the drain itself: no email, no
 * push, no object cleanup, while the log said only "iteration failed".
 */
export async function runEach(
  tasks: ReadonlyArray<readonly [name: string, task: () => Promise<unknown>]>,
  onError: (name: string, error: unknown) => void,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const [name, task] of tasks) {
    try {
      results[name] = await task();
    } catch (error) {
      onError(name, error);
    }
  }
  return results;
}

/** One task at a time per lane; idle/error retries sleep and shutdown wakes the sleep. */
export async function runWorkerLoop(
  step: () => Promise<boolean>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  idleMs = 2_000,
): Promise<void> {
  // A function, not the property: `signal.aborted` changes during the awaits
  // below, and control-flow narrowing from the loop condition cannot know it.
  const aborted = () => signal.aborted;
  while (!aborted()) {
    let worked = false;
    try {
      worked = await step();
    } catch (error) {
      onError(error);
    }
    if (!worked && !aborted()) {
      try {
        await delay(idleMs, undefined, { signal });
      } catch (error) {
        if (!aborted()) throw error;
      }
    }
  }
}

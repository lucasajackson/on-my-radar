/**
 * A per-request cap on concurrent pool queries.
 *
 * `hydrate` starts about a dozen queries in one `Promise.all`, and `read_radar`
 * runs it beside three counts and the stats. With a pool of ten, one such
 * request checks out every connection, and every other request, the readiness
 * probe included, queues behind it.
 *
 * The cap sits where the queries actually leave the process (`pool.query`, see
 * `db/client.ts`) rather than at each fan-out site, for two reasons. Fan-out
 * nests (a handler fans out, and each branch fans out again), and a cap applied
 * at each level multiplies instead of bounding. And the cap is per request, so
 * it follows the work through `await`s without every service function growing a
 * parameter: an `AsyncLocalStorage` carries the semaphore from the HTTP
 * middleware down to the pool.
 *
 * It gates single statements only. A transaction checks out a connection with
 * `pool.connect()` and is not counted, which is what keeps this deadlock-free: a
 * gated statement never waits for anything but another statement to finish, so
 * there is no cycle to form. Work outside a request (the worker, migrations,
 * tests) has no store and is not gated.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../env.js';

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  /** Statements that had to wait for a slot, for the metrics endpoint. */
  static waited = 0;

  constructor(private readonly permits: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.permits) {
      Semaphore.waited += 1;
      // The slot is handed over directly (active is not decremented), so a
      // newcomer cannot jump the queue between release and wake-up.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const store = new AsyncLocalStorage<Semaphore>();

/** Runs `work` (a request) with its own query cap. */
export function withRequestGate<T>(work: () => Promise<T>, limit?: number): Promise<T> {
  return store.run(new Semaphore(limit ?? env().REQUEST_QUERY_CONCURRENCY), work);
}

export function currentGate(): Semaphore | undefined {
  return store.getStore();
}

/** Readiness is withdrawn before the listener closes; every shutdown has a deadline. */
import { setTimeout as delay } from 'node:timers/promises';

let draining = false;
export const isDraining = () => draining;
function beginDrain(): void {
  draining = true;
}

interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
}

/** False means work exceeded the deadline; the caller must then exit nonzero. */
export async function finishWithin(
  work: () => Promise<void>,
  timeoutMs: number,
  force: () => void = () => undefined,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          force();
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function drainHttpServer(
  server: ClosableServer,
  options: {
    drainMs: number;
    timeoutMs: number;
    closeResources: () => Promise<void>;
  },
): Promise<boolean> {
  beginDrain();
  return finishWithin(
    async () => {
      // Keep serving during endpoint propagation, then finish accepted requests.
      await delay(options.drainMs);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await options.closeResources();
    },
    options.timeoutMs,
    () => server.closeAllConnections?.(),
  );
}

import { Hono } from 'hono';
import { readJson, requireUser, type AppEnv } from '../http.js';
import {
  accountExportMetadata,
  accountExportTicket,
  accountExportTicketSchema,
} from '../services/account-export.js';
import { logger } from '../logger.js';

/** Cancellation drains generator/cursor cleanup before returning its client. */
export function accountExportBody(
  source: Awaited<ReturnType<typeof accountExportMetadata>>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = source.records[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let stopped = false;
  // Cancellation can change this while an iterator read is pending.
  const isStopped = () => stopped;
  let cleanup: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stop = () => {
    stopped = true;
    signal.removeEventListener('abort', abort);
    cleanup ??= (async () => {
      try {
        await iterator.return();
      } finally {
        await source.close();
      }
    })();
    return cleanup;
  };
  const abort = () => {
    controller?.error(new Error('Account download interrupted.'));
    void stop().catch(() => logger.error('Account download cleanup failed.'));
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        if (isStopped()) return;
        const result = await iterator.next();
        if (isStopped()) return;
        if (result.done) {
          value.close();
          await stop();
        } else value.enqueue(encoder.encode(result.value));
      } catch (error) {
        value.error(error);
        await stop();
      }
    },
    cancel: stop,
  });
}

export const accountExportRoutes = new Hono<AppEnv>();
accountExportRoutes.get('/export', async (c) => {
  const source = await accountExportMetadata(requireUser(c));
  const body = accountExportBody(source, c.req.raw.signal);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    },
  });
});
accountExportRoutes.post('/export/object', async (c) =>
  c.json(await accountExportTicket(requireUser(c), await readJson(c, accountExportTicketSchema))),
);

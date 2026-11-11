import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  EMAIL_FAILURE_MESSAGES,
  isEmailFailureReason,
  type EmailFailureReason,
} from './email-failures.js';
import { ApiError } from '../http.js';

/** What email-parser-worker.ts receives as workerData. */
export interface EmailParserWorkerData {
  raw: Uint8Array;
  /** The capture address the message was delivered to; a DKIM-signed To/Cc must name it. */
  recipient: string;
  dnsRecords?: Record<string, string[][]> | undefined;
}

export interface ParsedEmail {
  sender: string;
  signatureId: string;
  body: string;
  original: Uint8Array;
  subject: string | null;
  senderName: string | null;
  sentAt: string | null;
  text: string;
  html: string | null;
  files: Array<{
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    contentId: string | null;
    inline: boolean;
  }>;
}

/** Disposable workers bound CPU lifetime and release MIME allocations after each message. */
export async function parseEmail(
  raw: Uint8Array,
  recipient: string,
  signal: AbortSignal,
  dnsRecords?: Record<string, string[][]>,
): Promise<ParsedEmail> {
  signal.throwIfAborted();
  // Ingress owns its exact-size ArrayBuffer. Copies are only needed for pooled
  // Buffers supplied by other internal callers (e.g. signed fixtures).
  const owned =
    raw.buffer instanceof ArrayBuffer &&
    raw.byteOffset === 0 &&
    raw.byteLength === raw.buffer.byteLength
      ? raw
      : Uint8Array.from(raw);
  const source = import.meta.url.endsWith('.ts');
  const url = new URL(
    source ? './email-parser-worker.ts' : './email-parser-worker.js',
    import.meta.url,
  );
  // Source runs use tsx's explicit import API; deployed workers execute built JS directly.
  const worker = source
    ? new Worker(
        `require(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))}).tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)})`,
        {
          eval: true,
          workerData: { raw: owned, recipient, dnsRecords } satisfies EmailParserWorkerData,
          transferList: [owned.buffer as ArrayBuffer],
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
          execArgv: [],
        },
      )
    : new Worker(url, {
        workerData: { raw: owned, recipient, dnsRecords },
        transferList: [owned.buffer as ArrayBuffer],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
        execArgv: [],
      });
  try {
    return await new Promise<ParsedEmail>((resolve, reject) => {
      const unavailable = () =>
        reject(
          new ApiError(
            503,
            'email_parser_unavailable',
            'Email processing is temporarily unavailable.',
          ),
        );
      signal.addEventListener('abort', unavailable, { once: true });
      if (signal.aborted) unavailable();
      worker.once('error', unavailable);
      worker.once('exit', unavailable);
      worker.once('message', (value: ParsedEmail | { error: true; reason: EmailFailureReason }) => {
        if ('error' in value) {
          const reason = isEmailFailureReason(value.reason) ? value.reason : 'mime_invalid';
          reject(
            new ApiError(
              reason === 'dkim_dns_unavailable' ? 503 : 403,
              `email_${reason}`,
              EMAIL_FAILURE_MESSAGES[reason],
            ),
          );
        } else resolve(value);
      });
      worker.once('exit', () => signal.removeEventListener('abort', unavailable));
    });
  } finally {
    await worker.terminate();
  }
}

/** Bound bytes before JSON/form parsing; Content-Length is only an early hint. */
import type { MiddlewareHandler } from 'hono';
import { WEBHOOK } from '@onmyradar/contract';
import { env } from './env.js';
import { ApiError, type AppEnv } from './http.js';
import type { ReadableStreamReadResult } from 'node:stream/web';

export async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new ApiError(
      413,
      'payload_too_large',
      `Request bodies are limited to ${Math.floor(maxBytes / 1024)} KB.`,
    );
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk: ReadableStreamReadResult<unknown> = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!(value instanceof Uint8Array)) throw new TypeError('Request body chunk was not bytes');
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

// A request with no resolved actor gets a small body. zod 3 has no early exit on a failing array
// (GHSA-mrhx-c7xc-m3w5, ignored in package.json pnpm.auditConfig), so a 2 MiB array of wrong
// elements allocates ~330 MB of issue objects; every unauthenticated route (sign-in, waitlist,
// OAuth registration, ...) takes a handful of short fields, so 16 KiB bounds that to nothing.
// Authenticated callers keep HTTP_BODY_LIMIT_BYTES.
const UNAUTHENTICATED_MAX_BYTES = 16 * 1024;
// Guest support proves itself with a capability header that its routes check before parsing,
// and carries real message text, so it keeps the full limit.
const GUEST_SUPPORT_PATH = /^\/api(\/v1)?\/guest-support\//;

// A tool call is arguments, not an upload (attachments go straight to object storage), so /mcp
// has a smaller cap than the API: zod 3 allocates ~165 bytes of issue objects per byte of a
// failing array, and the generic limit let one authenticated agent request pin ~330 MB.
const isMcpPath = (path: string) => path === '/mcp' || path.startsWith('/mcp/');

const OWN_CAP = new Set(['/hooks/email-capture/raw']);

export function boundRequestBody(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Raw email verifies its relay MAC before admitting/buffering the larger MIME body.
    if (c.req.raw.body && !(c.req.method === 'POST' && OWN_CAP.has(c.req.path))) {
      const limit = c.req.path.startsWith('/hooks/')
        ? WEBHOOK.maxPayloadBytes
        : !c.get('actor') && !GUEST_SUPPORT_PATH.test(c.req.path)
          ? UNAUTHENTICATED_MAX_BYTES
          : isMcpPath(c.req.path)
            ? env().MCP_BODY_LIMIT_BYTES
            : env().HTTP_BODY_LIMIT_BYTES;
      const body = await readCappedBody(c.req.raw, limit);
      c.req.raw = new Request(c.req.raw, {
        body: Buffer.from(body),
        duplex: 'half',
      });
    }
    await next();
  };
}

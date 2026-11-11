/** S3-compatible storage (R2 in production). Browser uploads use presigned URLs;
 * authenticated email ingestion writes bounded, verified MIME attachments here. */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LIMITS } from '@onmyradar/contract';
import { env, storageConfigured } from '../env.js';
import { ApiError, badRequest } from '../http.js';
import { logger } from '../logger.js';
import { isRefusedUploadType, mediaType, rendersActiveDocument } from './content-types.js';
import { EMAIL_MAX_STORED_FILES } from './email-limits.js';

export const UPLOAD_TTL_SECONDS = 15 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

let client: S3Client | null = null;

/**
 * Every storage call is bounded. The SDK's own default is no timeout at all, so
 * one connection the storage accepted and never answered held a request — and,
 * worse, the worker's outbox lane, where object cleanup runs — indefinitely.
 * `throwOnRequestTimeout` matters: without it the SDK only logs a warning when
 * `requestTimeout` passes and goes on waiting. Mutable only so a test can prove
 * the bound without waiting half a minute for it.
 */
export const STORAGE_TIMEOUTS = { connectionTimeout: 5_000, requestTimeout: 30_000 };

/** Bounded application-owned image read, never a fetch of a caller's URL.
 * Deadline destroys the live Node response stream even while awaiting a chunk.
 * Provider errors/keys/bytes stay out of the error forwarded to MCP and logs.
 */
export async function readImageObject(
  key: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Buffer; contentType: string | undefined }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let body: Readable | undefined;
  const abort = () => {
    body?.destroy(new Error('Image read deadline'));
  };
  try {
    const response = await s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }), {
      abortSignal: signal,
    });
    if (!(response.Body instanceof Readable)) throw new Error('Missing image body');
    body = response.Body;
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    const length = response.ContentLength;
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > maxBytes))
      throw new ApiError(
        413,
        'image_too_large',
        'Image metadata exceeds the view limit. Use download_attachment for the original.',
      );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new Error('Invalid image stream');
      size += chunk.byteLength;
      if (size > maxBytes)
        throw new ApiError(
          413,
          'image_too_large',
          'Image exceeds the view limit. Use download_attachment for the original.',
        );
      chunks.push(Buffer.from(chunk));
    }
    if (size === 0 || (length !== undefined && length !== size))
      throw new Error('Incomplete image');
    return { bytes: Buffer.concat(chunks, size), contentType: response.ContentType };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      503,
      'image_unavailable',
      'Image storage could not be read completely. Try again or use download_attachment.',
    );
  } finally {
    signal.removeEventListener('abort', abort);
    body?.destroy();
  }
}

function s3(): S3Client {
  const e = env();
  if (!storageConfigured(e)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'File storage is not configured on this server.',
    );
  }
  client ??= new S3Client({
    region: e.S3_REGION,
    ...(e.S3_ENDPOINT ? { endpoint: e.S3_ENDPOINT } : {}),
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: e.S3_ACCESS_KEY as string,
      secretAccessKey: e.S3_SECRET_KEY as string,
    },
    requestHandler: { ...STORAGE_TIMEOUTS, throwOnRequestTimeout: true },
    /*
      Checksums only when an operation requires one. Since SDK 3.729 the
      default is WHEN_SUPPORTED, and for a *presigned* PutObject there is no
      body at signing time — so the SDK signed the CRC32 of an empty payload
      (`x-amz-checksum-crc32=AAAAAA==`) into every upload URL. The browser then
      PUTs the real file, and R2 checksums what arrived against what the URL
      promised and refuses it. MinIO ignored the parameter, which is why this
      only surfaced after the move to R2. `storage.test.ts` fails if either
      checksum parameter reappears in a ticket.
    */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

/** Strip anything that could confuse a Content-Disposition header or a path. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'file';
  // Control characters are exactly what has to go here — a newline or NUL in a
  // filename is what turns a Content-Disposition header into a header-injection
  // bug — so the rule is disabled deliberately rather than worked around.
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  // `.` and `..` are path segments, not names: the key is `…/<uuid>/<name>`.
  if (/^\.+$/.test(cleaned)) return 'file';
  return (cleaned || 'file').slice(0, 200);
}

/**
 * Keys are prefixed by radar so that a radar's objects can be listed and deleted
 * as a unit, and carry a uuid so two uploads of `screenshot.png` never collide.
 */
export function buildObjectPrefix(radarId: string): string {
  return `radars/${radarId}/${randomUUID()}`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Email capture adds its 64-hex delivery id between the upload uuid and the file
// (`inbound-email.ts`): `radars/<id>/<uuid>/<delivery>/<n>-<name>`.
const ISSUED_KEY = new RegExp(`^radars/(${UUID})/${UUID}(?:/[a-f0-9]{64})?/([^/]+)$`, 'i');

/**
 * True only for a key shaped exactly like one `buildObjectKey` issues for this
 * radar: `radars/<radarId>/<uuid>[/<email delivery id>]/<one segment>`. A prefix check let
 * `radars/<id>/<uuid>/../../<other radar>/x` through, which names another radar's
 * object once anything normalises the path.
 */
export function isIssuedAttachmentKey(radarId: string, key: string): boolean {
  const match = ISSUED_KEY.exec(key);
  if (!match || match[1]?.toLowerCase() !== radarId.toLowerCase()) return false;
  const name = match[2] ?? '';
  // eslint-disable-next-line no-control-regex
  if (/^\.+$/.test(name) || /[\u0000-\u001f\u007f\\]/.test(name)) return false;
  // A name that is percent-encoded traversal is one segment today and a path
  // the moment something decodes it.
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Not valid percent-encoding: it is a literal name, already checked above.
  }
  return !/[\\/]/.test(decoded) && !/^\.+$/.test(decoded);
}

export function buildObjectKey(radarId: string, filename: string): string {
  return `${buildObjectPrefix(radarId)}/${safeFilename(filename)}`;
}

export function assertUploadable(contentType: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw badRequest('A valid file size is required');
  if (size > LIMITS.attachmentBytes) {
    throw new ApiError(
      413,
      'file_too_large',
      `Files must be ${LIMITS.attachmentBytes / (1024 * 1024)}MB or smaller.`,
    );
  }
  if (!mediaType(contentType).includes('/')) throw badRequest('A valid content type is required');
  if (isRefusedUploadType(contentType)) throw badRequest('That file type cannot be uploaded.');
}

export interface UploadTicket {
  key: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresIn: number;
}

export async function createUploadTicket(
  radarId: string,
  filename: string,
  contentType: string,
  size: number,
  reservedKey?: string,
): Promise<UploadTicket> {
  assertUploadable(contentType, size);
  const e = env();
  const key = reservedKey ?? buildObjectKey(radarId, filename);

  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: e.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      // Signing the length stops a ticket for a small file being reused to
      // upload a huge one.
      ContentLength: size,
    }),
    {
      expiresIn: UPLOAD_TTL_SECONDS,
      signableHeaders: new Set(['content-type']),
    },
  );

  return {
    key,
    url,
    method: 'PUT',
    headers: { 'content-type': contentType },
    expiresIn: UPLOAD_TTL_SECONDS,
  };
}

/**
 * Would a browser on `APP_URL` be allowed to PUT an upload ticket?
 *
 * Every upload is a cross-origin PUT straight to the bucket, so the bucket's
 * CORS policy is part of the capture path — and it lives outside this repo,
 * outside the chart, and outside anything CI can see. MinIO allowed every
 * origin by default; R2 allows none until told. The move to R2 copied every
 * object and not that policy, and every browser upload failed its preflight for
 * weeks while the server issued tickets and logged 200s.
 *
 * So the server asks once at boot, exactly as the browser would: an unsigned
 * preflight against a freshly signed ticket URL. It writes nothing, and a
 * failure only logs — storage being reachable is not this function's question.
 * `null` means there was nothing to ask (storage off) or no answer came.
 */
export async function checkBrowserUploadCors(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; allowOrigin: string | null; origin: string } | null> {
  const e = env();
  if (!storageConfigured(e)) return null;
  const origin = new URL(e.APP_URL).origin;
  const ticket = await createUploadTicket('cors-probe', 'probe.png', 'image/png', 1);
  try {
    const response = await fetchImpl(ticket.url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
      signal: AbortSignal.timeout(STORAGE_TIMEOUTS.connectionTimeout),
    });
    const allowOrigin = response.headers.get('access-control-allow-origin');
    return {
      ok: response.ok && (allowOrigin === '*' || allowOrigin === origin),
      status: response.status,
      allowOrigin,
      origin,
    };
  } catch {
    return null;
  }
}

/**
 * Is this the storage saying "no such object", or the storage saying nothing?
 *
 * Only a genuine 404 is absence. The AWS SDK models it either as an error named
 * `NotFound`/`NoSuchKey` or as one carrying `$metadata.httpStatusCode === 404`,
 * and which one arrives depends on the command and the server, so both are
 * checked. Everything else — a refused connection, a DNS failure, expired
 * credentials (403), a bucket policy change, a 5xx — is the storage being
 * unavailable, and must not be read as a statement about the object.
 */
function isAbsent(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  return e.$metadata?.httpStatusCode === 404;
}

/**
 * Confirms the object really landed, and returns its true size.
 *
 * **`null` means absent, and nothing else.** This catch used to be empty, which
 * conflated "the browser never completed the PUT" with "MinIO is unreachable,
 * the credentials expired, or the policy changed" — and logged neither. The
 * caller turns `null` into `Upload "…" was not completed`, so a storage outage
 * was reported to the person capturing as *their* mistake, on a screen with no
 * way to act on it, while the real cause left no line in `kubectl logs` at all.
 *
 * A failure now logs at `error` (it is an outage, not a nuisance) and throws a
 * 503 that says whose problem it is.
 */
export async function headObject(
  key: string,
  signal?: AbortSignal,
): Promise<{ size: number; contentType: string } | null> {
  try {
    const result = await s3().send(
      new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
      signal ? { abortSignal: signal } : {},
    );
    if (
      result.ContentLength === undefined ||
      !Number.isSafeInteger(result.ContentLength) ||
      result.ContentLength < 0
    )
      throw new Error('Object HEAD did not return a valid byte length');
    return {
      size: result.ContentLength,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  } catch (err) {
    if (isAbsent(err)) return null;
    // Re-thrown as-is: `s3()` already refuses with a 503 when storage is simply
    // not configured, and dressing that up as an outage would mislead.
    if (err instanceof ApiError) throw err;
    logger.error({ err, key, bucket: env().S3_BUCKET }, 'object storage HEAD failed');
    throw new ApiError(
      503,
      'storage_unavailable',
      'File storage could not be reached, so nothing was saved. Try again in a moment.',
    );
  }
}

/**
 * A short-lived GET that says how the browser should treat the bytes.
 *
 * A type that would render as an active document (see `rendersActiveDocument`)
 * is served as an opaque download whatever it was stored as, so a stored XML
 * file cannot become a page running script on the storage origin.
 */
export async function createDownloadUrl(
  key: string,
  filename: string,
  contentType: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<string> {
  const active = rendersActiveDocument(contentType);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      ResponseContentType: active ? 'application/octet-stream' : contentType,
      ResponseContentDisposition: `${active ? 'attachment' : disposition}; filename="${safeFilename(filename)}"`,
    }),
    { expiresIn: DOWNLOAD_TTL_SECONDS },
  );
}

/** Idempotent cleanup; failures must reach the outbox so it retains the job. */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      const result = await s3().send(
        new DeleteObjectsCommand({
          Bucket: env().S3_BUCKET,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (result.Errors?.length) {
        throw new Error(
          `Object cleanup failed for ${result.Errors.length} keys: ${result.Errors.map((error) => error.Code ?? 'unknown').join(', ')}`,
        );
      }
    } catch (err) {
      logger.warn({ err, count: batch.length }, 'object cleanup failed');
      throw err;
    }
  }
}

export function resetStorageClientForTesting(): void {
  client = null;
}

/** Keys come only from a persisted email authorization receipt. */
export async function putEmailAttachment(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  signal: AbortSignal,
): Promise<void> {
  assertUploadable(contentType, bytes.byteLength);
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: env().S3_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.byteLength,
      }),
      { abortSignal: signal },
    );
  } catch (err) {
    if (!signal.aborted) logger.error({ err, key }, 'email attachment PUT failed');
    throw new ApiError(
      503,
      'storage_unavailable',
      'Email attachment storage is temporarily unavailable.',
    );
  }
}

export interface StoredEmailContent {
  text: string;
  html: string | null;
  files: Array<{ key: string; contentId: string | null; inline: boolean }>;
}
const EMAIL_CONTENT_BYTES = 32 * 1024 * 1024;

/** Dedicated private email objects do not relax the browser attachment MIME allowlist. */
export async function putEmailContent(
  key: string,
  bytes: Uint8Array,
  original: boolean,
  signal: AbortSignal,
  digest?: string,
): Promise<void> {
  const limit = original ? 10 * 1024 * 1024 : EMAIL_CONTENT_BYTES;
  if (bytes.byteLength > limit)
    throw new ApiError(413, 'email_content_too_large', 'Email content exceeds its storage limit.');
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: env().S3_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: original ? 'message/rfc822' : 'application/json',
        ContentLength: bytes.byteLength,
        ContentDisposition: 'attachment',
        ...(digest ? { Metadata: { 'omr-email-digest': digest } } : {}),
      }),
      { abortSignal: signal },
    );
  } catch (err) {
    if (!signal.aborted) logger.error({ err, key }, 'email content PUT failed');
    throw new ApiError(503, 'storage_unavailable', 'Email storage is temporarily unavailable.');
  }
}

/** Reader payloads are bounded independently of object metadata and never publicly presigned. */
export async function readEmailContent(
  key: string,
  expectedEtag?: string,
): Promise<StoredEmailContent> {
  const signal = AbortSignal.timeout(10000);
  try {
    const result = await s3().send(
      new GetObjectCommand({
        Bucket: env().S3_BUCKET,
        Key: key,
        ...(expectedEtag ? { IfMatch: expectedEtag } : {}),
      }),
      {
        abortSignal: signal,
      },
    );
    if (!result.Body || (result.ContentLength ?? 0) > EMAIL_CONTENT_BYTES)
      throw new Error('Invalid email object');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > EMAIL_CONTENT_BYTES) throw new Error('Invalid email object');
      chunks.push(chunk);
    }
    const content: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (
      !content ||
      typeof content !== 'object' ||
      !('text' in content) ||
      typeof content.text !== 'string' ||
      !('html' in content) ||
      (content.html !== null && typeof content.html !== 'string') ||
      !('files' in content) ||
      !Array.isArray(content.files) ||
      content.files.length > EMAIL_MAX_STORED_FILES
    )
      throw new Error('Invalid email object');
    const files: unknown[] = content.files;
    for (const file of files)
      if (
        typeof file !== 'object' ||
        file === null ||
        !('key' in file) ||
        typeof file.key !== 'string' ||
        !('contentId' in file) ||
        (file.contentId !== null && typeof file.contentId !== 'string') ||
        !('inline' in file) ||
        typeof file.inline !== 'boolean'
      )
        throw new Error('Invalid email object');
    return content as StoredEmailContent;
  } catch (err) {
    logger.error({ err, key }, 'stored email content could not be read');
    throw new ApiError(
      503,
      'storage_unavailable',
      'The original email is temporarily unavailable.',
    );
  }
}

/** Human account exports retain the direct-to-storage byte path. The ETag
 * precondition pins each GET to the object observed in the metadata manifest. */
export async function accountExportObjectMetadata(key: string, signal?: AbortSignal) {
  const result = await s3().send(
    new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key }),
    signal ? { abortSignal: signal } : {},
  );
  if (
    !Number.isSafeInteger(result.ContentLength) ||
    (result.ContentLength ?? -1) < 0 ||
    !result.ETag
  )
    throw new Error('Export object metadata is incomplete');
  return { size: result.ContentLength as number, etag: result.ETag };
}
export async function accountExportObjectUrl(key: string, etag: string) {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      IfMatch: etag,
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: 'attachment',
    }),
    { expiresIn: DOWNLOAD_TTL_SECONDS },
  );
}

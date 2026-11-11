/** Browser-side account archive: database metadata from OMR, bytes from storage. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { zip, type ZipEntry } from './zip';

const encoder = new TextEncoder();
const MAX_RECORD = 64 * 1024 * 1024;
const BYTE_LIMIT = 64 * 1024 ** 3;
export type ExportProgress = { files: number; bytes: number };

async function* lines(response: Response) {
  if (!response.ok || !response.body) throw new Error('Account download could not start.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let reachedEnd = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        reachedEnd = true;
        break;
      }
      pending += result.value;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.length > MAX_RECORD) throw new Error('Account record is too large.');
        yield line;
      }
      if (pending.length > MAX_RECORD) throw new Error('Account record is too large.');
    }
    if (pending) throw new Error('Account metadata was interrupted.');
  } finally {
    try {
      if (!reachedEnd) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
function record(value: unknown) {
  return encoder.encode(JSON.stringify(value, null, 2) + '\n');
}
const SAFE_PATH = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
function safePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 256 &&
    SAFE_PATH.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..') &&
    path !== 'manifest.json'
  );
}
function fromBase64(text: unknown): Uint8Array {
  if (
    typeof text !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new Error('Invalid account archive record.');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Receipt = { path: string; size: number; sha256: string };

/**
 * Every file of the download, in order: database records and readable files
 * from OMR's metadata stream, then each attachment straight from storage, then
 * the checksum manifest. A file's bytes are fully read before the next file is
 * asked for, which is what lets one metadata reader serve both levels.
 */
async function* accountFiles(
  metadata: Response,
  signal: AbortSignal,
  progress: (value: ExportProgress) => void,
  request: typeof fetch,
): AsyncGenerator<ZipEntry> {
  const modified = new Date();
  const source = lines(metadata);
  const manifest: Receipt[] = [];
  const paths = new Set<string>();
  let database: Receipt[] = [];
  let files = 0;
  let objects = 0;
  let total = 0;
  let header = false;
  let databaseComplete = false;
  let metadataComplete = false;
  let open: string | null = null;
  const next = async () => {
    if (signal.aborted) throw new Error('Account download was cancelled.');
    const line = await source.next();
    return line.done ? null : (JSON.parse(line.value) as Record<string, unknown>);
  };
  const add = (receipt: Receipt) => {
    manifest.push(receipt);
    paths.add(receipt.path);
    total += receipt.size;
    files++;
    progress({ files, bytes: total });
  };
  /** One database or readable file, assembled from its base64 chunk records. */
  async function* entryBytes(path: string, size: number): AsyncGenerator<Uint8Array> {
    const hash = sha256.create();
    let length = 0;
    for (;;) {
      const item = await next();
      if (!item) throw new Error('Account metadata was interrupted.');
      if (item['type'] === 'chunk' && item['path'] === path) {
        const bytes = fromBase64(item['base64']);
        length += bytes.length;
        if (bytes.length > 65536 || length > size) throw new Error('Account record is too large.');
        hash.update(bytes);
        yield bytes;
        continue;
      }
      const digest = bytesToHex(hash.digest());
      if (
        item['type'] !== 'end-entry' ||
        item['path'] !== path ||
        item['size'] !== size ||
        length !== size ||
        item['sha256'] !== digest
      )
        throw new Error('Account record checksum did not match.');
      const receipt = { path, size, sha256: digest };
      database.push(receipt);
      add(receipt);
      open = null;
      return;
    }
  }
  /** One attachment, fetched directly from storage and checked as it streams. */
  async function* objectBytes(
    item: Record<string, unknown>,
    path: string,
    size: number,
  ): AsyncGenerator<Uint8Array> {
    const ticket = await request('/api/account/export/object', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: item['key'], etag: item['etag'] }),
    });
    if (!ticket.ok) throw new Error('A file cannot be downloaded. Retry the account download.');
    const data = (await ticket.json()) as { url?: unknown };
    if (typeof data.url !== 'string') throw new Error('Invalid file download ticket.');
    const file = await request(data.url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { 'If-Match': item['etag'] as string },
    });
    if (!file.ok || !file.body) throw new Error('A retained file is missing or changed.');
    const hash = sha256.create();
    let length = 0;
    const reader = file.body.getReader();
    let reachedEnd = false;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          reachedEnd = true;
          break;
        }
        length += part.value.length;
        if (length > size) throw new Error('File exceeded its recorded length.');
        hash.update(part.value);
        progress({ files, bytes: total + length });
        yield part.value;
      }
    } finally {
      try {
        if (!reachedEnd) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    if (length !== size) throw new Error('File download was interrupted.');
    const digest = bytesToHex(hash.digest());
    if (item['sha256'] !== null && item['sha256'] !== digest)
      throw new Error('File checksum did not match the snapshot.');
    add({ path, size, sha256: digest });
    open = null;
  }

  try {
    for (;;) {
      const item = await next();
      if (!item) break;
      if (open) throw new Error('Account metadata was interrupted.');
      const type = item['type'];
      if (metadataComplete) throw new Error('Unexpected data after the export receipt.');
      if (type === 'archive') {
        if (header || item['format'] !== 'onmyradar-account' || item['version'] !== 1)
          throw new Error('Unsupported account archive.');
        header = true;
      } else if (type === 'entry') {
        const path = item['path'];
        const size = item['size'];
        if (
          !header ||
          databaseComplete ||
          !safePath(path) ||
          paths.has(path) ||
          !Number.isSafeInteger(size) ||
          (size as number) < 0 ||
          (size as number) > BYTE_LIMIT - total
        )
          throw new Error('Invalid account archive record.');
        open = path;
        yield {
          name: path,
          size: size as number,
          modified,
          bytes: entryBytes(path, size as number),
        };
      } else if (type === 'complete') {
        if (
          !header ||
          databaseComplete ||
          item['totalBytes'] !== database.reduce((sum, receipt) => sum + receipt.size, 0) ||
          JSON.stringify(item['entries']) !== JSON.stringify(database)
        )
          throw new Error('Database snapshot manifest did not match.');
        databaseComplete = true;
        database = [];
      } else if (type === 'object-absent') {
        const path = item['path'];
        if (
          !databaseComplete ||
          item['state'] !== 'reserved' ||
          !safePath(path) ||
          !path.endsWith('.absent.json') ||
          paths.has(path)
        )
          throw new Error('Invalid reservation absence record.');
        const bytes = record({ key: item['key'], state: 'reserved', reason: item['reason'] });
        add({ path, size: bytes.length, sha256: bytesToHex(sha256(bytes)) });
        objects++;
        yield { name: path, size: bytes.length, modified, bytes: [bytes] };
      } else if (type === 'object') {
        if (!databaseComplete) throw new Error('File arrived before database snapshot completion.');
        const path = item['path'];
        const size = item['size'];
        if (
          typeof item['key'] !== 'string' ||
          !safePath(path) ||
          paths.has(path) ||
          !Number.isSafeInteger(size) ||
          (size as number) < 0 ||
          typeof item['etag'] !== 'string'
        )
          throw new Error('Invalid account file metadata.');
        if ((size as number) > BYTE_LIMIT - total)
          throw new Error('Account download exceeds the archive limit.');
        open = path;
        objects++;
        yield {
          name: path,
          size: size as number,
          modified,
          bytes: objectBytes(item, path, size as number),
        };
      } else if (type === 'metadata-complete') {
        if (!databaseComplete || item['objects'] !== objects)
          throw new Error('Account export is incomplete.');
        metadataComplete = true;
      } else throw new Error('Unexpected account metadata.');
    }
    if (open || !metadataComplete) throw new Error('Account metadata did not finish.');
    const receipt = record({
      format: 'onmyradar-account',
      version: 2,
      createdAt: modified.toISOString(),
      totalBytes: total,
      files: manifest,
    });
    yield { name: 'manifest.json', size: receipt.length, modified, bytes: [receipt] };
  } finally {
    await source.return(undefined);
  }
}

/** The account download as a standard .zip, produced as it streams. */
export async function* browserAccountArchive(
  metadata: Response,
  signal: AbortSignal,
  progress: (value: ExportProgress) => void,
  request: typeof fetch = fetch,
): AsyncGenerator<Uint8Array> {
  // Headers and descriptors are a few bytes each; batch them with file bytes so
  // the download worker is not sent thousands of tiny messages.
  let pending: Uint8Array[] = [];
  let pendingLength = 0;
  const flush = () => {
    const out = new Uint8Array(pendingLength);
    let at = 0;
    for (const part of pending) {
      out.set(part, at);
      at += part.length;
    }
    pending = [];
    pendingLength = 0;
    return out;
  };
  for await (const chunk of zip(accountFiles(metadata, signal, progress, request))) {
    if (signal.aborted) throw new Error('Account download was cancelled.');
    if (!pendingLength && chunk.length >= BATCH) {
      yield chunk;
      continue;
    }
    pending.push(chunk.slice());
    pendingLength += chunk.length;
    if (pendingLength >= BATCH) yield flush();
  }
  if (pendingLength) yield flush();
}
const BATCH = 64 * 1024;

/** Where the download worker lives; public/sw.js only intercepts under it. */
export const ACCOUNT_DOWNLOAD_SCOPE = '/account-export-download/';

export const ACCOUNT_DOWNLOAD_FILENAME = 'On-My-Radar-account.zip';
/** Past this, a download held in memory risks taking the tab down with it. */
const IN_MEMORY_LIMIT = 1024 ** 3;

/**
 * Whether this browser saves a download a service worker streams. WebKit does
 * not (Safari, and every browser on iOS, where all of them are WebKit): the
 * navigation is handed to the worker and nothing is saved. Those browsers get
 * the archive assembled in memory instead, which is bounded.
 */
export function streamsDownloads(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>): boolean {
  const ua = nav.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(ua);
  return !ios && !safari;
}

async function accountMetadata(signal: AbortSignal): Promise<Response> {
  const metadata = await fetch('/api/account/export', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!metadata.ok)
    throw new Error('Account download could not start. Sign in again or try later.');
  return metadata;
}

async function downloadInMemory(
  signal: AbortSignal,
  progress: (value: ExportProgress) => void,
): Promise<void> {
  const parts: BlobPart[] = [];
  let size = 0;
  for await (const chunk of browserAccountArchive(
    await accountMetadata(signal),
    signal,
    progress,
  )) {
    size += chunk.length;
    if (size > IN_MEMORY_LIMIT)
      throw new Error(
        'This account is too large to download in this browser. Use Chrome, Edge or Firefox on a computer.',
      );
    parts.push(chunk as Uint8Array<ArrayBuffer>);
  }
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = ACCOUNT_DOWNLOAD_FILENAME;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the save on a slow phone.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadAccount(
  signal: AbortSignal,
  progress: (value: ExportProgress) => void,
): Promise<void> {
  if (typeof ReadableStream === 'undefined')
    throw new Error('Use a current browser to download your account.');
  if (!('serviceWorker' in navigator) || !streamsDownloads(navigator))
    return downloadInMemory(signal, progress);
  // Its own narrow registration, never the root one: the root worker must keep
  // no fetch listener (see public/sw.js), and the download iframe's navigation
  // below is routed by URL scope, so this page need not be controlled by it.
  const registration = await navigator.serviceWorker.register('/sw.js', {
    scope: ACCOUNT_DOWNLOAD_SCOPE,
  });
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw new Error('The download service could not start. Refresh and try again.');
  if (worker.state !== 'activated')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Refresh to enable account downloads.')),
        10000,
      );
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  const metadata = await accountMetadata(signal);
  const archive = browserAccountArchive(metadata, signal, progress);
  const channel = new MessageChannel();
  const nonce = crypto.randomUUID().replaceAll('-', '');
  await new Promise<void>((resolve, reject) => {
    let frame: HTMLIFrameElement | undefined;
    let settled = false;
    const abort = () => fail(new Error('Account download cancelled.'));
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      frame?.remove();
    };
    const timer = setTimeout(() => fail(new Error('Refresh to enable account downloads.')), 10000);
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      channel.port1.postMessage({ type: 'error' });
      channel.port1.close();
      void archive.return(undefined);
      reject(error instanceof Error ? error : new Error('Account download failed.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    channel.port1.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (settled) return;
      if (event.data.type === 'ready') {
        clearTimeout(timer);
        frame = document.createElement('iframe');
        frame.hidden = true;
        frame.src = `${ACCOUNT_DOWNLOAD_SCOPE}${nonce}`;
        document.body.append(frame);
      } else if (event.data.type === 'pull') {
        void archive
          .next()
          .then((result) => {
            if (result.done) channel.port1.postMessage({ type: 'done' });
            else
              channel.port1.postMessage({ type: 'chunk', bytes: result.value }, [
                result.value.buffer,
              ]);
          })
          .catch(fail);
      } else if (event.data.type === 'complete') {
        cleanup();
        channel.port1.close();
        resolve();
      } else if (event.data.type === 'cancel') fail(new Error('Account download cancelled.'));
    };
    worker.postMessage({ type: 'account-export-download', nonce }, [channel.port2]);
  });
}

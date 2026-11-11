import { createHash } from 'node:crypto';

/** Transport for a complete export. A reader must require the final complete
 * record; an interrupted download is never a successful account archive. */
export type ExportEntry = {
  path: string;
  size: number;
  bytes: AsyncIterable<Uint8Array>;
};

export async function* accountArchive(
  entries: AsyncIterable<ExportEntry>,
  byteLimit: number,
): AsyncGenerator<string> {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1)
    throw new Error('Export byte limit must be a positive safe integer');
  const seen = new Set<string>();
  const manifest: Array<{ path: string; size: number; sha256: string }> = [];
  let total = 0;
  yield JSON.stringify({ type: 'archive', format: 'onmyradar-account', version: 1 }) + '\n';
  for await (const entry of entries) {
    if (seen.size >= 200100) throw new Error('Export entry count exceeds its bound');
    if (
      entry.path.length > 256 ||
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(entry.path) ||
      entry.path.split('/').some((part) => part === '.' || part === '..') ||
      seen.has(entry.path)
    )
      throw new Error('Unsafe or duplicate export path');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > byteLimit - total)
      throw new Error('Export size exceeds its bound');
    seen.add(entry.path);
    const hash = createHash('sha256');
    let size = 0;
    yield JSON.stringify({ type: 'entry', path: entry.path, size: entry.size }) + '\n';
    for await (const bytes of entry.bytes) {
      size += bytes.byteLength;
      if (size > entry.size) throw new Error('Export object exceeded declared size');
      hash.update(bytes);
      // Bound each encoded record even when an upstream reader returns a large chunk.
      for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
        yield JSON.stringify({
          type: 'chunk',
          path: entry.path,
          base64: Buffer.from(bytes.subarray(offset, offset + 65536)).toString('base64'),
        }) + '\n';
      }
    }
    if (size !== entry.size) throw new Error('Export object was truncated');
    total += size;
    const result = { path: entry.path, size, sha256: hash.digest('hex') };
    manifest.push(result);
    yield JSON.stringify({ type: 'end-entry', ...result }) + '\n';
  }
  yield JSON.stringify({ type: 'complete', totalBytes: total, entries: manifest }) + '\n';
}

/** Test support: reads back what lib/zip.ts writes, the way unzip tools do. */
function same(actual: unknown, expected: unknown, what: string): void {
  // Plain comparisons: `expect` per entry made 70,000 entries take 13 s in CI.
  if (actual !== expected)
    throw new Error(`zip ${what}: ${String(actual)} !== ${String(expected)}`);
}
import { crc32 } from './zip';

/** Reads a zip through its central directory, as unzip tools do, checking every CRC. */
export function readZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  same(view.getUint32(end, true), 0x06054b50, 'view.getUint32(end, true)');
  let count = view.getUint16(end + 10, true);
  let directory = view.getUint32(end + 16, true);
  const zip64 = count === 0xffff;
  if (zip64) {
    const locator = end - 20;
    same(view.getUint32(locator, true), 0x07064b50, 'view.getUint32(locator, true)');
    const record = Number(view.getBigUint64(locator + 8, true));
    same(view.getUint32(record, true), 0x06064b50, 'view.getUint32(record, true)');
    count = Number(view.getBigUint64(record + 32, true));
    directory = Number(view.getBigUint64(record + 48, true));
  }
  const files = new Map<string, Uint8Array>();
  let at = directory;
  for (let i = 0; i < count; i++) {
    same(view.getUint32(at, true), 0x02014b50, 'view.getUint32(at, true)');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    same(view.getUint32(offset, true), 0x04034b50, 'view.getUint32(offset, true)');
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = archive.subarray(start, start + size);
    same(crc32(data), crc, 'crc32(data)');
    same(view.getUint32(start + size, true), 0x08074b50, 'view.getUint32(start + size, true)');
    same(view.getUint32(start + size + 4, true), crc, 'view.getUint32(start + size + 4, true)');
    files.set(name, data.slice());
    at += 46 + nameLength + extraLength + commentLength;
  }
  same(at, zip64 ? end - 76 : end, 'at');
  return files;
}

export async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk.slice());
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

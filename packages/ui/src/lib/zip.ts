/**
 * A streaming ZIP writer: stored (uncompressed) entries, sizes and checksums in
 * a data descriptor after each entry, ZIP64 wherever a size, offset or count
 * needs it. Nothing is buffered but the central directory, one small record per
 * file, so an archive of any size passes through in the chunks it arrives in.
 *
 * Stored rather than deflated on purpose: most of an account's bytes are
 * already-compressed attachments, and every unzip tool on every phone and
 * computer reads stored entries.
 */
export type ZipEntry = {
  name: string;
  /** Declared length. An entry that streams a different length fails the archive. */
  size: number;
  modified: Date;
  bytes: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++)
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return ~crc >>> 0;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_AND_DESCRIPTOR = 0x0808;
const encoder = new TextEncoder();

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function record(length: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

export async function* zip(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = [];
  const names = new Set<string>();
  let offset = 0;
  let count = 0;
  for await (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error('Zip entry length is invalid.');
    if (names.has(entry.name)) throw new Error('Zip entry name is repeated.');
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    const when = dosTime(entry.modified);
    const large = entry.size >= MAX32;
    const version = large ? 45 : 20;
    const start = offset;
    // Sizes are only known for certain once the bytes have streamed; a ZIP64
    // entry announces itself here so readers expect 8-byte descriptor sizes.
    const local = record(30 + name.length + (large ? 20 : 0), (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, version, true);
      view.setUint16(6, UTF8_AND_DESCRIPTOR, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, when.time, true);
      view.setUint16(12, when.date, true);
      view.setUint32(18, large ? MAX32 : 0, true);
      view.setUint32(22, large ? MAX32 : 0, true);
      view.setUint16(26, name.length, true);
      view.setUint16(28, large ? 20 : 0, true);
      if (large) {
        view.setUint16(30 + name.length, 0x0001, true);
        view.setUint16(32 + name.length, 16, true);
      }
    });
    local.set(name, 30);
    yield local;
    let crc = 0;
    let size = 0;
    for await (const chunk of entry.bytes) {
      size += chunk.length;
      if (size > entry.size) throw new Error('Zip entry exceeded its length.');
      // Before the yield: a consumer may transfer (detach) the chunk's buffer.
      crc = crc32(chunk, crc);
      yield chunk;
    }
    if (size !== entry.size) throw new Error('Zip entry ended early.');
    const descriptor = record(large ? 24 : 16, (view) => {
      view.setUint32(0, 0x08074b50, true);
      view.setUint32(4, crc, true);
      if (large) {
        view.setBigUint64(8, BigInt(size), true);
        view.setBigUint64(16, BigInt(size), true);
      } else {
        view.setUint32(8, size, true);
        view.setUint32(12, size, true);
      }
    });
    yield descriptor;
    offset += local.length + size + descriptor.length;
    count++;

    const extra: bigint[] = [];
    if (large) extra.push(BigInt(size), BigInt(size));
    if (start >= MAX32) extra.push(BigInt(start));
    const extraLength = extra.length ? 4 + extra.length * 8 : 0;
    const header = record(46 + name.length + extraLength, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, (3 << 8) | 45, true); // Unix, so the mode below is read
      view.setUint16(6, extra.length ? 45 : version, true);
      view.setUint16(8, UTF8_AND_DESCRIPTOR, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, when.time, true);
      view.setUint16(14, when.date, true);
      view.setUint32(16, crc, true);
      view.setUint32(20, large ? MAX32 : size, true);
      view.setUint32(24, large ? MAX32 : size, true);
      view.setUint16(28, name.length, true);
      view.setUint16(30, extraLength, true);
      view.setUint32(38, (0o100644 << 16) >>> 0, true);
      view.setUint32(42, start >= MAX32 ? MAX32 : start, true);
      if (extra.length) {
        const at = 46 + name.length;
        view.setUint16(at, 0x0001, true);
        view.setUint16(at + 2, extra.length * 8, true);
        extra.forEach((value, index) => view.setBigUint64(at + 4 + index * 8, value, true));
      }
    });
    header.set(name, 46);
    central.push(header);
  }

  const directoryStart = offset;
  let directorySize = 0;
  for (const header of central) {
    directorySize += header.length;
    yield header;
  }
  const zip64 = count >= MAX16 || directoryStart >= MAX32 || directorySize >= MAX32;
  if (zip64) {
    const end64 = directoryStart + directorySize;
    yield record(56, (view) => {
      view.setUint32(0, 0x06064b50, true);
      view.setBigUint64(4, 44n, true);
      view.setUint16(12, (3 << 8) | 45, true);
      view.setUint16(14, 45, true);
      view.setBigUint64(24, BigInt(count), true);
      view.setBigUint64(32, BigInt(count), true);
      view.setBigUint64(40, BigInt(directorySize), true);
      view.setBigUint64(48, BigInt(directoryStart), true);
    });
    yield record(20, (view) => {
      view.setUint32(0, 0x07064b50, true);
      view.setBigUint64(8, BigInt(end64), true);
      view.setUint32(16, 1, true);
    });
  }
  yield record(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, zip64 ? MAX16 : count, true);
    view.setUint16(10, zip64 ? MAX16 : count, true);
    view.setUint32(12, zip64 ? MAX32 : directorySize, true);
    view.setUint32(16, zip64 ? MAX32 : directoryStart, true);
  });
}

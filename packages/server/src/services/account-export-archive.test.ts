import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountArchive, type ExportEntry } from './account-export-archive.js';

const decode = (line: string) => JSON.parse(line) as { type: string; base64: string };

async function* bytes(value: string) {
  yield Buffer.from(value);
}
async function* entries(values: ExportEntry[]) {
  yield* values;
}
const entry = (path: string, value: string, size = Buffer.byteLength(value)): ExportEntry => ({
  path,
  size,
  bytes: bytes(value),
});

describe('account archive completeness', () => {
  it('round-trips binary chunks and verifies every declared object', async () => {
    const value = 'a'.repeat(150000);
    const records = [];
    for await (const line of accountArchive(entries([entry('objects/a.bin', value)]), 200000))
      records.push(decode(line));
    const chunks = records.filter((record) => record.type === 'chunk');
    expect(
      Buffer.concat(chunks.map((record) => Buffer.from(record.base64, 'base64'))).toString(),
    ).toBe(value);
    expect(chunks.every((record) => Buffer.from(record.base64, 'base64').length <= 65536)).toBe(
      true,
    );
    expect(records.at(-1)).toEqual({
      type: 'complete',
      totalBytes: 150000,
      entries: [
        {
          path: 'objects/a.bin',
          size: 150000,
          sha256: createHash('sha256').update(value).digest('hex'),
        },
      ],
    });
  });

  it.each([
    [entry('objects/../escape', '')],
    [entry('/absolute', '')],
    [entry('objects/a.bin', 'abc', 2)],
    [entry('objects/a.bin', 'ab', 3)],
    [entry('objects/a.bin', 'abc'), entry('objects/a.bin', 'abc')],
    [entry('objects/a.bin', 'abc', 101)],
  ])('never certifies an invalid or incomplete archive', async (...values) => {
    const records: Array<{ type: string }> = [];
    await expect(async () => {
      for await (const line of accountArchive(entries(values), 100)) records.push(decode(line));
    }).rejects.toThrow();
    expect(records.some((record) => record.type === 'complete')).toBe(false);
  });

  it('does not certify an upstream read failure', async () => {
    async function* failing() {
      yield Buffer.from('a');
      throw new Error('object unavailable');
    }
    const records: Array<{ type: string }> = [];
    await expect(async () => {
      for await (const line of accountArchive(
        entries([{ path: 'objects/a', size: 2, bytes: failing() }]),
        100,
      ))
        records.push(decode(line));
    }).rejects.toThrow('object unavailable');
    expect(records.some((record) => record.type === 'complete')).toBe(false);
  });
});

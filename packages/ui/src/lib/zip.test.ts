import { describe, expect, it } from 'vitest';
import { crc32, zip, type ZipEntry } from './zip';
import { collect, readZip } from './zip-test-reader';

async function* bytes(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}
async function* entries(...values: ZipEntry[]) {
  yield* values;
}
const modified = new Date(2026, 9, 6, 12, 30, 10);

describe('streaming zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const whole = crc32(new TextEncoder().encode('hello world'));
    expect(
      crc32(new TextEncoder().encode(' world'), crc32(new TextEncoder().encode('hello'))),
    ).toBe(whole);
  });

  it('writes entries that read back exactly, with UTF-8 names and folders', async () => {
    const archive = await collect(
      zip(
        entries(
          { name: 'README.txt', size: 5, modified, bytes: bytes('hello') },
          { name: 'radars/Café/note.md', size: 10, modified, bytes: bytes('# Hi', '\n\nbody') },
          { name: 'empty.json', size: 0, modified, bytes: bytes() },
        ),
      ),
    );
    const files = readZip(archive);
    expect([...files.keys()]).toEqual(['README.txt', 'radars/Café/note.md', 'empty.json']);
    expect(new TextDecoder().decode(files.get('radars/Café/note.md'))).toBe('# Hi\n\nbody');
    expect(files.get('empty.json')?.length).toBe(0);
  });

  it('switches to ZIP64 records past 65,534 entries', async () => {
    async function* many() {
      for (let i = 0; i < 70_000; i++)
        yield { name: `data/${i}.json`, size: 1, modified, bytes: bytes('x') };
    }
    const files = readZip(await collect(zip(many())));
    expect(files.size).toBe(70_000);
    expect(new TextDecoder().decode(files.get('data/69999.json'))).toBe('x');
  }, 30_000);

  it.each([
    ['ends early', 6],
    ['runs long', 4],
  ])('fails, without a central directory, when an entry %s', async (_case, size) => {
    const output: Uint8Array[] = [];
    await expect(async () => {
      for await (const chunk of zip(
        entries({ name: 'a.txt', size, modified, bytes: bytes('hello') }),
      ))
        output.push(chunk);
    }).rejects.toThrow();
    const last = output.at(-1);
    expect(last && new DataView(last.buffer).getUint32(0, true)).not.toBe(0x06054b50);
  });

  it('refuses a repeated name', async () => {
    await expect(
      collect(
        zip(
          entries(
            { name: 'a', size: 0, modified, bytes: bytes() },
            { name: 'a', size: 0, modified, bytes: bytes() },
          ),
        ),
      ),
    ).rejects.toThrow('repeated');
  });
});

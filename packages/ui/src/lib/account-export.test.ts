import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { browserAccountArchive, streamsDownloads } from './account-export';
import { collect, readZip } from './zip-test-reader';

const file = new Uint8Array([0, 1, 128, 255, 3]);
const digest = createHash('sha256').update(file).digest('hex');
const readme = 'Hello from your account\n';
const readmeDigest = createHash('sha256').update(readme).digest('hex');
const database: Array<Record<string, unknown>> = [
  { type: 'archive', format: 'onmyradar-account', version: 1 },
  { type: 'entry', path: 'README.txt', size: readme.length },
  { type: 'chunk', path: 'README.txt', base64: Buffer.from(readme).toString('base64') },
  { type: 'end-entry', path: 'README.txt', size: readme.length, sha256: readmeDigest },
  {
    type: 'complete',
    totalBytes: readme.length,
    entries: [{ path: 'README.txt', size: readme.length, sha256: readmeDigest }],
  },
];
function metadata(
  patch: Record<string, unknown> = {},
  complete = true,
  head: Array<Record<string, unknown>> = database,
) {
  const records = [
    ...head,
    {
      type: 'object',
      path: 'radars/Ideas/files/photo.jpg',
      key: 'radars/owned/file',
      size: file.length,
      etag: 'fixed-etag',
      sha256: digest,
      ...patch,
    },
    ...(complete ? [{ type: 'metadata-complete', objects: 1 }] : []),
  ];
  return new Response(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function storage(fileResponse = new Response(file)) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ url: 'https://storage.example.test/file?private-ticket' })),
    )
    .mockResolvedValueOnce(fileResponse);
}
async function run(source: Response, request: typeof fetch = storage()) {
  const archive = await collect(
    browserAccountArchive(source, new AbortController().signal, () => {}, request),
  );
  return { files: readZip(archive), archive, request };
}
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
/** pipeThrough hides its pipeTo shutdown promise. Observe that real operation
 * before asserting the upstream body's lock, not just the decoder's reader. */
function observeMetadataPipe(source: Response) {
  const body = source.body;
  if (!body) throw new Error('Synthetic metadata requires a body');
  const pipes: Promise<void>[] = [];
  const pipeThrough = vi.spyOn(body, 'pipeThrough').mockImplementation((transform, options) => {
    const completion = body.pipeTo(transform.writable, options);
    // Early cancellation rejects the real pipe. Retain its result for the
    // test while handling it immediately, just as native pipeThrough does.
    void completion.catch(() => undefined);
    pipes.push(completion);
    return transform.readable;
  });
  return {
    settled: () => Promise.allSettled(pipes),
    restore: () => pipeThrough.mockRestore(),
  };
}
describe('account download as a zip', () => {
  it('writes readable files, storage bytes and a closing checksum manifest', async () => {
    const { files, archive, request } = await run(metadata());
    expect([...files.keys()]).toEqual([
      'README.txt',
      'radars/Ideas/files/photo.jpg',
      'manifest.json',
    ]);
    expect(text(files.get('README.txt'))).toBe(readme);
    expect(files.get('radars/Ideas/files/photo.jpg')).toEqual(file);
    expect(JSON.parse(text(files.get('manifest.json')))).toMatchObject({
      format: 'onmyradar-account',
      version: 2,
      totalBytes: readme.length + file.length,
      files: [
        { path: 'README.txt', size: readme.length, sha256: readmeDigest },
        { path: 'radars/Ideas/files/photo.jpg', size: file.length, sha256: digest },
      ],
    });
    expect(text(archive)).not.toContain('private-ticket');
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://storage.example.test/file?private-ticket',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: { 'If-Match': 'fixed-etag' },
      }),
    );
  });
  it('releases naturally exhausted metadata and object readers without requesting cancellation', async () => {
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const source = metadata();
    const object = new Response(file);
    const pipe = observeMetadataPipe(source);
    try {
      const { files } = await run(source, storage(object));
      expect(await pipe.settled()).toEqual([{ status: 'fulfilled', value: undefined }]);
      expect(files.has('manifest.json')).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
      expect(source.body?.locked).toBe(false);
      expect(object.body?.locked).toBe(false);
    } finally {
      pipe.restore();
      cancel.mockRestore();
    }
  });
  it('cancels an open metadata source when the archive consumer stops early', async () => {
    const cancel = vi.fn();
    const big = Buffer.alloc(65536, 1).toString('base64');
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const row of [
            database[0],
            { type: 'entry', path: 'data/big.json', size: 70000 },
            { type: 'chunk', path: 'data/big.json', base64: big },
          ])
            controller.enqueue(new TextEncoder().encode(JSON.stringify(row) + '\n'));
        },
        cancel,
      }),
    );
    const pipe = observeMetadataPipe(source);
    const archive = browserAccountArchive(source, new AbortController().signal, () => {});
    try {
      const first = await archive.next();
      expect(first.done).toBe(false);
      await archive.return(undefined);
      expect(await pipe.settled()).toEqual([{ status: 'rejected', reason: undefined }]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(source.body?.locked).toBe(false);
    } finally {
      await archive.return(undefined);
      await pipe.settled();
      pipe.restore();
    }
  });
  it.each([false, true])(
    'cancels an oversized open object and releases its reader even if cancellation rejects (%s)',
    async (rejectCancellation) => {
      const cancel = vi.fn(() => {
        if (rejectCancellation) return Promise.reject(new Error('Synthetic cleanup failure'));
        return Promise.resolve();
      });
      const object = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(file.length + 1));
          },
          cancel,
        }),
      );
      const release = vi.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
      const readerCancel = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
      const output: Uint8Array[] = [];
      try {
        await expect(async () => {
          for await (const bytes of browserAccountArchive(
            metadata(),
            new AbortController().signal,
            () => {},
            storage(object),
          ))
            output.push(bytes);
        }).rejects.toThrow(rejectCancellation ? 'Synthetic cleanup failure' : 'recorded length');
        expect(cancel).toHaveBeenCalledOnce();
        expect(object.body?.locked).toBe(false);
        expect(text(Buffer.concat(output))).not.toContain('manifest.json');
        expect(release.mock.contexts).toEqual(expect.arrayContaining(readerCancel.mock.contexts));
      } finally {
        readerCancel.mockRestore();
        release.mockRestore();
      }
    },
  );
  it.each([
    [{ sha256: '0'.repeat(64) }, new Response(file)],
    [{ size: file.length + 1 }, new Response(file)],
    [{ path: 'objects/../../escape' }, new Response(file)],
    [{ path: 'manifest.json' }, new Response(file)],
    [{ path: 'README.txt' }, new Response(file)],
    [{}, new Response('', { status: 404 })],
  ])('refuses missing, changed, truncated, repeated or unsafe files', async (patch, response) => {
    await expect(run(metadata(patch), storage(response))).rejects.toThrow();
  });
  it('refuses a database file whose bytes do not match its receipt', async () => {
    const head = database.map((row) =>
      row['type'] === 'chunk'
        ? { ...row, base64: Buffer.from('tampered text!!!!!!!!!!!').toString('base64') }
        : row,
    );
    await expect(run(metadata({}, true, head))).rejects.toThrow('checksum');
  });
  it('refuses an interrupted metadata stream or refused ticket', async () => {
    await expect(run(metadata({}, false))).rejects.toThrow('did not finish');
    await expect(
      run(metadata(), vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }))),
    ).rejects.toThrow('cannot be downloaded');
  });
  it('records a never-landed reservation explicitly without inventing original bytes', async () => {
    const source = new Response(
      [
        ...database,
        {
          type: 'object-absent',
          path: 'other-files/1.absent.json',
          key: 'radars/owned/reserved',
          state: 'reserved',
          reason: 'Provider confirmed no object',
        },
        { type: 'metadata-complete', objects: 1 },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const request = vi.fn<typeof fetch>();
    const { files } = await run(source, request);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(text(files.get('other-files/1.absent.json')))).toMatchObject({
      state: 'reserved',
    });
    expect(files.has('manifest.json')).toBe(true);
  });
  it('never writes the manifest after a truncated object or cancellation', async () => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      if (cancelled) controller.abort();
      const output: Uint8Array[] = [];
      await expect(async () => {
        for await (const bytes of browserAccountArchive(
          metadata(),
          controller.signal,
          () => {},
          storage(new Response(file.slice(0, 2))),
        ))
          output.push(bytes);
      }).rejects.toThrow();
      expect(text(Buffer.concat(output))).not.toContain('manifest.json');
    }
  });
});

describe('which browsers stream the download', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      0,
      true,
    ],
    [
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
      5,
      true,
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 0, true],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      0,
      false,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      5,
      false,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
      5,
      false,
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      5,
      false,
    ],
  ])('%s', (userAgent, maxTouchPoints, expected) => {
    expect(streamsDownloads({ userAgent, maxTouchPoints })).toBe(expected);
  });
});

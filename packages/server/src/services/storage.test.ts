import { createServer, type Socket } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { LIMITS } from '@onmyradar/contract';
import { loadEnv, setEnvForTesting } from '../env.js';
import { ApiError } from '../http.js';
import {
  assertUploadable,
  buildObjectKey,
  checkBrowserUploadCors,
  createDownloadUrl,
  createUploadTicket,
  deleteObjects,
  headObject,
  readEmailContent,
  resetStorageClientForTesting,
  safeFilename,
  isIssuedAttachmentKey,
  STORAGE_TIMEOUTS,
} from './storage.js';

afterEach(() => vi.restoreAllMocks());

function storageEnv(endpoint: string) {
  return loadEnv({
    DATABASE_URL: 'postgres://unused',
    SESSION_SECRET: 'x'.repeat(48),
    NODE_ENV: 'test',
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: 'unused',
    S3_SECRET_KEY: 'unused',
    S3_BUCKET: 'on-my-radar',
    S3_REGION: 'gnvl',
  });
}

beforeAll(() => {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'x'.repeat(48),
      NODE_ENV: 'test',
      // Configured, and pointing at a port nothing is listening on. That is the
      // whole point of the `headObject` test below: storage that is *set up*
      // and *unreachable* is precisely the state the empty catch used to
      // report as "your upload was not completed".
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_ACCESS_KEY: 'unused',
      S3_SECRET_KEY: 'unused',
      S3_BUCKET: 'on-my-radar',
      S3_REGION: 'gnvl',
    }),
  );
});

describe('isIssuedAttachmentKey', () => {
  const radar = '11111111-1111-4111-8111-111111111111';
  const id = '22222222-2222-4222-8222-222222222222';
  it('accepts exactly what buildObjectKey issues', () => {
    expect(isIssuedAttachmentKey(radar, buildObjectKey(radar, 'a b.png'))).toBe(true);
    expect(isIssuedAttachmentKey(radar, buildObjectKey(radar, '..'))).toBe(true);
    expect(isIssuedAttachmentKey(radar, `radars/${radar}/${id}/${'a'.repeat(64)}/0-a.png`)).toBe(
      true,
    );
  });
  it.each([
    `radars/${radar}/${id}/../../x/y`,
    `radars/${radar}/${id}/a/b`,
    `radars/${radar}/${id}/other/0-a.png`,
    `radars/${radar}/${id}/..`,
    `radars/${radar}/${id}/.`,
    `radars/${radar}/${id}/%2e%2e`,
    `radars/${radar}/${id}/a%2fb`,
    `radars/${radar}/${id}/a\\b`,
    `radars/${radar}/${id}/a\nb`,
    `radars/${radar}/${id}/x.png/`,
    `radars/${radar}/file`,
    `radars/33333333-3333-4333-8333-333333333333/${id}/x.png`,
    `radars/${radar}/zzzz/x.png`,
  ])('refuses %j', (key) => {
    expect(isIssuedAttachmentKey(radar, key)).toBe(false);
  });
});

describe('safeFilename', () => {
  it('strips path components so a name cannot escape its prefix', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..')).toBe('file');
    expect(safeFilename('C:\\Users\\me\\note.txt')).toBe('note.txt');
  });

  it('strips characters that would break a content-disposition header', () => {
    expect(safeFilename('re"port.pdf')).toBe('report.pdf');
    expect(safeFilename('a\nb.txt')).toBe('ab.txt');
  });

  it('never returns an empty name', () => {
    expect(safeFilename('')).toBe('file');
    expect(safeFilename('///')).toBe('file');
  });
});

describe('buildObjectKey', () => {
  it('prefixes by radar so ownership is checkable from the key alone', () => {
    const key = buildObjectKey('11111111-1111-1111-1111-111111111111', 'shot.png');
    expect(key.startsWith('radars/11111111-1111-1111-1111-111111111111/')).toBe(true);
    expect(key.endsWith('/shot.png')).toBe(true);
  });

  it('does not collide for the same filename', () => {
    const a = buildObjectKey('r', 'shot.png');
    const b = buildObjectKey('r', 'shot.png');
    expect(a).not.toBe(b);
  });
});

describe('assertUploadable', () => {
  it('accepts ordinary files', () => {
    expect(() => assertUploadable('image/png', 1024)).not.toThrow();
    expect(() => assertUploadable('application/pdf; charset=binary', 1024)).not.toThrow();
  });

  it('rejects anything that would execute in the browser', () => {
    expect(() => assertUploadable('text/html', 10)).toThrow();
    expect(() => assertUploadable('image/svg+xml', 10)).toThrow();
  });

  it('rejects oversized files and nonsense content types', () => {
    expect(() => assertUploadable('image/png', LIMITS.attachmentBytes + 1)).toThrow();
    expect(() => assertUploadable('nonsense', 10)).toThrow();
    expect(() => assertUploadable('', 10)).toThrow();
    expect(() => assertUploadable('image/png', -1)).toThrow();
    expect(() => assertUploadable('image/png', Number.NaN)).toThrow();
  });
});

describe('headObject', () => {
  it('refuses absent or malformed HEAD byte metadata instead of inventing an empty object', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    for (const length of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      send.mockResolvedValueOnce({
        ContentLength: length,
        ContentType: 'application/json',
      } as never);
      await expect(headObject('radars/fixture/email-content.json')).rejects.toMatchObject({
        status: 503,
      });
    }
    send.mockResolvedValueOnce({ ContentLength: 0, ContentType: 'application/json' } as never);
    await expect(headObject('radars/fixture/empty.json')).resolves.toEqual({
      size: 0,
      contentType: 'application/json',
    });
  });

  /**
   * The distinction this exists to hold: `null` means the object is absent, and
   * unreachable storage is not that. The catch here used to be empty, so a
   * MinIO outage came back as `null`, which `createBlip` turned into
   * `Upload "…" was not completed` — the user's mistake, on a screen with no
   * way to act on it, and no server-side log line at all.
   *
   * Unreachable is simulated rather than mocked: a real S3 client against a
   * closed port takes the same code path a real outage does.
   */
  it('throws rather than reporting absence when the storage cannot be reached', async () => {
    await expect(headObject('radars/abc/does-not-matter')).rejects.toThrow(ApiError);
    await expect(headObject('radars/abc/does-not-matter')).rejects.toMatchObject({ status: 503 });
  }, 30_000);

  /**
   * The outage that never refuses: a storage that accepts the connection and
   * never answers. With the SDK's default of no timeout this call — and the
   * outbox lane running object cleanup — waited forever.
   */
  it('gives up on a storage that accepts and never answers', async () => {
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as { port: number };
    const original = { ...STORAGE_TIMEOUTS };
    STORAGE_TIMEOUTS.requestTimeout = 200;
    setEnvForTesting(storageEnv(`http://127.0.0.1:${port}`));
    resetStorageClientForTesting();
    try {
      await expect(headObject('radars/abc/hung')).rejects.toMatchObject({ status: 503 });
    } finally {
      Object.assign(STORAGE_TIMEOUTS, original);
      setEnvForTesting(storageEnv('http://127.0.0.1:1'));
      resetStorageClientForTesting();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 10_000);
});

describe('presigning against MinIO-shaped configuration', () => {
  it('signs both the allowed content type and file size into the upload ticket', async () => {
    const ticket = await createUploadTicket('radar', 'image.png', 'image/png', 123);
    const url = new URL(ticket.url);
    expect(url.pathname).toMatch(/^\/on-my-radar\/radars\/radar\/.+\/image.png$/);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/gnvl/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    expect(ticket.headers['content-type']).toBe('image/png');
  });

  it('signs no checksum of the (absent) body into an upload ticket', async () => {
    // The SDK's WHEN_SUPPORTED default baked `x-amz-checksum-crc32=AAAAAA==` —
    // the CRC32 of zero bytes — into every presigned PUT, and R2 refuses the
    // real file against it. A pasted screenshot was the report; every browser
    // upload was affected.
    const ticket = await createUploadTicket('radar', 'image.png', 'image/png', 123);
    const params = [...new URL(ticket.url).searchParams.keys()].map((k) => k.toLowerCase());
    expect(params.filter((k) => k.startsWith('x-amz-checksum'))).toEqual([]);
    expect(params).not.toContain('x-amz-sdk-checksum-algorithm');
  });

  it('preserves download content disposition', async () => {
    const url = new URL(await createDownloadUrl('radars/radar/file', 'image.png', 'image/png'));
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="image.png"',
    );
    expect(url.searchParams.get('response-content-type')).toBe('image/png');
  });

  it('never serves a type a browser would run as a page', async () => {
    for (const type of ['text/xml', 'application/xml; charset=utf-8', 'application/rss+xml']) {
      const url = new URL(await createDownloadUrl('radars/radar/file', 'feed.xml', type));
      expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="feed.xml"',
      );
    }
  });
});

describe('stored email content', () => {
  it('reads an email whose inline images take it past the twelve-attachment ceiling', async () => {
    const content = {
      text: 'Issue 12',
      html: '<p>Issue 12</p>',
      files: Array.from({ length: 30 }, (_, i) => ({
        key: `radars/r/e/${i}.png`,
        contentId: `img${i}`,
        inline: i > 1,
      })),
    };
    const bytes = Buffer.from(JSON.stringify(content));
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- S3Client.send also has void callback overloads; only the promise form is ever called
    vi.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async () => ({
      ContentLength: bytes.byteLength,
      Body: (async function* () {
        yield new Uint8Array(bytes);
      })(),
    }));
    await expect(readEmailContent('radars/r/e/email-content.json')).resolves.toMatchObject({
      text: 'Issue 12',
      files: expect.arrayContaining([expect.objectContaining({ contentId: 'img29' })]) as unknown,
    });
  });
});

describe('durable object cleanup', () => {
  it('propagates a storage outage so the outbox can retry', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce(new Error('storage offline'));
    await expect(deleteObjects(['radars/r/file'])).rejects.toThrow('storage offline');
  });

  it('treats per-key errors in an HTTP success response as incomplete cleanup', async () => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- as above
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async () => ({
      Errors: [{ Key: 'radars/r/file', Code: 'InternalError' }],
    }));
    await expect(deleteObjects(['radars/r/file'])).rejects.toThrow('InternalError');
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- as above
    send.mockImplementationOnce(async () => ({}));
    await expect(deleteObjects(['radars/r/file'])).resolves.toBeUndefined();
  });

  it('deletes in batches of at most 1000 keys', async () => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- as above
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({}));
    await deleteObjects(Array.from({ length: 1001 }, (_, i) => `radars/r/file-${i}`));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: { Delete: { Objects: expect.any(Array) as unknown } },
    });
    const first = send.mock.calls[0]?.[0] as unknown as {
      input: { Delete: { Objects: unknown[] } };
    };
    const last = send.mock.calls[1]?.[0] as unknown as {
      input: { Delete: { Objects: unknown[] } };
    };
    expect(first.input.Delete.Objects).toHaveLength(1000);
    expect(last.input.Delete.Objects).toHaveLength(1);
  });
});

describe('checkBrowserUploadCors', () => {
  const preflight = (status: number, allowOrigin?: string) =>
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status,
        headers: allowOrigin ? { 'access-control-allow-origin': allowOrigin } : {},
      }),
    );

  it('asks exactly what the browser will: a PUT preflight from the app origin', async () => {
    const fetchMock = preflight(200, 'http://localhost:3500');
    await expect(checkBrowserUploadCors(fetchMock)).resolves.toMatchObject({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toMatch(/^\/on-my-radar\/radars\/cors-probe\//);
    expect(init.method).toBe('OPTIONS');
    expect(init.headers).toMatchObject({
      origin: 'http://localhost:3500',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    });
  });

  it('flags R2 with no CORS policy — 403, no allow-origin — as not ok', async () => {
    await expect(checkBrowserUploadCors(preflight(403))).resolves.toMatchObject({
      ok: false,
      status: 403,
      allowOrigin: null,
    });
  });

  it('flags a policy that allows some other origin', async () => {
    await expect(
      checkBrowserUploadCors(preflight(200, 'https://elsewhere.example')),
    ).resolves.toMatchObject({ ok: false });
  });

  it('returns null rather than a verdict when the storage does not answer', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(checkBrowserUploadCors(fetchMock)).resolves.toBeNull();
  });
});

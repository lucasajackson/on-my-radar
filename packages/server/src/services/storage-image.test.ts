/* eslint-disable @typescript-eslint/no-misused-promises -- S3Client.send has a void callback overload; these spies implement only its actual Promise overload. */
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, setEnvForTesting } from '../env.js';
import { readImageObject, resetStorageClientForTesting } from './storage.js';

beforeEach(() => {
  setEnvForTesting(
    loadEnv({
      DATABASE_URL: 'postgres://unused',
      SESSION_SECRET: 'synthetic-image-storage-secret-unused',
      S3_ACCESS_KEY: 'synthetic',
      S3_SECRET_KEY: 'synthetic',
      S3_ENDPOINT: 'http://127.0.0.1:1',
    }),
  );
  resetStorageClientForTesting();
});
afterEach(() => {
  vi.restoreAllMocks();
  setEnvForTesting(null);
  resetStorageClientForTesting();
});

describe('bounded image storage reader', () => {
  it('reads bytes with missing length metadata but verifies provided lengths', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    send.mockImplementationOnce(async () => ({
      Body: Readable.from([Buffer.from('image')]),
      ContentType: 'image/png',
    }));
    expect(await readImageObject('PRIVATE', 10, 1000)).toMatchObject({
      bytes: Buffer.from('image'),
    });
    send.mockImplementationOnce(async () => ({
      Body: Readable.from([Buffer.from('short')]),
      ContentLength: 9,
    }));
    await expect(readImageObject('PRIVATE', 10, 1000)).rejects.toMatchObject({ status: 503 });
  });
  it('destroys oversized bodies from both metadata and incremental chunks', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    for (const length of [100, undefined]) {
      const body = Readable.from([Buffer.alloc(11)]);
      send.mockImplementationOnce(async () => ({ Body: body, ContentLength: length }));
      await expect(readImageObject('PRIVATE', 10, 1000)).rejects.toMatchObject({ status: 413 });
      expect(body.destroyed).toBe(true);
    }
  });
  it('destroys a stalled stream on the real abort deadline and scrubs provider failures', async () => {
    const body = new Readable({ read() {} });
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementationOnce(async () => ({ Body: body }));
    await expect(readImageObject('PRIVATEKEY', 10, 20)).rejects.toMatchObject({
      status: 503,
      code: 'image_unavailable',
    });
    expect(body.destroyed).toBe(true);
    send.mockRejectedValueOnce(new Error('https://signedPRIVATE/SECRET bytesCANARY'));
    await expect(readImageObject('PRIVATEKEY', 10, 1000)).rejects.toMatchObject({
      status: 503,
      code: 'image_unavailable',
    });
  });
  it('aborts an actual SDK HTTP request before stalled response headers arrive', async () => {
    let received: IncomingMessage | undefined;
    const server = createServer((request) => {
      received = request;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing synthetic port');
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'synthetic-image-storage-secret-unused',
        S3_ACCESS_KEY: 'synthetic',
        S3_SECRET_KEY: 'synthetic',
        S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
      }),
    );
    resetStorageClientForTesting();
    try {
      await expect(readImageObject('synthetic.png', 10, 200)).rejects.toMatchObject({
        status: 503,
      });
      if (!received) throw new Error('Synthetic SDK request never reached server');
      if (!received.destroyed) await once(received, 'close');
      expect(received.destroyed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('refuses a stream error and destroys its body without returning partial bytes', async () => {
    const body = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('private provider text');
      })(),
    );
    vi.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async () => ({ Body: body }));
    await expect(readImageObject('PRIVATE', 10, 1000)).rejects.toMatchObject({ status: 503 });
    expect(body.destroyed).toBe(true);
  });
});

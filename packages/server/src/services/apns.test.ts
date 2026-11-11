import { generateKeyPairSync, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';
import {
  apnsConfigured,
  apnsPayload,
  apnsToken,
  classifyApns,
  closeApnsConnections,
  sendApns,
  type NativePushPayload,
} from './apns.js';
import { must } from '../errors.js';

const transport = vi.hoisted(() => ({ connect: vi.fn(), config: {} as Env }));
vi.mock('node:http2', () => ({ connect: transport.connect }));
vi.mock('../env.js', () => ({ env: () => transport.config }));

class Stream extends EventEmitter {
  destroyed = false;
  body = '';
  end(body: string) {
    this.body = body;
    return this;
  }
  destroy(error?: Error) {
    this.destroyed = true;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }
}
class Connection extends EventEmitter {
  closed = false;
  destroyed = false;
  streams: Stream[] = [];
  request = vi.fn((_headers: Record<string, string>) => {
    const stream = new Stream();
    this.streams.push(stream);
    return stream;
  });
  setTimeout = vi.fn();
  close() {
    this.closed = true;
  }
  destroy() {
    this.destroyed = true;
    this.streams.forEach((stream) => stream.destroy());
  }
}

const productionKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const sandboxKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (key: typeof productionKey) =>
  key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const payload: NativePushPayload = {
  title: 'A task is due',
  body: 'Review the design',
  tag: 'due:example',
  notificationId: 'cbe8e714-097a-4dcd-ae4b-e79b49687897',
  recipientUserId: 'recipient',
  kind: 'due',
  url: '/radar/r?blip=b',
  radarId: 'r',
  blipId: 'b',
  topicId: null,
};
let connections: Connection[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
  transport.config = {
    APNS_TEAM_ID: 'TEAM000001',
    APNS_BUNDLE_ID: 'io.onmyradar.app',
    APNS_PRODUCTION_KEY_ID: 'PROD000001',
    APNS_PRODUCTION_PRIVATE_KEY: pem(productionKey),
    APNS_SANDBOX_KEY_ID: 'SAND000001',
    APNS_SANDBOX_PRIVATE_KEY: pem(sandboxKey),
  } as Env;
  connections = [];
  transport.connect.mockReset().mockImplementation(() => {
    const connection = new Connection();
    connections.push(connection);
    return connection;
  });
});
afterEach(() => {
  closeApnsConnections();
  vi.useRealTimers();
});

describe('APNs authentication and payload boundary', () => {
  it('signs independently verifiable P-256 JWTs with the environment key and a bounded cache', () => {
    const token = apnsToken('production');
    const [head, claim, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(must(head), 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'PROD000001',
    });
    expect(JSON.parse(Buffer.from(must(claim), 'base64url').toString())).toEqual({
      iss: 'TEAM000001',
      iat: Math.floor(Date.now() / 1000),
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${must(head, 'head')}.${must(claim, 'claim')}`),
        { key: productionKey.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(must(signature), 'base64url'),
      ),
    ).toBe(true);
    expect(
      verify(
        'sha256',
        Buffer.from(`${must(head, 'head')}.${must(claim, 'claim')}`),
        { key: sandboxKey.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(must(signature), 'base64url'),
      ),
    ).toBe(false);
    expect(apnsToken('production', transport.config, Date.now() + 49 * 60_000)).toBe(token);
    expect(apnsToken('production', transport.config, Date.now() + 51 * 60_000)).not.toBe(token);
    expect(
      (
        JSON.parse(
          Buffer.from(must(apnsToken('sandbox').split('.')[0]), 'base64url').toString(),
        ) as { kid: string }
      ).kid,
    ).toBe('SAND000001');
  });

  it('does not advertise an absent environment or accept a wrong signing curve', () => {
    const unavailable = { ...transport.config, APNS_SANDBOX_PRIVATE_KEY: undefined };
    expect(apnsConfigured('sandbox', unavailable)).toBe(false);
    expect(apnsConfigured('production', unavailable)).toBe(true);
    expect(() => apnsToken('sandbox', unavailable)).toThrow('unavailable');
    const wrong = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(() =>
      apnsToken('production', { ...transport.config, APNS_PRODUCTION_PRIVATE_KEY: pem(wrong) }),
    ).toThrow('P-256');
  });

  it('bounds Unicode content and rejects an oversized routing payload instead of sending it', () => {
    const encoded = apnsPayload({ ...payload, title: '🙂'.repeat(500), body: '界'.repeat(1000) });
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(4096);
    const decoded = JSON.parse(encoded) as {
      recipientUserId: string;
      blipId: string;
      aps: { alert: { body: string } };
    };
    expect(decoded.recipientUserId).toBe(payload.recipientUserId);
    expect(decoded.blipId).toBe('b');
    expect(decoded.aps.alert.body.length).toBeLessThanOrEqual(240);
    expect(() => apnsPayload({ ...payload, url: 'x'.repeat(5000) })).toThrow('4096');
  });

  it('retires only definitive token failures, preserving devices on auth, quota and provider failures', () => {
    expect(classifyApns(410, '{"reason":"Unregistered","timestamp":1234}')).toEqual({
      state: 'invalid',
      code: 'Unregistered',
      invalidBefore: 1234,
    });
    expect(classifyApns(400, '{"reason":"BadDeviceToken"}').state).toBe('invalid');
    for (const [status, reason] of [
      [403, 'InvalidProviderToken'],
      [403, 'ExpiredProviderToken'],
      [400, 'DeviceTokenNotForTopic'],
      [500, 'InternalServerError'],
    ] as const)
      expect(classifyApns(status, JSON.stringify({ reason })).state).toBe('retry');
    expect(classifyApns(503, 'not JSON').state).toBe('retry');
    expect(classifyApns(429, '{"reason":"TooManyRequests"}', '120')).toMatchObject({
      state: 'retry',
      retryAfterMs: 120_000,
    });
    expect(classifyApns(503, '{}', new Date(Date.now() + 30_000).toUTCString())).toMatchObject({
      retryAfterMs: 30_000,
    });
  });
});

describe('APNs HTTP/2 delivery lifecycle', () => {
  function start(environment: 'sandbox' | 'production' = 'production') {
    const expiry = new Date(Date.now() + 3_600_000);
    const result = sendApns({ token: 'ab'.repeat(32), environment }, payload, expiry);
    const connection = must(connections.at(-1));
    const stream = must(connection.streams.at(-1));
    return { result, connection, stream, expiry };
  }
  it('uses the correct host, immutable expiry and stable bounded identity; reuses healthy connections', async () => {
    const first = start();
    const headers = must(first.connection.request.mock.calls[0])[0];
    expect(transport.connect).toHaveBeenCalledWith('https://api.push.apple.com');
    expect(headers['apns-topic']).toBe('io.onmyradar.app');
    expect(headers['apns-expiration']).toBe(String(first.expiry.getTime() / 1000));
    expect(headers['apns-collapse-id']).toHaveLength(64);
    expect(headers['apns-id']).toBe(payload.notificationId);
    expect(headers['apns-push-type']).toBe('alert');
    first.stream.emit('response', { ':status': 200 });
    first.stream.emit('end');
    first.stream.emit('close');
    expect(await first.result).toEqual({ state: 'accepted' });
    const second = start();
    expect(transport.connect).toHaveBeenCalledTimes(1);
    second.stream.emit('response', { ':status': 200 });
    second.stream.emit('end');
    expect(await second.result).toEqual({ state: 'accepted' });
    const sandbox = start('sandbox');
    expect(transport.connect).toHaveBeenLastCalledWith('https://api.sandbox.push.apple.com');
    sandbox.stream.emit('response', { ':status': 200 });
    sandbox.stream.emit('end');
    await sandbox.result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'aborted', 'error'] as const)(
    'settles a stream %s without waiting forever for end',
    async (event) => {
      const attempt = start();
      attempt.stream.emit(event, ...(event === 'error' ? [new Error('synthetic')] : []));
      expect(await attempt.result).toMatchObject({ state: 'retry' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('times out a silent provider, releases the stream and survives a late success event', async () => {
    const attempt = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await attempt.result).toEqual({ state: 'retry', code: 'apns_timeout' });
    expect(attempt.stream.destroyed).toBe(true);
    attempt.stream.emit('response', { ':status': 200 });
    attempt.stream.emit('end');
    expect(await attempt.result).toMatchObject({ state: 'retry' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the provider response and closes pending work during shutdown', async () => {
    const oversized = start();
    oversized.stream.emit('data', Buffer.alloc(4097));
    expect(await oversized.result).toMatchObject({ state: 'retry' });
    const pending = start();
    closeApnsConnections();
    expect(await pending.result).toMatchObject({ state: 'retry' });
    expect(pending.connection.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces a GOAWAY connection and preserves Retry-After from the provider', async () => {
    const first = start();
    first.stream.emit('response', { ':status': 503, 'retry-after': '60' });
    first.stream.emit('data', Buffer.from('{"reason":"Shutdown"}'));
    first.stream.emit('end');
    expect(await first.result).toMatchObject({ state: 'retry', retryAfterMs: 60_000 });
    first.connection.emit('goaway');
    const second = start();
    expect(transport.connect).toHaveBeenCalledTimes(2);
    second.stream.emit('response', { ':status': 200 });
    second.stream.emit('end');
    expect(await second.result).toEqual({ state: 'accepted' });
  });
});

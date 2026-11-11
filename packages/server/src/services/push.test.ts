/**
 * Web Push cryptography.
 *
 * This suite is the entire reason it is defensible to hand-roll RFC 8291 rather
 * than take a dependency. Bad push crypto does not throw and does not log: the
 * push service accepts the body with a 201 and the browser silently shows
 * nothing, which is indistinguishable from "nobody has subscribed yet".
 *
 * So the test performs **the user agent's half of the protocol**. It generates a
 * subscription keypair the way a browser does, encrypts through `encryptPayload`,
 * then re-derives the content-encryption key from the other side of the ECDH and
 * decrypts. A browser does exactly this computation, so a passing round trip is
 * real evidence rather than a restatement of the implementation — the derivation
 * here is written from the RFC, not by calling back into the module.
 *
 * No database, so this runs everywhere `pnpm test` does.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import * as publicTransport from './public-request.js';
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';
import { sendWebPush, encryptPayload, generateVapidKeys, vapidHeader } from './push.js';
import { loadEnv, setEnvForTesting, type Env } from '../env.js';
import type { schema } from '../db/client.js';
import { endpointHash } from './push.js';
import { must } from '../errors.js';

const b64url = (buf: Buffer) => buf.toString('base64url');
const nul = Buffer.from([0]);
const realPublicRequest = publicTransport.publicRequest;

/** RFC 5869, written out here rather than imported — see the file header. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/** A browser's subscription: a P-256 keypair plus a 16-byte auth secret. */
function makeSubscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
    authSecret: auth,
    publicKey: ecdh.getPublicKey(),
  };
}

/**
 * The user agent's side of RFC 8291 §3.4 and RFC 8188: parse the aes128gcm
 * header, redo the two-stage derivation from the *receiver's* private key, and
 * decrypt.
 */
function decryptAsBrowser(body: Buffer, subscription: ReturnType<typeof makeSubscription>): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const serverPublicKey = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const shared = subscription.ecdh.computeSecret(serverPublicKey);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info'),
    nul,
    subscription.publicKey,
    serverPublicKey,
  ]);
  const ikm = hkdf(subscription.authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), nul]), 16);
  const nonce = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: nonce'), nul]), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const sealed = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(sealed), decipher.final()]);

  // The last byte is the record delimiter, not content.
  expect(plaintext[plaintext.length - 1]).toBe(0x02);
  return plaintext.subarray(0, plaintext.length - 1);
}

function envWith(overrides: Record<string, string>): Env {
  return loadEnv({
    DATABASE_URL: 'postgres://unused/unused',
    SESSION_SECRET: 'test-only-session-secret-not-used-anywhere-else',
    ...overrides,
  });
}

describe('web push encryption (RFC 8291 / RFC 8188)', () => {
  it('produces a body a real browser can decrypt', () => {
    const subscription = makeSubscription();
    const payload = JSON.stringify({
      title: 'Ada commented on “Ship the thing”',
      body: 'I think yes',
      tag: 'comment:abc',
      url: 'https://onmyradar.io/notifications',
    });

    const { body } = encryptPayload(Buffer.from(payload, 'utf8'), subscription.keys);
    expect(decryptAsBrowser(body, subscription).toString('utf8')).toBe(payload);
  });

  it('frames the aes128gcm header exactly as the content coding specifies', () => {
    const subscription = makeSubscription();
    const { body, salt, serverPublicKey } = encryptPayload(
      Buffer.from('hello', 'utf8'),
      subscription.keys,
    );

    // salt(16) || rs(4) || idlen(1) || keyid(idlen) || ciphertext
    expect(body.subarray(0, 16).equals(salt)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.subarray(21, 86).equals(serverPublicKey)).toBe(true);
    // An uncompressed P-256 point, which is what a push service checks for.
    expect(serverPublicKey[0]).toBe(0x04);
  });

  it('uses a fresh ephemeral key and salt for every message', () => {
    const subscription = makeSubscription();
    const first = encryptPayload(Buffer.from('same', 'utf8'), subscription.keys);
    const second = encryptPayload(Buffer.from('same', 'utf8'), subscription.keys);

    // Reusing either would let anybody holding one payload derive the key for
    // every later one sent to that device.
    expect(first.salt.equals(second.salt)).toBe(false);
    expect(first.serverPublicKey.equals(second.serverPublicKey)).toBe(false);
    expect(first.body.equals(second.body)).toBe(false);
  });

  it('refuses a payload that will not fit one record', () => {
    const subscription = makeSubscription();
    expect(() => encryptPayload(Buffer.alloc(5000), subscription.keys)).toThrow(/ceiling/i);
  });

  it('refuses a subscription key that is not an uncompressed P-256 point', () => {
    expect(() =>
      encryptPayload(Buffer.from('x'), {
        p256dh: b64url(Buffer.alloc(65)),
        auth: b64url(randomBytes(16)),
      }),
    ).toThrow(/uncompressed P-256/i);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('generates a pair in the encoding the environment expects', () => {
    for (let i = 0; i < 20; i += 1) {
      const { publicKey, privateKey } = generateVapidKeys();
      // A P-256 scalar with a leading zero byte comes back short from OpenSSL
      // roughly one time in 256, and a short `d` makes the JWK import fail — so
      // this asserts the left-padding rather than trusting one sample.
      expect(Buffer.from(privateKey, 'base64url')).toHaveLength(32);
      const point = Buffer.from(publicKey, 'base64url');
      expect(point).toHaveLength(65);
      expect(point[0]).toBe(0x04);
    }
  });

  it('signs a token that verifies against its own public key', () => {
    const keys = generateVapidKeys();
    const e = envWith({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'mailto:hello@onmyradar.io',
    });

    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc123', e);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();

    const [, jwt, k] = match as RegExpExecArray;
    expect(k).toBe(keys.publicKey);

    const [rawHeader, rawClaims, rawSignature] = (jwt as string).split('.');
    const decodedHeader: unknown = JSON.parse(Buffer.from(must(rawHeader), 'base64url').toString());
    const claims = JSON.parse(Buffer.from(must(rawClaims), 'base64url').toString()) as {
      aud: string;
      sub: string;
      exp: number;
    };

    expect(decodedHeader).toEqual({ typ: 'JWT', alg: 'ES256' });
    // The audience is the endpoint's ORIGIN. Including the path makes the token
    // endpoint-specific and every push service rejects it.
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:hello@onmyradar.io');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // RFC 8292 caps the lifetime at 24 hours.
    expect(claims.exp).toBeLessThan(Math.floor(Date.now() / 1000) + 24 * 60 * 60);

    const point = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33, 65)),
      },
      format: 'jwk',
    });

    // `ieee-p1363`, not DER. Node signs DER by default and a push service reads
    // that as a malformed token — so this assertion is the one that catches the
    // single most likely way this header silently stops working.
    const signature = Buffer.from(rawSignature as string, 'base64url');
    expect(signature).toHaveLength(64);
    expect(
      verifySignature(
        'sha256',
        Buffer.from(`${must(rawHeader, 'rawHeader')}.${must(rawClaims, 'rawClaims')}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });

  it('refuses a public key that does not belong with the private one', () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    const e = envWith({ VAPID_PUBLIC_KEY: b.publicKey, VAPID_PRIVATE_KEY: a.privateKey });

    // The likeliest configuration mistake by far — two halves from different
    // generations pasted into one secret. Node imports such a JWK without
    // complaint (measured), so `vapidKey` re-derives the public point from the
    // scalar itself. Without that, this misconfiguration surfaces only as a
    // flat 401 from a push service with no explanation in it.
    expect(() => vapidHeader('https://example.com/push/x', e)).toThrow(/does not belong/i);
  });
});

describe('one Web Push provider attempt', () => {
  let received: Array<{ headers: IncomingHttpHeaders; body: Buffer }> = [];
  let status = 201;
  const keys = generateVapidKeys();
  beforeAll(() => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgresql://test@localhost/test',
        SESSION_SECRET: 'test-only-session-secret-not-production',
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
      }),
    );
    vi.spyOn(publicTransport, 'publicRequest').mockImplementation(async (url, options = {}) => {
      expect(url.protocol).toBe('https:');
      expect(options.httpsOnly).toBe(true);
      expect(options.method).toBe('POST');
      received.push({ headers: options.headers ?? {}, body: options.body ?? Buffer.alloc(0) });
      return { status, headers: {}, body: '' };
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
    setEnvForTesting(null);
  });
  function device(subscription: ReturnType<typeof makeSubscription>) {
    const endpoint = 'https://push.example.test/destination';
    return {
      id: 'test',
      userId: 'test',
      sessionId: null,
      disabledAt: null,
      endpoint,
      endpointHash: endpointHash(endpoint),
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      label: null,
      failureCount: 0,
      generation: 1,
      registeredAt: new Date(),
      createdAt: new Date(),
      lastUsedAt: null,
    } satisfies typeof schema.pushSubscriptions.$inferSelect;
  }
  it('POSTs decryptable content with VAPID and bounded TTL', async () => {
    received = [];
    status = 201;
    const subscription = makeSubscription();
    const payload = {
      title: 'A new comment',
      body: 'Hello',
      tag: 'notification',
      url: 'https://onmyradar.io/notifications',
    };
    expect(
      await sendWebPush(device(subscription), payload, new Date(Date.now() + 3_600_000)),
    ).toEqual({ state: 'accepted' });
    expect(JSON.parse(decryptAsBrowser(must(received[0]).body, subscription).toString())).toEqual(
      payload,
    );
    expect(must(received[0]).headers['authorization']).toMatch(/^vapid t=/);
    expect(Number(must(received[0]).headers['ttl'])).toBeLessThanOrEqual(3600);
  });
  it.each([404, 410])('classifies %s as invalid without provider retries', async (code) => {
    status = code;
    expect(
      await sendWebPush(
        device(makeSubscription()),
        { title: 'x', body: '', tag: 't', url: '/' },
        new Date(Date.now() + 1000),
      ),
    ).toMatchObject({ state: 'invalid' });
  });
  it.each([302, 401, 429, 500, 503])(
    'retains a destination after provider status %s',
    async (code) => {
      status = code;
      expect(
        await sendWebPush(
          device(makeSubscription()),
          { title: 'x', body: '', tag: 't', url: '/' },
          new Date(Date.now() + 1000),
        ),
      ).toMatchObject({ state: 'retry' });
    },
  );
  it('retires a subscription whose keys cannot be encrypted to, without a request', async () => {
    received = [];
    const d = device(makeSubscription());
    d.p256dh = 'test';
    expect(
      await sendWebPush(
        d,
        { title: 'x', body: '', tag: 't', url: '/' },
        new Date(Date.now() + 1000),
      ),
    ).toEqual({ state: 'invalid', code: 'web_bad_keys' });
    expect(received).toHaveLength(0);
  });
  it('refuses a private endpoint before making a request', async () => {
    received = [];
    const d = device(makeSubscription());
    d.endpoint = 'https://127.0.0.1/push';
    vi.mocked(publicTransport.publicRequest).mockImplementationOnce(realPublicRequest);
    expect(
      await sendWebPush(
        d,
        { title: 'x', body: '', tag: 't', url: '/' },
        new Date(Date.now() + 1000),
      ),
    ).toMatchObject({ state: 'invalid', code: 'unsafe_endpoint' });
    expect(received).toHaveLength(0);
  });
});

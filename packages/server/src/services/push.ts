/**
 * Web Push — RFC 8291 (message encryption), RFC 8188 (aes128gcm content
 * coding) and RFC 8292 (VAPID), implemented against Node's own crypto.
 *
 * ## Why no library
 *
 * The obvious move is `web-push`. It is not taken for the same reason the OIDC
 * client is written against `fetch` and the unfurler is hand-rolled: this is
 * about 120 lines of well-specified cryptography with no negotiation in it, and
 * `@aws-sdk/client-s3` has already taught this repo what a deep transitive tree
 * costs at the `pnpm audit --prod --audit-level=high` gate (docs/DESIGN.md, and
 * the August 2026 `fast-xml-parser` block). A push notification is a nicety;
 * paying for it with a permanent dependency in the production tree is not a
 * trade worth making.
 *
 * The risk that buys is silent breakage — bad crypto produces a push service
 * that returns 201 and a browser that shows nothing. `push.test.ts` closes it by
 * performing the **user agent's half** of RFC 8291: it generates a subscription
 * keypair, encrypts through this module, then derives the same key from the
 * other side and decrypts. If that round trip passes, a real browser can read
 * the payload, because that is the identical computation. The VAPID JWT is
 * verified against its own public key in the same suite.
 *
 * ## What is a secret here
 *
 * The VAPID **private** key is; it lives in the `onmyradar-push` Kubernetes
 * secret and reaches the pod through `envFrom` like every other credential. The
 * VAPID public key is not — it is handed to every browser that subscribes — but
 * it is kept in the same secret anyway, because a public key that has drifted
 * out of step with its private half breaks push silently and there is no
 * diagnostic that says so. They rotate together or not at all.
 *
 * Push being absent is a supported state, exactly like storage and SSO: the
 * secret is mounted `optional: true`, `pushConfigured()` is false, and the UI
 * hides the control rather than offering one that cannot work.
 */
import type { PushOutcome } from './apns.js';
import {
  createCipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign as signWithKey,
  type KeyObject,
} from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { type PushSubscriptionInput } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { env, type Env } from '../env.js';
import { logger } from '../logger.js';
import type { Actor } from '../http.js';
import { assertHumanDecision } from './access.js';
import { publicRequest, UnsafeOutboundUrlError } from './public-request.js';

/** True when the server holds a usable VAPID pair. */
export function pushConfigured(e: Env = env()): boolean {
  return Boolean(e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY);
}

/** Handed to the browser so it can subscribe. Not a secret. */
export function vapidPublicKey(e: Env = env()): string | null {
  return pushConfigured(e) ? (e.VAPID_PUBLIC_KEY ?? null) : null;
}

/* -------------------------------------------------------------------------- */
/* Encoding helpers                                                           */
/* -------------------------------------------------------------------------- */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const unb64url = (value: string): Buffer => Buffer.from(value, 'base64url');
const nul = Buffer.from([0]);

function uint32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

/**
 * HKDF (RFC 5869), single-block expand.
 *
 * Every output this module asks for is 32 bytes or fewer, which is exactly one
 * HMAC-SHA256 block — so the counter never leaves 0x01 and the loop a general
 * implementation would need does not exist here. Asking for more than 32 bytes
 * would silently return a short buffer, so it is asserted rather than assumed.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  if (length > 32) throw new Error('hkdf: this single-block expansion caps at 32 bytes');
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const okm = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  return okm.subarray(0, length);
}

/* -------------------------------------------------------------------------- */
/* RFC 8291 — encrypting a payload for one subscription                        */
/* -------------------------------------------------------------------------- */

/**
 * The record size advertised in the aes128gcm header. One record, always: a push
 * payload is a few hundred bytes and most push services refuse more than 4096
 * anyway, so multi-record framing would be dead code.
 */
const RECORD_SIZE = 4096;
/** Header (86) + delimiter (1) + GCM tag (16) has to fit inside the record. */
const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;

export interface SubscriptionKeys {
  /** The device's P-256 public key, base64url, uncompressed (65 bytes). */
  p256dh: string;
  /** The device's 16-byte auth secret, base64url. */
  auth: string;
}

/**
 * Encrypt one payload for one subscription, producing a complete aes128gcm
 * body: `salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext`.
 *
 * The two-stage key derivation is the part that is easy to get subtly wrong and
 * impossible to notice: the *auth secret* is the salt for the first extract and
 * the random salt is the salt for the second. Swapping them yields a body a push
 * service will happily accept and no browser can read.
 */
export function encryptPayload(
  plaintext: Buffer,
  keys: SubscriptionKeys,
): { body: Buffer; salt: Buffer; serverPublicKey: Buffer } {
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new Error(`push payload is ${plaintext.length} bytes; the ceiling is ${MAX_PLAINTEXT}`);
  }

  const uaPublic = unb64url(keys.p256dh);
  const authSecret = unb64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('push subscription p256dh is not an uncompressed P-256 point');
  }

  // A fresh ephemeral keypair per message. Reusing one would let anybody who
  // ever held a payload derive the key for every later one.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const salt = randomBytes(16);

  // Stage one: mix the ECDH secret with the subscription's auth secret, binding
  // the result to both public keys so a payload cannot be replayed at a
  // different device.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info'), nul, uaPublic, serverPublicKey]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  // Stage two: the RFC 8188 content-encryption key and nonce.
  const cek = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), nul]), 16);
  const nonce = hkdf(salt, ikm, Buffer.concat([Buffer.from('Content-Encoding: nonce'), nul]), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 is the last-record delimiter. 0x01 would say "more records follow" and
  // a browser would wait for a record that never comes.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.concat([
    salt,
    uint32be(RECORD_SIZE),
    Buffer.from([serverPublicKey.length]),
    serverPublicKey,
  ]);

  return { body: Buffer.concat([header, ciphertext]), salt, serverPublicKey };
}

/* -------------------------------------------------------------------------- */
/* RFC 8292 — VAPID                                                            */
/* -------------------------------------------------------------------------- */

let cachedKey: { fingerprint: string; key: KeyObject } | null = null;

/**
 * The VAPID private key as a Node key object.
 *
 * Assembled through JWK rather than a hand-rolled SEC1 DER wrapper: the public
 * half supplies `x` and `y` and the private half supplies `d`.
 *
 * **The two halves are cross-checked here, because nothing else does it.** Node
 * imports a JWK whose `d` has no relationship to its `x` and `y` perfectly
 * happily — measured, not assumed — so a pair pasted together from two separate
 * generations produces a server that boots, hides nothing, signs every token
 * with the wrong key, and is rejected by every push service with a flat 401
 * carrying no explanation. That is the single likeliest way to misconfigure
 * this and by far the hardest to diagnose from the outside, so the public point
 * is re-derived from the scalar and compared. It costs one scalar
 * multiplication, once, and it is cached.
 */
function vapidKey(e: Env): KeyObject {
  const priv = e.VAPID_PRIVATE_KEY ?? '';
  const pub = e.VAPID_PUBLIC_KEY ?? '';
  const fingerprint = `${pub}.${priv}`;
  if (cachedKey?.fingerprint === fingerprint) return cachedKey.key;

  const point = unb64url(pub);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point (65 bytes)');
  }
  const scalar = unb64url(priv);
  if (scalar.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url 32-byte P-256 scalar');
  }

  const check = createECDH('prime256v1');
  check.setPrivateKey(scalar);
  if (!check.getPublicKey().equals(point)) {
    throw new Error(
      'VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY — they must be generated together ' +
        '(`pnpm --filter @onmyradar/server vapid`) and stored in the same secret',
    );
  }

  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
      d: priv,
    },
    format: 'jwk',
  });
  cachedKey = { fingerprint, key };
  return key;
}

/** How long a VAPID token is good for. The spec caps this at 24 hours. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

/**
 * The `Authorization: vapid t=…, k=…` header for one push endpoint.
 *
 * `aud` is the endpoint's **origin**, not the endpoint — including the path
 * would make the token endpoint-specific and every push service rejects it.
 *
 * ES256 signatures must be the raw `r || s` pair JOSE specifies. Node emits DER
 * by default, which a push service reads as a malformed token, so
 * `dsaEncoding: 'ieee-p1363'` is load-bearing rather than stylistic.
 */
export function vapidHeader(endpoint: string, e: Env = env()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + VAPID_TTL_SECONDS,
        sub: e.VAPID_SUBJECT,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = signWithKey('sha256', Buffer.from(signingInput), {
    key: vapidKey(e),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${e.VAPID_PUBLIC_KEY ?? ''}`;
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A push endpoint can be longer than the 2704-byte btree index limit, so
 * uniqueness is enforced on this digest instead of the value. It is not a
 * security measure; it is an index that fits.
 */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

/**
 * Register (or refresh) the calling browser's subscription.
 *
 * Upsert on the endpoint hash rather than insert: a browser hands back the same
 * endpoint on every page load, and re-registering must update the row rather
 * than accumulate one per visit. It also re-points the row at the *current*
 * account, which is what should happen when two people share a machine — the
 * endpoint belongs to the browser, and only one account can hold it.
 */
export async function subscribePush(
  actor: Actor,
  input: PushSubscriptionInput,
): Promise<{ id: string }> {
  const { registerBrowserPush } = await import('./push-devices.js');
  return registerBrowserPush(actor, input);
}

/**
 * Drop a subscription.
 *
 * Scoped by user id as well as endpoint, so knowing somebody else's endpoint is
 * not a way to switch their notifications off.
 */
export async function unsubscribePush(actor: Actor, endpoint: string): Promise<void> {
  assertHumanDecision(
    actor,
    'A push subscription belongs to one browser, and removing one would stop the user ' +
      'being told things happened. That is not something an agent may do.',
  );
  const db = getDb();
  const hash = endpointHash(endpoint);
  const rows = await db
    .select({ id: schema.pushSubscriptions.id, userId: schema.pushSubscriptions.userId })
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpointHash, hash))
    .limit(1);
  const found = rows[0];
  if (!found || found.userId !== actor.user.id) return;
  await db
    .update(schema.pushSubscriptions)
    .set({ disabledAt: new Date(), generation: sql`${schema.pushSubscriptions.generation}+1` })
    .where(
      and(
        eq(schema.pushSubscriptions.id, found.id),
        eq(schema.pushSubscriptions.userId, actor.user.id),
      ),
    );
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/* -------------------------------------------------------------------------- */
/* Key generation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A fresh VAPID pair, in exactly the encoding the environment expects.
 *
 * Exists as a command (`pnpm --filter @onmyradar/server vapid`) so that
 * docs/DEPLOY.md can be copy-pasted rather than describing an encoding somebody
 * has to get right by hand. Generating the pair with the wrong encoding is the
 * failure this is here to prevent: it produces a server that boots, hides
 * nothing, and silently never delivers.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // A P-256 scalar with a leading zero byte comes back 31 bytes long, roughly
  // one time in 256. Left-padding is not cosmetic: `vapidKey` builds a JWK, and
  // a short `d` is rejected outright — so without this, one key in every 256
  // would be generated, written into a secret, and fail only at the first push.
  const priv = Buffer.alloc(32);
  const raw = ecdh.getPrivateKey();
  raw.copy(priv, 32 - raw.length);
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(priv),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const keys = generateVapidKeys();
  logger.info(
    { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey },
    'new VAPID pair — put both in the onmyradar-push secret, never in git',
  );
}

/** One bounded device attempt. The durable receipt owns retries and invalidation. */
export async function sendWebPush(
  subscription: typeof schema.pushSubscriptions.$inferSelect,
  payload: PushPayload,
  expiresAt: Date,
): Promise<PushOutcome> {
  const plaintext = Buffer.from(JSON.stringify(payload));
  let body: Buffer;
  try {
    ({ body } = encryptPayload(plaintext, {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    }));
  } catch {
    // An oversized payload is this server's to fix. Anything else is the
    // subscription's keys — not a P-256 point, or not on the curve — and no
    // retry repairs those: this used to be reported as `web_network` and
    // retried eight times for every notification, forever.
    return plaintext.length > MAX_PLAINTEXT
      ? { state: 'retry', code: 'web_payload_too_large' }
      : { state: 'invalid', code: 'web_bad_keys' };
  }
  try {
    const response = await publicRequest(new URL(subscription.endpoint), {
      httpsOnly: true,
      method: 'POST',
      headers: {
        authorization: vapidHeader(subscription.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))),
        urgency: 'normal',
      },
      body,
      timeoutMs: 10_000,
    });
    if (response.status >= 200 && response.status < 300) return { state: 'accepted' };
    if (response.status === 404 || response.status === 410)
      return { state: 'invalid', code: 'web_unregistered' };
    const retryHeader = response.headers['retry-after']?.toString();
    const delay = retryHeader
      ? Number(retryHeader) * 1000 || Date.parse(retryHeader) - Date.now()
      : 0;
    return {
      state: 'retry',
      code: `web_${response.status}`,
      ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: Math.min(delay, 3_600_000) } : {}),
    };
  } catch (error) {
    return error instanceof UnsafeOutboundUrlError
      ? { state: 'invalid', code: 'unsafe_endpoint' }
      : { state: 'retry', code: 'web_network' };
  }
}

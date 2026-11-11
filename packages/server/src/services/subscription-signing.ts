import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../env.js';

// Domain separation keeps this encryption key distinct from session signing.
function encryptionKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', env().SESSION_SECRET, 'onmyradar', 'outbound-webhooks-v1', 32),
  );
}
export function encryptSubscriptionSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64url')).join('.');
}
export function decryptSubscriptionSecret(value: string): string {
  const [iv, tag, encrypted] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted subscription secret');
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
export function signSubscription(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}
/** Reference receiver verifier. Verify the raw body before parsing JSON. */
export function verifySubscription(
  secret: string,
  body: string,
  signature: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
  const [, stamp, digest] = match ?? [];
  if (!secret || !stamp || !digest || Math.abs(now - Number(stamp)) > 300) return false;
  const expected = signSubscription(secret, body, Number(stamp)).split('v1=')[1];
  if (expected?.length !== digest.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest, 'hex'));
}

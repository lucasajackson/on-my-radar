export async function signMetadata(secret, timestamp, nonce, recipient, rawSize) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}\n${nonce}\n${recipient}\n${rawSize}`),
  );
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

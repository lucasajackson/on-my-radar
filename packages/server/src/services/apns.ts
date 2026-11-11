import { createHash, createPrivateKey, sign } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import { env, type Env } from '../env.js';

export type ApnsEnvironment = 'sandbox' | 'production';
export interface NativePushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  notificationId: string;
  recipientUserId: string;
  kind: string;
  radarId: string | null;
  blipId: string | null;
  topicId: string | null;
}
export type PushOutcome =
  | { state: 'accepted' }
  | { state: 'invalid'; code: string; invalidBefore?: number }
  | { state: 'retry'; code: string; retryAfterMs?: number };

function credentials(environment: ApnsEnvironment, config: Env) {
  return environment === 'production'
    ? { id: config.APNS_PRODUCTION_KEY_ID, key: config.APNS_PRODUCTION_PRIVATE_KEY }
    : { id: config.APNS_SANDBOX_KEY_ID, key: config.APNS_SANDBOX_PRIVATE_KEY };
}
export function apnsConfigured(environment: ApnsEnvironment, config = env()): boolean {
  const pair = credentials(environment, config);
  return Boolean(config.APNS_TEAM_ID && pair.id && pair.key);
}
const tokens = new Map<string, { value: string; created: number }>();
const connections = new Map<string, ClientHttp2Session>();

export function apnsToken(environment: ApnsEnvironment, config = env(), now = Date.now()): string {
  const pair = credentials(environment, config);
  if (!pair.key || !pair.id || !config.APNS_TEAM_ID) throw new Error('APNs unavailable');
  const key = createHash('sha256')
    .update(`${pair.id}:${pair.key}:${config.APNS_TEAM_ID}`)
    .digest('hex');
  const cached = tokens.get(key);
  if (cached && now - cached.created < 50 * 60_000 && now >= cached.created) return cached.value;
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: pair.id })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({ iss: config.APNS_TEAM_ID, iat: Math.floor(now / 1000) }),
  ).toString('base64url');
  const signingKey = createPrivateKey(pair.key.replaceAll('\\n', '\n'));
  if (
    signingKey.asymmetricKeyType !== 'ec' ||
    signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new Error('APNs requires a P-256 signing key');
  const signature = sign('sha256', Buffer.from(`${head}.${claim}`), {
    key: signingKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const value = `${head}.${claim}.${signature}`;
  if (tokens.size > 8) {
    const oldest = tokens.keys().next();
    if (!oldest.done) tokens.delete(oldest.value);
  }
  tokens.set(key, { value, created: now });
  return value;
}

export function apnsPayload(payload: NativePushPayload): string {
  const result = JSON.stringify({
    aps: {
      alert: { title: payload.title.slice(0, 180), body: payload.body.slice(0, 240) },
      sound: 'default',
      'thread-id': payload.radarId ?? 'activity',
    },
    notificationId: payload.notificationId,
    recipientUserId: payload.recipientUserId,
    kind: payload.kind,
    url: payload.url,
    radarId: payload.radarId,
    blipId: payload.blipId,
    topicId: payload.topicId,
  });
  if (Buffer.byteLength(result) > 4096) throw new Error('APNs payload exceeds 4096 bytes');
  return result;
}

export function classifyApns(status: number, body: string, retryAfter?: string): PushOutcome {
  let data: { reason?: string; timestamp?: number } = {};
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    /* Invalid provider body is retryable. */
  }
  if (status === 200) return { state: 'accepted' };
  if (status === 410 && data.reason === 'Unregistered')
    return {
      state: 'invalid',
      code: 'Unregistered',
      ...(data.timestamp === undefined ? {} : { invalidBefore: data.timestamp }),
    };
  if (status === 400 && data.reason === 'BadDeviceToken')
    return { state: 'invalid', code: 'BadDeviceToken' };
  const reason = data.reason;
  const code =
    reason !== undefined &&
    [
      'ExpiredProviderToken',
      'InvalidProviderToken',
      'DeviceTokenNotForTopic',
      'TooManyRequests',
      'ServiceUnavailable',
      'Shutdown',
    ].includes(reason)
      ? reason
      : `apns_${status}`;
  const delay = retryAfter ? Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now() : 0;
  return {
    state: 'retry',
    code,
    ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: Math.min(delay, 3_600_000) } : {}),
  };
}

export async function sendApns(
  device: { token: string; environment: ApnsEnvironment },
  payload: NativePushPayload,
  expiresAt: Date,
): Promise<PushOutcome> {
  const config = env();
  const token = apnsToken(device.environment, config);
  const host =
    device.environment === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
  // apnsToken above has already refused a missing team or key id.
  const identity = `${host}:${config.APNS_TEAM_ID ?? ''}:${credentials(device.environment, config).id ?? ''}`;
  let connection = connections.get(identity);
  if (!connection || connection.closed || connection.destroyed) {
    connection = connect(host);
    connection.on('error', () => connection?.destroy());
    connection.on('goaway', () => connection?.close());
    connection.setTimeout(60_000, () => connection?.close());
    connections.set(identity, connection);
  }
  const body = apnsPayload(payload);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: PushOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const stream = connection.request({
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      authorization: `bearer ${token}`,
      'apns-topic': config.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-id': payload.notificationId,
      'apns-collapse-id': createHash('sha256').update(payload.notificationId).digest('hex'),
      'apns-expiration': String(Math.floor(expiresAt.getTime() / 1000)),
    });
    let status = 0;
    let response = '';
    let retryAfter: string | undefined;
    const timer = setTimeout(() => {
      finish({ state: 'retry', code: 'apns_timeout' });
      stream.destroy();
    }, 10_000);
    stream.on('response', (headers) => {
      status = Number(headers[':status']);
      retryAfter = headers['retry-after']?.toString();
    });
    stream.on('data', (chunk: Buffer) => {
      response += chunk.toString();
      if (response.length > 4096) stream.destroy(new Error('APNs response too large'));
    });
    stream.on('error', () => finish({ state: 'retry', code: 'apns_network' }));
    stream.on('close', () => finish({ state: 'retry', code: 'apns_closed' }));
    stream.on('aborted', () => finish({ state: 'retry', code: 'apns_aborted' }));
    stream.on('end', () => finish(classifyApns(status, response, retryAfter)));
    stream.end(body);
  });
}

export function closeApnsConnections(): void {
  for (const connection of connections.values()) connection.destroy();
  connections.clear();
  tokens.clear();
}

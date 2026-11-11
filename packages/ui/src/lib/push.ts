/**
 * Browser push, from the page's side.
 *
 * The whole flow is four steps that each fail differently, and conflating them
 * is what makes push settings feel broken: register a service worker, ask the
 * *user* for permission, ask the *browser* for a subscription, then hand that
 * subscription to the server. This module keeps them apart so the settings
 * screen can say which one did not happen.
 *
 * The one irreversible step is permission. A browser only ever asks once; after
 * a refusal, `Notification.requestPermission()` resolves straight to 'denied'
 * without showing anything, and nothing the page does can re-open that prompt —
 * only the person can, through browser settings. So the UI has to distinguish
 * "not asked yet" from "said no", and never present a button that silently does
 * nothing.
 */

/** Everything the settings screen needs to decide what to render. */
export interface PushState {
  /** False on browsers with no Push API at all, and on any insecure origin. */
  supported: boolean;
  permission: NotificationPermission;
  /** The subscription this browser currently holds, if any. */
  endpoint: string | null;
}

/**
 * Push needs a secure context. `localhost` counts as one, which is why the dev
 * loop works over plain http without a certificate.
 */
function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants raw bytes.
 *
 * `atob` needs standard base64, so the URL-safe alphabet is translated back and
 * the padding restored. Getting this wrong throws deep inside `subscribe()`
 * with a message that does not mention encoding.
 */
function decodeVapidKey(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  // An ArrayBuffer rather than a Uint8Array view: `applicationServerKey` is
  // typed as BufferSource over a plain ArrayBuffer, and a view whose backing
  // buffer could be a SharedArrayBuffer does not satisfy it.
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Register the worker and report what this browser is currently holding.
 *
 * Safe to call on every load of the settings screen: registration is idempotent,
 * and reading the existing subscription is how the screen knows whether to offer
 * "turn on" or "turn off".
 */
export async function readPushState(): Promise<PushState> {
  if (!pushSupported()) {
    return { supported: false, permission: 'denied', endpoint: null };
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    const existing = await registration.pushManager.getSubscription();
    return {
      supported: true,
      permission: Notification.permission,
      endpoint: existing?.endpoint ?? null,
    };
  } catch {
    // A worker that will not register (a browser with site data blocked, a
    // private window on some platforms) is indistinguishable from no support as
    // far as anything the person can do about it.
    return { supported: false, permission: Notification.permission, endpoint: null };
  }
}

class PushDenied extends Error {}

/**
 * Ask for permission and subscribe.
 *
 * Returns the subscription as the plain JSON the server's schema expects —
 * `{ endpoint, keys: { p256dh, auth } }` — rather than the live object, which
 * does not survive `JSON.stringify` usefully on every browser.
 *
 * Throws `PushDenied` when the person has said no, carrying a sentence that
 * says what to do, so the caller's ordinary error toast is already the plain
 * answer rather than a generic failure for something no retry will fix.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  // Wait for it to be in control; `subscribe()` on a still-installing
  // registration rejects on some browsers with an unhelpful InvalidStateError.
  await navigator.serviceWorker.ready;

  const permission =
    Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushDenied(
      permission === 'denied'
        ? 'This browser is blocking notifications. Allow them for this site in your browser settings, then try again.'
        : 'Notifications were not allowed.',
    );
  }

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Required by every browser that implements the spec, and the reason a
      // VAPID key rotation invalidates every existing subscription: the key is
      // baked into the one the browser hands back here.
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(vapidPublicKey),
    }));

  const json = subscription.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error('This browser returned an incomplete push subscription.');
  }
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** Drop this browser's subscription locally. The server row is removed separately. */
export async function unsubscribeFromPush(): Promise<string | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  return endpoint;
}

/** A name for this device in the settings list, guessed from the user agent. */
export function describeThisBrowser(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'This browser';
  const platform = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return platform ? `${browser} on ${platform}` : browser;
}

/** Reads existing consent only: never asks permission or creates a subscription. */
export async function existingPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const existing = await registration?.pushManager.getSubscription();
  const json = existing?.toJSON();
  const p256dh = json?.keys?.['p256dh'];
  const auth = json?.keys?.['auth'];
  return json?.endpoint && p256dh && auth
    ? { endpoint: json.endpoint, keys: { p256dh, auth } }
    : null;
}

/* Root-scoped push and private-download worker. It does not cache responses. */

// Keep the worker alive through the account check and notification display.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Undecryptable or malformed. Still say *something*: the alternative is a
    // notification the platform has already committed to, silently missing.
    payload = {};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};

  event.waitUntil(displayNotification(payload));
});

/** An accepted push can arrive after logout or an account switch. */
async function matchesCurrentAccount(recipientUserId) {
  if (typeof recipientUserId !== 'string' || !recipientUserId) return false;
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, 2500);
    });
    const session = fetch(new URL('/api/auth/session', self.location.origin).href, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const data = await response.json();
        return data?.user?.id === recipientUserId && data.user.state === 'active';
      })
      .catch(() => false);
    return await Promise.race([session, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function displayNotification(payload) {
  const matches = await matchesCurrentAccount(payload.recipientUserId);
  const title =
    matches && typeof payload.title === 'string' && payload.title ? payload.title : 'On My Radar';
  await self.registration.showNotification(title, {
    body: matches && typeof payload.body === 'string' ? payload.body : 'You have new activity.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: matches && typeof payload.tag === 'string' && payload.tag ? payload.tag : 'onmyradar',
    renotify: false,
    data: {
      url: notificationUrl(matches ? payload.url : '/notifications').href,
      recipientUserId: matches ? payload.recipientUserId : null,
    },
  });
}

/** Notification links always stay within this application. */
function notificationUrl(value) {
  try {
    const target = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    if (target.origin === self.location.origin) return target;
  } catch {
    // A malformed stored notification still opens the application.
  }
  return new URL('/', self.location.origin);
}

// Reuse an application tab, but recheck the account before following a private target.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    matchesCurrentAccount(event.notification.data?.recipientUserId).then(async (matches) => {
      const target = notificationUrl(matches ? event.notification.data?.url : '/notifications');
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        // Same origin, so navigate the tab that is already here.
        if (new URL(client.url).origin === target.origin && 'focus' in client) {
          return client.navigate
            ? client.navigate(target.href).then((c) => c && c.focus())
            : client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
    }),
  );
});

// Activate updates without waiting for every application tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/*
 * Account exports are assembled by the signed-in page, never cached.
 *
 * The download half runs ONLY in the registration scoped to
 * `/account-export-download/` (account-export.ts registers it). The root
 * registration must keep no fetch listener at all: with one, the browser has to
 * wake this worker for every request the app and the marketing site make, and a
 * slow worker start then stalls every API call behind it. That happened
 * (2026-10-06: a 100 ms /api/radars took 19.5 s waiting on the worker, and
 * dashboard widgets sat on "Loading widget") — docs/ARCHITECTURE.md records the
 * root worker as push only for exactly this reason.
 */
const DOWNLOAD_SCOPE = new URL('/account-export-download/', self.location.origin).href;
const accountDownloads = new Map();
function onDownloadMessage(event) {
  if (
    event.data?.type !== 'account-export-download' ||
    !event.ports[0] ||
    !event.source ||
    event.source.type !== 'window' ||
    typeof event.source.id !== 'string' ||
    !event.source.id ||
    new URL(event.source.url).origin !== self.location.origin ||
    typeof event.data.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(event.data.nonce)
  )
    return;
  const port = event.ports[0];
  const nonce = event.data.nonce;
  if (accountDownloads.has(nonce)) return;
  const timer = setTimeout(() => {
    accountDownloads.delete(nonce);
    port.postMessage({ type: 'cancel' });
    port.close();
  }, 120000);
  accountDownloads.set(nonce, { port, timer, clientId: event.source.id });
  port.postMessage({ type: 'ready' });
}
function onDownloadFetch(event) {
  const url = new URL(event.request.url);
  const match = /^\/account-export-download\/([a-f0-9]{32})$/.exec(url.pathname);
  if (url.origin !== self.location.origin || !match) return;
  const download = accountDownloads.get(match[1]);
  if (
    event.request.method !== 'GET' ||
    !download ||
    (event.clientId && event.clientId !== download.clientId)
  ) {
    event.respondWith(
      new Response('Download expired. Start again from Settings.', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );
    return;
  }
  accountDownloads.delete(match[1]);
  clearTimeout(download.timer);
  const port = download.port;
  let waiting;
  let requested = false;
  let releasePull;
  let settled = false;
  function finishPull() {
    clearTimeout(waiting);
    requested = false;
    releasePull?.();
    releasePull = undefined;
  }
  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = (message) => {
        if (settled) return;
        if (!requested) {
          settled = true;
          controller.error(new Error('Unexpected account export data.'));
          port.postMessage({ type: 'cancel' });
          port.close();
          return;
        }
        if (
          message.data?.type === 'chunk' &&
          message.data.bytes instanceof Uint8Array &&
          message.data.bytes.byteLength <= 64 * 1024 * 1024
        )
          controller.enqueue(message.data.bytes);
        else if (message.data?.type === 'done') {
          settled = true;
          controller.close();
          port.postMessage({ type: 'complete' });
          port.close();
        } else {
          settled = true;
          controller.error(new Error('Account export interrupted.'));
          port.postMessage({ type: 'cancel' });
          port.close();
        }
        finishPull();
      };
    },
    pull(controller) {
      if (settled) return;
      requested = true;
      const pending = new Promise((resolve) => {
        releasePull = resolve;
      });
      waiting = setTimeout(() => {
        settled = true;
        controller.error(new Error('Account export timed out.'));
        port.postMessage({ type: 'cancel' });
        port.close();
        finishPull();
      }, 120000);
      port.postMessage({ type: 'pull' });
      return pending;
    },
    cancel() {
      settled = true;
      port.postMessage({ type: 'cancel' });
      port.close();
      finishPull();
    },
  });
  event.respondWith(
    new Response(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="On-My-Radar-account.zip"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }),
  );
}
if (self.registration?.scope === DOWNLOAD_SCOPE) {
  self.addEventListener('message', onDownloadMessage);
  self.addEventListener('fetch', onDownloadFetch);
}

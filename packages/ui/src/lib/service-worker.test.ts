import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { must } from './must';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const payload = {
  title: 'New comment',
  body: 'A private reply',
  tag: 'thread',
  url: '/radar/example',
  recipientUserId: 'alice',
};

/** What the worker calls fetch with, as far as these tests look. */
type SessionFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>;

function worker(
  fetchSession = vi.fn<SessionFetch>().mockResolvedValue({
    ok: true,
    json: async () => ({ user: { id: 'alice', state: 'active' } }),
  }),
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi
    .fn<(title: string, options: NotificationOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  runInNewContext(source, {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchSession,
    self: {
      location: { origin: 'https://onmyradar.test' },
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        listeners.set(name, handler),
      registration: { showNotification },
      clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow },
    },
  });
  async function dispatch(name: string, fields: Record<string, unknown>) {
    let pending: Promise<unknown> | undefined;
    must(listeners.get(name))({
      ...fields,
      waitUntil: (work: Promise<unknown>) => {
        pending = work;
      },
    });
    await pending;
  }
  return { dispatch, showNotification, openWindow, fetchSession };
}

describe('push service worker', () => {
  it.each([null, [], 'text', 7, false])(
    'shows generic activity for non-object payload %j',
    async (value) => {
      const w = worker();
      await w.dispatch('push', { data: { json: () => value } });
      expect(w.showNotification).toHaveBeenCalledWith(
        'On My Radar',
        expect.objectContaining({ body: 'You have new activity.', tag: 'onmyradar' }),
      );
      expect(w.fetchSession).not.toHaveBeenCalled();
    },
  );

  it('preserves a preview only after a fresh matching session check', async () => {
    const w = worker();
    await w.dispatch('push', { data: { json: () => payload } });
    expect(w.fetchSession).toHaveBeenCalledWith(
      'https://onmyradar.test/api/auth/session',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }),
    );
    expect(w.showNotification).toHaveBeenCalledWith(
      'New comment',
      expect.objectContaining({
        body: 'A private reply',
        data: { url: 'https://onmyradar.test/radar/example', recipientUserId: 'alice' },
      }),
    );
  });

  it.each([
    null,
    { id: 'bob', state: 'active' },
    { id: 'alice', state: 'pending' },
    { id: 'alice', state: 'suspended' },
  ])('does not disclose a queued preview to a different session %j', async (user) => {
    const w = worker(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user }) }));
    await w.dispatch('push', { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenCalledWith(
      'On My Radar',
      expect.objectContaining({
        body: 'You have new activity.',
        data: { url: 'https://onmyradar.test/notifications', recipientUserId: null },
      }),
    );
  });

  it('fails closed offline and for legacy recipient-free payloads', async () => {
    const w = worker(vi.fn().mockRejectedValue(new Error('offline')));
    await w.dispatch('push', { data: { json: () => payload } });
    await w.dispatch('push', {
      data: { json: () => ({ ...payload, recipientUserId: undefined }) },
    });
    expect(w.showNotification.mock.calls.map(([title]) => title)).toEqual([
      'On My Radar',
      'On My Radar',
    ]);
    expect(w.fetchSession).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled session request and still shows a generic notification', async () => {
    vi.useFakeTimers();
    try {
      const w = worker(vi.fn<SessionFetch>().mockReturnValue(new Promise(() => {})));
      const pending = w.dispatch('push', { data: { json: () => payload } });
      await vi.advanceTimersByTimeAsync(2500);
      await pending;
      expect(w.showNotification).toHaveBeenCalledWith(
        'On My Radar',
        expect.objectContaining({ body: 'You have new activity.' }),
      );
      expect(must(must(w.fetchSession.mock.calls[0])[1]).signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks account identity when a previously displayed notification is clicked', async () => {
    const fetchSession = vi
      .fn<SessionFetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { id: 'alice', state: 'active' } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user: { id: 'bob' } }) });
    const w = worker(fetchSession);
    await w.dispatch('push', { data: { json: () => payload } });
    const data: unknown = must(w.showNotification.mock.calls[0])[1].data;
    await w.dispatch('notificationclick', { notification: { data, close: vi.fn() } });
    expect(w.openWindow).toHaveBeenCalledWith('https://onmyradar.test/notifications');
  });

  it.each(['https://outside.test/private', 'https://[', 'javascript:alert(1)'])(
    'keeps invalid target %s within the app',
    async (url) => {
      const w = worker();
      await w.dispatch('notificationclick', {
        notification: { data: { url, recipientUserId: 'alice' }, close: vi.fn() },
      });
      expect(w.openWindow).toHaveBeenCalledWith('https://onmyradar.test/');
    },
  );
});

/*
  The root worker must never hold a fetch listener. With one, the browser wakes
  the worker for every request the app makes — every API call, asset and
  navigation, and the marketing site's pages that share the scope — so a slow
  worker start stalls all of them. On 2026-10-06 that turned a 100 ms
  /api/radars into 19.5 s and left dashboard widgets on "Loading widget".
*/
describe('service worker fetch interception', () => {
  const origin = 'https://onmyradar.test';
  function listenersFor(scope: string): string[] {
    const names: string[] = [];
    runInNewContext(source, {
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      self: {
        location: { origin },
        registration: { scope },
        addEventListener: (name: string) => names.push(name),
      },
    });
    return names;
  }

  it('registers no fetch or message listener at the root scope', () => {
    const names = listenersFor(`${origin}/`);
    expect(names).toContain('push');
    expect(names).not.toContain('fetch');
    expect(names).not.toContain('message');
  });

  it('intercepts only in the registration scoped to the account download path', () => {
    expect(listenersFor(`${origin}/account-export-download/`)).toEqual(
      expect.arrayContaining(['fetch', 'message']),
    );
    expect(listenersFor(`${origin}/account-export-download/x/`)).not.toContain('fetch');
  });

  it('is registered for downloads with that narrow scope, never the root one', () => {
    const page = readFileSync(new URL('./account-export.ts', import.meta.url), 'utf8');
    expect(page).toMatch(/register\('\/sw\.js', \{\s*scope: ACCOUNT_DOWNLOAD_SCOPE,?\s*\}\)/);
    expect(page).toContain("ACCOUNT_DOWNLOAD_SCOPE = '/account-export-download/'");
    expect(page).not.toMatch(/serviceWorker\.ready/);
  });
});

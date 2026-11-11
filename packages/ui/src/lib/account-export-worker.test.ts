import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://onmyradar.test';
const nonce = 'a'.repeat(32);
class Port {
  messages: Array<{ type: string }> = [];
  closed = false;
  onmessage?: (event: { data: unknown }) => void;
  postMessage(message: { type: string }) {
    this.messages.push(message);
  }
  close() {
    this.closed = true;
  }
  send(data: unknown) {
    this.onmessage?.({ data });
  }
}
function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const cache = vi.fn();
  runInNewContext(source, {
    URL,
    AbortController,
    Response,
    ReadableStream,
    Uint8Array,
    setTimeout,
    clearTimeout,
    caches: { open: cache },
    self: {
      location: { origin },
      // The download half exists only in the narrowly scoped registration.
      registration: { scope: `${origin}/account-export-download/` },
      addEventListener: (name: string, callback: (event: unknown) => void) =>
        handlers.set(name, callback),
    },
  });
  function prepare(port = new Port(), patch: Record<string, unknown> = {}) {
    handlers.get('message')?.({
      data: { type: 'account-export-download', nonce },
      source: { id: 'owner', type: 'window', url: `${origin}/settings` },
      ports: [port],
      ...patch,
    });
    return port;
  }
  function download(
    clientId = 'owner',
    method = 'GET',
    path = `/account-export-download/${nonce}`,
  ) {
    let response: Response | undefined;
    handlers.get('fetch')?.({
      request: new Request(origin + path, { method }),
      clientId,
      respondWith: (value: Response) => {
        response = value;
      },
    });
    return response;
  }
  return { prepare, download, cache };
}
afterEach(() => vi.useRealTimers());

describe('account export worker protocol', () => {
  it('accepts only a same-origin window and a valid private capability', () => {
    const w = worker();
    for (const source of [
      null,
      { id: 'x', type: 'worker', url: origin },
      { id: 'x', type: 'window', url: 'https://other.test/' },
    ]) {
      const port = w.prepare(new Port(), { source });
      expect(port.messages).toEqual([]);
    }
    const invalid = w.prepare(new Port(), {
      data: { type: 'account-export-download', nonce: '../secret' },
    });
    expect(invalid.messages).toEqual([]);
    expect(w.download()?.status).toBe(404);
    expect(w.download('owner', 'GET', '/api/account/export')).toBeUndefined();
  });
  it('is one-use, source-bound when the browser supplies clientId, and never cached', async () => {
    const w = worker();
    const port = w.prepare();
    expect(w.prepare().messages).toEqual([]);
    expect(w.download('different-window')?.status).toBe(404);
    const response = w.download();
    expect(response?.headers.get('cache-control')).toBe('private, no-store');
    expect(w.download()?.status).toBe(404);
    expect(worker().download()?.status).toBe(404); // worker restart discards capability
    await response?.body?.cancel();
    expect(port.messages.at(-1)?.type).toBe('cancel');
    expect(port.closed).toBe(true);
    expect(w.cache).not.toHaveBeenCalled();
  });
  it('requests one bounded chunk at a time and completes only after the producer ends', async () => {
    const w = worker();
    const port = w.prepare();
    const reader = w.download()?.body?.getReader();
    await Promise.resolve();
    expect(port.messages.map((m) => m.type)).toEqual(['ready', 'pull']);
    const pending = reader?.read();
    port.send({ type: 'chunk', bytes: new Uint8Array([1, 2]) });
    expect((await pending)?.value).toEqual(new Uint8Array([1, 2]));
    await Promise.resolve();
    await Promise.resolve();
    expect(port.messages.filter((m) => m.type === 'pull').length).toBe(2);
    port.send({ type: 'done' });
    expect((await reader?.read())?.done).toBe(true);
    expect(port.messages.at(-1)?.type).toBe('complete');
    expect(port.closed).toBe(true);
  });
  it('fails incomplete downloads on producer failure or malformed data without a completion acknowledgment', async () => {
    for (const message of [{ type: 'error' }, { type: 'chunk', bytes: 'not bytes' }]) {
      const w = worker();
      const port = w.prepare();
      const reader = w.download()?.body?.getReader();
      await Promise.resolve();
      port.send(message);
      await expect(reader?.read()).rejects.toThrow('interrupted');
      expect(port.messages.some((m) => m.type === 'complete')).toBe(false);
    }
  });
  it('expires unused capabilities and aborts stalled streams', async () => {
    vi.useFakeTimers();
    const w = worker();
    const unused = w.prepare();
    await vi.advanceTimersByTimeAsync(120000);
    expect(w.download()?.status).toBe(404);
    expect(unused.closed).toBe(true);
    const active = w.prepare();
    const reader = w.download()?.body?.getReader();
    const read = reader?.read();
    const rejected = expect(read).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120000);
    await rejected;
    expect(active.messages.at(-1)?.type).toBe('cancel');
    expect(active.messages.some((m) => m.type === 'complete')).toBe(false);
  });
});

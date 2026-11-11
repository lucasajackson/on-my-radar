import { describe, expect, it, vi } from 'vitest';
import { accountExportBody } from './account-export.js';

function pendingSource() {
  const events: string[] = [];
  let resume: () => void = () => {
    throw new Error('Missing export continuation');
  };
  let entered: () => void = () => {
    throw new Error('Missing export entry signal');
  };
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const records = (async function* () {
    try {
      yield 'first\n';
      entered();
      await pending;
      yield 'must-not-be-delivered-after-cancellation\n';
    } finally {
      events.push('iterator-finished');
    }
  })();
  const close = vi.fn(async () => {
    events.push('client-released');
  });
  return { source: { records, close }, resume, started, events };
}

describe('account export response cancellation', () => {
  it('finishes an in-flight iterator before releasing its client on request abort', async () => {
    const fixture = pendingSource();
    const abort = new AbortController();
    const reader = accountExportBody(fixture.source, abort.signal).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
    const pendingRead = reader.read().catch((error: unknown) => error);
    await fixture.started;
    abort.abort();
    expect(fixture.source.close).not.toHaveBeenCalled();
    fixture.resume();
    expect(await pendingRead).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(fixture.source.close).toHaveBeenCalledTimes(1));
    expect(fixture.events).toEqual(['iterator-finished', 'client-released']);
  });
  it('shares cleanup for body cancellation and a concurrent request abort', async () => {
    const fixture = pendingSource();
    const abort = new AbortController();
    const reader = accountExportBody(fixture.source, abort.signal).getReader();
    await reader.read();
    const pendingRead = reader.read();
    await fixture.started;
    const cancel = reader.cancel();
    abort.abort();
    expect(fixture.source.close).not.toHaveBeenCalled();
    fixture.resume();
    await cancel;
    expect(await pendingRead).toMatchObject({ done: true });
    expect(fixture.source.close).toHaveBeenCalledTimes(1);
    expect(fixture.events).toEqual(['iterator-finished', 'client-released']);
  });
  it('closes a completed source once and removes its request-abort listener', async () => {
    const abort = new AbortController();
    const close = vi.fn(async () => undefined);
    const records = (async function* () {
      yield 'one\n';
    })();
    const reader = accountExportBody({ records, close }, abort.signal).getReader();
    await reader.read();
    expect(await reader.read()).toMatchObject({ done: true });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

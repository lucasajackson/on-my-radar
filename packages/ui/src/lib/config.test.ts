/**
 * The client reads its API base from the document, and every way that can fail
 * fails silently: a missing element, a malformed block, a server that stopped
 * injecting. None of them throw anywhere a person would see — they just leave
 * every request pointing somewhere unintended.
 *
 * So each one is pinned to the same answer as "no configuration at all":
 * same-origin, which is what this client did before it could be configured.
 * `readConfig` takes the document rather than reaching for a global precisely
 * so this can be asserted without one.
 */
import { describe, expect, it } from 'vitest';
import { apiUrl, readConfig, type ClientConfig } from './config.js';

/** The smallest thing shaped like the part of Document that is actually used. */
const docWith = (text: string | null): Pick<Document, 'getElementById'> => ({
  getElementById: () => (text === null ? null : ({ textContent: text } as HTMLElement)),
});

const base = (json: string | null): string => readConfig(docWith(json)).apiBase;

describe('client configuration', () => {
  it('is same-origin when the document carries no config', () => {
    expect(base(null)).toBe('');
  });

  it('reads the API base the server injected', () => {
    expect(base('{"apiBase":"https://api.onmyradar.io"}')).toBe('https://api.onmyradar.io');
  });

  it('strips a trailing slash rather than emitting a doubled one', () => {
    expect(base('{"apiBase":"https://api.onmyradar.io/"}')).toBe('https://api.onmyradar.io');
  });

  it('falls back to same-origin on a malformed block', () => {
    expect(base('{not json')).toBe('');
  });

  it('falls back to same-origin when apiBase is the wrong type', () => {
    expect(base('{"apiBase":42}')).toBe('');
  });

  it('falls back to same-origin on an empty block', () => {
    expect(base('')).toBe('');
  });

  /** The default path: relative, byte-identical to what it was before. */
  it('leaves paths untouched when there is no base', () => {
    const cfg: ClientConfig = readConfig(docWith(null));
    expect(cfg.apiBase).toBe('');
    expect(apiUrl('/api/radars')).toBe('/api/radars');
  });
});

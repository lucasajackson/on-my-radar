import { describe, expect, it } from 'vitest';
import { parseSearchWith } from '@tanstack/react-router';
import { readConnectSearch } from './connect';

describe('readConnectSearch', () => {
  const query =
    '?client_id=abc&redirect_uri=https%3A%2F%2Fx.test%2Fcb&response_type=code' +
    '&code_challenge=cccccccccccccccccccccccccccc&state=1e3&scope=read';

  it('returns state byte for byte, however JSON-shaped it looks', () => {
    for (const state of ['12345', '1e3', '1.50', 'true', 'null', '"quoted"', '007']) {
      const search = readConnectSearch(`?state=${encodeURIComponent(state)}`);
      expect(search.state).toBe(state);
    }
  });

  it('is needed: the router parser turns the same values into something else', () => {
    // This is what `useSearch` handed the consent screen before.
    const routerParse = (query: string): unknown =>
      Object.entries(parseSearchWith(JSON.parse)(query)).find(([key]) => key === 'state')?.[1];
    expect(routerParse('?state=12345')).toBe(12345);
    expect(routerParse('?state=1e3')).toBe(1000);
  });

  it('reads every field the decision needs, and nothing else', () => {
    expect(readConnectSearch(`${query}&extra=1`)).toEqual({
      client_id: 'abc',
      redirect_uri: 'https://x.test/cb',
      response_type: 'code',
      code_challenge: 'cccccccccccccccccccccccccccc',
      state: '1e3',
      scope: 'read',
    });
  });
});

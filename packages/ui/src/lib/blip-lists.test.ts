import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { invalidateBlipLists, queryKeys } from './session';

it('refreshes every list a changed blip can be showing in, the tag page included', async () => {
  const client = new QueryClient();
  const lists = [
    queryKeys.tagBlips('garden'),
    queryKeys.blips('r1', {}),
    queryKeys.search('#garden'),
    queryKeys.radars,
    ['widget-results', 'd1', 'w1', {}],
  ];
  for (const key of lists) client.setQueryData(key, { items: [] });
  await invalidateBlipLists(client);
  for (const key of lists) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

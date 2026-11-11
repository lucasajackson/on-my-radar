/**
 * Universal search — the REST half.
 *
 * Thin, like every other route in this application: parse, call the service,
 * return. `services/search.ts` is where the grammar is resolved and where the
 * readable set is decided, and the MCP tool calls the identical function with
 * the identical `Actor`. A filter that worked here and not there would mean two
 * implementations, which is the thing the service layer exists to prevent.
 */
import { Hono } from 'hono';
import { SEARCH_FIELD_VALUES, searchSchema } from '@onmyradar/contract';
import { readQuery, requireActor, type AppEnv } from '../http.js';
import {
  searchBlips,
  searchCorpusSize,
  searchPeople,
  searchRadarNames,
  searchTopicNames,
} from '../services/search.js';

export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  return c.json(await searchBlips(actor, readQuery(c, searchSchema)));
});

/**
 * What the box may complete: the radars and the people this person could
 * legally name.
 *
 * One call rather than two, because the completion popup needs both the moment
 * a colon is typed and a second round trip would show `in:` completions a beat
 * after `from:` ones. Both lists come from the search service, so neither can
 * offer something the search itself would refuse to resolve — a completion for a
 * radar that then "matched no radar you can read" would be a worse disclosure
 * than no completion at all.
 */
searchRoutes.get('/suggest', async (c) => {
  const actor = requireActor(c);
  const [radars, people, corpus, topics] = await Promise.all([
    searchRadarNames(actor),
    searchPeople(actor),
    searchCorpusSize(actor),
    searchTopicNames(actor),
  ]);
  // `values`: the closed vocabularies (`has:`, `is:`, `kind:`), so the box can
  // offer them the moment a colon is typed. Also in the contract as
  // `SEARCH_FIELD_VALUES`; sent here for a client that does not bundle it.
  return c.json({ radars, people, corpus, topics, values: SEARCH_FIELD_VALUES });
});

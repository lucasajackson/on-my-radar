/**
 * Personal access tokens for connecting agents over MCP.
 *
 * Every route here is `requireUser`, not `requireActor`: a PAT is a credential,
 * and minting one is how a scoped connection would escape its own ceiling. A
 * token granted `radars:read` that can `POST /api/tokens` simply hands itself a
 * full-access PAT, which makes every scope in the application decoration again —
 * the exact bug this file's neighbours exist to fix. Listing is included because
 * a token's prefix and last-use time are inventory of somebody's credentials.
 */
import { Hono } from 'hono';
import { createTokenSchema } from '@onmyradar/contract';
import { getMcpAvailability } from '../services/mcp-availability.js';
import { readJson, requireUser, type AppEnv } from '../http.js';
import { agentDto, listAgents } from '../services/agents.js';
import {
  createToken,
  listGrants,
  listTokens,
  revokeGrant,
  revokeToken,
} from '../services/tokens.js';

export const tokenRoutes = new Hono<AppEnv>();

tokenRoutes.get('/', async (c) => {
  const actor = requireUser(c);
  return c.json({
    tokens: await listTokens(actor),
    // The personas this account owns, so the screen can offer one when a
    // connection is named rather than making somebody go and create it first.
    agents: (await listAgents(actor)).map((agent) => agentDto(agent)),
    // Everything the Settings → Connections screen needs to render copy-paste config.
    mcp: getMcpAvailability(actor),
  });
});

/*
  Personas live under the tokens routes because they are the same screen and the
  same question — what have I connected, and under whose name does it write.

  `requireUser` throughout, like everything else in this file, and the service
  asserts the same thing again through `assertHumanDecision`. That is deliberate
  duplication of exactly the kind the topic-fence bug argued for: the route
  guard protects this path, and the service guard protects every path, including
  the one somebody adds next year.
*/
/*
  Personas were folded into agents in v2 (docs/AGENT_REPO.md §V2.5): an agent in
  the Agent Repo *is* the identity now, created on its own page. These two
  answer 410 with a sentence rather than 404, for clients built against v1.
*/
tokenRoutes.post('/agents', (c) => {
  requireUser(c);
  return c.json(
    {
      error: {
        code: 'gone',
        message:
          'Identities are agents now. Create one in Agents (/repo/new) — it writes under its own name, cosigned by you.',
      },
    },
    410,
  );
});

tokenRoutes.delete('/agents/:id', (c) => {
  requireUser(c);
  return c.json(
    {
      error: {
        code: 'gone',
        message: 'Identities are agents now. Archive the agent from its Settings in Agents.',
      },
    },
    410,
  );
});

/*
  Connected remote apps — OAuth grants. Listing and disconnecting are both
  `requireUser`: a grant's existence is inventory of somebody's credentials,
  and a connection that could revoke grants could cut off the person's others.
*/
tokenRoutes.get('/grants', async (c) => {
  const actor = requireUser(c);
  return c.json({ grants: await listGrants(actor) });
});

tokenRoutes.delete('/grants/:clientId', async (c) => {
  const actor = requireUser(c);
  const revoked = await revokeGrant(actor, c.req.param('clientId'));
  return c.json({ revoked });
});

tokenRoutes.post('/', async (c) => {
  const actor = requireUser(c);
  const input = await readJson(c, createTokenSchema);
  const token = await createToken(actor, input);
  return c.json({ token }, 201);
});

tokenRoutes.delete('/:id', async (c) => {
  const actor = requireUser(c);
  await revokeToken(actor, c.req.param('id'));
  return c.body(null, 204);
});

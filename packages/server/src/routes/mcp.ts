/**
 * The MCP endpoint.
 *
 * Streamable HTTP in stateless mode: a fresh McpServer and transport per
 * request, so nothing has to be kept between calls and a rolling deploy cannot
 * strand a session.
 *
 * The web-standard transport, which takes a `Request` and returns a `Response`
 * — what Hono already speaks. The Node one wrapped it around the raw
 * request/response, and declared `onclose` and friends as accessors typed
 * `| undefined`, which is not assignable to the SDK's own `Transport` under
 * `exactOptionalPropertyTypes`; this one declares them as optional properties.
 * The Node response is still used for one thing: its `close` event, which says
 * the reply — possibly a stream — has been delivered and the per-request
 * server can go.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { env } from '../env.js';
import type { AppEnv } from '../http.js';
import { logger } from '../logger.js';
import { buildMcpServer } from '../mcp/server.js';

type McpEnv = { Bindings: HttpBindings; Variables: AppEnv['Variables'] };

export const mcpRoutes = new Hono<McpEnv>();

/**
 * A 401 here must tell the client *where* to authenticate, or a remote MCP
 * client has no way to start the OAuth flow (RFC 9728 / the MCP auth spec).
 */
function unauthorizedResponse(c: Context<McpEnv>) {
  const resourceMetadata = `${env().PUBLIC_URL}/.well-known/oauth-protected-resource`;
  c.header('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"`);
  /*
   * Whether a credential was even offered, which the request log cannot say.
   *
   * A 401 here has two completely different causes — the client sent nothing, or
   * it sent something this server will not resolve — and they point at opposite
   * ends of the system. Four hours were spent on 2026-08-27 distinguishing them
   * by correlating pod logs against `oauth_tokens.last_used_at`, which is a
   * fine thing to be able to do once and a poor thing to have to do twice.
   *
   * The boolean only. The token itself is a live credential and never goes near
   * a log line.
   */
  logger.info(
    {
      requestId: c.get('requestId'),
      method: c.req.method,
      presented: (c.req.header('authorization') ?? '').toLowerCase().startsWith('bearer '),
    },
    'mcp request was not authenticated',
  );
  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authentication required' },
      id: null,
    },
    401,
  );
}

async function handleMcp(c: Context<McpEnv>) {
  if (!env().MCP_ENABLED) {
    return c.json({ error: 'MCP is disabled on this server' }, 404);
  }

  /*
   * Answered **before** the actor is resolved, and that ordering is the whole
   * fix rather than a tidy-up.
   *
   * Streamable HTTP lets a client open the server-to-client stream with
   * `GET /mcp`, and the spec's own answer for a server that does not offer one
   * is 405. This server is stateless: there is never a stream to open and never
   * a session to DELETE, and no credential changes that. Checking auth first
   * meant a client that opened the stream without an `Authorization` header got
   * a 401 carrying a `WWW-Authenticate` challenge — an instruction to go and
   * obtain a token, issued for a request that no token could ever satisfy.
   *
   * LM Studio followed that instruction literally. Against production on
   * 2026-08-27 it opened the stream unauthenticated, read the challenge as
   * "your token is stale", refreshed, retried, and refreshed again: 1039
   * `GET /mcp` 401s and 1047 refreshes in four minutes, minting 1043 access
   * tokens of which two were ever presented. The connection never finished and
   * nothing surfaced to the user.
   *
   * Nothing is disclosed by answering first. Which methods this endpoint
   * implements is published behaviour, identical for every caller, and the body
   * says only that the server is stateless — the same sentence an authenticated
   * caller already got.
   */
  const method = c.req.method;
  if (method === 'GET' || method === 'DELETE') {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'This server runs MCP statelessly; use POST.' },
        id: null,
      },
      405,
    );
  }

  const actor = c.get('actor');
  // An integration credential is never an MCP caller (docs/HELPDESK.md §3.3).
  // `attachActor` already resolves it to nobody here; this is the second fence,
  // because an MCP server built for it would list every radar its owner has.
  if (!actor || actor.kind === 'integration' || actor.kind === 'guest')
    return unauthorizedResponse(c);
  // Single-user mode signs the browser in without asking, so a session proves nothing about
  // who is calling: any page that reaches this port has one, and it is a plain string a
  // process can send as a cookie or as a bearer token. Agents bring a PAT or an OAuth token.
  if (env().SINGLE_USER_EMAIL && actor.kind === 'user') return unauthorizedResponse(c);
  if (actor.user.state !== 'active') {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32003, message: `This account is ${actor.user.state}.` },
        id: null,
      },
      403,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      400,
    );
  }

  // No session id generator: that absence is what makes the transport stateless.
  const transport = new WebStandardStreamableHTTPServerTransport();
  const userAgent = c.req.header('user-agent');
  const server = buildMcpServer(userAgent ? { ...actor, userAgent } : actor);

  // Both are per-request; closing the transport when the response ends is what
  // stops each call leaking a server instance.
  c.env.outgoing.on('close', () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport);
    // An ordinary Response through Hono, so the cross-origin headers are the
    // CORS middleware's to add, as on every other route (see `cors.ts`).
    return await transport.handleRequest(c.req.raw, { parsedBody: body });
  } catch (err) {
    logger.error({ err, userId: actor.user.id }, 'mcp request failed');
    return c.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
      500,
    );
  }
}

mcpRoutes.all('/', (c) => handleMcp(c));

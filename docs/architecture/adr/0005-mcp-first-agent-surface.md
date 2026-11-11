# ADR-0005: The MCP server is a first-class surface, stateless, and every REST route is classified against it

Status: Accepted · Date: 2026-08-26

## Context

The product loop is to capture an idea stream and then let an authorised agent read it. Agent access therefore cannot be a bolt-on, and it cannot lag the web app.

## Decision

- `/mcp` is a stateless Streamable HTTP endpoint: a new `McpServer` and transport per request, POST only (GET and DELETE answer 405 before auth).
- Authentication is a personal access token or an OAuth 2.1 access token; integration and guest actors are refused. A session cookie or `omr_s_` bearer is currently also accepted as a plain `user` actor (see ADR-0007).
- `mcp/capabilities.ts` holds `endpointCoverage`: every REST route is either an MCP tool or has a stated reason (human-only, or transport-specific). `mcp/coverage.test.ts` parses `routes/*.ts` and fails on an unclassified route, so a new endpoint requires a coverage decision.
- Plan admission is applied to every tool, resource and prompt, and to the transport's message path.

## Evidence

- The stateless endpoint and the OAuth server landed with `0ca3520` (2026-08-26). Route classification and its AST test landed in `c76115e` (2026-09-19); MCP plan admission in `b2d8c93` (2026-10-04).
- `packages/server/src/routes/mcp.ts`, `packages/server/src/mcp/coverage.test.ts`.
- The count of registered tools (99 by a static count at `2c4905d`) is not a number this ADR relies on.

## Consequences

- Good: no feature is web-only by accident.
- Cost: every new route costs a classification line, and a tool that is added to the server reaches an already-running client session only after the client reconnects.

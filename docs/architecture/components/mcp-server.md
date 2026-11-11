# Component: M23 MCP server

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The agent surface. A stateless Streamable HTTP endpoint at `/mcp` that builds an MCP server per request around the caller's `Actor`, registers the tools, resources and prompts, and shapes results. Apart from `whoami` and `list_capabilities`, it adds no behaviour of its own: each tool parses its arguments with the contract schemas and calls the service function REST calls.

**Depends on:** M2 (bearer and OAuth resolution), M3, every service component, M25 (schemas).

**Used by:** AI agents (external); the OAuth discovery documents point at it.

**Invariants (and what enforces each):**

- Stateless: a new `McpServer` and a web-standard transport per request, closed when the response closes; GET and DELETE answer 405 before authentication is checked (the 2026-08-27 LM Studio 401 loop is recorded in `routes/mcp.ts`).
- An unauthenticated call gets 401 with `WWW-Authenticate: Bearer resource_metadata=<PUBLIC_URL>/.well-known/oauth-protected-resource`. `integration` and `guest` actors are refused; a non-active account is 403.
- `mcp/capabilities.ts` classifies every route in the top-level `routes/*.ts` files (routes registered directly in `app.ts`, such as `/agent-setup/*`, are outside the scan) as a tool or a reason; `mcp/coverage.test.ts` parses `routes/*.ts` with the TypeScript AST and fails on an unclassified route, an entry with both or neither of `tool` and `reason`, or an unregistered tool name.
- A thrown `ApiError` or zod message passes through; anything else becomes a generic message with an `err_<uuid>` logged server side (`mcp/result.ts`; `handler-boundary.test.ts`). Every result of a tool wrapped in `guard()` passes `fenceClientSupplied` (not `load_agent`, `read_architecture`, `read_attachment_image`, `whoami`, `list_capabilities`, or resources and prompts), which wraps fields of client-originated text as data and defuses a client's own copies of the markers.
- Human-only acts have no tool and are also refused in the service (ADR-0007); `list_capabilities` and `onmyradar://capabilities` return the human-only list.
- `load_agent` and other agent tools return text blocks, not `structuredContent` (`mcp/structured-content.test.ts`).

## 2. Owned data

| Owned                                      | Kind | Notes                                  |
| ------------------------------------------ | ---- | -------------------------------------- |
| `packages/server/src/routes/mcp.ts`        | file | Mounted at `/mcp`                      |
| `packages/server/src/mcp/server.ts`        | file | Tool, resource and prompt registration |
| `packages/server/src/mcp/capabilities.ts`  | file | The route-to-tool coverage inventory   |
| `packages/server/src/mcp/result.ts`        | file | Result and error shaping               |
| `packages/server/src/mcp/coverage.test.ts` | file | The coverage test                      |

## 3. Interface

- **Endpoint:** `POST /mcp` (stateless). Discovery: `/.well-known/oauth-protected-resource`.
- **Tools by domain:** identity (`whoami`, `list_capabilities`); radars and templates (M4); topics and sharing (M3); blips and the drop box (M5); comments (M7); dashboards (M9); feeds (M15); subscriptions (M16); webhooks (M5); integrations (M18); notifications (M10); files and email (M12, M13); architecture (M6); the Agent Repo (M21, M22).
- **Resources:** `onmyradar://radars`, `onmyradar://capabilities`, `onmyradar://agents`, `onmyradar://agents/{agent}`, `onmyradar://agents/{agent}/memories/{name}`. **Prompt:** `agent`.
- **Configuration:** `MCP_ENABLED` (default true), `MCP_ALLOWED_REDIRECT_HOSTS`.

## 4. Failure and degradation

- `MCP_ENABLED=false` answers 404. A tool added on the server reaches a connected client only after it reconnects, and a connector may cache the tool list.

## 5. Known gaps and unverified facts

- The live tool count was not measured; a static count of `registerTool(` calls at `2c4905d` finds 99 distinct names (77 in `server.ts`, 1 in `capabilities.ts`, 21 in `agent-repo.ts`).
- The `invocation: 'mcp'` flag is set on session-cookie and `omr_s_` callers too, and is not consulted by the human-only fence (see M3).

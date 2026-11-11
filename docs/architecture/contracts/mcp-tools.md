# Contract: AI agents (MCP tools, resources and prompts)

Status: Draft · Version 1.0 · Owner (OMR side): M23 MCP server · Owner (other side): AI agents (Claude, Codex, Cursor and other MCP clients) acting for a person · Provider ref verified against: MCP Streamable HTTP, stateless, at `routes/mcp.ts` on `2c4905d`

## 1. Scope

The tools, resources and prompt an agent sees at `POST /mcp`. Each tool maps to a service function; the registry of what is a tool and what is human-only is `mcp/capabilities.ts`. Tool families are listed by domain in `components/mcp-server.md`.

## 2. Auth

- `Authorization: Bearer` with a personal access token or an OAuth access token (see `contracts/oauth-server.md`); the account must be `active`, read fresh on every request. The route also accepts the `omr_session` cookie and an `omr_s_` bearer: those arrive as a plain `user` actor with no credential ceiling, so they pass the human-only fences, and `/mcp` is outside the CSRF guard.
- Effective access is `min(person's grants, the credential's ceiling)`; the voice an agent may write in is carried by `voice:persona` and `voice:principal` grants.

## 3. Operations

| Operation                  | Shape                                                                   | Effect   | Notes                                                                               |
| -------------------------- | ----------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `tools/list`, `tools/call` | per tool                                                                | per tool | Many inputs are contract zod schemas; others are declared inline in `mcp/server.ts` |
| `resources/read`           | `onmyradar://radars`, `onmyradar://capabilities`, `onmyradar://agents…` | read     |                                                                                     |
| `prompts/get`              | `agent`                                                                 | read     | Loads an agent with harness `mcp-prompt`                                            |
| `list_capabilities`        | tool                                                                    | read     | Returns the human-only list and the web-feature equivalents                         |

## 4. Errors and refusals

- 401 with `WWW-Authenticate: Bearer resource_metadata=…` when unauthenticated; 405 for GET and DELETE; 401 also for an `integration` or `guest` actor and for a token whose account is not `active` (the token does not resolve); 403 for a session-based caller whose account is pending or suspended, and for a plan with `features.mcp` false (`plan_mcp_unavailable`); 404 when `MCP_ENABLED` is false.
- A refusal names what was refused and why; a human-only act has no tool and is refused in the service for agent credentials; a session or `omr_s_` caller on `/mcp` is a `user` actor and is not fenced.

## 5. Idempotency, versioning and limits

- Stateless per request; no session id. Tool results for client-originated text are fenced as data. New tools reach a connected client only after it reconnects.
- A write by an agent is cosigned (ADR-0006) and rate limits apply per component (for example 120 memory writes per session per hour).

## 6. Known gaps and unverified facts

- The live tool count was not measured; a static count at `2c4905d` finds 99 distinct names.
- `docs/MCP.md` was not diffed against the registry.

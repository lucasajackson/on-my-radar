# ADR-0002: REST, MCP and the worker are thin transports over one service layer

Status: Accepted · Date: 2026-08-26

## Context

An AI agent is a first-class client of On My Radar. If the MCP tools had their own implementation, every authorization rule would exist twice and drift.

## Decision

- All behaviour lives in `packages/server/src/services`. A route parses a request and calls a service function with an `Actor`; an MCP tool parses its arguments and calls the same function with the same kind of `Actor`; the worker calls the same functions to run jobs.
- No service imports a route, an MCP module or Hono. Errors cross the boundary as `ApiError`.
- Both transports are mounted from the same app: `/api` and `/api/v1` from one list of routers, `/mcp` beside them.

## Evidence

- The rule is stated in `docs/DESIGN.md` section 1 and landed with the first commit `0ca3520` (2026-08-26). `b305512` (2026-08-27) moved the human-only fences out of the tool router and into the services so the rule holds for REST too.
- `packages/server/src/app.ts` mounts `apiRoutes` at both prefixes (added with the versioned API in `9026833`, 2026-09-01).
- A grep over `services/*.ts` finds no import of `routes/`, `mcp/` or `hono`.

## Consequences

- Good: an agent cannot do what its person cannot, because it runs the same checks.
- Cost: a service function's signature carries the `Actor`, so background code must construct one; the inbound email path, for example, writes as a `webhook` actor carrying the owner.

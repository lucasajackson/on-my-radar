# Contract: REST API (/api and /api/v1)

Status: Draft · Version 1.0 · Owner (OMR side): M24 API edge · Owner (other side): M26 Web UI; M27 iOS client; scripts and integrations that hold a session or token · Provider ref verified against: `packages/server/src/app.ts` (`apiRoutes`) at `2c4905d`

## 1. Scope

The JSON HTTP surface that the web app and the iOS app use, and the surface the MCP tools wrap. Every router is mounted twice from one list, at `/api<path>` and `/api/v1<path>`; the helpdesk router is versioned only (`/api/v1/helpdesk`). `/oauth`, `/.well-known`, `/mcp`, `/hooks` and `/health` are unversioned.
The shapes are defined by the contract package (M25), not here.

## 2. Auth

- A browser uses the `omr_session` cookie (SameSite Lax); a native or scripted client sends `Authorization: Bearer omr_s_…` (a device session), `omr_pat_…` (a personal access token) or an OAuth access token. `omr_int_…` is accepted only under `/api/v1/helpdesk`.
- Cross-site writes with a cookie are refused by `Sec-Fetch-Site` or `Origin`; bearer requests are exempt. Cross-origin bearer requests are allowed only from `CORS_ALLOWED_ORIGINS` (default empty; the preflight permits GET, POST, PATCH, PUT and DELETE), and `Access-Control-Allow-Credentials` is never sent.

## 3. Operations

| Operation      | Shape                                                                  | Effect     | Notes                                                                                 |
| -------------- | ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| Mount          | `/api/<router>` and `/api/v1/<router>`                                 | per router | One list in `app.ts`; the router set is the one in each component's interface section |
| Error envelope | `{ "error": { "code", "message", "id"? } }`                            | —          | Uniform; unknown paths under `/api` are JSON 404s (`errors.ts`)                       |
| Pagination     | opaque keyset cursor, at most 1024 characters                          | read       | Cursors preserve Postgres microseconds                                                |
| Discovery      | `/api/auth/config`, `/api/auth/session`, `/api/notifications/settings` | read       | Clients discover capabilities rather than assume them                                 |

## 4. Errors and refusals

- A radar the caller cannot read is a 404, never a 403.
- A body over `HTTP_BODY_LIMIT_BYTES` (default 2 MiB) is refused; anonymous routes have their own caps (a 16 KiB cap on anonymous bodies was added on 2026-10-29, commit `b7ebfcf`).
- An unexpected exception becomes a 500 with an opaque `err_…` id and no internal message; a deliberate 5xx `ApiError` (for example 503 `storage_unavailable`) keeps its own code and message.

## 5. Idempotency, versioning and limits

- The version segment exists so a breaking change can be added beside the old one; no `v2` exists. `Idempotency-Key` on `createBlip` and `createComment` does not exist yet and is recorded as a prerequisite for a native capture outbox (`docs/ARCHITECTURE.md`).
- Every route is classified for MCP in `mcp/capabilities.ts` (`mcp/coverage.test.ts`).

## 6. Known gaps and unverified facts

- The full route list is not restated here; each component lists its routes. `docs/SPLIT.md` describes the series that created the versioned surface.

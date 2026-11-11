# Component: M18 Helpdesk and integrations

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The client side of a client-facing radar. An integration is a credential held by the Workshop & Web portal that can read and write a whitelisted projection of requests on enrolled helpdesk radars, and receives signed ids-only events. Staff and agent replies reach the client only when the owner releases them (M7); a reply posted through the portal API is the client's own and is stored as client-visible at once.

**Depends on:** M3 (`requireHelpdeskRadar`), M5, M7, M10 (`reply_pending`), M16 (the same signature scheme), M11.

**Used by:** The portal; M23 (four tools); the UI Settings -> Integrations.

**Invariants (and what enforces each):**

- The credential `omr_int_…` reaches `/api/v1/helpdesk` only and requires `X-OMR-Requester-Scope` on the four `/requests` routes (the radar list and the events feed take none, and carry ids only); requests are isolated by integration and requester scope, and a cross-account request is a 404 identical to a missing one (`auth/middleware.ts`; `helpdesk-integration.test.ts`).
- The projection is a whitelist; client-supplied fields are fenced at MCP result boundaries (`services/helpdesk-projection.ts`).
- Minting, rotating, revoking and enrolling are human-only; agents may list, unenrol and pause. Revocation is terminal and removes all enrolments; deletion is refused by trigger `integrations_guard` (function `omr_integrations_guard`), except in a user-deletion cascade; expiry is at most 90 days by CHECK.
- Events are appended by triggers on `blips`, `blip_comments` and `integration_radars` in the same transaction as the change; they are immutable and carry only ids, with an `(xid8, seq)` cursor read below the `pg_snapshot_xmin` watermark (`helpdesk-events.test.ts`).
- Pushed events use the outbound-subscription signature, six attempts and the same schedule; unlike subscriptions, exhaustion pauses delivery and keeps the rows.
- The per-minute rate limit is a single atomic `UPDATE` (`consumeIntegrationCall`).
- `helpdesk_requests` ties provenance (portal, support or guest) to its columns by CHECK.

## 2. Owned data

| Owned                                                 | Kind  | Notes                                              |
| ----------------------------------------------------- | ----- | -------------------------------------------------- |
| `integrations`                                        | table |                                                    |
| `integration_radars`                                  | table |                                                    |
| `integration_events`                                  | table |                                                    |
| `integration_deliveries`                              | table |                                                    |
| `integration_delivery_attempts`                       | table |                                                    |
| `integration_idempotency`                             | table |                                                    |
| `integration_scope_windows`                           | table |                                                    |
| `helpdesk_requests`                                   | table |                                                    |
| `packages/server/src/services/helpdesk.ts`            | file  | Requests and replies                               |
| `packages/server/src/services/helpdesk-projection.ts` | file  | Whitelisted projection and the MCP fence           |
| `packages/server/src/services/integrations.ts`        | file  | Credential lifecycle, enrolment, delivery settings |
| `packages/server/src/services/integration-events.ts`  | file  | Events and push delivery                           |
| `packages/server/src/routes/helpdesk.ts`              | file  | Mounted at `/api/v1/helpdesk` only                 |
| `packages/server/src/routes/integrations.ts`          | file  | Mounted at `/api/integrations`                     |
| `packages/contract/src/helpdesk.ts`                   | file  | Helpdesk DTOs, event kinds and limits              |

## 3. Interface

- **Routes:** `/api/v1/helpdesk`: `GET /radars`, `GET|POST /radars/:radarId/requests`, `GET /requests/:id`, `POST /requests/:id/replies`, `GET /events`. `/api/integrations`: list, create, rotate, revoke-previous, revoke, radars, delivery, pause, resume, test, deliveries.
- **MCP tools:** `list_integrations` (with `integrationId`, its deliveries), `unenroll_helpdesk_radar`, `pause_integration_delivery`. Helpdesk reads and replies are not exposed over MCP.
- **Event kinds:** `request.status_changed`, `request.reply`, `request.reply_retracted`, `request.removed`, `integration.test`.
- **Configuration:** none; there is no flag for helpdesk.

## 4. Failure and degradation

- A failed push pauses delivery; the portal can still pull `GET /events`.

## 5. Known gaps and unverified facts

- The portal side is recorded as not built in `docs/HELPDESK.md`; no code in this repository references Roving Express.
- `HELPDESK_LIMITS` values live in `packages/contract/src/helpdesk.ts` and were not restated here.

# Contract: Workshop & Web portal (helpdesk API and signed events)

Status: Draft · Version 1.0 · Owner (OMR side): M18 Helpdesk and integrations · Owner (other side): Workshop & Web portal (the client-facing side; not built according to `docs/HELPDESK.md`) · Provider ref verified against: `routes/helpdesk.ts`, `services/integration-events.ts`, `docs/HELPDESK.md` at `2c4905d`

## 1. Scope

The portal reads and writes a whitelisted projection of requests on helpdesk radars an owner has enrolled, and learns of changes from signed events that carry only ids.

## 2. Auth

`Authorization: Bearer omr_int_…` and the header `X-OMR-Requester-Scope`; the credential works under `/api/v1/helpdesk` and nowhere else. Credentials expire in at most 90 days, rotate with an optional 0 to 24 hour overlap (default 2) and revoke terminally. Event pushes use the outbound-webhook signature.

## 3. Operations

| Operation   | Shape                                                      | Effect          | Notes                                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Radars      | `GET /api/v1/helpdesk/radars`                              | read            | Enrolled radars only                                                                                                                                                                                                                                   |
| Requests    | `GET\|POST /radars/:radarId/requests`, `GET /requests/:id` | read and create | Created requests have portal provenance                                                                                                                                                                                                                |
| Replies     | `POST /requests/:id/replies`                               | create          | Stored at once with `visibility = 'client'`, `author_id` NULL and the requester as `external_author`; there is no owner release on this endpoint (`createHelpdeskReply`). Owner release applies to comments written by staff, agents and collaborators |
| Events pull | `GET /events`                                              | read            | Cursor `(xid8, seq)` below the `pg_snapshot_xmin` watermark                                                                                                                                                                                            |
| Events push | signed `POST` to the integration's `delivery_url`          | irreversible    | `request.status_changed`, `request.reply`, `request.reply_retracted`, `request.removed`, `integration.test`; ids only                                                                                                                                  |

## 4. Errors and refusals

- A request outside the integration's scope is a 404 identical to a missing one. Rate limiting is a per-minute atomic window plus a separate hourly limit on writes per scope (`consumeScopeWrite`).

## 5. Idempotency, versioning and limits

- Six push attempts on the subscription schedule; exhaustion pauses and keeps the rows. Idempotency keys are recorded in `integration_idempotency` and purged on expiry.

## 6. Known gaps and unverified facts

- The portal side is not built; this contract has no live consumer.
- `integrations.staff_display_name` defaults to `Support` in the database (migration 0103).

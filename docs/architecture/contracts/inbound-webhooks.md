# Contract: Webhook senders (capture URLs)

Status: Draft · Version 1.0 · Owner (OMR side): M5 Blips and capture · Owner (other side): Webhook senders (scripts and services the radar owner connects) · Provider ref verified against: `services/webhooks.ts` and `routes/hooks.ts` at `2c4905d`

## 1. Scope

`POST|PUT /hooks/:id/:token` creates one blip on one radar. It is the one unauthenticated write whose whole credential is a token in the URL path (the waitlist, invitation and guest-support endpoints are also unauthenticated, but they take no credential). A `GET` answers 200 with a note, captures nothing, and does not say whether the token is right.

## 2. Auth

A token of the form `omr_hook_…`, shown once at creation or rotation and stored as a keyed hash (`radar_webhooks.token_hash`, unique). An unknown id and a wrong token both answer 404, and a closed account's webhook answers 404. The drop box refuses a webhook.

## 3. Operations

| Operation   | Shape                                                                                                                   | Effect                                           | Notes                                                                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create blip | `POST\|PUT /hooks/:id/:token`, body at most 64 KiB, JSON, form or text; files in multipart are ignored                  | creates a blip as the creator, `authored: false` | Answers 202 `{ ok, blipId }`; 60 requests per minute enforced by one atomic `UPDATE` on the row                                                                                                                                                                                |
| Manage      | `POST /api/radars/:id/webhooks`, `PATCH /api/webhooks/:id`, `POST /api/webhooks/:id/rotate`, `DELETE /api/webhooks/:id` | create, update, rotate, delete                   | Needs manage access on the radar (`requireRadar(..., 'manage')`). Not human-only: an agent with `radars:manage` may call the MCP tools `create_webhook`, `update_webhook`, `rotate_webhook_secret` and `delete_webhook`, and receives the one-time `secretUrl` in the response |

## 4. Errors and refusals

- A malformed id, a missing token, an unknown id, a wrong token or a closed account is 404; a disabled webhook, a creator whose account is not `active` (for example suspended), or an empty payload is 400, and only once the token has matched. The body cap and the per-minute limit are enforced by the hook route and `ingestWebhook`; a smart radar accepts no capture. The `GET` answer is 200 with a note and confirms nothing about the token.

## 5. Idempotency, versioning and limits

- No idempotency key exists; a retried POST makes a second blip.

## 6. Known gaps and unverified facts

- `hooks.ts` says `logger` redacts every `path` it is handed (`scrubPath`); the end-to-end behaviour was not traced.

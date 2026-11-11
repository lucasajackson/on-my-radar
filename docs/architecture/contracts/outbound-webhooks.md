# Contract: Webhook receivers (signed event delivery)

Status: Draft · Version 1.0 · Owner (OMR side): M16 Outbound subscriptions · Owner (other side): Webhook receivers (an HTTPS endpoint the radar owner runs) · Provider ref verified against: `services/subscriptions.ts`, `services/subscription-signing.ts`, `docs/OUTBOUND-WEBHOOKS.md` at `2c4905d`

## 1. Scope

Per-radar subscriptions to `blip.created`, `blip.updated`, `blip.deleted` and `comment.created`. Each delivery is a signed HTTPS POST of an immutable snapshot taken in the producing transaction. `docs/OUTBOUND-WEBHOOKS.md` is the receiver-facing reference.

## 2. Auth

`X-OMR-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`, `X-OMR-Event-Id`, `X-OMR-Delivery-Attempt`. The secret is `omr_whsec_…`, shown once, stored AES-256-GCM under a key derived by HKDF from `SESSION_SECRET`. Receivers should accept a 300 second skew.

## 3. Operations

| Operation | Shape                                             | Effect                                    | Notes                                                                       |
| --------- | ------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| Deliver   | `POST` to the receiver                            | irreversible                              | HTTPS only, DNS pinned, no redirects, 10 second timeout, body not read      |
| Retry     | attempts at 60, 300, 1800, 7200 and 10800 seconds | —                                         | Six attempts; exhaustion disables the subscription and notifies its creator |
| Manage    | `/api/radars/:id/subscriptions`                   | human-only to create, pause, rotate, test | Agents with manage access may list, delete and read history                 |

## 4. Errors and refusals

- An unsafe address is refused when saved and again at delivery. Each attempt rechecks that the creator is active and still has write access.

## 5. Idempotency, versioning and limits

- 20 subscriptions per radar; 100 attempts retained per subscription; one-minute lease with `FOR UPDATE SKIP LOCKED`. Delivery is at least once; the event id is the receiver's idempotency key.

## 6. Known gaps and unverified facts

- The worker and the API must share `SESSION_SECRET` or secrets cannot be decrypted.

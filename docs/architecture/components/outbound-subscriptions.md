# Component: M16 Outbound subscriptions

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Signed HTTPS delivery of blip and comment events from a radar to a receiver the owner chose. Events are snapshotted inside the content transaction, queued in the component's own table and delivered by a dedicated worker lane.

**Depends on:** M3 (the creator's write access is rechecked before every attempt), M10 (`subscription_failed`), M11, M24 (`publicRequest`).

**Used by:** M5, M7, M18, M19 (they enqueue events), M23 (three tools).

**Invariants (and what enforces each):**

- Events are `blip.created`, `blip.updated`, `blip.deleted` and `comment.created`, snapshotted immutably in the producing transaction (`packages/contract/src/subscriptions.ts`; `services/subscriptions.ts`).
- The signature is `X-OMR-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>` with `X-OMR-Event-Id` and `X-OMR-Delivery-Attempt`; receivers should allow 300 seconds (`services/subscription-signing.ts`).
- The secret is `omr_whsec_…`, shown once, stored AES-256-GCM with a key HKDF-derived from `SESSION_SECRET` (`outbound-webhooks-v1`), so the API and worker must share it.
- Transport is HTTPS only, DNS pinned, no redirects, 10 second timeout and the response body unread.
- Six attempts at 60, 300, 1800, 7200 and 10800 seconds; exhaustion disables the subscription, deletes its pending rows and creates a `subscription_failed` notification. History keeps 100 attempts per subscription; 20 subscriptions per radar.
- Creating, pausing, resuming, rotating and testing are human-only; an agent with manage access can list, delete and read history (every one calls `assertHumanDecision`; `subscriptions.test.ts` asserts the refusal for create and rotate).
- The queue is its own table, not the outbox, because its rows have a cascading foreign key, a delivery schedule and owner-visible history; the lease is one minute with `FOR UPDATE SKIP LOCKED`.

## 2. Owned data

| Owned                                                  | Kind  | Notes                                      |
| ------------------------------------------------------ | ----- | ------------------------------------------ |
| `radar_subscriptions`                                  | table |                                            |
| `subscription_deliveries`                              | table |                                            |
| `subscription_attempts`                                | table |                                            |
| `packages/server/src/services/subscriptions.ts`        | file  | Management, enqueue, delivery              |
| `packages/server/src/services/subscription-signing.ts` | file  | Signing and secret encryption              |
| `packages/server/src/routes/subscriptions.ts`          | file  | Mounted at `/api/radars/:id/subscriptions` |

## 3. Interface

- **Routes:** list, create, `PATCH /:subscriptionId`, delete, `/rotate`, `/test`, `/deliveries`.
- **MCP tools:** `list_subscriptions` (with `subscriptionId`, its deliveries), `delete_subscription`.
- Receiver contract: `docs/OUTBOUND-WEBHOOKS.md`.

## 4. Failure and degradation

- A receiver that fails is retried and then disabled, never blocking the content write.

## 5. Known gaps and unverified facts

- Moving a blip between radars: delivery rechecks the blip's radar so an event is not sent across radars; the exact cases are in `subscriptions.test.ts`.

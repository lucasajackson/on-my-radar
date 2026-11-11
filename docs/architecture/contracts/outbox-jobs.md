# Contract: Outbox jobs

Status: Draft · Version 1.0 · Owner (OMR side): M11 Outbox and worker · Owner (other side): M5 Blips and capture; every component that enqueues work · Provider ref verified against: `services/outbox.ts` at `2c4905d`

## 1. Scope

The internal queue: a producer inserts a row in its own transaction, a handler registered for the kind runs it. Producers and handlers are in different components, so the kinds and payload ownership are listed here.

## 2. Auth

None; same database.

## 3. Operations

| Operation            | Shape                     | Effect                                                       | Notes                                                                                                         |
| -------------------- | ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `unfurl`             | `{blipId, url}`           | handler in `services/blips.ts`                               | Enqueued by `createBlip` and `updateBlip`                                                                     |
| `object-cleanup`     | `{keys}`                  | handler in `services/blips.ts`, calling `cleanupStorageKeys` | Enqueued on blip and radar deletion and by the inbound email path                                             |
| `notification`       | `{notificationId}`        | handler in `services/notifications.ts`                       | Enqueued when a notification row is created                                                                   |
| `notification-event` | event snapshot            | handler in `services/notifications.ts`                       | Enqueued by the blip, comment, reaction, topic, radar, reminder, helpdesk, support and guest-support services |
| `push`               | `{deliveryId, expiresAt}` | handler in `services/push-delivery.ts`                       | One per device receipt                                                                                        |
| `email`              | a rendered message        | handler in `services/mail.ts`                                | Enqueued by radar and topic sharing and by the waitlist                                                       |

## 4. Errors and refusals

- A handler that throws is retried; the eighth failure parks the row. An unknown kind waits 24 hours for a process that knows it, then dead-letters.

## 5. Idempotency, versioning and limits

- Lease 300 seconds; backoff `min(30·2^(attempts−1), 3600)`; dead letters are purged 30 days after the job was created, not after it parked. Handlers must be idempotent: a lease can expire during a slow run.

## 6. Known gaps and unverified facts

- Payload shapes are summarised from the producers, not copied from a schema; the authority is each handler's parsing code.

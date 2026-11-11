# ADR-0009: Asynchronous work is a row before it is an attempt: an outbox, an optional worker, no broker

Status: Accepted · Date: 2026-09-02

## Context

Notifications, link previews, queued mail, push and object cleanup must survive a crash between the user's action and the side effect, without adding infrastructure.

## Decision

- Work is inserted into `outbox` in the same transaction as its cause. A job is claimed with one statement using `FOR UPDATE SKIP LOCKED` and a 300-second lease; nothing holds a connection during the handler.
- Failure reschedules with exponential backoff capped at an hour; the eighth failure parks the row for inspection. A process claims only kinds it has handlers for, so a rolling deploy never burns a new kind's retries.
- The web process kicks each job inline after commit, so a deployment with no worker still behaves; the worker is the durability guarantee.
- Deliveries that need a cascading foreign key, their own schedule or owner-visible history (outbound subscriptions, integration events) use their own tables and lanes instead of the outbox.

## Evidence

- `4ffaf8c` (2026-09-02): "asynchronous work becomes a row before it becomes an attempt". `5f60d33` the same day: claim only registered kinds.
- `packages/server/src/services/outbox.ts`, `packages/server/src/worker.ts`, `packages/server/src/services/outbox.test.ts`.

## Consequences

- Good: one more thing for Postgres to arbitrate, and nothing else to deploy.
- Cost: the queue shares the primary's capacity; `pollDueFeed` pauses itself when 1000 or more jobs are due.

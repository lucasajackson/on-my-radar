# Component: M11 Outbox and worker

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The durable job queue and the process that drains it. The `outbox` table holds jobs for six kinds; any process claims runnable ones with a lease; the worker is the same image as the API started as `worker.js` and runs the delivery lanes and the housekeeping sweeps on loops.

**Depends on:** M5, M10, M12, M13, M15, M16, M18, M22 (the handlers and lanes it runs), M24 (configuration, database client).

**Used by:** Everything that needs work done after commit.

**Invariants (and what enforces each):**

- A job is claimed in one statement (`FOR UPDATE SKIP LOCKED`, `run_after <= now()`, only kinds this process has handlers for) that sets `attempts + 1` and a 300-second lease; nothing holds a pool connection during the handler (`services/outbox.ts`; `outbox.test.ts`: never handed to two drainers, a dead claimer's job resurfaces).
- Success deletes the row; failure backs off `min(30·2^(attempts−1), 3600)` seconds; at 8 attempts the row is parked at `9999-12-31` with its error and kept 30 days; a kind no process knows is dead-lettered after 24 hours.
- The six kinds are `unfurl`, `object-cleanup`, `notification`, `notification-event`, `push` and `email`; a process with an empty handler registry claims nothing.
- Callers kick a job inline after commit (`drainOne`), so a deployment without a worker still works; the worker is the durability guarantee.
- The worker runs five single-concurrency lanes: outbound subscription deliveries, integration deliveries, housekeeping and the outbox, feed polling, and brief binding checks (`worker.ts`; `worker-loop.test.ts` tests the loop and per-lane isolation, not the lane count).
- Shutdown hands unstarted claims back with `attempts − 1`; `SHUTDOWN_DRAIN_MS` (5000) must be below `SHUTDOWN_TIMEOUT_MS` (25000).
- The worker serves only `GET /health/live` on `PORT`.

## 2. Owned data

| Owned                                    | Kind  | Notes                                    |
| ---------------------------------------- | ----- | ---------------------------------------- |
| `outbox`                                 | table |                                          |
| `packages/server/src/services/outbox.ts` | file  | Enqueue, claim, complete, fail, sweep    |
| `packages/server/src/worker.ts`          | file  | Worker entry point and lanes             |
| `packages/server/src/worker-loop.ts`     | file  | Single-concurrency loop with idle sleeps |
| `packages/server/src/lifecycle.ts`       | file  | Graceful shutdown                        |
| `packages/server/src/index.ts`           | file  | API entry point                          |

## 3. Interface

- **No routes and no MCP tools.**
- **Housekeeping every 5 minutes:** push receipt purge, auth retention, notification purge, email receipt cleanup, forgotten-memory purge, idle-session purge, outbox sweep, removed-feed purge, idempotency key purge, integration event purge. **Every iteration:** the reminder sweep, then up to 5 outbox jobs.
- **Configuration:** `MIGRATE_ON_BOOT` (honoured by the worker too) and `SHUTDOWN_TIMEOUT_MS`; `SHUTDOWN_DRAIN_MS` is read by the API only (`env.ts` requires it to be below the timeout).

## 4. Failure and degradation

- A handler that throws is retried; a sweep that throws is isolated by `runEach` so it cannot stop the drain.

## 5. Known gaps and unverified facts

- The chart that gives the worker its argv is outside this repository; `docs/ARCHITECTURE.md` states `dist/worker.js` and the Dockerfile has no worker `CMD`.
- `docs/ARCHITECTURE.md` says the worker only drains unfurl, notification, quiet email and cleanup; the code also runs the push, feed, subscription, integration and brief lanes.

# ADR-0010: Attachment bytes go browser to object storage on signed URLs, and active content is refused

Status: Accepted · Date: 2026-08-26

## Context

Uploads can be large, and a user-controlled file served from the app's origin is a cross-site scripting risk.

## Decision

- The API issues a presigned PUT with the content type and length signed in, and a presigned GET of five minutes. Bytes do not pass the pod for browser upload and download.
- `text/html`, `application/xhtml+xml`, `image/svg+xml` and two executable types are refused at upload; a stored type that renders as an active document is forced to `application/octet-stream` with `Content-Disposition: attachment` on download.
- Capture takes size and type from a `HEAD` of the stored object, not from the client.
- Deleting a blip or radar enqueues an `object-cleanup` job that takes the per-key reference lock and re-checks every table that can reference the key before deleting.
- The pod handles bytes only for inbound email, image viewing for agents (bounded: 4 MiB, 8 million pixels) and small reads.

## Evidence

- `0ca3520` (2026-08-26) carried the presign. `f683436` (2026-09-30) fixed browser uploads to R2 by no longer signing an empty-body checksum.
- `packages/server/src/services/storage.ts`, `packages/server/src/services/content-types.ts`, `packages/server/src/services/storage-cleanup.ts`, `packages/server/src/services/storage.test.ts`.

## Consequences

- Good: storage cost and bandwidth stay off the API pods.
- Cost: the bucket's CORS policy lives outside this repository; a boot-time probe only logs when it is wrong.

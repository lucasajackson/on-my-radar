# Component: M12 Storage and attachments

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Attachment bytes and who may touch them. It issues presigned uploads and downloads against S3-compatible storage (Cloudflare R2 in production), authorises each by the radar's access rules, refuses active content, and deletes objects through a durable cleanup job that re-checks references. It also keeps the table remnants of a storage ledger that was removed (ADR-0019).

**Depends on:** M3 (access), M11 (the `object-cleanup` job).

**Used by:** M5 (capture), M13 (email payloads), M20 (export tickets), M23 (attachment tools).

**Invariants (and what enforces each):**

- Browser upload and download do not pass the pod: the ticket is a presigned PUT with the content type and length signed in (900 seconds), the download a presigned GET (300 seconds). Capture takes size and type from a `HEAD` of the object, not the client (`services/storage.ts`, `services/blips.ts`; `storage.test.ts`).
- `text/html`, `application/xhtml+xml`, `image/svg+xml` and two executable types are refused at upload; a stored type that renders as an active document is forced to `application/octet-stream` plus `attachment` on download (`services/content-types.ts`).
- Limits: 25 MiB per attachment and 12 per blip for uploads (email capture may store up to 12 attachments plus 48 inline images on one blip). A key must start with `radars/<radarId>/`.
- Access is re-checked on every download request through `requireRadar(…, 'read')` (`services/attachment-access.ts`); the public-radar route uses `requirePublicRadar` and its own join instead.
- Deleting rows queues an `object-cleanup` job; the handler takes `omr_storage_reference_lock(key)` for each sorted key and deletes only keys that no `attachments`, `blip_emails` or incomplete `email_capture_receipts` row references (`services/storage-cleanup.ts`; `attachment-cleanup.test.ts` covers deleting a radar's or blip's objects, not the reference check or the lock). Triggers on those three tables take the same lock on insert.
- The pod does handle bytes in three places: inbound email writes, image viewing for agents (4 MiB, 8 million pixels, static PNG, JPEG or WebP, 2 in flight) and bounded reads of email JSON (`services/attachment-image.ts`).

## 2. Owned data

| Owned                                               | Kind  | Notes                                    |
| --------------------------------------------------- | ----- | ---------------------------------------- |
| `attachments`                                       | table |                                          |
| `storage_objects`                                   | table |                                          |
| `storage_protocols`                                 | table |                                          |
| `storage_inventory_runs`                            | table |                                          |
| `storage_inventory_objects`                         | table |                                          |
| `storage_migration_bindings`                        | table |                                          |
| `packages/server/src/services/storage.ts`           | file  | S3 client, tickets, signed URLs, deletes |
| `packages/server/src/services/storage-cleanup.ts`   | file  | Reference-checked object deletion        |
| `packages/server/src/services/attachment-access.ts` | file  | Attachment authorization                 |
| `packages/server/src/services/attachment-image.ts`  | file  | Bounded image reading for agents         |
| `packages/server/src/services/content-types.ts`     | file  | Allowed and refused types                |

## 3. Interface

- **Routes:** `POST /api/radars/:id/uploads` (ticket), `GET /api/attachments/:id` (302 to a signed URL), `GET /api/attachments/:id/image`, `GET /api/public/radars/:slug/attachments/:attachmentId` (all in `routes/radars.ts`, `routes/blips.ts` and `routes/public.ts`).
- **MCP tools:** `create_upload_ticket`, `download_attachment`, `read_attachment_image`.
- **Configuration:** `S3_ENDPOINT`, `S3_REGION` (default `us-east-1`), `S3_BUCKET` (default `on-my-radar`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` (default true).

## 4. Failure and degradation

- Without endpoint, keys and bucket, storage calls answer 503 `storage_unavailable` and nothing else stops. A boot probe asks whether the bucket's CORS allows the app origin and only logs.

## 5. Known gaps and unverified facts

- The five `storage_*` tables have no writer since 2026-10-06 (ADR-0019). `storage_objects` is still read by the account export, and the `omr_storage_reference_fence` trigger on `attachments`, `blip_emails` and `email_capture_receipts` still consults its `state`, so that check cannot currently fire.
- No test drives a re-reference race on the same key against cleanup.
- `env.ts` and `docs/DESIGN.md` still say MinIO; production uses R2.

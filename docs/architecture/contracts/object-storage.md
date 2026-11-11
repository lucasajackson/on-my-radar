# Contract: Object storage (S3 API, Cloudflare R2)

Status: Draft · Version 1.0 · Owner (OMR side): M12 Storage and attachments · Owner (other side): Object storage (Cloudflare R2 in production, any S3-compatible service elsewhere) · Provider ref verified against: `services/storage.ts` at `2c4905d`; AWS SDK `@aws-sdk/client-s3` 3.1118.0

## 1. Scope

Attachment bytes, email payloads (`email-content.json`, `original.eml`) and email attachments. Browsers upload and download directly on signed URLs; the pod writes email objects and reads a few bounded objects.

## 2. Auth

`S3_ACCESS_KEY` and `S3_SECRET_KEY` from `onmyradar-minio`, endpoint `S3_ENDPOINT`, bucket `S3_BUCKET` (default `on-my-radar`), region `S3_REGION`, path style `S3_FORCE_PATH_STYLE` (default true). Signed URLs: upload 900 seconds, download 300 seconds.

## 3. Operations

| Operation             | Shape                                                           | Effect         | Notes                                                                          |
| --------------------- | --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Upload ticket         | presigned `PUT`, content type and length signed in, no checksum | creates object | Key `radars/<radarId>/<uuid>/<safeName>`                                       |
| Download              | presigned `GET` with `Content-Disposition`                      | read           | Active-content types are forced to `application/octet-stream` and `attachment` |
| Head                  | `HEAD` at capture                                               | read           | Size and type come from here                                                   |
| Put/get email content | server-side                                                     | write and read | JSON up to 32 MiB                                                              |
| Delete                | batched `DeleteObjects` of 1,000 keys                           | destructive    | Only from the `object-cleanup` job, after a reference re-check                 |

## 4. Errors and refusals

- No configuration: 503 `storage_unavailable`. A per-key delete error fails the job so the outbox retries. A browser upload blocked by CORS is reported by a boot-time probe that only logs.

## 5. Idempotency, versioning and limits

- AWS SDK bumps must re-verify presigning (an SDK change once started signing an empty-body checksum, fixed in `f683436`).

## 6. Known gaps and unverified facts

- The bucket's CORS policy is outside this repository. `env.ts` and `docs/DESIGN.md` still call this block MinIO.

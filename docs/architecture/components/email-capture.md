# Component: M13 Email capture and reader

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Receives mail addressed to `<username>[+alias]@<capture domain>`, proves the sender by DKIM, stores the content in object storage and creates a blip through the capture service; and serves the stored message back through a sanitised reader. Receipt lifetime and reading lifetime are independent: a blip owns its email content, and moving the blip needs no rewrite.

**Depends on:** M14 (the relay that calls it), M12 (storage), M5 (`createBlip`), M3, M11 (cleanup jobs), M10 (`email_received` notification).

**Used by:** M14, M23 (two tools), the UI reader.

**Invariants (and what enforces each):**

- The ingress is authenticated before the body is read: timestamp within 300 seconds, constant-time HMAC compare over `timestamp, nonce, recipient, size`, and a nonce replay cache (in memory, capacity 10,000, so it assumes one API replica) (`routes/inbound-email.ts`; `email-ingest.test.ts`).
- At most 2 messages are in flight with no queue; each has a 20 second budget and a 10 MiB cap, read into an exact-size buffer; parsing and DKIM verification run in a disposable `worker_threads` Worker with a 64 MiB old-generation limit (`services/email-ingest.ts`, `email-parser.ts`; `email-ingest.test.ts`).
- Authentication requires exactly one From and an exact-domain-aligned, time-valid DKIM signature (rsa-sha256 or ed25519-sha256) of at least 1024 bits that covers `from` and whichever of subject, content-type, content-transfer-encoding and mime-version the message has, and has no `l=`; an `Authentication-Results` header is never trusted (`services/email-authenticate.ts`; `email-authenticate.test.ts`).
- The target is a username and optional alias; no alias means the owner's Drop Box. The sender must be the owner's address or in `allowed_senders` (at most 25), else 403; capture is limited to 100 per radar per day by one atomic `UPDATE` (`inbound-email.ts`).
- The blip is created as a `webhook` actor carrying the owner with `authored: false`; its receipt row is inserted idempotently (id is a SHA-256 of the recipient and the verified DKIM signature value), objects are verified by `HEAD` before the blip exists, and the receipt is scrubbed on completion (`finalizeEmailDelivery`). Abandoned receipts are cleaned after 1 day, completed ones after 90.
- HTML is sanitised at ingest with a tag and CSS allowlist and links forced to `rel="noopener noreferrer nofollow"`; remote images are only resolved with `?images=1`; the UI renders in an iframe with `sandbox="allow-popups allow-popups-to-escape-sandbox"` and its own CSP (`services/email-html.ts`, `packages/ui/src/components/email-content.tsx`; `email-html.test.ts`).
- Reader concurrency is bounded (2 member, 2 public); public reads redact the sender address and the original download (`services/email-reader.ts`; `email-reader.test.ts`).
- The first username claim is permanent and atomically creates the owner's Drop Box source with the account email as its only default sender.

## 2. Owned data

| Owned                                                 | Kind  | Notes                                                               |
| ----------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `email_capture_identities`                            | table |                                                                     |
| `radar_email_capture`                                 | table |                                                                     |
| `email_capture_receipts`                              | table |                                                                     |
| `blip_emails`                                         | table |                                                                     |
| `packages/server/src/routes/inbound-email.ts`         | file  | Mounted at `POST /hooks/email-capture/raw` and `/api/email-capture` |
| `packages/server/src/services/inbound-email.ts`       | file  | Authorise, upload, finalise                                         |
| `packages/server/src/services/email-ingest.ts`        | file  | Bounded ingestion                                                   |
| `packages/server/src/services/email-parser.ts`        | file  | Parser entry                                                        |
| `packages/server/src/services/email-parser-worker.ts` | file  | Parser thread                                                       |
| `packages/server/src/services/email-authenticate.ts`  | file  | DKIM verification                                                   |
| `packages/server/src/services/email-html.ts`          | file  | Sanitisation                                                        |
| `packages/server/src/services/email-render.ts`        | file  | Reader rendering                                                    |
| `packages/server/src/services/email-render-worker.ts` | file  | Render thread                                                       |
| `packages/server/src/services/email-reader.ts`        | file  | Reader and budgets                                                  |
| `packages/server/src/services/email-limits.ts`        | file  | Size and count limits                                               |
| `packages/server/src/services/email-failures.ts`      | file  | Failure codes and friendly messages                                 |
| `packages/server/src/services/email-summary.ts`       | file  | Summary hydrated into blip reads                                    |

## 3. Interface

- **Routes:** `POST /hooks/email-capture/raw` (any other path under it is 404); `GET|PUT /api/email-capture` (username); `GET|PUT /api/radars/:id/email-capture`; reader `GET /api/blips/:id/email`, `GET /api/blips/:id/email/original` (302 to a signed URL), `GET /api/public/radars/:slug/blips/:id/email`.
- **MCP tools:** `get_email`, `download_original_email`. No tool changes receiving or the sender list.
- **Configuration:** `EMAIL_CAPTURE_ENABLED` (default false), `EMAIL_CAPTURE_DOMAIN`, `EMAIL_INGEST_SECRET` (at least 32 characters). Capture is available only when all three are set.

## 4. Failure and degradation

- The relay treats 200 with `x-omr-email-result: accepted` as done and 400, 403 or 413 with `rejected` as a permanent SMTP reject; any other answer (a busy 503, a DNS failure) throws so Cloudflare retries.

## 5. Known gaps and unverified facts

- `EMAIL_INGEST_SECRET` is supplied by the deployment; `packages/email-worker/README.md` says how the relay receives the same value.
- `EMAIL_CAPTURE_DOMAIN` is declared optional but the code treats unset as unavailable.
- The Cloudflare routing rule, MX records and the replica count are outside the repository.

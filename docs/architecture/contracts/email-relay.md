# Contract: Email relay (signed raw message ingress)

Status: Draft · Version 1.0 · Owner (OMR side): M13 Email capture and reader · Owner (other side): M14 Email relay · Provider ref verified against: `routes/inbound-email.ts` and `packages/email-worker/src/signing.mjs` at `2c4905d`

## 1. Scope

`POST /hooks/email-capture/raw`: the relay streams the original MIME bytes with a signature; the API verifies, authenticates the sender and creates the blip.

## 2. Auth

HMAC-SHA256 with `EMAIL_INGEST_SECRET` over `timestamp, nonce, recipient, rawSize`, verified in constant time before the body is read; timestamp within 300 seconds; the nonce is recorded in a memory cache of 10,000 entries.

## 3. Operations

| Operation     | Shape                                        | Effect         | Notes                                                                                                            |
| ------------- | -------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Ingest        | `POST /hooks/email-capture/raw`              | creates a blip | Headers `x-omr-timestamp`, `x-omr-nonce`, `x-omr-recipient`, `x-omr-raw-size` and `x-omr-signature`              |
| Result header | `x-omr-email-result: accepted` or `rejected` | —              | 200 accepted; 400, 403 or 413 with `rejected` is a permanent SMTP reject; anything else is retried by Cloudflare |

## 4. Errors and refusals

- 403 for a sender not permitted for the target; 413 for over 10 MiB; 503 when 2 messages are already in flight.

## 5. Idempotency, versioning and limits

- The receipt id is a SHA-256 of the recipient and the verified DKIM signature value, and is inserted idempotently; abandoned receipts are cleaned after 1 day and completed ones after 90 days. The replay cache assumes one API replica.

## 6. Known gaps and unverified facts

- Any other path under `/hooks/email-capture` is 404 so an old path cannot fall through to the generic webhook route.

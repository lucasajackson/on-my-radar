# Contract: Resend (transactional email)

Status: Draft · Version 1.0 · Owner (OMR side): M10 Notifications and push · Owner (other side): Resend (third party) · Provider ref verified against: `services/mail.ts` at `2c4905d`

## 1. Scope

Outbound transactional mail: sign-in codes (sent directly), waitlist and approval mail, radar and topic share invitations (queued as outbox `email` jobs) and notification email (sent from the `notification` handler).

## 2. Auth

`Authorization: Bearer RESEND_API_KEY` to `POST https://api.resend.com/emails`, 15 second timeout, sender `MAIL_FROM` (default `On My Radar <hello@onmyradar.io>`).

## 3. Operations

| Operation | Shape          | Effect       | Notes                                                                                                                         |
| --------- | -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Send      | `POST /emails` | irreversible | Queued mail carries `outbox-email/<jobId>` as the idempotency key; notification email has none and is guarded by `emailed_at` |

## 4. Errors and refusals

- Without a key, `sendMail` throws `MailError` in production and elsewhere logs a warning and skips; notification email is skipped before `sendMail` when mail is not configured. Recipients with a closure record are refused. A queued job retries with the outbox backoff.

## 5. Idempotency, versioning and limits

- `emailed_at` is stamped only after Resend accepts; it does not prove a person saw the message.

## 6. Known gaps and unverified facts

- Delivery to a person's inbox was confirmed in production on 2026-09-19 (`docs/ARCHITECTURE.md`); no later check was made.

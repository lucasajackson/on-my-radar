# Contract: Browser push services (Web Push with VAPID)

Status: Draft · Version 1.0 · Owner (OMR side): M10 Notifications and push · Owner (other side): Browser push services (the endpoint each browser registered) · Provider ref verified against: `services/push.ts` at `2c4905d` (RFC 8291, 8188, 8292, hand-written)

## 1. Scope

Web Push to browsers that registered a subscription: `aes128gcm` payload encryption and a VAPID JWT, with Node crypto and no library.

## 2. Auth

`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (optional), subject `VAPID_SUBJECT` (default `mailto:hello@onmyradar.io`). The subscriber's endpoint is fetched through `publicRequest`: https only, no redirects, 10 second timeout.

## 3. Operations

| Operation | Shape                        | Effect       | Notes                                                                                                                               |
| --------- | ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Send      | `POST <subscriber endpoint>` | irreversible | Subscriptions are bound to a session; the service worker re-checks the recipient against `/api/auth/session` before showing details |

## 4. Errors and refusals

- 404 and 410 delete the subscription. An unsafe endpoint is treated as invalid. Without keys, web push is reported unavailable.

## 5. Idempotency, versioning and limits

- Registration is human-only and limited to 120 per session per hour.

## 6. Known gaps and unverified facts

- Whether production holds VAPID keys is not knowable here; the push secret is `onmyradar-push` in the chart.

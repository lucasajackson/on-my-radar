# Contract: APNs (Apple Push Notification service)

Status: Draft · Version 1.0 · Owner (OMR side): M10 Notifications and push · Owner (other side): APNs (Apple, third party) · Provider ref verified against: `services/apns.ts` at `2c4905d`

## 1. Scope

Alert pushes to registered iOS devices, one environment (sandbox or production) per device row.

## 2. Auth

An ES256 provider JWT (`kid` and `iss` from the environment's key id and the team id) cached for 50 minutes, over HTTP/2 to `api.push.apple.com` or `api.sandbox.push.apple.com`. Keys: `APNS_PRODUCTION_KEY_ID` with `APNS_PRODUCTION_PRIVATE_KEY`, `APNS_SANDBOX_KEY_ID` with `APNS_SANDBOX_PRIVATE_KEY`, and `APNS_TEAM_ID`; a half-configured pair fails startup.

## 3. Operations

| Operation  | Shape                    | Effect       | Notes                                                                                                                                                      |
| ---------- | ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send alert | `POST /3/device/<token>` | irreversible | `apns-topic` is `APNS_BUNDLE_ID` (default `io.onmyradar.app`), push type `alert`, priority 10, a collapse id and an expiration; payload at most 4096 bytes |

## 4. Errors and refusals

- `Unregistered` (HTTP 410) and `BadDeviceToken` (HTTP 400) cancel the receipt and delete the device row, unless Apple's timestamp predates the registration. When keys are absent, registration answers 400 and `GET /api/notifications/settings` reports the environment unavailable.

## 5. Idempotency, versioning and limits

- Delivery is per device with a receipt keyed `(notification_id, destination_kind, destination_id, generation)`; the payload is rebuilt at send time after rechecking the session and preference.

## 6. Known gaps and unverified facts

- Whether production holds APNs keys is not knowable from this repository, and delivery to a physical device is recorded as unverified in `docs/NATIVE-PUSH-PLAN.md`.

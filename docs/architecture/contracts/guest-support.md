# Contract: Guest support visitors (capability API)

Status: Draft · Version 1.0 · Owner (OMR side): M19 Support intake · Owner (other side): Guest support visitors (signed-out people using a capability token) · Provider ref verified against: `routes/guest-support.ts` and `services/guest-support.ts` at `2c4905d`

## 1. Scope

A signed-out visitor starts or recovers one conversation with the operator's support team and reads and replies to it. Signed-in people use `/api/support` instead.

## 2. Auth

A capability token and a recovery code, each stored as a SHA-256 hash, expiry at most 720 hours. The actor kind is `guest`, which `getRadarAccess` refuses; it reaches only `requireGuestSupportQueue`.

## 3. Operations

| Operation      | Shape                                                                           | Effect               | Notes                                                                                                      |
| -------------- | ------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Start, recover | `POST /api/guest-support/start`, `/recover`                                     | creates a capability | Per-network, global and per-token fixed windows; the capability is probed before shared limits are charged |
| Conversation   | `GET\|POST /conversation`, `POST /conversation/replies`, `/conversation/revoke` | read and write       | One conversation only                                                                                      |
| Staff revoke   | `POST /requests/:id/revoke`                                                     | destructive          | Only the human session of `SUPPORT_OWNER_ID`; other admins and agents get 404                              |

## 4. Errors and refusals

- 503 `support_unavailable` unless `SUPPORT_RADAR_ID` and `SUPPORT_OWNER_ID` point to a private standard helpdesk radar owned by an active admin.

## 5. Idempotency, versioning and limits

- Responses are `no-store`.

## 6. Known gaps and unverified facts

- Launch gates are listed in `docs/SUPPORT.md` and are not restated here.

# Component: M19 Support intake

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Two ways to reach the same private helpdesk queue: native support from a signed-in person, and guest support from a signed-out visitor holding a capability token. Both write into the radar named by `SUPPORT_RADAR_ID`, owned by the admin named by `SUPPORT_OWNER_ID`.

**Depends on:** M18 (the helpdesk projection and queue), M3 (the doors `requireNativeSupport` and `requireGuestSupportQueue`), M16, M5.

**Used by:** The UI support pages; staff in the queue.

**Invariants (and what enforces each):**

- Both are available only when the two ids point to a private, standard, `helpdesk` radar owned by an active admin; otherwise 503 `support_unavailable` (`services/access.ts`).
- Native support is session-bound: only `active` users post, pending users can read an empty list, and requester provenance is immutable (`services/support.ts`; `support.test.ts`).
- A guest capability token and recovery code are stored only as SHA-256 hashes (expiry at most 720 hours by CHECK); the capability is probed before shared limits are charged, and limits are fixed windows per network, globally and per token (`services/guest-support.ts`; `guest-support.test.ts`).
- A guest can read and write one conversation and nothing else; the reply path is the staff review in M18.

## 2. Owned data

| Owned                                           | Kind  | Notes                           |
| ----------------------------------------------- | ----- | ------------------------------- |
| `guest_support_capabilities`                    | table |                                 |
| `guest_support_limits`                          | table |                                 |
| `guest_support_operations`                      | table |                                 |
| `support_operations`                            | table |                                 |
| `packages/server/src/services/support.ts`       | file  | Native support                  |
| `packages/server/src/services/guest-support.ts` | file  | Guest support                   |
| `packages/server/src/routes/support.ts`         | file  | Mounted at `/api/support`       |
| `packages/server/src/routes/guest-support.ts`   | file  | Mounted at `/api/guest-support` |
| `packages/contract/src/support.ts`              | file  | Support DTOs                    |

## 3. Interface

- **Routes:** `/api/support`: list, create, get, reply. `/api/guest-support`: `/start`, `/recover`, `GET|POST /conversation`, `/conversation/replies`, `/conversation/revoke`, `/requests/:id/revoke` (staff).
- **MCP tools:** none.
- **Configuration:** `SUPPORT_RADAR_ID`, `SUPPORT_OWNER_ID` (optional UUIDs).

## 4. Failure and degradation

- Without the two ids both doors answer 503.

## 5. Known gaps and unverified facts

- `docs/SUPPORT.md` was read only for its headings; the launch gates it lists are not restated.

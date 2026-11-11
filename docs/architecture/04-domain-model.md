# 04 · Domain model

Status: Draft · Version 0.1

## Entities

| Entity             | Table                             | Identity and the rules the schema holds                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User               | `users`                           | `state` is `pending`, `active` or `suspended` (CHECK `users_state_check`). Only `active` accounts receive notifications or mentions, or authenticate by bearer token. A session cookie resolves for any non-closed account with an unexpired row, `pending` and `suspended` included (`resolveSession`); `requireActor` then answers 403 `awaiting_approval` or "suspended", and `liveActor` downgrades to anonymous. |
| Session            | `sessions`                        | Unique `token_hash`; `client` is `web`, `ios`, `android` or `cli`. Non-web sessions slide their expiry.                                                                                                                                                                                                                                                                                                               |
| Credential         | `api_tokens`, `oauth_tokens`      | Stored as hashes. Scope is `radars:read`, `radars:write`, `radars:manage`; an unknown scope string authenticates nothing.                                                                                                                                                                                                                                                                                             |
| Radar              | `radars`                          | `kind` is `standard` or `smart`; `template` is one of eight registry ids with no SQL constraint; `visibility` is `private` or `public`. CHECKs: a drop box, a smart radar, a helpdesk and a once-client-facing radar are never public.                                                                                                                                                                                |
| Membership         | `radar_members`, `topic_members`  | Radar role is `viewer`, `editor` or `owner`; a topic role is `viewer` or `editor`. A topic cascade can never confer owner.                                                                                                                                                                                                                                                                                            |
| Topic              | `topics`                          | A named group of radars; unique `(owner_id, slug)`. The cascade switch defaults off.                                                                                                                                                                                                                                                                                                                                  |
| Blip               | `blips`                           | `kind` is one of `note`, `link`, `image`, `file`, `essay`, `quote`, `task`; `state` is `inbox`, `active`, `later`, `done` or `dropped`; `status` is a lane id (no SQL constraint). `supersedes_id` cannot point at itself.                                                                                                                                                                                            |
| Comment            | `blip_comments`                   | One level of threading, enforced by re-parenting in the service. `visibility` is `internal`, `client_pending` or `client`; a released comment's body cannot change (CHECK `blip_comments_released_body_unchanged` against the stored hash).                                                                                                                                                                           |
| Mention            | `mentions`                        | Exactly one source (blip or comment) and exactly one target (user or agent), by CHECK.                                                                                                                                                                                                                                                                                                                                |
| Agent              | `agents`, `agent_*`               | An identity owned by a person: a slug, a versioned prompt (one live row), memories, profiles, briefs. Writes carry `agent_id` and `agent_voice` (`persona` or `principal`).                                                                                                                                                                                                                                           |
| Boundary, contract | `blip_elements`, `blip_relations` | Blips in the `boundary` and `contract` lanes of an Architecture radar. A contract has two `seam_side` relations; an ADR has `amends` relations. A boundary with seams cannot be deleted (NO ACTION foreign key).                                                                                                                                                                                                      |
| Notification       | `notifications`                   | One open row per `(user_id, group_key)` while unread (partial unique index); eleven kinds.                                                                                                                                                                                                                                                                                                                            |
| Job                | `outbox`                          | A kind, a payload, `run_after`, `attempts`; six kinds today (`unfurl`, `object-cleanup`, `notification`, `notification-event`, `push`, `email`).                                                                                                                                                                                                                                                                      |

## State machines

### Account

`pending` → `active` only through `activateUser` (guarded by `WHERE state = 'pending'`), called for an admin approval, an admin sharing with a waitlisted person, or open signup (`admitOnOpenSignup` when `SIGNUP_MODE=open`). An account can also be created already `active` (`AUTO_APPROVE_EMAILS`, or an invite from a currently active admin); these decide the initial state only, and an existing pending account is not changed by them. An admin can suspend a `pending` or `active` account and reinstate a `suspended` one to `active` (`/api/admin/users/:id`), so a suspended-then-reinstated pending account becomes active without an approval step. Suspension revokes every session at that moment and stops bearer tokens and webhooks; a suspended person can still sign in again to be told so, but cannot act (`requireActor` refuses), and re-authenticating never un-suspends. It does not by itself hide the person's radars from others.

### Blip: two axes

`state` is the universal triage axis. `status` is the lane of the radar's template; landing in a lane sets `state` from the lane, and setting only `state` repairs a contradicting lane. An unknown lane is a 400 (`assertLane`). A blip that is `done` or `dropped` on an archiving template (`kanban`, `reading`, `helpdesk`) is **archived** once its last activity is older than the radar's window (default 30 days; 0 means never). Archive is computed in `archivedExpr`, never stored, so new activity resurrects the blip.

### ADR on an Architecture radar

```
proposed ──► accepted ──► repealed
   │
   └──────► rejected
```

Only these moves are allowed (`transitions` in the `architecture` template); any other move is a 409 `lane_move_refused`. `blips.ratified_at` is stamped on first entry into `accepted` and never changes. An ADR that supersedes another leaves the old one in place until it is itself accepted, then files it into `repealed`. The `boundary` and `contract` lanes take no capture and no manual move.

### Comment visibility

Visibility is set at creation and an `internal` comment is never promoted. For comments written by a person or agent, `client` is reached only when the owner in person writes it, or by owner release of a `client_pending` comment (a human session; the request must carry the SHA-256 of the body it saw). A non-owner who asks for `client` produces `client_pending`, which nobody can request directly. The portal's replies skip this: `createHelpdeskReply` inserts `client` at once with an external author. SQL checks tie `client` to a release record or an external author.

### Outbox job

A job is claimed by setting `run_after = now() + 300 seconds` and `attempts = attempts + 1`. Success deletes the row; failure reschedules with `min(30·2^(attempts−1), 3600)` seconds; the eighth failed attempt parks the row at `9999-12-31` with its error. The worker's sweep deletes parked rows 30 days after the job was created, and dead-letters a kind no running process knows 24 hours after creation (without a worker neither happens).

### Subscription delivery

Up to six attempts at 60 s, 300 s, 1800 s, 7200 s and 10800 s. Exhaustion disables the subscription, deletes its pending rows and creates a `subscription_failed` notification. Integration deliveries use the same schedule but pause and keep their rows instead.

### Email receipt

A receipt row is inserted idempotently (id is the message hash), its objects are written to storage, and `finalizeEmailDelivery` creates the blip, writes `blip_emails` and scrubs the receipt. Abandoned receipts are cleaned after one day; completed receipts after 90 days.

## Who may cause each transition

| Transition                          | Who                                                    | Where it is decided                                                  |
| ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Account approve, suspend, reinstate | An admin, in a browser session                         | `routes/admin.ts`, `auth/accounts.ts`                                |
| Mint, rotate or revoke a credential | A signed-in person                                     | `assertHumanDecision` in `services/tokens.ts`                        |
| Decide an ADR                       | Anyone with write access to the radar, agents included | `decideAdr` (`write` need) over `updateBlip`; `architecture.test.ts` |
| Release a client comment            | The radar owner, in a browser session                  | `releaseComment` in `services/comments.ts`                           |
| Resume a failed subscription        | A person                                               | `services/subscriptions.ts` (`assertHumanDecision`)                  |

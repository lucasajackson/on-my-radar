# Component: M3 Access, sharing and audit

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The single authorization function and what feeds it: radar and topic membership, invitations, topic cascade, and the audit log. `services/access.ts` decides every read and write to a radar for every kind of caller, applies the credential ceiling once, and answers 404 for a radar the caller may not read. It also owns the rule that a human decision cannot be taken by a non-human.

**Depends on:** M2 (the ceiling comes from the credential), M4 (radar rows), M20 (`omr_account_open`).

**Used by:** Every other service that touches a radar, a blip or a comment; M8 and M9 (`readableRadarIds`); M10 (`radarReaders`).

**Invariants (and what enforces each):**

- A radar the caller cannot read is a 404, never a 403, from `requireRadar` and `requireTopic`. The deliberate 403s are `listMembers` (in `services/radars.ts`) and `requireParticipation` for a caller holding only a public link (`services/access.ts`; `public-link.test.ts`).
- Effective role is `min(ceiling, strongest(owner, direct member, cascading topic role))`; the clamp is the tail of `computeRadarAccess`, with `clampRole` reused in `listRadars` and the ceiling also applied by `requireScope` and `canParticipate` (`services/scopes.test.ts`).
- The topic cascade is computed at authorization time and never stored; it maps viewer to viewer and editor to editor and can never confer owner (`CASCADE_GRANTS` in `packages/contract/src/domain.ts`; `services/topics.test.ts`).
- A public link grants read only when it is the identifier used, never on a client-facing radar (`viaPublicLink`, `neverPublic`). Redaction of member emails and owner ids is decided from `role === null` in `services/redaction.ts`.
- `assertHumanDecision` passes only for `actor.kind === 'user'` and is called from about 65 sites across the services; the rule is on the shared service path, not the tool router (`services/agent-boundary.test.ts`).
- An invite token carries navigation only: `base64url(JSON).HMAC` in its own HMAC domain. The waitlist bypass is derived live from a currently active admin inviter at the moment an initial state is decided; an agent cannot invite an address with no account (`services/invites.ts`, `invites.test.ts`).
- `recordAudit` never fails the caller: a failure is logged and the record lost, and inside a transaction it uses a savepoint (`services/audit.ts`).
- `Actor.kind` is one of `user`, `agent`, `webhook`, `integration` or `guest`; integration and guest actors are refused by `getRadarAccess` and reach only their own doors (`requireHelpdeskRadar` for integrations and `requireGuestSupportQueue` for guests; native support, `requireNativeSupport`, is for signed-in `user` actors).

## 2. Owned data

| Owned                                       | Kind  | Notes                                                       |
| ------------------------------------------- | ----- | ----------------------------------------------------------- |
| `radar_members`                             | table |                                                             |
| `radar_invites`                             | table |                                                             |
| `topics`                                    | table |                                                             |
| `topic_members`                             | table |                                                             |
| `topic_invites`                             | table |                                                             |
| `audit_log`                                 | table |                                                             |
| `packages/server/src/services/access.ts`    | file  | Authorization, ceiling clamp, human-only fence, reader sets |
| `packages/server/src/services/topics.ts`    | file  | Topic CRUD, members, cascade switch                         |
| `packages/server/src/services/invites.ts`   | file  | Share-by-email invitations and the bypass                   |
| `packages/server/src/services/audit.ts`     | file  | `recordAudit`                                               |
| `packages/server/src/services/redaction.ts` | file  | Narrowing for callers without a role                        |
| `packages/server/src/http.ts`               | file  | The `Actor` type, `requireUser`, `requireAdmin`             |
| `packages/server/src/routes/topics.ts`      | file  | Mounted at `/api/topics`                                    |
| `packages/server/src/routes/invites.ts`     | file  | Mounted at `/api/invites` (unauthenticated preview)         |

## 3. Interface

- **Routes:** `/api/topics`, also mounted as `/api/arrays` (list, create, get, patch, delete, `PUT /:id/cascade`, members, invites); `GET /api/invites/:token` (one 404 for every failure). Radar membership routes live in `routes/radars.ts` (M4).
- **MCP tools:** `list_arrays`, `read_array`, `create_array`, `update_array`, `delete_array`, `set_radar_array`, `share_array`, `list_array_members`, `remove_array_member`, `share_radar`, `list_radar_members`, `remove_radar_member` (with `email`, cancels a pending invite), `whoami`. The cascade switch is not a tool.
- **Configuration:** none of its own.

## 4. Failure and degradation

- A radar whose owner has an account-closure record, or a caller who does, resolves to no access (`omr_account_open` on both, in the row query behind `getRadarAccess`). That fence tests closure records only; no application code creates one (ADR-0019).
- Admin suspension is a different mechanism (`users.state = 'suspended'` plus revoked sessions). It stops the suspended person's own sessions, bearer tokens and webhooks, but `getRadarAccess` does not read `users.state`, so a suspended owner's radars stay readable to members and public links. Notification and mention audiences do exclude non-active accounts (`radarReaders`).

## 5. Known gaps and unverified facts

- `docs/ARCHITECTURE.md` lists two actor kinds and says webhooks have none; the code has five.

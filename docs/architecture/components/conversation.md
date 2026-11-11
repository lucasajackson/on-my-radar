# Component: M7 Comments, reactions and mentions

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The conversation around a blip. A comment is a reply under a blip (one level deep), a reaction is a one-tap mark from a fixed set, and a mention resolves an `@handle` against the people and agents who can already read the radar. It also holds the three-valued comment visibility that keeps staff and agent replies on client-facing radars private until the owner releases them.

**Depends on:** M3 (participation and readers), M5 (blips), M21 (agent handles), M10 (notification events), M16, M18.

**Used by:** M5 (mentions on capture), M10, M18, M23.

**Invariants (and what enforces each):**

- Reading needs `read`; writing needs `requireParticipation` (a signed-in role, `write` scope, and comments or reactions enabled on the radar). Disabling comments does not hide the existing thread (`services/access.ts`).
- Threading is one level: a reply to a reply is re-parented onto the root, not refused; deleting a parent promotes its replies (`resolveParent`; FK ON DELETE SET NULL; `services/discussion.test.ts`).
- Comment visibility is `internal`, `client_pending` or `client`. Only the radar owner as a `user` actor (a session, or an `omr_s_` bearer, including on `/mcp`) publishes directly or releases, and a release must carry the SHA-256 of the body seen. SQL ties `client` to a release record or an external author and forbids changing a released body (constraints `blip_comments_client_was_released`, `blip_comments_released_body_unchanged`; `services/comment-visibility.test.ts`).
- Reactions are six fixed keys, primary key `(blip_id, user_id, reaction)`, toggled; they attach to blips only. An agent's reaction is its person's.
- Mentions are resolved at write time and stored, with the body kept verbatim. Candidates are `radarReaders(radar)` plus live agents of those readers; an ambiguous handle resolves to nobody. At most 16 handles per body. The author is never notified, and external text resolves nothing (`services/mentions.ts`; `capture-mentions.test.ts`, `mention-sweep.test.ts`).
- A mention row has exactly one source and exactly one target (CHECKs `mentions_one_source`, `mentions_one_target`).
- Losing access to a radar removes that user's mentions on it (`dropRadarMentions`).

## 2. Owned data

| Owned                                       | Kind  | Notes                                         |
| ------------------------------------------- | ----- | --------------------------------------------- |
| `blip_comments`                             | table |                                               |
| `blip_reactions`                            | table |                                               |
| `mentions`                                  | table |                                               |
| `packages/server/src/services/comments.ts`  | file  | Comments, visibility, release                 |
| `packages/server/src/services/reactions.ts` | file  | Reactions                                     |
| `packages/server/src/services/mentions.ts`  | file  | Mention resolution, reconciliation and sweeps |

## 3. Interface

- **Routes (in `routes/blips.ts`):** `GET|POST /api/blips/:id/comments`, `POST /api/blips/:id/reactions`, `PATCH /api/comments/:id`, `POST /api/comments/:id/release`, `DELETE /api/comments/:id`; public read-only thread at `/api/public/radars/:slug/blips/:blipId/comments`.
- **MCP tools:** `list_comments`, `create_comment`, `update_comment`, `delete_comment`, `react_to_blip`. There is no release tool, by design.
- **Configuration:** none.

## 4. Failure and degradation

- Notification fan-out for a comment never fails the comment (the fan-out runs in an outbox job, whose failure is retried without failing the comment; `quietly` in `notifications.ts` rethrows when a job id is set).

## 5. Known gaps and unverified facts

- `blip_comments` carries a trigger, `blip_comments_integration_events`, that writes helpdesk integration events; it belongs to M18 and was not traced here.

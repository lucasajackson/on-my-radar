# Component: M5 Blips and capture

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The blip itself and the one-box capture that makes it cheaper than the thought. Capture infers kind, title, URL and tags from the entered text; a blip carries two axes (a universal `state` and the template's `status` lane); one blip can replace another; a person can set a personal reminder; a radar can accept posts through a capture webhook; and a captured link gets a preview. Every other component that creates content calls `createBlip` here.

**Depends on:** M3 (access), M4 (templates, lanes, drop box), M7 (mentions on capture), M11 (outbox for unfurl and cleanup), M12 (attachments), M16 (events at commit), M25 (inference functions).

**Used by:** M6, M13, M15, M18, M19, M7, M8, M9, M23. Not every creator goes through `createBlip`: `ensureDefaultWorkspace` inserts the welcome blip directly.

**Invariants (and what enforces each):**

- Kind is derived by `deriveBlipKind` unless the caller passes one: attachments win (`image` if all images, else `file`), a bare URL is `link` (on reading-list templates the first URL in a longer body also makes a link), a body over 600 characters is `essay`, otherwise `note`; `quote` and `task` are never inferred (`packages/contract/src/domain.ts`, CHECK `blips_kind_check`; `capture.test.ts`).
- A title is inferred only from a Markdown heading on the first line that fits 300 characters, and a caller may also pass one; tags are inline hashtags plus explicit ones, at most 24 per blip for authored text (`services/blip-tags.test.ts`).
- `state` is CHECK-constrained to inbox, active, later, done, dropped; `status` is a lane id validated by `assertLane`. Landing in a lane carries its state; setting only `state` repairs a contradicting lane (`services/blips.ts`; `src/templates.test.ts`).
- A blip is capped at `LIMITS.blipBody` (100,000 characters) and `updateBlip` has no revision guard: concurrent body edits are last-write-wins.
- Supersession files the replaced blip at link time, within one radar, and `supersedes_id` cannot point at itself (`blips_supersedes_not_self`; `checkSupersedes`). On a template with a ratified lane the filing is deferred until the replacement is accepted.
- A smart radar accepts no capture, and the drop box is private by CHECK (`services/smart-radars.test.ts`, `services/drop-box.test.ts`).
- Text from outside (webhook, email, feed) is `authored: false`: it resolves no mentions and keeps only its first 24 tags silently (`isExternalDelivery`).
- A capture webhook token is `omr_hook_…`, stored hashed, with a 60 per minute limit as one atomic `UPDATE`, a 64 KiB body cap, and 404 for both an unknown id and a wrong token (`services/webhooks.ts`; `services/webhooks.test.ts`, with `routes/hooks.test.ts` for body parsing and the cap).
- A link preview is fetched through the shared SSRF transport after commit via an `unfurl` outbox job (at least once, and re-queued when the URL is edited) and written only where the URL is unchanged (`services/unfurl.ts`; `unfurl.test.ts` tests the fetch, not the job).
- A reminder is `(blip, user)` with lead 0, 60 or 1440 minutes, set only by a person's session; the sweep skips one more than an hour overdue (`services/reminders.ts`; no test asserts that skip).

## 2. Owned data

| Owned                                       | Kind  | Notes                                                                                  |
| ------------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| `blips`                                     | table |                                                                                        |
| `blip_reminders`                            | table |                                                                                        |
| `radar_webhooks`                            | table |                                                                                        |
| `packages/server/src/services/blips.ts`     | file  | `createBlip`, `updateBlip`, `deleteBlip`, listing, supersession, filters               |
| `packages/server/src/services/webhooks.ts`  | file  | Capture webhooks                                                                       |
| `packages/server/src/services/reminders.ts` | file  | Personal reminders and the due sweep                                                   |
| `packages/server/src/services/unfurl.ts`    | file  | Link previews                                                                          |
| `packages/server/src/services/cursor.ts`    | file  | Keyset cursors                                                                         |
| `packages/server/src/routes/blips.ts`       | file  | Mounted at `/api/blips`; also hosts the comment, reaction, attachment and trace routes |
| `packages/server/src/routes/hooks.ts`       | file  | Mounted at `/hooks` (unauthenticated, token in the URL)                                |
| `packages/contract/src/text.ts`             | file  | Tag, mention, title and byline functions                                               |

## 3. Interface

- **Routes:** `PATCH|DELETE /api/blips/:id`, `GET|PUT|DELETE /api/blips/:id/reminder`, `POST /api/radars/:id/blips`, webhook admin at `/api/webhooks/:id` and `POST /api/radars/:id/webhooks`, and the ingest `POST|PUT /hooks/:id/:token` (a `GET` answers 200 and captures nothing).
- **MCP tools:** `create_blip`, `update_blip`, `delete_blip`, `get_blip`, `read_drop_box`, `list_tags`, `list_webhooks`, `create_webhook`, `update_webhook`, `rotate_webhook_secret`, `delete_webhook`. There is no tool to set a reminder.
- **Configuration:** `HTTP_BODY_LIMIT_BYTES` (default 2 MiB).

## 4. Failure and degradation

- Link preview failure leaves the blip without a preview; the blip is never blocked by it.
- Capture into a closed account is refused. Feeds and email capture refuse an archived radar; direct capture (composer, MCP, webhook) does not.

## 5. Known gaps and unverified facts

- Older briefs say `unfurl.ts` is the only outbound fetch of a user URL; the shared transport has five callers (principle P10).
- The logger's redaction of the webhook token in access paths is claimed in a `hooks.ts` comment; `logger.ts` has a `scrubPath`, but the end-to-end behaviour was not traced.

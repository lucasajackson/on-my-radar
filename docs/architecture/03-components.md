# 03 · Components

Status: Draft · Version 0.1

A component is a **boundary**: the thing that owns a set of tables, modules and routes and is the only writer of its tables. The boundaries below are not separate processes. The deployable units are three (the API, the UI and the worker; see `components/release-deploy.md`) plus the Cloudflare email relay and the separately built iOS app. The boundaries are the rule for who may write what.

## Layers and allowed dependencies

```
 clients      M26 Web UI   M27 iOS client   M23 MCP server   (AI agents)   (webhook senders)
                 │              │               │
 transport    M24 API edge (Hono: routes/, middleware, errors)  ·  M11 worker loops
                 │                                                   │
 services     M3 … M22  (packages/server/src/services, one module per boundary)
                 │
 data         PostgreSQL (one primary) · object storage
 shared       M25 contract package: imported by clients, transport and services
```

Rules, each checked or checkable:

1. **Services import neither routes, MCP modules nor Hono.** A grep over `services/*.ts` finds none directly (they import `ApiError` from `src/http.ts`, which extends Hono's `HTTPException`); no lint rule or test enforces it. Transport code adapts input to a service call and an `ApiError` back to a response.
2. **Every access decision goes through `services/access.ts` (M3).** Other services call `requireRadar`, `getRadarAccess`, `requireParticipation`, `readableRadarIds` or `assertHumanDecision`; none re-derives membership for an access decision, though a few queries read `topic_members` directly (repo agents, notifications).
3. **A table has one owner, not always one writer.** The "Owned data" table of each component names the tables it owns. Other components read them or call the owner's service function, with these real exceptions found by grepping `insert`, `update` and `delete` calls: `blips` is written by `createBlip`, `updateBlip` and `deleteBlip` in `services/blips.ts` (plus its supersession helpers), by the architecture rewrite and `anchorAdr` in `services/architecture.ts`, by the helpdesk, native support and guest support reply paths (`createHelpdeskReply`, `replySupport`, `replyGuestSupport`, which move a waiting or resolved request blip back to its in-progress lane), by the link-preview handler (`blips.preview`) and by `ensureDefaultWorkspace` in `auth/accounts.ts` (the first-run welcome blip); `blip_comments` is written by `services/comments.ts` and by those same three reply paths; `notifications`, `users`, `radars`, `radar_members` and a few others are written from several modules. `audit_log` and `outbox` are written mostly through `recordAudit` and `enqueue`, with a few direct inserts (billing, plan catalog, comment release) and, for `outbox`, updates and deletes by its own sweep and by the notification service; neither has an append-only trigger.
4. **Every REST route is classified for MCP** in `mcp/capabilities.ts`: an MCP tool, or a stated reason it is human-only or transport-specific. `mcp/coverage.test.ts` fails on an unclassified route.
5. **The contract package depends on nothing in this repository** (its one runtime dependency is `zod`). Everything else may import it.
6. **The worker and the API run the same code.** The worker is the same image started with different arguments; it registers the same job handlers, so a job kind exists in both or neither.

## The components

| Code | Component                        | Owns (summary)                                                                        | File                                   |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| M1   | Identity and sessions            | Accounts, email-code login, SSO, sessions, signup and the waitlist                    | `components/identity-sessions.md`      |
| M2   | Credentials and OAuth            | Personal access tokens and the OAuth authorization server                             | `components/credentials-oauth.md`      |
| M3   | Access, sharing and audit        | The single authorization function, radar and topic membership, invites, the audit log | `components/access-sharing.md`         |
| M4   | Radars and templates             | Radars, the template registry, lanes, smart radars, themes, public pages              | `components/radars-templates.md`       |
| M5   | Blips and capture                | Blips, the capture box, reminders, inbound webhooks, link previews                    | `components/blips-capture.md`          |
| M6   | Architecture radar               | Charter, ADR lanes, amendment markers, boundaries, contracts, trace                   | `components/architecture.md`           |
| M7   | Comments, reactions and mentions | The conversation around a blip                                                        | `components/conversation.md`           |
| M8   | Search                           | The query grammar and the full-text search over readable radars                       | `components/search.md`                 |
| M9   | Dashboards                       | Per-user tabs of radar and query widgets                                              | `components/dashboards.md`             |
| M10  | Notifications and push           | Notification rows, preferences, email notices, Web Push and APNs                      | `components/notifications-push.md`     |
| M11  | Outbox and worker                | The job queue and the worker process                                                  | `components/outbox-worker.md`          |
| M12  | Storage and attachments          | Presigned upload and download, attachment authorization, object cleanup               | `components/storage.md`                |
| M13  | Email capture and reader         | Inbound mail to blips, and the sanitised email reader                                 | `components/email-capture.md`          |
| M14  | Email relay                      | The Cloudflare Worker that forwards raw mail                                          | `components/email-relay.md`            |
| M15  | RSS feeds                        | Subscribed feeds polled into radars                                                   | `components/rss-feeds.md`              |
| M16  | Outbound subscriptions           | Signed event delivery to a radar owner's receiver                                     | `components/outbound-subscriptions.md` |
| M18  | Helpdesk and integrations        | The client-facing request projection and its signed events                            | `components/helpdesk-integrations.md`  |
| M19  | Support intake                   | Signed-in native support and signed-out guest support                                 | `components/support-intake.md`         |
| M20  | Account data                     | Account export and the account-closure fence                                          | `components/account-data.md`           |
| M21  | Agents                           | Agent identity, prompts, memories, profiles, sharing, checkout                        | `components/agent-repo.md`             |
| M22  | Agent briefs                     | Briefs, their revisions, and the GitLab binding                                       | `components/agent-briefs.md`           |
| M23  | MCP server                       | The MCP transport, tool registration, plan admission, result shaping                  | `components/mcp-server.md`             |
| M24  | API edge                         | The Hono app, middleware, the error envelope, configuration, the database client      | `components/api-edge.md`               |
| M25  | Contract package                 | The shared vocabulary and the snapshot                                                | `components/contract-package.md`       |
| M26  | Web UI                           | The SPA, its nginx image, the service worker, the browser verification suite          | `components/web-ui.md`                 |
| M27  | iOS client                       | The native app, in its own repository                                                 | `components/ios-client.md`             |
| M28  | Release and deploy               | Dockerfile, CI, the release pipeline, the chart and secrets it expects                | `components/release-deploy.md`         |

## What the 27 are not

- There is no separate service for any of them, and no network hop inside an access decision (`docs/SCALE.md` section 2 refuses that split by name).
- Support, helpdesk and the Architecture radar share the blip, radar and comment tables of M4, M5 and M7. They do not own parallel copies; they add tables that reference those rows.
- The marketing site (`onmyradar-site`) is a different project on the same hostname. It is external here.

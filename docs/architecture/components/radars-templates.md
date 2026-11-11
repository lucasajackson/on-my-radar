# Component: M4 Radars and templates

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Creates, updates and deletes radars and decides what kind of radar each is. It owns the template registry (eight templates declaring lanes, ordering and capabilities), custom lanes, smart radars (saved filters resolved against the caller), themes, the archive window, visibility and the public radar pages, the drop box, and the rules for changing a radar's template.

**Depends on:** M3 (access), M5 (stranded-blip check, `archivedExpr`), M25 (the registry lives in the contract package).

**Used by:** M5, M6, M7, M9, M16, M18, the UI.

**Invariants (and what enforces each):**

- `radars.template` has no SQL constraint; the registry `RADAR_TEMPLATES` in `packages/contract/src/templates.ts` is the vocabulary, and services mostly read its typed capability fields (`ratifiedLane`, `laneMoveAllowed`, `statusesFor`) rather than branching on an id, though a few name `architecture` or `helpdesk` directly; `src/templates.test.ts` checks the registry's shape only.
- Changing a template or lanes serialises with writes: `updateRadar` takes `pg_advisory_xact_lock(hashtextextended('radar-settings:<id>', 0))`, then the radar row `FOR UPDATE` (skipped when the call only moves the radar between topics); capture takes the row `FOR KEY SHARE` (`services/radars.ts`, `services/blips.ts`; `services/lanes.test.ts`, `services/architecture.test.ts`).
- A radar leaves the `architecture` template only if it has no elements, no relations and no amendment markers (`assertTemplateUnlocked`, 409 `template_locked`).
- A lane set is 2 to 8 lanes with a non-terminal one, keeps the template's superseded lane, and may not strand a blip (`packages/contract/src/lanes.ts`, `assertNoStrandedBlips`).
- A drop box, a smart radar, a helpdesk radar and a once-client-facing radar are never public, and a drop box or smart radar is never in a topic: CHECK constraints `radars_drop_box_is_never_public`, `radars_smart_is_never_public`, `radars_helpdesk_is_never_public`, `radars_once_client_facing_never_public`, `radars_drop_box_is_never_in_a_topic`, `radars_smart_is_never_in_a_topic`.
- A smart radar resolves against the caller: `readableRadarIds(caller)` intersected with its saved ids, minus other smart radars; an anonymous caller gets nothing (`resolveRadarScope`; `services/smart-radars.test.ts`).
- Archive is computed, not stored: `archivedExpr` considers `done` or `dropped` blips on an archiving template older than the window; 0 days means never (`services/archive.test.ts` asserts SQL and DTO agree).
- A public slug is minted on first publish and kept when going private; `rotatePublicSlug` replaces it. The public blip list forces `includeArchived: false` (`routes/public.ts`).

## 2. Owned data

| Owned                                    | Kind  | Notes                                                            |
| ---------------------------------------- | ----- | ---------------------------------------------------------------- |
| `radars`                                 | table |                                                                  |
| `packages/server/src/services/radars.ts` | file  | Radar CRUD, lanes, themes, visibility, drop box, template change |
| `packages/server/src/services/slugs.ts`  | file  | Slug generation                                                  |
| `packages/contract/src/templates.ts`     | file  | The template registry                                            |
| `packages/contract/src/lanes.ts`         | file  | Lane validation                                                  |
| `packages/contract/src/theme.ts`         | file  | The nine-axis radar theme                                        |
| `packages/server/src/routes/radars.ts`   | file  | Mounted at `/api/radars`                                         |
| `packages/server/src/routes/public.ts`   | file  | Mounted at `/api/public` (unauthenticated)                       |

## 3. Interface

- **Routes (`/api/radars`):** list, create, `POST /smart`, `GET /drop-box`, get, patch, delete, `PUT /:id/visibility`, `POST /:id/rotate-link`, members and invites, `PUT /:id/topic`, `GET /:id/blips`, `GET /:id/facets`, `POST /:id/uploads`. `/api/public`: `GET /radars/:slug`, blips, comments, attachments, `card.svg`, email. The `/r/<slug>` page is an SPA route whose meta tags the API rewrites (`app.ts`).
- **MCP tools:** `list_radars`, `read_radar`, `create_radar`, `update_radar`, `delete_radar`, `set_radar_lanes`, `set_radar_theme`, `set_radar_visibility`, `describe_templates`.
- **Templates (8):** `stream`, `kanban`, `microblog`, `reading`, `decisions`, `architecture`, `discussion`, `helpdesk`. Only `stream` and `kanban` have an inbox; `kanban`, `reading` and `helpdesk` archive.

## 4. Failure and degradation

## 5. Known gaps and unverified facts

- `themeable: false` (kanban, helpdesk) is enforced in the MCP tool and the UI, but the service and REST `PATCH` accept a theme on a kanban radar.
- Reminders pausing on an archived radar is tested (`native-push.test.ts`).

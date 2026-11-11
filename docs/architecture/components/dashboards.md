# Component: M9 Dashboards

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Per-user tabs of widgets on a 12-column grid: a panel for one radar, or a live query over the search grammar shown as a list, a count, lanes or an activity chart. Dashboards belong to one person; the data in a widget is re-authorised on every read.

**Depends on:** M8 (query resolution), M3 (readable radars), M5.

**Used by:** M23 (six tools), the UI.

**Invariants (and what enforces each):**

- Every dashboard is owner-only. A query widget runs through the search resolver on each read, so access is re-evaluated each time; a widget pointing at a radar the caller has lost shows as unavailable and can be removed (`services/dashboards.ts`; `mcp/dashboards.test.ts`).
- A full replacement of widgets requires `expectedRevision` (409 on mismatch, under a row lock); `append` and `operations` can be sent without it. The revision is an integer on `dashboards` incremented on every update; there is no history table.
- CHECK `dashboard_widget_source_check`: a query widget has no radar id and a radar widget has one.
- Position is assigned under `pg_advisory_xact_lock(hashtextextended('dashboards:<userId>', 0))`, so concurrent creates get distinct positions.
- Limits: 60 widgets per dashboard (the merged layout is re-validated; one call accepts up to 120 operations), 12 query widgets per dashboard, query limit 1 to 50, grid width 12.

## 2. Owned data

| Owned                                                  | Kind  | Notes                                        |
| ------------------------------------------------------ | ----- | -------------------------------------------- |
| `dashboards`                                           | table |                                              |
| `dashboard_widgets`                                    | table |                                              |
| `packages/server/src/services/dashboards.ts`           | file  | Dashboards and widgets                       |
| `packages/server/src/services/dashboard-aggregates.ts` | file  | Grouped counts for lanes and activity charts |
| `packages/server/src/routes/dashboards.ts`             | file  | Mounted at `/api/dashboards`                 |

## 3. Interface

- **Routes:** `GET|POST /api/dashboards`, `POST /api/dashboards/preview`, `GET /api/dashboards/:id/widgets/:widgetId/results`, `PATCH|DELETE /api/dashboards/:id`.
- **MCP tools:** `list_dashboards`, `create_dashboard`, `update_dashboard`, `delete_dashboard`, `preview_dashboard_query` (also runs a saved widget).

## 4. Failure and degradation

- A widget whose radar the caller can no longer read renders unavailable rather than failing the dashboard; deleting a radar deletes its widgets (foreign key `ON DELETE CASCADE`).

## 5. Known gaps and unverified facts

- No per-user dashboard count cap was found in `createDashboard`.

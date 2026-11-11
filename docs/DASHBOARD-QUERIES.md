# Query dashboards and safe layout editing

The dashboard is a working view over existing blips. Queries, counts, charts,
search and MCP share the same readable radar set and filter predicates. A
widget never grants access, copies blips, or stores a second result set.

## Query expressions

Examples:

```text
-in:"Reads" is:inbox
not:tag:archived tag:bug|techdebt
topic:"Roving Studio" is:active
topic:"Roving Studio" stale:30d
has:link touched:7d
```

`-field:value` and `not:field:value` negate a structured filter. A `|` between
values means alternatives within one token; negate the entire alternative set
with `-tag:archived|noise`. Quote names containing spaces. `topic:` follows
current topic membership, so a newly filed radar flows into the view while
normal radar permissions still apply. An unknown or inaccessible name is a
query problem, including inside an exclusion; it is never silently discarded.

`touched:7d` uses the same activity definition as archiving: a blip's update or
a new comment. `stale:30d` selects activity older than that cutoff. Reactions and
edits to existing comments do not advance that activity clock. `after:` and
`before:` remain capture-date filters. `has:link` includes explicit URLs and
links present in the blip body or email notes.

Existing repeated-filter behavior is retained so saved dashboards do not change
meaning. Prefer `|` to express alternatives explicitly. Search responses expose
`combinationRules`, and the UI interpretation/help explains the legacy rules.
Invalid filters and exceeded budgets return `problems` and `unresolved`, with
no results; they cannot widen a query or masquerade as a valid empty result.

## Widget presentation

A radar panel continues to show its radar stream. A live query has one of four
displays:

| Display           | Behavior                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| List              | Up to 50 blips, with an optional grouping by radar and exact full-query subtotals.                                             |
| Count             | An exact full-query total; a tile can occupy two columns by two rows, allowing six across the grid.                            |
| Lanes             | Template-aware lane counts, preserving each radar's lane labels and including zero lanes within matching radars.               |
| Capture over time | Daily capture counts over 7, 30 or 90 UTC calendar days, including today, with zero-filled days and an accessible daily table. |

The aggregate response's `total` always counts the complete query. The capture
chart's separate `activityRange` defines its bounded time window; the chart
never silently changes that total. Count/chart modes do not hydrate full blip
bodies. List subtotals are database counts, not counts of the loaded page.

`hideWhenEmpty` hides only successfully resolved empty displays (for capture charts, no captures in the selected window). A failed query,
loading state, or permission error remains visible. Hidden widgets keep polling
and return when data matches. They are available through the hidden-widget
control and while arranging; hiding never deletes a widget or its saved layout.

Blip rows can be marked done through the existing update service, which selects
the appropriate template lane. Drop box rows can be filed using a dialog or
by dragging onto a writable radar panel. Filing preserves the original blip,
its notes and attachments; the same source/destination authorization applies
as elsewhere in the app. An undo action restores the prior filing state.

## Safe updates over HTTP and MCP

Every dashboard has a monotonic `revision`. All changes serialize on the
owner's dashboard row and commit atomically. Prefer partial updates:

```json
{
  "dashboardId": "<dashboard UUID>",
  "append": [
    {
      "radarId": null,
      "config": {
        "type": "query",
        "title": "Work in progress",
        "query": "topic:\"Roving Studio\" is:active",
        "display": "count",
        "hideWhenEmpty": true
      }
    }
  ]
}
```

`append` packs each new widget into the first available grid position against
the latest committed layout. It does not require the caller to compute `x/y`.
Defaults are 2×2 for counts and 6×8 for other widgets. Explicit `w/h` are allowed.
Concurrent appends merge instead of replacing one another.

`operations` supports:

- `{op:"add", widget:{radarId,config,w?,h?}, x?,y?}` — omit both coordinates to pack.
- `{op:"remove", id}` — remove that widget only.
- `{op:"move", id, x,y,w?,h?}` — change that widget's geometry.
- `{op:"update", id, radarId?,config?}` — change its source/configuration.

A batch validates its final layout, so two widgets may swap positions in one
atomic call. Invalid IDs, overlap, invalid sources or exceeded budgets roll
back the entire batch, including name changes. Widget IDs belong to one
specific dashboard and cannot be imported from another owner's or another tab.

Choose only one of `append`, `operations`, or `widgets` per update. Name and
position changes can accompany any mode. `expectedRevision` is optional for
partial changes and rejects stale changes when supplied. Full `widgets`
replacement **requires** the revision read from `list_dashboards`; missing or
stale revisions return a conflict, preserving newer panels. Reload and review
before retrying a conflict. Do not automatically retry an old replacement with
a newly read revision.

All of these fields are exposed through `update_dashboard`. Use
`preview_dashboard_query` with `display`, `groupByRadar`, or `activityDays` to
preview an aggregate, and `preview_dashboard_query` with `dashboardId` and `widgetId` to run its saved configuration.
Existing dashboard IDs, widget IDs and query configurations survive migration.
The additive database migration initializes existing revisions to zero.

## Boundaries and verification

The grid is 12 columns, up to 60 widgets including 12 live queries. Lists and
charts require at least 3×4, counts at least 2×2. Query grammar and result-size
budgets remain enforced in the shared contract/service, including for agents.

Tests cover real PostgreSQL aggregation beyond a page limit, topic membership,
revoked access, invalid/negated filters, UTC bucket edges, custom lane labels,
concurrent appends, stale replacements, atomic rollback and actual MCP calls.
Browser tests cover widget editing, charts, hidden-widget recovery, completion,
filing, drag targets, mobile layout and keyboard alternatives.

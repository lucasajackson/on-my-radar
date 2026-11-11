# Sources and live dashboard widgets

Design for the user's September2026 request: RSS imports, individually approved
inbound email senders, cross-radar query widgets, and a permanent Drop box. This
supersedes the earlier decision prohibiting every inbound Drop box surface;
existing public-sharing and webhook restrictions are separate decisions.

## Radar Sources

Add **Sources** to radar settings. It contains RSS feeds and the radar's inbound
email address. Keep Webhooks as its existing section so saved settings URLs retain
their meaning. Sources is available to owners of a radar that stores blips;
smart radars instead remain derived views and cannot receive imported content.

```
Radar name                                     Back
Identity  Look  People  Sources  Webhooks

RSS feeds                              Add RSS feed
Bring new posts into this radar automatically.
┌──────────────────────────────────────────────────┐
│ Example Journal                     Active       │
│ example.org/feed.xml                              │
│ 24 imported · checked 8 minutes ago               │
│                                  Pause  Remove   │
└──────────────────────────────────────────────────┘

Email
username+radarslug@onmyradar.io                Copy
Only your individually approved senders can deliver here.
Manage approved senders →
```

**Add RSS feed** asks for Feed URL and **Import existing posts**. The history
selection explicitly offers Forever, Past year, Past month, Past week and Past
day. The explanatory sentence states: “Imports matching entries still supplied by
the feed, then new posts automatically.” The history is an initial-import window,
not a promise that the upstream server retains a full archive.

After submission, the list shows queued/first-check status until the first fetch
finishes. Active/paused, last successful check and imported count remain legible.
Failures show the reason and a recovery path; failure is never drawn as an empty
feed. Pausing stops checks without removing imported blips. Removing the source
also keeps its existing blips, stated in the removal confirmation.

On390px screens, source URLs wrap, timestamps stay under the feed name and actions
wrap below the description. Inputs and action buttons remain full touch targets.
All states have explicit copy: loading, no feeds, invalid URL/history, failed
check, queued first check, paused and active. Buttons are disabled while their
mutation is pending.

## Inbound email

The account's **Email capture** section reserves a permanent username. The base
address delivers to Drop box. Each radar's Sources section owns its separate
Receive email switch and individually approved sender list. The owner account
email is always approved and cannot be removed. Other senders can be approved or
removed individually; domains and wildcards are rejected.

Addresses use backend-issued stable readable aliases, preserving delivery after
renaming a radar. The username cannot change after reservation; the UI explains
this before saving. A service-not-live notice distinguishes reservation from
working mail delivery. Enabling receive is unavailable until routing is live and
an address exists. Copy reports success only after clipboard completion.

## Dashboard widget creation

The primary action becomes **Add widget**. A modal offers **Radar** and **Live
query** choices; existing radar widgets remain fully supported.

```
Add widget                                       ×
[ Radar ] [ Live query ]

Widget name
[ Reading to catch up on                         ]
Query
[ tag:reading is:inbox after:1m                   ]
Radars  Tags  State  Date             Query examples

Preview
8 recent matches across the radars you can read
Title of a matching blip             Source radar
…
                                  Cancel  Add widget
```

Use the existing Search grammar and completion vocabulary, not a second parser.
Examples should be concrete and clickable, such as `is:inbox`, `tag:reading`,
`after:7d`, or `in:"Project"`. Structured controls may insert valid tokens, while
the query remains visible and editable. Preview explains applied filters and
refuses unresolved or invalid filters instead of silently broadening the query.
Empty preview is a valid saved query when its filters resolve; live data may
arrive later. Display “Showing the latest12 matches”, not a fabricated total when
the API supplies only a page.

Each live widget shows its custom name, a restrained “Live query” descriptor,
source radar on each result, **Edit query**, and **Open full results**. Results
remain constrained by the current reader's authorization at every refresh.
Unknown/removed radar names never leak from a cached cross-account context.

Edit/remove affordances appear on both desktop and mobile. Drag/resize are
optional desktop conveniences, not the only way to manage widgets. Saving layout
must preserve widget identity, kind and typed config. Multiple query widgets may
look at the same radar; deduplication by radarId is only appropriate to the
existing single-radar picker.

## Drop box

Drop box is the permanent default inbox. Its settings omit Delete and explain
that individual blips can be cleared or filed into other radars. The service
layer must refuse deletion independently of the hidden control. Rename/theme and
permitted source settings continue to work.

## Engineering handoff

- Source components: FeedList, FeedEditor, FeedStatus, RadarEmailAddress.
- Account component: EmailCaptureSettings with stable identity; RadarEmailCapture with per-radar exact-address
  approval management; no UI element can create a wildcard policy.
- Dashboard components: WidgetEditor, shared query input/help/interpretation,
  QueryWidget and existing RadarWidget; shared header supports edit/remove on
  every breakpoint.
- Reuse query keys and mutation invalidation; pending/error state belongs to the
  specific edited source/widget so unrelated content remains readable.
- Backend provides authoritative feed status/history enum, stable email addresses,
  approval state and typed widget config. Client previews use the same query
  evaluator as actual widget results.
- Test complete flows: import history selection, queued/failed/paused feed;
  rejected unapproved sender configuration; copy address failure; query preview
  and edit preserving layout; removing a widget on mobile; protected Drop box.

This document records design intent. Concrete DTOs/routes and shipped validation
are tracked with the implementation; it does not assert unbuilt API behavior.

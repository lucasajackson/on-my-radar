# Radar templates

A template is what a radar _does_ with its blips. The registry is
`packages/contract/src/templates.ts`; the views are `packages/ui/src/templates/`,
mapped by `layout` rather than by template id.

## What a template is for

**A template earns its place by the verbs it offers, not by its label.** If you
cannot say what a radar on this template lets you _do_ that a stream does not,
it is a stream with different words in a dropdown — and it will feel like one.

That is not hypothetical. Reading list, decision log and stream shipped
differing only in their lane vocabulary and a placeholder string: same `stream`
layout, same card, same order, same query. Lucas's own summary was "they all
feel the same, and I'm not sure that's an accurate portrayal", and he was right
about the code as well as the feeling.

The fix was not more chrome. It was to work out what each one is genuinely for
and let the registry declare it, so the shared components read a template's
intentions rather than branching on its name.

| Template         | Verbs it offers                | What makes it not a stream                              |
| ---------------- | ------------------------------ | ------------------------------------------------------- |
| **Stream**       | capture, triage                | nothing. It is the baseline, deliberately               |
| **Kanban**       | move between columns           | the board, and the lane a card sits in                  |
| **Microblog**    | post                           | the absence of triage chrome; a diary if grouped        |
| **Reading list** | queue it, open it, finish it   | queue order, the link as the object, link-first capture |
| **Decision log** | propose, decide, **supersede** | ledger layout, chronicle order, the supersession link   |
| **Architecture** | **amend**, propose, decide     | a charter whose accepted amendments strike its text     |

### Stream — the null template

Undifferentiated capture. Newest first, pinned on top, triage by `state`, no
lanes, no facets, nothing inferred beyond the universal rules.

It is deliberately plain, and it should stay that way, because it is what the
other templates are measured against. If a change would make the stream
cleverer, it belongs on a template — templates are the thing you opt into.

### Reading list — a reader

Things from elsewhere you intend to consume, read the way mail is. Properties,
all of them behavioural rather than cosmetic:

- **A reader.** `layout: 'reader'`: a list of stories, newest first by capture
  date (`order: 'captured'`; the old `queue` order is declared by no shipped
  template). A story opens full-screen as `?sel=<id>` at a 70ch measure, with
  its source, date, original link and images; Esc or Back closes it, ←/→ or
  j/k step through the list, and an id beyond the loaded page is fetched alone
  and never swapped for another. Full-screen on a phone too.
- **Mail's read state.** `readState: { unread, read }` names two of the lanes.
  Unread stories are bold with a dot, read ones muted; opening a story files it
  in the read lane, "Mark unread" (or `u`) puts it back, and the Unread / All
  toggle replaces the lane rail and the per-card dropdown. The lane axis is the
  only record, so `state` follows by the lane's own rule. The read lane is
  `reading`, not `finished`, so opening a story never starts the archive clock.
  A radar whose custom lanes drop either lane has no read state.
- **No comments.** `comments: false` is folded into the radar's
  `commentsEnabled` (`commentsAllowed`), so the DTO, the SPA and the write path
  agree.
- **The link is the object.** The card leads with the source domain, and a blip
  with a URL leads with its preview even when the kind heuristic called it a
  note — a note written around a link does not demote the link to an aside. The
  URL is then removed from the body text, because by that point the card has
  printed it twice already.
- **Link-first capture.** `soleUrl` is strict everywhere else: a body that is
  _nothing but_ a URL is a link, a body that mentions one is a note. On a
  reading list that rule is wrong, so `capture.linkFirst` widens it — "https://…
  — because Ben mentioned it" is a link with a note attached.

### Discussion — a place to talk

A blip is a **thread** and its comments are the replies. That is the whole
template: nothing about storage was missing, because a blip already had a
conversation that non-owners could join. What was missing was that the
conversation was folded away, flat, ordered by capture, and called a comment.

- **The thread is the content.** `conversation.expanded` renders it open instead
  of behind a toggle. Everywhere else the restraint stays and is deliberate — a
  permanent conversation surface under every private note is rent charged on the
  surface whose thesis is that capture is cheap.
- **One level of nesting.** `conversation.threaded` lets a reply answer a
  particular reply. Replying to a reply re-parents you beside it rather than
  under it, and pre-fills a mention of whoever you are answering. Google Wave
  allowed arbitrary depth and it is the single most cited reason a long wave had
  no reading order; Slack built the same thing independently and concluded that
  restricting each thread to one level "was an instant success on all fronts".
- **Activity order.** `order: 'discussion'` floats the thread answered most
  recently to the top. A forum in capture order is a list of things nobody
  replied to.
- **Resolve, rather than delete.** Two lanes, Open and Resolved, and a resolved
  thread sinks rather than disappearing.

Two lanes and no more, because "it doesn't need to be complicated" was the brief
and Wave is the argument for taking that literally.

### Decision log — a record with a spine

A record of choices and the reasoning behind them. Entries are never "done";
they are in force, or they have been **replaced**.

- **Supersession** is the verb the other templates do not have. One blip can
  record that it replaces another (`blips.supersedes_id`), and recording it
  files the replaced blip into the lane the template declares as
  `supersededStatus` — one call, not two, so the log re-sorts itself the moment
  you say what replaced what.
- **Chronicle order.** Lane order, then newest first. Live entries lead;
  rejected and superseded ones sink. The top of the page is the state of play.
- **The ledger layout** (`layout: 'log'`). Entries grouped under their lane
  rather than running together, because "what have we decided" and "what did we
  decide against" are different questions and a flat list answers neither.

### Architecture — a charter, and the ADRs that amend it

The decision log's cousin, for an application's architecture document. The
document (the **charter**) is one markdown text per radar (`charter_documents`),
saved whole with `write_charter` against a `baseRevision` and sealed as a full
version on every change (`charter_versions`). Each ADR is a blip in the decision
lanes. Radars built before the cutover had their pages joined into the document
(and markers turned into anchors) by `migrateRadar`; the old page blips are kept
until `scripts/charter-one-document.ts --purge-pages --apply` removes them. Comments, search, sharing and MCP come for free because everything is a
blip. It is not in `ORDINARY_PLAN_TEMPLATES` yet.

**An amendment is a stand-off anchor**, not text in the document: a row in
`charter_anchors` holding the quote, a little context either side (64 characters),
the replacement, and a cached position. It is resolved against a plain-text
projection of the markdown (`projectMarkdown`, `resolveAnchors` in
`contract/anchor.ts`), so markup around the words does not matter. It is written
when the ADR is _proposed_; the quoted text is never deleted. How it reads is
computed from the ADR's lane: **accepted** strikes the quote (or, "As amended",
shows the replacement), **proposed** is highlighted, **rejected** and **repealed**
are plain text. A superseding ADR amending the exact same span stacks a second
layer. Clients that still draw strikes from `:amend[…]{…}` markers get them in
`view=source`, synthesized from the anchors; marker syntax typed into the text is
escaped there and means nothing.

**A save never refuses on an amendment.** `write_charter` re-resolves every anchor
against the new text in the same transaction. An anchor whose words are gone is
`orphaned` (cause `text_changed`, `ambiguous` or `diff_not_exact`; when in doubt,
orphan) and the response lists it with its last good version and its quote; saving
the words back heals it. An ADR with an orphaned amendment cannot be accepted
(`adr_orphaned`, 409, on every path that accepts), cannot be deleted, and still
locks the radar's template.

**Links and history.** A passage can also be tied to a boundary or contract
(`link_charter`): the same kind of anchor (`kind='link'`), but it points rather than
replaces, so it may span paragraphs (up to 4,000 characters) and the element can be
made in the same call. It follows the text and orphans with it, flagging the element.
Every sealed version is listed (`list_charter_versions`: who, when, why), readable as
it was (`read_architecture({version})`, read-only), comparable (`diff_charter`, on
the words) and restorable as a new version (`write_charter` with `restoreVersion`). History is for members: a
public link shows the current charter and none of its versions.

A quote is one line of plain text that appears exactly once (`pageId` narrows
the search to a page). Code fences, code spans and link targets are never
quotable. Refusals, all before anything is written: `quote_not_found` (422),
`quote_ambiguous` (409, with each match's page and context), `quote_overlaps` and
`quote_in_amendment` (409, naming the ADR to supersede), `quote_spans_blocks` and
`quote_in_code` (422).

**Ratifying is a lane move the registry polices.** `transitions` allows proposed
to accepted or rejected, and accepted to repealed; the charter lane is closed
both ways. `updateBlip` enforces it on the _final_ lane, so the `state` repair
(`state: 'done'` lands in Accepted) is checked like an explicit `status`. Nothing
is created straight into a decided lane. `ratifiedStatus: 'accepted'` defers
supersession (see below): entering Accepted stamps `blips.ratified_at` once and
files the replaced ADR as Repealed.

**The charter lane is closed.** No blip can be created in it, edited, or moved
into it (`charter_is_one_document`, 410). An ADR named by an anchor cannot be deleted or moved (`anchored`). Only a
Proposed or Accepted ADR's anchor blocks a save or counts as an orphan: a
Rejected or Repealed one is resolved and versioned but only counted
(`inertOrphaned`).

**Boundaries and contracts** are blips too, in the `boundary` and `contract`
lanes (`elementLanes` in the registry; no transition leads in or out, and
`assertEntry` refuses a capture or cross-radar move into them with `element_lane`).
`blip_elements` holds a boundary's `external` and `owns` (at most 100 items) and a
contract's `version`. `blip_relations` holds the links: `seam_side` (a contract to
each of its two boundaries, side `a` or `b`) and `amends` (an ADR to a boundary or
contract). Its `to_blip_id` is `NO ACTION`, so the database itself refuses to
delete a boundary that still has seams (`boundary_in_use` in the service); a
radar delete still cascades through `radar_id`. The relation and element guards
(`anchored`, `boundary_in_use`) read those tables, not the radar's current
template, so switching a radar to Stream and back cannot be used to cut or carry
them. One boundary or contract per title per radar, whatever the case
(`blips_element_title_key`, on `blip_elements` only, so another radar's custom
`contract` lane is untouched; it arbitrates concurrent upserts). The verbs are `upsert_boundary`, `upsert_contract` and `trace`
(`docs/MCP.md`); `propose_adr` takes `amends`.

**The Map and the Matrix.** The layout has three tabs, `?tab=charter|map|matrix`,
with the selected element in `?focus=`. Charter is the default, unless the radar
has boundaries and no charter. `layoutMap` (`contract/map.ts`) is pure and
deterministic (given `{aspect}` it is also bounded: every column count is sized
without pills, only the best two are drawn in full, and the spare room is found by
halving, so 100 boundaries take about 0.1s; the web memoizes it by data and box
shape and lays out off the resize path) so native clients draw the same picture: our boundaries in a grid
inside a frame (sorted by title, then pairs swapped while the internal seams get
shorter, at most 20 passes), each external system on the frame side facing its
counterparties, a labelled pill on each line (at the midpoint, or on the wall for
an external seam, sliding in 10% steps off anything it would cover). A boundary
or contract amended by an ADR is badged red when an accepted ADR amends it and
amber when only a proposed one does. The matrix is our boundaries as rows against
every boundary as columns; each cell lists its contracts and an empty cell is a
`·` labelled "No contract".

**Writing it from the page.** The view is never replaced by the generic empty
state: an empty radar is the card with its tabs, each saying what goes in it and
offering the action that fills it, and the ADR ledger always lists Proposed,
Accepted and Rejected ADRs, charter or not. People with write access get, in the
tab bar, Edit charter (Charter; "Write the charter" on an empty one), Add boundary and
Add contract (Map) and Propose ADR (a title and why, no quote; it replaces the capture
box, which an Architecture radar does not show). The boundary and contract forms sit in
their column (the map's detail rail, a sheet on a phone), never in a modal over the map; a
boundary's or contract's detail has Edit and Remove (`delete_blip`'s guards:
`boundary_in_use`, `anchored`). Once a radar has a document its page blips are fenced by the database (migration
0091, `charter_page_fence`): an insert, update or delete of one fails for an older pod
during a rolling deploy instead of succeeding and being lost, and the API refuses a
comment on a page (410). `purgeMigratedPages` is the one writer; it never deletes a
page that has a comment.

The charter is written by `write_charter` (REST `PUT /radars/:id/charter`), whole,
with the `baseRevision` read; a stale one is `stale` (409). The old page routes
(`POST /radars/:id/charter-pages`) are retired (410).
`propose_adr` numbers each ADR one after the radar's highest.

**Editing the charter (`architecture-charter.tsx`).** Edit charter turns the document
into Milkdown in place, at the document's own width (no page, no form, no Save button).
It opens on `?view=written` (the stored text, never the `source` view with its
synthesised markers) with that read's `revision`. Typing is saved by itself through
`CharterSaver` (`lib/charter-save.ts`): one `PUT /charter` in flight, the latest text held
behind it, each response's revision the next write's base, a write about 2 seconds after
typing stops. Those writes are `checkpoint: false`: they replace the working text and make
**no version** (a morning's typing is one version, not hundreds). The working text is
sealed, under its writer's name, by Done, after 10 quiet minutes (the editor sends it, and
the server also does so before the next write), before another actor's write, and by any
save that orphans or heals an amendment (those point at a version). The badge reads Saved
just now / Saving… / Saving paused (retrying) / Changed elsewhere / Not saved. **Nothing
that decides the text's fate reads the editor's debounced report.** Done, Copy mine,
Reload latest, Undo and leaving read the editor itself (`MarkdownEditorApi.markdown()`).
Done holds the document still, writes what is typed, seals it, and closes only if the
editor still holds what was sealed; otherwise it goes round again, and it stays open,
saying why, when it cannot. What is not on the server is also kept in this browser (per
radar, with the revision it was typed on): leaving the radar, or the browser, brings it
back with "Unsaved changes restored. Save / Discard", and leaving inside the app asks first
(`CharterLeaveGuard`). **A conflict is whole-document**, because the server's only save is a full replace: on a 409 `stale` the
editor stops saving and keeps every typed word, and offers Reload latest (the document is
replaced, with no Undo, which would write over their save; the person's own text is set
aside first and offered back with Copy it) or Copy mine. As written
is locked while editing. Amendments are drawn over the text as ProseMirror decorations
(`charter-spans.ts` finds each one in the projection from the `source` view's markers) and
never enter the Markdown. A save that orphans comes back with what it orphaned: the toast
says so, and its Undo writes the previous text back (which heals them) and remounts the
editor on it; the rail's Orphaned tray shows each cause and quote, the Charter tab counts
them, and Accept is disabled on an ADR with an orphaned anchor, with the reason beside it.
The rail's Outline lists the headings (a sheet from the bar's Outline button on a phone).
Selecting text in the reading view sends the quote with its `prefix` and `suffix`, taken
from the page across block boundaries, so a sentence that occurs under two headings
anchors to the one selected.

**History (`architecture-history.tsx`, members only).** A History button in the charter's
bar opens a panel in the rail's column (a sheet on a phone): the current charter, then each
sealed version newest first, with its why ("Accepted ADR-0027", "Edited", "Restored from v3",
"Migrated"; the lane is the one the ADR was in when the version was sealed, `lane` on the
version), who (an agent is badged, its person in the tooltip) and how long ago. A public-link
reader has no button (`access.viaPublicLink`), and the server answers every door 404. Picking a
version draws it, read-only, in the document's place: a banner (Viewing version N, when, by whom;
Back to current, Compare with current, Restore this version for those who can write), the editor
and Propose ADR are off, and its amendments are underlined as they stood. It is a read-only
Milkdown (`lib/milkdown-history.ts`, loaded when one is opened) so the server's text offsets
(`docBlocks`, the projection) land on the words drawn: a comparison is the newer document with
inserted words marked green and struck words (placed by walking the hunks, `changesOf`) red, a
sticky bar with the count and Previous/Next, From/To pickers for any two versions, and a note
when the diff lists fewer changes than it found ("Showing the first 200 of N changes") or is not
word-exact. `?version=N&anchor=ID` (also `compare=head|M`) opens that version and scrolls to, then
flashes, the passage; the Orphaned tray's "See it in version N" (`SeeInVersion`, which U2's link
rows reuse) is that link, and opens in place when the charter is on the page. Restore asks first
(it adds a version, nothing is lost: the working text is sealed before it), then the toast names
the amendments and links it anchored again or orphaned, and the panel shows the new version on top.

**The layout.** One rounded card (`.panel`) on the full content pane (the radar
route gives `architecture` the board's `max-w-[1600px]`; the header and composer
follow). The three views are a `.segmented` control in the card's top bar, with
the As written / As amended toggle (or the element counts) at its right; from
1024px the bar stays under the radar header while the Charter scrolls, and the
rail sticks beneath it. The
Charter is the pages beside a rail of the ledger, Proposed and Rejected, once the
card is 44rem wide (the card's width, not the screen's: a 1024px screen with the
sidebar open is the narrowest); the rail is sticky and scrolls on its own, and
under the pages when narrower. Prose keeps a 72ch measure inside its column, and
tables and code take the column: the width goes to the rail, not to longer lines.

**The Map, by width.** From 1024px the Map and Matrix fill the screen below the
header: the view measures the room left in the scroll pane and sets `--arch-fill`
on the card, so the drawing and a 288-360px detail rail are both on screen with no
page scroll. From 820px the drawing is fitted to its box (the box's size sets the
viewBox, so it scales rather than scrolls) with zoom, fit, drag and pinch in
the box and small icon buttons in its corner; there is no "Open map" button.
A pinch on a trackpad (ctrl + wheel) or ⌘/ctrl-scroll zooms at any width; a
plain wheel pans from 1024px, where the page does not scroll, and is left to the
page below it. The box says "Pinch or ⌘-scroll to zoom" at 1024px and up. A
press that is let go outside the box ends when the pointer comes back with nothing held;
a finger that lands on a box keeps dragging when capture passes to the pane. Panning
is clamped (wheel, drag and pinch alike) so the drawing always covers at least 40% of the
box along each axis, and Fit is always reachable. At 820 to 1023px the box is a share of the screen's height with
the detail directly beneath it. Fitting 40 boundaries into a box makes the labels
small, which is why zooming is there; the key and `data-zoom` (1.00 when fitted)
are on the box.

**The phone answer.** Below 820px the drawing would render at about a fifth of its
size and the matrix is 24 by 40, so neither is shown inline. The Map tab is a
**Seams list**: every boundary is a row (title, owns count, badge) that opens onto
what it owns, its seams and its ADRs; a quiet "Open map" (`.btn`) shows the drawing
full screen, pinch to zoom and drag to pan, with the same icon buttons. The Matrix
tab shows one boundary at a time: each counterparty, or "no seam". Every control is
44px, and the page body never scrolls sideways. A boundary with nothing under Owns,
Seams or Amended by says so.

**Anchoring the selected occurrence.** Selecting text sends `pageId`, `occurrence`
(which match of the quote it is, 0-based, in the page as rendered, without the ADR
labels) and `seen` (how many matches the page shows). `findQuote` counts the
matches in the page source with the same masking, leaving out what a reader never
sees (link targets, a fenced block's label line), and anchors only when the count
equals `seen` and `occurrence` is below it; otherwise it refuses with
`quote_moved` (409, "the text changed; reselect"). A recurring phrase with no
`occurrence` stays `quote_ambiguous`. Amending is offered only from As written.

**Where ADRs come from.** The ledger, Proposed and Rejected are drawn from the
`read_architecture` response, which holds every ADR, never from the paged stream
(pinned boundaries could fill a page). A Proposed or Rejected row shows the stream's
card when the stream has it and fetches the ADR's text when it is opened.

On a phone the Charter tab is the stream's layout: vertical pages. A wide table scrolls
inside its own box, never the page. Selecting charter text shows a **Propose ADR**
bar: below `lg` it docks at the foot of the scrolling pane, directly above the
tab bar and clear of the iOS selection callout; from `lg` it floats beside the
selection. It opens the ADR form with the quote filled in. The As written / As
amended toggle lives in `?view=`. A layout a client does not know is drawn as the
stream, and a public architecture radar is too (the charter is read through the
signed-in API).

## The registry

Adding a template is one declaration. What that declaration now carries:

| Field                | What it decides                                                                      |
| -------------------- | ------------------------------------------------------------------------------------ |
| `layout`             | which view draws it — `stream`, `board`, `timeline`, `log`, `architecture`, `reader` |
| `statuses`           | the lanes, in a meaningful order (see below)                                         |
| `defaultStatus`      | where a newly captured blip lands                                                    |
| `order`              | `captured`, `queue`, `chronicle` or `discussion`                                     |
| `laneFilter`         | whether the lanes appear as a filter rail above the list                             |
| `assignable`         | whether a card takes an assignee and a claim (`claim_blip`)                          |
| `facets`             | what the cards lead with — `source`, `supersession`, `assignee`, `moved`             |
| `capture`            | what capture infers here beyond the universal rules                                  |
| `comments`           | `false` where blips take no comments (default: they do)                              |
| `readState`          | the `unread` and `read` lanes of a reader, for mail-style read state                 |
| `conversation`       | whether the thread is the content: expanded, threaded, noun                          |
| `supersededStatus`   | the lane a replaced blip is filed into                                               |
| `decides`            | for a decision request: the lane it is asked in and the outcome lanes that answer it |
| `ratifiedStatus`     | the lane that means "in force"; defers supersession to it                            |
| `transitions`        | the legal lane moves; a lane with no entry is final                                  |
| `customLanes`        | `false` when the lanes are part of the meaning                                       |
| `capturePlaceholder` | the composer's voice                                                                 |
| `showTriage`         | whether the triage chips belong here                                                 |
| `photos`             | how a picture is drawn — `inline`, `thumb`, `feature`                                |
| `grouping`           | whether the day-rule control is offered                                              |
| `themeable`          | whether the reading surface may be styled (default: yes)                             |

The last three are the ones added most recently, and two of them exist to retire
special-casing rather than to add behaviour.

**`photos`** settles a conflation that had been quietly wrong since the microblog
shipped. `BlipCard` took one `compact` flag meaning _this card is dense, drop the
kind badge_ — what a board column wants — and forwarded it to the attachment
block, where it meant _a picture here is a thumbnail, not the point_. The
microblog set `compact` to lose the badge and silently got an 11rem thumbnail
with it, hanging off the left margin under a serif post. Now the card asks
`photosFor(template)` and `compact` keeps its one honest meaning:

- `inline` (default) — shown whole, capped by height, left-aligned in the card's
  text column. A picture attached to a thought.
- `thumb` — a board card is an index entry; the picture marks it.
- `feature` — **the picture is the post.** Centred and given the column's width.

**`grouping`** replaced `template === 'microblog'` on the settings page, which
was the last piece of id-based special-casing in shared code.

**`themeable`** defaults on and a template opts _out_. Kanban is the only one
that does: its columns read as columns because of the application's own frame
around them, and the spacing axis fights a layout whose density is functional
rather than decorative. A radar switched to a template that opts out keeps its
stored theme — it stops being drawn, which is not the same as being lost.

**Lane declaration order is load-bearing** for `queue` and `chronicle`: it _is_
the running order of the page. A reading list declares unread → reading →
finished → abandoned, which is exactly the order you want to meet them in.
Reorder the lanes and you reorder the radar.

### Shipped

| Template         | Layout       | Order      | Lanes                                                                                                         |
| ---------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------- |
| **Stream**       | stream       | captured   | none — triage by `state`                                                                                      |
| **Kanban**       | board        | captured   | Backlog · To do · In progress · Blocked · Done                                                                |
| **Microblog**    | timeline     | captured   | none; `grouping: 'day'` makes it a diary                                                                      |
| **Reading list** | reader       | captured   | Unread · Reading · Finished · Abandoned                                                                       |
| **Decision log** | log          | chronicle  | Proposed · Accepted · Rejected · Superseded                                                                   |
| **Discussion**   | discussion   | discussion | Open · Resolved                                                                                               |
| **Architecture** | architecture | chronicle  | Charter · Proposed · Accepted · Rejected · Repealed · Boundaries · Contracts (fixed: no custom lanes)         |
| **Helpdesk**     | board        | captured   | New · Scheduled · In progress · Waiting on client · Resolved · Declined, each mapped to a fixed client status |

Helpdesk is the one template with a client side (`clientFacing`): it is never
public, and every lane names one of six fixed `clientStatus` values, so a lane
an agent renames can never change what a client reads. It may be shared with
internal collaborators, who see its internal notes; never with a client.
`docs/HELPDESK.md` is the full design.

Reading list still costs **no view code**, and that is the honest form of the
old claim: a template whose distinctions are order, capture and card facets is
free, because those are registry declarations the shared components already
read. What was wrong before was treating "costs nothing" as the _purpose_ of the
abstraction rather than as a happy case of it. The decision log needed a shape a
list cannot draw, and pretending otherwise is precisely how it ended up
indistinguishable from the stream.

## Custom lanes

A radar may replace its template's lane vocabulary with its own —
`templateConfig.lanes`, validated by `packages/contract/src/lanes.ts`, written
over MCP with `set_radar_lanes` or from the radar settings page (Edit lanes).

**The line, and it is the whole design: a template is a set of behaviours; a
lane set is a vocabulary.** Layout, reading order, card facets, capture rules,
conversation shape and archiving all need code, and they stay in the registry
where they get review, tests and a phone layout. The words on the columns need
none of that, and they are the thing people actually want to change.

That line is what stops this being a plugin system. Nothing a person can write
here adds a behaviour: there is no way to express a new order, a new card, a new
query or a new capture rule, by construction rather than by policy.

### What it costs, and where each check lives

Three validations in three places, because each needs something the others do
not have:

| Where                        | What it can answer                                   |
| ---------------------------- | ---------------------------------------------------- |
| `schemas.ts` (zod)           | is this the shape of a lane at all                   |
| `lanes.ts` (`validateLanes`) | is this set coherent against the template's registry |
| `services/radars.ts`         | does it strand blips this radar already holds        |

Only the third needs the database, which is why it is not in the contract.

### The rules, and the broken radar each one prevents

- **Only a template with a lane axis may be given lanes.** A stream declares
  none; adding some would put a lane rail above a surface that has never had one
  and a lane menu on every card. That is a layout change wearing a vocabulary
  change's clothes.
- **Two to eight.** One lane is not an axis. Past eight a board scrolls sideways
  on a desktop whatever the column floor is, and becomes an eight-tap pager on a
  phone.
- **Every lane declares its `state`.** The same invariant the registry has always
  held: it is what stops a board and the universal Inbox count disagreeing.
- **At least one non-terminal lane**, or everything captured arrives already
  finished — and on an archiving template, ages out of sight a month later.
- **A template with a `supersededStatus` keeps that lane id.** Drop it and
  supersession keeps recording links while silently filing nothing, which is the
  one failure here that is invisible on the page. Relabelling it is free; the id
  is what supersession looks for.
- **No stranded blips.** Refused rather than repaired. Repairing would mean
  writing every stranded blip into some other lane — a second write that can
  disagree with the first, which is the failure the lane/state repair already
  exists to prevent — and doing it to rows the person asking has not looked at.
  The refusal names the lanes and the counts.

### What is deliberately not offered

- **No second copy of the rules.** The settings page's **Edit lanes** dialog
  runs the contract's `validateLanes` — the function the server runs — and shows
  its problems as worded; the stranded-blips refusal comes from the server. An
  earlier version offered no editor at all for fear of restating the rules
  above; running the same function answers that. Agents use `set_radar_lanes`.
- **No custom `defaultStatus` ceremony.** Absent means the first lane, which is
  what all five shipped templates already declare — a board opens on Backlog, a
  queue on Unread, a log on Proposed. The field exists for the radar that wants
  otherwise and can be left out by everyone else.
- **Lanes on a smart radar.** It holds nothing of its own; its blips live on
  other radars and are already filed in theirs.

### Reading a radar that has them

Nothing downstream knows an override is possible. `templateFor(id, config)`
returns the template _as this radar has it_, and every other helper —
`statusesFor`, `findStatus`, `resolveStatus`, `laneRank`, `laneForState`,
`supersededLane` — goes through it. The board, the lane rail, the card menu, the
keyset cursor and the MCP `lanes` output all read the radar's own words without a
line of branching.

Two consequences worth knowing:

- **A stored lane set on a template with no lane axis is ignored, not deleted.**
  Move a board to a stream and back and the vocabulary is still there. Same
  degradation rule as an unknown template id, and for the same reason: a radar
  must stay readable.
- **`templateConfig` is patched, never replaced.** It had been written wholesale,
  which was harmless while it held two display booleans and would now mean the
  settings page erasing a radar's lanes the next time somebody toggled the diary
  rule. The theme has patched since it shipped; this is the same rule one field
  over.

## Mentions

`@handle` in any body — a blip's or a comment's — addresses somebody, and it is
**not** gated to the discussion template. "This names that person" is a fact
about a body rather than about a template, exactly like `#hashtags` and
`supersedes_id`, and gating the storage would lose it the moment a radar
switched templates. Threading _is_ gated, because a folded thread has nowhere to
put a reply control.

A handle resolves only against the people who can already read the radar, so
mentioning can never widen access — see `docs/DESIGN.md` §18. What a template
author needs to know is only this: any layout that renders a body should pass
`mentions` to `renderMarkdown`, or handles will render as plain text on that
surface while still notifying, which is the one visible way the two halves can
disagree.

## Ordering, and the cursor

The stream is keyset-paginated, and the keyset has to name every key of the
`ORDER BY` or it stops being total — capturing mid-scroll could then duplicate
or skip a row. `queue` and `chronicle` sort on lane rank first, so the cursor
carries that rank.

Row-value comparison only works when every key sorts the same way, which is why
neither order mixes directions:

- `captured` — `pinned DESC, created_at DESC, id DESC`. Left byte-for-byte as it
  was, because it is the hot path (every stream, board, microblog, smart radar
  and public page) and it stays served outright by `blips_radar_created_idx`.
- `queue` — ascending throughout, with `pinned DESC` written as `NOT pinned ASC`.
- `chronicle` — descending throughout, with the rank negated so lanes still read
  forwards.
- `discussion` — descending throughout like `chronicle`, with the last reply
  standing in for the creation time. Its key is the only **mutable** one in the
  application: the keyset stays total, so a row that sits still cannot duplicate
  or be skipped, but a thread answered mid-scroll genuinely moves. Say that
  plainly rather than letting the totality guarantee be read as covering it.

The two lane orders sort on a CASE expression and so cannot be index-only. That
is a trade made knowingly: they are declared by templates whose radars hold tens
to low hundreds of blips. A cursor issued before lane ordering existed has no
rank, reads as 0, and keeps paging.

**Only the radar's own template decides the order.** A smart radar always reads
in capture order — it spans many radars on many templates, so its own lane order
would be sorting rows that never had those lanes. A public page reads in the
owner's order, because a public page that silently re-sorted itself would be a
different radar wearing the same name.

## Themes

A radar's **theme** styles its reading surface: nine enum keys covering paper,
pattern, reading face, instrument face, corners, the rule between posts, spacing,
pointer and headline. It is a property of the radar, gated by the template's
`themeable` declaration, and the full design — including why it is a bounded
vocabulary rather than user CSS — is in `docs/DESIGN.md` §20.

Three things a template author needs to know:

- **A theme is a token override on a container**, exactly like the accent. Every
  component in `styles.css` already reads `--paper`, `--line`, `--ink-800` and so
  on, so a themed surface re-skins everything nested inside it without any
  component knowing a theme exists. A new layout gets theming for free if it uses
  the tokens, and gets none of it if it hard-codes a colour. That is a good
  reason not to hard-code a colour.
- **The theme starts and stops in exactly one place** — `<RadarSurface>`. Inside
  it: the radar's header, bearing strip, composer and posts. Outside it: the app
  shell, the tab bar, the toast layer and every dialog. If your layout needs
  chrome outside that container, it will not be themed, and that is deliberate.
- **`.attribution` is the one class a theme may not repaint.** It carries the
  byline on a public page. Nothing in the vocabulary can hide it — a surface
  ships its ink with its ground, and no axis can position or size anything — but
  the class exists so that stays true by construction as well as by argument.

Two axes interact with layout and are worth checking when you add one: `rule`
targets `.timeline-post + .timeline-post` and `.divide-y > * + *`, and `density`
targets `.timeline-post`. A layout that separates its items some other way should
extend those selectors rather than inventing a tenth axis.

## Supersession

`blips.supersedes_id` is on **every** blip rather than gated to the decisions
template: "this replaced that" is a fact about two blips, not about a template,
and gating the storage would mean a radar switched off the template silently
losing its links. The affordance is registry-gated instead —
`facets: ['supersession']` for the control, `supersededStatus` for the lane — so
the service layer never carries a lane id.

Three rules, and the first is a disclosure rule rather than tidiness:

- **A supersession link never crosses a radar.** `supersededBy` puts the
  replacement's _title_ in the DTO, so a pointer across a boundary would print a
  title out of a radar the reader cannot see. The refusal does not distinguish
  "no such blip" from "a blip somewhere you cannot see", for the same reason
  `requireRadar` answers 404 rather than 403. Moving a blip between radars cuts
  the link in both directions rather than carrying it.
- **`ON DELETE SET NULL`, not `CASCADE`.** Deleting the decision that replaced an
  older one must not delete the older one. The pointer goes; the record stays.
  That is the opposite of the aggregate rule for attachments and comments, which
  are parts of a blip rather than references to one.
- **A template can defer the filing.** With `ratifiedStatus` (Architecture) the
  link is recorded when the replacement is written, but the replaced blip is
  filed only when the replacement enters the ratified lane, in the same
  transaction, and only a blip in that lane can be replaced.
- **Clearing a link does not un-file the blip it pointed at.** What happened to
  that blip is its own record, and reversing it as a side effect of an edit over
  here is the "two writes that can disagree" failure the lane/state repair exists
  to prevent.

## What every layout owes a phone

A template is not finished until it works in the hand. The shell already gives
every radar an app frame below the `lg` breakpoint — bottom tab bar in thumb
reach, sidebar as a drawer that closes on navigation, safe-area insets — so a
layout only has to answer for its own shape.

- **discussion** is a vertical stack of thread panels, each with its replies
  open inside it. The only thing it asks of a narrow screen is room for one
  level of indent, which is why the indent is small and set in `rem` — at 390px
  a generous one leaves a reply a few words wide. Measured at 296px of reading
  measure inside a 390px viewport, which is fine. The depth cap is doing the
  work here: a second level would not survive the same measurement, and that is
  a layout argument for the cap on top of the comprehension one.
- **architecture** is vertical pages plus the ledger, a Seams list for the Map,
  and one boundary at a time for the Matrix; see its section for the Amend bar,
  how wide tables behave and why neither the drawing nor the grid is shown inline.
- **stream**, **timeline** and **log** are vertical lists of full-width blips on a
  phone, which is already the native shape. On a wide pane (up to `--radar-max`,
  1920px) the width goes into structure, never into the line: the stream is a
  filter rail plus a card grid, the timeline is days | feed | photos, the log is
  index | decision | context. Each layout declares its pane in `PANES`
  (`templates/index.tsx`) and the columns are container queries on the pane
  (`.cols`, `.radar-cols` in styles.css): lg 1000-1499px, xl 1500px and up, and
  below 1000px the single column above. A public page has no pane, so it is that
  column at every width.
- **board** is the one that genuinely cannot survive being narrowed. Five lanes
  side by side on a phone is either five unreadable columns or a horizontal
  scroll nobody discovers, so below the breakpoint the lane strip stops being a
  legend and becomes a **pager**: one full-width lane at a time, tapped between.
  The same component, driven by `matchMedia`, not a second implementation.

The **lane rail** wraps rather than scrolls, like the triage chips and for the
same reason: a lane sliced in half at the screen edge is a lane nobody knows is
there. That is asserted in the phone battery.

If you add a layout, that is the question to answer: does the shape survive a
375px viewport, and if not, what does it _become_? A new layout that only makes
sense wide should say so in the registry rather than shipping a broken phone
view.

On the desktop side, a lane has a floor rather than a fixed width, and the two
share the pane. The floor is what decides when sharing stops being honest and
the row scrolls instead — it is measured against the real shell cost, not
guessed. See the comment on `.board-column` in `styles.css`.

## Comments and reactions per template

Both are per-radar switches (`commentsEnabled`, `reactionsEnabled`), not per
template, and both default on. They are switches rather than template properties
because the same layout serves opposite intentions: a decision log usually wants
comments and no reactions, a public microblog often wants the reverse. The
registry should not be deciding that on the owner's behalf.

Worth knowing when you design a layout: the conversation surface is deliberately
quiet until there is something to say, so a blip nobody has touched costs one
hairline row. A layout whose unit is small — a board card — is where that
restraint matters most, and the board deliberately does not render it at all:
a card is a card, and a thread belongs on the blip.

## Backlog

Deliberately not built, with what each would actually cost.

### Worth building next

- **Per-reply unread state.** The discussion layout jumps to the _newest_ reply
  because unread is modelled per notification, not per comment. Wave modelled the
  finer thing and never surfaced it, which is the wrong half to have; this has
  the surfacing and the coarser state. Worth revisiting when a thread is long
  enough for the difference to bite.

- **Gallery** — a grid of image blips, captions under. One layout value and a
  small component; the cheapest thing on this list. Held back only to keep the
  first pass on templates honest about scope.
- **Meeting notes** — lanes Agenda · Discussed · Action · Parked. Nearly free.
  Not shipped because it overlaps Kanban closely enough that shipping both
  without a real use in front of us would be padding the picker — and, by the
  rule at the top of this document, because nobody has yet named a verb it
  offers that a board does not. It is now a lane set rather than a template.
- **Pipeline / CRM** — Lead · Contacted · Proposal · Won · Lost. Also nearly
  free, and also an argument _against_ itself: it is Kanban with different words.
  Two more near-identical boards was the point at which the answer stopped being
  "ship another template" and became **user-defined lanes**. That has now landed
  — see [Custom lanes](#custom-lanes) — so neither this nor Meeting notes is a
  template any more. Both are a Kanban board and one `set_radar_lanes` call.

### Needs a schema change first

- **Roadmap / timeline** — blips positioned by a date they are _for_, not the
  date they were captured. Needs an `occurred_at` column, date parsing on
  capture, and a horizontal layout. Real work, and it changes the keyset cursor
  if it ever becomes a sort key — the cursor now carries a rank as well, so that
  is a third key rather than a second.

  The decision log was considered as a first customer for that column — a
  decision is logged on a different day from when it was made — and deliberately
  passed over. Capture never asks for a field; that is the whole thesis. A
  "decided on" input would be exactly the ceremony the product refuses, and
  inferring a date from prose is a different piece of work with its own failure
  modes. `created_at` answers "when was this logged", which is honest, and the
  lane says the rest.

- **Habit tracker** — needs recurrence, which means a rule column and something
  that materialises occurrences. A different kind of object, not a template.

### Needs a new authorization axis

- **Feedback board with voting** — a public radar where strangers can upvote.
  Public access is read-only by construction today (`decide()` in
  `services/access.ts`: "a public link is read-only, always"). Adding anonymous
  writes is a security decision about the public surface, not a template, and it
  should be argued on its own rather than smuggled in behind one.

### Considered and rejected

- **Mind map / canvas** — free positioning of blips. It fights the product
  thesis: capture is cheap precisely because you do not choose where something
  goes. A canvas makes placement mandatory again.
- **Calendar month grid** — the bearing strip already answers "when did this
  radar get filled", and a month grid of capture dates answers a question nobody
  has. If it is wanted for _scheduled_ dates, that is the roadmap template above.

## Adding one

1. **Say what it lets you do.** If the answer is only "it has different lane
   names", stop — that is a lane vocabulary, and the right shape for that is
   [custom lanes](#custom-lanes), not a template. That is now a `set_radar_lanes`
   call rather than a thing to go and build, so the rule has teeth it did not
   have when it was written.
2. Declare it in `RADAR_TEMPLATES`. Give every lane a `state` — that is what
   keeps the board and the Inbox count from disagreeing — and declare the lanes
   in the order the page should read.
3. Pick an `order`. `captured` unless the radar is a queue you work through or a
   record you read from the top. Only a template with lanes may declare the
   other two, and `templates.test.ts` enforces that.
4. Pick `facets` and `capture`. Both are read by the shared card and composer;
   neither costs a component.
5. If `layout` is one that already exists, stop. It works everywhere: the
   picker, the lane control on each card, the lane rail, the MCP `lanes` output,
   and `read_radar` all read the registry.
6. Only if it needs a genuinely new shape, add one `layout` value and one
   component in `packages/ui/src/templates/`. That is allowed. A shape a list
   cannot draw is a real reason.

No migration is needed for lanes. `blips.status` is deliberately unconstrained in
SQL for exactly this reason — see `docs/DESIGN.md` §4.

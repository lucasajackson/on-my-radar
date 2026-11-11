/**
 * Radar templates.
 *
 * A template is what a radar *does* with its blips: the default is a
 * reverse-chronological stream, but a radar can also be a board, a microblog, a
 * reading queue or a decision log. This file is the single registry — the server
 * validates against it and the SPA renders from it, so adding a template is one
 * declaration here plus (only if it needs a bespoke layout) one view component.
 *
 * ## Why `status` and not `state`
 *
 * `blips.state` is the universal triage axis and it stays universal: inbox →
 * active → later → done → dropped, the same five values in every radar, which is
 * what makes cross-radar triage and `search_blips({state})` coherent.
 *
 * A template's lanes are a *second*, template-scoped axis stored in
 * `blips.status`. It is nullable, it has no CHECK constraint in SQL, and it is
 * validated here instead — so shipping a new template needs no migration.
 *
 * The two axes are kept honest by `state`: every status declares the triage state
 * a blip takes when it lands there, so moving a card to "Done" on a board also
 * empties it out of the Inbox count. One is where the work sits; the other is
 * whether the work is dealt with.
 */

import type { BlipState } from './domain.js';
import { isOwnKey } from './own.js';
import { listWithOr } from './prose.js';
import type { ClientStatus } from './helpdesk.js';

/** One lane of a template's own status axis. */
export interface BlipStatusDef {
  /** Stored verbatim in `blips.status`. */
  readonly id: string;
  readonly label: string;
  /**
   * Triage state a blip takes when it is moved into this lane, so the universal
   * Inbox count never disagrees with the board.
   */
  readonly state: BlipState;
  /** Terminal lanes are rendered quieter and sort last. */
  readonly terminal?: boolean;
  /**
   * On a client-facing template only: which of the six fixed client statuses a
   * request in this lane shows its client. The lane's own label never leaves On
   * My Radar. `validateLanes` requires it on every lane of such a template, and
   * refuses it anywhere else. See `helpdesk.ts`.
   */
  readonly clientStatus?: ClientStatus;
}

/**
 * How the SPA lays a radar out. A template that needs no bespoke view uses
 * 'stream' and gets the ordinary card list plus a lane control.
 */
export type RadarLayout =
  'stream' | 'board' | 'timeline' | 'log' | 'discussion' | 'architecture' | 'reader';

/**
 * The order a template reads its blips in, and the first place a template earns
 * its keep. Reverse-chronological is not a neutral default — it is a *choice*,
 * and it is the wrong one for two of the shapes below.
 *
 * - `captured`  — pinned, then newest first. Capture order: what On My Radar has
 *                 always done, and the right answer whenever the radar is a
 *                 record of what you thought and when.
 * - `queue`     — lane order, then **oldest first inside the lane**. A queue is
 *                 something you work through from the front; a reading list read
 *                 newest-first is a stack, and a stack is how a reading list
 *                 dies. This is what makes "the next thing to read" the thing at
 *                 the top of the page.
 * - `chronicle` — lane order, then newest first inside the lane. A log leads with
 *                 what is live and sinks what has been settled or replaced, so
 *                 the top of the page is the state of play rather than the most
 *                 recent edit to it.
 *
 * - `discussion` — lane order, then **most recently replied-to first**. The one
 *                 order in this application whose key is not a fact about the
 *                 blip itself: a thread rises when somebody answers it. A forum
 *                 sorted by capture time is a list of things nobody replied to,
 *                 which is the opposite of what a discussion radar is for.
 *
 * `queue`, `chronicle` and `discussion` all sort by lane first, which is why only
 * a template with lanes may declare them — asserted in templates.test.ts.
 *
 * ## What `discussion` costs, stated plainly
 *
 * Its activity key is **mutable**, and every other order here sorts on keys that
 * are not. The keyset stays *total* — every key runs the same direction and `id`
 * cannot tie, so no page can duplicate or skip a row that sits still — but a
 * thread somebody replies to mid-scroll genuinely moves, and can therefore be
 * met twice or missed. That is inherent to activity ordering rather than a
 * defect in the cursor, and it is the price every forum pays for the thing that
 * makes it a forum. It is called out here so nobody later reads the totality
 * guarantee as promising more than it does.
 */
export type StreamOrder = 'captured' | 'queue' | 'chronicle' | 'discussion';

/**
 * Extra meta a template's cards lead with.
 *
 * Declared here rather than branched on in the card, so a card never asks *which
 * template am I on* — it asks *which facets does my template want*. That is the
 * difference between an abstraction and a switch statement with extra steps.
 *
 * - `source`       — the link is the object, not an attachment to it: the host it
 *                    came from, and an open affordance, even when the blip also
 *                    carries a note and is therefore not `kind: 'link'`.
 * - `supersession` — this entry replaced one, or was replaced by one. The line
 *                    that makes a log a log rather than a list.
 * - `assignee`     — who holds the card, and whether it is claimed. Only on a template
 *                    that is `assignable`.
 * - `moved`        — who last moved the card between lanes. Only where there are lanes to
 *                    move between; a template that already says who ratified (a decision log)
 *                    does not need it.
 */
export type BlipFacet = 'source' | 'supersession' | 'assignee' | 'moved';

/**
 * How a picture is treated on this template's cards.
 *
 * Declared here for the same reason `facets` is, and to settle a conflation that
 * had been quietly wrong since the microblog shipped. `BlipCard` took one
 * `compact` flag meaning *this card is dense, drop the kind badge* — which is
 * what a board column wants — and forwarded it straight to `BlipAttachments`,
 * where it meant something else entirely: *a picture here is a thumbnail, not the
 * point*. The microblog set `compact` to lose the kind badge and got an 11rem
 * thumbnail it never asked for, hanging off the left margin under a serif post.
 * One flag, two meanings, and the second one silently applied to a surface where
 * it was the opposite of true.
 *
 * - `inline`  — the default. Shown whole, capped by height, left-aligned in the
 *               card's own text column. A picture attached to a thought.
 * - `thumb`   — a board card lives inside a column and is read as an index; the
 *               picture is a marker for the card, not the content of it.
 * - `feature` — **the picture is the post.** Centred and given the column's full
 *               width rather than hugging the left edge of it. A microblog whose
 *               photos are left-aligned thumbnails reads exactly as the product owner
 *               described it: like an afterthought.
 */
export type PhotoTreatment = 'inline' | 'thumb' | 'feature';

/**
 * What a template infers at capture time, over and above the universal rules.
 *
 * `linkFirst` is the one that matters: on a reading list the URL *is* the blip,
 * so "https://… — because Ben mentioned it" has to become a link with a note,
 * not a note that happens to contain a link. Everywhere else a body that is not
 * purely a URL is text, which is the honest reading of a stream.
 */
export interface TemplateCapture {
  readonly linkFirst?: boolean;
}

/**
 * What the conversation under a blip is *for* on this template.
 *
 * The axis exists because the same component has to serve two opposite
 * intentions. On a stream a comment is a remark about somebody's captured
 * thought, so the thread stays folded behind one hairline row — a capture app
 * must not charge rent on the surface whose whole thesis is that capture is
 * cheap. On a discussion radar the thread *is* the blip's content, and folding
 * it away hides the entire point of the radar.
 *
 * Declared here rather than branched on in `Conversation`, for the same reason
 * `facets` is: a component should ask *what does my template want*, never *which
 * template am I*.
 *
 * - `expanded`  — render the thread open, without waiting for a click.
 * - `threaded`  — a reply may answer a particular reply rather than the thread.
 *                 One level only; see `drizzle/0008_threads_and_mentions.sql`.
 * - `replyNoun` — what a contribution is called here. A discussion has replies;
 *                 everything else has comments, and calling a forum post a
 *                 "comment" is the sort of small wrongness that makes a template
 *                 feel like a relabelled stream.
 */
export interface TemplateConversation {
  readonly expanded?: boolean;
  readonly threaded?: boolean;
  readonly replyNoun?: string;
}

/**
 * Mail-style read state, declared by a template that is a reader. Which of its lanes means a
 * story has not been opened yet, and which one opening it files it in. Both are lane ids, so the
 * read state is the lane axis and moves `state` with it; no second flag exists to disagree.
 */
export interface TemplateReadState {
  readonly unread: string;
  readonly read: string;
}

export interface RadarTemplateDef {
  readonly id: string;
  readonly label: string;
  /** One line, shown in the picker. */
  readonly blurb: string;
  readonly layout: RadarLayout;
  /**
   * Whether this template can serve as an **undifferentiated inbox**: something
   * anything at all may be dropped into, and that you work down towards empty.
   *
   * Only the drop box reads this, and it reads it as a *refusal* — a drop box
   * may be a template that declares `inbox`, and no other. That is the one place
   * in the application where a radar's template is not the owner's free choice,
   * so it is worth saying why the restriction is real rather than fussy.
   *
   * A template is a set of opinions about what its blips *are*. That is its
   * whole value everywhere else, and it is exactly what the drop box cannot
   * afford. A reading list decides the URL is the object, so an appointment
   * captured there arrives shaped like something to read. A decision log frames
   * every entry as a choice with a rationale and offers to record what replaced
   * it; "call the plumber" is neither. A microblog is a place you publish to,
   * and the drop box is the one radar whose contents you have explicitly not
   * decided anything about yet. A discussion turns each blip into a thread
   * waiting for replies that are never coming, and sorts by a reply that never
   * arrives.
   *
   * What the two remaining templates have in common is that neither of them
   * claims to know what a blip is. A stream says only *when*; a board says only
   * *how far along*. Both are things you empty. That is the property, and a
   * sixth template that has it should declare `inbox: true` and need no other
   * change anywhere — which is the reason this is a declared property and not a
   * pair of ids written into the service layer.
   *
   * Not constrained in SQL, for the same reason `blips.status` is not: the
   * vocabulary lives here so that a new template is one declaration and no
   * migration. See `drizzle/0011_drop_box_is_private.sql`, which says so.
   */
  readonly inbox: boolean;
  /**
   * Whether a card here can have an assignee and be claimed (`claim_blip`). A behaviour of the
   * template, declared and never branched on by id. Revision checks are not part of it: they are
   * integrity and stay universal. A stored claim or assignee on a radar that later moves to a
   * non-assignable template is ignored at read time, never deleted (as lanes are).
   */
  readonly assignable: boolean;
  /** Ordered lanes. Empty means this template has no status axis at all. */
  readonly statuses: readonly BlipStatusDef[];
  /** Lane a newly captured blip lands in. Null when there are no lanes. */
  readonly defaultStatus: string | null;
  /** Placeholder for the capture box — the voice differs per template. */
  readonly capturePlaceholder: string;
  /** Whether the triage chips belong here. A board already shows its lanes. */
  readonly showTriage: boolean;
  /** How the blips are ordered. See `StreamOrder`. */
  readonly order: StreamOrder;
  /**
   * Whether the lanes belong above the list as a filter rail.
   *
   * A board draws its lanes as columns and must not say it twice; a stream that
   * has lanes has nowhere else to put them, and without this its lanes are
   * reachable only through a per-card dropdown — declared and invisible, which
   * is exactly how a template ends up feeling like every other one.
   */
  readonly laneFilter: boolean;
  /** Meta the cards lead with. Read by the shared card; never branched on by id. */
  readonly facets: readonly BlipFacet[];
  /** How a picture is drawn here. Absent means `inline`. */
  readonly photos?: PhotoTreatment;
  /**
   * Whether this template offers the day-rule grouping control.
   *
   * A registry property rather than a `template === 'microblog'` check in the
   * settings dialog, which is what it was — the same rule `bb602ab` established
   * for lanes, orders and facets. A shared component asks *what does my template
   * want*, never *which template am I*.
   */
  readonly grouping?: boolean;
  /**
   * Whether this template's reading surface may be themed. Absent means yes.
   *
   * A registry property rather than a `template === 'microblog'` branch, which
   * is how the theme picker would otherwise have to find its way onto the one
   * template the product owner asked about. Themeability is not a microblog fact — a public
   * stream is just as much somebody's page — so it defaults on and a template
   * opts *out* when its chrome is load-bearing.
   *
   * The kanban board is the one that opts out today: its columns read as columns
   * because of the application's own frame around them, and the spacing axis
   * fights a layout whose density is functional rather than decorative. See
   * docs/TEMPLATES.md.
   */
  readonly themeable?: boolean;
  /** Capture rules over and above the universal ones. */
  readonly capture: TemplateCapture;
  /**
   * Whether blips here take comments. Absent means yes. A property of the template, folded into
   * the radar's `commentsEnabled` by `commentsAllowed`, so every surface and the write path
   * agree; a reader's story is not a thought to answer.
   */
  readonly comments?: boolean;
  /** Mail-style read state over two of this template's lanes. See `readStateFor`. */
  readonly readState?: TemplateReadState;
  /**
   * What the thread under a blip is for here. Absent means the default: folded
   * away until asked for, flat, and called a comment.
   */
  readonly conversation?: TemplateConversation;
  /**
   * The lane that means "replaced", if this template has one. Superseding a blip
   * files the old one here, which is the whole point of recording the link: the
   * log re-sorts itself the moment you say what replaced what.
   */
  readonly supersededStatus?: string;
  /**
   * The lane that means "in force". When set, supersession is **deferred**: the
   * link is recorded when the replacement is written, but the replaced blip is
   * filed (into `supersededStatus`) only when the replacement enters this lane,
   * which also stamps `blips.ratified_at` once. Only a blip in this lane can be
   * superseded.
   */
  readonly ratifiedStatus?: string;
  /**
   * The legal lane moves, by lane id. A lane with no entry is final: nothing
   * leaves it, and a lane that nothing lists as a target can never be moved into.
   * Absent means every move is legal (every other template).
   */
  readonly transitions?: Readonly<Record<string, readonly string[]>>;
  /**
   * Lanes that hold structural elements (boundaries, contracts) instead of
   * decisions. Nothing is captured or moved into them by hand: the template's
   * verbs write them (`upsert_boundary`, `upsert_contract`), and no transition
   * leads in or out.
   */
  readonly elementLanes?: readonly string[];
  /** False when the lane vocabulary is part of the template's meaning. Absent means true. */
  readonly customLanes?: boolean;
  /**
   * Whether finished blips on this template **age out of the radar** — stop
   * being loaded, and stop being counted, once nothing has happened to them for
   * the radar's window.
   *
   * Declared per template and never applied globally, because the same act
   * means opposite things on different shapes. A board drops the boundary a
   * sprint used to provide, so its Done column grows forever by construction. A
   * decision log's rejected and superseded entries **are the artifact** —
   * archiving them would delete the thing the template exists to keep, which is
   * why this is opt-in and why the setting does not render for a template that
   * has not asked for it.
   *
   * The axis is visibility and nothing else. Archiving writes **nothing** — it
   * is computed from the row's own activity, and it touches neither `state` nor
   * `status` — so a resurrected blip is still exactly where it was filed,
   * because it never left. See `archive.ts` and `docs/DESIGN.md` §25.
   */
  readonly archives?: boolean;
  /**
   * Whether a radar on this template has a **client side**: it is the one kind
   * of radar whose content is meant to reach somebody outside On My Radar,
   * through an integration that sees only a narrowed projection of it
   * (`docs/HELPDESK.md`).
   *
   * Two rules follow, both decided from this flag rather than from a template id:
   *
   * - **Never public.** A public link would hand every internal note about a
   *   client to anybody holding the URL. The service refuses it on every path
   *   that could produce one, and a CHECK constraint stands behind the service.
   * - **Every lane names a `clientStatus`**, because a lane label is a
   *   vocabulary an agent may rename and must never be what a client reads.
   *
   * It is deliberately **not** owner-only. Internal collaborators — someone who
   * works a client's site with the product owner — may be invited like on any radar, and see
   * internal notes like any member; the share dialog says so. What must never
   * happen is a *client* holding a share: their only door is the portal
   * (decision 5, `docs/HELPDESK.md` §11). On My Radar cannot tell a client from
   * a collaborator by their address, so that line is the person's, stated
   * before the click rather than enforced after it.
   */
  readonly clientFacing?: boolean;
  /**
   * What answering a decision request does here. A request is universal (any card can ask a person
   * to decide, like a comment); this only declares that, for a card in lane `from`, the options
   * are the `outcomes` lanes and the answer moves the card into one through the template's own
   * rules (ratification, supersession). Absent means the options are free text and an answer
   * changes nothing. Read through `decidesFor`, never by template id; a request on a radar that
   * stops declaring it, or whose card has left `from`, reads as overtaken and is never deleted.
   */
  readonly decides?: { readonly from: string; readonly outcomes: readonly string[] };
}

export const RADAR_TEMPLATES = {
  stream: {
    id: 'stream',
    label: 'Stream',
    blurb: 'The default. Newest first, pinned on top, triage by state.',
    layout: 'stream',
    inbox: true,
    assignable: false,
    statuses: [],
    defaultStatus: null,
    capturePlaceholder: 'Drop a blip…  #tag it, paste a link, or drag a file in',
    showTriage: true,
    // The null template, and deliberately so: it is the baseline the others are
    // measured against. Nothing inferred beyond the universal rules, nothing
    // ordered beyond capture order, no facet on the card. If a change would make
    // the stream cleverer, it belongs on a template, not here.
    order: 'captured',
    laneFilter: false,
    facets: [],
    capture: {},
  },

  kanban: {
    id: 'kanban',
    label: 'Kanban',
    blurb: 'A board. Blips become cards you move between columns.',
    layout: 'board',
    inbox: true,
    assignable: true,
    statuses: [
      { id: 'backlog', label: 'Backlog', state: 'inbox' },
      { id: 'todo', label: 'To do', state: 'later' },
      { id: 'doing', label: 'In progress', state: 'active' },
      { id: 'blocked', label: 'Blocked', state: 'active' },
      { id: 'done', label: 'Done', state: 'done', terminal: true },
    ],
    defaultStatus: 'backlog',
    capturePlaceholder: 'Add a card…  it lands in Backlog',
    showTriage: false,
    // A column is already sorted by being a column, and the lane strip above it
    // is already the filter. Both would be said twice.
    order: 'captured',
    laneFilter: false,
    facets: ['assignee', 'moved'],
    // A card in a column is read as an index entry. The picture marks the card;
    // it is not what the card is for.
    photos: 'thumb',
    // The only template that opts out of theming. A board's columns read as
    // columns because of the frame around them, and its density is functional.
    themeable: false,
    // The motivating case. A sprint board never accumulates because the sprint
    // ends and Done is wiped; Kanban drops that boundary and keeps nothing to
    // put it back.
    archives: true,
    capture: {},
  },

  /**
   * Post-shaped, and the one template routinely read by somebody with no
   * account. That is what earns it the two properties the others do not have.
   *
   * `photos: 'feature'` because here the picture *is* the post. The default
   * treatment left-aligns a picture inside the card's text column, which is
   * right for a photo attached to a thought and wrong for a photo that is one.
   *
   * `grouping` because a microblog is the only shape where "where did one day
   * end and the next begin" is a question worth answering — it is what turns the
   * same surface into a diary. Declared here rather than checked as
   * `template === 'microblog'` in the settings dialog, which is what it was.
   */
  microblog: {
    id: 'microblog',
    label: 'Microblog',
    blurb: 'Post-shaped. No triage chrome — good public, good as a diary.',
    layout: 'timeline',
    inbox: false,
    assignable: false,
    statuses: [],
    defaultStatus: null,
    capturePlaceholder: "What's happening?",
    showTriage: false,
    order: 'captured',
    laneFilter: false,
    facets: [],
    photos: 'feature',
    grouping: true,
    capture: {},
  },

  /**
   * Things from elsewhere you intend to consume.
   *
   * What makes it a reading list and not a stream with different words in a
   * dropdown: it is ordered as a **queue** (front of the unread lane first, not
   * newest first), the URL is the object rather than an attachment to it, and
   * capture pulls the link out of a body that also carries your reason for
   * saving it. The verbs are queue it, open it, finish it.
   *
   * It is a **reader** now: newest first by capture date, a story opens
   * full-screen, and opening it files it as read (`readState`), as in mail. The
   * `queue` order is no longer used by any shipped template.
   */
  reading: {
    id: 'reading',
    label: 'Reading list',
    blurb: 'A reader for what you save. Newest first; opening a story marks it read.',
    layout: 'reader',
    inbox: false,
    assignable: false,
    statuses: [
      { id: 'unread', label: 'Unread', state: 'inbox' },
      { id: 'reading', label: 'Reading', state: 'active' },
      { id: 'finished', label: 'Finished', state: 'done', terminal: true },
      { id: 'abandoned', label: 'Abandoned', state: 'dropped', terminal: true },
    ],
    defaultStatus: 'unread',
    capturePlaceholder: 'Paste a link…  add a line about why, if you like',
    showTriage: false,
    order: 'captured',
    // The Unread / All toggle (`readState`) is this template's filter; a lane rail would say it twice.
    laneFilter: false,
    facets: ['source', 'moved'],
    // `finished` / `abandoned` is done/dropped wearing different words, and a
    // queue you have worked through is exactly the thing that should shorten.
    archives: true,
    capture: { linkFirst: true },
    comments: false,
    // 'reading' rather than 'finished': opening a story must not start the archive clock.
    readState: { unread: 'unread', read: 'reading' },
  },

  /**
   * A record of choices and the reasoning behind them.
   *
   * What makes it a log and not a stream: entries are never "done", they are in
   * force or they have been **replaced**, and the entry that replaced one points
   * at it. Supersession is the verb the other templates do not have, and it is
   * what re-sorts the log — a superseded entry files itself into its terminal
   * lane and sinks below what is live. The layout is a ledger grouped by lane
   * rather than a flat list, because a decision log read as a flat list is
   * indistinguishable from a stream, which is precisely the complaint.
   */
  decisions: {
    id: 'decisions',
    label: 'Decision log',
    blurb: 'A ledger of choices and why. Live entries first; replaced ones sink.',
    layout: 'log',
    inbox: false,
    assignable: false,
    statuses: [
      { id: 'proposed', label: 'Proposed', state: 'inbox' },
      { id: 'accepted', label: 'Accepted', state: 'done' },
      { id: 'rejected', label: 'Rejected', state: 'dropped', terminal: true },
      { id: 'superseded', label: 'Superseded', state: 'done', terminal: true },
    ],
    defaultStatus: 'proposed',
    capturePlaceholder: 'What is being decided, and why?',
    showTriage: false,
    order: 'chronicle',
    laneFilter: true,
    facets: ['supersession'],
    capture: {},
    supersededStatus: 'superseded',
    decides: { from: 'proposed', outcomes: ['accepted', 'rejected'] },
  },

  /**
   * An application's architecture: a charter, amended by ADRs.
   *
   * Pages of the charter are blips in the `charter` lane; ADRs are blips in the
   * decision lanes. An accepted ADR strikes the text it amends (the anchor is a
   * marker in the page source, see `amend.ts`). Ratifying is a lane move the
   * registry polices: proposed to accepted or rejected, accepted to repealed.
   */
  architecture: {
    id: 'architecture',
    label: 'Architecture',
    blurb: 'A charter and the ADRs that amend it. Struck text, with the reason.',
    layout: 'architecture',
    inbox: false,
    assignable: false,
    statuses: [
      { id: 'charter', label: 'Charter', state: 'active' },
      { id: 'proposed', label: 'Proposed', state: 'inbox' },
      { id: 'accepted', label: 'Accepted', state: 'done' },
      { id: 'rejected', label: 'Rejected', state: 'dropped', terminal: true },
      { id: 'repealed', label: 'Repealed', state: 'done', terminal: true },
      // Last, because the stream is in lane order and pages: a radar with 40
      // boundaries and 26 contracts must not push its ADRs off the first page.
      { id: 'boundary', label: 'Boundaries', state: 'active' },
      { id: 'contract', label: 'Contracts', state: 'active' },
    ],
    defaultStatus: 'proposed',
    capturePlaceholder: 'What is being decided, and why?',
    showTriage: false,
    order: 'chronicle',
    laneFilter: false,
    facets: ['supersession'],
    capture: {},
    supersededStatus: 'repealed',
    ratifiedStatus: 'accepted',
    transitions: { proposed: ['accepted', 'rejected'], accepted: ['repealed'] },
    elementLanes: ['boundary', 'contract'],
    customLanes: false,
    decides: { from: 'proposed', outcomes: ['accepted', 'rejected'] },
  },

  /**
   * A place to talk, rather than a place to keep things.
   *
   * **A blip here is a thread**, and its comments are the replies. That is the
   * decision the whole template rests on, and it is what makes it cost so little:
   * a blip already has a conversation, non-owners can already join it on a shared
   * radar, and `requireParticipation` already decides who may. What was missing
   * was never storage — it was that the conversation was folded away behind a
   * hairline row, flat, ordered by capture, and called a comment.
   *
   * What it lets you do that a stream does not — the test every template has to
   * pass:
   *
   * - **Reply to a particular reply.** One level, so Ben answering Ada is visible
   *   as such without a thread turning into a staircase.
   * - **Read without unfolding.** The thread renders open, because on this
   *   template it is the content rather than an aside about it.
   * - **See what is actually moving.** `order: 'discussion'` floats the
   *   thread somebody just answered to the top. A forum in capture order is a
   *   list of things nobody replied to.
   * - **Resolve one.** Two lanes and no more: it is Open, or it is Resolved.
   *
   * ## What was taken from Google Wave, and what was refused
   *
   * Wave's conversation model (Gregorio & North, Oct 2009) was structurally
   * sound. What killed it as an interface was one specific thing, and it is
   * worth naming precisely rather than as "it was confusing": **arbitrary-depth,
   * arbitrary-position insertion destroyed the correspondence between position
   * and recency, and Wave never shipped the affordance that would have
   * compensated.** Jon Stokes at Ars Technica, on why his team abandoned it: it
   * "was really not obvious how to spot the newest messages, because they could
   * be nested somewhere deep in the middle (or, the 'trough') of a long wave."
   * Martin Seibert put the other half in one line — "there are no means of
   * monitoring waves. This is Google Wave's biggest weakness."
   *
   * **Taken — a conversation and a document are the same object.** A blip here is
   * a full markdown body with attachments and it is *also* the head of a thread.
   * You do not start a discussion *about* a thought; the thought is the
   * discussion.
   *
   * **Taken — Wave's continuation/reply distinction.** In the spec, sibling blips
   * inside one thread are continuations and are not indented; a new thread under
   * a blip is a reply and is. That distinction is exactly right and it is the one
   * borrowed here: top-level replies run flat as continuations of the thread,
   * and answering a particular reply indents once. Bounded at one level, which is
   * where Wave left it unbounded.
   *
   * **Refused — unbounded depth and arbitrary insertion position.** The trough,
   * above. A first-hand account describes Wave's ordering rule as unlearnable:
   * the first reply followed the replied-to text unindented, and later replies
   * were inserted *above* it, indented. At around three hundred blips the
   * scrollbar stopped working.
   *
   * Slack arrived at the same conclusion independently — their design write-up
   * compares against Facebook, Twitter, Reddit, YouTube and email, and never
   * mentions Wave at all. They built arbitrary-depth replies rendered in the main
   * flow, spent six internal versions on it, and Hubert Florin's account of the
   * fix is unusually blunt: "Because you could reply to any message, including
   * replies, Threads quickly became extremely complex… we decided to restrict
   * each thread to only one level of replies… Reducing each thread to only one
   * level of replies was an instant success on all fronts." Google Docs comments
   * ended up in the same place again: one reply level, anchored, in a gutter
   * rather than in the flow.
   *
   * That these are *convergent* rather than derivative is what makes them worth
   * citing. Nobody was repeating anybody's homework — separate teams built the
   * unbounded version and separately found that position stops meaning recency.
   * One level, appended in time order, is learnable in a glance and survives a
   * 390px viewport.
   *
   * **Already true here — a reply never competes with the radar's own flow.**
   * Slack's second finding was subtler than the depth cap and they call it the
   * more important one: "Hiding replies from the channel content turned out to be
   * the single most meaningful change we made." Before it, people replied in a
   * thread on the newest message when a plain message would have been identical,
   * because there was no felt difference between the two acts.
   *
   * On My Radar gets that by construction rather than by design work: **a reply
   * is not a blip.** Comments live in their own table and the radar lists blips,
   * so a reply can never appear in the stream, and starting a thread and
   * answering one are different verbs with different tools — `create_blip`
   * against `create_comment`. Nothing had to be hidden, because nothing was ever
   * in there.
   *
   * **Refused — live character-by-character typing.** On the product's own terms
   * this is the weakest of the refusals and it is worth being honest about that.
   * The press consensus was that it felt surveillant, but Google's own published
   * user research (Aaron Cheang, Nov 2009) lists only three dislikes —
   * invitations, integration with other tools, and speed — and live typing is not
   * among them. Either the press amplified a minority irritation or the
   * instrument missed it; there is no way to settle that from here, and no
   * peer-reviewed work on keystroke-level transmission to appeal to either. So
   * this is refused on a *product* argument rather than an evidential one:
   * transmitting a half-typed thought makes composing it a performance, and this
   * application's entire thesis is that capture is cheap precisely because
   * nobody is watching. Whether the machinery itself has descendants is a claim
   * often made and nowhere documented — no Google engineer has publicly tied
   * Docs' editing to Wave — so it is left alone here. What is observable is that
   * character-level presence is welcome in document products and contested in
   * conversational ones, and this is a conversational one.
   *
   * **Refused — playback, and the lesson underneath it.** Wave shipped the
   * history-replay view rather than the what-changed view, and the two are far
   * less alike than they look: playback is a linear scrub over an operation log,
   * while "what happened since I last looked" is a set difference against read
   * state.
   *
   * The sharp part is that Wave *had* both. It modelled per-user read state as a
   * first-class object and it did ship unread navigation — as a spacebar
   * shortcut, published as a numbered tip in a blog post ("Ten tips for waving",
   * Feb 2010). Users still overwhelmingly reported being unable to tell what was
   * new; Seibert wrote that there were "no means of monitoring waves" while the
   * means existed. **An affordance nobody can see is not an affordance**, and
   * that is a rendering lesson rather than an architectural one — which is
   * exactly the kind that gets missed, because the data model looks complete.
   *
   * So: this application already ships the set difference as notifications with
   * unread badges and an Activity screen, and the discussion layout must put its
   * jump-to-newest control **on screen, next to the thread it applies to**. Not a
   * hotkey, not a tip. See the note on the trough below.
   *
   * **Refused — everybody editing everybody's words.** Already settled here and
   * unchanged: an owner may delete somebody else's remark, never rewrite it.
   * Every successor to Wave made authorship immutable, and every one of them
   * added *resolve* rather than relying on delete — which is what the `resolved`
   * lane below is, arrived at before the precedent was known.
   *
   * **Refused — new vocabulary.** Wave asked people to learn waves, wavelets,
   * blips and pings, and reviewers still used "wavelet" to mean the wrong thing
   * because it never appeared in the UI. This template introduces two words
   * everybody already owns: thread and reply. (That On My Radar calls its unit a
   * "blip" is convergence, not borrowing — it predates this template and means a
   * captured thought.)
   *
   * ## The trough, and why this template does not have one
   *
   * Refusing depth is only half an answer; Wave's other half was having no way to
   * find what was new. This application already shipped that half — notifications
   * with unread badges, deep-linking to the blip. What the template adds is the
   * ordering: `order: 'discussion'` floats the thread that was answered most
   * recently to the top of the radar, so the newest words in the whole radar are
   * always in the first thread on the page. Within a thread, replies stay in time
   * order — a conversation is a thing you read forwards — and the header offers a
   * jump to the newest one, so a long thread never has to be scrolled to find its
   * own end.
   *
   * "It doesn't need to be complicated" was the brief, and Wave is the argument
   * for taking it literally.
   */
  discussion: {
    id: 'discussion',
    label: 'Discussion',
    blurb: 'Threads people reply to. Whatever was answered last sits at the top.',
    layout: 'discussion',
    inbox: false,
    assignable: false,
    statuses: [
      // Not 'inbox'. A discussion is open because people are in it, not because
      // nobody has looked at it yet — and starting one is itself the triage
      // decision, so filing every new thread into somebody's Inbox count would
      // be counting the same act twice.
      { id: 'open', label: 'Open', state: 'active' },
      { id: 'resolved', label: 'Resolved', state: 'done', terminal: true },
    ],
    defaultStatus: 'open',
    capturePlaceholder: 'Start a discussion…  what do you want to talk about?',
    showTriage: false,
    order: 'discussion',
    laneFilter: true,
    facets: [],
    capture: {},
    conversation: { expanded: true, threaded: true, replyNoun: 'reply' },
  },

  /**
   * Client requests for one site: a board whose cards are requests and whose
   * lanes each say what the client is shown.
   *
   * What it lets you do that a kanban does not — the test every template has to
   * pass (`docs/TEMPLATES.md`, "Adding one"):
   *
   * - **Be worked from outside, safely.** It is the only template with a client
   *   side, so it is the only one that can never be published (`clientFacing`).
   *   Comment visibility (internal notes, drafts held for the owner's review,
   *   released replies) reads exactly this flag; later slices add the portal
   *   projection and the waiting-on-client clock on top of it.
   * - **Say one fixed thing to the client per lane.** Each lane maps to one of
   *   six client statuses whose words live in the contract, so renaming a lane
   *   can never change what a client reads.
   *
   * The lane ids are the ones the first eight helpdesk radars were given as a
   * custom Kanban vocabulary on 2026-10-02, so moving them here strands nothing.
   * `inbox: false` because a drop box is the one radar nobody else may ever
   * write into, and this is the radar that exists to be written into from
   * outside.
   */
  helpdesk: {
    id: 'helpdesk',
    label: 'Helpdesk',
    blurb:
      'Client requests for one site. Never public; each lane says one fixed thing to the client.',
    layout: 'board',
    inbox: false,
    assignable: true,
    statuses: [
      { id: 'new', label: 'New', state: 'inbox', clientStatus: 'received' },
      { id: 'scheduled', label: 'Scheduled', state: 'later', clientStatus: 'scheduled' },
      { id: 'in-progress', label: 'In progress', state: 'active', clientStatus: 'in_progress' },
      {
        id: 'waiting-on-client',
        label: 'Waiting on client',
        state: 'active',
        clientStatus: 'waiting_on_you',
      },
      {
        id: 'resolved',
        label: 'Resolved',
        state: 'done',
        terminal: true,
        clientStatus: 'resolved',
      },
      {
        id: 'declined',
        label: 'Declined',
        state: 'dropped',
        terminal: true,
        clientStatus: 'declined',
      },
    ],
    defaultStatus: 'new',
    capturePlaceholder: 'Add a request…  it lands in New',
    showTriage: false,
    order: 'captured',
    laneFilter: false,
    facets: ['assignee', 'moved'],
    photos: 'thumb',
    // A board, for the reason kanban gives: its columns are functional chrome.
    themeable: false,
    // Resolved requests would otherwise pile up in the board forever.
    archives: true,
    capture: {},
    clientFacing: true,
  },
} as const satisfies Record<string, RadarTemplateDef>;

export type RadarTemplate = keyof typeof RADAR_TEMPLATES;
export const RADAR_TEMPLATE_IDS = Object.keys(RADAR_TEMPLATES) as RadarTemplate[];

/**
 * The templates whose blips age out, derived rather than listed — the server
 * builds its SQL predicate straight from this, so the registry stays the one
 * place the question is answered. Same argument as `DROP_BOX_TEMPLATE_IDS`.
 */
export const ARCHIVING_TEMPLATE_IDS: readonly RadarTemplate[] = (
  Object.keys(RADAR_TEMPLATES) as RadarTemplate[]
).filter((id) => archivesFor(id));
export const DEFAULT_RADAR_TEMPLATE: RadarTemplate = 'stream';

export function isRadarTemplate(value: unknown): value is RadarTemplate {
  return isOwnKey(RADAR_TEMPLATES, value);
}

/* ------------------------------- the drop box ----------------------------- */

/**
 * The templates a drop box may take, derived rather than listed.
 *
 * Both the SPA's picker and the server's refusal read this, so there is exactly
 * one answer to "may a drop box be a reading list" and it is `inbox` on the
 * template. Adding an inbox-capable template changes both surfaces and touches
 * neither.
 */
export const DROP_BOX_TEMPLATE_IDS: readonly RadarTemplate[] = RADAR_TEMPLATE_IDS.filter(
  (id) => RADAR_TEMPLATES[id].inbox,
);

/**
 * What a freshly provisioned drop box is.
 *
 * The stream, and not the board — even though the board is equally permitted.
 * A board asks which column before it will take a card, and the drop box exists
 * precisely for the thoughts you have not decided anything about yet; making the
 * first act of capture a filing decision is the friction the whole feature was
 * built to remove. Somebody who wants to work their inbox as a board switches to
 * one and that is a considered choice, which is the right way round.
 */
export const DEFAULT_DROP_BOX_TEMPLATE: RadarTemplate = 'stream';

/**
 * Whether a drop box may use this template.
 *
 * Deliberately strict where `templateFor` is lenient: an id the registry does
 * not know degrades to the stream *for rendering*, because an unknown template
 * must never produce an error page. It must not degrade for a *refusal* — that
 * would make an unrecognised id a way past the rule rather than a reason to
 * refuse it.
 */
export function isDropBoxTemplate(id: string | null | undefined): boolean {
  return isRadarTemplate(id) && RADAR_TEMPLATES[id].inbox;
}

/** "Stream or Kanban" — for the sentence a refusal hands back. Registry-derived. */
export function dropBoxTemplateLabels(): string {
  const labels = DROP_BOX_TEMPLATE_IDS.map((id) => RADAR_TEMPLATES[id].label);
  return listWithOr(labels);
}

/**
 * Never throws: an unknown template id degrades to the stream, not to an error
 * page.
 *
 * With a `config` carrying lanes it returns the template **as this radar has
 * it** — the registry definition with its lane vocabulary substituted. Every
 * other helper in this file goes through here, so a radar's own lanes are read
 * by the board, the lane rail, the card menu, the cursor and the MCP output
 * without any of them knowing that an override is possible. See `lanes.ts` for
 * what a caller must satisfy before storing one.
 *
 * A stored lane set that no longer makes sense — because the radar was moved to
 * a template with no lane axis — is **ignored rather than applied**. Degrading
 * is the same rule an unknown template id already follows, and for the same
 * reason: a radar must stay readable.
 */
export function templateFor(
  id: string | null | undefined,
  config?: TemplateConfig | null,
): RadarTemplateDef {
  const base = isRadarTemplate(id) ? RADAR_TEMPLATES[id] : RADAR_TEMPLATES[DEFAULT_RADAR_TEMPLATE];
  const lanes = config?.lanes;
  if (
    !lanes?.length ||
    base.statuses.length === 0 ||
    (base as RadarTemplateDef).customLanes === false
  )
    return base;
  const defaultStatus =
    config?.defaultStatus && lanes.some((lane) => lane.id === config.defaultStatus)
      ? config.defaultStatus
      : (lanes[0]?.id ?? null);
  return { ...base, statuses: lanes, defaultStatus };
}

export function statusesFor(
  templateId: string | null | undefined,
  config?: TemplateConfig | null,
): readonly BlipStatusDef[] {
  return templateFor(templateId, config).statuses;
}

export function findStatus(
  templateId: string | null | undefined,
  statusId: string | null | undefined,
  config?: TemplateConfig | null,
): BlipStatusDef | null {
  if (!statusId) return null;
  return statusesFor(templateId, config).find((s) => s.id === statusId) ?? null;
}

/**
 * The lane a blip should sit in, given what the caller asked for and what the
 * template allows. A status the template does not know is not an error — a radar
 * can be switched from kanban to stream and back, and the stored value has to
 * survive that without blocking an unrelated edit.
 */
export function resolveStatus(
  templateId: string | null | undefined,
  requested: string | null | undefined,
  existing: string | null = null,
  config?: TemplateConfig | null,
): string | null {
  const template = templateFor(templateId, config);
  if (template.statuses.length === 0) return null;
  if (requested !== undefined && requested !== null) {
    return findStatus(templateId, requested, config) ? requested : null;
  }
  if (existing && findStatus(templateId, existing, config)) return existing;
  return template.defaultStatus;
}

/**
 * The lane that best represents a triage state, or null when the template has
 * none for it.
 *
 * This is deliberately *not* an inverse of `BlipStatusDef.state` — there isn't
 * one. Several lanes can imply the same state (a Kanban card is `active`
 * whether it is Doing or Blocked), so the mapping only goes one way cleanly.
 * What this gives is a repair: when a blip's triage state is set directly and
 * the lane it sits in now contradicts that state, this is where it should move
 * to instead. Callers must check the current lane first — otherwise a blocked
 * card that is merely re-confirmed `active` would be dragged into Doing.
 *
 * First declared match wins, so a template orders its lanes most-canonical
 * first for any state it repeats.
 */
export function laneForState(
  templateId: string | null | undefined,
  state: BlipState,
  config?: TemplateConfig | null,
): BlipStatusDef | null {
  return statusesFor(templateId, config).find((lane) => lane.state === state) ?? null;
}

/* ------------------------------- the axes -------------------------------- */

/** How this template's blips are ordered. Unknown template ids read as capture order. */
export function orderFor(templateId: string | null | undefined): StreamOrder {
  return templateFor(templateId).order;
}

/** How this template draws a picture. Unknown template ids read as `inline`. */
export function photosFor(templateId: string | null | undefined): PhotoTreatment {
  return templateFor(templateId).photos ?? 'inline';
}

/** Whether this template offers the day-rule grouping control. */
export function hasGrouping(templateId: string | null | undefined): boolean {
  return templateFor(templateId).grouping === true;
}

/**
 * Whether this template's reading surface may be themed. Defaults on; a template
 * opts out. An unknown template id reads as the stream, which is themeable.
 */
export function isThemeable(templateId: string | null | undefined): boolean {
  return templateFor(templateId).themeable !== false;
}

/**
 * Whether finished blips on this template age out. Defaults **off**; a template
 * opts in. An unknown template id reads as the stream, which does not archive —
 * so a radar created by a future build can never have its blips silently hidden
 * by this one.
 */
export function archivesFor(templateId: string | null | undefined): boolean {
  return templateFor(templateId).archives === true;
}

/**
 * Whether a template has a client side, and therefore may never be public.
 * Strict like `isDropBoxTemplate`: an unknown id is not a registry template at
 * all, and degrades to the stream for rendering.
 */
export function isClientFacingTemplate(id: string | null | undefined): boolean {
  return isRadarTemplate(id) && (RADAR_TEMPLATES[id] as RadarTemplateDef).clientFacing === true;
}

/** The client-facing templates, derived rather than listed. */
export const CLIENT_FACING_TEMPLATE_IDS: readonly RadarTemplate[] = RADAR_TEMPLATE_IDS.filter(
  (id) => isClientFacingTemplate(id),
);

/** Whether a card on this template can be assigned and claimed. Unknown ids read as the stream. */
export function assignableFor(templateId: string | null | undefined): boolean {
  return templateFor(templateId).assignable;
}

/** Whether blips on this template take comments. Absent means yes. */
export function commentsAllowed(templateId: string | null | undefined): boolean {
  return templateFor(templateId).comments !== false;
}

/**
 * The read/unread lanes of a reader, or null when the template declares none or the radar's own
 * lanes no longer include both (custom lanes), in which case there is simply no read state.
 */
export function readStateFor(
  templateId: string | null | undefined,
  config?: TemplateConfig | null,
): TemplateReadState | null {
  const { readState, statuses } = templateFor(templateId, config);
  const has = (id: string) => statuses.some((lane) => lane.id === id);
  return readState && has(readState.unread) && has(readState.read) ? readState : null;
}

/** Whether a template's cards lead with a given facet. The card asks this, never "which template". */
export function hasFacet(templateId: string | null | undefined, facet: BlipFacet): boolean {
  return templateFor(templateId).facets.includes(facet);
}

/**
 * What the thread under a blip is for on this template.
 *
 * Always returns a whole answer rather than `undefined`, so the conversation
 * components read four settled values instead of writing the defaults out again
 * at each of their call sites — which is exactly how two of them end up
 * disagreeing about what "no declaration" meant.
 */
export function conversationFor(
  templateId: string | null | undefined,
): Required<TemplateConversation> & { replyNounPlural: string; visibility: boolean } {
  const declared = templateFor(templateId).conversation ?? {};
  const noun = declared.replyNoun ?? 'comment';
  return {
    expanded: declared.expanded ?? false,
    threaded: declared.threaded ?? false,
    // Whether the composer offers "Reply to client" and rows carry a visibility
    // label. Derived from `clientFacing` rather than declared beside it, because
    // the server accepts a client-visible comment on exactly those radars
    // (`docs/HELPDESK.md` §7.2) and two flags could disagree.
    visibility: isClientFacingTemplate(templateId),
    replyNoun: noun,
    // Derived rather than declared a second time, so a template cannot ship a
    // noun whose plural was forgotten — but derived by a rule that is actually
    // right, because the first noun to use this is "reply" and `reply + s` is
    // not a word. Consonant + y takes -ies; everything else takes -s.
    replyNounPlural: /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`,
  };
}

/**
 * Where a lane sits in its template's running order — declaration index, with
 * anything unlaned sorted after every lane.
 *
 * Declaration order is doing real work here rather than being incidental: a
 * reading list declares unread → reading → finished → abandoned, which is
 * exactly the order you want to meet them in, and a decision log declares
 * proposed → accepted → rejected → superseded, which puts what is undecided and
 * what is in force above what has been settled or replaced. A template that
 * declares `queue` or `chronicle` is therefore also declaring that its lane
 * order is meaningful; reorder the lanes and you reorder the page.
 *
 * Returned as a plain number so the server can push it into SQL and the SPA can
 * group on it without either owning the rule.
 */
export function laneRank(
  templateId: string | null | undefined,
  status: string | null | undefined,
  config?: TemplateConfig | null,
): number {
  const lanes = statusesFor(templateId, config);
  if (!status) return lanes.length;
  const index = lanes.findIndex((lane) => lane.id === status);
  return index === -1 ? lanes.length : index;
}

/**
 * The lane a superseded blip is filed into, if this template has one.
 *
 * Registry-driven rather than a lane id written into the service layer: the day
 * a second template wants supersession, it declares its own lane and the service
 * keeps working. A template with no such lane still records the link — it just
 * does not move the blip, which is the honest degradation.
 */
export function supersededLane(
  templateId: string | null | undefined,
  config?: TemplateConfig | null,
): BlipStatusDef | null {
  const id = templateFor(templateId, config).supersededStatus;
  return id ? findStatus(templateId, id, config) : null;
}

/** The lane a blip must enter to be in force, if the template defers supersession. */
export function ratifiedLane(
  templateId: string | null | undefined,
  config?: TemplateConfig | null,
): BlipStatusDef | null {
  const id = templateFor(templateId, config).ratifiedStatus;
  return id ? findStatus(templateId, id, config) : null;
}

/**
 * What an answer does on this radar, if its template declares it: the lane a card must be in to
 * be decided, and the outcome lanes (in the radar's own vocabulary) that answer it. Null when the
 * template declares nothing, or this radar no longer has the lanes it names.
 */
export function decidesFor(
  templateId: string | null | undefined,
  config?: TemplateConfig | null,
): { from: string; outcomes: readonly BlipStatusDef[] } | null {
  const decides = templateFor(templateId, config).decides;
  if (!decides || !findStatus(templateId, decides.from, config)) return null;
  const outcomes = decides.outcomes.flatMap((id) => findStatus(templateId, id, config) ?? []);
  return outcomes.length > 0 ? { from: decides.from, outcomes } : null;
}

/** Whether a lane holds structural elements (boundaries, contracts) rather than decisions. */
export function isElementLane(
  templateId: string | null | undefined,
  status: string | null | undefined,
  config?: TemplateConfig | null,
): boolean {
  return Boolean(status && templateFor(templateId, config).elementLanes?.includes(status));
}

/** Whether a blip may go from one lane to another. Staying put is always fine. */
export function laneMoveAllowed(
  templateId: string | null | undefined,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  const moves = templateFor(templateId).transitions;
  if (!moves || from === to) return true;
  return (moves[from ?? ''] ?? []).includes(to ?? '');
}

/** Per-template display options, kept small and opaque outside this file. */
export interface TemplateConfig {
  /** microblog: group posts under a date heading, diary-style. */
  grouping?: 'none' | 'day';
  /** kanban: hide terminal lanes once they get long. */
  collapseDone?: boolean;
  /**
   * This radar's own lane vocabulary, replacing the ones its template declares.
   *
   * The answer to the third board-shaped template, and it is the answer
   * `docs/TEMPLATES.md` has named for a while: Pipeline (Lead · Contacted ·
   * Proposal · Won · Lost) and Meeting notes (Agenda · Discussed · Action ·
   * Parked) are both *Kanban with different words*, and shipping either as a
   * registry entry would be padding the picker with a template that offers no
   * verb a board does not.
   *
   * So the lanes move to the radar and the template keeps everything that
   * actually needs code — layout, order, facets, capture, conversation,
   * archiving. That split is the whole design: **a lane set is a vocabulary, and
   * a template is a set of behaviours.** Anything a person could want that needs
   * a behaviour still needs a template; anything that only needs different words
   * on the same board now needs nothing at all.
   *
   * Declaration order is as load-bearing here as it is in the registry — for
   * `queue` and `chronicle` it *is* the running order of the page — and every
   * lane still declares the triage `state` a blip takes when it lands there,
   * which is what keeps a custom board and the universal Inbox count from
   * disagreeing.
   *
   * Validated by `validateLanes` in `lanes.ts` before it is ever stored, and
   * ignored at read time if the radar has since moved to a template with no lane
   * axis. Unset means the template's own lanes, which is what every radar had
   * before this existed and what most will keep.
   */
  lanes?: readonly BlipStatusDef[];
  /**
   * Which of `lanes` a newly captured blip lands in. Absent means the first,
   * which is what all five shipped templates already declare — a board opens on
   * Backlog, a queue on Unread, a log on Proposed — so the common case needs no
   * second field and cannot be got wrong by leaving it out.
   *
   * Read only when `lanes` is set; the registry's own `defaultStatus` governs a
   * radar that has not overridden anything.
   */
  defaultStatus?: string;
}

/**
 * A radar's template and its own lane vocabulary, as one thing.
 *
 * Exists so a function that needs both cannot be handed one. Every helper here
 * takes them as two arguments, which is right for a call site that has only an
 * id — the template picker, a registry test — and wrong for one that has a
 * radar, where the second argument is easy to leave off and the failure is
 * silent: the radar renders, in the *registry's* lanes, and nothing says so.
 *
 * `RadarRow` and `RadarDto` both satisfy this structurally, so a caller passes
 * the radar it already has.
 */
export interface TemplateSource {
  readonly template: string | null;
  readonly templateConfig?: TemplateConfig | null;
}

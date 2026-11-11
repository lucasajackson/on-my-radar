# The shared UI contract

**Status: designed, not built.** This document decides where presentation and
interaction semantics live now that there is more than one client, and what
shape they take in `packages/contract`. It is written to be handed to a coding
agent: every decision states what to build, why the alternative lost, and which
files it touches.

It descends from four settled positions and contradicts none of them:

- **SCALE.md §2 / DESIGN.md §26** — the API is the product and every UI is a
  peer client on its own cadence. The web SPA is a client; the iOS app is a
  client; iPad and Electron will be clients.
- **DESIGN.md §4** — templates are declarations, not branches. Components ask
  _what does my template want_, never _which template am I_, and the registries
  are keyed `Record<RadarTemplate, …>` so a new template is a compile error
  everywhere it needs work.
- **DESIGN.md §2 / §24** — authorization is resolved server-side and refusals
  are shaped: a radar you may not read is a 404, never a 403, and an error a
  caller cannot act on is a defect.
- **`on-my-radar-ios/docs/ARCHITECTURE.md` §10** — a Swift mirror cannot see a
  TypeScript compile error, so what prevents drift is a snapshot and a test.
  Anything this document adds to the contract must be exportable through that
  mechanism or it does not belong in the contract.

---

## 1. The problem, and the three places it is already half-solved

`packages/contract` is described as the home of _data_ contracts: enums, zod
schemas, DTOs, registries, and the pure text rules that decide what a blip is.
That description has been inaccurate for months, in three places, each of them
correct:

- `BLIP_STATE_LABELS: Record<BlipState, string>` — copy.
- `SCOPE_COPY: Record<TokenScope, { title; detail }>` and
  `VOICE_COPY: Record<Voice, { title; detail }>` — copy with an explanatory
  paragraph attached, keyed by a domain enum.
- The template registry's `label`, `capturePlaceholder`, and every lane's
  `label` — copy, and the most user-visible copy in the product.

Nobody argued for those. They arrived because the alternative was worse: a
lane called "In progress" on the server and "Doing" in the SPA is a bug, and
the only way to make it impossible is to write the string once. The line was
never really "no presentation in the contract". It was **"nothing that needs a
DOM"** — and that line is still exactly right.

What sits on the wrong side of it today is everything else two clients must
agree about and currently re-derive:

- **Which actions exist on a blip, and when.** `packages/ui/src/components/blips.tsx`
  computes advance/defer, edit, pin, delete, react and lane-set availability
  inline across ~400 lines. The iOS app has none of it yet, and phase 3 of
  `on-my-radar-ios/docs/ROADMAP.md` is about to write a second copy.
- **What advance and defer mean.** `blips.tsx:445-485` holds a small state
  machine — settled blips reopen instead of completing; a blip already in
  `later` drops instead of deferring again; the undo restores the _lane_ when
  there is one, because the server derives state from lane and restoring half
  of it leaves the card in the right lane with the wrong state. That last
  sentence is a subtlety a second client will get wrong, silently, and be
  right about 80% of the time.
- **Which surfaces may be triaged by gesture at all.** `components/swipe.tsx`
  argues it in forty lines of prose: the stream, the reading list, the
  microblog and the drop box; never a board card (two gestures on one axis);
  never the decision log (accepting a decision is not housekeeping). That is a
  declaration about templates written as a comment.
- **Empty-state copy** — nineteen `<Empty title hint>` call sites, all literals.
- **Refusal copy** — mapped ad hoc at every call site from `ApiError.message`.
- **Confirmation copy** — `ConfirmDialog` takes its title, body and confirm
  label from whoever opens it, so the same destructive act can be described two
  ways in one product.
- **Badge semantics** — seen versus read is argued in DESIGN §8 and restated in
  NATIVE §12, and implemented twice from the prose.
- **The screen inventory** — which surfaces exist, which are reachable, which
  are deliberately web-only (`/connect`, `/admin`). `YouView.swift` links out to
  `https://onmyradar.io/settings` with a hardcoded string because nothing told
  it that surface is web-only by design.

Two clients re-deriving all of that is survivable, because one of them was
written by reading the other. **Four is not**, and the fourth is the one that
drifts: an iPad build that quietly gains a swipe on a decision log, or an
Electron build whose delete confirmation says something the web's does not.

**The premise of this document: presentation _semantics_ are contract;
presentation _form_ is platform.** A gesture is platform. What "advance"
_means_ is not.

## 2. Decision: it lives in `packages/contract`, as new modules

**Four new modules — `actions.ts`, `triage.ts`, `copy.ts`, `surfaces.ts` —
plus additive fields on the existing template registry.** Same package, same
version, same snapshot, same drift suite.

Why not the alternatives:

- **Rejected: a new package, `@onmyradar/ui-contract`.** It would have to
  depend on `@onmyradar/contract` for `RadarTemplate`, `BlipState`,
  `RadarAccessDto` and `RadarRole` — every type its predicates read — so the
  split buys no independence, only a second thing to version once DESIGN §26's
  obligation to publish the contract as a semver package lands. And the
  exhaustiveness property that makes this whole design work
  (`Record<RadarTemplate, …>` failing to compile when a seventh template
  arrives) is only available in the package that owns the enum. The one honest
  argument for a split — keeping copy out of the server's bundle — is answered
  by the contract being tree-shakeable ESM whose theme and glyph registries are
  already larger than every string in this document combined.
- **Rejected: `packages/ui` owning it, with the app reading from there.** That
  makes the web client the source of truth for the other clients, which is
  precisely the "the web is the app and mobile is a port" posture SCALE §2
  rejected. It would also break the rule that keeps the contract usable at all:
  one runtime dependency, no DOM, no Node.
- **Rejected: a `/api/v1/meta/ui` endpoint serving the registry.** ARCHITECTURE
  §10 already rejected runtime registry fetching for the data registries, and
  every word of it applies here with one addition: an availability predicate is
  consulted while a menu is opening, so this trades a compile-time answer for a
  network round trip in a render path.
- **Rejected: leaving it where it is and writing it down more carefully.** That
  is what `swipe.tsx`'s comment block already is. It is excellent prose and it
  has produced exactly one correct implementation, which is the one it sits
  inside.

The contract's own constraints survive intact: **no DOM, no Node APIs, one
runtime dependency.** Strings, records and pure functions are all this adds.

## 3. The line, and the two tests that draw it

Two questions decide every item, and they are meant to be asked in order.

**"If two clients answered this differently, is that a bug or a difference?"**
A bug is contract. A difference is platform. Two clients disagreeing about
whether a decision log can be swiped is a bug. Two clients disagreeing about
how far a finger travels before the swipe commits is a difference.

**"Can it be decided without knowing the size of the screen?"** If the answer
needs a viewport measurement, a font metric or a pointer type, it is platform.
This is what keeps the board's lane budget (DESIGN §16 — measured arithmetic
against `--lane-floor`) out, while keeping "the board is a pager on a phone and
never scrolls sideways" in as a statement about the layout the template wants.

Applied:

| In the contract                                       | Left to the platform                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Which actions a blip has, and when                    | Whether they are a context menu, a sheet, or a hover row     |
| The order actions are declared in                     | How they are grouped, sectioned or overflowed                |
| What advance/defer write, and the undo write          | The gesture, its threshold, its animation, its haptic        |
| Which templates permit gesture triage at all          | Which gesture (swipe, long-press, keyboard) performs it      |
| Destructive-action confirmation copy and severity     | Whether the confirm is a dialog, an alert, or a hold         |
| Empty-state and refusal copy, keyed                   | Typography, illustration, spacing                            |
| Badge semantics — what counts, what clears            | Where the badge is drawn                                     |
| The screen inventory and each screen's canonical path | Navigation idiom, transitions, split view                    |
| `bodyEmphasis` — a board card is an index entry       | That this means `lineLimit(4)` on iOS and `--clamp-4` on web |
| Icon _tokens_                                         | Which artwork a token resolves to                            |
| Template grouping — the log groups by lane            | Whether a group header is sticky                             |

The `bodyEmphasis` row is not hypothetical. It is the first defect
`on-my-radar-ios/docs/ARCHITECTURE.md` §15 recorded: a board card rendered an
entire essay because `.lineLimit(8)` bounds each `Text`, not a block model. The
fix — "a microblog post _is_ the content and runs in full; a board card is an
index entry and gets the least" — is a template declaration that the web has
been making in CSS since the beginning, and that the iOS app arrived at
independently, in a different vocabulary, after shipping the bug.

## 4. The action registry

One declaration per action, in one array, whose order is the canonical order.

```ts
// packages/contract/src/actions.ts

export const ACTION_IDS = [
  'blip.advance',
  'blip.defer',
  'blip.setLane',
  'blip.setState',
  'blip.edit',
  'blip.pin',
  'blip.attach',
  'blip.react',
  'blip.comment',
  'blip.copyLink',
  'blip.restore',
  'blip.delete',
  'radar.capture',
  'radar.share',
  'radar.settings',
  'radar.setTopic',
  'radar.setTheme',
  'radar.setVisibility',
  'radar.archive',
  'radar.delete',
  'topic.settings',
  'topic.share',
  'topic.delete',
  'comment.reply',
  'comment.edit',
  'comment.delete',
  'notification.markRead',
  'notification.markAllRead',
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export interface ActionDef {
  readonly id: ActionId;
  readonly subject: 'blip' | 'radar' | 'topic' | 'comment' | 'notification';
  /** Imperative, sentence case. What the control says at rest. */
  readonly label: string;
  /** Past tense, for the acknowledgement: "Marked done". Null when silent. */
  readonly done: string | null;
  /** A token, not an asset. See §4.3. */
  readonly icon: IconToken;
  readonly intent: 'primary' | 'neutral' | 'destructive';
  /**
   * One field write with a known previous value.
   *
   * DESIGN §16 permits a gesture ONLY for a reversible action, because a
   * gesture has no confirmation step by definition. A client's gesture layer
   * is therefore `actionsFor(ctx).filter(a => a.reversible)` and the rule
   * stops being something an implementer has to remember.
   */
  readonly reversible: boolean;
  /** Present exactly when the action must be confirmed. Never both this and `reversible`. */
  readonly confirm: ConfirmSpec | null;
  /** Offered on the row itself, or only once the subject is opened. */
  readonly surface: 'inline' | 'detail' | 'both';
}

export const ACTIONS: Record<ActionId, ActionDef>;
export const ACTION_ORDER: readonly ActionId[]; // === ACTION_IDS
```

**Declaration order is menu order.** Clients may section or overflow the list;
they may not reorder it. This is the same rule as lanes and as the server's
template ordering — the order carries meaning, and a client that re-sorts is
asserting an opinion the product did not have. A client whose menu is too short
for the list drops from the end, which is why destructive actions are declared
last within each subject.

**`reversible` and `confirm` are mutually exclusive, and the type says so.**
An action with a confirmation cannot be a gesture; an action that is a gesture
must undo with one tap. That is DESIGN §16's rule about gestures and
`swipe.tsx`'s rule about delete, expressed once, as a shape.

### 4.1 Availability has three answers, not two

```ts
export type Availability =
  | { readonly state: 'available' }
  | { readonly state: 'hidden' }
  | { readonly state: 'blocked'; readonly reason: RefusalKey };

export function availabilityOf(id: ActionId, ctx: ActionContext): Availability;
export function actionsFor(ctx: ActionContext): readonly ResolvedAction[];
```

The rule that decides which of the three:

> **Vocabulary that does not exist is hidden. Permission you do not have is
> blocked, with a reason.**

Setting a lane on a stream is hidden: a stream has no lanes, and offering a
disabled "Move to…" teaches a person a false thing about the product. Deleting
a blip on a radar where you are a viewer is blocked and says why — because the
person _could_ have that, the difference between "not for you" and "not a
thing" is the difference between asking for access and giving up, and DESIGN
§24's rule that a refusal must be actionable applies to a greyed-out control as
much as to an HTTP status.

Two constraints on the predicate, both load-bearing:

**It reads only server-resolved booleans.** `dto.ts` already states the rule
for comments: _"`canDelete` is resolved server-side like `RadarAccessDto` — the
UI must never infer a permission by comparing ids, because the rule (author OR
radar owner) lives in one place and has to keep living there."_ The predicate
takes `RadarAccessDto` and `CommentDto.canDelete` as inputs and never sees a
user id, so it cannot break that rule even by accident. This is the whole
reason the predicate is safe to share: it is not authorization, it is a
rendering of authorization.

**The server is still the arbiter.** Principle 12 of this system is that the
database decides; §2 is that access decides in one function. A client whose
predicate says `available` and whose request comes back 404 renders the 404
copy and does not complain, because the predicate is a hint about what to draw
and the service layer is the truth. The predicate never becomes the source of
truth, and no server code ever imports it.

### 4.2 The context is a pure value

```ts
export interface ActionContext {
  /** The person/delegate fence, rendered. Never widened here — see below. */
  readonly actor: { readonly kind: 'user' | 'agent' };
  readonly radar: {
    readonly access: Pick<RadarAccessDto, 'canRead' | 'canWrite' | 'canManage' | 'viaPublicLink'>;
    /** Null when the wire carried a template id this build has never heard of. */
    readonly template: RadarTemplate | null;
    readonly commentsEnabled: boolean;
    readonly reactionsEnabled: boolean;
    readonly isDropBox: boolean;
    readonly archived: boolean;
    readonly visibility: RadarVisibility;
  };
  readonly blip?: {
    readonly state: BlipState;
    readonly status: string | null;
    readonly pinned: boolean;
    readonly archived: boolean;
  };
  readonly comment?: { readonly canDelete: boolean };
  /**
   * What this deployment and this client can physically do. Principle 10 —
   * features degrade by construction — becomes one rule instead of a
   * conditional at every control: storage off hides the paperclip everywhere.
   */
  readonly capabilities: {
    readonly storage: boolean;
    readonly push: boolean;
    readonly share: boolean;
    readonly gestures: boolean;
  };
}
```

`template: null` is the unknown-template case ARCHITECTURE §9 already decided:
an id this build has never heard of renders with the stream layout and
capture-only affordances. In the registry that is one line rather than a
convention — every action whose availability depends on lane vocabulary is
`hidden` when `template` is null, and capture is not.

`actor.kind` is in the context because the person/delegate fence
(`assertHumanDecision`) has a rendering: push registration, notification
settings, credential minting and owner grants must not be _offered_ to an agent
credential, not merely refused. **This mirrors the fence for drawing purposes
and never weakens it.** The server remains the only place the fence is
enforced, and no service ever reads this.

### 4.3 Icons are tokens, and they are chrome

`IconToken` is a small named vocabulary (`'check'`, `'clock'`, `'pin'`,
`'trash'`, `'link'`, `'reply'`, …) declared beside the actions. It is
deliberately **not** `RadarGlyph`.

The glyph registry is different in kind: a radar's glyph is _content_ — the
person chose it, it identifies their radar, and ARCHITECTURE §11 bundles the
48 lucide SVGs on iOS precisely so the mark is identical on both clients. An
action's icon is _chrome_, and §11's carve-out already says chrome belongs to
the platform: "the app's own chrome (tab bar, toolbars, system actions) uses SF
Symbols, because chrome is the platform's, exactly as glass is."

So the contract names the token; the web resolves it to a lucide component and
iOS resolves it to an SF Symbol. **Rejected: bundling thirty more lucide SVGs
into the iOS asset catalog** so action icons match pixel for pixel — a trash
can that is not the system trash can is the kind of detail that makes an app
read as a port, and matching artwork on a menu item is not a promise the
product is making. **Rejected: no icon field at all**, leaving each client to
pick — that is a fourth-client drift generator for zero saving, since the
mapping table is thirty lines wherever it lives.

## 5. Triage semantics: advance and defer as data

The state machine currently inside `blips.tsx` moves out whole.

```ts
// packages/contract/src/triage.ts

export interface TriageMove {
  /** Exactly one field. Reversibility is a property of that. */
  readonly patch: { readonly state: BlipState };
  /** The label the control (and the gesture's track) wears right now. */
  readonly label: string;
  /** The acknowledgement: "Marked done", "Filed under Later". */
  readonly done: string;
  readonly icon: IconToken;
  /**
   * The inverse write, as data rather than a closure.
   *
   * On a template with lanes the server derives state from lane, so restoring
   * only the state would leave the card in the right lane with the wrong
   * state — or the reverse. The undo therefore restores the lane when the blip
   * had one. This is the single subtlest rule in this document and the one a
   * second implementation is most likely to get 80% right.
   */
  readonly undo: { readonly status: string } | { readonly state: BlipState };
}

export function advanceMove(blip: TriageSubject, template: RadarTemplate | null): TriageMove | null;
export function deferMove(blip: TriageSubject, template: RadarTemplate | null): TriageMove | null;
```

The rules it encodes, all of them already true on the web and all of them
prose today:

- A settled blip (`done` or `dropped`) advances to **Reopen** → `active`, not
  to done again.
- A blip already in `later` defers to **Drop** → `dropped`. Dropped is a triage
  state, not a deletion, which is the only reason a gesture is allowed to reach
  it.
- Otherwise advance is **Done** and defer is **Later**.
- Both return `null` on a template that does not triage.

And the surface rule becomes a template declaration rather than a comment:

```ts
// added to the template registry
readonly gestureTriage: boolean;   // stream, microblog, reading: true. kanban, decisions, discussion: false.
```

`kanban: false` carries the board's axis conflict; `decisions: false` carries
the meaning conflict (the swipe that means "done" everywhere else would mean
_accepting a decision_, and "later" has no lane to land in). The drop box is a
stream and inherits `true`. A seventh template must answer the question to
compile.

**Rejected: leaving triage inside the action registry as two more entries with
static labels.** Their labels and their writes are state-dependent, so they are
resolvers, not declarations; folding them in would either make every
`ActionDef` a function or make advance/defer lie about themselves. They stay a
module the action registry calls into.

## 6. Copy, and the rules it makes unrepresentable

```ts
// packages/contract/src/copy.ts
export const EMPTY: Record<SurfaceId, { title: string; hint: string; action?: ActionId }>;
export const REFUSAL: Record<RefusalKey, { title: string; hint: string }>;
export const ACK: Record<AckKey, string>;
```

Copy in the contract is not a new idea here; §1 lists three places it already
is. What is new is that the tables are keyed by something the type system
knows, and that turns three of this system's security rules from things people
remember into things the code cannot express.

**404-never-403 becomes a missing key.** `REFUSAL` is keyed by the server's
`error.code`. There is no `radar.forbidden` key, because the server never sends
one — a radar you may not read is a 404 whose copy must not know the difference
(`"Not here. It may have been deleted, or it may not be yours."`). A client
that wanted to write "you don't have permission to see this radar" would have
to invent a key, and the drift suite fails on an extra key in either direction.

**The no-account-existence-oracle rule becomes a single key.** There is exactly
one string for the outcome of `POST /auth/request-code`: `auth.codeSent`. There
is no `auth.noSuchAccount`, and a client cannot branch on something it has no
second string for. DESIGN §13's rule that the answer is identical for known and
unknown addresses is currently enforced on the server and merely _observed_ by
the client; this makes the client's half structural. The one sanctioned signal
— `shareRadar`'s returned status — gets its own keys, and they are the only
place in the table where a person's existence is spoken about at all.

**Actionable refusals become the default.** Every `RefusalKey` carries a
`hint` that says what to do, and an unrecognised `error.code` maps to
`REFUSAL.unknown`, which names the failure and carries the `x-request-id` the
API puts on every response. The livelock DESIGN §24 records — an error that
invited a retry that could never succeed, a thousand times — is a copy defect
as much as a status-code defect.

**Confirmation copy lives on the action, not at the call site.**
`ActionDef.confirm` is `{ title, body, confirmLabel, phrase? }`, where `phrase`
(the type-this-back gate `ConfirmDialog` already supports) is a symbolic
`'name'` resolved by the client against the subject, never a literal. The same
destructive act therefore cannot be described two ways in one product, which it
currently can.

Deliberately **not** in scope: an internationalisation runtime, ICU message
format, or a pluralisation engine. The tables are English literals under stable
keys, and the keys are the thing that makes localisation possible later. The
only pluralisation rule this product has — consonant + y takes `-ies`, six
lines, already mirrored in Swift for `replyNounPlural` — is the evidence that a
runtime would be machinery for one case.

## 7. Surfaces: the screen inventory as a registry

```ts
// packages/contract/src/surfaces.ts
export interface SurfaceDef {
  readonly id: SurfaceId; // 'radar' | 'blip' | 'topic' | 'search' | 'tag' | 'activity' | …
  readonly title: string;
  /** The canonical path. One string; universal links, web routes and Electron all route from it. */
  readonly path: string; // '/radar/:radarId'
  readonly params: readonly string[]; // ['radarId']
  readonly query: readonly string[]; // ['blip']  — the notification ping target
  /** Where a client is expected to make this reachable. */
  readonly placement: 'tab' | 'push' | 'modal';
  /** DESIGN §15 and §22: consent and administration are web surfaces. A native client links out. */
  readonly webOnly: boolean;
  /** NATIVE §12: Activity is non-removable by construction. */
  readonly removable: boolean;
  /** Which of `seen` / `read` this surface posts. DESIGN §8. */
  readonly badge: 'seen' | 'read' | null;
  readonly emptyKey: SurfaceId;
}
```

Three things this buys that prose has not:

**`webOnly` stops silent omission.** `/connect` must stay web because DESIGN
§15 requires consent to happen where the person can see the origin; `/admin` is
web because it is not a phone job. `YouView.swift` today links out to
`https://onmyradar.io/settings` with a literal, which works and tells nobody
why. Declared, a native client renders a link-out for every `webOnly` surface
and a fourth client cannot forget one exists.

**`removable: false` on Activity** is NATIVE §12's "non-removable by
construction" as a field rather than a sentence, and the phrase "by
construction" finally means something.

**`badge` is the seen/read rule, once.** Opening the tray posts `seen` (stops
the ping, keeps the count); acting on an item posts `read` (clears the badge).
Both clients implement it correctly today; both implemented it from the same
paragraph, and the third will read a summary of a summary.

`path` is the canonical string that AASA routing (NATIVE §9.2), the SPA router
and any later Electron shell all derive from — one place where a deep link's
shape is decided, which is the only way `/radar/:id?blip=…` stays identical
across four clients and an email.

## 8. Presentation declarations that are not actions

Additive fields on the existing template registry, each replacing something a
client currently invents:

| Field                                              | Replaces                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyEmphasis: 'full' \| 'excerpt' \| 'index'`     | The iOS `bodyBudget` switch and the web's clamp classes                                                                                                   |
| `grouping: 'none' \| 'day' \| 'lane'`              | Today's `grouping: boolean`; iOS groups the log by lane in `RadarScreen.sections()`, the web groups the microblog by day, and one boolean cannot say both |
| `gestureTriage: boolean`                           | `swipe.tsx`'s comment block                                                                                                                               |
| `emptyKey: SurfaceId`                              | Nineteen literal `<Empty>` call sites                                                                                                                     |
| `capture: { placeholder; linkFirst; attachments }` | `capturePlaceholder` and `linkFirstCapture`, grouped so a seventh template answers capture as one question                                                |

Widening `grouping` from `boolean` to a three-valued enum is itself a contract
change with a Swift mirror consumer that cannot see the compile error — which
is exactly the case ARCHITECTURE §10 built the drift suite for. It is a good
first exercise of the mechanism, and it should be done first for that reason.

## 9. How a Swift client gets this

The snapshot script ARCHITECTURE §10/§14.1 already specifies
(`packages/contract/src/snapshot.ts`, still unbuilt) grows four sections. The
predicates stay code in both languages; the **vectors are the spec**, exactly
as they already are for `deriveBlipKind` and `parseSearchQuery`.

`contract-snapshot.json` gains:

1. **`actions`** — every `ActionDef` verbatim, in declaration order. Pure data.
2. **`availability`** — a generated table of
   `[actionId, contextSampleId] → Availability`, produced by running the TS
   predicates over an enumerated sample space: 3 access levels × 7 template
   values (six plus unknown) × 5 blip states × the boolean flags that any
   predicate actually reads, pruned to reachable combinations. A few thousand
   rows of small JSON, and an exact specification of a function.
3. **`triage`** — `[template, state, status] → TriageMove | null` vectors,
   including the lane-restoring undo cases, which are the rows that matter.
4. **`copy`** and **`surfaces`** — pure data, verbatim.

`OMRContract` gains `Actions.swift`, `Triage.swift`, `Copy.swift` and
`Surfaces.swift`, and its drift suite gains four cases in the shape it already
has: decode the snapshot, assert the mirror reproduces it exactly, no extras in
either direction. A new action, a changed label, a predicate whose answer moved
— each becomes a named test failure the next time the snapshot is refreshed,
and the failure message is the work list.

**Rejected: serializing the predicate as an expression tree** so clients could
evaluate it as data rather than mirror it. That is a layout DSL wearing a
different hat: it needs an interpreter in every client, the interpreter is
larger than the predicate, and a bug in it is a bug nobody can read. **Rejected
again: code generation** — same answer as §10 gave for the data registries, and
the same escape hatch: the snapshot is already generation's input format if
churn ever makes the mirror a treadmill.

## 10. What this must never become

Written down because every shared-UI project in history has failed by growing
past this line, and because the next person to extend it will be reasonable
about it.

- **No component model.** No `<SharedBlipCard>`, no view descriptions, no
  render tree. The contract says a blip has these six actions in this order;
  what a card looks like is the client's entire job and the reason there are
  separate clients at all.
- **No layout DSL.** No sizes, no spacing scale, no breakpoints, no flex
  directions. `bodyEmphasis: 'index'` is in; `lineLimit: 4` is not.
- **No style tokens beyond the theme registry.** The nine theme axes already
  exist and are already resolved server-side into a whole `RadarTheme` on every
  radar. Nothing here adds a second styling system, and Liquid Glass stays
  chrome that never takes radar accent.
- **No navigation controller, no router, no state machine runtime.** Surfaces
  are an inventory, not a graph to execute.
- **No gestures, animations, haptics, keyboard maps or pointer rules.**
- **No authorization.** Availability is a rendering of server-resolved
  booleans. If a client's predicate and the server disagree, the server is
  right and the client renders the refusal. No server code imports
  `actions.ts`, ever — a check-then-act between a client predicate and a
  service is the shape principle 12 exists to forbid.
- **No runtime fetching.** The contract is compiled in or mirrored in. Never
  served.
- **No copy that a person supplied.** Radar names, taglines, lane labels a
  person renamed and blip bodies are data, not contract. The registry's lane
  labels are the _defaults_; `templateConfig.lanes` overrides them and always
  wins, exactly as it does today.

## 11. Migration, without rewriting the web client

Four phases. Nothing in phase A changes a rendered pixel, and the web keeps
working throughout.

**Phase A — the modules exist and nobody imports them.** Write `actions.ts`,
`triage.ts`, `copy.ts`, `surfaces.ts` and the template-registry additions; port
the copy verbatim out of the current call sites, character for character, so
that adoption is provably a no-op. Build the snapshot script (which is owed
anyway, ARCHITECTURE §14.1) with all four new sections. Mirror in Swift, turn
the drift suite on. _Acceptance: `pnpm --filter @onmyradar/contract snapshot`
emits a stable file; the iOS suite passes against it; adding a seventh template
to a scratch snapshot fails the suite in every new section._

**Phase B — the iOS app is the first consumer.** iOS phase 3 (triage,
comments, blip actions) is written _against_ the registry rather than
re-derived and reconciled later. This sequencing is the point: the shared thing
is introduced at the exact moment the duplication would otherwise be created,
which is the only moment it costs nothing. _Acceptance: `BlipActionsView` and
the swipe layer render entirely from `actionsFor(ctx)`; no template id appears
in any iOS view; the decision log has no swipe and the stream does, both
asserted._

**Phase C — the web adopts, one surface at a time.** In value order:

1. `components/blips.tsx`'s action cluster and swipe wiring — the place where
   the divergence has already bitten twice (the `inLane`/`compact` mix-up, the
   invisible-but-hit-testable cluster).
2. The nineteen `<Empty>` call sites → `EMPTY[surfaceId]`.
3. Every `ConfirmDialog` call site → `ACTIONS[id].confirm`.
4. `lib/api.ts`'s error surfacing → `REFUSAL[code]`.

Each is a change whose test is "the same items render, with the same words".
Nothing is rewritten; call sites are replaced with lookups.

**Unified, 2026-09-26: triage has one source.** The SPA's swipe wiring in
`components/blips.tsx` and `triage.ts` had disagreed in four places. The owner
chose to unify them in the contract, taking whichever side was better for a
person, and the SPA now renders `advanceTarget` / `deferTarget` /
`allowsTriageGesture` and holds no triage rule of its own. The dashboard's
"Done" action, a third copy that always wrote `state: 'done'`, reads
`advanceTarget` too.

|                             | Chosen rule                                                                                                                                                                                                                                   | Taken from                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| What a swipe writes         | The template's own lane `status` where it has lanes, labelled with the lane's word ("Finished", "Resolved"); the universal `state` only where it has none                                                                                     | Contract                              |
| Reopening something settled | Back to work: `active`, labelled "Reopen" — or, with lanes, the first non-terminal lane whose state is `active` (else the first non-terminal), labelled "Back to …". A lane is settled when it is `terminal` **or** its state is done/dropped | SPA's target, contract's naming       |
| Deferring                   | A gradient: Later, then Dropped for something already Later; defer on something settled reopens it. With lanes, a `later` lane first, then a `dropped` one                                                                                    | SPA (with the contract's two-way end) |
| Where a swipe exists at all | Only where `allowsTriageGesture`: never a board, a decision log, or a template with neither lanes nor triage — so not the timeline, whose posts show no triage and where a swipe changed something invisible                                  | Contract                              |

Why each: a lane template's own word is what the person sees on the card, and
writing its lane directly cannot land in a lane the server picked; reopening to
the inbox asked the person to triage again something they had already decided
about; the defer gradient gives one gesture a meaning at every step instead of
toggling; and a gesture whose effect is invisible reads as a broken one.

**Contract changes the iOS mirror must port** (`Triage.swift`, and the
snapshot's triage vectors change accordingly):

1. `TriageTarget` gains `acknowledgement` — the past-tense toast ("Marked
   done", "Filed under Later", "Dropped", "Reopened", "Moved to …", "Back
   in …").
2. Reopen (unlaned): `inbox` / "Back to inbox" → `active` / "Reopen".
3. Reopen (laned): the first non-terminal lane → the first non-terminal lane
   whose state is `active`, falling back to the first non-terminal one (a
   reading list reopens to Reading, not Unread).
4. A lane whose state is `done` or `dropped` reopens even when it is not
   `terminal` (the decision log's Accepted used to target itself).
5. Advance (unlaned) on `dropped` reopens, as on `done` (it offered Done).
6. Defer (unlaned): `later` → `dropped` / "Drop" (it went back to the inbox);
   `done` and `dropped` → reopen (they offered Later).
7. Defer (laned): prefers a `later` lane, then `dropped`; from a `later` lane,
   `dropped` (it preferred `dropped` first).
8. `allowsTriageGesture` is unchanged; the web conforms to it (no timeline
   swipe).

The web does not offer the contract's discussion gesture (resolve/reopen a
thread): a thread's card holds its reply box, and `SwipeRow` does not yet
refuse drags that start in a field. That is a choice of surface, not a
divergence of rule — what a swipe would do there is still the contract's.

**Phase D — the rule lands.** A numbered section in DESIGN.md, in that
document's voice, arguing this change and stating the standing rule it creates:
_a client-visible action must be declared before it is rendered, and a new
empty state or refusal gets a key._ Until §D lands, this document is a design,
not a rule.

## 12. File-level work list

**`packages/contract/src/`** — new: `actions.ts`, `triage.ts`, `copy.ts`,
`surfaces.ts`, `icons.ts`, `snapshot.ts`. Changed: `templates.ts` (the §8
fields), `index.ts` (exports), `package.json` (the `snapshot` script).

**`packages/server/src/`** — nothing. The service layer neither imports nor
enforces any of this, and the one change that touches the server at all is that
`templates.test.ts` should assert the new registry fields exist for every
template, since that is where the contract's tests currently live.

**`packages/ui/src/`** — phase C only: `components/blips.tsx`,
`components/swipe.tsx`, `components/primitives.tsx` (`Empty` and
`ConfirmDialog` take keys), `lib/api.ts`, and the nineteen route files holding
literal empty states.

**`on-my-radar-ios/`** — `Packages/OMRContract/Sources/OMRContract/Actions.swift`,
`Triage.swift`, `Copy.swift`, `Surfaces.swift`; `Tests/OMRContractTests/MirrorTests.swift`;
`contract/contract-snapshot.json` (vendored). App-side consumption is
`docs/ROADMAP.md` phase 3.

**`docs/`** — this file, plus the DESIGN.md section that phase D adds.

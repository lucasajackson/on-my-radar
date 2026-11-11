# On My Radar — design notes

Native signed-in support reuses the private helpdesk service and staff review
model, with a capture-only proof and immutable native requester provenance.
Its authorization, configuration, customer projections and release gates are
documented in [SUPPORT.md](SUPPORT.md). It grants no customer radar membership.

Why the pieces are arranged the way they are. This is the document to read
before changing something structural.

## 1. One service layer, two transports

The REST API and the MCP tools are both thin wrappers over the same functions in
`packages/server/src/services`. A route parses a request and calls
`createBlip(actor, radarId, input)`; an MCP tool parses tool arguments and calls
the same function with the same `Actor`.

This is the whole security model for agents. An agent cannot see or do anything
its human could not, because it is running the identical authorization checks —
not a parallel implementation that has to be kept in step.

It is also why `packages/contract` exists. The zod schemas that validate an HTTP
body are the same ones that shape an MCP tool's input schema, so "what counts as
a valid blip" is defined once.

## 2. Authorization lives in `services/access.ts`

`requireRadar(idOrSlug, actor, need)` is the only way any code reaches a radar.
Three rules in it are load-bearing:

- **A radar you may not read is a 404, never a 403.** A 403 confirms that a given
  id exists, which is a disclosure in itself.
- **A public link grants access only when it is the identifier that was used.**
  Knowing a private radar's uuid must not turn into read access the moment the
  owner publishes it under a different slug. `viaPublicLink` is only true when
  the caller arrived via `public_slug`.
- **Union first, then clamp.** An agent's connection carries a ceiling, and the
  effective access is `min(what the person may do, what the token was granted)`.
  The union runs on the human's grants and only the human's grants; the clamp is
  a single monotonically weakening `min` at the tail. §21.

Public reads have their own routes (`routes/public.ts`) rather than reusing the
private ones with a null actor, because the responses are deliberately narrower:
member counts, owner ids and author email addresses never appear on a public
page, and attachments are fetched through a public, radar-scoped route.

### Narrowing is a property of the access, not of the route

That last paragraph used to describe the whole defence, and it was not enough.
`requireRadar` **has to accept a `public_slug`** as an identifier — resolving a
public radar by its uuid grants nothing, so without it the thread on a published
blip is unreachable for everybody (§7). The consequence was that the private
routes and the MCP tools took the same slug and answered the same radar
unredacted: publishing a radar handed every member's address, every _pending
invitee's_ address, the owner id, the member count and every blip's author
address to any signed-in stranger holding only the link.

So the redaction moved out of `routes/public.ts` and into
`services/redaction.ts`, decided from `role === null` — "reached this without a
grant", which is the whole of the condition, because `canRead` is true for
exactly two kinds of caller and a public visitor is the one with no role.
`getRadarDto`, `radarStream` and `listComments` apply it; the public routes keep
only the part that really is route-shaped, rewriting attachment hrefs onto the
public identity.

`listMembers` **refuses** rather than narrowing. A member list is a list of
people and there is no redacted version of it worth serving. It is a 403 and not
this codebase's usual 404, and only here: the caller demonstrably holds a working
public link already, so the radar's existence is not news to them and a 404 would
only mislead. Everybody with a role, however narrow — including one that arrives
through a cascading topic — still sees the whole list, because access nobody can
enumerate is access nobody audits (§17).

### Asking whether an address has an account is not something this API does

`GET /api/radars/:id/lookup?email=` used to sit on the radar router — "used by
the share dialog to say this person already has an account". It needed `manage`
on _a_ radar and anybody can create one, so any signed-in account could ask
whether any address in the world was registered and get the display name with
it, unrate-limited. §14 forbids exactly that: `request-code` answers identically
whether or not the address has an account, on purpose. This handed the same fact
over by another door, with a name attached.

It is **removed**, not rate-limited. Rate limiting slows an oracle without
changing its shape, and there was nothing to preserve — it had no caller in the
SPA, in an MCP tool or in the contract package, and had had none since the commit
that introduced it. The question is already answered where it matters:
`shareRadar` returns `status: 'invited' | 'added' | 'updated'`, so the dialog
learns whether the person had an account at the moment it shares with them. The
difference is that sharing writes an audit record and tells the recipient.
Probing did neither, and that is what made it an oracle rather than a feature.

§6.2's user-to-user note already states the general rule — "addressing must never
be by email — that makes the endpoint an oracle for who is registered" — so this
is the same rule applied to a route written before it.

## 3. Capture infers, it does not ask

`createBlip` derives the tags (from `#hashtags` in the body), the URL (if the
body is nothing but one), the kind, and the title (only from a real markdown
heading — deriving one from the first sentence just prints the same words
twice). The composer previews what it is about to infer so nothing is a surprise.

The reason is that capture has to be cheaper than the thought. Every field a
person has to choose before typing is a reason not to type. The same property is
what makes the MCP tool usable in one argument: `create_blip({radarId, body})`.

**Tags follow the text they were written in.** Editing the body re-derives the
inline ones: a `#tag` taken out goes, one put in arrives. A tag the old body
never carried was set explicitly (the tag editor, `tags` on a write, a webhook
mapping) and survives the edit; an explicit `tags` in the same call wins
outright. A blip holds at most 24 tags, and a person or agent whose own words
would carry more is refused with the ones that do not fit named — never cut
short silently. Somebody else's words (a feed item, an email, a webhook payload;
`blips.authored` false) keep the first 24 and leave the rest as text, because
refusing would lose the capture over tagging nobody here chose. The same flag
is why such text never resolves an `@handle`, on capture or after a move; a
person rewriting the body makes it theirs.

## 4. Radar kinds and templates

Two orthogonal columns on `radars` decide what a radar _is_:

- **`kind`** — where its blips come from. `standard` owns them; `smart` owns
  none and is a saved tag query, resolved at read time.
- **`template`** — what it does with them. A registry id from
  `packages/contract/src/templates.ts`, shared by the server and the SPA.

### The two axes of a blip

`blips.state` is universal triage and stays universal: the same five values in
every radar, which is what makes cross-radar triage and `search_blips({state})`
mean anything.

A template's lanes are a **second, template-scoped axis** in `blips.status`. It
is nullable, it has no CHECK constraint in SQL, and it is validated against the
registry instead — so shipping a new template needs no migration.

Making `state` itself template-dependent was the obvious alternative and it is
worse twice over: it would need a migration per template (or the CHECK dropped
entirely), and it would break the one thing that works across radars.

The pair is kept honest by `state`. Every lane declares the triage state a blip
takes when it lands there, so moving a card into Done also empties it out of the
Inbox count. One axis is where the work sits; the other is whether it is dealt
with. `resolveStatus` also drops a lane the current template does not know, so a
radar can be switched between templates without leaving rows stranded in a
column that no longer exists.

Keeping them honest has to work in **both** directions, and only one of them is
a mapping. `status` → `state` is exact: a lane names the state it implies.
`state` → `status` has no inverse, because several lanes can imply one state —
a Kanban card is `active` whether it is Doing or Blocked — so it is a **repair**
rather than a mapping (`laneForState`, applied in `createBlip` and `updateBlip`):

- Setting `state` alone moves the blip only when the lane it is currently in
  contradicts the new state, and then to the first lane declaring that state.
  Blocked re-confirmed `active` stays Blocked; `done` lands in Done.
- If the template declares no lane for that state — a reading list has no
  `later` — the blip keeps the lane it had. An imprecise lane beats an invented
  one, and the item stays where its reader left it.
- An explicit `status` in the same call always wins. The caller named a lane.

For a long time only the first direction existed, and the consequence was a
board that lied: `update_blip({state:'done'})` over MCP left six cards sitting
in To do and In progress while every count elsewhere called them done, with
nothing on screen to say which was true. `lanes.test.ts` covers both directions
against a real Postgres, because what a board renders is the stored row.

The same section is why an explicitly supplied lane the template does not
declare is now **refused** rather than nulled. `resolveStatus` degrading an
unknown status to null is right for a value already stored through a template
change, and wrong for one a caller just typed — there, silence means the card
quietly leaves the board. Agents guess lane ids; the error names the real ones.

### A radar's own lane vocabulary

`templateConfig.lanes` lets a radar replace the lanes its template declares. It
is the payoff of the paragraph above about no CHECK constraint: the vocabulary
was already validated in the registry rather than in SQL, so letting a radar
carry its own needed no migration and no new column — `template_config` is
already jsonb.

**The line it draws is the whole design: a template is a set of behaviours; a
lane set is a vocabulary.** Layout, order, facets, capture, conversation shape
and archiving need code, so they stay in the registry. The words on the columns
do not, so they move to the radar.

That line is also what stops this being a plugin system, and it is worth stating
as a property rather than a policy: **nothing expressible here can add a
behaviour.** There is no sort order, no card, no query and no capture rule in the
grammar. The same argument the theme vocabulary makes about CSS in §22 — the
bounded vocabulary _is_ the safety model, not a convenience on top of one.

Two refusals are worth recording because they were the arguable ones.

**A lane set that would strand blips is refused rather than repaired.** Repairing
means writing every stranded blip into some other lane: a second write that can
disagree with the first, applied to rows the person asking has not looked at.
That is precisely the failure mode the `state`/`status` repair above exists to
prevent, so inventing a second one here would be undoing the argument. The
refusal names the lanes and the counts, and nine times in ten the answer is to
keep the lane id and change only its label — which moves nothing.

**A lane set is ignored, not deleted, when the radar moves to a template with no
lane axis.** Same degradation rule as an unknown template id, and for the same
reason: a radar must stay readable. Moving a board to a stream and back gets the
vocabulary back.

There are two write surfaces, one rule set. Over MCP, `describe_templates`
publishes the rules, generated from the registry so it cannot drift from the
validator, and `set_radar_lanes` applies them. The settings page has an **Edit
lanes** dialog (rename, add, remove, reorder) plus one button to restore the
template's. It was once deliberately editor-less, on the argument that a form
would restate every rule — but the rules are `validateLanes` in the contract, and
the dialog runs that function as-is and shows its problems verbatim; the one rule
that needs the database (no stranded blips) is the server's refusal, shown beside
the lanes. Nothing is restated, so the argument no longer holds. A new lane's id
is minted from its label; a saved lane keeps its id through any rename.

### A template is what it lets you do, not what it is called

Lanes alone are not a template. Reading list, decision log and stream shipped
differing only in their lane vocabulary and a placeholder string — same layout,
same card, same order, same query — and they read as one thing because they were
one thing. A template has to be able to say what a radar on it lets you _do_
that a stream does not.

So the registry declares behaviour, and the shared components read it rather
than branching on a template id:

- **`order`** — capture order is a choice, not a neutral default. A reading list
  is a `queue` (lane order, then oldest first: a reading list read newest-first
  is a stack, and a stack is how a reading list dies). A decision log is a
  `chronicle` (lane order, then newest first: the top of the page is the state
  of play, not the most recent edit to it).
- **`laneFilter`** — a stream with lanes had nowhere to show them, so they were
  reachable only from a per-card dropdown. Declared and invisible.
- **`facets`** — what the cards lead with. A reading list leads with its source,
  because the link is the object rather than an attachment to it.
- **`capture`** — what capture infers here beyond the universal rules.
- **`supersededStatus`** — the lane a replaced blip is filed into, named here so
  the service layer never carries a lane id.

`packages/ui/src/templates/` still maps by `layout`, not by template id, and a
template whose distinctions are order, capture and card facets still costs no
view code — the reading list is exactly that. What was wrong before was treating
"costs nothing" as the _purpose_ of the abstraction rather than a happy case of
it. The decision log needed a shape a list cannot draw (`layout: 'log'`, a
ledger grouped by lane), and pretending otherwise is how it ended up
indistinguishable from the stream. See `docs/TEMPLATES.md`.

### One blip can replace another

`blips.supersedes_id` is universal rather than gated to the decisions template:
"this replaced that" is a fact about two blips, and gating the storage would mean
a radar switched off that template silently losing its links. The affordance is
registry-gated instead.

Recording the link also files the replaced blip in the lane its template declares
as `supersededStatus`, one call rather than two — the same argument as the
lane/state pairing above. A template that declares `ratifiedStatus` (Architecture)
defers it: the link is recorded when the replacement is written and the replaced
blip is filed when the replacement enters the ratified lane, in that transaction.

**A supersession link never crosses a radar**, and that is a disclosure rule
rather than tidiness: the DTO carries the replacement's _title_, so a pointer
across a boundary would print a title out of a radar the reader cannot see. The
refusal does not distinguish "no such blip" from "a blip somewhere you cannot
see", for the same reason §6 answers 404 rather than 403. Moving a blip between
radars cuts the link in both directions. Deletion is `ON DELETE SET NULL`, not
`CASCADE`: deleting the decision that replaced an older one must not delete the
older one.

### Smart radars resolve against the caller

A smart radar is resolved **against the caller's own readable radars, never the
owner's** (`resolveRadarScope` in `services/blips.ts`).

Two people looking at one shared smart radar legitimately see different blips,
because each is seeing their own material through the same lens. Resolving
against the owner would turn "share a saved search" into "hand over read access
to every private radar I own that happens to carry the tag", which is not what
anybody means by sharing a search.

It is also why a smart radar can never be published: a public reader has no
readable radars, so the only non-empty answer would be somebody else's. That is
refused in `setVisibility`, again by a CHECK constraint, and again in
`requirePublicRadar`.

## 5. Webhooks — the one unauthenticated write

`/hooks/<id>/<token>` is the only route that answers an unauthenticated request
with a write. Everything that makes it safe is an application of a rule that
already existed rather than a new one:

- **A delivery gets no permissions of its own.** It is authorized as the
  webhook's creator through the same `createBlip` → `requireRadar` path a
  browser uses. Losing write access to the radar, or being suspended, kills the
  webhook — with no second code path that could keep honouring it.
- **The token is a credential like any other**: high-entropy random, stored as an
  HMAC keyed by `SESSION_SECRET`, in plaintext exactly once. A wrong token and a
  missing webhook are the same 404, so the URL space is not an oracle.
- **Rate limited per webhook** by a fixed window rolled and counted in a single
  atomic `UPDATE ... RETURNING`, so there is no gap between checking and
  incrementing. It only charges deliveries that presented a valid token: a bad
  token is one indexed miss with no row to charge, and absorbing a flood of
  those is the edge's job.
- **Payloads map by shape.** One obvious message field is the message; as soon as
  there is more than one, every field becomes a labelled line — which is the case
  a form submission actually hits, where picking one field would throw ten away.
  A field lifted into the title, link or tags is not then printed again
  underneath, for the same reason a title is only ever a real heading.

- **The log redacts it, and the logger is what does the redacting.** The ingest
  path carries a live credential, and a request path is the one thing written
  down verbatim on every request. This was fixed once as `safePath` in `app.ts`,
  applied at the single call site that logged a path — so when a second and a
  third appeared (the 5xx branch of `app.onError`, and `hookRoutes.onError`) they
  wrote the token in plaintext, on the same request whose access-log line said
  `[redacted]`. Patching those two would have fixed the two that exist and left
  the next one to be written, so the scrubbing moved into `pino`'s `redact`:
  `path` and `url` take a censor that strips the credential and keeps the id, and
  a raw path cannot reach the log from a call site this rule has never heard of.

  The same omission covered `/api/invites/<token>` and the SPA screen behind it,
  `/invite/<token>` — and that one is not an error path at all. The invitation
  token was written at INFO on every successful click, which is every time an
  invitation works. `scrubPath` is a table of URL shapes that carry a credential,
  so adding a route is adding a row.

The actor is tagged `kind: 'webhook'` so the audit log records which of user,
agent and webhook it was rather than flattening the three together.

## 6. The drop box

One radar per account for things with no home yet. It is a **real radar the user
owns**, flagged `is_drop_box` rather than special-cased, so it can be renamed,
recoloured, shared and deleted like any other and nothing in the app has to know
about it. The alternative — a system-owned radar with no owner — would need its
own answer to every question the ownership model already answers.

It is created on demand rather than at signup, because every account that
already exists needs one too and `ensureDefaultWorkspace` only ever runs once.
A partial unique index on `(owner_id) WHERE is_drop_box` decides the race, not
the application code.

The point of it is the MCP loop: `create_blip` without a radar id captures into it, and
`read_drop_box` hands an agent the pile plus somewhere to file each item.

### 6.1 It is a private inbox, and two rules follow from that

The flag was originally a rendering convenience — a sidebar slot and a glyph.
It is now load-bearing, because the drop box turns out to be the one radar that
is _categorically_ different from the rest rather than differently decorated.

Every other radar is a place somebody decided to keep a kind of thing. Deciding
that is the act; publishing one afterwards is a judgement about material already
grouped on purpose. The drop box is the opposite by construction: it holds
exactly the things nobody has decided anything about yet. Two rules fall out.

**It has no public address.** Not "publishing it is unwise" — there is nothing
in it anyone chose to show. Refused on both halves of "public", because they
come apart: `setVisibility` deliberately _keeps_ a minted `public_slug` when a
radar goes private, so re-publishing restores the same URL instead of silently
issuing a new one. Constraining only `visibility` would therefore leave a drop
box that had ever been published carrying a dormant, working public address one
`UPDATE` away from live. `radars_drop_box_is_never_public` and
`radars_drop_box_has_no_public_slug` (`0011`) make it a fact about the database;
`assertDropBoxMayNotBePublished` makes it a sentence in `setVisibility` and
`rotatePublicSlug`. Same arrangement as `radars_drop_box_is_never_in_a_topic`,
and the same argument for it: an agent over MCP will try, and a constraint cannot
be forgotten by a code path written later.

Sharing it **with a named person** is untouched and stays allowed. That is a
deliberate grant to somebody you name, revocable individually, and it is a
different act from having an address. The distinction is the one the whole of
6.2 turns on.

That paragraph was challenged and it holds. A security review reported the drop
box being shareable as an inconsistency with the two rules above, and it is not
one — the demonstration offered showed sharing working, which is what the
sentence above says it should do. Refusing it outright would take away a named,
revocable grant in the name of consistency with a rule about _addresses_, and it
would undercut the argument 6.2 rests on.

What the review did surface is a boundary this section had not applied to
sharing, and 6.2 makes the argument itself two paragraphs later about webhooks:
_"it matters most over MCP, where an agent holds manage on the drop box the
moment it connects."_ Every word of that is true of `share_radar`. The drop box
is the one radar an agent is routinely pointed at — `read_drop_box` exists to
hand it the whole unsorted pile — and nothing stopped it passing that pile to a
third party.

So **an agent may not share the drop box; a person may.** Same shape as
`assertMayInvite` (§19): an agent may share, because its human could, but an act
whose consequence reaches beyond this account wants a person looking at what
they are handing over. `assertDropBoxMayNotBeSharedByAnAgent` is the one
function, and the `kind` on the actor is the only thing it reads — which is what
makes it a boundary rather than a new rule about drop boxes. Nothing was
materialised and no existing grant was touched, so if Lucas decides the drop box
should be unshareable outright, widening that function and rewriting this
paragraph is the whole change.

**It is a stream or a board.** A template is a set of opinions about what its
blips _are_, and that is its entire value everywhere else. It is exactly what a
holding bay cannot afford: a reading list decides the URL is the object, so an
appointment arrives shaped like something to read; a decision log frames every
entry as a choice with a rationale, and "call the plumber" is not one; a
microblog is a place you publish to; a discussion turns each blip into a thread
waiting for replies that are never coming, and sorts by a reply that never
arrives. What the stream and the board have in common is that neither claims to
know what a blip is — one says only _when_, the other only _how far along_ — and
both are things you empty.

That is declared, not listed: each template carries `inbox: boolean`, and both
the picker and the refusal read it. A sixth template that is a good inbox
declares so and changes nothing else.

Deliberately **not** a CHECK constraint, which is the one place this diverges
from the rule above. The template vocabulary lives in the registry precisely so
that shipping a template is one declaration and no migration — the same
arrangement `blips.status` has — and a CHECK naming template ids would revoke
that and be a second place for the answer to live. `0011` repairs existing rows
and says so at length; `drop-box.test.ts` asserts the _absence_ of the
constraint, so it reads as a decision rather than an oversight.

A newly provisioned drop box is a **stream**, stated in `ensureDropBox` rather
than inherited from the column default. A board asks which column before it will
take a card, and making the first act of capture a filing decision is the
friction the drop box exists to remove.

### 6.2 Letting things in from outside — designed, considered, and declined

**Decided 2026-08-27: a drop box gets no inbound surface, ever.** Lucas closed
the question. A drop box is yours alone and stays that way; the interim refusal
in `createWebhook` below is therefore permanent rather than a holding position,
and the design that follows it is kept as a record of what was weighed, not as
work waiting to be picked up. **Do not build it, and do not leave hooks for it.**

The rest of this section is preserved because the reasoning is worth having if
the question is ever reopened, and because the argument it makes about minting
per-recipient addresses rather than publishing one is a general one — it applies
to any future inbound path anywhere in the product. Read it as an argument, not
as a plan.

---

Lucas asked for two things at once: that a drop box never be public, _and_ that
people outside the account be able to drop things into one. Those are only
compatible if "from outside" means something narrower than "from anyone", and
working out what settles the spam question rather than deferring it. **None of
this is built.** What is recorded here is the reasoning, and the one decision
that is his.

**The interim refusal.** `createWebhook` refuses the drop box today. A webhook
is already an unauthenticated write path into a radar, addressed by an
unguessable URL, minted by its owner — so pointed at the drop box it _is_ this
feature, built by accident and missing every part that needs designing. Nothing
marks an arrival as having come from outside, so a stranger's delivery lands in
the unsorted pile the owner and their agent read as their own; the blip is
authored by the owner under the webhook actor model, which is honest for a form
you wired up and a lie for something a stranger sent; and there is no quarantine,
so the only remedy for abuse is deleting delivered blips one at a time. It
matters most over MCP, where an agent holds manage on the drop box the moment it
connects and would be handed the secret URL in the response. The refusal is
explicitly a holding one, expected to be lifted by whatever 6.2 becomes.

**Two populations, therefore two mechanisms.** Conflating them is the mistake.
A stranger with a link is anonymous, unattributable and unlimited in number:
anything one can do, a script does ten thousand times, and the only handle to
rate-limit against is an IP, which is cheap to rotate. An On My Radar user was
approved through the waitlist by an admin, is attributable to an account, and is
suspendable — spam from one is a moderation problem with an existing remedy, not
an anti-abuse problem. One mechanism with a flag would have to be as strict as
its worst caller.

**The recommendation: you never publish an address, you mint one per recipient.**
This is the part worth arguing for. A single drop address is a spam vector by
construction — once it leaks, the only remedies are rotate (which breaks it for
everybody who had it legitimately) or switch it off. Mint a link _for Ben_,
labelled "Ben", and hand it over: if it leaks or Ben starts spamming, revoke
Ben's link and nobody else's breaks. The spam problem becomes a revocation
problem, and revocation is already solved. It also collapses the anonymous case
into a semi-attributed one — every arrival names which link it came through, so
even a stranger is attributable to the person who was trusted with it.

`radar_webhooks` is already almost exactly that row: one per sender, with a name,
an `enabled` flag, rotation, a per-row fixed-window rate limit charged
atomically, an HMAC'd token that exists in plaintext once, and a 404 that does
not distinguish a wrong token from a missing hook. Every item on the anti-abuse
list — unguessable identifier, oracle-free failure, per-target limit, revocation
without losing the drop box — is solved there already, because it is the same
problem. What would be added is a rendered form at the ingest URL (one textarea,
nothing else, the same capture thesis), a flag distinguishing a human-facing drop
link from an integration webhook, and quarantine.

**Quarantine is the whole answer to spam, and rejection is not.** A stranger's
genuine message and a stranger's spam are the same shape; nothing can decide
between them at the door. So the door should not try. An external arrival must
not enter the pile `read_drop_box` returns — poisoning exactly the surface the
owner and their agent read is the failure mode — and it must not be carried on
`state`, which is the owner's own triage axis, nor on a lane, since the drop box
may be a stream with no lanes. It wants a column on `blips`: `arrived_via` (null
for ordinary capture) plus the link's id, and an optional unverified
`arrived_from` — the name a stranger typed, rendered as untrusted and labelled
so, never linkified. Then "Arrivals" is a second surface the owner triages:
accept, which clears the flag and lets the blip join the inbox, or discard, which
offers to revoke that link on the way out. The drop box's whole premise is that
sorting happens later; this is the same premise applied to who sent it.

**Per-source rate limiting, stated honestly.** An anonymous drop has no source
identity. IP is the only handle, arrives via `CF-Connecting-IP`, and rotates for
pennies. A per-IP limit stops a naive script and nothing else; it is worth adding
for exactly that and worth not claiming as the defence. The real defences are the
per-link limit and quarantine, because neither depends on identifying the sender.

**User-to-user is a different shape.** Addressing must never be by email — that
makes the endpoint an oracle for who is registered, which §14 forbids outright —
so it is by user id or by picking from people you already share something with,
and a target who refuses you answers identically to a target who does not exist.
The rate limit is per (sender, target) pair, which unlike an IP cannot be
rotated. It needs a per-person block list before it ships: a mechanism you cannot
switch off for one person is not one that can safely be switched on. And it
cannot go through `createBlip` as the sender, because the sender has no write
access to the target's radar and `requireRadar` would correctly refuse — the
check belongs in `access.ts` as a sibling of `requireRadar` (`requireDropTarget`,
reading the target's setting and the block list), never as a bypass tucked inside
a service. One place, one implementation, both transports.

**Notifications must be bounded by construction.** The partial unique index on
`(user_id, group_key) WHERE read_at IS NULL` already gives that for free if the
key is chosen properly. An anonymous arrival coalesces on `drop:<radarId>` —
_one_ unread line for every pending arrival regardless of how many arrive or
through how many links, so ten thousand spam drops is "12,431 things are waiting
in your drop box". Not `blip:<radarId>`, which would fold a stranger's delivery
in with the owner's own webhook deliveries. A user drop keys on
`drop:<radarId>:<senderId>`, so the owner can see who; bounded because account
creation is gated by the waitlist and a blocked sender stops generating them.
**Email and push stay off for external arrivals** — an in-app notification is a
set difference somebody reads when they look, an email is something a stranger
put in your mailbox. An unauthenticated path must never reach the mail transport.

**What was needed from Lucas, and his answer.** The question was never the
mechanism — it was whether "private inbox" is allowed to mean "private except
for addresses I hand out". That is a change to what the word means, and it was
his to make. **He said no.** The drop box holds the things you have not decided
anything about yet, and the guarantee that nobody else can put something there
is part of what makes it usable for that. Neither mechanism ships.

## 7. Comments and reactions: participation is a third capability

A blip is one person's captured thought. A comment is somebody talking _about_
it. Keeping those separate is the whole design — editing a blip is still
`write`, while anyone the radar is shared with can join the conversation around
it.

That distinction needs a capability that did not exist. `requireParticipation`
in `services/access.ts` is the only place it is decided, and it is deliberately
**not** `canWrite`:

- A **viewer** may comment and react. That was the ask in as many words — "if
  you share a radar with someone, people should be able to comment on blips they
  don't own" — and widening `write` instead would have handed every commenter
  the right to rewrite the blip underneath.
- A **public link never grants it.** `decide()` says a public link is read-only,
  always, and `role !== null` keeps that true here. Anonymous writes on the
  public surface are a security decision about that surface, to be argued on
  their own rather than arriving behind a feature.
- The **per-radar switch is checked in the service**, so an owner turning
  comments off stops the MCP tool as well as the composer. Otherwise "off" would
  only ever have meant "off in the browser".

Two switches rather than one, because they are genuinely different asks: a
decision log wants comments and no reactions; a public microblog may want
reactions and no thread under every post. Both default to true, which is what an
existing radar was implicitly doing before either existed.

Some smaller decisions that are easy to get wrong:

- **Reading a thread needs only read access.** The toggle gates _writing_.
  Turning comments off on a radar that already has some must not make the
  existing conversation vanish — that reads as data loss rather than as a
  setting.
- **An owner may delete somebody else's comment, but never edit one.** Putting
  words in somebody's mouth is worse than removing them, so moderation stops at
  the delete. Deleting stays reachable when comments are switched off, because
  switching them off is often exactly how somebody starts clearing something up.
- **A thread reads forwards.** It is the one list in this application whose
  cursor runs `>` rather than `<`: a stream is a pile you scan from the top, a
  conversation is a thing you read in order.
- **Reactions are a closed, named registry**, not an open emoji picker — the
  same argument as radar glyphs and accents. A stored key is stable whatever the
  platform renders, an agent can react by name without emitting an emoji, and
  every viewer sees the same six marks rather than a long tail nobody can
  aggregate. `reaction` is deliberately unconstrained in SQL for the same reason
  `blips.status` is: the registry validates it, so adding a mark is one line and
  no migration.
- **The toggle is decided by the primary key.** `(blip_id, user_id, reaction)`
  is what makes reacting idempotent — two clicks that interleave cannot leave
  two rows — rather than a read-then-write in the service that they could race
  inside.
- **Both tables carry a denormalised `radar_id`**, and `updateBlip` moves it
  when a blip changes radar. That column is what authorizes and scopes them, so
  a stale one would strand a comment on a radar its blip has left: readable by
  the wrong people and invisible to the right ones.

### The public thread, and a rule that bites

Serving a published blip's thread means calling `listComments` with a null
actor — and §2's rule says a public link grants access only when it _is the
identifier used_. Resolving the radar by its uuid therefore yields no access at
all, so the public route 404'd on every published blip until the slug was
threaded down to the service.

`listComments` takes an optional `radarRef` for exactly that, and cross-checks
that the radar it resolves to is the radar the blip actually lives on. Without
that check a valid public slug plus somebody else's blip id would read a private
conversation. Both properties are covered in `participation.test.ts`.

## 8. Notifications

Comments and reactions shipped silent, and §7's own limitation list said so:
"nothing tells you somebody commented". That made a shared radar one-way — the
only way to find a conversation was to go and look at the blip. This is what
closes the loop.

### What is worth interrupting somebody for

The test every event had to pass is **"would a person go and look because of
this?"**, because a stream that cries wolf is muted once and then never read
again, at which point it is worse than having none. So the bar is _somebody else
acted on something of yours_, not _something happened somewhere you can see_.

Four kinds, and the fourth is the interesting one:

- **`comment`** — on a blip you wrote, or in a thread you are already in. The
  "conversation you are in" rule is the only one that cannot cry wolf.
- **`reaction`** — a mark on your blip. Only the author, and only when a mark
  goes _on_: taking one back is not an event anybody needs to hear about, and
  notifying on both halves of a toggle would let one indecisive click emit two.
- **`share`** — a radar was handed to you. The only kind that ignores the
  per-radar level, because there cannot be one yet and because it is an access
  change rather than activity: it is the message that tells you the radar exists.
  Raised only when access is genuinely new — promoting a viewer to editor is not
  the same event, and saying so twice is how a stream starts to feel like noise.
- **`blip`** — something landed in a radar. **Silent by default when a person
  captured it**, and that exclusion is deliberate: capture is the primary action,
  and a shared radar between two active people would otherwise emit one of these
  per thought. A **webhook** delivery is different in kind — it arrives from
  outside with nobody watching, which is the entire reason webhooks exist — so
  the radar's owner and the webhook's creator are told without opting in.

Explicitly **not** notified: your own actions; a comment on a blip you can merely
read; a reaction to somebody else's blip; a reaction being withdrawn.

`mention` was added later and is the one kind that reaches somebody the rules
above would miss — neither the blip's author nor already in the thread. See §18.

### Coalescing is decided by the database

Ten reactions on one blip is one notification, and that had to be settled before
the schema rather than after. Each event computes a deterministic **group key**
(`comment:<blipId>`, `reaction:<blipId>`, `share:<radarId>`, `blip:<radarId>`),
and a **partial unique index** on `(user_id, group_key) WHERE read_at IS NULL`
means one open notification per person per key. The service upserts against that
index with `ON CONFLICT ... WHERE read_at IS NULL`, so folding is one atomic
statement with no gap between deciding and writing — the same argument as the
`(blip_id, user_id, reaction)` primary key behind the reaction toggle.

**Reading closes the window.** Once a notification is read it no longer matches
the index predicate, so the next event starts a fresh row: "you dealt with that
one, this is new". That is also what makes a digest scheduler unnecessary. Email
is sent on row _creation_ only — never on a fold — so a burst is one message, and
the next one cannot arrive until the person has read this one. No worker, no
timer, and nothing extra to keep alive on a single replica.

`count` is incremented on every event and never decremented: a reaction taken
back does not un-happen. `actor_ids` keeps distinct people, most recent first,
capped — so the sentence names a few and counts the rest.

### The stream sorts on `created_at`, not `updated_at`

A folding event moves `updated_at`, and a mutable sort key makes a keyset cursor
non-total — a notification could duplicate or vanish mid-scroll, which is exactly
the property §9's cursor rule exists to prevent. So the list is keyset-paginated
on `(created_at, id)` like every other list here. The cost is real and worth
stating: a folded event grows a row's count in place rather than jumping it back
to the top. The count and the un-seen flag are what draw the eye instead.

### Seen and read are different questions

`seen_at` is "has this been displayed" and drives the ping; `read_at` is "have I
dealt with it" and drives the badge. Opening the panel stops the ping without
claiming anything has been handled, which is why the badge keeps its count until
you actually deal with something. A fold clears `seen_at` — something new
happened, so it should draw the eye again — but it cannot clear `read_at`,
because a read row is excluded by the index predicate before it gets there.

### The per-radar level is not a column on `radars`

`commentsEnabled` and `reactionsEnabled` are properties of the **radar**: the
owner sets them for everybody. How loud a radar is, is a property of **one
person's relationship to it** — a noisy shared radar has to be muteable by the
one person it is drowning without going silent for everyone else. So it is a
`(user_id, radar_id)` row, defaulting to `involved` by absence, and setting it
needs only `read` access: it is a statement about your own attention, not about
the radar.

`all` is what makes the excluded event available rather than impossible: turn a
radar up and every blip captured into it notifies you too.

### Recipients are re-derived from live membership, every time

Never from who was historically involved. Somebody whose share was revoked stops
being notified immediately — and since a notification carries an **excerpt of the
content**, that is a disclosure rule rather than a tidiness one. Suspended and
pending accounts are excluded in the same query, because a suspended account has
had every session revoked and email would be the one path still talking to
somebody who has been shut out.

Removing a member also **deletes their notifications for that radar**. Re-deriving
recipients stops new ones, but the ones already written carry a snapshot excerpt
of the content — so leaving them would hand a removed member a readable copy of a
conversation they can no longer open. Same reasoning as §14's rule that suspension
revokes every session immediately rather than waiting for a cookie to expire: the
moment access ends, it ends.

Fan-out is wrapped exactly like `recordAudit`: a notification that cannot be
written must never turn a successful comment into a 500.

### Push is hand-rolled, and there is a test that earns it

`services/push.ts` implements RFC 8291, RFC 8188 and RFC 8292 against Node's own
crypto rather than taking `web-push` — the same call as the `fetch`-based OIDC
client and the hand-rolled unfurler, plus what §9's AWS SDK story has already
taught this repo about deep transitive trees at the audit gate.

The risk that buys is **silent** breakage: bad crypto produces a 201 from the
push service and nothing on the device. `push.test.ts` closes it by performing
the _user agent's_ half of the protocol — it generates a subscription keypair,
encrypts through the module, then derives the key from the other side and
decrypts. A passing round trip is evidence a real browser can read the payload,
because it is the identical computation. A second suite runs the whole delivery
leg against a fake push service on a real socket and decrypts what arrived.

Two real defects surfaced while writing those tests, both of which would have
shipped silently:

- **Node imports an EC JWK whose `d` bears no relation to its `x`/`y` without
  complaint** (measured, not assumed). A VAPID pair assembled from two separate
  generations would boot, hide nothing, sign every token with the wrong key and
  be rejected with a bare 401. `vapidKey` re-derives the public point from the
  scalar and refuses a mismatch.
- **`ecdh.getPrivateKey()` returns 31 bytes when the scalar has a leading zero**,
  roughly one generation in 256. That key would be written into a secret and fail
  only at the first send. It is left-padded to 32.

Push absent is a supported state, exactly like storage and SSO: the VAPID secret
is `optional: true`, the server logs a line at boot, and the UI hides the control
rather than offering one that cannot work.

The **service worker is served from the origin root**, and that is load-bearing
rather than tidy: a worker's scope is the directory it was served from, so one
under `/assets/` would register without error and never deliver anything. It is
also kept out of the year-long immutable cache rule — a worker pinned for a year
is a worker that cannot be replaced. It has no `fetch` handler on purpose;
offline capture is a real feature that deserves its own design, and a half-built
one that silently serves stale bundles is worse than none.

### The widget cannot be removed, by construction

The ask was literal, so it is honoured literally: the dashboard's Activity panel
has **no row in `dashboard_widgets`**. It is not part of the draggable grid at
all, so there is nothing to delete, nothing to drag off the edge, and no stored
state in which a dashboard comes back without it. Making it a real grid item and
special-casing the remove button would have left exactly that state reachable —
an older row, a hand-edited layout — and "cannot be removed" would quietly have
become "usually present". The cost is that it cannot be moved or resized either,
which is the right trade for the one panel whose job is to be found without
looking.

It sits above the tab strip because activity is not per-tab; duplicating it into
every tab would make clearing it on one look like it failed on the others.

**Revised 2026-08-27: with nothing outstanding it renders nothing at all.** This
paragraph used to say it collapsed to one quiet line — "Nothing new — you are all
caught up" — and defended that as "collapsing is not removal". The measurement
that overturned it: the collapsed state is still a full-width band, ~60px at the
very top of the landing screen, spent to report the absence of information. A
smaller version of the cost is not an answer to the cost.

The argument the old paragraph made was that the panel's position has to be
learnable. That is still right, and it is about where the panel appears when
there **is** something. The entry point is not at stake either way: Activity is a
row on `/radars`, an item in the sidebar and a tab on a phone, all three badged.

"It cannot be removed" is unchanged and is still true by construction — there is
no row in `dashboard_widgets` to delete. Rendering nothing when there is nothing
to render is not the same as being removable.

### What the MCP surface got, and what it deliberately did not

**An agent may read and clear your notifications; it may never change how or
whether you are notified.**

`list_notifications` and `mark_notifications_read` exist. Reading is the product
loop — "catch me up", then act on what is there — and every line arrives as a
finished sentence rendered by the same code the SPA uses, so there is one
phrasing rather than two. Clearing is its honest completion and destroys nothing:
the row stays and `read: false` puts it back.

There is **no** tool for the email switch, browser push, the per-radar level or
the device subscriptions. Those are a person's control over being interrupted,
and an agent quietly turning somebody's email off is exactly the class of thing
the consent screen in §14 exists to prevent — it could make itself the only thing
that knows something happened. Device subscriptions are additionally push
credentials belonging to one browser.

### Sharing now tells the recipient, on both transports

`shareRadar` raises the email and the notification itself. They used to live in
the REST route, which meant the MCP `share_radar` tool granted access in total
silence — an agent could hand somebody a radar and that person would never find
out. Telling the recipient is part of what sharing _means_, so it belongs on the
one code path both transports run, exactly like the authorization check above it.

### The email path is general enough for the next thing

`services/mail.ts` is a `Message` builder plus `sendMailQuietly`, and
`notificationMessage` is deliberately shapeless — a rendered sentence, an optional
excerpt and one link — because the sentence is already assembled by the service.
Adding a notification kind needs nothing there at all.

The adjacent piece of work, **share-by-email invitations for people who have not
signed up**, reused that path exactly as predicted and is now built — see §19 for
the signed link, the waitlist bypass and the boundary an agent may not cross.
`notificationMessage` needed no change at all, which was the point of leaving it
shapeless.

The notification fan-out is still not that path and must not become it: an
invitee has no user row, so there is nobody to hold an in-app notification, and
email is the only channel that exists for them.

## 9. The database

Hand-written SQL migrations in `packages/server/drizzle`, applied forward-only by
`src/db/migrate.ts` and recorded with a checksum. Editing an already-applied
migration is a hard error rather than a silent divergence.

Drizzle's table definitions in `src/db/schema.ts` mirror that SQL for typed
queries, but the SQL is the source of truth: it carries generated columns,
partial indexes and CHECK constraints a generator would not round-trip.

Two details worth knowing:

- **`blips.search` is a GENERATED tsvector**, weighted title > tags > url > body.
  Generated rather than trigger-maintained so it can never drift from the row.
  It is deliberately absent from `schema.ts` — it is only ever matched against in
  raw SQL, never selected or written.
- **`omr_tags_text()` exists because `array_to_string` is only STABLE**, and
  Postgres refuses a non-immutable expression in a generated column. For `text[]`
  it is genuinely deterministic, and the wrapper says so. Without it the tags
  would not be searchable in free text at all.

The stream is keyset-paginated on `(pinned, created_at, id)` with a row-value
comparison that matches the `ORDER BY` exactly. That triple cannot tie, which is
what makes the cursor total — capturing a blip mid-scroll can neither duplicate
nor skip a row the way an `OFFSET` would.

Two templates sort by **lane rank** before time (§4), so for those the cursor
carries the rank as a fourth key and the comparison names it. Row-value
comparison is only total when every key sorts the same way, so neither mixes
directions: `queue` runs ascending throughout, with `pinned DESC` written as
`NOT pinned ASC`; `chronicle` runs descending throughout, with the rank negated
so the lanes still read forwards. Capture order is unchanged and stays served
outright by `blips_radar_created_idx` — it is the hot path, and the two lane
orders sort on a CASE expression that cannot be index-only. That is a trade made
knowingly for templates whose radars hold tens to low hundreds of blips.

A cursor issued before lane ordering existed carries no rank, reads as 0, and
keeps paging.

### Organizations are where things live, not who may see them (0089)

Every user has exactly one _home_ organization (`memberships.is_home`, unique per user),
today a personal one they own. Radars, topics, dashboards, agents, PATs and OAuth grants
carry the `organization_id` they are filed under (`audit_log` has it nullable, unfilled for
history). Blips do not: they inherit their radar's by join.

Triggers keep the column honest for every writer, including the previous release during a
rolling deploy: an insert that omits it gets the owner's home org, a container may only be
filed under an organization its owner belongs to, and a container whose owner changes moves
to the new owner's home unless they share its organization. `omr_ensure_home_org` is
idempotent and called eagerly, because sign-up can create a user and a container in one
transaction and the constraint trigger on `users` only runs at commit.

Nothing in `access.ts` reads any of this yet. An organization's owners and admins get names,
roles and counts (`services/organizations.ts`), never blips, comments, briefs or memories.

## 10. Direct attachments, with a bounded image-view exception

The browser asks for an upload ticket, `PUT`s straight to MinIO with a presigned
URL, then tells the server the object key. Ordinary reads are a 302 to a short-lived
presigned GET. Those paths do not buffer file bytes in the pod, and an
attachment URL cannot be forwarded beyond its expiry.

Two guards: a key must start with `radars/<thatRadarId>/` before it can be
attached (otherwise a caller could claim somebody else's object by guessing a
key), and the object is `HEAD`ed to confirm it actually landed. Content types
that execute in a browser — `text/html`, `image/svg+xml` — are refused.

The refusal is a policy about uploads; the download is where the browser fact
is enforced. `createDownloadUrl` serves anything that would render as an
active document — the refused types, `text/xml`, `application/xml`, `text/xsl`
and every `+xml` type, all of which can run script — as an
`application/octet-stream` attachment, whatever it was stored as. That covers
objects stored before a type was refused, and email attachments: a MIME part
typed `text/html` or with a malformed type is stored as opaque bytes rather
than bouncing the whole message (`content-types.ts`).

### Direct image viewing for agents

`read_attachment_image` is an explicit exception: an authenticated agent can
receive the original raster as an MCP image content block, without fetching a
signed URL or copying base64 into tool text. `GET /api/attachments/:id/image`
uses the same service and returns private, uncached bytes. Ordinary uploads and
downloads keep their direct storage path; no public image-read route is added.

Only static PNG, JPEG and WebP are accepted. The stored size and MIME, provider
size/MIME, magic signature and native decoded format must agree. The reader
caps input at 4 MiB, decoded pixels at 8 million, each dimension at 8192 and
channels at four. Sharp fully decodes with `failOn: warning`; animated inputs,
malformed or incomplete data, HTML/SVG and unsupported formats are refused.
Nothing is resized, truncated or substituted. Refusals point to the existing
`download_attachment` tool for the original.

An abort signal limits storage reads to ten seconds, destroys stalled or
oversized Node streams and aborts the SDK request. Sharp's native processing
timeout is five seconds. A process admits two reads/decodes at once and refuses
extra work immediately; it does not build an unbounded queue. This bounds both
input buffers and native decoded allocations per pod. Storage errors do not log
object keys, signed URLs, provider responses or bytes.

The shared attachment lookup uses current `requireRadar(..., read)` access.
Image reads also require a fresh active user and a parent blip in the same
radar. Bearer connections are refreshed by row identity through the same PAT/OAuth
resolver predicates, including live expiry, revocation and scope consent. The
service repeats those checks after awaited storage/decoding. A changed
attachment, parent move, revoked grant or suspended user discards the result.
Sticky client-facing provenance is marked as untrusted image content in MCP;
filenames and customer prose are not added to the result. When the separate
account-closure lifecycle lands, this service must also compose its activity/read
barrier: the recheck alone is not proof that a simultaneous closure waits for
all already-running reads. That integration is not present in this main-based
slice.

### Deleting something takes its bytes with it

The `attachments` rows are the authoritative
record of what exists in the bucket — and `attachments.radar_id` is
`ON DELETE CASCADE`. `deleteRadar` deleted the row and stopped, so the cascade
destroyed that record and every object the radar owned stayed in MinIO forever,
unreachable and uncountable. `deleteObjects` had documented itself as cleanup
"after a blip or radar is deleted" the whole time and had one caller, the
single-blip path.

Unbounded growth is the cheap half; the expensive half is retention, because
files somebody believes they deleted are still there. The keys are now read
**before** the row goes, which is the whole of the fix — looking afterwards finds
nothing, and a version that did would clean up zero objects while every "it was
called" assertion still passed. Not awaited, on the same argument as
`deleteBlip`: the radar is gone from the database either way, and a MinIO outage
must not turn a delete into a 500 that invites a retry.

## 11. Blip bodies are user content rendered as HTML

`packages/ui/src/lib/markdown.ts` escapes the source **in full first**, and only
then introduces a fixed set of known-safe tags. Safety comes from that ordering,
not from filtering afterwards. Link targets are separately restricted to `http`,
`https` and `mailto` — the only place a URL reaches an attribute.
`markdown.test.ts` exists to fail loudly if that ordering is ever changed.

## 12. Outbound requests to user-selected URLs

Link previews and Web Push both connect to URLs supplied by a user. Both use
`services/public-request.ts`, which resolves every candidate address, refuses
private, loopback, link-local and CGNAT destinations, and pins the connection to
that vetted result. The deadline includes DNS and the socket; response bodies
are capped. Link previews follow redirects manually and recheck every hop.
Push requires HTTPS and never follows a redirect. Its endpoint is a credential
issued by a browser's push provider, not a reason to trust arbitrary routing.
Preview failures return `null`; retryable push failures reach the outbox.

### Checking an address is not the same as connecting to it

The paragraph above was true and the code was still vulnerable, because it
resolved the hostname, checked every answer, **threw the answers away**, and
then called `fetch(url)` — which resolved the same name a second time and
connected to whatever came back. Two lookups, two answers: a URL on a nameserver
the attacker controls, answering with a TTL of 0, passes the check on the first
answer and is connected to on the second. And it is not blind, because the
`<title>` and the `og:*` tags are stored on the blip and rendered straight back.

The fix is to resolve once and connect to exactly what was vetted, which means
owning the DNS step. `node:http`/`node:https` take a `lookup` hook; global
`fetch` has no equivalent without adding undici as a dependency, so the transport
is the core modules and not `fetch`. The hook ignores the hostname it is asked
about and returns the vetted list, so there is no second resolution for anything
to change underneath — while the request still carries the real hostname in
`Host` and in the TLS SNI, so certificate validation is untouched.

Two smaller things went with it, both of which had a test passing for the wrong
reason:

- The **scheme check was outside the loop**, so a redirect to `file:` or `data:`
  was accepted here and refused only because `dns.lookup('')` finds nothing. It
  is checked at every hop now — `gopher://host/` has a host and would have gone
  through.
- **`URL.hostname` keeps the brackets on an IPv6 literal**, so `isIP('[::1]')` is
  0 and the entire IPv6 branch was dead code; `http://[::1]/` was refused by a
  failing DNS lookup rather than by the guard.

Un-bracketing the literals is what made a third defect reachable, and the new
test caught it before it shipped: `new URL()` normalises
`http://[::ffff:127.0.0.1]/` to `[::ffff:7f00:1]`, which a dotted-quad regex does
not match. `isPrivateIpv6` now parses to sixteen bytes and judges those —
IPv4-mapped and NAT64 by the IPv4 they carry, `::/96` refused outright, fc00::/7,
fe80::/10 and ff00::/8 refused, and anything unparseable refused rather than
dialled. Bytes have one spelling; string prefixes do not.

A full DNS-rebinding demonstration needs control of the OS resolver, which is not
something a test here can take. What `unfurl.test.ts` proves instead is the
property that makes rebinding impossible: the socket is handed the vetted address
and DNS is consulted exactly once per hop. The transport is mocked and the logic
is not, so the hop loop, the redirect walk and the vetting all run for real.

## 13. Sign-in

Six-digit codes are low entropy on purpose — they have to be typed. The security
comes from a 10-minute TTL, single use, a five-attempt cap, and six requests per
address per hour. Only an HMAC of the code is stored, keyed by `SESSION_SECRET`,
so a database dump alone is not enough to sign in as somebody.

Requesting a code answers identically whether or not the address has an account:
the response must not become an oracle for who is registered.

OIDC is implemented against `fetch` (with `jose` for the signature) rather than an
OIDC library, so the flow can be held to the exact checks it needs: the code is
exchanged over a direct back-channel TLS call to the token endpoint, with the
client credentials and a PKCE verifier this server generated, and the ID token is
verified against the provider's JWKS (issuer, audience, authorized party, expiry and
this attempt's nonce). Userinfo supplies the profile and can never change who signed
in. Endpoints come from the discovery document, or from explicit `OIDC_*_ENDPOINT`
settings for a provider that does not serve one; there is no guessed fallback.

## 14. Signup is open but waitlisted

New accounts land in `pending` and see only the waiting room. `ADMIN_EMAILS` and
`AUTO_APPROVE_EMAILS` skip the queue. Approving sends an email; suspending
revokes every session immediately rather than waiting for a cookie to expire.

`findOrCreateUser` only decides the _initial_ state, so re-authenticating can
never quietly un-suspend an account.

`SIGNUP_MODE=open` ends the waitlist: every new sign-in lands `active`, the form
answers "signup is open" and creates nothing, and a still-`pending` account is
admitted (`admitOnOpenSignup`, audited `user.approve` via `open-signup`, no
approval email) the next time it signs in or presents a live session. Only
`pending` moves; a suspended account stays suspended. The default is `waitlist`.

There is one more way past the queue, and it is the only one that is not a
config list: **an invitation from an admin**. It is decided at account creation
from live database state, it dies with the inviter's admin bit, and it can never
un-suspend anybody — see §19, which is where the whole boundary is drawn.

### The waitlist form joins the same queue

The marketing site's `/waitlist` form posts, same-origin and as JSON, to
`POST /api/waitlist` (`{ email, name, useCase?, source?, website? }`, where
`website` is a honeypot, and `name` — 1–120 characters, not blank — is required
so the admin deciding has something to call them). It does not have a queue of its own: it creates the
same `pending` user a first sign-in would, so the admin console lists it,
approval (`activateUser`) acts on it unchanged, and a later sign-in with that
address finds the account already queued rather than making a second one. What
the form said — name, use case, source, when — sits beside the row in
`waitlist_requests` (`drizzle/0037`), not on it: nobody proved they own the
address, so the typed name is shown to the admin as what the form said and is
never written into the account's own display name.

It is the one unauthenticated endpoint that mails an address the caller chose,
and every rule follows from that (`services/waitlist.ts`):

- **One answer.** New, already queued, an existing account, a honeypot hit: the
  same `202` and the same body. Mail goes through the outbox after the
  response, so its timing does not tell them apart either.
- **Never a new way in.** It only ever creates `pending`, and it creates nothing
  for an address a first sign-in would admit (`ADMIN_EMAILS`,
  `AUTO_APPROVE_EMAILS`, an outstanding admin invitation) — a pending row made
  here would take that away, because the initial state is decided once.
- **One confirmation per address per day**, charged in the statement that
  decides to send it, and **none** to an active or suspended account.
- **A per-network ceiling** (`WAITLIST.requestsPerNetworkPerHour`, 10) keyed on
  `CF-Connecting-IP` through the sign-in limiter's window table; no trusted
  header, no key.
- Field caps in `waitlistRequestSchema`, and JSON only.

Turnstile was considered and left out: with no enumeration, a daily cap per
address and a per-network ceiling, a bot can at most put an address it chose on
the waitlist once and send it one confirmation a day — the same exposure the
sign-in form already has. It is the next step if the queue fills with junk.

Approval is where onboarding starts: the approval email names the address and
sends the person to `/login` to sign in with it by code.

## 15. MCP

Streamable HTTP in stateless mode: a fresh `McpServer` and transport per request,
so nothing is kept between calls and a rolling deploy cannot strand a session.

On My Radar is also its own OAuth authorization server for remote MCP clients —
dynamic client registration, authorization code, mandatory PKCE, rotating refresh
tokens. There are no confidential clients (an MCP client running inside somebody
else's product cannot keep a secret), so security rests on PKCE plus an
allow-list of redirect hosts. Consent is a real screen in the SPA and is never
auto-approved: an agent asking for access to somebody's private thinking should
have to say so out loud — and what it says is now what is enforced, which for a
while it was not. §21.

## 16. The interface

The default application shell uses readable, sentence-case sans-serif labels,
timestamps, tag rows and counts. Blip reading content retains its serif voice.
The earlier monospace instrument treatment is design history; explicit radar
and social themes can still choose their own type and colors. Navigation and
management controls stay consistent across those themed reading surfaces.

Colour is almost entirely deferred. The shell is neutral ink-blue; each radar
floods its own accent through `--accent-*`, set on a container element rather
than `:root` so two radars can sit side by side on a dashboard, each in its own
colour.

The signature element is the **bearing strip** under a radar's header: one tick
per blip, positioned by when it was captured across the radar's lifetime, taller
as it gets more recent. It is a readout of the radar's own activity — a radar
filled in one burst looks nothing like one filled steadily over months, and you
can see which you are looking at before reading a word. Below a six-hour span
there is no shape to show, so the ticks spread evenly rather than piling up at
the left edge and reading as a rendering fault.

A **hashtag is the one piece of chrome that lives inside the ink** — it is
written mid-sentence, in the serif, and has to read as a door out of the blip
without shouting over the words around it. So it gets the accent colour and a
hairline underline that fills in on hover, rather than a chip. `.blip-body a` is
more specific than `.tag-link`, so there is an explicit override stopping a tag
from wearing both the link underline and the border at once.

The **board** is an instrument panel of its own: columns are hairlined channels
rather than cards, and the only colour is each blip's accent rule plus the lane
header lighting up under a drag. Terminal lanes are dimmed, never hidden — a
Done column you cannot see is a Done column you stop trusting.

### The board budgets its lanes, because no lane floor could work

Two reports about the Kanban pulled in opposite directions. The board must not
scroll sideways — dragging a card across a board that is scrolling under you is
the worst gesture in the product. And the cards must not be so narrow that the
controls on them disappear. Sharing the width between five equal lanes satisfies
the first by breaking the second.

The interval between them is **empty**, and that is arithmetic rather than taste.
Measured on 2026-08-27: a 1366px laptop leaves the board 1054px (the shell costs
264px beside the viewport with the sidebar expanded, 60px railed); a board card's
meta row had a min-content width of 283px, so the edit control was only fully
inside the card once the lane reached about 317px; five lanes at 317px is 1585px.
No value of a lane floor is both wide enough to hold a card and narrow enough to
fit five of them. Lowering the floor to 200px, which is what the first fix did,
bought the "no scrollbar" half and paid for it with the other half.

So the two halves are answered separately.

**A card inside a lane lifts its action cluster out of the meta row.** It is
pinned to the card's top-right instead of competing for the row's width, which
removes the arithmetic rather than tuning it — no lane width can push the
controls outside the card again. Measured at 210px wide inside a 270px card at
the floor. This is the whole of the "I don't see the button to edit" fix, and it
is independent of anything below.

It keys on `inLane`, not on `compact`, and the difference is not pedantry: a
timeline post is compact too, and it has all the width it needs. Keyed on
`compact` the first time, a floating control box appeared in the middle of the
microblog's reading column — precisely the chrome that template is defined by
removing — and a screenshot is what showed it.

**The board then keeps a budget.** It measures itself, works out how many lanes
clear `--lane-floor` once the others are railed, and opens exactly that many.
There is no `overflow-x` anywhere on it: the open lanes are sized from a width
measured before layout, so the row cannot exceed its box and there is nothing to
scroll. `--lane-floor` and `--lane-rail` live on `.board` and are read off the
computed style by `useLaneBudget`, so the stylesheet that lays the lanes out and
the arithmetic that counts them cannot drift — a budget computed from a stale
copy of the floor is the bug this replaces.

A lane that does not fit becomes the **furled rail** this file already had:
visible, counted, still a drop target, and now clickable across its whole 44px
rather than at a 12px glyph inside it. Which lanes are open is an ordering,
seeded terminal-last so Done and Blocked rail before the lanes work moves
through; clicking a rail brings that lane to the front and pushes the least
recently wanted one out. An explicit furl still wins over the budget, so
`templateConfig.collapseDone` means exactly what it meant.

The floor rose from 200px to 288px and stopped being about chrome at all. At
288px a card sets about 33 characters to the line in the reading serif, rather
than the three-word ladder a 200px lane produced. It is now a statement about
reading, which is the only honest reason for a lane to have a minimum.

Measured, sidebar expanded / railed, with the five Kanban lanes:

| viewport | expanded            | railed             |
| -------- | ------------------- | ------------------ |
| 1366     | 3 × 309px + 2 rails | 4 × 294px + 1 rail |
| 1440     | 3 × 334px + 2 rails | 4 × 312px + 1 rail |
| 1920     | 5 × 303px           | 5 × 303px          |

Nothing scrolls sideways at any of them. Furling the sidebar still buys a whole
lane, which is what it was asked for — the two controls remain one fix.

The budget does not run on a phone. There the lanes are a pager and one lane is
drawn at a time, which answers the same question with the only answer a 390px
screen has. `packages/phone` asserts that no lane is ever railed at that width,
that the next control actually moves you, and that a chip is a jump rather than
only a readout of where you are.

**The card inside that lane is full width, and was not.** `inLane` lifts the
action cluster out of the meta row, which is the fix for a column narrower than
the card wants — and a phone lane is the entire screen, so the arithmetic it
answers does not exist there. Floating it anyway laid the cluster on top of the
byline, which nobody saw while the cluster was invisible at rest and which a
screenshot showed the moment it stopped being. `inLane` is now `desktop`.

**The horizontal-scroll half of `23083131` is settled and is now a guarantee.**
Measured at 1024, 1152, 1280, 1366, 1440 and 1920, the board does not scroll
sideways at any of them, and on a phone it is a pager. That was recorded and not
asserted while the two consolidated reports pulled against each other; a suite
should not take a side in a live argument, but it should hold a settled one. The
lane _widths_ stay recorded rather than asserted — density is a judgement,
scrolling is not.

### The sidebar has one plus and one pen

Two `+` glyphs sat a few rows apart in the rail doing different things — quick
drop and new radar — and furled to bare icons they were the same control twice.
They were never the same kind of thing: capture is a **verb**, and new radar is a
**list gaining a row**. Capture takes the compose glyph, in the accent, on the
desktop rail and in the phone tab bar alike. `+` is left meaning only "add to the
list under this heading", which is also why it is the control that offers topics:
one glyph, one meaning, and the menu says in words which thing it will make.

**The mark is the furl control when the sidebar is railed.** Expanded, the
control is a chevron at the end of the brand row, which is right and unchanged.
Railed there is no end of the row — 60px holds one glyph — so the row used to
turn into a column and drop the chevron onto a second line under the logo.
Hovering the mark now swaps the radar sweep for the panel glyph in the same 34px
box, so the brand row is one row at one height in both states. Nothing is lost by
the mark not linking to `/` there: Dashboards is the next row and it is the same
destination.

A section heading in the rail has no heading — `display: none` takes the label —
so `.sidebar-section` grows a hairline rule instead. The rule is the heading,
drawn as a line, and without it the `+` is a glyph in a column of glyphs with
nothing saying what it adds to.

The rail's items name themselves on demand (2026-09-26, approved from a mockup):
pointing at one, or tabbing to it, floats its name — with its unread count or
⌘K — beside the rail, over the page. One label, portaled and `position: fixed`,
because the rail scrolls and would clip anything inside it; clamped to the
viewport; no pointer events, so it can never take a click meant for the page;
and `aria-hidden`, because each item keeps its own name in the accessibility
tree (visually hidden rather than `display: none`, which is also why the rail's
`title` tooltips could go instead of doubling it). Unread is a dot on the glyph.

The **timeline** is defined by what it removes. No kind badge, no triage chrome,
no filter chips: a post is a thing you wrote, not a thing to be processed. What
is left is the ink half at full strength, with the instrument voice reduced to a
timestamp and a date rule.

Component CSS lives in `@layer components` deliberately. Unlayered rules beat
Tailwind's layered utilities, so a bare `.btn { display: inline-flex }` silently
defeats every `lg:hidden` on a button — which is exactly what happened before the
layers were added.

### The phone is a different frame, not a narrower one

Desktop is a sidebar and a content pane, and the sidebar furls to a rail of
glyphs. A phone gets a **bottom tab bar** — Boards, Radars, capture, Drop box,
You — with capture in the middle where the primary action lives in every
application built for a phone. There is deliberately no mobile title bar: it
carried the wordmark and nothing else, stacked above each screen's own header,
and on an 844px-tall phone two headers before any content is a third of the
viewport spent saying where you are.

**Radars is a screen, not a drawer.** The first version reached the sidebar by
sliding it over the content. Lucas's words were "clunky feeling", and the reason
is structural: an overlay is a _modal_ gesture doing a _navigation_ job, so the
back gesture does not undo it and the page behind is neither gone nor usable.
`routes/radars.tsx` is a full-width list; tapping a radar pushes into it, the
back gesture returns to the list, and the tab bar never moves. The drawer was
removed rather than kept alongside — two paths to the same place is how one of
them rots. Sign out and the waitlist link moved to Settings, and the notification
badges moved onto the radar rows, because the rail is no longer rendered there.

### The phone grew three idioms, because fit is not feel

The push before this one delivered _fit_ — right sizing, right tap targets, a
settings page instead of a 3.2-screen sheet — and Lucas's card stayed open on
purpose, because "it just feels like a smaller version of the desktop app" is
about idiom. Three native conventions were simply absent. They are the answer to
`0e00d89b`, and each one is driven rather than described by
`packages/phone/src/idiom.ts`.

**One lane at a time on a phone board.** Already shipped with the pager, and
finished here — see the board section above.

**Screens push and pop.** Every route replaced the last with no motion at all,
which is the biggest "this is a website" tell there is: depth is how a person
keeps their place. Going into a radar now arrives from the right, coming back
arrives from the left, and there is a back control in the pane. Switching tabs is
neither, because Boards, Radars, capture, the drop box and You are peers rather
than rungs — sliding sideways between them would say something false about where
they sit. The scroll offset of a screen comes back when you do.

The back control is **not** the mobile title bar this frame was defined by
removing: no wordmark, no painted band, not sticky, and rendered only when the
stack has something underneath it — which is nowhere on any of the five tab
roots. A band that is on every screen is chrome; one that appears only where
there is somewhere to go is an affordance.

Direction is decided from a stack rather than from the URL's shape, which lies —
`/radar/a` to `/radar/b` is neither deeper nor shallower. A path already in the
stack below the top is a pop and truncates it; anything else is a push.

**The stack is a module singleton, and that is a symptom.** Every authenticated
route in `router.tsx` renders its own `<RequireAccount><Screen /></RequireAccount>`,
so React sees a different element type at that position on each navigation and
tears the whole frame down — shell, sidebar, tab bar and guard — rebuilding it
from nothing every time you move. A `useRef` in the shell is therefore
reinitialised by the very event it exists to observe, and the first version of
this could never see a single transition. The structural fix is a pathless layout
route mounting the shell once above an `<Outlet />`; it renames every route id
(`/radar/$radarId` becomes `/_app/radar/$radarId`) and so touches seven route
files, which is wider than a layout pass should reach. It is recorded here as a
defect of its own rather than folded in silently.

**Swiping a blip triages it** — right for done (or the template's own done
lane), or back to work if it is already settled; left for later, or dropped if it
is already later. What each direction does is the contract's `triage.ts`, shared
with iOS (UI-CONTRACT §11 records how the two were unified on 2026-09-26). On the
stream, the reading list and the drop box — not the timeline, whose posts show no
triage, so a swipe there changed something invisible — and never on a board card: a lane
that pages horizontally and cards inside it that triage horizontally are two
gestures competing for one axis, and no threshold resolves that. `touch-action:
pan-y` gives the browser first refusal on the vertical gesture _before_ the first
move event exists, which is the only way to win that reliably; the angle test in
`components/swipe.tsx` is a second gate, not the first.

Two rules bound what a gesture is allowed to do. **Everything it does must be
reversible**, because a gesture has no confirmation step by definition — both
directions are one field write with a known previous value, and the toast carries
the undo. Delete stays a button with a confirm behind it, which is the same rule
that separated reply from delete in a discussion thread. And **every action has a
control**, because a gesture is unreachable by keyboard, switch and screen
reader: the lane or state select in the card's own cluster does exactly what the
swipe does.

### Four things this uncovered, none of them new

**The action cluster was invisible on a phone and still hit-testable.** Edit,
pin, delete and the lane select were `opacity-0 group-hover:opacity-100`. Those
are Tailwind _utilities_, and utilities outrank `@layer components`, so no rule
in the stylesheet could ever have turned them back on — this is the same cascade
trap as the unlayered `.btn`, in the other direction. A phone has no hover and a
tap focuses nothing, so on a touch device the cluster sat at zero opacity
forever: re-triaging, editing, pinning or deleting a blip from a phone was not
possible, and the controls could still be pressed by accident, which is worse
than absent. The reveal now lives entirely in the stylesheet, where
`@media (hover: none)` can say "at rest" — quietly, at 0.62, in 44px boxes.

**`prefers-reduced-motion` meant 1ms, not none.** A universal
`* { transition-duration: 1ms !important }` — the version of this reset everybody
copies — silently outranked four specific `transition: none` rules elsewhere in
the file, all of them dead from the day they were written, and it is precisely
the shortened animation the setting is not asking for. It is `0s` now, and it
stops animations as well: naming four `@keyframes` by hand is how the fifth gets
forgotten. The 1ms convention exists because `transitionend` does not fire for a
zero-duration transition; the one listener in this app is the swipe row's settle,
which is unreachable under this setting because nothing is ever given the class
that would transition.

**The toast sat underneath the tab bar**, which cost nothing while a toast was
only an acknowledgement and costs the undo the moment one carries a control.

**The triage state was printed twice** on any card whose select was visible —
about 60px the meta row does not have at 390px, and the delete control is what
got pushed out of the card for it.

And one the swipe row introduced rather than uncovered, worth recording because
the assertion that should have caught it did not. `.swipe-surface` was given
`position: relative; z-index: 1` so it would sit above its track. A positioned
element with a z-index creates a **stacking context**, and every blip card
renders its own delete confirmation _inside itself_ — so the dialog's
`z-index: 50` was scoped to one row, and every card below the open dialog painted
straight through the scrim. The z-index was unnecessary: the track is absolutely
positioned and comes first in source order, so a positioned surface already
paints on top of it.

The suite had a check that the dialog covers the viewport, and it passed: the
scrim's geometry was exactly right. **A screenshot is what showed it** — the top
of the page blurred behind the scrim and two sharp cards sitting on top. The
check now asks `elementFromPoint` at four heights, because "does it cover the
screen" is a question about paint order and geometry cannot answer it.

### There are two viewports, and only one of them tells the truth

The **layout** viewport is what `position: fixed`, `100vh` and `100dvh` are all
measured against. The **visual** viewport is the part of it on screen. On iOS
Safari the keyboard shrinks only the visual one, so a sheet anchored to the
bottom of `inset-0` anchors itself under the keyboard. That is what put the whole
compose sheet off-screen on a real phone, with a clipped header the only thing
left visible. `dvh` does not save it: dvh tracks browser chrome, not keyboard
insets, and there is nothing in CSS that tracks them.

`window.visualViewport` is the only thing that reports it, and it is a JS API. So
`lib/viewport.ts` republishes it as `--vv-height` and `--vv-top` on `<html>`,
measured once at the router root, and `.modal-scrim` is positioned and sized
against those. Every dialog in the product then lays out inside the region the
person can actually see, with no further arithmetic.

That alone stops a sheet hiding, but a sheet is still the wrong primitive with a
keyboard up: there is no height at which it is both big enough to write in and
small enough to clear the keyboard. So on a phone the quick drop is a full screen
(`Modal fill`) and its submit control sits in the **header** (`Modal action`) —
iOS floats its form accessory bar over the bottom of the visual viewport, so the
bottom of a dialog is not somewhere a button can be relied on to be tappable
while somebody is typing.

Everything in this section is now guarded by `packages/phone`, which drives the
built app at 390x844 in headless Chrome and asserts the composer's submit and
field are inside the visual viewport with the keyboard raised. It is a real
assertion — the shim reports the heights iOS would report, which is the signal a
correct layout has to consult — but the occlusion is drawn, not felt. What it
leaves unverifiable is listed in [`PHONE.md`](PHONE.md), and it is the reason the
Mobile UI blip stays open pending a check on the actual phone.

Two smaller rules from the same round, both from photographs of a real iPhone:

- A **fixed set of chips wraps; an unbounded rail scrolls and says so.** The six
  triage chips wrap, because a set that small should be visible whole — the sixth
  was being sliced through the middle of the word at the screen edge. The board's
  lane strip cannot wrap, so it keeps a mask that fades the last chip out; iOS
  paints no scrollbar, and the fade is the only affordance there is.

  **Revised 2026-08-27:** the tag chips no longer have a rail of their own. They
  were a second 40px band under the filter row which on most radars carried a
  single chip, and they now wrap in `.filter-rail` after a hairline, capped at
  eight with a `+N more` disclosure. The cap has one rule attached to it: the
  active tag is always in the visible set whatever the cap says, because a filter
  that is on and cannot be seen is a filter people conclude is broken.

- `env(safe-area-inset-bottom)` **is 0 while Safari's own bottom toolbar is
  showing** — that toolbar is chrome, not an inset. A bare `env()` therefore gave
  the tab bar no separation at all and the two chromes read as one stack. The
  floor is `max(0.5rem, env(...))`, which still yields to the real home-indicator
  inset when Safari's bar is hidden.

None of this is verifiable by resizing a window. It is checked by driving a
headless browser at 390×844, `deviceScaleFactor: 3`, `isMobile`, `hasTouch` and
an iOS user agent, with the visual viewport shadowed to the height iOS leaves
above the keyboard. That gives a true _layout_; it does not give a true _device_,
and the keyboard, the safe-area insets and momentum scrolling still want a real
phone before anything here is called finished.

### The UX audit of 2026-08-27, and the three things it changed here

Eleven blips of measurements, not impressions. Three of them changed something
this section had said, so they are recorded rather than folded in silently.

**`.instrument` is for chrome, and it had stopped being.** The class is 10.5px
mono, uppercase, `0.14em` tracking, in the faintest ink — a correct spec for one
or two words and four stacked legibility penalties for a sentence. It was
carrying full sentences in twenty-eight `<p>` elements, including the paragraphs
explaining the permission model, which is the most confusing thing in the
product. And `--paper-faint` measured **3.60:1** in the dark theme and
**3.34:1** in the light one: below AA, everywhere it was used.

So `.note` carries prose — sentence case, 12.5px, `--paper-dim`, normal tracking
— and `.instrument` keeps labels, timestamps, counts, tag rows and lane names.
This is not a retreat from "ink on an instrument panel"; it restores it, by
giving the chrome voice back its meaning. `--paper-faint` was raised in both
themes until it clears 4.5:1 against every `--ink-*` token, worst case 4.58:1
dark and 4.60:1 light — `--ink-700` included, because that is the active sidebar
row and it does carry a count in this colour.

**Radar settings is a page, not a dialog** — `/radar/$radarId/settings`, four
sections: _Identity & behaviour · Appearance · People & links · Webhooks_. It was
1,370px of content at rest in a 768px viewport and 1,930px with the pickers open,
which is 3.22 screens on a phone. The share and webhook dialogs fold in with it:
the header carried three unlabelled 20px icons — one of them a broadcast glyph
that reads as "publish" and means the opposite direction — all `canManage`-only,
all configuring the same radar, opening at ~650px, ~495px and 512px with three
different footers. Somebody asking "who can see this?" opened the gear and found
no answer.

The template is a summary row with a **Change template** action after creation: a
six-card grid is over half the surface at rest for a choice made once. `Modal`
now decides width, subtitle and footer, so the drift that produced three widths
cannot recur; destructive controls leave the primary footer for a rule-separated
`.danger-row`; and `ConfirmDialog` replaced every native `window.prompt` /
`window.confirm`. The audit named three of those. There were nine.

`topicId` still goes through `api.radars.setTopic` separately from
`api.radars.update`, and only when it changed — §17's reason is unaffected by the
container, and the separation is more legible on a page than it was in a dialog.

**270px of chrome stood above the content on every radar**, measured at 258px on
the day: a bearing strip, an always-expanded three-line composer, a search box
and a tag band, before a single word of anybody's thinking. It is 162px now.

The composer is one line at rest and expands on **content, not focus**. Focus is
the obvious rule and it is the wrong one: the box takes focus on arrival on a
desktop, so a focus-driven composer is expanded exactly as often as the old one
and saves nothing. Capture is untouched by this — the caret still lands here,
⌘↵ still captures, the paperclip is still on the row, drop and paste are
unchanged, and the toolbar arrives with the first thing there is to capture.

## 17. Topics, and the permission model that goes with them

**Vocabulary (ADR-0030): people and agents say _array_.** The UI, `/arrays` and
`/array/:id`, the MCP tools (`list_arrays`, `read_array`, `set_radar_array`, … taking
`arrayId`) and the search filter `array:` all say array. The database, services, REST
DTOs and this section keep `topic`. The old MCP tool names are gone (no
aliases: a client reconnects); `topic:` stays a synonym of `array:`; `/topic*` redirects.

A topic is a container for radars — "I Am Well Foundation" holding a Kanban
board, a decision log and a discussion. It exists because the ask was for one,
and because it is the thing `@mentions` and the discussion-forum template both
needed underneath them — though not quite in the way that sentence assumed. A
topic member is a person you can address **only when the topic cascades**; on a
non-cascading topic they hold the grouping and no radar, so addressing them would
promise a notification about something they cannot open. §18 works that through.

The whole design turns on one sentence from the ask, which is a precise spec
rather than a vague wish:

> "I want to ensure that radar permissions don't need to follow topic
> permissions… maybe a topic is shared to a group, but one radar in the topic is
> only shared to certain members of the group. I think we can have a topic
> sharing option that forces cascaded permissions to all radars, but that's an
> option."

So: **sharing a topic shares no radar.** Cascading is opt-in per topic.

### Effective permission is the most-permissive union

A person's effective role on a radar is the strongest of three separate grants:
ownership, their own `radar_members` row, and whatever a _cascading_ topic
contributes. `viewer` on the topic and `editor` on one radar gives `editor`
there — the narrower grant was the deliberate one, and a container silently
demoting it is not something anybody would predict.

The converse matters more: **revoking the topic grant leaves the radar grant
standing.** The three grants are stored separately and none is ever written in
terms of another, so revoking at one level removes exactly that level. A
revocation whose blast radius depends on what else happens to be true is a
revocation nobody can reason about at the moment they most need to.

`RadarAccessDto` therefore carries `role` (effective), `directRole`, `topicRole`
and `via`, so the interface can say _why_ somebody can edit something and what
would survive if a cascade were switched off. The UI never works a permission
out for itself — same rule as `canDelete` on a comment.

### The cascade is computed, never materialised

`topics.cascade` is a boolean read in `services/access.ts` at authorization
time. Turning it on writes no `radar_members` rows; turning it off deletes none.

That is the single most important decision here, and it is what answers the two
questions the toggle would otherwise pose badly:

- **On, against radars that already have their own member lists:** it unions.
  Nothing is overwritten, nothing is merged irreversibly, and radars added to the
  topic later are covered automatically with no stale state to reconcile.
- **Off:** the cascaded access disappears completely and immediately, and every
  direct grant survives untouched.

Materialising the cascade was the obvious alternative and it is worse in both
directions at once. Going on, it has to choose between clobbering a radar's
member list and merging into it irreversibly. Coming off, it cannot tell the rows
it created from rows a person added in between, so it either strips access
somebody meant to keep or leaves behind access somebody meant to revoke. A
setting that silently strips access on toggle is a footgun; one that silently
leaves it behind is a leak. Computing it avoids **both**, and it is the same
argument as `blips.search` being GENERATED rather than trigger-maintained: a
derived value that is computed cannot drift from what it is derived from.

The reversibility is asserted directly in `topics.test.ts` by counting
`radar_members` on both sides of the switch.

### A cascade can never confer `manage`

`CASCADE_GRANTS` maps a topic role to `viewer` or `editor` and has no `owner` in
its range. A cascade may hand somebody the right to read or to capture; it can
never hand them the right to delete a radar, publish it, or share it onward. The
blast radius of the switch stops at content and never reaches access itself.

For the same reason `TOPIC_ROLES` is only `viewer` and `editor`: a topic 'owner'
grant would let a second person flip the cascade, and widening this later is easy
where narrowing it would mean taking access away from somebody who already had it.

### A topic grant conveys the grouping, not its contents

A topic member sees the topic's name and the radars in it **they can already
reach** — never a radar they hold no grant on. `TopicDto.radarCount` is what the
caller can read, not what the topic holds, so a member given the grouping and no
radars sees 0 where the owner sees 5. Reporting the true number would tell them
five things exist that they cannot open, and a radar's name is content. Same
reasoning as the 404-not-403 rule.

### Two kinds of radar are never in a topic

Both refused in the service _and_ by a CHECK constraint, because an agent over
MCP will try both and a silent no-op is worse than a refusal that says why.

- **The drop box.** A per-user singleton with its own provisioning path, and the
  holding bay for things with no home yet. Grouping it would make a private inbox
  shareable through a side door: one cascade toggle two screens away would hand
  every topic member somebody's unsorted pile of appointments and reminders.
- **A smart radar.** A saved query, not a container. It owns no blips, and what
  it resolves to is governed by the _reader's_ access to each matching blip's
  home radar (§4). Putting one in a topic would imply a membership it does not
  have, and leaves no good answer to what a topic grant means over a result set
  spanning radars the grantee may not be able to read. A topic must not change
  what a smart radar resolves — so it does not belong in one.

Both keep their existing places in the sidebar and on `/radars` rather than
falling out of a list that has become topic-organised.

### Ownership, orphans, and who may file what

`radars.topic_id` is **ON DELETE SET NULL**. Deleting a topic never deletes a
radar and never touches its member list: the radars simply become topicless,
which is the state every radar in this database is already in. Radars living
outside any topic is the normal case, not a degenerate one.

**Granting needs both sides; revoking needs either.** Filing a radar into a topic
requires `manage` on the radar _and_ `manage` on the topic. If a topic editor
could drop their own radar into somebody else's cascading topic, that radar's
access would from then on be controlled by whoever owns the topic — the radar's
owner would have handed away control of their own sharing as a side effect of
filing something. Taking a radar out needs `manage` on only one of the two,
because either party should be able to withdraw without the other's cooperation.

That rule also keeps a useful invariant true — every radar in a topic is owned by
that topic's owner — which is why `getRadarAccess` has no topic-owner branch.

### Interaction with what already existed

- **Public links are untouched.** Arriving by `public_slug` still yields
  `role: null`, and a topic grant cannot change that. Topics have no public
  surface: a public topic page would need its own answer to what a stranger sees,
  and that is a new disclosure surface to be argued on its own.
- **Webhooks** need `manage`, which a cascade cannot confer, so a cascaded editor
  cannot mint an ingest URL on somebody else's radar. And a webhook whose
  creator's access came only through a cascade stops working the moment the
  cascade is switched off, because every delivery is re-authorized through
  `requireRadar` — no new code, just the existing rule.
- **`readableRadarIds` grew the topic leg**, which is what keeps search, the tag
  vocabulary, dashboards and smart-radar resolution in step with the sidebar. A
  radar that appeared in search but not in the list would be the same class of
  bug as an MCP tool disagreeing with a REST route, happening inside one service.

### Notifications: two new kinds, and one deliberate silence

`topic_share` is its own kind rather than `share` at a different scope, for two
reasons that are really one: it has no radar to point at, and the sentence is
genuinely different. "Ada shared the topic I Am Well Foundation with you" and
"Ada shared Kanban with you" mean different things — the first may hand over
nothing at all — and collapsing them would make the stream lie about what access
somebody just got. It is **one notification, not one per radar**, even when the
topic cascades: one act by one person is one line.

`topic_cascade` fires when cascading is switched **on** for a topic somebody is
already in. That is the one moment access widens without anybody being shared
anything, so it is the one that most needs saying out loud; silence there is
exactly the leak this design otherwise avoids, and the audit log is not something
a person reads.

There is deliberately **no notification for switching it off**. Removing a radar
member does not send one either, and "your access was taken away" is a message
this application sends nowhere else. What happens instead is the disclosure rule
from §8: notifications for radars a person reached _only_ through the cascade are
deleted, because a notification carries a snapshot excerpt and leaving one behind
would hand somebody a readable copy of something they can no longer open. Same
sweep on removing a topic member and on a radar leaving a cascading topic.

### The MCP boundary: an agent may organise, but may never widen access

The same line §8 draws for notifications, applied to what topics control.

Organising is safely an agent's job: `create_array`, `update_array`,
`set_radar_array`, plus `list_arrays`, `read_array` and `list_array_members`.
None of that hands anybody anything.

Two things are fenced — **in the service layer**, which is not where they
started; see §22 for what "there is no tool for it" turned out to be worth:

- **The cascade switch is refused for an agent in either direction.** On, it
  converts every existing topic membership into access to every radar in the
  topic including radars added later, in one call. Off, it silently strips access
  from collaborators — "an agent revoked my access" is as bad as "an agent
  granted it". That is a person's decision on a real screen, like the consent
  screen and the notification settings.
- **`share_array` works only on a topic that does not cascade.** There a grant
  conveys the grouping and nothing else, making it strictly _weaker_ than
  `share_radar`, which agents already have — refusing it would be theatre. On a
  cascading topic it is strictly stronger than anything an agent can do and
  open-ended in time, since it covers radars that do not exist yet. The refusal
  lands exactly where the act changes class, and it names `share_radar` as the
  way to do what was actually asked.

`set_radar_array` is refused on the same principle when the target cascades and
has other members: filing a radar there is an access change, not filing. A
cascading topic with **no** other members grants nobody anything, so filing into
that one stays organising and stays an agent's job — the line is drawn where the
act changes class, not where the flag is set.

### The interface says what the switch does, before the click

The cascade control is not a checkbox with a label. `/topic/:id` states the
consequence in live numbers — how many people, how many radars — and says on the
way out that direct shares survive, because the thing that stops anybody using a
switch like this is not knowing whether turning it off will take away something
they gave somebody on purpose.

The radar's own member list now includes people who reach it **only** through a
cascading topic, marked `via: 'topic'` and named with the topic. They hold no
membership row and would otherwise be invisible in the one place that answers
"who can see this": access nobody can enumerate is access nobody audits. Their
row links to the topic rather than offering a remove button with nothing to
remove.

In the sidebar and on `/radars`, a topic heading carries the **sum** of the
unread counts beneath it. That roll-up is not decoration — without it, grouping a
radar could hide the one badge asking you to look, and a grouping that hides a
signal is worse than no grouping.

### A capability with no control is not a capability

Topics shipped with a model, a permission cascade, REST routes, MCP tools and
sidebar grouping — and no way to make one anywhere in the interface.
`POST /api/topics` existed from the first commit and `api.topics.create` was
never called from `packages/ui`. The only accounts that had topics were ones an
agent had made them for. `TopicPicker` even returns `null` when there are no
topics, so a person creating their first radar was never told topics existed at
all, which closed the loop: nothing offered to make one, and nothing mentioned
that one could be made.

Lucas's report was "I don't see anything indicating how to create new topics",
and he was right in the strongest sense — the feature was not hidden, it was
absent. This is the failure Wave made with its unread affordance: the capability
was built, the control was not, and users correctly concluded the feature did not
exist.

Two ways in were added, and both named the thing in words: a `+` beside the
sidebar's RADARS heading opening a menu offering a radar or a topic, and both as
labelled buttons in the header of `/radars`.

**That was not enough, and the next section is why.**

`cascade` is deliberately not on the create form, matching the contract's own
reason for leaving it off `createTopicSchema`: converting a grouping into access
to every radar inside it, including radars added later, is the widest single
access change in the application, and it belongs on the topic's own screen where
the numbers are there to say what it will grant and to whom. A new topic groups
and nothing more, until somebody says otherwise on a screen that says what that
means.

### A control that appears once you have used the feature is not discoverable

The same report came back a second time, after creation had been fixed: _"I'm
still not seeing anywhere in the UI how to manage topics or groups of radars."_
Treat that as evidence the fix was insufficient, not that nobody looked. It was.
Three things were true at once, and each on its own was enough.

**Nothing signalled that topics existed.** The rail's only heading said RADARS,
and the only control beside it was a `+` a reasonable person reads as "new
radar", which reveals a second option after you click it. A topic then appeared
only as a heading over a slice of the radar list — which reads as a property of
those radars, not as a thing in its own right. With no topics yet, the concept
was named nowhere in the navigation at all.

**There was no list.** `/radars` indexes radars; nothing indexed topics. An
_empty_ topic appeared in a small section on `/radars` that vanished the moment
you put something in it, so the only surface showing every topic at once was the
one showing the topics you were not using.

**There was no rename.** `PATCH /api/topics/:id` and `api.topics.update` both
existed with **zero callers in `packages/ui`** — the identical shape
`api.topics.create` had been in. A topic named wrong when it was made stayed
wrong short of deleting and rebuilding it: a destructive act to fix a typo. The
pattern is worth naming, because it has now happened twice in the same feature:
**a client method with no caller is a control that does not exist.** It is
greppable, and it should be grepped for.

So `/topics` exists. It lists them, says what each holds, explains what a topic
is _whether or not you have one_, and carries rename. The sidebar gains a Topics
section present at zero, linking there. `/radars` — the only surface a phone has
— gains a Topics row present at zero too. And `TopicPicker` no longer returns
`null` with no topics; it says what a topic is and links out, because a control
that goes missing exactly when you have not yet used a feature teaches that the
feature is not there.

**The `+` goes back to one per section, and that IS the rule** the two-plus bug
produced rather than a departure from it. That rule is: `+` means "add a row to
the list under this heading", and the verb — quick drop — keeps its pen. Two
pluses each adding a row to the list directly beneath them are one control doing
one thing twice. The single `+` whose menu offered a second kind of object under
a heading naming only the first was the compromise, and it is what hid topics.

Furled, an empty Topics section leaves the rail entirely — heading rule and `+`
together — because there it would be a bare `+` fifty pixels above another bare
`+` with nothing between them, which is the exact shape the rule exists to
prevent. Once there are topics, their glyphs sit between the two and the pairing
reads. Nothing is lost: **the rail is a compacted view of what you have, not a
place a concept can be introduced**, since 60px of glyphs names nothing.

Filing also worked in one direction only. `TopicPicker` is the right control for
"where does this radar live" and the wrong one for "gather these three
together" — that starts from the group, and doing it through three separate radar
settings screens is three times the work in the least obvious place. The topic
screen adds and removes radars itself now, with the same rule as everywhere else
here: adding to a _cascading_ topic states the consequence in live numbers before
the click, removing from one confirms and says the direct grants survive, and the
cascade switch itself is untouched — its own endpoint, audit action, confirmation
and screen. Making topics discoverable must not make that switch easier to hit.

A radar also names its topic in its own header now. It was said nowhere: the only
surface that knew was the radar's settings, opened to change something rather
than to find out, and on a phone there is no sidebar to infer it from.

### `radars.topic` became `radars.tagline` — and the copy did not follow

The one-line subtitle under a radar's name was called `topic` long before a topic
was a thing you could create. Leaving both would put one word on two meanings
inside the most access-sensitive object in the application. A `topic` key on
radar create/update is **refused by name**, with a message pointing at `tagline`
and `topicId`, rather than silently stripped — zod drops unknown keys in silence
by default, and a stale MCP connector schema is a real and observed condition.

**The schema was fixed and the user-facing copy was not**, which meant the rename
bought nothing where it mattered most. Two adjacent items in the create menu read:

> **New radar** — a container for one **topic's** thinking
> **New topic** — a group of related radars

That is the collision, restated verbatim, in the one place a person meets both
words for the first time. `create_radar`'s MCP description had it too — "a radar
to hold blips on a topic" — read by an agent directly beside `create_array`.

The container keeps the name **topic**, matching the schema, the REST routes and
the MCP tools; renaming it would be a far wider change than the one the collision
needs. Subject-matter is now **"one thing"**: a radar is "a container for blips
about one thing", and a topic "groups related radars". Swept from the radar
dialog, the `/radars` empty state, the README and the `create_radar` tool
description.

### The topic page, after the 2026-08-27 audit

The information on this screen was right; the presentation was doing four things
at once. It had **three container idioms stacked** — Radars a bordered row-list,
Sharing a filled panel, People a filled panel with different internal padding —
and the gap from a section's label to its container differed per section, so a
screen that is one screen read as three components pasted together.

`Section` is a primitive in `primitives.tsx` now, shared with `/settings` (which
already got this right) and with the radar settings page. `bare` covers a child
that draws its own frame, so `.radar-list` is not two frames around one list; the
label and the spacing stay identical either way, which is the part that makes a
rhythm. The desktop sweep asserts every gap on this page is the same number.

**The riskiest control had the most visual weight.** "Share every radar in it"
was a full-width, full-saturation accent gradient — a primary call to action — on
the one switch that grants access to every radar in the topic _and every radar
added to it afterwards_, while "Add a radar", which grants nothing, was a quiet
ghost link beside it. Weight was inverted against risk. The cascade switch is a
normal-width secondary now; the paragraph above it already carries the
persuasion, and §17's whole argument is that the sentence is what makes the
switch honest, not the button.

Two smaller ones from the same round. A chevron that navigates and a
folder-minus that changes who reaches a radar sat 38px apart in every row, same
size, same weight, unlabelled — separated by a rule and the destructive one now
says what it does. And the blip count moved out of that control cluster into the
row's own metadata, where a number reads as a fact rather than as a value you can
change; it is suppressed at zero, which is the rule the unread badge already
followed and which stops a column of zeros making empty radars look broken.

## 18. The discussion template, and @mentions

Two asks, built together because the second lives inside the first. The brief for
the template said to take a cue from Google Wave; the brief for mentions said the
candidates are people shared on the radar **or on its topic**. Both of those turn
out to be more pointed than they first read.

### A blip is a thread; its comments are the replies

That is the decision everything else rests on, and it is what makes the template
cost so little. A blip already has a conversation, a viewer on a shared radar can
already join it, and `requireParticipation` already decides who may (§7). Nothing
about storage was missing. What was missing was that the conversation was folded
away behind a hairline row, flat, ordered by capture, and called a comment.

So the registry grew a **`conversation` axis** — `expanded`, `threaded`,
`replyNoun` — and the shared `Conversation` component reads it. No component asks
which template it is on. The alternative, a second kind of object for "forum
post", would have meant a second capture path, a second permission story and a
second thing for `read_radar` to explain, in exchange for nothing.

### What was taken from Wave, and what was refused

Wave's conversation model (Gregorio & North, Oct 2009) was structurally sound: a
separate manifest describing nesting, with sibling blips in a thread as
_continuations_ and a new thread under a blip as a _reply_. What killed it as an
interface is specific and worth naming precisely rather than as "it was
confusing": **arbitrary-depth, arbitrary-position insertion destroyed the
correspondence between position and recency.** Jon Stokes, on why his team gave
up on it, described the newest messages being "nested somewhere deep in the
middle (or, the 'trough') of a long wave."

**Taken — a conversation and a document are the same object.** A blip here is a
full markdown body with attachments and also the head of a thread. You do not
start a discussion _about_ a thought; the thought is the discussion.

**Taken — the continuation/reply distinction.** Top-level replies run flat as
continuations of the thread; answering a particular reply indents once. That is
Wave's own distinction, bounded where Wave left it unbounded.

**Refused — unbounded depth.** Slack arrived at the same refusal independently:
their write-up compares against Facebook, Twitter, Reddit, YouTube and email and
never mentions Wave, and they built the arbitrary-depth version first across six
internal versions before concluding that restricting each thread to one level of
replies "was an instant success on all fronts". Google Docs comments ended up in
the same place again. That these are _convergent_ rather than derivative is what
makes them worth citing — three teams built the unbounded version and separately
found the same failure.

**Refused — inline insertion into a body.** The one Wave idea that has never
survived into a conversational product, only into document ones, and there only
by moving the comment into a gutter so the document stays readable.

**Refused — live character-by-character typing**, on a product argument rather
than an evidential one. The press consensus was that it felt surveillant, but
Google's own published user research lists only invitations, integration and
speed as dislikes, and live typing is not among them. What settles it here is
that transmitting a half-typed thought makes composing it a performance, and this
application's thesis is that capture is cheap precisely because nobody is
watching.

**Refused — playback**, and this is the sharpest lesson of the three. Wave
shipped the history-replay view rather than the what-changed view, and those are
far less alike than they look: playback is a linear scrub over an operation log,
while "what happened since I last looked" is a set difference against read state.
Wave _had_ the read state as a first-class object and did ship unread navigation
— as a spacebar shortcut, published as a numbered tip in a blog post. Users still
overwhelmingly reported being unable to tell what was new. **An affordance nobody
can see is not an affordance**, and that is a rendering failure rather than an
architectural one, which is exactly the kind that gets missed because the data
model looks complete.

**Refused — new vocabulary.** Wave asked people to learn waves, wavelets, blips
and pings. This template introduces two words everybody already owns: thread and
reply. (That On My Radar calls its unit a "blip" is convergence — it predates
this and means a captured thought.)

### Three answers to the trough

Refusing depth is only half of it. The other half is that this application
already shipped what Wave lacked — notifications with unread badges and an
Activity screen (§8).

- **`order: 'discussion'`** floats the thread answered most recently to the top,
  so the newest words in the whole radar are always in the first panel.
- **Each panel states its own recency**, so a scan down the page answers "what
  has moved" without opening anything.
- **A long thread gets a visible jump** to its newest reply — a control on
  screen, next to the thread, not a hotkey.

### One level, enforced by re-parenting rather than refusal

`blip_comments.parent_id` is null or points at a comment whose own `parent_id` is
null. Replying to a reply re-parents you to the same sub-thread and the response
says where it actually landed. Refusing would make the reply control on a nested
reply do nothing, which is worse than the thing being prevented — and the
addressing that a third indent level would have carried is carried by the
mention instead, which is why the two features are one design.

The invariant needs a lookup on the same table, so it cannot be a CHECK and lives
in the service. `ON DELETE SET NULL` keeps it true for free: a deleted parent
promotes its replies to the top level. That is also the right rule on its own
terms — moderation already stops short of the edit (§7), and deleting a remark
while silently taking three other people's answers with it is the same failure at
a larger blast radius.

### The thread keyset, and a bug it uncovered

A thread reads as each top-level remark in time order with its replies beneath,
which is a sort on `(root_created_at, root_id, created_at, id)` ascending — the
parent's position, then the comment's own. Every key runs the same direction, so
the row-value comparison is valid; `id` cannot tie; and a parent always sorts
before its replies because a reply cannot predate what it answers. For a flat
thread `root` is the comment itself and it collapses to `(created_at, id)`, byte
for byte what it was.

Extending it surfaced a defect that had shipped with comments and had nothing to
do with threading. **`timestamptz` holds microseconds and a JS `Date` holds
milliseconds.** A cursor built from `Date.toISOString()` names an instant
fractionally before the row it came from, so on the ascending comment cursor the
boundary row satisfied `>` again and every page re-served its own last row for
ever — paging five comments two at a time gave c0,c1,c1,c2,c2,c3,c3,c4,c4,c4…,
confirmed against the shipped code before anything was changed. The descending
blip cursors have the mirror image and **skip** rather than repeat, which is
quieter and worse: two blips captured in the same millisecond, and one silently
leaves the stream.

Both are fixed by carrying the value as Postgres `::text` rather than through a
Date. The ORDER BY is untouched, so `blips_radar_created_idx` still serves the
hot path index-only.

### Activity ordering is computed, and says what it cannot promise

`lastActivityAt` is a correlated subquery, not a `blips.last_activity_at` column.
A stored one would need maintaining on comment insert, comment delete and blip
move, and the first path that forgot would sort a radar wrongly with nothing to
say why. Same argument as `blips.search` being GENERATED and the cascade being
computed at authorization time: a derived value cannot drift from its source.

The honest caveat, recorded in the registry rather than left to be discovered:
that key is **mutable**, unlike every other sort key here. The keyset stays
total, so a row that sits still can neither duplicate nor be skipped — but a
thread somebody answers mid-scroll genuinely moves. Every forum pays that; the
point is not to let the totality guarantee be read as promising more.

### Mentions resolve against who can read the radar

`radarReaders` is the single authority for "who can reach this radar": owner,
direct members, and a topic's members **only when it cascades**. Mention
resolution draws from exactly that set.

That is what makes the central rule true **by construction rather than by a
check**: mentioning cannot widen access, because the parser can only name people
`requireRadar` would already admit. A handle naming anybody else does not
resolve, and an unresolved handle is plain text. There is no branch to get wrong.

It also settles the ask precisely. "Shared on the radar **or on its topic**" reads
as though topic membership were the candidate list, and it is not: a member of a
non-cascading topic holds the grouping and no radar at all (§17). Offering them
would be offering to notify somebody about a conversation they cannot open. The
honest reading is "or on its topic, when that topic actually grants the radar".

Deliberately **no** "X is in this topic but cannot read this radar" hint. The
person composing may not be able to read the topic, and that would be a new
disclosure surface. An unresolved handle instead says nobody on this radar is
called that, and points at sharing — because pulling somebody in _is_ a share,
and it should be offered as one rather than done quietly.

### Stored at write time, body kept verbatim

`@ada` stays `@ada` in the body — it is the person's words and it round-trips
through `update_blip`. What is stored beside it is the resolution. Three cases
decide this and render-time parsing loses all three: a renamed account (a stored
id renders the current name), a deleted account (the row cascades away rather
than printing a name resolving to nobody), and a body edited to add or remove a
name (the rows are the record of who has already been told, so an edit notifies
only the newly addressed).

Ambiguity resolves to nothing. Two people on one radar can answer to `@ada`, and
guessing would send somebody's words to the wrong person.

### `mentions.radar_id` follows the content, and the sweep that reads it runs

`0008` denormalises `radar_id` onto `mentions` for the same reason
`blip_comments` and `blip_reactions` carry it — it is what scopes and authorizes
the row — and its own header names the failure: _"re-deriving it through two
joins on every read is how a mention ends up stranded on a radar its blip has
left."_ Which is what happened. `updateBlip` carried the attachments, the
comments and the reactions on a radar move and left `mentions` behind.

Two consequences, and the second is the one that shows. The revocation sweep
filters on that column, so it missed exactly the rows that had moved. And the
column is `ON DELETE CASCADE` on `radars`, so deleting the **old** radar stripped
the mentions off blips now living somewhere else entirely — an `@ada` that stops
resolving because of something that happened to a radar its blip is not in. The
move now carries mentions on the body and on every comment underneath it, since
the comments are moving in the same breath.

Worse than a missed row: **`dropRadarMentions` had no caller at all.** Not "swept
the wrong set" — never ran, on any path, while its own docstring called itself
the counterpart to `dropRadarNotifications`, which has four. So a test that
called it directly would have passed for the whole period it was dead, which is
how it hid. It now runs wherever notifications are swept, through one
`sweepLostRadar` so the pair cannot drift again: `removeMember`, the cascade-off
and grant-revoked sweeps, and the radar-leaves-a-topic sweep.

The rule it enforces is the one this section already states from the other end.
A mention resolves only against `radarReaders`, so a handle naming somebody just
removed would not resolve if it were typed today; leaving the row makes it keep
resolving, which is the member list and the blip disagreeing about who is here.

### `setRadarTopic` sweeps on a move, not only on a withdrawal

Found by the same reading. Withdrawing a radar from a cascading topic swept;
moving it from one topic to another did not sweep at all — so the first topic's
members kept notifications, which carry snapshot excerpts, for a radar they can
no longer open. The two directions are the same event seen from different ends.

It sweeps **before** the write, because `radarsReachableOnlyViaTopic` asks which
radars are _in_ the topic and after the write there is nothing left to find — the
same ordering trap as reading attachment keys after a delete (§10). Somebody who
cascades on the destination as well keeps everything: the move cost them nothing,
and sweeping them would read as data loss rather than as revocation.

### A mention does not coalesce

Its group key names one comment, so it can never fold. Coalescing is right when
events are interchangeable — ten reactions on one blip is one fact — and a
mention is not a fact about a blip, it is an _address_. "Mentioned you 2 times"
throws away which two and turns a notification into a prompt to go hunting. The
burst that coalescing normally protects against is handled a level up:
`reconcileMentions` returns only the newly addressed, and `mentionsPerBody` bounds
one body's fan-out.

A mention **suppresses the `comment` notification** for the same person on the
same comment. One act by one person is one line, and being named is the stronger
sentence.

A mention **respects a radar muted to `none`**. This is the highest-signal event
the application has, so there is a real case the other way — but the level's own
hint promises silence, and a mute a colleague can defeat by typing your name is
not a mute. The one thing that still gets through `none` is an access change,
which is not activity.

### Mentions are universal; threading is not

Mentions work in any body on any template, like `#hashtags` and
`supersedes_id`: "this names that person" is a fact about a body, not about a
template, and gating the storage would lose it the moment a radar switched
templates. Threading is registry-gated, because a folded thread has nowhere to
put a reply control.

### The MCP boundary

An agent **may** write a mention. It is text in a comment it can already post,
and the two alternatives are both worse: stripping handles out of a body is a lie
about what was written, and resolving them for humans but not for agents produces
a body whose rendering disagrees with its notifications. The boundary that
matters is already absolute — an agent cannot address anybody who cannot read the
radar, for the same structural reason a person cannot.

There is no separate mention tool, and `create_comment` says out loud that the
notification arrives in **the user's name**, so an agent should address somebody
only when asked to. That is the same line §8 and §17 draw: an agent may organise,
and may never widen access or decide who gets interrupted.

### Two bugs this uncovered, both pre-existing

- **Cascaded members received no notifications at all.** `audience()` joined only
  the owner and direct members — written before topics existed and never widened
  when they landed. Somebody reaching a radar through a cascading topic could
  read it, comment on it and be named in it, and heard nothing. It now derives
  from `radarReaders`.
- **The cursor truncation above**, which affected every keyset in the
  application.

## 19. Share-by-email invitations, and the waitlist bypass

Sharing a radar with an address that has no account has always written a
`radar_invites` row and left it for `claimInvites` to turn into a membership on
that person's first sign-in. What was missing was everything either side of it:
the person was never told in a way they could act on, and there was no answer to
what happens when the invitation is to an application nobody can sign up to
without being approved.

Two things were added, and the whole design is keeping them apart.

### The token carries navigation, never authority

The invitation email now carries a signed link. The token is
`base64url(JSON) . HMAC`, keyed by `SESSION_SECRET`, and its body names **only
the invitation row id**, its kind (`radar` or `topic`) and an expiry.

Not the address, and not the radar. A second copy of the address inside the
token is a second chance for it to disagree with the row that actually decides
who gets the grant, and a radar id baked into a token outlives the reason it was
put there. One id, resolved live against the database, every time.

**Nothing about the token admits anybody.** It fills in a form and names a
radar; `GET /api/invites/:token` returns what the email already said, and the
only way past the login screen is still a six-digit code delivered to the
address the invitation names. That single decision settles the failure paths
rather than requiring one guard each:

- **Replayed** — resolves the same page as many times as it is asked for, and
  grants nothing, because it never granted anything.
- **Used by a different address** — admits nobody. Whoever clicks it lands on the
  login form; if they sign in as themselves they get their own ordinary account,
  and the invitation stays where it was addressed.
- **After the share was revoked** — `revokeInvite` deletes the row, so the token
  stops resolving and the bypass has nothing left to read. Revoking a share
  revokes its invitation by construction, not by anybody remembering to.
- **After the radar was deleted** — `ON DELETE CASCADE` takes the invitation with
  it, and the link dies the same way.
- **After it was accepted** — the row is marked and stops resolving; that person
  already has the radar.
- **Expired** — 14 days (`INVITE.ttlDays`).
- **Forged or tampered with** — fails the HMAC and is answered exactly like a
  token that was never issued.

Because the HMAC is keyed by `SESSION_SECRET`, rotating it invalidates every
outstanding invitation link along with every session and access token. The
invitations themselves survive; only their links die, and an ordinary sign-in
still claims them.

**One failure response, not six.** The route answers a bad signature, an expired
token, a revoked invitation, a deleted radar and an already-accepted invitation
with the same 404 and the same sentence. Telling them apart would describe the
inside of somebody else's account to whoever is holding the link, and the
landing page has the same useful thing to say in every one of those cases: this
is no longer open, sign in normally.

### `INVITE.ttlDays` bounds the link and the bypass, and deliberately not the grant

Somebody who takes a month to get round to signing up still finds the radar
waiting for them. What they lose after fourteen days is the shortcut past the
queue — a privilege over the product — not the share of one radar. Expiring the
grant as well would retroactively change what sharing means for a feature that
shipped long before this one, and nobody asked for that.

### The bypass is derived live, at the only moment an initial state is decided

An invitation **from an admin** skips the waitlist. An invitation from an
ordinary user does not: that person signs up and joins the queue like anybody
else, and the radar is waiting when they are approved. That distinction is the
entire security boundary of this feature, because it decides who gets into a
waitlisted application.

`invitationBypassFor(email)` is a query, not a claim carried in a token. It
requires an unclaimed invitation to that address, younger than `INVITE.ttlDays`,
whose `invited_by` resolves to a user who is **still** an admin and **still**
active. `findOrCreateUser` consults it on the create branch only. Three
properties fall out of that, and each was a requirement rather than a bonus:

- **Not forgeable by the invitee.** Nothing the person signing up sends is
  consulted — not the token, not a parameter, not the address they type beyond
  its use as the lookup key.
- **Does not survive the inviter losing admin.** The bit is read at the moment
  the account is created. A demoted admin's outstanding invitations stop letting
  people in immediately, and so do a suspended one's.
- **Not transferable.** It is bound to the invitation row's own normalized
  `email`. A bystander who clicks the link and signs up as themselves gets an
  ordinary pending account.

### Approving somebody who is already on the waitlist happens at share time

An admin sharing with an address that already has a `pending` account is the
same decision as an admin approving that account, so it runs the same code:
`activateUser`, extracted from the admin console and now the only approval path
in the codebase. Giving them one implementation is what stops the second one
drifting into something the first would not have allowed.

It happens at share time rather than at that person's next sign-in **so that
§14 stays true**: `findOrCreateUser` decides an initial state and nothing more,
and it must never be the thing that quietly re-approves a returning account. And
`activateUser` touches `pending` only. A suspended account stays suspended:
suspension is a decision somebody took about a person, and an invitation must
never be a way to walk it back.

`ShareResult.approved` reports it, and the share dialog says
"and let them into On My Radar" rather than a plain "shared". An approval that
happens invisibly is one nobody audits at the moment it matters.

### Pending grants stay an invitation row, not a provisional user

The alternative — writing a real `users` row and granting against it — was
rejected. That row is an account nobody has proved they control. It would answer
`findUserByEmail`, so the next share would take the "they already have an
account" branch and never send an invitation; it would sit in the admin console's
waitlist as a person who has never heard of the application; and
`accessPolicyFor` would have already decided its state before anybody asked for
it. An invitation is a promise about an address, and the address is the right
thing to key it on.

### Normalisation, and the plus-tag that is deliberately kept

`normalizeEmail` — trim and lowercase — applied on the way in and in every
lookup, including the bypass query. Capitalisation therefore cannot miss an
invitation.

Plus-tags are **not** stripped. `lucas+radar@example.com` is a different address
to most providers and can belong to a different person; collapsing them would
hand one person's invitation to another, which is precisely the failure this
whole section exists to prevent. The cost is that somebody invited at one tag and
signing up at another gets an ordinary account, which is recoverable by sharing
again. The other error is not.

### Enumeration: the existing distinction is kept, and nothing finer is added

`shareRadar` still answers `invited` for an address with no account and `added`
for one with. That does reveal whether an address is registered, and it is kept
deliberately: the sharer genuinely needs to know whether that person has the
radar now or whether everyone is waiting for them to sign up, and "invite
pending" in the member list says the same thing already.

It is a much narrower surface than the sign-in oracle §13 refuses. That one is
unauthenticated and unlimited; this one requires an authenticated account with
`manage` on a radar it controls, is one address at a time, and is written to the
audit log under the actor who asked. What is **not** exposed is anything finer:
whether the account is `pending`, `active` or `suspended` never appears, and
approving a waitlisted account does not change the response shape.

### The MCP boundary: an agent may share, but may never invite

**An agent may not invite an address that has no account.** `assertMayInvite`
allows `actor.kind === 'user'` and refuses everything else, in the service layer
so both transports inherit it. `mayBypassWaitlist` excludes agents for the same
reason, so an agent holding an admin's token cannot approve a waitlisted account
either.

Sharing with somebody who already has an account is organising, which is what
§8 and §17 already settled an agent may do: it moves access between people who
are already here, the person on the other end is told, and they can undo it.
Inviting an address with nobody behind it is a different act. It is an email
going out in the user's name to somebody who has never heard of this
application, and when the person sharing is an admin it is an account-creation
path into a waitlisted product — strictly more consequential than the cascade
tool topics refused in both directions.

The consent screen an agent passes through names the client. It cannot name the
people that client will later decide to email, because they do not exist yet, so
consent to connect an agent is not and cannot be consent to this. The refusal is
loud, it names the reason, and the recovery is two clicks on a real screen —
which is the right shape for something that cannot be undone. An invitation
cannot be unsent.

Webhooks are refused by the same check and for one more reason: a webhook actor
is a stored credential acting as its creator, with nobody present at all.

### The link is handed back to the sharer, because the email may never arrive

`ShareResult.inviteUrl` carries the link on the `invited` branch. With no
`RESEND_API_KEY` — a self-hosted instance, or a cluster where that secret has not
been filled in — `sendMailQuietly` logs and returns, which left inviting somebody
with no working path at all rather than a slow one. Handing the link back makes
that recoverable by pasting it wherever the two people actually talk.

It is returned there and **not** from the member list. The link grants nothing on
its own, but a member list is readable by everybody on the radar, while this
response goes only to the caller who holds `manage` and has just this moment
created the invitation.

### The invitation is context for signing in, not a step before it

`/invite/$token` renders the login screen with the invitation stated above it and
the address filled in, rather than an accept-then-sign-in flow. Somebody who
clicked a link in an email has already decided; an extra button would be one more
click on the flow where the person has the least patience and the least idea what
this application is.

The card says three things and stops: who is handing over what, at which role,
and what happens to their account when they accept. The last line earns its
place because signup is waitlisted — discovering that _after_ typing a six-digit
code, having been sent a personal invitation, reads as the product being broken
rather than as a queue.

The address is pre-filled but not locked. An invitation is addressed to a
mailbox, and somebody who reads that mailbox under a different address must
still be able to sign in.

### No migration

Every column this needed already existed: `radar_invites` and `topic_invites`
carry `email`, `role`, `invited_by`, `accepted_at` and `created_at`, and the
partial unique index on `(radar_id, email) WHERE accepted_at IS NULL` is what
the upsert targets. That upsert is a change of its own: it was
`onConflictDoNothing`, so re-sharing a pending invitation at a higher role was
silently swallowed and somebody told they were an editor arrived as a viewer.

## 20. Universal search

One box, across every radar the person can read, with structured filters written
inline: `roadmap in:"On My Radar Dev" from:lucas after:7d`.

### The authorization argument is that there isn't one

`services/search.ts` makes no access decision. It starts from
`readableRadarIds(actor)` — the same function the sidebar, the tag page and every
smart radar resolve against, and the one place the topic cascade is read — and
every filter **narrows** that set. `in:` intersects, exactly as
`resolveRadarScope` intersects a smart radar's saved `radarIds`; `from:` can only
name somebody who is already a reader of a radar in it.

That is deliberately boring, and the boredom is the point. A search that returned
one blip title from a radar somebody cannot open is the worst bug this
application could have, and the way that bug gets written is by a search growing
its own idea of who may see what.

The one piece of new authorization code is a **generalisation** rather than an
addition. `radarReaders(radar)` — the mention candidate list and the notification
audience — now delegates to `readersOfRadars(radarIds)`, which is the same query
over a set instead of a single row. The `from:` candidate list is then literally

```
readersOfRadars(readableRadarIds(me))
```

— the people who share at least one radar with the caller. `search.test.ts`
asserts that equality against a real Postgres rather than taking this sentence's
word for it, because the whole reason a second "who may I name" query is not
allowed to exist is that it would drift.

### Naming something is not a way to ask about it

`in:` and `from:` name things, so they are also a way to _probe_ for them. The
answer is the same shape as `requireRadar`'s 404-not-403 rule: a radar you may
not read and a radar that has never existed produce **identical** answers —
"matched no radar you can read". A message that distinguished them would confirm
that an id is real, which is the disclosure the 404 rule exists to prevent,
arriving through a different door. The test asserts the two responses are
byte-identical once the id itself is normalised out.

The same holds for people: `from:` naming somebody real who shares no radar with
you reads exactly like `from:` naming nobody at all.

One case is deliberately _not_ obscured. Naming a smart radar says so — "a saved
search, not a container" — because you can read it, so its existence is not news.
The grammar does not expand a smart radar through `in:`. Explicit `radarId`
scope uses the shared service resolver instead, intersecting its saved filters
and source radars with the caller's readable corpus. Its source radars can still
be named with `in:` to narrow the scope further.

### An unmatched filter returns nothing, and says so

If `in:desgin` matches nothing, the query is **not** run with that filter quietly
lifted out. It returns an empty page with `unresolved: true` and the token echoed
back, and the screen shows it struck through in amber with a sentence naming it.

Dropping it would return the entire corpus and look like a healthy search. That
is how somebody comes to believe a search proved something it never tested — and
an empty result reading "nothing matches your words" when it means "your filter
is a typo" is the same failure wearing a better coat. The screen's empty state
says which half of the query is at fault, and the phone suite asserts the count
is zero where the words alone return two.

### The grammar, and what is deliberately not in it

Parsed in `packages/contract/src/search.ts`, so the API, the MCP tool and the box
lex the same string. Parsing is pure; resolving is not.

|                                             |                                                          |
| ------------------------------------------- | -------------------------------------------------------- |
| `in:"Design notes"`                         | one radar — name, slug or id                             |
| `from:lucas`                                | one person — name or email                               |
| `tag:bug`                                   | normalised exactly as capture normalises a `#hashtag`    |
| `is:active`, `is:pinned`                    | triage state, or the pin                                 |
| `has:link`, `has:attachment`, `has:comment` | with the spellings people reach for (`files`, `replies`) |
| `kind:essay`                                | the blip kind                                            |
| `template:helpdesk`                         | only radars on that template, across every topic         |
| `after:7d`, `before:2026-01-01`             | a date or a span back from now, **UTC**                  |

Five decisions worth stating:

- **An unknown prefix is a word, not an error.** `note:` is not a field, so
  `note: to self` searches for those words and `https://example.com` is a URL
  rather than a broken `https:` filter. A field that _is_ known and carries a
  value it cannot accept — `is:blue` — is reported instead, because there the
  person plainly meant a filter.
- **`status:` is not in the grammar.** A lane id only means something relative to
  one template: `todo` is the kanban's second column and nothing at all on a
  reading list. Across radars there is no template to read it against, so a
  global `status:todo` would mean different things in different rows. It stays on
  the single-radar API, where it is meaningful.
- **Dates are UTC.** A bound in the reader's local zone would need that zone
  carried on every transport, and an MCP client has none to send — so it would be
  one meaning in the browser and another for an agent, which is exactly the
  divergence the shared service layer exists to prevent.
- **No negation on structured filters.** `-word` already works, because
  `websearch_to_tsquery` reads it; `-in:noise` would double both the parse
  surface and the SQL for a need nothing has yet demonstrated. Listed under known
  limitations rather than guessed at.
- **A quoted value survives a colon**, which is why the lexer is a scanner rather
  than a regex: `in:"9:30 standup"` has to work, and so does an unterminated
  quote somebody is halfway through typing.

### Ranking: relevance when there are words, recency when there are not

`ts_rank_cd` over the existing GENERATED tsvector — no new column, no new index,
no trigram. The weights are the schema's own judgement about which part of a blip
is most itself (title A, tags B, url C, body D), so the ranking inherits it, and
cover density is what makes a blip whose title _is_ the phrase beat one that uses
both words four paragraphs apart.

Full-text rather than trigram or ILIKE because the corpus is already indexed for
it: `blips_search_idx` is a GIN index that has existed since `0001`, and the
matching semantics — quoted phrases, `OR`, a leading minus — are the ones a
person expects and the ones the single-radar box has always had. A parallel
matcher would have meant the same words finding different things in two places.

`ORDER BY score DESC, created_at DESC, id DESC`. Three notes:

- **`pinned` is deliberately not a key.** A pin is a statement about one radar's
  own stream; carrying it into a search across forty radars would float somebody's
  pinned shopping list above the exact phrase they typed.
- **The keyset stays total**: `id` is the primary key and cannot tie, so no two
  rows can be equal on the triple.
- **The score travels in the cursor as Postgres-rendered text**, never through a
  JavaScript number. That is the float twin of the microsecond bug this codebase
  already carries a warning about: `ts_rank_cd` returns a `real`, a round trip
  through a JS float does not always come back the same, the comparison is `<`,
  and the boundary row is then served twice or skipped in silence. `::text` out
  and `::real` in is lossless. The test proving it was itself checked by
  sabotage — rounding the value fails exactly the two paging assertions.

With no words there is nothing to be relevant to, so `in:x is:done` falls back to
capture order, which is both the right answer and the index-only one.

### One index, and why the other seven filters needed none

`0010` adds `blips (author_id, created_at DESC)` and nothing else. `author_id`
had never been indexed because nothing had ever filtered on it — the column
existed to render a byline, which is a lookup by blip. Everything else was
already served: the radar IN list by `blips_radar_created_idx`, tags by
`blips_tags_idx`, state by `blips_state_idx`, pinned by `blips_radar_pinned_idx`,
the two `has:` EXISTS clauses by `attachments_blip_idx` and
`blip_comments_blip_idx`, the date bounds by the second column of
`blips_radar_created_idx`, and the words by `blips_search_idx`. The migration
carries the list, so the next person adding a filter can see which side of it
they are on.

`has:link` deliberately has no index: `url IS NOT NULL` is true of a large
fraction of rows, so scanning the already-narrowed radar set beats a lookup.

### One visible search in the application header

The authenticated shell owns the visible search field. It replaces the text box
beneath each radar's composer and the sidebar search destination. Typing shows a
short, debounced preview of matching blips; Enter opens the dedicated results
page with the same query and current-radar priority. Selecting a preview opens
that blip expanded in the results page, including older or archived hits that
may not be loaded in the radar's current view. Template lane, state and tag
filters remain on radars.

Search covers all readable radars by default. When viewing a radar, matching
blips from it appear first under “This radar”, followed by matches from other
radars. Home and other unscoped screens rank results normally. The current radar
changes ordering, never authorization or the overall search scope. Explicit
`radarId` filtering remains available to existing API/MCP clients; the header
has no scope dropdown. Query filters such as `in:` can still narrow results.

`preferRadarId` expresses ordering separately from restrictive `radarId` scope.
It resolves through the same radar access and saved-filter rules. Preferred
membership is sorted before the existing relevance/recency keys, with the
preference carried through pagination. Preview and full results use the same
ordering rather than sorting an already truncated page in the browser.

The header remains visible while content scrolls. The preview supports keyboard
navigation, Escape dismissal and clear loading, empty and error states. Mobile
placement must leave both the field and results usable with the keyboard open.
The results page remains a linkable destination without a second search field.

On themed radar content pages, search adopts the radar's validated palette,
accent, chrome font and corner style. Search excerpts keep the chrome font for
readable navigation; expressive body fonts remain in the actual blips. This is
a narrow styling boundary: decorative patterns, custom cursors, headline effects
and content density do not spread into search controls. Menus retain solid,
readable surfaces and consistent keyboard focus and touch targets. Home,
directories, settings and the dedicated results page use the standard app theme.

### The MCP tool gained the grammar, and its structured arguments became sugar

`search_blips` parses the same string, and `tag`, `state` and `kind` are folded
into it rather than carried down a parallel path — two ways to say "only blips
tagged bug" is how they come to mean different things. `radarId` stays an
argument, because it is an id the caller already holds rather than a name to be
matched, and resolving it through `requireRadar` is what keeps a smart radar
working and makes an unreadable id a 404 rather than a quiet empty page.

The response carries `filters`, `problems` and `unresolved`. An agent that could
not see those would have no way to tell an empty answer from a mistyped one,
which is the entire point of reporting rather than dropping.

## 21. Discussion density on a desktop

The discussion template shipped and immediately read as cramped. The measurement
says why, and it is not the thing it looks like.

At 1920 the column was **760px inside a 1656px pane** — 46% of the available
width — and each thread spent four stacked rows of chrome (lane pill, reply count
and last reply, the blip's own byline, the title) before a single word of the
thought. One and a half threads fitted on a 900px-tall screen.

So the vertical problem was being caused by a horizontal one: there was nowhere
else to put the chrome.

**What was not done: widening the prose.** A serif paragraph has a measure, and
1600px of it is harder to read rather than easier. The temptation a wide screen
creates is exactly the wrong move.

A thread is two columns — a 9rem instrument rail and the reading column — and the
container goes to 960px to pay for the rail. The rail is on the **left** because
it is the scanning column: an eye going down the left edge answers "what has
moved" without reading anything, which is the half of Wave's trough a layout can
actually solve. It is **sticky**, so on a long thread the lane and the reply
count follow you down and stay answerable at the point in the thread where you
are asking.

**Revised 2026-08-27: the switch is a container query, not a media query.** It
was `@media (min-width: 64rem)`, and that asks a question with three different
answers at the same viewport — the sidebar costs 264px expanded, 60px railed, and
nothing at all on a public radar. Measured at the breakpoint itself, which nobody
had:

| viewport | thread panel | rail | reading column |
| -------- | ------------ | ---- | -------------- |
| 1023     | 912px        | —    | **912px**      |
| 1024     | 712px        | 144  | **534px**      |
| 1152     | 840px        | 144  | 662px          |
| 1280+    | 912px        | 144  | 734px          |

One pixel of extra window cost 41% of the measure, and it was invisible at 1366,
1440 and 1920 — the three widths the desktop sweep held. `.discussion` is a
container now and the rail appears from **55rem of the thread's own width**,
which is the width at which it is affordable: the rail costs 144px plus a 24px
gutter and the panel spends 32px on padding, so the reading column is W − 200,
and 880 − 200 = 680 is within 2% of the ~690 this section defended. In practice
the app only ever hands the container 712, 840 or 912, so the rule reads: the
rail appears when the thread has the full 912, and nowhere else. Below it the
chrome lays out on one line above the words, which was the third option in the
original report and is now what 1024 and 1152 get — 683px and 811px of prose
where they had 534 and 662.

The gate moved with it. `the discussion rail does not take a third of the thread`
measured the rail, which does not exist in the stacked shape; it is now `the
thread spends its width on prose, not on chrome`, asserted on the reading column
at a floor of 0.78. The floor is 0.78 rather than 0.75 because 534/712 is 0.7500
exactly — the first version of the assertion passed on the defect it was written
for, which is what reverting the fix and re-running is for.

Measured after: column 760 → 960, thread panel 712 → 912, thread height
393 → 347, the first thread 52px higher up the page, and the prose measure
667 → ~690 — which is the number that was supposed to stay still. It is 734 at
1280 and above today, and the container query is what keeps it from being 534
one pixel below that.

**The nesting depth was not touched.** The one-level cap rests on comprehension
evidence as well as on the 296px an indented reply has at 390px, and Slack
reached the same conclusion independently after six internal versions. A wider
screen is not an argument against either. Two columns _of threads_ was also
refused: the whole thesis is that the thread somebody just answered is the panel
at the top of the page, and a masonry destroys precisely that.

## 22. Radar themes, and the picker that had to scale

Two requests, and they turned out to share a shape: **the vocabulary grows and
the surface must not.**

### More icons and more colours, without a wall

The accents went from ten to twenty-six and the glyphs from sixteen to
forty-eight. Lucas pre-diagnosed the real problem in the same sentence he asked
for them: a longer flat list makes the settings surface worse, not better. Two
flat wraps of seventy-four small targets is about eleven rows on a 390px screen,
sitting between the template grid and the delete button.

So the registries gained **display metadata** — an accent declares a `family`, a
glyph declares a `group` and search `keywords`. Nothing behavioural reads either;
they exist so a picker can draw six short labelled rows instead of one wall.
`AppearancePicker` is then closed at rest: one line showing the glyph drawn in
the accent and the two names, with Colour and Glyph as separate disclosures that
close each other. **The dialog can never grow by more than one panel however many
tokens are added later**, which is the property that makes the next twenty
glyphs free.

**One thing here was overturned on 2026-08-27.** The open panel capped itself at
`17rem` and scrolled, so a long panel could not push the dialog's Save button off
the bottom of a phone. Correct inside a dialog, and wrong the moment settings
became a page: the cap was then one of three independent scroll regions stacked
vertically — the modal body, this panel, and the theme panel — all painting a
scrollbar at once, so a swipe did something different depending on which 100px
band the finger was over. That, not the number of controls, was the mechanism
behind "it feels like a mess". Both pickers take `bounded`, true in a dialog and
false on the page, and the page's own action bar is sticky so there is nothing
left for a cap to protect.

Search lives in the contract (`matchesGlyphQuery`) rather than in the SPA,
because the matching rule is part of what the vocabulary means: an agent asked
for "something science-y" should reach the same flask the picker does.

**Every previously shipped key is preserved, and `appearance.test.ts` writes all
twenty-six accents and all forty-eight glyphs out longhand.** A key here is a
value sitting in the `radars` table on production; renaming one does not fail a
typecheck, it silently repaints somebody's radar in the default colour. That test
is the only thing standing between a tidy-up and that.

The longhand list is checked in **both** directions, and the second direction is
the one that keeps this paragraph honest. Walking the list proves nothing was
renamed; asserting that the list _equals_ the registry proves nothing new shipped
unpinned. For a while only the first existed, and the list had been left at the
pre-`89eec73` vocabulary of ten and sixteen — so sixteen accents and thirty-two
glyphs could have been renamed with nothing failing, while this sentence said
they could not. A one-directional coverage test can only ever be as complete as
the day it was written, which is worth remembering the next time a registry gains
a companion list.

New accents stay inside the luminance band the original ten occupied.
`--accent-from` is a text colour in two dozen rules and the light theme
deliberately does not restate it, so a genuinely pale accent is a cascade change
rather than a palette change. Listed under known limitations.

### A theme is nine enum keys, and that is the security model

"Have some fun with it, like Myspace back in the day" is a good product instinct
and MySpace's actual implementation was a decade-long XSS and phishing farm. The
version that can ship is a **bounded vocabulary**: paper, pattern, reading face,
instrument face, corners, rule between posts, spacing, pointer, headline.

Each is validated against the registry in `packages/contract/src/theme.ts`. The
SPA turns eight of them into `data-` attributes matching **static rules already
in the bundle**, and the ninth — colour — into custom properties whose values are
hexes read out of our own table by a key `themeFor` has already proved belongs to
it. There is no code path anywhere that concatenates a stored value into a
stylesheet, a `style` string or a `url()`. A row this build does not understand
matches no rule and renders as the default.

#### The CSP could not have been the defence, and that is _why_ it is a vocabulary

This is the part worth stating plainly, because it turns a preference into a
constraint.

Blips carry open-graph thumbnails from arbitrary hosts, so `img-src` on a public
radar has to allow `https:`. And `img-src https:` is exactly the channel a CSS
exfiltration uses — an attribute selector that matches on a value and fires a
`background-image` request per match. **As long as link previews exist, raw user
CSS on a public page is unsafe whatever the header says.** The vocabulary is not
a nicety; it is the only version of this feature that can be shipped.

What _can_ be tightened on `/r/:slug` is tightened, in a middleware registered
before `secureHeaders` so its post-`next()` code runs after the header is set:
`connect-src 'self'` (a stranger reading a radar needs nothing else),
`font-src 'self'` (no webfont from any origin, ever — every face in the
vocabulary is a system stack, and this is what keeps that true if somebody later
adds an axis without thinking), `form-action 'none'`, `base-uri 'none'`,
`frame-src 'none'`. `frame-ancestors 'none'` was already inherited, and it is the
one that stops a themed page being framed inside chrome pretending to be somebody
else's.

#### A theme cannot hide an author's name — as a property, not an intention

This is what lets the _whole page_ be themed rather than only the posts, and it
rests on two facts:

1. **A surface ships its ink with its ground.** A person picks a paper, never a
   background and a foreground independently. So text can never be the colour of
   its own background — which, in a vocabulary with no positioning, is the only
   way to hide a byline.
2. **Nothing in the nine axes can position, size, layer or clip anything.** No
   `position`, no `z-index`, no `opacity`, no `overflow`. A theme cannot cover
   the viewport, float fake chrome over real chrome, or push anything off screen.

`theme.test.ts` holds every surface to WCAG AA for body text and 3:1 for the
instrument voice, which is where the attribution line lives; the phone suite
measures the same ratio on the rendered page, through the real cascade, signed
out. Wave's worst failure was letting content masquerade as somebody else's
words. A theme that could hide an author is the same bug wearing a nicer hat, and
this is the pair of facts that makes it impossible rather than discouraged.

#### What the vocabulary refuses

Free text anywhere; `url()`; `@import`; a webfont from any origin; positioning,
sizing, z-index, opacity and overflow; an independent choice of foreground and
background; a custom cursor image; and **ambient motion**. The last is a product
call rather than a safety one and is worth naming as such: §12 makes the radar
sweep the one piece of ambient motion in the product, so a theme that could add a
second would be overriding a decision rather than decorating within it. It is one
line to add if that reads as too strict.

#### Presets are not stored

Nine presets span both directions asked for — Paper, Studio, Press and Noir clean
and modern; Terminal, Blueprint, Geocities and Arcade unmistakably the old web.
Picking one writes the nine axes and **the preset name is discarded**. That way a
preset can be retired or re-tuned without orphaning a radar styled with it, and
`presetOf` stops claiming Geocities the moment you nudge one axis — because you
are no longer on it. A stored preset id would have gone on saying you were.

The default look is stored as `{}`, so "unthemed" has one representation rather
than two that happen to render alike.

#### Themeability is a registry property

`themeable` defaults on and a template opts _out_. The kanban board is the one
that does: its columns read as columns because of the application's own frame
around them, and the spacing axis fights a layout whose density is functional. A
radar switched to a template that opts out keeps its stored theme — it simply
stops being drawn — so switching back is not data loss.

`grouping` moved to the registry in the same change, retiring the last
`template === 'microblog'` in shared code.

#### The MCP decision

`set_radar_theme` ships, and it is **the first creative agent capability in the
product**. Every capability before it was about organising what a person already
wrote. The established boundary — an agent may organise but may never widen
access — is satisfied trivially: a theme touches no grant, no membership and no
visibility.

What made it worth deciding rather than waving through is that it writes
something a stranger sees, on a page published in the user's name. Four things
settle it: the vocabulary is closed and identical to the dialog's, so the tool
cannot express anything a person could not express by clicking; theming cannot
publish, because visibility is a separate tool with its own consent; it requires
`manage`, so an agent acting for an editor cannot restyle somebody else's
published page; and it is one call to undo and audited like any other update.

**Deferred to Lucas:** whether theming a radar that is _already public_ should
need a confirmation the way deletion does. Built as "yes, an agent may"; narrowing
it is one line in `updateRadar`.

### The image on a microblog: one flag meaning two things

The unambiguous defect in the screenshot — "the image isn't centered and looks
like an afterthought" — was two defects.

`BlipCard` took a `compact` flag meaning _this card is dense, drop the kind
badge_, which is what a board column wants, and handed it straight to
`BlipAttachments`, where it meant something else entirely: _a picture here is a
thumbnail, not the point_, `--photo-max: 11rem`. The microblog set `compact` to
lose the kind badge and silently inherited an 11rem thumbnail with it,
left-aligned in the card's text column under a serif post. One flag, two
meanings, and the second one applied to the one surface where it was the opposite
of true.

So `PhotoTreatment` became its own registry axis — `inline`, `thumb`, `feature` —
and the card asks `photosFor(template)`. `compact` keeps its one honest meaning.
`is-feature` swaps inline-block for a block box with `margin-inline: auto`, which
keeps the shrink-to-fit from `c3e30d8` intact (the box is still exactly the
picture, so nothing is letterboxed) while making it centrable, which an
inline-block is not.

The second defect was larger: **the public page threw the template away.**
`PublicRadarRoute` rendered `BlipStream` whatever the radar was, so a published
microblog came out as a stream with a kind badge on every post. The server was
already returning the blips in the template's own order — only the SPA was
ignoring it. It now renders `TemplateView`, with `linkTags` and `publicSlug`
moved onto the shared props as a `ReadingContext`, because a public radar can be
a board or a log too.

## Known limitations

- **The archive boundary moves with the wall clock.** §25 computes archived-ness
  rather than storing it, so a blip can cross the boundary between two pages of
  one scroll and be shown on neither. Same class as the discussion order's mutable
  key, and thirty days wide rather than one reply, but it is real and it is not
  something the keyset can fix.
- **A drop box archives only when it is shaped as a board.** §25's declaration is
  per _template_ and a drop box is a radar _kind_ on the stream or the kanban, so
  the design's "a drop box should archive" is honoured on one of its two shapes.
  One `archives: true` on the stream template would settle it, and would also turn
  archiving on for the default template of every radar in the product — which is
  why it is a question rather than a patch.
- **Nothing at 390px asserts the archive seam.** `archive.test.ts` proves the
  behaviour over the wire — what is hidden, what is counted, what resurrects — and
  the seam itself is a one-line conditional render that was verified in a browser
  in both themes. The phone suite does not seed an archive, so a layout regression
  in that line would not red CI. Seeding one needs the phone seed to age rows,
  which it has no SQL path for today.
- **The unfurl guard is proved by its mechanism, not by a rebinding attack.**
  §12's pin makes DNS rebinding impossible by construction, and the suite asserts
  that property — the socket is handed the vetted address, and DNS is consulted
  exactly once per hop. It does not stage the attack, because doing so needs
  control of the OS resolver (`dns.lookup` goes through `getaddrinfo`, so
  `dns.setServers` cannot redirect it) and that is a machine-level change, not
  something a test can arrange. If this is ever worth proving end to end it wants
  a container with its own resolver, not a cleverer unit test.
- **Nothing sweeps `radar_members` rows on a drop box.** §6.1 refuses an agent
  sharing one from now on; a grant made before that, or made from the app since,
  stays exactly as it is. That is correct — the grant is deliberate and
  revocable — but it means "who can see my drop box" is answered only by its
  member list, and there is no separate audit surface that highlights it.
- **The scrubbed-path table is a list, not a rule.** §5's `scrubPath` names the
  URL shapes that carry a credential, so a _new_ route with a secret in its path
  is covered only once somebody adds a row. The redaction is structural (it
  happens in the logger, not at the call sites) but the vocabulary is not
  derived from the routes — nothing fails if the two drift.

- **Universal search has no negation on structured filters.** `-word` works,
  because `websearch_to_tsquery` reads a leading minus, but `-in:noise` does not.
  It would double both the parse surface and the SQL for a need nothing has
  demonstrated yet; naming the radars you _do_ want is the workaround.
- **Relevance ordering cannot be index-ordered.** `ts_rank_cd` is computed per
  matching row, so Postgres sorts the matched set. `blips_search_idx` has already
  cut that set down to rows matching the words at all, and at this corpus size
  the sort is nothing — but it is the ceiling this design accepts, and a corpus
  two orders of magnitude larger would want a materialised rank or a different
  strategy rather than a bigger `work_mem`.
- **`in:` matches by substring and unions its matches.** `in:design` meaning both
  "Design notes" and "Design system" is usually what somebody wants, and refusing
  an ambiguous name would be a search box that refuses to search. The response
  says how many radars it used, but there is no way to say "exactly this one"
  short of naming the uuid.
- **Searching inside a smart radar is refused rather than expanded.** It is
  itself a saved query, and composing two would need per-radar saved filters
  where `listBlips` takes one scope-wide filter. The message says where the blips
  actually live.
- **Universal search does not search comments.** The tsvector is on `blips`, and
  a reply is a row in `blip_comments` with no `search` column of its own. A
  discussion radar is therefore searchable by its threads and not by its
  answers — a real gap now that a forum template exists, and the fix is a second
  GENERATED column plus a union rather than anything clever.
- **The search box completes `in:` and `from:` only.** `tag:` completes from the
  tag rail somebody is already looking at, `is:` and `kind:` are closed sets the
  help text lists in full, and a date does not complete at all. A tag typed
  slightly wrong is normalised rather than refused, so it fails quietly where a
  radar name fails loudly.
- **The phone suite verifies a viewport, not a device.** `packages/phone` asserts
  layout at 390x844 in headless Chrome, and that is a good approximation of the
  layout and no approximation at all of the browser. iOS Safari's real keyboard,
  its form accessory bar, real `env()` safe-area insets, momentum scrolling and
  rubber-banding stay unverifiable headlessly. Font rendering is deliberately
  never asserted — a suite that fails on half a pixel of text metrics gets
  disabled within a week. So the suite being green means the defects already
  found cannot return silently; it does not mean the phone is right.
- **No `og:image` on public radars.** A share card is generated at
  `/api/public/radars/:slug/card.svg` in the radar's accent, but the major social
  platforms will not rasterise SVG, so advertising it as `og:image` would produce
  a broken preview rather than none. Public pages emit `og:title`,
  `og:description` and `twitter:card=summary`. Rendering a PNG needs a font
  rasteriser in the image.
- **Nothing can be dropped into somebody's drop box from outside.** Sharing it
  with a named person works; there is no address, no form and no webhook, and
  `createWebhook` refuses it outright. That is a deliberate hold rather than a
  gap — §6.2 has the whole design and the one decision it is waiting on, which is
  whether "private inbox" may mean "private except for addresses I hand out".
- **One replica, no PDB, no HPA.** A rolling deploy drops in-flight MCP calls.
- **`readOnlyRootFilesystem: false`** in the chart. The app writes nothing at
  runtime, so this can be tightened once it has been confirmed on-cluster.
- **The nightly backup writes to a local PVC only** — no offsite copy. Inherited
  from Commander's chart, and the same caveat applies.
- **Link previews are fetched once**, on capture, and never refreshed.
- **A public radar's `img-src` cannot be closed**, because blips carry
  open-graph thumbnails from arbitrary hosts. That is an existing third-party
  request made by a page a stranger loads — a referer and a tracking leak that
  predates theming — and it is the reason the theme is a closed vocabulary rather
  than sanitised CSS (§20). Closing it needs preview images proxied through the
  pod, which is bandwidth and a second outbound surface, or dropped from public
  pages, which changes what a published radar looks like.
- **No accent is paler than `slate`.** `--accent-from` is used as a text colour
  in about two dozen rules and the light theme does not restate it, so a pale
  accent would look right on the dark theme and be unreadable on the light one.
  Every accent added in §20 stays inside the band the original ten occupied.
  Fixing it properly means a light-theme accent variant, which is a cascade
  change rather than a palette one.
- **A theme cannot promise an accent is legible on its own paper.** Accent and
  surface are chosen independently, so bubblegum on bubblegum paper is reachable.
  `.radar-theme` mixes the accent 72% toward the paper's ink, which stops it
  vanishing, but that is a floor rather than a contrast guarantee. The guarantee
  that _is_ made — and tested — covers body text and the attribution line, which
  read from the surface's own paired ink.
- **A theme is a per-radar look, not a per-account one.** Nothing carries a style
  across a person's radars, and there is no way to say "all my public pages look
  like this". Nine axes copied by hand is the current answer.
- **A decision log records when a decision was _logged_, not when it was
  _made_.** A "decided on" field would be exactly the ceremony capture refuses,
  and inferring a date from prose is its own piece of work with its own failure
  modes — so `created_at` answers the question it can answer honestly and the
  lane says the rest. An `occurred_at` column is on the templates backlog behind
  the roadmap layout, which is the feature that genuinely needs it.
- **Nothing stops two blips claiming to replace the same one.** That is a
  judgement rather than a constraint, and a unique index would refuse a
  legitimate case (two proposals overturning one decision). The reverse lookup
  shows the most recent claimant; the other link is still stored and still
  readable from the blip that made it.
- **`supersedes` is unreachable from the SPA.** The link renders in both
  directions on a decision log and can be set over the API and MCP, but there is
  no control for making one by hand — the natural gesture is picking the entry
  being replaced from the log itself, and that needs a picker the composer does
  not have. Setting it is one `update_blip` call, which is how an agent will do
  it anyway.
- **A board loads every lane in one page** (200 blips) rather than paging per
  column, because a column that is half-loaded reads as a column that is empty.
  A board with more than 200 cards shows a "load more" control instead.
- **Kanban drag-and-drop is pointer-only.** Every card also carries a lane
  select, so the board is never the only way to move something — but there is no
  keyboard drag.
- **The lane budget is remembered for as long as you are looking at the board.**
  Which lanes are open is per-viewer and per-visit, like furling always was, so
  reopening a radar starts from the seeded ordering rather than from where you
  left it. Storing it would mean deciding whether it belongs to the person or to
  the screen, and the sidebar's own answer — the screen, in `localStorage` — is
  not obviously right for a per-radar preference.
- **A topic's cascade cannot be set at creation.** The create form deliberately
  omits it; a new topic groups and shares nothing until the switch is thrown on
  the topic's own screen, which is the only place that states who it will reach.
  That costs a second step for somebody who knew what they wanted, and it is the
  right trade for the widest access change in the app.
- **There is no committed desktop-viewport suite.** `packages/phone` gates 390px
  and nothing gates 1366/1440/1920, where the board's lane budget and the
  sidebar's two states actually live. The numbers in §16 were measured with a
  scratch harness built on `packages/phone`'s own server and seed, and thrown
  away — which is exactly the pattern `packages/phone` exists because of.
- **No per-IP rate limit on the webhook ingress.** The per-webhook window only
  charges requests that presented a valid token; absorbing a flood of invalid
  ones is left to the edge.
- **Webhook deliveries cannot carry attachments.** A file has to be presigned
  into MinIO, which a third-party sender has no way to do, so multipart text
  fields come through and files are ignored.
- **A smart radar's `blipCount` is 0 in `list_radars` and the sidebar**, because
  it genuinely owns no rows. Opening one resolves and counts what it shows.
- **A folded notification does not resurface.** The stream sorts on
  `created_at` so the keyset cursor stays total (§8), so ten new reactions grow
  an existing line's count in place rather than lifting it back to the top.
- **Push cannot be verified end to end without a real push service.** The
  cryptography is proven by an RFC-8291 round trip and the delivery leg by a
  fake push service on a real socket, but nothing in CI exercises FCM or
  Mozilla actually accepting a VAPID token.
- **Fan-out is one statement per recipient.** A radar with fifty members all set
  to `all` costs fifty upserts on every capture. Fine at this scale and a real
  ceiling at a larger one; the fix would be a single multi-row insert.
- **An email that has already been sent cannot be recalled** when access is
  revoked, even though the in-app notification is deleted. Nothing can fix that,
  but it is worth knowing the two are not equivalent.
- **No notification is raised for anything an agent does on your behalf** beyond
  the events above — an agent re-filing forty blips over MCP is silent, which is
  right for a tool acting as you, but it does mean the audit log is the only
  record of it.
- **Comments are still not searchable**, and threading makes that sharper: on a
  discussion radar most of the words are in the replies, so `search_blips` finds
  the question and not the answer. `blips.search` is a generated column over the
  blip's own columns. Indexing them means either a second tsvector on
  `blip_comments` or a materialised join, and neither is worth it until threads
  are long enough to lose things in.
- **A mention names a person, not a place in a body.** `@ada` addresses somebody
  for the whole blip or comment it appears in; there is no anchoring to a
  particular sentence the way a document comment anchors to a text range. That
  is the one Wave idea that has never survived into a _conversational_ product,
  only into document ones, and it would need a position that survives an edit.
- **No per-reply read state.** The jump control goes to the _newest_ reply, not
  to the first one you have not seen, because unread is modelled per notification
  rather than per comment. Wave modelled the finer thing and never surfaced it;
  this surfaces the coarser thing, which is the trade worth making until a thread
  is long enough for the difference to bite.
- **Editing a comment works over the API and MCP but has no control in the
  SPA** — the thread offers delete only, the same shape as blip editing before
  it got an editor.
- **Who reacted is never shown.** Tallies are aggregated in SQL and only
  `mine` comes back, so there is no hover-for-names. That is a deliberate
  narrowing rather than a missing feature, but it does mean a reaction cannot be
  used to take attendance.
- **A public visitor can read a thread but never add to it**, and sees no
  reaction controls at all. Anonymous participation would need its own
  authorization story — see §7.
- **The phone layout is verified by emulation, not by a device.** A headless
  browser at 390×844 with a shadowed visual viewport gives a true layout and
  catches every geometric defect, but iOS Safari's keyboard, its floating form
  accessory bar, `env(safe-area-inset-*)` and momentum scrolling are not
  reproducible headlessly. Anything touching the phone frame wants confirming on
  a real handset before it is called done.
- **A topic cannot be shared with a co-owner.** `TOPIC_ROLES` is `viewer` and
  `editor` only, so only the topic's owner can rename it, share it, file radars
  into it or move the cascade switch. Widening this later is easy; narrowing it
  would mean taking access away from somebody who already had it.
- **Adding a radar to a topic needs `manage` on both**, so two people cannot pool
  radars they each own into one shared topic without one of them owning both.
  That is deliberate — see §17 — but it does mean a topic is one person's
  container that other people are let into.
- **Topics have no public surface.** A radar can be published; a topic cannot.
  A public topic page would need its own answer to what a stranger sees, and that
  is a new disclosure surface rather than a missing feature.
- **A topic cannot be renamed into another person's namespace**, and topic slugs
  are owner-scoped like radar slugs, so a topic shared with you is only ever
  reachable by id rather than by name.
- **Turning a cascade off sends nothing.** The access stops immediately and the
  notifications that carried excerpts of it are deleted, but nobody is told —
  consistent with removing a radar member, which is also silent. Whether "your
  access was taken away" is a message this application should ever send is a
  product question, not an oversight.
- - **The desktop sidebar is `display: none` on a phone, not unmounted.** It still
    renders and still holds a second copy of every badge, hidden. Cheap, and the
    queries behind it are shared, but it is not nothing.

## 21. Token scopes

A bearer token carries a **ceiling** — the strongest `RadarRole` it may reach,
whatever its holder's own grants say. `radars:read` caps at `viewer`,
`radars:write` at `editor`, `radars:manage` at `owner`.

### The bug this closes

`resolveBearerToken` computed a scope for every bearer token and `attachActor`
threw it away. `Actor` had no field for it, so no service could read one, so
every connected agent acted at the full breadth of its human's access no matter
what the grant said. A client could ask for `radars:read`, the string was stored
on the grant, and the token then did everything anyway.

The consent screen was not lying about it — it described full access in three
fixed sentences, which is what a full grant got. But the record said otherwise,
the protected-resource metadata advertised `scopes_supported`, and a client that
asked for less was told it had less and given everything. That is a consent bug
whichever way it is read, and it was not narrow: `requireActor` asked who the
_user_ was and never what the _connection_ was, so a bearer token could also
`POST /api/tokens` and mint itself a fresh full-access PAT, register an OAuth
client and approve its own consent for it, and — if its owner is an admin —
approve accounts and suspend people. None of those are described by any scope
that has ever existed. Minting a credential, approving a consent and the admin
surface are now session-only: a ceiling that can be raised by one HTTP call is
not a ceiling.

### Where it is enforced, and why there

In `services/access.ts`, at the tail of `getRadarAccess` and `getTopicAccess`, so
REST and MCP inherit it identically. A scope check living only in the MCP router
would be the same class of bug as the one being fixed.

The security argument is about where the `min` is **not**. `decide()` still runs
on the human's grants and only the human's grants — an agent holds no grants of
its own, so it contributes no term to the union. The only token-specific
operation in the whole authorization path is a monotonically weakening `min`
applied to an answer already decided. To give a token more access than its human
you would have to add a term to the union, and there is none to add. That is what
makes this an intersection rather than a union with good intentions.

Two consequences fall out of it, both asserted in `scopes.test.ts`:

- **A cascading topic is inherited, not re-decided.** Every invariant §17 states
  survives untouched, because the agent evaluates a weakening of an access that
  §17 already computed. `CASCADE_GRANTS` has no `owner` in its range, so `manage`
  stays unreachable through a cascade with no second check.
- **Search composes without a second authorization path.** `readableRadarIds` is
  the floor every filter narrows from (§20), and every ceiling is at least
  `viewer`, so a scoped connection sees exactly what its human sees.

`listRadars` and `listTopics` compute that union a _second_ time, in SQL, for the
sidebar. A list that advertises `canWrite` on a radar the connection cannot write
to is the MCP-disagrees-with-REST divergence happening inside a single service,
and it is exactly the kind of thing that gets missed — the clamp was written once
and the second union found by sabotaging it.

`listRadars` applies `clampRole`. **`listTopics` does not** — it hand-rolls the
two booleans at `services/topics.ts`, and they agree with `decideTopic` only
because `TOPIC_ROLES` happens to be `['viewer', 'editor']`, which makes
`role !== 'viewer'` accidentally equal to `topicRoleAtLeast(role, 'editor')`. A
third topic role diverges them in silence, and nothing tests the topic list the
way `scopes.test.ts` tests the radar list. This paragraph claimed both used the
clamp for a while; it did not become true by being written down, which is the
whole reason the claim is worth checking rather than trusting. Two things close
it: derive the topic booleans from `decideTopic` (or a shared
`decideTopicCaps(role, ceiling)`), and add the topic sibling of
`'the radar list never advertises a capability the connection does not have'`.

**Participation is capped at `radars:write`, not `radars:read`.** `canParticipate`
deliberately sits below `canWrite` for a human — a viewer may join the
conversation without editing the blip (§7) — and that stays true. For a token it
does not: from the token's side a comment is an outbound utterance, and a
read-only connection that can still post comments is not read-only in any sense
a person would recognise.

A handful of writes have no radar to clamp — creating a radar, a smart radar, a
topic or a dashboard; marking notifications read; notification settings; push
subscriptions. Those call `requireScope`, in the same module, against the same
two tables. It is not a second authorization path: it decides nothing about
grants, and only asks what the connection was given.

### `radars:manage` exists so nothing shipped stops working

The tempting rule was that a token can never confer `manage` — an agent could
then never delete a radar, publish one, or share it onward. It was rejected
because it silently removes five shipped MCP tools: `delete_radar`,
`set_radar_visibility`, `share_radar`, `create_webhook` and `delete_webhook`.
Removing capability that is live in production as a side effect of fixing consent
is not a change anybody agreed to. Adding the scope, granting it by default, and
naming it on the consent screen gives the ceiling a real dial without breaking
anything.

Creating a radar is `radars:write` rather than `radars:manage`, for a related
reason: a new radar is a container for your own capture and grants nobody
anything, and putting it above `editor` would stop a write-scoped agent from
capturing without a radar id, which is the cheapest capture path in the product.

### What happens to a token that already exists

Nothing, and that is the point. The two families are asymmetric because their
histories are, and `drizzle/0014_token_scopes.sql` carries the full argument.

- **A PAT never had a scope at all.** `resolveApiToken` returned the literal
  string `'radars:read radars:write'` for every PAT ever minted; nobody was shown
  it, no UI offered a choice, and nothing read it — a PAT could delete radars and
  manage webhooks, which that string does not describe. There is no consent
  record to preserve, only a behaviour, so `api_tokens.scope` defaults to the
  full set and every existing row was backfilled to it.
- **An OAuth grant has a real string that was never displayed.** Enforcing those
  retroactively would withdraw `radars:manage` from live connections on the
  strength of a number the user never saw; rewriting them to the full set would
  destroy the only record of what each client asked for. So neither: a new
  `oauth_tokens.scope_consented` flag records whether the scopes were put in
  front of a human. `false` on every pre-existing row, which keeps its owner's
  full access; `true` on everything minted from here on. The flag is **carried
  forward through refresh rotation** rather than re-derived — otherwise a legacy
  grant would silently become enforced the first time it refreshed, an hour
  later, which is the same regression by a slower route.

A legacy grant therefore keeps full access until the client re-authorizes, at
which point the consent screen names the scopes and they start being enforced.

### The consent screen says what the grant says

The three fixed sentences are gone. The screen renders one line per granted
scope, derived from the same `parseScopes` the server writes the grant with, so
the two cannot disagree. A client asking for `radars:read` now visibly gets a
one-line screen. Absent means all three — the same default the server applies,
because a default that quietly narrows an existing integration is a breaking
change dressed as a security fix. A scope this server does not define is dropped
rather than honoured; a request naming only undefined scopes is refused before
any screen is shown, so nobody is ever asked to approve a grant that cannot be
made.

A refusal caused by the ceiling is `insufficient_scope` with the
`WWW-Authenticate` header RFC 6750 defines, and a deliberately different sentence
from a permission refusal. "You have read-only access to this radar" sends an
agent looking for a permission its human already has; only a re-authorization
fixes a scope.

### Known limitations

- **A PAT cannot be narrowed.** The Settings → Agents screen offers no scope
  picker, so every PAT is minted at the full set. `services/tokens.ts` is where a
  chosen set would be written.
- **`ensureDropBox` is not scope-gated.** Reading the drop box creates it on
  first use, so a read-only connection can cause one insert — an idempotent
  bootstrap of the caller's own private inbox, holding nothing. Gating it would
  make `read_drop_box` fail for a read-only agent on an account that had never
  opened one.
- **The deploy window is five minutes wide.** An authorization code minted by the
  old consent screen and redeemed by the new server is treated as consented, at
  whatever scope the client requested. Codes live five minutes; the worst outcome
  is reconnecting an agent.
- **Scopes are a total order, so they cannot express "share but not capture".**
  The ceiling is a single `RadarRole`, and a ceiling that is not a total order
  stops being a `min` — which is the whole security argument. A capability-shaped
  grant would be a different design, not a wider enum.

## 22. What an agent may never do

A second boundary, narrower than scopes and asking a different question. A scope
asks _how much of what this person can do was handed to this connection_; this
asks _is this the kind of act a connection may perform at all_. No arrangement of
scopes answers the second, because every act below is something the person
themselves may obviously do. The objection is not to the power. It is to who is
exercising it, and whether anybody is present to see the consequence.

`assertHumanDecision(actor, message)` in `services/access.ts` is the whole
mechanism: refuse unless `actor.kind === 'user'`.

### The absence of a tool is not a refusal

§17 said the cascade switch was fenced because there is no MCP tool for it.
`docs/MCP.md` said the notification switches were fenced the same way. Both were
true statements about the tool surface and neither was enforcement.

`attachActor` is global middleware with no path restriction, so an agent's bearer
token authenticates on `/api/*` exactly like a session cookie. Three ordinary
REST calls with a connected agent's token:

```
PUT  /api/topics/<id>/cascade    {"cascade": true}
POST /api/topics/<id>/members    {"email": "<stranger>"}
PUT  /api/radars/<private>/topic {"topicId": "<id>"}
```

and a stranger who was never given anything is reading a private radar as an
editor, `via: 'topic'`. The same token could turn the email and push switches off
— the thing `docs/MCP.md` promises outright is impossible, on the grounds that an
agent must not be able to make itself the only thing that knows something
happened.

**So the rule is: an agent-facing refusal belongs on the shared service path,
never in the tool router.** A tool that refuses something the service allows is
documentation. `assertMayInvite` (§19) had this right from the start and is why
the invitation fence held under the same probing; the topic fences lived in
`mcp/server.ts` and did not. Those wrappers are now plain calls again, and the
sentences they used to throw live in the services.

### The list

| Act                                                                                | Why it is not an agent's                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Turning a topic's cascade on or off                                                | The widest single access change in the application, in both directions |
| Sharing a **cascading** topic                                                      | Hands over every radar in it, including ones that do not exist yet     |
| Filing a radar into a cascading topic **that has other members**                   | A sharing decision wearing the clothes of an organising one            |
| Granting `owner` on a radar                                                        | Handing the radar over — see below                                     |
| Notification settings, per-radar level, push subscriptions                         | A person's control over being interrupted                              |
| Inviting an address with no account, and the waitlist bypass                       | §19, and enforced there since it shipped                               |
| Minting or revoking a PAT, approving an OAuth consent, anything under `/api/admin` | §21 — these issue or destroy credentials                               |

Everything else stays an agent's job, and the test suite asserts that half too: a
boundary with no control is indistinguishable from a broken feature.

### `share_radar` could grant `owner`, and said it could not

The tool declared `role: z.enum(RADAR_ROLES)` — `['viewer','editor','owner']` —
while its own `.describe()` named only viewer and editor. So the third value was
reachable and undocumented in the same breath, and `owner` in `radar_members` is
`canManage`: the grantee could publish the radar, share it onward, and delete it
outright. Removing the real owner is correctly refused; destroying the radar was
not.

An agent may now share as `viewer` or `editor` and not as `owner`. Both of those
are one click to undo on the member list and neither can remove the owner; the
third is handing the thing over. The enum stays whole and the refusal is a
sentence from the service rather than `owner` being cut from the schema, because
a connector can hold a cached copy of a tool schema for a long time — a narrowed
enum would still let the call arrive and would only change where the error came
from, and a schema rejection says nothing about why.

### A suspended account has no credentials, of any kind

Suspension deleted session rows and never touched tokens, so an account could be
suspended — sessions gone, next request 401 — while its PAT and OAuth tokens kept
working indefinitely. Two routes (`/api/blips/:id/comments`, `/api/attachments/:id`)
serve anonymous and signed-in callers through one path and so take the actor
without `requireActor`, which meant nothing downstream caught it either.

**State first, then scope.** Both queries in `auth/bearer.ts` now require
`users.state = 'active'`, so a token belonging to a suspended or never-approved
account does not resolve at all — it is not an actor with a small ceiling, it is
not an actor. A scope check on a principal that should not have authenticated is
enforcement in the wrong order, and it would leave every route to remember.

Enforced at resolution rather than by revoking the rows, and that is a real
choice: a PAT has to **survive an unsuspension**, because the human deliberately
connected that agent and making them reconnect every one after a lapse is the
worse outcome. So the state is read fresh on every request, exactly as
`mayBypassWaitlist` reads the admin bit.

The refresh grant needed the same check for a sharper reason. Rotation writes a
new row with a new `created_at`, so the 30-day refresh window **restarts on every
refresh** — without a state check, a suspended account's client keeps a working
grant for as long as anything keeps calling. `/oauth/token` now joins `users` and
requires active.

`liveActor(c)` covers the two lenient routes: a session for a non-active account
is downgraded to anonymous rather than being treated as a member. Session cookies
are still _attached_ for such accounts, deliberately, because `requireActor` needs
them to answer "your account is waiting to be approved" rather than "sign in".

### Known limitations

- ~~**An OAuth grant cannot be revoked.**~~ Closed 2026-09-26 with the Agent
  Repo (§35): Settings → Connections disconnects a grant, and a
  per-grant advisory lock stops a racing refresh from minting a survivor.
- **The agent boundary is a list, not a property.** Nothing forces a new
  mutating service function to consider whether it belongs on it, the way
  `requireRadar` forces an authorization decision. A new fence is a thing
  somebody has to remember.

## 23. Agent personas

An AI can have a name of its own — and can never act except on behalf of a human.
`docs/PERSONA.md` is the long version, including the two findings that only a real
Postgres produces. The short version is one sentence and everything else falls out
of it:

> **The voice decides what is rendered. It never decides what is recorded.**

Because an agent can never act alone, every agent-borne write already has a human
behind it. So the agent is an _additional_ author, not an alternative one:
`blips.author_id` and `blips.agent_id` are both written every time, in both
voices, with no mode that suppresses either. `agent_voice` stores which name the
byline leads with, because a reader opening the radar next year has no token to
consult.

That is the whole impersonation argument, in both directions. Agent→human has no
column to forge. Human→agent is unsayable: `agent_id` is derived from
`actor.agent` and from nothing else, and no request body, tool argument or service
parameter carries an agent id anywhere that writes content. The `as` argument
selects a _voice_ from a closed two-value enum and cannot name a principal.

### Why a separate table

`agents` is not a row in `users` with a discriminator. No `email`, so
`findUserByEmail` has nothing to answer and an invitation has nothing to be
addressed to; no `state`, so the waitlist and `activateUser` are out of scope for
it permanently rather than by predicate; no `is_admin`, so the bit cannot be held.
Each absence keeps a subsystem out of scope by construction, where a discriminator
would need a `kind = 'user'` predicate in around thirty lookups — and an incomplete
list there is the bug.

### It holds no membership, ever

What an agent can reach is `readableRadarIds(its owner)`, clamped by its token's
ceiling — computed on every call, materialised nowhere. A membership row would be
standing access outliving the token, and it would add a term to the union in
`decide()` where §21's rule demands an intersection. **The agent is a second
computed overlay stacked on the first**, and the argument is the same one
`topics.cascade` makes in §17: a derived value cannot drift from its source.

So the persona changes nothing about authorization. The union runs on the human's
grants and only the human's, and the only token-specific operation in the whole
path is still the `min` §21 introduced.

### The three sharp edges

- **The authorship FKs are `DEFERRABLE INITIALLY DEFERRED`.** `author_id` and
  `agent_id` both point at the same human on every agent-borne row, so deleting
  that person runs two `ON DELETE SET NULL` actions plus a CASCADE against one
  tuple — and a non-deferrable check lands on a tuple version naming an agent
  Postgres has already removed, aborting the whole DELETE. `INITIALLY IMMEDIATE`
  holds only on small fixtures. Asserted on `pg_constraint.condeferrable` as well
  as behaviourally, because the failure is trigger-order dependent and therefore
  intermittent by fixture.
- **The notification self-filter is pairwise.** It was keyed on the user id alone,
  and an agent's queue row carries its owner's `user_id` — so Lucas mentioning his
  own `@claude`, the most likely use of the whole feature, was filtered out
  silently. Suppress when the addressee _is_ the actor: a person's row when that
  person acted, including personal-voice delegation; an agent's row only when that
  agent acted. Persona-voice **comments** are another participant speaking: they
  notify their involved human cosigner, like anybody else's comment. This uses
  the stored comment voice, not the connection's default, and preserves radar
  mute, channel/kind preferences, active-account and current-access checks,
  coalescing and durable event replay. Personal-voice comments, ordinary captures
  and reactions retain their self-filter. This rule follows Lucas's October4
  clarification on blip c0105c84-8fd7-4287-ad3e-4f73dd1c8916.
  Migration0058 also records qualified principal keys separately from legacy
  human cosigner IDs. Attributed event count increments on every new-writer
  event, including repeated principals; total count also includes old-writer
  inserts/folds. A difference marks unknown earlier attribution during rolling
  releases. Existing events are never backfilled into invented agent identities.
  Principal identities fold atomically newest-first/distinct/capped; event
  counts never imply a total number of participants. One shared sentence names
  agents with an `(agent)` label in inbox, REST/MCP, email and push. Names are
  resolved live, including archived agents; missing records render a neutral
  former-principal label without retained name snapshots.
- **`notifications.user_id` stays NOT NULL and stays the owner.** Coalescing is a
  partial unique index on `(user_id, group_key)`, so a NULL there would mean agent
  rows never conflict and folding would silently stop working for agents while the
  index went on looking correct. The group key is namespaced instead.

### Settled 2026-08-27: delegation is invisible

Whether an agent acting on somebody's behalf is _named_ to other people on a
shared radar was Lucas's to decide. **He chose hidden.**
`PRINCIPAL_VOICE_NAMES_THE_AGENT` in `packages/contract/src/text.ts` is now
`false`: a `principal`-voice write renders simply as the human, everywhere.

Nothing else changed, because nothing else depends on it. Both identities are
still written to the row unconditionally and still carried in both DTOs — the
record is complete, and reversing the decision is the same one line it always
was. `docs/PERSONA.md` §8.4 has the argument on both sides; the deciding one was
that an agent acting on your behalf **is** you, the way a letter your assistant
typed is still your letter, and your delegation is your own business.

**This governs `principal` voice only.** An agent writing in its _own_ persona is
still attributed as itself. That distinction is the whole product: speaking as
itself is the agent saying something, speaking as you is you saying something
through it.

## 24. Connecting, and staying connected

§15 describes a client getting a token. This section is about the four minutes
afterwards, because on 2026-08-27 a client got one and the connection still never
finished — and none of the flow tests could see why, because every individual
request was answered correctly. What was broken lived in the _sequence_.

LM Studio registered, authorized, exchanged its code and made three successful
MCP calls. Then it spent four minutes in a loop that could not converge: 1039
`GET /mcp` 401s, 1047 refreshes, 1043 access tokens minted and exactly two ever
presented. Nothing surfaced to the user. It just sat there.

Two decisions produced that between them, and both were ours.

### An answer that tells a client to retry what can never work

Streamable HTTP lets a client open the server-to-client stream with `GET /mcp`,
and the spec's own answer for a server that does not offer one is 405. This
server is stateless: there is never a stream and never a session to `DELETE`.
But the actor was resolved first, so a client that opened the stream without an
`Authorization` header got a 401 carrying a `WWW-Authenticate` challenge — an
instruction to go and obtain a token, issued about a request that no token could
ever satisfy. The client obeyed it, forever.

The 405 now comes before the auth check. Nothing is disclosed by answering
first: which methods an endpoint implements is published behaviour, identical
for every caller, and `mcp-connect.test.ts` asserts that an authenticated caller
gets the byte-identical answer — the moment those two diverge, the method list
has become an oracle for something.

The general rule is worth stating on its own: **a refusal must be one the caller
can act on.** A challenge that cannot be satisfied is worse than a plain refusal,
because a well-behaved client will keep taking it seriously.

### A rotation that destroyed the credential it was meant to renew

Access and refresh token live in one `oauth_tokens` row, and rotation set
`revoked_at` — which killed both. Nothing in OAuth asks for that. RFC 6749 §10.4
and OAuth 2.1 require rotation to invalidate the _refresh_ token; an access token
is a bearer credential with an expiry of its own.

The cost was a livelock, and the trigger is very small. Two consumers of one
grant is not exotic — it is what LM Studio had: one connection working, and
something else calling without a header. The header-less call 401s, the client
refreshes to recover, and **the refresh revokes the token the working connection
is holding.** Now both are broken, both refresh, and each rotation destroys the
token the other just received. The act of recovering was what broke the thing
that was fine.

Rotation now nulls `refresh_token_hash` and leaves the access token to expire on
its own clock. No property is lost: the partial unique index is already
`WHERE refresh_token_hash IS NOT NULL`, so a replayed refresh token matches no
row and still answers `invalid_grant`. `revoked_at` keeps its plain meaning —
this grant was deliberately killed — and nothing sets it today. A "disconnect
this client" action is where it belongs, and it would correctly take the access
token down with the grant.

### What was investigated and found innocent

Recorded so it is not re-investigated: discovery, dynamic client registration,
`redirect_uri` validation (including RFC 8252 §7.3 loopback port variability),
PKCE, the consent screen, and the five-minute authorization-code TTL — which
cannot be reached by a slow magic-link login anyway, because the code is minted
at the _decision_, after the login, not at `/authorize`. The legacy HTTP+SSE
transport was not involved either: the access log shows Streamable HTTP
throughout, and `/sse` was never requested once.

Missing CORS was the initial hypothesis and was wrong — LM Studio exchanges from
its Node main process, which sends no `Origin`. It was a real gap all the same
and is closed in `cors.ts`, scoped to `/.well-known`, `/oauth` and `/mcp`: three
surfaces carrying no ambient cookie authority, so `*` with **no** credentials is
correct rather than grudging. It must never be hoisted to `/api`, whose only
defence against another origin driving it as the signed-in person is that the
response cannot be read. `cors.test.ts` fences that explicitly.

### What made this expensive to find

Four hours, almost all of it spent establishing something the server already
knew: whether a 401 meant _no credential was offered_ or _the credential was
refused_. The request log records the status and nothing else, so the two were
told apart by correlating pod logs against `oauth_tokens.last_used_at` — which
worked, and should not have been necessary. A `/mcp` 401 now logs whether a
bearer credential was presented at all. The boolean only; the token itself never
goes near a log line.

The SPA fallback was tightened in the same change, on its own merits rather than
as a cause: `/mcp/…` and `/.well-known/…` used to fall through to `index.html`,
so a client probing for a transport this server does not implement got
`200 text/html` — which reads as a connection that succeeded and then never says
anything. They 404 now. A machine-facing path that answers 200 with a React shell
is the worst available failure, because the silence is indistinguishable from
success.

## 25. Blip archiving, and why there is no sweep

A sprint board never accumulates, because time does the cleaning: the sprint
ends, the board is torn down, Done is wiped. **Kanban drops that boundary, so
Done grows forever by construction.** `templateConfig.collapseDone` was the
previous answer and it is a display fix for a data problem — thirty stale cards
occupy 44px instead of a column. They are still there, still counted, and still
loaded.

Lucas's decision, 2026-08-27: **automatic, with a visible seam.** Not a button.
A button is a chore, and a chore nobody does leaves the board exactly as it was.

### One axis, and it writes nothing

A blip is live or archived. There is no third state beside `state` and `status`,
and **archiving writes neither of them** — which settles "where does a
resurrected card go" before it is asked: the lane it was already in, because it
never left.

Archived-ness is **computed, never stored**. There is no `blips.archived_at`
column, no sweep, and no background job. A row is archived when:

- its `state` is `done` or `dropped`; and
- its radar's template declares `archives` in the registry; and
- that radar's window is on; and
- nothing has happened to it for that many days.

`services/blips.ts` holds exactly one spelling of that rule, `archivedExpr`, and
every surface reads it: the stream's `WHERE`, the lane counts, the state chips,
the tag chips, the radar's own `blipCount`, and `is:archived` in the universal
search. Two spellings of "archived" is how a lane header comes to print a number
the column underneath it disagrees with.

This is the fourth time this application has chosen computation over storage and
the reasoning has not moved: `blips.search` is GENERATED rather than
trigger-maintained (§9), `lastActivityAt` is a subquery rather than a column
(§18), and the topic cascade is read at authorization time rather than written
into `radar_members` (§17). **A derived value that is computed cannot drift from
its source.**

### What that buys, specifically

"Activity resurrects" was a requirement: commenting on, editing or moving an
archived blip brings it back. The clock is
`GREATEST(blips.updated_at, lastActivity)` — and those are exactly the three
triggers. Editing bumps `updated_at`. Moving a card bumps `updated_at`.
Commenting moves `lastActivity`. So resurrection is **a consequence of the
definition**, not an event handler that three write paths have to remember to
call.

Held against the alternative: a stored `archived_at` would need clearing on
comment insert **and** comment delete **and** edit **and** lane move **and** a
blip moving radar, and the first path that forgot would leave a blip invisible
with nothing on screen to say why. That is the same failure `lastActivityAt`
declined to sign up for, one object down.

It also answers the question the spec left open — _where does the sweep run?_ —
by removing it. A lazy sweep on radar read would be a **write on a GET**, on a
path that also serves public pages and MCP reads; and it would only ever run for
radars somebody opened, so `is:archived` across forty radars would be answering
from a half-swept corpus. A cron job would be a second process for this
deployment's single pod, and a new class of "the job did not run" bug. Neither
buys anything the predicate does not already give.

### The cost, stated plainly

**The boundary moves with the wall clock.** A blip can cross it between two pages
of the same scroll and appear on neither. That is the same class of mutability
`order: 'discussion'` already admits (§18), and far rarer: the boundary is thirty
days wide, not one reply. No _live_ row can be duplicated or skipped — the keyset
is untouched, and removing rows from a result set moves nothing.

**Query cost.** A correlated `EXISTS` on `radars` (a primary-key lookup) plus the
comment subquery the discussion order already pays, and only ever on rows that
are already `done` or `dropped` — `blips_terminal_activity_idx` is the partial
index for exactly that set. On a template that does not archive, the whole
expression short-circuits on the `template IN (…)` test, so the hot
capture-order path on a stream, a microblog or a discussion is byte-for-byte the
query it was.

**The window is a live rule, not a ratchet.** Widening a radar's window brings
blips back, because nothing was destroyed. Switching a board to the stream
template un-archives everything on it, because the stream does not archive. Both
are the least surprising reading of "hide finished work untouched for more than
N days", and both are free.

### Per template, never globally

`RadarTemplateDef.archives` is opt-in, because the same act means opposite things
on different shapes:

| Template     | Archives | Why                                                                                                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kanban       | **yes**  | The motivating case. A board has no sprint boundary to clear Done.                                                                                               |
| Reading list | **yes**  | `finished` / `abandoned` is done/dropped in different words, and a queue you have worked through is exactly the thing that should shorten.                       |
| Decision log | **no**   | Its rejected and superseded entries **are the artifact**. Archiving them would delete the thing the template exists to keep. The setting does not render at all. |
| Microblog    | no       | It is a diary. You do not archive your diary, and chronological order already sinks old posts.                                                                   |
| Stream       | no       | The null template. Nothing inferred beyond the universal rules.                                                                                                  |
| Discussion   | no       | A resolved thread is a record of an answer, and the thing people come back to.                                                                                   |

`ARCHIVING_TEMPLATE_IDS` is derived from the registry and the SQL predicate is
built from it, so `templates.ts` stays the one place the question is answered —
the same shape as `DROP_BOX_TEMPLATE_IDS`.

**A drop box is the loose end.** The design said it should archive, and it has no
template of its own: a drop box is a radar _kind_ on the stream or the kanban
(§6). So a drop box shaped as a board archives and one shaped as a stream does
not. That is a coherent rule — archiving is a property of the shape, and a stream
has no finished lane to clear — but it is a rule nobody chose, and if the drop
box should archive on both it is one `archives: true` on the stream template.
Left for Lucas rather than guessed at, because turning it on for `stream` turns
it on for the default template of every radar in the product.

### The window

`radars.archive_after_days`, an integer column. **NULL means "no opinion — take
`DEFAULT_ARCHIVE_AFTER_DAYS` (30)"** and **0 means never**, and they are
genuinely different facts: the first is the absence of a decision, which is what
lets the default move later without overriding anybody, and the second is a
decision. Stored on any template and _applied_ only on one that archives, so
switching a radar's template away and back does not lose the setting.

**One number with a per-radar override, not a default per template.** The only
two templates that archive are the board and the reading list, and there is no
argument that a finished card should age out at a different rate from a finished
article. Two constants where one will do is a number that has to be justified
twice and reconciled the first time they disagree. If a template ever genuinely
needs its own, `archives: true` becomes `archives: { after: n }` and this stays
the fallback.

Changing it needs `manage`, alongside `commentsEnabled` and the theme (§22.2):
shortening the window takes rows off the board for **everyone the radar is shared
with**. It is exactly reversible, and reversible only helps once somebody
notices.

### Never silent

The constraint, and it is the one this feature could most easily have broken.

- **A board says it per lane.** `12 · 34 archived` in the column header, only when
  something actually went — a permanent `· 0 archived` on five lanes is chrome,
  not information.
- **Every archiving radar says it once, above the stream.** This line was
  originally board-excluded, on the reasoning that the lane headers were more
  precise. A screenshot said otherwise: the lane budget (§16) rails Done and
  Blocked by default at every width below 1920, and **those two lanes hold the
  entire archive** — so on the default board the count was being drawn inside a
  44px rail that renders no header at all. The line is the guarantee; the lane
  header is the detail.
- **A published radar shows its live work, and cannot be asked for the archive.**
  `includeArchived` is on `listBlipsSchema`, which validates the private route and
  the MCP tool too, so `routes/public.ts` overrides it — otherwise a stranger
  could append it to the URL and read every abandoned card off a board whose
  owner published a page showing four. No public surface asks for it: there is no
  seam and no search on a published page, so the flag would exist only for
  somebody who guessed at it. Same narrowing this route already applies to author
  addresses and member counts (§2).
- **The universal search marks an archived result.** Search spans the archive by
  default (below), so without a marker the search would be the one surface where
  archiving really is silent: the row would look live, and clicking through to
  the radar would not show it.

### The archive is search

No bespoke archive screen. `is:archived` and `is:live` join the `is:` grammar —
on `is:` rather than a field of their own because archived-ness is not a sixth
triage state, it is a fact about a `done` or `dropped` blip that has sat still
long enough, so it composes with `is:done` rather than replacing it.

**A radar's own stream hides the archive; the universal search does not.** That
is the one place the two surfaces deliberately disagree, and it is the point:
hiding finished work from the board is what archiving _is_, but an archive you
cannot find by searching is a deletion with extra steps. `is:live` narrows the
search back to the working set.

The lane header and the radar line both link to `in:<radar id> is:archived`,
composed by `archiveSearchFor`. **The id, not the name**: `in:` resolves an exact
id first and only then falls back to name matching, and that fallback returns
_every_ substring match — `in:"Design"` means both "Design notes" and "Design
system". A header that says 34 and links to a page showing 51 is worse than no
link. The search page renders the resolved filter with the radar's name beside
it, so nothing about the id is left for the reader to decode. It is not
lane-scoped and cannot be: `status:` is deliberately absent from the grammar
(§20), because a lane id means nothing outside its own template.

### Both transports, as usual

`read_radar` takes `includeArchived` and reports `archivedCount` per lane and per
radar, matching the `includeArchived` that `list_radars` and `list_arrays` have
taken since topics shipped — blips were the asymmetry. An agent told to "read
this radar and build what is in it" has to be able to tell _there is nothing
else_ from _there is more, behind a flag_, so the count and the way to it are on
the response rather than left to be discovered.

### What this replaced

Blip `79c3f5d5` asked whether to add a sixth **"Won't do"** lane so `dropped`
cards had somewhere to go on a board. None of its three options are needed:
dropped blips archive. **The five-lane kanban is therefore permanent**, not
pending — no sixth column, no extra 44px rail, and no change to the lane-budget
arithmetic in §16.

### What happens to data that already exists

`0016_radar_archive_window.sql` adds one nullable column and one partial index.
It writes no blip rows, backfills nothing, and is undone by a single
`ALTER TABLE radars DROP COLUMN archive_after_days`.

Every radar gets NULL, which is "take the default". The visible consequence, said
rather than discovered: on a **kanban** or **reading list** radar, blips that are
`done` or `dropped` and have had nothing happen to them for 30 days stop being
loaded and stop being counted. Nothing is deleted, the seam says how many went,
and the count links to them. Every other template is untouched.

## 26. The API, and the clients that are not this repo's

Two rules argued earlier in this document have been narrowed. Both narrowings
exist for the same reason — a client that this repository does not deploy — and
both are written down here rather than discovered later in a diff.

The premise is that the API is the product and every interface is a client of
it. `packages/ui` has always been one; the difference is that it stops being
the _only_ one, and stops being deployed inside the same image as the thing it
calls. Nothing about the service layer changes: routes are still thin wrappers
over `services/`, MCP still calls the same functions with the same `Actor`, and
authorization is still one function. What changes is what a caller may be.

### A session is a credential, not a cookie

§13 issues a session as an httpOnly cookie and never hands the token to the
caller. That was right, and it quietly encoded an assumption: that every client
is a browser, in which case a cookie is strictly better than a token, because
script cannot read it and the browser attaches it without the client having to
remember to.

A client that is not a browser has nowhere to put a `Set-Cookie`, and a client
on a different origin cannot use one. So `sessions` now records the `client`
holding it, and a sign-in that names one is answered with the token in the body
and no cookie at all. Never both: two credentials for one session is two
answers to the question of which one signed a request.

**This does not widen `assertHumanDecision`, and the distinction is worth being
exact about.** §22 draws its line between a person and something acting on a
person's behalf — which is why an agent token may not register for push or
change notification settings. Somebody who signed into a first-party client
with a code emailed to their own address is a person. The container the
credential sits in — an httpOnly cookie, a keychain, an
`EncryptedSharedPreferences` — is a property of the client, not of the
authority. So `omr_s_…` presented as a bearer token resolves through the same
session lookup to the same actor, `kind: 'user'`, and personal access tokens
and OAuth grants remain `kind: 'agent'` with their scope ceiling untouched. The
fence has not moved; what changed is that a person can now stand on a different
part of it.

One thing genuinely is new. A cookie can be replaced on any response, so a
browser session in daily use is silently renewed and nobody notices the
thirty-day TTL. A bearer client has no such channel, and a person using an app
every day being signed out on the thirtieth day for no visible reason is not a
security property. So a bearer session renews on a sliding window: past halfway,
authenticating extends it. An abandoned client still expires exactly on
schedule, because nothing renews a session that stops authenticating.

The second consequence is one the web has been missing all along: if a
credential can live somewhere a person cannot clear by quitting the browser,
they need to be able to see it and end it. `GET /api/auth/sessions` and
`DELETE /api/auth/sessions/:id` are that, and they list every session, cookie
ones included.

### `/api` may answer another origin, but only a caller that brought its own authority

`cors.ts` refuses `/api` cross-origin, and §24 restates why: the API is
authenticated by a cookie a browser attaches on its own, and the only thing
standing between another origin and acting as the signed-in person is that the
response cannot be read.

Read that argument closely and it is not about origins. It is about **ambient
authority** — a credential the browser supplies without the calling page having
had to obtain it. That is exactly why `/.well-known`, `/oauth` and `/mcp` were
always allowed: they carry none, so a caller that cannot produce the secret gets
nothing, and one that can did not need the browser's help.

A bearer token is not ambient either. A page holding one was given it. So the
allowance is granted to that caller and refused to the other, and three things
keep them apart:

- The allow-list is exact origins from `CORS_ALLOWED_ORIGINS`, echoed one at a
  time, never `*`, with `vary: origin` — including on the refusal, because the
  response that differs by origin is the one a shared cache would poison.
- **`Access-Control-Allow-Credentials` is never sent.** It is the single header
  that would turn this back into the thing the original paragraph refuses:
  without it a browser will not attach the session cookie to these requests and
  will not hand the response to a caller that asked it to. There is no
  configuration that adds it.
- `attachActor` independently declines to read the session cookie when the
  `Origin` is neither the API's nor the app's. A property enforced only by the
  browser is a property enforced by somebody else's code.

Empty is the default, and empty means the old rule exactly: no cross-origin
access to `/api` at all. `cors.test.ts` pins that default; `api-cors.test.ts`
pins the narrower allowance, and above all pins the absent header.

### `PUBLIC_URL` was two questions

It was supplying both _what the API is called_ and _where a person goes_, which
are the same string only while one server does both jobs. `APP_URL` takes the
second — invitations, notification hrefs, share links, the buttons in email,
`og:url` — and defaults to `PUBLIC_URL`, so a deployment that has not split
anything cannot discover it is now pointing people elsewhere.

`PUBLIC_URL` keeps everything a third party holds a copy of: the OAuth `issuer`
and endpoint URLs, the `/mcp` challenge, the OIDC `redirect_uri` registered with
the identity provider, and the MCP connection URL. **Webhook ingest URLs stay with it too**,
and that is the one worth stating because it looks like the opposite: a webhook
URL reads as human-facing, and it is pasted into other people's products and
stored there. Moving it does not break a link somebody can re-find; it breaks an
integration silently, on somebody else's schedule.

### A version segment, before it is needed

`/api/v1` mounts every router a second time, from the same list, so the two
cannot drift. Nothing is deprecated: `/api/*` continues to mean v1, and when a
v2 becomes necessary the deprecation is announced then.

It is here now because of when it stops being possible to add. A client this
repository deploys is always current by construction. A client sitting in an App
Store review queue is not, and the moment to have a version segment is before
such a client ships rather than after one has shipped without one. `API_V1` lives
in `packages/contract` for the same reason the schemas do: it is the one string a
client and the server have to agree on before they can agree on anything else.

### What is deliberately not in this

The web client is not extracted. It is now _able_ to be — it reads its API base
at runtime from a JSON block in the document rather than from a build-time
substitution, so one bundle is correct against any API, and `api.ts` can carry a
bearer token instead of relying on the cookie. Both paths work and the cookie
one is still the default.

What remains is a chart change and a `CORS_ALLOWED_ORIGINS` value, and that
belongs in the infrastructure repository with somebody watching, not in this
one. The application code is finished; the deployment is a decision.

## 27. Two caveats retired

`a46e030` closed five check-then-act races and left two caveats in its wake,
both documented at the time rather than papered over: the login-code ceiling was
narrowed but not closed, and the safety of refusing a concurrent-refresh loser
rested on a property a test asserted rather than the code enforced. Both are now
closed, and since the caveats were argued in writing, their removal is argued
here too.

### The login-code ceiling is a row now, and therefore exact

The limit was a count over `login_codes` — read, compare, insert — which is a
check-then-act however tightly the statements are packed. Folding the count into
a conditional `INSERT` narrowed the gap to one statement's width; under
READ COMMITTED two transactions could still each miss the other's uncommitted
row, and the comment said so.

The exact shape was already in the codebase. The webhook window
(`radar_webhooks.window_*`) is a self-rolling fixed window charged by a single
statement whose `CASE` arms read the pre-update row, so the reset and the
increment cannot disagree and two concurrent charges serialise on the row for
exactly one statement's duration. `login_code_limits` is that, one row per
address, and §"the database is the arbiter" gains its second citation.

Two alternatives were considered and lost. **SERIALIZABLE-with-retry** moves the
invariant into an application retry loop, which is the opposite of the rule the
codebase runs on. **A per-address advisory lock** — the migrator's pattern — is
exact but blocking, and blocking is the flaw: the mailbomb this limit exists to
stop would queue its requests on pinned pool connections (`max: 10`) and starve
everyone else. The counter row holds its lock for the duration of one statement,
which is the difference between a rate limit and a denial-of-service amplifier.

The window becomes fixed rather than sliding — six in the hour measured from
the first request, worst case roughly double across a boundary — the trade
webhooks already made, because the job is stopping abuse, not metering fairly.
In exchange `Retry-After` stops being a flat 900 and becomes the truth: the
window's roll-over moment is a column, so the header is computed from it.

### Rotation and mint commit together

The deeper flaw in the refresh path was never the race — it was that retiring
the refresh hash and inserting its successor were two statements with a
pod-death window between them. Killed in that window, the grant ends with its
hash nulled and no successor row: the credential destroyed, the client facing a
re-authorization it did nothing to deserve, and nothing anywhere to say why.
Rotation and mint are now one transaction; at every instant exactly one of
{predecessor, successor} is redeemable.

What was deliberately _not_ added: `FOR UPDATE`, or any lock beyond what the
statements already take. The guarded update — `WHERE id AND refresh_token_hash =
<presented>` — is itself the serialisation point: the loser of a concurrent
refresh blocks on the winner's row lock, re-evaluates against the committed row,
matches nothing, and is refused deterministically. A row lock taken separately
from the statement that does the work would have been the codebase's first, for
a guarantee the working statement already provides.

Refusing the loser remains safe for the reason §24 records: rotation leaves the
access token alone, so a client that fires two refreshes at once still holds a
working access token and the winner's new pair. That property is now asserted
_and_ structural — the transaction cannot touch the access token because
nothing in it writes that column.

## 28. The outbox, and the worker that is optional

§8 recorded a boast — "no worker, no timer, and nothing extra to keep alive on
a single replica" — and it was the right boast for coalescing, which the
database folds without any process's help. But it quietly extended to work the
database cannot do alone: fetching a link preview, handing a payload to a push
service, asking Resend to send. Those were unowned promises —
`void (async () => …)()` — and an unowned promise dies with its pod. A blip
captured near a deploy stayed preview-less forever, because previews are
fetched once and never refreshed. A share email evaporated with nobody told. A
deleted radar's objects sat in MinIO unreachable and uncounted, with no sweep
to ever find them. One replica with occasional deploys made this rare;
SCALE.md's replicas with an HPA would have made it routine, on every
scale-down.

### A row before an attempt

The fix is the arbiter this codebase already trusts: work becomes an `outbox`
row before anything tries to do it. Claiming is one statement —
`FOR UPDATE SKIP LOCKED` inside an `UPDATE` that pushes `run_after` forward by
a lease and bumps `attempts` — so a claim holds its lock for exactly one
statement's duration and pins nothing while a handler waits on a slow remote.
A claimed row is not marked, flagged, or moved; it is merely _not due_ for the
lease's length. Success deletes it. Failure reschedules it with backoff and
keeps the error. A claimer that dies does nothing at all, which is the entire
design: the row resurfaces by itself when the lease lapses.

What was considered and declined: a broker (a second stateful system bought to
solve what one indexed table solves at this scale — the same reasoning that
hand-rolled Web Push), `LISTEN/NOTIFY` (a wake-up optimisation that adds a
connection-lifetime concern before there is a latency problem to solve), and
holding the claim lock across the handler (simpler, and exactly how a rate
limit becomes a pool-starver — §27 already buried that shape).

### The lease's one honest cost

A handler that outlives its lease can run twice, so every handler must
tolerate a duplicate, and each one documents why it does: an unfurl re-fetches
the same URL into the same column; object cleanup deletes already-deleted
keys; a notification delivery **re-reads its row and skips any transport
already stamped**, so the duplicate a lease overrun permits is a re-attempt of
an unstamped transport. This is at-least-once external delivery: a crash after
provider acceptance but before the database stamp can send again. Push stamps
are per notification transport, not per device, so a partially successful
multi-device attempt can resend to a device that already accepted it; the OS
notification tag coalesces those repeats. The delivery job carries only
the notification id — state is read at delivery time, not enqueue time — which
also means a member removed before delivery has their pending email and push
silently cancelled, exactly what removing them means. `emailed_at` and
`pushed_at` keep meaning _delivered_; the outbox retries toward the stamp, and
never writes one.

The attempt ceiling is enforced in two places because a claim counts the
attempt before the handler starts. `fail` dead-letters a job that failed its
eighth time; `run` dead-letters, unrun, a job claimed past the ceiling — one
whose handler never returned at all, because it outlived every lease or took
the process down with it. Without the second check such a job resurfaced
forever and crash-looped the worker on each claim. A dead letter is not
deleted (this used to say it was): it is parked at `run_after = 9999-12-31`
with its reason in `last_error`, never due, never claimed and never counted as
backlog, and the worker's upkeep deletes it 30 days after it was created. The
same upkeep dead-letters any job whose kind no process has had a handler for
in 24 hours — a rolled-back release, a removed feature — which is what stops
such rows pausing feed polling: the backlog check counts only runnable kinds.

Shutdown claims nothing new. The job in hand finishes inside
`SHUTDOWN_TIMEOUT_MS`; the rest of its batch is handed back at once (due now,
the attempt uncounted) instead of hiding behind a five-minute lease, and a feed
poll ends its capture batch and releases its lease as a continuation. Durable `email` jobs also send
`Idempotency-Key: outbox-email/<job id>` to Resend: their payload is the
rendered message, identical on every attempt, so a re-run after acceptance is
answered from Resend's record instead of arriving twice.

### Two drains, so the worker is a guarantee and not a dependency

Every job enqueued on the request path gets one immediate, best-effort kick
from the web process itself. That is not an optimisation detail; it is what
keeps "no worker deployed" a supported state, like storage and mail and push
being absent are. A single-pod deployment behaves exactly as the app always
has — same latency, nothing new to keep alive. The worker deployment — the
same image with `dist/worker.js` as its command, per SCALE.md's
split-by-runtime-shape — is the guarantee layered on top: it drains whatever
the kick lost, which is precisely the work a dying pod used to lose silently.
`SKIP LOCKED` makes the two drains safe together, and neither knows the other
exists.

The boot sweeps gained a home in the worker's loop while the door was open —
a sweep on a schedule is what a worker's loop is _for_, where at N web
replicas the boot-time version runs N times per rollout. The boot-time sweep
stays, deliberately: it is idempotent, it is what a deployment without a
worker relies on, and removing it would make the worker a dependency, which
is the one thing this section promises it is not.

## 29. September code review: enforce the promises at the write

An upload ticket now signs Content-Type as well as Content-Length, and attaching
an object validates the actual HEAD metadata again. The presigner previously
excluded Content-Type, so merely putting it on the PUT command was not an
integrity check. Public-only archive filtering likewise lives in the shared
stream service; public comments and attachment reads reject archived parents.

Session/device management and profile changes require a human actor, including
a pending account managing its own sign-in. A read-only agent token cannot
rename its human or revoke the human's sessions. Verification claims one of five
attempts in the database before comparing the code. Issuance still charges its
rate limit in the short atomic statement described in §27; only admitted
requests enter a brief transaction locking that address's existing limit row to
retire the old code and insert the replacement. No email is sent under that lock.

Blip moves now lock the current blip, recheck its current radar access, and commit
all denormalized dependent rows with the blip and supersession changes. A failed
write leaves the whole conversation in its original radar. Compound radar/topic
and dashboard/layout updates validate before mutation and save their metadata
together. A stale preview job updates only while the blip still names its URL.

Cleanup failures and notification transport failures now reach the outbox rather
than being logged as success. S3's per-object error array counts as failure even
when its HTTP response succeeds. Email and push are attempted independently;
a successful transport stamp survives retry of the failed one. Durable enqueue
happens inside the corresponding database transaction, and delivery kicks happen
after commit. Agent audit records now include the persona ID as well as the
human ID; the schema had held that column while the writer omitted it.

### Durable fanout starts at the source

A notification delivery job protects only work that has already reached the
notification table. The September review also closed the earlier gap: blip,
comment, reaction, sharing and cascade mutations insert a `notification-event`
job in their own transaction. Mentions are reconciled there too, so a crash
cannot remember that somebody was mentioned while forgetting the notification.
Share emails are enqueued with the membership or invitation they announce.
The source event is drained after commit, retaining the existing immediate
in-app visibility without holding a database transaction during delivery.

The event contains identifiers and the newly addressed targets, not a credential
or a cached body. Its handler reloads current identities, content and membership;
a deleted or moved source and a revoked recipient cancel stale work. The fanout
transaction writes both notification rows and their delivery jobs, plus a
completion marker on the source event. If a process dies before deleting that
event, its replay sees the marker and cannot increment coalesced counts twice.
Deleting the outbox event also removes the marker, so no permanent receipt
history is needed.

Transactions pass their database handle through authorization and mention
resolution. Opening a second pooled connection while holding the first would
starve the ten-connection pool under ten concurrent captures; the regression
suite runs twelve captures and twelve edits together to exercise that boundary.
External requests, delivery and post-commit hydration remain outside source
transactions. Editing words transfers both human and agent attribution together;
triage, pinning and movement retain the original pair.

## 30. A web release includes the assets its documents can name

The API/client split made images independent, but it did not make a document
independent of its JavaScript. A public `/r/:slug` document is rendered by the
API image and names assets served by nginx. The ordinary root document can also
come from a new UI pod while its next asset request reaches an old one. A release
that deploys both correct images and still returns a missing script is broken.
Long cache lifetimes do not repair this: a first-time visitor has no cached copy.

A release therefore has one serialized lifecycle, held by the parent GitLab
resource group while its child pipeline prepares, builds, rolls, and verifies.
The child never takes the parent's lock. It refuses an obsolete main revision,
resolves the actual running predecessor by image digest, and deploys the digests
Kaniko reports, rather than asking a mutable tag what it means later. Locking
only the deploy job was declined: two image builds can change `latest` before
that job begins. A missing predecessor is a refusal, not permission to forget
assets; a new installation must supply a seeded UI digest explicitly.

The first UI rollout keeps the preceding document and service worker while
adding the new assets. Once every UI pod has that union, the second rollout may
publish the new document. Only then do API and worker roll. Both mixtures are
safe: during the first, every document is old; during the second, every pod can
answer both generations. A single UI-first rollout was declined because its new
document can still reach an old pod for its script. A shared object store could
also provide this property, but would add a delivery dependency where the images
already carry a small set of immutable files.

The image retains thirty days of assets plus the complete immediate predecessor,
even after a long interval between releases. `build.json` records the document's
commit, its current asset set, and retention ages. A transition image preserves
the old current-asset set and records the staged commit separately, so a killed
release can be resumed without pretending its document had changed. This is a
bounded compatibility window, not offline application storage; no private API
payload is cached. Smoke fetches both root and public shells and their assets,
including every lazy chunk, and proves both API and UI identities.

Fleet still owns workload configuration. CI owns only the three image fields.
The Fleet comparison excludes precisely those fields, while the Helm helper
looks up and preserves their live values on unrelated upgrades. Comparison
suppression alone was declined because hiding a difference does not stop a
later Helm upgrade from changing it. Initial installs use bootstrap values;
`ciManagedImages=false` is the explicit operator choice to reset that ownership.
The installed Fleet renderer supports lookup, and a server-side render is part
of verification. Browser policy is also a property of whichever server returns
the document: nginx carries the same ordinary SPA security headers as Hono,
while the API's public document keeps its tighter existing policy.

## 31. Email capture is an authenticated source (19 September 2026)

The earlier §6.2 prohibition on Drop Box integrations is narrowed by the explicit
product decision to receive email there. A person's permanent username names their
Drop Box; a persisted readable radar alias names another owned radar. Neither a
shared editor nor an agent configures that destination. Approved senders are exact
individual addresses, with the owner's current account address always included.
An allow-all mode was declined because possession of a guessable mailbox name is
not permission to write into a personal radar.

Cloudflare Email Routing and a small email-only Worker relay receive mail;
Resend continues to send it. The owner chose existing Kubernetes capacity over a
Workers Paid subscription. The edge therefore streams bounded raw MIME to a
fixed HTTPS endpoint instead of parsing, hashing the full body, or verifying
signatures under the Workers Free CPU allowance. Kubernetes owns DKIM verification,
MIME parsing and R2 writes. This keeps the relay small and removes its storage
binding and MIME/cryptography dependencies.

Cloudflare accepting a message does not prove its From author: SPF can authenticate
an unrelated envelope, and DMARC policy can allow failures. Parsing an
Authentication-Results header was therefore declined. The server independently
verifies the original raw message's DKIM signature with mailauth, requires exact
From-domain alignment and signed interpretation headers, and rejects partial-body
signatures. This is deliberately narrower than accepting all forwarding
arrangements. People can forward a message as a new message from their approved
address. Native Node runs the maintained verifier without the former workerd
compatibility patch.

A timestamped HMAC binds the recipient, size and nonce to the relay request;
TLS protects the streamed body. The nonce is remembered for the five-minute
window, so one signed header set is accepted once. That memory is in-process
(the API is one replica); unlike the receipt, it is not what makes a retry one
capture — a miss only lets a replayed request reach DKIM, sender approval and
the receipt, which all still hold — so the in-memory cache declined below for
deduplication is acceptable here. SCALE.md §3.4 moves it to Postgres before a
second API replica.

A message is refused for more than 12 attached files or more than 100 MIME
parts. Images its HTML shows by `cid:` are counted apart, up to 48 and 6 MiB,
and any past that budget are left out rather than refusing the message: one
shared ceiling of twelve used to bounce every image-heavy newsletter
(`email-limits.ts`). Sender authorization comes only after independent
DKIM verification on Kubernetes, never from relay-supplied sender claims.
Authentication and admission limits precede body buffering. The API resolves live
ownership and exact sender permission before allowing file storage.
Finalization uses the ordinary createBlip transaction seam. A receipt claim in that
transaction makes SMTP retries one capture, while live authorization is checked
again after attachment metadata checks. An in-memory duplicate cache and a
check-then-insert receipt were declined because neither survives concurrent workers
or a process dying between the marker and the blip. Source state, rate windows,
receipts and their bounded retention live in Postgres; R2 cleanup intent lives in
the existing outbox. The global enable flag gates actual ingestion as well as the
UI, so an incompletely configured domain never presents a working capture address.

## 32. Original emails belong to blips, not delivery receipts

An email is a document with immutable source content, not a mutable markdown note.
Flattening formatted messages into the ordinary card made newsletters hard to read
and discarded the information required to recover their presentation. New captures
therefore retain full text, a safe formatted representation and original MIME in
private R2 storage. A small blip-owned row supplies list summaries without storage
reads; a permission-checked reader fetches the heavy payload only on demand.

The original extracted body remains search/MCP text. Separate email notes are
editable and join the generated search vector. Replacing the body is refused at
the shared service boundary. Moving a blip changes authorization, never ownership
of the original document. Public sharing publishes its content but omits sender
address metadata and raw headers. Only exact-blip raster CID images are resolved;
remote images require explicit consent. Author style blocks and active markup are
removed rather than preserving newsletter fidelity at the cost of executable or
tracking content. HTML is additionally isolated by the client sandbox/CSP.

Receipt expiry cannot delete a live original: finalization atomically moves key
ownership into `blip_emails` while clearing the receipt payload. Deletes and failed
captures queue exact keys through the existing durable cleanup path. Earlier
captures only gain a plain-text email identity where surviving receipts prove
provenance; missing originals are never invented.

## 33. Dropdowns share one interaction and visual language

Fixed-choice fields use `Select` from `components/select.tsx`. Its options have a
value, label and optional disabled state; consumers receive the selected string
through `onValueChange`. Empty strings remain valid choices for fields such as
“No topic”. Searchable entity pickers retain their dedicated search interaction.

The shared control owns the trigger, menu, selection indicator, keyboard behavior
and theme styling. Menus must fit the viewport and work within dialogs without
escaping their focus boundary or dismissing the dialog when Escape closes a menu.
Use the field's visible label or an accessible label, and keep option labels short.
ESLint rejects native JSX select elements in the UI so new screens cannot silently
reintroduce platform-specific dropdowns. Changes to the shared control must be
checked on desktop and mobile, with keyboard input and inside a dialog.

The authenticated application shell fills the viewport. Content and sidebar
navigation scroll independently; sidebar controls and mobile navigation remain
visible. Public pages retain normal document scrolling.

## Query dashboard widgets and concurrent layout editing

See [Query dashboards and safe layout editing](DASHBOARD-QUERIES.md) for the
current contract and examples. Count tiles, grouped lists, lane bars and UTC
capture charts use database aggregates over the same authorized search
predicate. Presentation does not copy data or count only loaded rows. Empty
widgets remain recoverable through management controls; errors never disappear
as if they were successful empty results. Direct completion and Drop box filing
reuse blip mutation services, with keyboard/mobile alternatives to dragging.

Dashboard revisions and atomic append/operation batches prevent a stale agent
or browser from silently deleting panels. A whole-layout replacement must name
the revision it read; conflicts require reloading and reviewing the newer layout.

### Neutral shell and flat accents (September 2026)

The default web shell uses true black with neutral charcoal raised surfaces in
dark mode, and neutral white/grey surfaces in light mode. Borders and secondary
text use the same neutral family. Radar accent fills and picker swatches are solid;
share cards use one flat accent tint. Accent text mixes 80% of its hue toward the
foreground in dark mode, and 35% in light mode, keeping all 26 accents readable.
Custom radar surfaces keep the contrast-safe 35% mix against their own foreground;
their intentional textures are independent of accent fills. Existing accent keys
remain stable for saved radars, native clients and MCP. New controls must consume
these shared tokens rather than add blue surfaces or gradient accent fills.

## 34. The other direction, and why it is not the notification pipeline

On My Radar could be written to but could not tell anybody that something had
changed. `POST /hooks/:id/:token` is ingress — a URL things POST _to_. The
mirror image is now `radar_subscriptions`: a receiver a radar manager registers,
which gets a signed POST when a blip is created, changed or deleted, or a
comment is posted. `docs/OUTBOUND-WEBHOOKS.md` is the receiver contract. This
section is why it has the shape it has.

**Per radar, not per account.** A subscription belongs to one radar and carries
one secret. The account-wide version with a radar filter is one credential whose
leak exposes everything the creator can read, and it makes "which radars does
this thing see" a question you answer by reading a filter rather than by looking
at the radar. Twenty per radar is the ceiling, taken inside the transaction that
creates one.

**Egress is a different word.** The settings pane says _Inbound webhooks_ and
_Outbound webhooks_, as peers, in the same `Section` treatment. "Webhook" was
already spent on ingress, and a pane where one of them is a heading and the
other a label is a pane where somebody registers the wrong direction.

**Events are written by the write, not derived from notifications.** The obvious
place to hang a dispatcher is the notification pipeline, which already knows
that something happened. It is the wrong place twice over. Notifications are
_recipient_-shaped — re-derived from live membership, coalesced by a partial
unique index, deleted when a member leaves — and an integration is not a
recipient: it must see the event that happened, once per event, whether or not
any human would have been told. And a notification is raised beside the write,
so an event could survive a transaction that rolled back. `enqueueSubscriptionEvent`
takes the caller's `tx` and inserts inside it. An event that exists is an event
whose content change committed; there is no other ordering.

**Its own queue, not the outbox.** §28's outbox is a general lease queue and
this could have been a kind in it. It is not, for three reasons that are all
schema: a delivery cascades from its subscription (deleting one must take its
pending work with it, which a generic `payload` column cannot express), the
retry schedule is six specific attempts over 5h36m rather than the outbox's
policy, and the attempt history is a thing the _creator reads_ — a support
surface, not an internal queue. The mechanism is still §28's: `FOR UPDATE SKIP
LOCKED`, a lease pushed forward by the claim, no network inside a transaction.

**Authorization is re-decided at every attempt, and it is `write`.** The
subscription acts as its creator, exactly like an inbound webhook, through the
ordinary `requireRadar` — so revocation, suspension and radar deletion already
do the right thing with no second code path. Capturing the decision at enqueue
time was rejected: an event can sit in the queue for hours across six attempts,
and the whole point of a single access path is that it is asked _now_. `write`
rather than `read` because a subscription is a standing export of a radar's
contents, and the fence for that is the one we already draw around people who
can change it.

**Secrets are encrypted, not hashed.** Inbound tokens are hashed because the
server only ever _compares_ them. An outbound secret has to be recovered to sign
with, so it is AES-256-GCM at rest under a key HKDF-derived from `SESSION_SECRET`
with its own context string. That is a real difference in posture and it is
worth naming: losing the session secret loses the outbound secrets, which is why
rotation exists and why the doc says to back it up separately.

**Creating, pausing, rotating and testing are human-only** under
`assertHumanDecision`; reading and deleting are not. A secret is a credential
(§22), and an agent that can mint one can export a radar. An agent that can
_delete_ one can only stop an export, which is the safe direction.

**The drop box changes rule §6.2, narrowly.** It still refuses an ingest URL —
the reason there was never about webhooks, it was about what may write into a
private inbox. It has blips, so it can report them. The Webhooks tab is
therefore present on the drop box with only the outbound half. The rule is now
"the drop box accepts nothing and may report", not "the drop box has no
webhooks".

**The body is never truncated, and that is the decision.** A payload carries the
blip's whole body, and `changes` carries the previous value of every field that
moved — so an edit to a 100 KB body is a ~300 KB payload, once per subscribed
receiver, held as `jsonb` until it is delivered. A size ceiling was considered
and rejected (2026-09-20, user decision): a blip captured from a forwarded email
keeps the message's readable text in `body`, and a receiver holding a truncated
copy is a receiver holding a record that is quietly wrong — worse than a large
payload, and undetectable from the receiving end. The cost is real and belongs
in the scaling conversation, not in the payload.

## 35. The Agent Repo (2026-09-26)

An agent's system prompt and memory, held here and checked out on any device, in
any directory, by any MCP harness. `docs/AGENT_REPO.md` is the long version;
the decisions that constrain later work:

- ~~**A repo agent is not a persona.**~~ **Reversed in v2 (0038): an agent is
  the identity.** Personas were folded into `agents` with ids preserved. Identity
  on a write comes from a server-issued binding only — a load `session` passed
  on the call, or a credential bound to an agent the person owns — never from an
  argument naming an agent; every agent-borne write records the person who ran
  it as cosigner.
- **Memories are not blips.** Capture inference would unfurl agent-written URLs
  and fan `@mentions` out to people, and every cross-radar surface would need an
  exclusion. A memory write has no fanout at all, and a test says so.
- **The checkout file is a pointer and the trust anchor.** A prompt that arrives
  as a tool result is tool output to the model; the person's own instruction
  file is what authorises adopting it. Only server text, the slug and the id
  are ever rendered into it.
- **Memory writes happen inside a load session bound to the connection** — the
  PAT id or the OAuth client id, never the access-token row, which rotates.
  Not a security boundary; it enforces order, aim and provenance.
- **Only the prompt is instruction-grade.** v1 made agent edits proposals; **v2
  made them live** (the owner's decision), bounded instead by an optional
  owner-set lock, 20 agent versions a day, full history with restore, and a
  note in Activity. A shared agent's recipient runs the version they accepted
  until they choose otherwise, so an owner's agent editing its own prompt never
  reaches someone else's machine unasked. Pinning and restoring memories stay a
  person's acts; review was removed.
- **Sharing has two axes** — prompt (view/edit) and memory (none/view/edit) —
  per person or per topic, computed at read time like the topic cascade. A
  non-owner's checkout never carries a value that widens what a tool may do.
- **Scopes reuse the radar ceiling.** A second scope family would have made the
  ceiling a partial order; the consent copy says what the grant now reaches.
- **OAuth grants can be revoked** (§22's known limitation, closed).
- **Briefs are the third layer** (0039, 2026-10-01): the facts about the product
  an agent works on, with On My Radar as the source of truth and any repository
  copy a one-way mirror. Access is the prompt's, so a pinned recipient runs each
  brief as it stood at acceptance; `load_agent` carries only the index. Another
  agent's brief is read by naming that agent — authorization is the person's,
  so no attachment table. `docs/AGENT_REPO.md` §V2.15. Slice 2a (0040) added
  the Briefs tab, history, rename and an owner-only, in-person delete; a rename
  and a delete are events in `agent_brief_events` rather than revisions, so
  Activity can tell them without a read path into `audit_log` (§V2.16).
  Slice 2b (0041) binds a brief to a path in a GitLab project: the worker
  records how far that path has moved since the brief's revision (the `stale`
  field, a count for an older revision shown as "not checked", never as
  current), and an optional one-way mirror opens merge requests — never a push
  — behind a server flag that is off. An edit made in the repository is drift,
  reported and never imported. Binding is human-only, owner-only, and only for
  an administrator's agent, because the tokens are the operator's (§V2.17).

## 36. The helpdesk template: a client side, and never public (2026-10-02)

`docs/HELPDESK.md` is the design. Slice 1 adds the `helpdesk` template and
the one rule that has to hold before anything reaches a client.

- **`clientFacing` is a registry flag, not a template id.** It means "this
  radar's content is meant to reach somebody outside, through a narrowed
  projection". Everything below reads the flag.
- **Never public, on every path.** A helpdesk's comments include internal
  notes about a client. `setVisibility` refuses to publish one, `updateRadar`
  refuses to switch a public radar onto the template (the path `setVisibility`
  cannot see), `getRadarAccess` never honours a public link on one, the public
  route refuses to serve one, and CHECK `radars_helpdesk_is_never_public`
  (0042) stands behind all four. The constraint names the id literally because
  SQL cannot read the registry, and a test asserts one exists per
  client-facing template.
- **…and once a helpdesk, never public (0044).** `radars.was_client_facing`
  is set by a BEFORE trigger whenever the template is client-facing and never
  cleared; CHECK `radars_once_client_facing_never_public` refuses a public row
  with it. Every public-side refusal reads `neverPublic()` in `access.ts`, so
  switching the template off does not publish the notes. The one trigger in
  the schema, chosen because three paths write `template` and a flag the
  service had to remember on each would be a promise a later path forgets.
- **Not owner-only.** An earlier draft computed helpdesks as owner-only, and
  Lucas corrected it: internal collaborators may be shared one and see its
  internal notes like any member, and the share dialog says so before the
  click. What must never happen is a _client_ holding a share, and On My Radar
  cannot tell a client from a collaborator by address, so that line is the
  sharer's (`docs/HELPDESK.md` §6.1, decision 5). Nothing in slice 1 changes
  an existing grant.
- **A client reads a fixed status, never a lane label.** Every lane on a
  client-facing template names one of six `clientStatus` values whose words
  live in `packages/contract/src/helpdesk.ts`. `validateLanes` requires the
  field there and refuses it elsewhere. A stored custom lane set without it
  cannot ride a template switch: the refusal names `templateConfig.lanes: null`
  as the one-call fix.
- **`template:` joined the search grammar**, and `?template=` the radar
  listing on both transports, so a cross-project view finds every helpdesk
  without a hand-kept list. Both narrow `readableRadarIds` and can never widen
  it.

### 36.1 Comment visibility (slice 2)

A comment on a helpdesk is `internal` (the default, on every path and every
radar), `client_pending` or `client` (`docs/HELPDESK.md` §7).

- **Asking is explicit; the outcome is the writer's.** `visibility: 'client'`
  is accepted only on a client-facing standard radar and needs edit access.
  The radar's owner, in a browser session, publishes at once (typing it is
  the review). Everyone else — their agents included, even writing as them, a
  collaborator, a co-owner — lands `client_pending`. `client_pending` cannot be
  requested. Decision 3.
- **Release is human, owner-only and bound to the text.** `releaseComment`
  (`POST /api/comments/:id/release {bodySha256}`) runs `assertHumanDecision`,
  requires `radar.owner_id`, locks the blip then the row (the order
  `updateComment` takes), and refuses with 409 unless the stored body hashes
  to what the reviewer was shown (`CommentDto.bodySha256`). There is
  deliberately no MCP tool for it; the route is listed as human-only in
  `capabilities.ts`.
- **The database holds a released body to its hash.** CHECK
  `blip_comments_released_body_unchanged` compares
  `encode(sha256(convert_to(body,'UTF8')),'hex')` with `released_body_sha256`,
  so no path, psql included, can edit a released reply. The other CHECKs make
  `client` mean "released or (slice 3) external author" and nothing else. None
  keys on a foreign-key column (§7.1's cascade trap); `released_by` is
  DEFERRABLE like every authorship FK.
- **Immutable once released; never note-to-reply.** `updateComment` re-reads
  the row under the blip lock and refuses a released reply. A pending draft
  may be edited by its author, which voids a review in progress. An internal
  note is never released, and an update cannot touch visibility.
- **Discard is deletion.** An agent may delete its own draft and an owner may
  moderate, the safe direction, like unenrolling. Only publishing needs a
  person. (`docs/HELPDESK.md` §7.2 said discard was human-only; corrected.)
- **A blip carrying a non-internal comment cannot be moved.** Another
  client's helpdesk, or an ordinary radar shared with other people, would
  receive a client conversation. A blip with only internal notes may leave a
  (former) helpdesk only for a never-public radar whose readers and pending
  invitees can all read the source (`assertNotesStayInside`).
- **Deleting a released reply keeps its record**: text, approved hash and
  release go into the audit log in the delete's transaction, fail-closed.
- **Members see everything, labelled.** Visibility is about who sees a comment
  outside On My Radar. Collaborators read notes, drafts and replies;
  `list_comments` states `visibility` whenever it is not `internal`.
- **`reply_pending`** notifies the radar's owner only, folded per radar, and
  bypasses the self-filter (an agent-borne draft counts as the owner's own act
  everywhere else, which would hide it from the one person who can release
  it). A muted radar stays muted.
- **Decision requests (D1)** are universal like comments (`request_decision`, gated by
  `requireParticipation(…,'comments')`; comments off refuses new ones and hides open ones, never
  deletes them). What an answer does is declared by `RadarTemplateDef.decides`: on the decisions
  and architecture templates the options are the outcome lanes and the answer moves the card
  through `updateBlip`; elsewhere it is free text. Answering is REST-only, the addressee's own act
  (`assertHumanDecision`), claimed with `UPDATE … WHERE status='open'` in the move's transaction.
  A request reads _overtaken_ (computed, `decision-live.ts`) once the card moved lane or radar or
  the template changed, and every read is fenced to the blip's current radar. The activity list
  splits into **Needs you** (open requests, mentions by a person) and **Agents reported**;
  the badge counts only the first (`box` on `list_notifications` and `/counts`).
- **`comment.created` carries `visibility`** to the owner's own subscriptions;
  bodies are still sent, and a later release is not re-sent.

### 36.2 The integration credential and the client projection (slice 3)

The W&W portal reaches a helpdesk through its own credential family, `omr_int_`
(`docs/HELPDESK.md` §3, §5; migration 0045).

- **Somebody only on `/api/v1/helpdesk`.** `attachActor` resolves an
  integration token under that prefix (segment-exact, versioned only) and
  nowhere else, `/mcp` included: there it is anonymous, not an actor with a
  small ceiling. Behind that, `getRadarAccess` (so `requireRadar`),
  `requireScope`, `requireActor`, `liveActor` and the `/mcp` route each refuse
  `kind: 'integration'`. A service written later refuses the portal by default.
- **One door, an intersection.** `requireHelpdeskRadar` takes the owner's own
  access clamped to `editor`, then requires a live enrolment, an unrevoked
  integration, the actor being its owner, the radar still theirs, a
  client-facing standard private radar, and write access. Every miss is a 404.
  Its result is branded proof that `createBlip` accepts (`helpdesk` option)
  instead of authorizing again.
- **Scope is enrolment, made by a person; exposure only shrinks.** Minting,
  rotating, revoking and enrolling are `assertHumanDecision`; listing and
  unenrolling are open to agents (REST and MCP). A trigger revokes every live
  enrolment when a radar leaves the template or changes owner, whichever path
  wrote it; a revoked enrolment or integration is never revived (triggers), and
  an integration is never deleted except by an account cascade (a BEFORE DELETE
  trigger refusing at `pg_trigger_depth() < 2`).
- **Expiry and overlap are CHECKs**, written against `created_at` /
  `rotated_at` because a CHECK cannot read `now()`: 90 days from mint or
  rotation (decision 6), the previous hash at most 24 h after rotation. Each
  hash keeps its own last-used time.
- **Isolation is the client account.** Every `/requests` call carries
  `X-OMR-Requester-Scope`; another account's request is the same 404 as a
  missing one; the requester's account is fixed by trigger; a request never
  moves and its title and body are frozen like an email's.
- **The projection is a whitelist** (`services/helpdesk.ts`): the request, its
  `clientStatus` from the closed map, and `client` comments only, staff replies
  signed with the integration's display name and timed by their release. The
  ball-in-court clock and last reply are computed from the thread
  (`helpdesk-projection.ts`), for the portal and for the card alike.
- **"Arrived from outside" is one predicate.** `isExternalDelivery(actor)` is
  true for webhooks and integrations and is the only test of the actor's kind in
  `notifications.ts` (a test counts), so a new request and a client's reply
  reach the owner at the default level. The audit log records
  `actor_kind = 'integration'`.
- **Client text is marked.** `BlipDto.external` and `CommentDto.external`
  name the requester; MCP renders those bodies inside a labelled fence a client
  cannot close early. A client's words never resolve an `@handle`.

## 37. Billing was removed (2026-11-11)

On My Radar is open source and has no billing, plans, quotas or Stripe code. The tables
and triggers from the applied billing migrations remain, because migrations are
forward-only; nothing reads or writes them, and the account export lists them as
excluded. The only counts left are the 100-agent ceiling (`AGENT_REPO.agentsPerOwner`)
and the per-file and per-device limits. Every count-increasing write still takes the
owner lock (`services/owner-lock.ts`, advisory key `quota-owner:<id>`, kept so old and
new pods serialize during a rollout). Bootstrap writes the whole welcome workspace
atomically, so concurrent first sign-ins make exactly one. See
[ADR-0013](architecture/adr/0013-billing-behind-flags.md) for what it replaced.

## Private account export

The human-session-only account export mounts at `/api/account/export` and the
versioned API equivalent. It uses a bounded read-only snapshot and explicit
table/column classifications. Settings assembles and streams the archive through
the uncached worker; file bytes go directly from storage using conditional GETs.
See
[ACCOUNT-DATA-RIGHTS.md](ACCOUNT-DATA-RIGHTS.md) for boundaries and remaining gates.

## Account access closure is a lifecycle fence

Migration0057 adds a permanent `account_closure_requests` fence, not another
users.state value and not a raw account cascade. Shared access/authentication and
SQL writer guards consult `omr_account_open(uuid)`. The customer-facing closure
request flow was removed on 2026-10-06 (it was never enabled); the fence and
tables remain, so closing an account today is an operator insert.

# Agent personas

> **Superseded by Agent Repo v2 (migration 0038).** Personas became agents: the
> `agents` table was folded into the Agent Repo with every id preserved, so what
> a persona wrote still names it. Everything below about voices, the grep-proven
> write sites, mentions and the agent queue still holds; what changed — agents
> as identities, load sessions, cosigners, sharing — is `docs/AGENT_REPO.md`
> §V2.5.

How an AI gets an identity of its own in On My Radar, and why that identity can
never act except on behalf of a human.

This is the record of what shipped, not a proposal. The decision it implements is
Lucas's, on blip `fdba2349` of radar `58c5f415`:

> "There will be times AI needs to have its own persona and other times it'll
> need to be acting on my behalf."

Both exist, both are selectable, and the database remembers both every time.

---

## 1. The one idea everything else falls out of

**The voice decides what is _rendered_. It never decides what is _recorded_.**

An agent can never act except on behalf of a human, so every agent-borne write
already has a human behind it. The agent is therefore an _additional_ author, not
an alternative one: `author_id` and `agent_id` are both written on every write, in
both voices, with no mode that suppresses either.

| voice       | `author_id` | `agent_id` | renders as             |
| ----------- | ----------- | ---------- | ---------------------- |
| `persona`   | the human   | the agent  | **Claude** · via Lucas |
| `principal` | the human   | the agent  | **Lucas** · via Claude |

Note what is identical between those rows. That is the point.

The alternative — the voice choosing which column to write — was rejected because
it turns the voice grant into a _provenance control_, and a provenance control has
an unrecoverable failure mode. A mis-granted token would produce a row
indistinguishable from one the human typed, with nothing anywhere able to tell
them apart afterwards. As built, the worst a mis-grant can do is put the wrong
name in the larger type over a record that is still true, still carries the agent,
and is still in the audit log. Wave's failure was not that words appeared under
the wrong name; it was that the result could not be reconstructed.

Four consequences worth stating, because each one is a thing that did not have to
be built:

- **`author_id` is never null-because-an-agent-wrote-it.** Every query joining
  `users` on it keeps working: `canDelete`, the comment edit rule, the
  notification audience, the "already in this thread" set.
- **Agent→human impersonation is unrepresentable rather than forbidden.** There
  is no column to forge.
- **There is no polymorphic author.** No `CHECK (num_nonnulls(…) = 1)` over
  authorship, no "principal id" abstraction over two tables.
- **The open product question stays reversible.** Whether an agent acting on
  somebody's behalf is _named_ to other people is one line in `bylineFor`, not a
  decision about what the database may remember. §9.

---

## 2. Where the principal lives

**A separate `agents` table. Not a `users.kind` discriminator.**

```sql
CREATE TABLE agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle      text NOT NULL,          -- unique per owner, never globally
  name        text NOT NULL,
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

Every absence is as deliberate as every presence:

- **No `email`.** With no address there is nothing for `findUserByEmail` to
  answer, nothing `radar_invites` can be addressed to, and nothing `shareRadar`'s
  deliberate invited/added distinction can be made to speak about. An agent is
  unreachable by address _by construction_.
- **No `state`.** No waitlist, no approval, no suspension of its own. Its
  liveness is derived: it acts only through a live token held by a live owner.
  `accessPolicyFor`, `activateUser` and the admin waitlist are out of scope for
  it permanently rather than by predicate.
- **No `is_admin`.** The bit cannot be held.
- **`owner_id NOT NULL … CASCADE`.** One human, always. §8.1.
- **`handle` unique per owner.** A global namespace would be a cross-tenant
  namespace and therefore a probe for which handles are taken, for no benefit.
- **`retired_at` rather than a delete.** The row stays, so everything it wrote
  still says who wrote it. What stops is the future.

The alternative was audited and rejected: a bot row in `users` needs a synthetic
address under a real unique index, inherits a state nothing can ever activate, and
would require a `kind = 'user'` predicate in around thirty lookups where _an
incomplete list is the bug_. The separate table makes every one of those correct
by doing nothing.

---

## 3. Authorship, and the two things a real Postgres taught us

```sql
ALTER TABLE blips
  ADD COLUMN agent_id uuid REFERENCES agents(id)
                           ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN agent_voice text;
ALTER TABLE blips ADD CONSTRAINT blips_agent_voice_valid
  CHECK (agent_voice IS NULL OR agent_voice IN ('persona','principal'));
```

…and the same pair on `blip_comments`.

**The CHECK is one-directional.** The obvious constraint is bidirectional — a
voice implies an agent and an agent implies a voice — and it is wrong.
`ON DELETE SET NULL` nulls `agent_id` and leaves `agent_voice` behind, because a
referential action can only touch the referencing columns. A bidirectional CHECK
therefore aborts the DELETE the moment a persona goes away. A row with a voice and
no agent is not corrupt, it is informative: _an agent wrote this and its principal
is gone_ — the same sentence `author_id` already tells about a deleted person.
`persona.test.ts` asserts the service half instead: every write path sets both or
neither.

**The FK has to be DEFERRABLE, and that is the finding worth carrying.**
`blips.author_id` and `blips.agent_id` are both `ON DELETE SET NULL`, and on an
agent-borne row _both point at the same human_ — `author_id` is always the agent's
owner. So deleting that person runs two referential actions plus a CASCADE against
one tuple, and a non-deferrable check lands on a tuple version naming an agent
Postgres has already removed:

```
ERROR: insert or update on table "blips" violates foreign key constraint
       "blips_agent_id_fkey"
```

The whole DELETE aborts. Three things about it are worth knowing:

- **The obvious test passes.** A blip whose author is somebody _else_ and whose
  agent belongs to the deleted person deletes cleanly, because only one action
  touches the row. The failing case is the one the feature actually produces.
- **`INITIALLY IMMEDIATE` is not enough.** On a minimal fixture it passes; add
  the rest of what a real account owns and the same DELETE fails again. A
  guarantee that holds only on small fixtures is not a guarantee.
- **It is intermittent by fixture even when non-deferrable.** The trigger firing
  order depends on constraint OIDs and on how many rows the statement touches, so
  the behavioural test alone is not a reliable guard. `persona.test.ts` asserts
  `pg_constraint.condeferrable` as well.

**`blip_reactions` gets nothing.** Its primary key is
`(blip_id, user_id, reaction)`, and that composite is what makes the toggle
idempotent with no read-then-write. An agent column in the key would let one
person's three agents each land the same mark and turn a count of 1 into 3. The
interface never shows _who_ reacted, so there is nothing an agent column would
render. A reaction stays the human's; the audit log records which agent put it
there.

### Editing

**The creator is fixed; the editor is shown (ADR-0028).** `author`, `agent` and `agent_voice`
name whoever captured the blip and never change. This reverses the earlier rule that authorship
followed the words, which erased an agent's mark the moment a person fixed a typo. Its concern, a
name left on text its owner didn't write, is met by naming the editor beside the author instead.

- `blips_keep_author` (0095) keeps the three columns as they were on every UPDATE, silently, so a
  previous image that still re-stamps them is harmless. Only a deleted user or agent may null one.
- `blip_revisions` logs each change to title, body, lane or radar with who made it. A blip read by
  a signed-in reader carries `lastEditedBy` (omitted when the creator made the last edit) and
  `list_blip_revisions` gives the log; neither is public.
- `authored` still turns true when the body is rewritten: it decides whether a mention in the text
  notifies anyone, which is about the words, not the byline.

A comment needs no new predicate at all. `updateComment` already refuses unless
`author_id` is the caller, and on an agent-written comment `author_id` _is_ the
owner — so the existing rule already passes for them and already fails for
everybody else, including a different human who owns a different agent.

A comment's creator is fixed the same way (`blip_comments_keep_author`, 0099): editing keeps `author`,
`agent` and `voice`, and the rewriter is recorded in `edited_by_user_id` / `edited_by_agent_id`
(from `omr.actor_user` / `omr.actor_agent`, as for blips) and shown as `editedBy` on a signed-in
read when it is not the creator. `update_comment` no longer takes `as`.

---

## 4. The voice grant

The token grants which voices are permitted; the call picks among them. Same shape
as scopes: the human grants a range, the agent exercises within it, and a token
minted persona-only can never speak as the human whatever it is asked to do.

- **OAuth tokens ride `scope`** — `voice:persona`, `voice:principal` — because
  that is already the grant channel and the consent screen already renders it and
  is never auto-approved. Safety rule 7, obtained for free.
- **Personal access tokens get columns**, because the Settings screen offers no
  scope choice and voices are not a ceiling on access anyway. Two CHECKs make them
  honest: `cardinality(voice_grants) >= 1` and
  `default_voice = ANY (voice_grants)`.

`cardinality`, **not `array_length`**. `array_length(ARRAY[]::text[], 1)` is NULL,
`NULL >= 1` is NULL, and **a CHECK that evaluates to NULL passes**. Written that
way the empty array slips straight through — verified by dropping the sibling
constraint and inserting one. Same class of finding as `array_to_string` not being
immutable, and invisible to anything that does not run the DDL.

### Nothing live changed behaviour, and no row was rewritten

**A token with no agent has no voice at all.** That one rule is the whole of it.
Every token issued before `0015` carries `agent_id IS NULL`, so it resolves with no
persona, so `authorshipOf` writes `agent_id = NULL, agent_voice = NULL` — byte for
byte what it already wrote.

An earlier draft proposed a legacy rule (an absent `voice:` scope meaning both
voices with a `principal` default). It is not needed and is not there: the case it
protected cannot arise, because a grant that names no voice also carries no agent.
One rule instead of two, and the narrower one.

The default for anything minted _after_ this is `persona`. Own-voice is the honest
default: writing under the human's name is the more consequential mode and should
be the one somebody chose.

### How the call picks

Write tools take one optional argument:

```ts
as: z.enum(['me', 'agent']).optional();
```

Absent → the connection's default. Present and not granted → **refused, loudly,
naming the reason**, in the service layer so both transports inherit it. Never
silently downgraded: a silent downgrade is how a comment ends up rendered under a
name the caller did not intend, which is the failure this whole design exists to
prevent. The refusal happens before the write, so nothing half-happens.

`as` is a closed two-value enum and cannot name a principal. **No request body, no
tool argument and no service parameter carries an agent id anywhere that writes
content** — the two places an id legitimately arrives (minting a PAT, approving a
consent) attach a persona to a _credential_, on a screen, and both check ownership
first. `persona.test.ts` asserts the write sites by grep, so a fifth one fails the
suite.

---

## 5. An agent holds no memberships

**Ever.** What it can reach is computed, every time, from its owner:

```
agentReadable(agent, token) = readableRadarIds(agent.ownerId) clamped by the token
```

A membership row is standing access by definition: it survives token revocation,
it survives the human losing their own access, and it would add a term to the
most-permissive union in `decide()` — the exact shape of a union where the rule
demands an intersection.

Nothing needs one. Mentionable, notifiable and listable are all derived from
`radarReaders`. This is the same argument as `topics.cascade` being a computed
overlay, applied one level up: **the agent is a second computed overlay stacked on
the first**, and neither can drift from its source because neither is written
down.

---

## 6. Authorization: union, then clamp

```
effective(agentActor, radar) = min( decide(the human's grants), the token's ceiling )
```

Unchanged from what `0014` already shipped, and that is the point: **the persona
contributes no new term.** For an agent-borne actor the union's inputs are
byte-for-byte the human's, and the only token-specific operation in the whole
authorization path is a monotonically weakening `min`. To give an agent more access
than its human you would have to add a term to the union, and there is no term to
add.

`persona.test.ts` asserts it as a matrix over owned / direct member / cascading
topic / stranger, at every scope — because the property is monotone weakening and
only a matrix catches a promotion. It also asserts one equality, because `<=` alone
cannot see a _missing_ clamp: with the `min` removed, agent and human are simply
equal and every inequality still holds.

---

## 7. Mentions and notifications

### `@claude` and `@lucas.claude`

`mentionDirectory` gains the live agents of everybody in `radarReaders`, with two
handles each: the bare one, and the owner-qualified one built from the owner's own
handle. **No new resolution mechanism.** Agents share one namespace with people —
so `@ada` can never mean a person on one radar and an agent on another — and two
`@claude`s collide and resolve to nobody, exactly as two people called Ada already
do. The qualified handle never collides.

Resolution still cannot widen access, by the same construction: candidates come
from `radarReaders`, so an agent is a candidate only where its owner can already
read. The mention is proof the access exists, never a grant of it.

A retired agent is not a candidate. Its handle stops resolving, exactly as a
deleted account's does.

### The queue

`notifications.agent_id`, and **`user_id` stays NOT NULL and stays the owner.**
This is the most important implementation detail here. Coalescing is the partial
unique index `(user_id, group_key) WHERE read_at IS NULL`; making `user_id`
nullable to hold an agent's queue would mean agent rows never conflict — NULL
against NULL — so folding would silently stop working for agents while the index
went on looking correct. The group key is namespaced instead
(`agent:<id>:mention:comment:<id>`), so the two key spaces can never meet.

`deliver()` returns immediately for an agent row. No email, no push: an agent has
no mailbox and no browser, and pushing a banner would put the agent's business on
the human's phone. Retention is the existing retention — unread rows are never
purged — so the answer to "how long does a mention wait for a disconnected agent"
is "indefinitely", which is the right default for a surface whose whole purpose is
_what did I miss_.

### The self-filter, which would otherwise have shipped broken

`fanOut` filtered recipients on the user id alone. An agent's row carries
`user_id = <its owner>`, so **Lucas mentioning his own `@claude`** — the single
most likely way anybody will use this — was dropped, silently, with no error
anywhere. The filter is pairwise now, and reads the way it is meant: _suppress when
the addressee is the actor_.

- A row addressed to a person is suppressed when that person acted, including
  personal-voice delegation. A stored **persona-voice comment** is another
  participant speaking and notifies its involved human cosigner under the normal
  radar, kind and channel preferences. Personal-voice comments and ordinary
  captures/reactions stay quiet for their own author. The stored comment voice
  decides this, not the token's default voice. Lucas explicitly chose this rule
  on October4 in blip c0105c84-8fd7-4287-ad3e-4f73dd1c8916.
- A row addressed to an agent is suppressed only when _that_ agent acted. Its
  owner writing to it is not it writing to itself.

### The sweep

`dropRadarMentions` covers the owner's agents in the same predicate, inside the
function every revocation site already calls — so there is nothing for a call site
to remember and nothing for a three-way merge to lose. (The design that preceded
this asked for the leg to be added at four call sites and named that as the change
a merge would most likely drop; the sites had since been consolidated to two,
which is what made the better shape available.)

`dropRadarNotifications` needed no change: an agent's row carries its owner's
`user_id`, so the existing equality already catches it. Stated explicitly in the
code, because the next person to reach for `agent_id IS NULL` there to "only sweep
the person's own" would open the hole.

---

## 8. Lucas's four sub-questions

### 8.1 One human, or a team?

**One human.** The intersection rule needs a _specific_ human whose access bounds
the agent's. A team-owned persona has no such human: its ceiling would be
"whoever connected it this time", which widens when a new member joins — the
union-shaped failure the rule exists to forbid, wearing a different hat.

A team still gets what it wants. Ada shares a radar with Lucas; Lucas's agent can
reach it because Lucas can; Ada addresses it as `@lucas.claude`; the byline names
Lucas. It is visibly _Lucas's_ agent operating in a shared space, which is both
true and the thing a team needs to know.

### 8.2 May the owner edit the agent's writing?

**Yes, and the card says so** — see §3. The agent's mark stays; the byline adds "edited by
Lucas", and the revision log keeps what the card said before.

### 8.3 Does `@claude` reach a disconnected agent?

**Yes, and it waits indefinitely.** The mention writes its rows the moment the body
is saved, with no liveness check; `list_notifications` drains the queue on the next
connect. Unread rows are never purged.

### 8.4 Is an agent acting on somebody's behalf visible to others?

**Settled 2026-08-27: hidden.** `PRINCIPAL_VOICE_NAMES_THE_AGENT` in
`packages/contract/src/text.ts` is now `false`. An agent writing in Lucas's voice
renders simply as Lucas.

Nothing else depends on it: the row records both identities unconditionally, the
DTO carries both, and `bylineFor` decides only what is printed. So the record is
complete either way and the decision remains one line.

It shipped `true` while the question was open, on an asymmetry rather than an
argument — if the mention turned out to be noise, hiding it later cost one line;
if it turned out to matter, having hidden it meant every belief formed from that
radar in the meantime was formed wrong. Lucas answered the underlying question
instead: an agent acting on your behalf **is** you, in the way a letter your
assistant typed is still your letter, and your delegation is your own business.

**`principal` voice only.** An agent writing in its own persona is still
attributed as itself, and that path is untouched.

---

## 9. Rendering

```
persona    Claude · via Lucas · 14:02
principal  Lucas · 14:02                (§8.4 — delegation is not named)
human      Lucas · 14:02
```

`via X` is one quiet monospace token in a byline that is already monospace. Not a
badge, not a coloured pill, not an icon: the chrome is an instrument voice and it
states facts in one register. A provenance chip would be the loudest thing on a
card whose actual content is somebody's thought.

`BlipDto` and `CommentDto` both carry `agent: AgentDto | null` and
`voice: Voice | null`. `author` keeps its meaning and its shape — always the human,
never null because of an agent. The public surface keeps the agent's _name_ and
blanks its id, exactly as it already does for authors.

`MentionDto` gained `agentId` and `aliases`. The second one exists because the
qualified handle is not the one stored: an agent answers to `@claude` and
`@lucas.claude`, and the row deliberately does not remember which was typed so a
rename re-renders. Without `aliases` the qualified form notified correctly and then
came back as plain text — found by writing it in a real comment and looking at the
result, not by any test on the server.

---

## 10. Known limitations this introduces

The bounded notification identity release has a hosted served-UI acceptance
scenario in `packages/phone/src/notification-identity.ts`. It uses real scratch
API sessions, agent-bound connections and committed comments, without canned
notification responses. Activity and its home dashboard widget are exercised at
390x844 and 1280x900, including distinct agents sharing a cosigner, equal-named
human/agent and explicit human voice, unknown historical/mixed coalescing, and
archived/deleted principals. Old-writer rows are synthetic only inside the
existing CI-owned scratch database. Original phone assertions remain enabled.
Screenshots `identity-activity-<scenario>-<width>.png`,
`identity-dashboard-<width>.png` and `identity-provenance.json` are retained in the
existing phone artifacts. Provenance records source SHA, actual API DTOs, visible
geometry, hit-testing/focus and browser/network diagnostics, never connection
tokens/cookies. Hosted results and independent screenshot/customer acceptance
must be recorded separately; writing this scenario is not a visual PASS.
The thin current-main release retains migration0058 byte-for-byte. It depends
only on the existing notification table, not plan-builder/support migrations0053–57.
The forward migrator tracks each filename/checksum, so later arrival of those
lower-numbered migrations is supported without rewriting0058; composition
fixtures independently verify populated0056/0058 and late0054 preservation.
Those broader sources and their acceptance are not included in this thin release.

- **Historical notification identity is unknown.** Migration0058 records
  qualified principal keys for new events and keeps `actor_ids` only as legacy
  human-cosigner metadata. Older writers increment total count without the
  attributed-event counter, so mixed-version folding remains visible. Unknown
  earlier activity is labelled, never reconstructed as a named agent. New
  persona-voice comments and their mentions name the committed agent; personal
  voice names the person. Agents carry an `(agent)` label even when their name
  matches a person's. Archived agents still resolve; deleted records show a
  neutral former-principal label. Keys are identifiable retention data, not
  anonymized. Account closure, export and erasure coordination is future work,
  outside this release. Erasure needs a reviewed cross-recipient key/cosigner
  scrub coordinated with queued notification/push dispatch, retries and restored
  backups. Deleting one's recipient rows alone cannot erase identities retained
  in other people's notifications. Future account exports must review attribution
  fields alongside quoted content and refuse unsupported schema generations.
- **Pre-persona content is ambiguous.** No agent mark means "a person, _or_ an
  agent from before personas existed". Not backfillable: one could learn _that_ an
  agent wrote a row from `audit_log.actor_kind`, but never _which_, because no
  agent existed. Manufacturing a legacy persona to attribute them to would put a
  name in a byline nobody chose.
- **Editing loses the drafting fact.** §8.2.
- **The bare handle degrades on a busy shared radar.** Once two readers each own a
  `@claude`, everybody must qualify. The same trade the existing ambiguity rule
  already makes for two people called Ada.
- **An agent cannot be given access its owner lacks.** By design, and worth
  stating because somebody will eventually want a service account that reaches a
  radar no single human does. That is a different feature and should be argued on
  its own rather than arriving as a relaxation of §5.
- **No per-agent rate limit.** An agent's writes are bounded only by whatever
  bounds its human's.
- ~~**An OAuth grant still cannot be revoked**~~ — closed 2026-09-26: Settings →
  Identities → Connected apps disconnects one (DESIGN.md §35).

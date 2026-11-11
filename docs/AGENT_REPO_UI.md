# Agent Repo v2 — screen by screen

The UI half of `docs/AGENT_REPO.md` Part I. Written to be turned into a clickable
mockup: every screen lists its regions top to bottom, its controls, its states,
and the exact copy where the copy is the design. Not built.

**Design language, unchanged:** the chrome is the monospace instrument voice
(`.instrument`); words people and agents wrote — names, prompts, memories — are
the reading serif. An agent's accent is set on its page's container, never
`:root`. Every control is ≥ 44 px on touch; nothing is hover-only. Phone = 390 px,
desktop = 1024 / 1440 / 1920, and the 1024 content pane (sidebar open) is the
width to design against.

**Vocabulary on screen** (the mental model, §V2.1): _agent_ (the thing here),
_tool_ (the harness — "tool" in UI copy, "harness" in docs and MCP), _profile_
(an agent's settings for one tool), _use in…_ (checkout).

**Routes:** `/repo` (list), `/repo/:id` (agent, Prompt tab), `/repo/:id/memory`,
`/repo/:id/memory/:name`, `/repo/:id/activity`, `/repo/:id/settings`,
`/repo/:id/settings/:harness`. Use-in and Share are dialogs over any tab
(`?use=claude-code`, `?share=1` so they are linkable).

---

## 1. Agents list — `/repo`

**Header row:** `Agents` (h1) · `Import` (secondary) · `New agent` (primary).

**Explainer** (one line, dim, always shown, links "How it works" → a small
popover with the three-step diagram from the empty state):

> An agent lives here — a name, a prompt, a memory. Your tools run it.

**Filter row:** a segmented control `Mine · Shared with me · Archived`, then a
search field (`Find an agent`), then a sort dropdown (`Recently used`, `Name`,
`Recently changed`).

**Rows** (one per agent, the whole row a link):

```
[accent glyph]  onmyradar-architect                                   ›
                @onmyradar-architect · 45 memories · used 2h ago in Claude Code
                ▁▁▂▁▃▅▂▇█  ← bearing strip: memory writes over its life
```

- Shared-with-me rows add `Shared by Lucas · can use` (the preset name) and, when
  the owner has changed it since the recipient accepted, a quiet
  `Update available` token.
- Tool icons for each profile the agent has, max 4 then `+2`.

**Empty state (Mine, zero agents)** — the mental model, drawn:

```
 ① Define it here        ② Use it in your tool        ③ It remembers everywhere
 a name, a prompt,        Claude Code, Codex, Cursor,  what it learns is saved here,
 a memory                 claude.ai — any of them      never on one machine
                    [ New agent ]   [ Import from Claude Code ]
```

**Empty (Shared with me):** "Nothing shared with you yet. When someone shares an
agent, it appears here."

**Import dialog:** two ways, as tabs — `From a file` (drop or paste an export
bundle, shows "Architect · 45 memories · a prompt"), `From Claude Code` (explains
the one command to run locally, `pnpm … import-claude-agents`, and that nothing
on the machine is changed).

**New agent dialog:** Name · Handle (derived, editable, `@…`, live collision
check) · "What it's for" (one line; becomes the routing description tools read)
· Primary tool (dropdown, §7) · Prompt (optional, Markdown editor with preview
toggle). `Create agent` → lands on the Prompt tab.

---

## 2. The agent page — shell

**Header** (every tab):

```
[glyph] onmyradar-architect                       [ Connect a tool… ▾ ] [ Share ] [ ⋯ ]
@onmyradar-architect · owned by you · 45 memories · used 2h ago in Claude Code
Architect and maintainer for On My Radar…            (description, 2 lines, expand)
▁▁▂▁▃▅▂▇█
```

- `Connect a tool… ▾` is the primary action: a dropdown of tools (icons), the agent's
  primary tool first; choosing one opens the Use-in dialog (§6) on that tool.
- `Share` opens the Share dialog (§7). Hidden for view-only recipients.
- `⋯` menu: `Export`, `Duplicate`, `Transfer ownership…`, `Archive`, `Delete…`
  (owner only for the last three).
- **Recipient banner** (shared agent with a newer version than accepted):
  `Lucas updated this agent · v14 → v16 · Review changes · Update` — Review opens
  the history diff at those two versions.

**Tabs:** `Prompt · Memory · Activity · Settings`. Default: Prompt. Phone: the tab
strip scrolls; header collapses to name + `Connect a tool…` on scroll.

---

## 3. Prompt tab — the prompt as a page

**Read mode** (default):

- Meta line (instrument): `v16 · changed by an agent in Claude Code · 2h ago ·
History`. For a person's edit: `v15 · edited by Lucas · yesterday`.
- The document, rendered Markdown, reading serif, measure ~72ch, full height —
  no box, no border. Code blocks in mono with a copy button.
- **Outline** (≥ 1280 px): sticky right column listing h2/h3 headings; click
  scrolls. Hidden below 1280 (a `Contents` dropdown above the document instead).
- **Profile addenda**: if any tool profile has an addendum, a quiet section at
  the end: `Added for Claude Code` / `Added for Codex` (collapsed, each with an
  `Edit in settings` link) — so what a tool actually receives is visible here.
- Buttons: `Edit` (people with prompt edit), `History`.
- Locked prompt (Q3): a lock token beside the meta line, `Locked — agents can't
change this prompt`.

**Edit mode** (same page, same URL + `?edit`):

- **WYSIWYG, on the same page.** The rendered document becomes editable in place
  — same measure, same serif, same headings — so editing looks like the page you
  were reading. No split view. The editor (Milkdown, AGENT_REPO.md §V2.4) loads
  lazily on entering edit mode; a skeleton shows the document meanwhile.
- **Toolbar** (sticky under the header, instrument voice, icon buttons with
  tooltips and keyboard shortcuts): Paragraph/Heading 1–3 dropdown · Bold ·
  Italic · Inline code · Link · Bulleted list · Numbered list · Task list ·
  Quote · Code block (with a language field) · Table (insert; row/column
  controls appear inside a table) · Divider · Undo · Redo · **View Markdown**
  (toggle, right-aligned).
- Markdown shortcuts work as you type (`## `, `- `, `1. `, ` ``` `, `**…**`).
- **View Markdown** swaps the page for the raw source in a monospace textarea
  (full width, same save bar); toggling back re-renders. Anything the WYSIWYG
  can't express is edited here.
- **Save** stays disabled until something actually changed. If this is the
  first WYSIWYG save and the editor normalised formatting, the note field is
  pre-filled "formatting normalised by the editor".
- Footer bar (sticky): `Note (optional) — why this change` · character count ·
  `Cancel` · `Save as v17` (primary).
- **Conflict** (409 — an agent or person saved while you edited): a sheet
  `This prompt changed while you were editing (now v17, by an agent in Codex)`
  with the diff between your base and theirs and three actions:
  `Put my version on top` (saves yours as v18), `Start again from v17`,
  `Keep editing`.
- Leaving with unsaved changes asks once.

**History drawer** (right side on desktop, full screen on phone):

- List, newest first: `v16 · agent · Claude Code · MacBook · 2h ago`, note
  underneath if any.
- Selecting one shows it rendered, with `Compare with current` (diff view with
  an `Ignore formatting` toggle,
  added/removed lines) and `Restore as v17`.
- For recipients: versions after their accepted one are marked `newer than yours`.

---

## 4. Memory tab

**Toolbar:** search (`Search memory`), `Type ▾` (All · Feedback · User · Project
· Reference), `Written by ▾` (Anyone · This agent · People · Imported ·
Collaborators), `Sort ▾` (Recently changed · Name · Type), `New memory`
(people with memory edit). A `Recently deleted (3)` link at the end when any
exist.

**List** (not lanes — 400 memories need scanning, not columns):

```
◆ agent-boundary                         Feedback · agent · Claude Code · 3d
  An agent-facing refusal must live in the service, never in the tool router
```

- `◆` = pinned. Row click → detail. Grouped by type when sorted by type.
- Paged, 50 at a time with `Show more`; the count is exact (`45 memories`).

**Memory detail** — `/repo/:id/memory/:name`, a page on phone, a right-hand
panel on desktop ≥ 1280 (list stays visible):

- Name (mono), description (serif, dim), rendered body.
- Provenance line: `r4 · written by the agent in Claude Code (MacBook) · 3 days
ago` / `r2 · Ada (collaborator) · …` / `imported`.
- `Links` — `[[other-memory]]` references and backlinks, as chips.
- Actions: `Edit`, `Pin`/`Unpin` (people only), `History`, `Copy to a radar…`,
  `Delete` (confirm: "Moved to Recently deleted for 30 days").
- **No review controls anywhere.**

**Editor** (dialog, full screen on phone): Name (mono, locked after create) · Type
dropdown with its one-line guidance under it · Description ("the one line the
agent sees in its index") · Body — the same WYSIWYG editor and View Markdown
toggle as the prompt, with a smaller toolbar (no tables or headings above H3). Save; stale revision
→ the same conflict sheet as the prompt.

**Recently deleted:** list with `Restore` per row and "Deleted memories are gone
for good after 30 days."

**Empty:** "No memories yet. Use the agent in a tool and it saves what it learns
here — or write one yourself."

**Recipients without memory access:** the tab shows "Lucas hasn't shared this
agent's memory with you. Your sessions run with the prompt only."

---

## 5. Activity tab

One timeline, newest first, grouped by day. Computed from prompt versions,
memory revisions and sessions; nothing to approve.

```
Today
  14:02  Claude Code · MacBook · ~/src/on-my-radar   session · 3 memories written
         + keyset-timestamp-precision   ~ agent-boundary   − stale-note
  11:40  Prompt v16 · by the agent in Claude Code     "tighten the deploy rules"  View diff
Yesterday
  22:15  Codex · workstation                           session · nothing written
  18:03  Lucas · shared with Ada (Can use)
```

Filters: `Everything · Prompt · Memory · Sessions · Sharing`. Every memory name is
a link; `View diff` opens the history diff.

---

## 6. Connect a tool — the setup flow

A dialog (full screen on phone), three numbered steps, one tool at a time. The
tool picker is the dialog's first row as a dropdown with icons — the same list
everywhere:

```
[icon] Claude Code                  reads CLAUDE.md
[icon] Codex CLI                    reads AGENTS.md
[icon] Cursor                       reads .cursor/rules and AGENTS.md
[icon] Claude (claude.ai & Desktop) reads Project instructions — no files
[icon] GitHub Copilot               reads AGENTS.md and copilot-instructions.md
[icon] Gemini CLI                   reads GEMINI.md
[icon] Windsurf (Devin Desktop)     reads .windsurf/rules and AGENTS.md
[icon] Zed                          reads the first rules file it finds
[icon] Other tool                   reads AGENTS.md
```

Each entry shows a `profile` token when the agent has a profile for that tool
(and the page's `Connect a tool… ▾` dropdown shows the same labels). Under the picker, one
line explains the pairing: "<Tool> finds the agent through <file>; its profile
decides how <Tool> runs it."

The Agents list has the same **Connect a tool** primary action: choose an
available agent and its tool, then continue into this dialog. Existing
`?use=<harness>` links remain supported. The agent's primary tool stays first.

Current availability comes from authenticated `GET /api/tokens`: `mcp.enabled`
is the site setting and `available` follows it. This read grants no access.

**Step 1 — Connect On My Radar to <tool>.** Automatic setup copies the public
setup prompt with the selected tool and agent ID. **Set up the connection
manually** expands the existing server-rendered connect instructions and token
flow. Claude's browser connector uses these manual steps directly. Copying a
prompt is not connection verification. The person approves access, then starts
a new session in the chosen tool. If MCP is turned off for the site,
the dialog says so and retains manual project
files. Files alone do not connect a tool or supply live memory.

**Step 2 — Add <agent> to a project.**

- For file-based tools, a choice (radio cards) where the tool supports both:
  **This project runs as <agent>** / **Available as a helper** (Claude Code
  subagent; Copilot custom agent — per §V2.8).
- Primary path: `Ask your agent to set it up` — one sentence to paste, with copy:
  > Check out my On My Radar agent onmyradar-architect for Codex here, and apply
  > the files exactly as checkout_agent returns them.
- Secondary: `Or add the files yourself` (expander) — each file with its path,
  what happens to it (`created` / `a block is added` / `one line is added`), the
  content, copy.
- The plain-language box that replaces v1's commit sentence:

  > **What these files are.** They tell <tool> to load this agent from On My Radar
  > when a session starts. They hold only the agent's name and ID — no prompt, no
  > memory, no password.
  > **Commit them** if you want everyone who works in this repository to get the
  > same agent. People who don't have access to it in On My Radar see a short
  > note and carry on as normal.
  > **Don't commit them** if the agent is just for you — add them to your
  > ignore file instead.

- For Claude: no files — `Paste into your Project's instructions` with the text,
  or `Use the agent prompt in any chat: choose "agent" from the On My Radar
connector, then onmyradar-architect`.

**Step 3 — Verify the connection.** Start a new session in the chosen tool and
ask which On My Radar agent it is. The dialog polls and offers **Check
connection**. Confirmation requires a PAT/OAuth session for this agent and the
current cosigner, in the selected harness, started after this setup's server
observation baseline, with currently confirmed access. Each opening/tool change
requests fresh inventory; its first successful response establishes a cutoff
covering the database clock and all starts for this agent in one read-only
snapshot, beyond the 50-row display limit. IDs in that initial result and starts
at or before the cutoff cannot verify. Browser time and pre-open cached data are
not freshness evidence. A browser load, another person or tool, a
copied prompt or an older session cannot complete setup. Changing tools resets
the setup's confirmation baseline; delayed responses from a prior tool are
isolated. Missing observation metadata cannot confirm setup. Read failures are shown, not treated as
successful or empty observations. Confirmation is an observed new agent
session, not proof that every future call or provider remains available.

**Settings applied** (small, under step 2): `Codex profile: gpt-5-codex · high
effort · workspace-write · Edit profile`, and a checkbox `Also apply these settings to
the project (.codex/config.toml — affects everyone on this repository)`, off — or `Using the default profile ·
Add a Codex profile`. For Codex specifically, the step also says: "Codex reads
AGENTS.md, so this is the same file other tools use — the Codex profile adds
Codex's own settings on top."

---

## 7. Share dialog

Google-Docs-shaped, because that shape is already learned.

- **Add row:** `Email or topic` (autocomplete: people you share radars with,
  your topics) · preset dropdown · `Share`.
- **Preset dropdown:** `Can use` (default) · `Can use, with its memory` · `Can
contribute to its memory` · `Can edit` · `Custom…` — Custom reveals two small
  dropdowns: `Prompt: View · Edit`, `Memory: None · View · Edit`. Each preset has a
  one-line description under it in the menu (e.g. _Can use — runs the agent with
  its prompt. Your memories stay private._).
- **List:** you (Owner) · each person/topic with its preset (editable dropdown,
  `Remove` in it) · topic rows expand to show members ("via topic Foundation").
- **Footer note** (instrument): "People you share with run this prompt in their
  own tools. They get your changes when they choose to update."
- `Transfer ownership…` lives in the page's `⋯` menu, not here: a separate
  dialog with an email field, the consequences in two lines, and a confirm that
  types the handle.

**Recipient side:** the shared agent appears in `Shared with me` with an `Accept`
state first — the agent page opens on the Prompt tab showing the full prompt
and profiles, with a bar: `Lucas shared this agent with you · Can use · Accept ·
Decline`. Accepting pins the current version.

---

## 8. Settings tab

Sections, top to bottom. Viewers see it read-only; editors can change Basics and
Profiles; the rest is owner-only.

**Basics** — Name · Handle (`@…`, with "Changing it breaks @-mentions written
before" warning) · What it's for (routing description) · Accent (swatch picker) ·
`Save`.

**Tool profiles** — the "easy yet comprehensive" answer:

```
Settings for  [ Claude Code ▾ ]                       Primary tool ●
┌──────────────────────────────────────────────────────────────────┐
│ Model          [ Opus (latest) ▾ ]                                │
│ Effort         [ High ▾ ]                                         │
│ Tools          [ All tools ▾ ]   (or a checklist when restricted) │
│ Permissions    [ Ask before edits ▾ ]                             │
│ Colour         ● ● ● ● ●                                          │
│ Added instructions for Claude Code  (optional, Markdown)          │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ When you finish a change, run the full gate before commit…   │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                        [ Remove profile ] [ Save ]│
└──────────────────────────────────────────────────────────────────┘
+ Add a profile for… [ Codex CLI ▾ ]
```

- The tool dropdown lists the agent's profiles first (✓), then `Default (any
other tool)`, then the rest under `Add a profile for…`.
- **Only that tool's fields** render, from its schema in the contract (§V2.7):
  dropdowns for enumerable values, each with a `Custom…` entry where the tool
  accepts any string (model ids), and a one-line hint per field.
- Fields a tool reads only from the user's own config (not the project) are marked
  `your config` with a tooltip: "Applied by the snippet in Use in…, not by
  project files."
- Values that widen what the tool may do without asking (Claude "Bypass
  permissions", Codex "Full disk access" / "Never ask") carry a caution token and
  the note "Only applied on your own machines. People you share with get the
  tool's default."
- Per-tool fields, from the contract registry (AGENT_REPO.md §V2.7):
  - **Claude Code:** Model · Effort · Tools (All / Only these / All except) ·
    Permission mode · Colour · Added instructions.
  - **Codex CLI:** Model · Reasoning effort · Approvals (Ask when needed / Never
    ask) · Sandbox (Read only / This workspace / Full disk access) · Added
    instructions.
  - **Cursor:** Model (for the helper) · Read-only helper · Run in background ·
    Added instructions.
  - **GitHub Copilot:** Model · Tools · Where it runs (VS Code / GitHub) · Added
    instructions.
  - **Gemini CLI:** Model · Approvals (Default / Auto-edit / Plan only) · Sandbox ·
    Temperature and max turns (helper) · Added instructions.
  - **Zed:** Model (your config) · Tool approvals (your config) · Added
    instructions.
  - **Claude, Windsurf, Default:** Added instructions only — the page says why
    ("Claude has no per-project settings").
- `Default` profile holds only the addendum and the tool-agnostic bits (there is
  no universal "model").

**Identity** — how the agent appears: `Writes as onmyradar-architect · cosigned by you`,
its mention handles (`@onmyradar-architect`, `@lucas.onmyradar-architect`), and
**Machines and apps that write as it**: the tokens and OAuth grants bound to this
agent (name, last used, `Revoke`), plus `Create a token for a machine`.

**Prompt safety** (owner) — `Lock prompt` switch (Q3): "Agents can't change the
prompt while this is on. People with edit access still can."

**Danger zone** (owner) — Archive ("It stops loading everywhere. Its name stays on
what it wrote.") · Transfer ownership · Delete (type the handle).

---

## 9. Elsewhere in the app

- **Settings** loses `Identities`. `Connect an agent` becomes **Connections**:
  server URL, Access tokens (each row says `writes as <agent>` or `writes as you`),
  Connected apps (OAuth grants). Creating a token offers an optional `Writes as`
  agent dropdown.
- **OAuth consent screen:** the `Writes as` dropdown lists your agents (and
  `You`), with the note "You can also choose per chat by loading an agent."
- **Bylines** on blips and comments: `onmyradar-architect · cosigned by Lucas`; the agent
  name links to `/repo/:id` only for people who can load it.
- **@-mention autocomplete** shows agents with a small glyph and their owner:
  `@onmyradar-architect  Lucas's agent`.
- **Sidebar:** `Agents` (unchanged position), with a dot when a shared agent has an
  update waiting.

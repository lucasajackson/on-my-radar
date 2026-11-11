# Component: M21 Agents

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

An agent is one identity owned by a person: a slug, a versioned prompt, per-tool profiles, memories, briefs (M22), sharing and transfer. It writes only through server-issued bindings and always has a human cosigner. The component owns agent management, the `load_agent` session, checkout of an agent into a workspace, and agent handles for mentions.

**Depends on:** M2 (credentials bound to an agent), M3 (`decideAgentAccess`), M10, M7 (handles).

**Used by:** M5 and M7 (authorship), M22, M23 (21 tools), the UI `/repo`.

**Invariants (and what enforces each):**

- `agent_id` can only come from `authorshipOf(actor)`, which reads `actor.agent`; that comes from the credential or from `writeAsAgent`, which validates that a `load_agent` session belongs to this user and connection, has not idled, and that the person still has access and has accepted the agent (`services/agents.ts`; `agent-repo.test.ts` covers the wrong-connection and idle-session cases).
- Both `author_id` and `agent_id` are written in both voices, and an ungranted voice is refused, never downgraded; that is done in code by `resolveVoice` and `authorshipOf`, and the CHECKs (`blips_agent_voice_valid`, `blip_comments_agent_voice_valid`) only limit the voice to `persona`, `principal` or NULL (`persona.test.ts`). A browser user never writes as an agent.
- A prompt is `(agent_id, version)` with one live row (partial unique index `agent_prompts_one_live`); `updatePrompt` takes a row lock and requires `basedOn` to equal the live version (409 otherwise); a person's edit, or an identified other agent's, is live (with an Activity note), but an agent's own edit, an unidentified editor's, and any agent edit under `lock_prompt` is held in `agent_prompt_proposals` until the owner accepts it in a browser session (3 waiting at once, 20 versions or proposals a day; ADR-0029; `services/repo-agents.ts`; `agent-repo.test.ts`).
- Human-only acts: lock, archive, delete, share, accept, follow, transfer, binding a brief repo, minting a token, listing connections, promoting a memory to a blip (`agent-repo.test.ts`: refuses every human-only act for a connection).
- A recipient who has not accepted a shared agent cannot load it, and is pinned to the version they accepted unless they follow updates.
- Memory: at most 2,000 per agent and 120 writes per session per hour; sessions idle after 7 days; a forgotten memory is restorable for 30 days (`AGENT_REPO` in `packages/contract/src/agent-repo.ts`).
- `checkout_agent` renders deterministic file operations (each one that carries content has a sha256) and no credentials, for nine harnesses, including windsurf, zed, claude-ai (paste only) and a helper mode that writes `.claude/agents/<slug>.md` and the like; for example: `.omr/agent.json` plus `.omr/AGENT.md` and an ensure-line in `CLAUDE.md` (claude-code), the same with `GEMINI.md`, an upsert block in `AGENTS.md` (codex, copilot, other) or `.cursor/rules/omr-agent.mdc` (cursor); for non-owners, widening values are stripped (`agent-checkout.test.ts`).
- Handles share a namespace with people (the bare slug and `owner.slug`); a handle claimed twice resolves to nobody; archived agents resolve nothing (`services/mentions.ts`).

## 2. Owned data

| Owned                                           | Kind  | Notes                                                             |
| ----------------------------------------------- | ----- | ----------------------------------------------------------------- |
| `agents`                                        | table |                                                                   |
| `agent_sessions`                                | table |                                                                   |
| `agent_prompts`                                 | table |                                                                   |
| `agent_prompt_proposals`                        | table |                                                                   |
| `agent_memories`                                | table |                                                                   |
| `agent_memory_revisions`                        | table |                                                                   |
| `agent_profiles`                                | table |                                                                   |
| `agent_shares`                                  | table |                                                                   |
| `agent_recipients`                              | table |                                                                   |
| `agent_transfers`                               | table |                                                                   |
| `model_catalog`                                 | table |                                                                   |
| `packages/server/src/services/agents.ts`        | file  | Authorship, `writeAsAgent`, voices                                |
| `packages/server/src/services/repo-agents.ts`   | file  | Agent, prompt, profile, share, transfer, brief and checkout logic |
| `packages/server/src/services/agent-memory.ts`  | file  | Memories, sessions, `loadAgent`                                   |
| `packages/server/src/services/model-catalog.ts` | file  | Model catalog                                                     |
| `packages/server/src/mcp/agent-repo.ts`         | file  | The 21 agent tools, the `agent` prompt, the agent resources       |
| `packages/server/src/routes/repo-agents.ts`     | file  | Mounted at `/api/repo-agents`, `/api/models`                      |
| `packages/contract/src/agent-repo.ts`           | file  | Caps and DTOs                                                     |
| `packages/contract/src/checkout.ts`             | file  | Checkout file rendering                                           |
| `packages/contract/src/harnesses.ts`            | file  | Harness list                                                      |
| `agent-setup`                                   | file  | Plugin and prompt the UI serves at /agent-setup                   |

## 3. Interface

- **Routes:** `/api/repo-agents` (50 routes, all also mounted under `/api/v1`; including `/:id/load`, `/prompts`, `/profiles`, `/briefs/:name/…`, `/memories`, `/checkout`, `/export`, `/shares`, `/accept`, `/transfer`, `/connections`), `GET /api/repo-agents/handles/:handle`, `/api/models`; `/api/admin/models` is in `routes/admin.ts`.
- **MCP tools (19):** `list_agents`, `load_agent`, `agent_recall`, `agent_remember`, `agent_forget`, `create_agent`, `update_agent`, `update_agent_prompt`, `get_agent_prompt`, `get_agent_profiles`, `set_agent_profile`, `delete_agent_profile`, `list_agent_briefs`, `get_agent_brief`, `update_agent_brief`, `rename_agent_brief`, `agent_activity`, `checkout_agent`, `export_agent`; plus the `agent` prompt and `onmyradar://agents` resources.
- **Harnesses:** claude-code, codex, cursor, claude-ai, copilot, gemini-cli, windsurf, zed, other.
- **Configuration:** `MCP_ENABLED`.

## 4. Failure and degradation

- `load_agent` returns text blocks only, never `structuredContent` (`mcp/structured-content.test.ts`).

## 5. Known gaps and unverified facts

- `docs/ARCHITECTURE.md` says 17 tools and `docs/AGENT_REPO.md` says 13; the code registers 21.
- The header comment on `persona.test.ts` says the write sites are asserted by grep; no such grep assertion was found.

# Component: M22 Agent briefs

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

An agent's briefs: named, versioned documents the agent reads at the start of work. A brief may be bound to a path in a GitLab repository; the worker then reports how many commits behind it is and, when the mirror is on, proposes the brief into the repository as a merge request. The repository copy is never imported back.

**Depends on:** M21 (agents and the brief CRUD in `services/repo-agents.ts`), M11 (the worker lane), GitLab.

**Used by:** M21, M23, the UI.

**Invariants (and what enforces each):**

- Binding a brief repo is human-only and admin-only, and the server's GitLab tokens may be used only for an agent owned by an administrator (`setBriefBinding`; `ownerIsAdmin`; `brief-bindings.test.ts`).
- The worker lane (`checkDueBriefBinding`) counts commits since the brief's current revision excluding the mirror's own and stores the result; the read path shows it. The stored `check_state` is `ok`, `unconfigured` or `failed`, and the DTO adds `not_checked`, `current` and `behind` (`services/brief-bindings.ts`).
- The mirror is one way and does not push to the bound ref by construction: it commits to branch `omr-mirror/<agent>/<brief>` and opens or updates a merge request; an edit in the repository is recorded as drift and never imported; the mirror is constrained to files by CHECK `agent_brief_bindings_mirror_file`.
- GitLab calls go only to `GITLAB_URL`, refuse redirects, time out at 10 seconds and cap responses at 1 MiB and files at 256 KiB (`services/gitlab.ts`; `gitlab.test.ts`).
- A brief is at most 16,384 bytes, an agent has at most 20, and agents write at most 40 brief revisions a day.

## 2. Owned data

| Owned                                            | Kind  | Notes                              |
| ------------------------------------------------ | ----- | ---------------------------------- |
| `agent_briefs`                                   | table |                                    |
| `agent_brief_revisions`                          | table |                                    |
| `agent_brief_events`                             | table |                                    |
| `agent_brief_bindings`                           | table |                                    |
| `packages/server/src/services/brief-bindings.ts` | file  | Binding checks and the worker lane |
| `packages/server/src/services/gitlab.ts`         | file  | GitLab client                      |
| `packages/contract/src/brief-repo.ts`            | file  | Brief DTOs and limits              |

## 3. Interface

- **Routes:** under `/api/repo-agents/:id/briefs/:name/` (`revisions`, `rename`, `binding`).
- **MCP tools:** `list_agent_briefs`, `get_agent_brief`, `update_agent_brief`, `rename_agent_brief` (registered with M21's tools).
- **Configuration:** `GITLAB_URL` (unset by default: bindings then show no link and read "not checked"), `GITLAB_READ_TOKENS` (`read_repository`; Reporter role suffices), `GITLAB_MIRROR_TOKENS` (`api`; Developer role), `BRIEF_MIRROR_ENABLED` (default false). A malformed token map turns the feature off and logs the setting name.

## 4. Failure and degradation

- With no token for a project the stored check state is `unconfigured`, the brief shows `not_checked` with a reason, and nothing fails.

## 5. Known gaps and unverified facts

- The brief CRUD lives in `services/repo-agents.ts` (owned by M21), so this component's boundary is the tables and the binding.
- Whether the production tokens are provisioned is not knowable from the repository.

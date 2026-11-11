# 01 · Principles

Status: Draft · Version 0.1

These principles are decisions, not options. Every component, contract and job definition must be traceable to them, and a change that breaks one needs an ADR first. They are short on purpose: a reviewer should be able to hold all nineteen in mind while reading a design.

| #   | Principle                                                         | What it means in practice                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Intent is declarative, and sync converges every device to it.** | Each workspace has a versioned **desired state** (members, notebooks, sharing, retention). Clients and jobs never patch each other; they read the desired state, compute the difference and apply it. A change is a new version of the state, never an edit in place. |
| P2  | **Durable intent comes before every external effect.**            | Before any call that changes another system, the job persists an effect record: what it will do, to what, under which idempotency key. A crash then leaves a record that can be finished or compensated, never a mystery.                                             |
| P3  | **One policy authority.**                                         | One function, `decide(actor, action, subject, state)`, answers allow, deny with a code, or require confirmation. Screens, the API and the agent surface all ask it; none of them re-implements a rule.                                                                |
| P4  | **People outrank automation.**                                    | A decision a person made (a hold, a pin, a restore) is never undone by a job. Automation may propose, raise a finding and wait, but it does not overwrite a human decision.                                                                                           |
| P5  | **Each fact has one system of record and one writer.**            | `02-system-context.md` names the owner of each fact. Acme mirrors facts it does not own and labels every mirror with the time it was last observed, so a stale copy is visible as stale.                                                                              |
| P6  | **Unknown is a verdict, and every check fails closed.**           | A read that fails, or a field that is missing, raises an error; it is never coerced to "fine". A gate that cannot tell whether an action is safe refuses and says what it could not read.                                                                             |
| P7  | **Done means independently observed.**                            | A 2xx reply is a request, not a result. A step succeeds when a separate observation proves the world matches the intent, for example a read-back of the stored object or a search hit for the new note.                                                               |
| P8  | **Integrations are contract-first.**                              | Every external system sits behind a port and an adapter that implement a written contract with a version. The contract has a fake, and the same case table drives the fake and the contract test against the real system.                                             |
| P9  | **Never destroy what you cannot restore.**                        | A permanent delete runs in order: archive, then a verified export with a checksum, then the delete, then a forward-only cleanup. A delete that cannot prove its export refuses.                                                                                       |
| P10 | **Secrets never touch Acme storage or git.**                      | The only path is secret store, then the sync operator, then a cluster secret. Acme records which secret a workload uses and its rotation date, and never a value. A value found in a row, a log or a test fixture is a defect.                                        |
| P11 | **Deploys are the only way to change a cluster.**                 | Releases render bundles into the deployment repository and the cluster agent applies them. Neither Acme nor CI holds credentials that can write to a cluster directly, so every change has a commit.                                                                  |
| P12 | **A small core with capability modules.**                         | The core (edge, policy, job engine, persistence, audit, scheduler) knows nothing about notebooks, billing or sharing. A capability registers commands, queries, checks and jobs through a manifest, and the core stays closed to modification.                        |
| P13 | **Every effect is attributable.**                                 | Each command, decision, job transition and external effect writes an append-only event naming the actor, the subject, the reason and the job. "Who did this and why" is always one query.                                                                             |
| P14 | **Semantics are versioned.**                                      | Job definitions, contracts, events and the policy table each carry a version. A job finishes under the semantics it was planned with, even when a newer version has shipped since it started.                                                                         |
| P15 | **Refuse honestly.**                                              | A clear refusal with a stable code and a remedy that is safe to follow beats a partial success. The person is told what did not happen, why, and what to do next, in words rather than a status code.                                                                 |
| P16 | **Small-team operability.**                                       | One language (TypeScript), one database (Postgres), two process roles (api, worker). The system must be understandable, restartable and recoverable by one on-call engineer reading the runbook.                                                                      |
| P17 | **The agent surface is task-shaped.**                             | The agent tools expose a small set of user tasks that map one-to-one onto commands, with the same policy and the same refusal codes as the screens. There is no second, looser door.                                                                                  |
| P18 | **Every runtime resource has exactly one owning subject.**        | Shared capacity (a storage region, a search cluster) is a lifecycle subject of its own. Dependents inherit its placement, and capacity that still serves tenants cannot be removed.                                                                                   |
| P19 | **Authority is separate from history.**                           | Who created something grants nothing. Scope comes from a current, revocable grant: a role, a share, a token. Removing the grant removes the access, whoever made the note.                                                                                            |

## Precedence when principles collide

Safety of customer notes (P9) > people over automation (P4) > fail closed (P6) > convergence (P1) > everything else. For example, a reconcile that would converge a shared notebook by deleting a note a person restored does nothing and raises a finding. Billing never changes what a person can read or restore (ADR-0005), so a lapsed plan limits new writes and nothing else.

## How the principles are used

- A design review names the principles a change touches and says why each still holds.
- A pull request that adds an external call links the contract it implements and the fake that covers it.
- An incident review ends by asking which principle would have prevented it, and whether a check can now enforce it.
- A new capability starts from the manifest in `03-components.md`; anything the manifest cannot express is a request to change the core, which needs an ADR.
- A principle is retired only by an ADR that names its replacement, and the old text stays in the history.

## Worked examples

| #   | Situation                               | Principle | Expected behaviour                                                                                                                                                                             |
| --- | --------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | A person asks to lock a invitation      | P6        | The command is accepted only after policy allows it. The cache purge is recorded as an effect before it runs, and the job is done when the invitation is read back in its new state.           |
| E2  | A person asks to duplicate a invitation | P4        | The command is accepted only after policy allows it. The virus scan is recorded as an effect before it runs, and the job is done when the invitation is read back in its new state.            |
| E3  | A person asks to archive a share link   | P16       | The command is accepted only after policy allows it. The storage write is recorded as an effect before it runs, and the job is done when the share link is read back in its new state.         |
| E4  | A person asks to lock a member          | P10       | The command is accepted only after policy allows it. The notification is recorded as an effect before it runs, and the job is done when the member is read back in its new state.              |
| E5  | A person asks to restore a revision     | P9        | The command is accepted only after policy allows it. The virus scan is recorded as an effect before it runs, and the job is done when the revision is read back in its new state.              |
| E6  | A person asks to move a sync session    | P7        | The command is accepted only after policy allows it. The search index update is recorded as an effect before it runs, and the job is done when the sync session is read back in its new state. |
| E7  | A person asks to rename a workspace     | P11       | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the workspace is read back in its new state.          |
| E8  | A person asks to restore a workspace    | P14       | The command is accepted only after policy allows it. The cache purge is recorded as an effect before it runs, and the job is done when the workspace is read back in its new state.            |
| E9  | A person asks to lock a template        | P16       | The command is accepted only after policy allows it. The email is recorded as an effect before it runs, and the job is done when the template is read back in its new state.                   |
| E10 | A person asks to import a invitation    | P7        | The command is accepted only after policy allows it. The notification is recorded as an effect before it runs, and the job is done when the invitation is read back in its new state.          |
| E11 | A person asks to unshare a share link   | P12       | The command is accepted only after policy allows it. The audit record is recorded as an effect before it runs, and the job is done when the share link is read back in its new state.          |
| E12 | A person asks to tag a share link       | P7        | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the share link is read back in its new state.         |
| E13 | A person asks to merge a import         | P5        | The command is accepted only after policy allows it. The storage write is recorded as an effect before it runs, and the job is done when the import is read back in its new state.             |
| E14 | A person asks to lock a plugin          | P13       | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the plugin is read back in its new state.             |
| E15 | A person asks to restore a attachment   | P1        | The command is accepted only after policy allows it. The email is recorded as an effect before it runs, and the job is done when the attachment is read back in its new state.                 |
| E16 | A person asks to subscribe to a export  | P11       | The command is accepted only after policy allows it. The search index update is recorded as an effect before it runs, and the job is done when the export is read back in its new state.       |
| E17 | A person asks to move a sync session    | P7        | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the sync session is read back in its new state.       |
| E18 | A person asks to publish a invitation   | P14       | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the invitation is read back in its new state.         |
| E19 | A person asks to pin a comment          | P8        | The command is accepted only after policy allows it. The storage write is recorded as an effect before it runs, and the job is done when the comment is read back in its new state.            |
| E20 | A person asks to comment on a revision  | P9        | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the revision is read back in its new state.           |
| E21 | A person asks to move a notebook        | P6        | The command is accepted only after policy allows it. The virus scan is recorded as an effect before it runs, and the job is done when the notebook is read back in its new state.              |
| E22 | A person asks to unshare a export       | P19       | The command is accepted only after policy allows it. The thumbnail render is recorded as an effect before it runs, and the job is done when the export is read back in its new state.          |
| E23 | A person asks to restore a comment      | P18       | The command is accepted only after policy allows it. The audit record is recorded as an effect before it runs, and the job is done when the comment is read back in its new state.             |
| E24 | A person asks to merge a device         | P14       | The command is accepted only after policy allows it. The usage counter is recorded as an effect before it runs, and the job is done when the device is read back in its new state.             |
| E25 | A person asks to archive a note         | P12       | The command is accepted only after policy allows it. The search index update is recorded as an effect before it runs, and the job is done when the note is read back in its new state.         |

## Glossary

| Term         | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| `Actor`      | The authenticated caller of a command, with a class and a set of grants.                    |
| `Subject`    | The thing a command acts on, with a state that policy can read.                             |
| `Facet`      | One slice of the desired state, owned and versioned by exactly one module.                  |
| `Effect`     | A recorded intention to change another system, with an idempotency key.                     |
| `Finding`    | A fact a person has to decide about; automation only raises and resolves them.              |
| `Hold`       | A person's decision that automation must respect until they clear it.                       |
| `Grant`      | A current, revocable permission that scopes what an actor may do.                           |
| `Placement`  | Where a workspace is stored and served, by region and role.                                 |
| `Receipt`    | The proof, written after an effect, that the result was observed.                           |
| `Seal`       | A checksummed archive that makes a later delete restorable.                                 |
| `Spec`       | The versioned desired state of one subject.                                                 |
| `Epoch`      | A counter that identifies which worker owns a job right now.                                |
| `Fence`      | A token that lets a stale worker be rejected by the system it writes to.                    |
| `Digest`     | The content hash that names an immutable artifact.                                          |
| `Mirror`     | A read-only copy of a fact owned elsewhere, with its observation time.                      |
| `Port`       | The interface the core defines for an external system.                                      |
| `Adapter`    | The code that implements a port against one real system.                                    |
| `Fake`       | A deterministic stand-in for a port, driven by the same case table.                         |
| `Manifest`   | The declaration a capability module registers with the core.                                |
| `Outbox`     | The table of events waiting to be delivered, written in the same transaction as the change. |
| `Projection` | A read model built from events for a screen or an agent tool.                               |
| `Drift`      | A difference between the desired state and what was observed.                               |
| `Probe`      | A scheduled read that compares the two.                                                     |
| `Tenant`     | One customer account and everything it owns.                                                |
| `Ledger`     | The append-only record of every effect and who caused it.                                   |

## Non-goals

- Acme is not a general workflow engine; jobs exist to converge notes, sharing and storage and nothing else.
- Acme does not hold payment data; the payment processor does, and Acme reads it.
- Acme does not offer real-time cursors inside a note; collaborative editing is a revision merge, not a shared buffer.
- Acme does not guess: where two writers disagree, it raises a finding instead of choosing.

- Non-goal note 1: this list is deliberately short.

## Review checklist

1. Check 1: does the change to the search query flow keep P1, and is the evidence in the pull request rather than in the description?
2. Check 2: does the change to the tag flow keep P9, and is the evidence in the pull request rather than in the description?
3. Check 3: does the change to the tag flow keep P6, and is the evidence in the pull request rather than in the description?
4. Check 4: does the change to the invitation flow keep P6, and is the evidence in the pull request rather than in the description?
5. Check 5: does the change to the search query flow keep P9, and is the evidence in the pull request rather than in the description?
6. Check 6: does the change to the workspace flow keep P15, and is the evidence in the pull request rather than in the description?
7. Check 7: does the change to the share link flow keep P13, and is the evidence in the pull request rather than in the description?
8. Check 8: does the change to the sync session flow keep P9, and is the evidence in the pull request rather than in the description?
9. Check 9: does the change to the comment flow keep P9, and is the evidence in the pull request rather than in the description?
10. Check 10: does the change to the tag flow keep P14, and is the evidence in the pull request rather than in the description?
11. Check 11: does the change to the search query flow keep P19, and is the evidence in the pull request rather than in the description?
12. Check 12: does the change to the webhook flow keep P13, and is the evidence in the pull request rather than in the description?
13. Check 13: does the change to the share link flow keep P9, and is the evidence in the pull request rather than in the description?
14. Check 14: does the change to the folder flow keep P9, and is the evidence in the pull request rather than in the description?
15. Check 15: does the change to the template flow keep P17, and is the evidence in the pull request rather than in the description?
16. Check 16: does the change to the webhook flow keep P8, and is the evidence in the pull request rather than in the description?
17. Check 17: does the change to the reminder flow keep P11, and is the evidence in the pull request rather than in the description?
18. Check 18: does the change to the note flow keep P12, and is the evidence in the pull request rather than in the description?
19. Check 19: does the change to the sync session flow keep P2, and is the evidence in the pull request rather than in the description?
20. Check 20: does the change to the share link flow keep P8, and is the evidence in the pull request rather than in the description?
21. Check 21: does the change to the import flow keep P17, and is the evidence in the pull request rather than in the description?
22. Check 22: does the change to the plugin flow keep P1, and is the evidence in the pull request rather than in the description?
23. Check 23: does the change to the comment flow keep P6, and is the evidence in the pull request rather than in the description?
24. Check 24: does the change to the webhook flow keep P16, and is the evidence in the pull request rather than in the description?
25. Check 25: does the change to the search query flow keep P3, and is the evidence in the pull request rather than in the description?
26. Check 26: does the change to the export flow keep P10, and is the evidence in the pull request rather than in the description?
27. Check 27: does the change to the device flow keep P8, and is the evidence in the pull request rather than in the description?
28. Check 28: does the change to the notebook flow keep P17, and is the evidence in the pull request rather than in the description?
29. Check 29: does the change to the notebook flow keep P8, and is the evidence in the pull request rather than in the description?
30. Check 30: does the change to the plugin flow keep P8, and is the evidence in the pull request rather than in the description?

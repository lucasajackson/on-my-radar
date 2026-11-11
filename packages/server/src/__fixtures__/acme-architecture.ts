/**
 * A synthetic architecture pack for a fictional product ("Acme Notes"), shaped like the pages, ADR
 * headers, component and contract headers an architecture folder holds, so the real tables, fences and
 * status headers are what the tests meet. Nothing here describes a real system.
 * Generated once from packages/contract/test/fixtures/acme-charter-*.md's vocabulary; edit by hand now.
 */

/** 02-system-context.md: the title, the external-systems header and the Stripe row */
export const PAGE_02 = [
  '# 02 · System context',
  '| System                                              | What it owns                                                                  | What Acme does with it                                                   | Direction · auth                                       | Contract                    |',
  '| --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------- |',
  '| **Stripe**                                          | Customers, subscriptions, invoices, payments, disputes: **all billing truth** | Reads only. Webhooks are triggers that cause Acme to re-read the objects | In · webhook signature. Out · restricted read-only key | `contracts/stripe.md`       |',
].join('\n');

/** 03-components.md: the title, the components header and the M8 row */
export const PAGE_03 = [
  '# 03 · Components',
  '| #   | Component              | Responsibility                                                                                                                                                                                                              | Owns (data)                                          | Public interface                                                                                                                      | Depends on  |',
  '| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- |',
  '| M8  | **Billing**            | Billing links (workspace ↔ Stripe customer and subscription ↔ portal client). Stripe observations. Derives the billing state and the **billing-desired service level** (an input to M1). Never acts on its own (ADR-0005).  | `billing_links`, `billing_observations`, `overrides` | `billing.link/unlink`, `billing.override`, `billing.observe`, `billing.rederive`, `billing.sweep`; query `billing.desired(workspace)` | Stripe port |',
].join('\n');

/** 04-domain-model.md: the title, one amendment note and a state diagram */
export const PAGE_04 = [
  '# 04 · Domain model',
  'Amended by Phase B2 (2026-10-14): one backup per delete run before the point of no return, no recapture there, receipt read back before the delete (Acme !175, 2026-10-14); Membership invite codes are derived, not stored; Credential kinds as in `components/credentials.md`; Backup `retainUntil` becomes `retention` (`components/backup.md`). A lost dispute keeps billing at no opinion (ADR-0005), so `disputed` does not move to `ended` on its own; billing acts on shared tenants only, a dedicated workspace gets `BILLING_MANUAL_ACTION` (C1).',
  '```mermaid',
  '  disputed --> disputed: lost (stays no opinion; staff decide, ADR-0005)',
  '```',
].join('\n');

/** Line 1 and the Status line of ADRs 0001 (Proposed), 0005, 0021, 0025, 0026 and 0027. */
export const ADR_HEADERS = {
  '0001': [
    '# ADR-0001: Desired state is a declarative spec, and sync converges every device to it',
    'Status: Proposed · Date: 2026-10-14',
  ],
  '0005': [
    '# ADR-0005: Stripe is the billing source of truth, and Acme is read-only to it',
    'Status: Accepted (Dana, 2026-10-14) · Date: 2026-10-14',
  ],
  '0021': [
    "# ADR-0021: Static builds read their content credentials from the secret store with the CI job's identity",
    'Status: Accepted (Dana, 2026-10-14); amends the global secrets standard · Date: 2026-10-14 · **v0 retired (S6b, 2026-10-22): `GET /ci/build-config` answers 410; there is no per-site switch**',
  ],
  '0025': [
    "# ADR-0025: Acme's own CI reads its deploy credential from the secret store, not a CI variable",
    'Status: Accepted (standing rule: CI/CD variables hold registry credentials only); closes G3 (`contracts/git-host.md` §11) · Date: 2026-10-14 · Implemented by: `plan/rollout.md` PRE-01, prerequisite OB1',
  ],
  '0026': [
    "# ADR-0026: Acme converges what it owns; only people's problems become findings",
    'Status: Accepted (Dana, 2026-10-15) · Date: 2026-10-15 · Amends: `components/health.md`, `contracts/checks.md`, `components/delivery.md`, `components/ui.md`',
  ],
  '0027': [
    '# ADR-0027: Acme owns the plan; Stripe executes it',
    'Status: Accepted (Dana, 2026-10-15) · Date: 2026-10-15 · Supersedes: ADR-0005 (the money split) · Amends: ADR-0024, ADR-0026, `components/billing.md`, `contracts/portal.md`, and `plan/slices-1-2.md` A4',
  ],
} as const;

/** Line 1 of all 27 ADR files, in order. */
export const ADR_TITLES = [
  '# ADR-0001: Desired state is a declarative spec, and sync converges every device to it',
  '# ADR-0002: Durable intent before every external effect; idempotent steps; done means observed',
  '# ADR-0003: A single policy decision point (actor × action × state)',
  '# ADR-0004: People outrank automation; billing never archives or deletes',
  '# ADR-0005: Stripe is the billing source of truth, and Acme is read-only to it',
  '# ADR-0006: Secrets go only through the secret store and the sync operator; Acme never writes cluster secrets or stores values',
  '# ADR-0007: Deploys are the only cluster write path; Acme and CI hold no cluster write credentials',
  '# ADR-0008: Every delete is archive, then a verified sealed backup, then the delete, then forward-only releases',
  '# ADR-0009: Job definitions are versioned; a job finishes under the semantics it was planned with',
  '# ADR-0010: Contract tests and fakes are generated from shared case tables',
  '# ADR-0011: The MCP surface is small and task-shaped',
  '# ADR-0012: One Postgres, one modular monolith, two process roles; effects are fenced',
  '# ADR-0013: Capabilities are modules with manifests, and the core stays closed to modification',
  '# ADR-0014: One writer per external fact; Acme changes only records it has tagged as its own',
  '# ADR-0015: Unknown is a verdict, and every gate fails closed',
  '# ADR-0016: Tunnel ingress is static per region, and per-workspace routing is configuration through deploys',
  '# ADR-0017: Every caller is an authenticated, scoped principal',
  '# ADR-0018: Customer communication belongs to the portal; Acme emits events',
  '# ADR-0019: Placement is a list; serving capacity is removed only by withdraw, verify, drain, then teardown',
  '# ADR-0020: Deploys pin immutable digests and only move forward; rollback names a ledger entry',
  "# ADR-0021: Static builds read their content credentials from the secret store with the CI job's identity",
  '# ADR-0022: Rebuild in place by replacing module implementations behind stable interfaces',
  '# ADR-0023: Shared plugin hosts are lifecycle subjects; tenants inherit their placement; capacity serving tenants cannot be removed',
  '# ADR-0024: Commercial membership is separate from creation provenance',
  "# ADR-0025: Acme's own CI reads its deploy credential from the secret store, not a CI variable",
  "# ADR-0026: Acme converges what it owns; only people's problems become findings",
  '# ADR-0027: Acme owns the plan; Stripe executes it',
];

/** components/*.md line 1, all 23. */
export const COMPONENT_H1S: Record<string, string> = {
  adapters: '# Component: Adapters and fakes (A\\*)',
  associations: '# Component: M12 Memberships',
  backup: '# Component: M7 Backup and seal',
  billing: '# Component: M8 Billing',
  catalog: '# Component: M2 Templates',
  'command-bus': '# Component: C3 Command bus',
  credentials: '# Component: M6 Credentials and secrets',
  delivery: '# Component: M4 Delivery',
  'domains-edge': '# Component: M5 Custom domains',
  edge: '# Component: C1 Edge',
  'events-audit': '# Component: C8 Event log, outbox and audit',
  health: '# Component: M9 Health',
  identity: '# Component: C2 Identity and access',
  notifications: '# Component: M10 Notifications',
  persistence: '# Component: C9 Persistence, schemas, migrations and locks',
  placement: '# Component: M3 Placement',
  'platform-apps': '# Component: M11 Plugins',
  policy: '# Component: C5 Policy PDP',
  query: '# Component: C4 Query service and read models',
  'run-engine': '# Component: C6 Run engine',
  scheduler: '# Component: C7 Scheduler and jobs',
  sites: '# Component: M1 Workspaces',
  ui: '# Component: Admin UI',
};

/** contracts/*.md line 1 and the Status line, all 27. */
export const CONTRACT_HEADERS: Record<string, [string, string]> = {
  'capability-manifest': [
    '# Contract: Capability manifest',
    'Status: Draft · Version 0.1 · Owner (OMR side): the composition root (`core/boot`); each validation rule is run by the core component that owns its registry · Owner (other side): every capability module (M1–M12) · Provider ref: internal',
  ],
  capacity: [
    '# Contract: Capacity (withdraw, verify, drain; terminal withdrawal; capacity authority)',
    'Status: Draft · Version 0.2 · Owner (OMR side): M3 Placement · Owner (other side): importing jobs of M1 (archive, delete), M3 (placement remove, set role), M11 (host drain, retire) · Provider ref: internal',
  ],
  checks: [
    '# Contract: Checks and findings',
    'Status: Draft · Version 0.1 · Owner (OMR side): M9 Health · Owner (other side): every module that registers checks (manifest `checks`), C4 (read models), M10 (consumer) · Provider ref: internal',
  ],
  cdn: [
    '# Contract: Edge CDN (zones, DNS, load balancers, custom hostnames, rules, cache)',
    'Status: Draft · Version 1.1 · Owner (OMR side): M5 Custom domains and edge · Owner (other side): platform (CDN account; tunnels, region pools and monitors) · Provider ref: internal',
  ],
  commands: [
    '# Contract: Commands (command bus interface)',
    'Status: Draft · Version 0.3 · Owner (OMR side): C3 Command bus · Owner (other side): C1 Edge and C7 Scheduler (callers) and every capability module (handlers) · Provider ref: internal',
  ],
  email: [
    '# Contract: Transactional email (operator alerts)',
    'Status: Draft · Version 1.0 · Owner (OMR side): M10 Notifications · Owner (other side): the transactional email provider · Provider ref: internal',
  ],
  events: [
    '# Contract: Events and outbox',
    'Status: Draft · Version 0.3 · Owner (OMR side): C8 Event log and audit · Owner (other side): C4 (projections), M9, M10 and every emitting module · Provider ref: internal',
  ],
  'secrets-sync': [
    '# Contract: Secrets sync operator',
    'Status: Draft · Version 1.1 · Owner (OMR side): M6 Credentials (render facet, delivery proof) · Owner (other side): platform (the sync operator and its store bindings) · Provider ref: internal',
  ],
  'build-ci': [
    '# Contract: Build CI → Acme (CI API)',
    'Status: Draft · Version 1.0 · Owner (OMR side): C1 Edge (surface), C2 (ID token), M4 Delivery (deploy) · Owner (other side): build pipeline templates · Provider ref: internal',
  ],
  'git-host': [
    '# Contract: Git host API',
    'Status: Draft · Version 1.0 · Owner (OMR side): M4 Delivery (repositories, deploy commits), with M6 (CI variables, pipeline reads) and M7 (export packages) · Owner (other side): platform (the git host) · Provider ref: internal',
  ],
  gitops: [
    '# Contract: Deployment repository layout and agent',
    'Status: Draft · Version 1.0 · Owner (OMR side): M4 Delivery (renderer output, commits, readiness proof) · Owner (other side): platform (the deployment repository and its cluster agent) · Provider ref: internal',
  ],
  registry: [
    '# Contract: Image registry',
    'Status: Draft · Version 1.0 · Owner (OMR side): M4 Delivery (projects, artifacts, retention), with M6 (robots) · Owner (other side): platform (the image registry) · Provider ref: internal',
  ],
  platform: [
    '# Contract: Container platform (east and west; read-only)',
    'Status: Draft · Version 1.1 · Owner (OMR side): M4 Delivery (rollout proof), M3 Placement (withdrawal and drain proof), with M6 (secret sync status) · Owner (other side): platform (the clusters) · Provider ref: internal',
  ],
  mcp: [
    '# Contract: MCP task tools',
    'Status: Draft · Version 0.1 · Owner (OMR side): C1 Edge (`/mcp`), C2 (OAuth AS), each module (the command or query a tool maps to) · Owner (other side): the agent clients · Provider ref: internal',
  ],
  'secret-store': [
    '# Contract: Secret store',
    'Status: Draft · Version 1.0 · Owner (OMR side): M6 Credentials · Owner (other side): platform (the secret store and its policies) · Provider ref: internal',
  ],
  'operator-api': [
    '# Contract: Operator REST API',
    "Status: Draft · Version 0.2 · Owner (OMR side): C1 Edge (routes), each module (the command or query a route maps to) · Owner (other side): the operators' admin UI (`components/ui.md`) and scripts · Provider ref: internal",
  ],
  'plugin-hosts': [
    '# Contract: Shared plugin hosts',
    "Status: Draft · Version 1.0 · Owner (OMR side): M11 Plugins · Owner (other side): the hosts' maintainers · Provider ref: internal",
  ],
  policy: [
    '# Contract: Policy (rule table, `decide`, `explain`)',
    'Status: Draft · Version 0.2 · Owner (OMR side): C5 Policy · Owner (other side): C3 Command bus, C4 Query service, C6 Run engine (callers) and every module (rule rows, predicates) · Provider ref: internal',
  ],
  portal: [
    '# Contract: Acme portal',
    'Status: Draft · Version 1.1 · Owner (OMR side): C1 Edge (Portal API surface), M12 Memberships (scope), C8 (callbacks) · Owner (other side): the Acme portal team · Provider ref: internal',
  ],
  ports: [
    '# Contract: Ports (shared adapter rules)',
    'Status: Draft · Version 0.1 · Owner (OMR side): Adapters (A\\*), with C6 for the port guard · Owner (other side): every external contract in `contracts/` · Provider ref: internal',
  ],
  registrar: [
    '# Contract: Domain registrar',
    'Status: Draft · Version 1.1 · Owner (OMR side): M5 Custom domains and edge (registrations) · Owner (other side): the registrar · Provider ref: internal',
  ],
  renderer: [
    '# Contract: Renderer (facet contributions, reserved paths, determinism, receipts)',
    'Status: Draft · Version 0.1 · Owner (OMR side): M4 Delivery (assembly, serialisation, receipts) · Owner (other side): every module that registers a facet · Provider ref: internal',
  ],
  search: [
    '# Contract: Search index',
    'Status: Draft · Version 1.2 · Owner (OMR side): M1 Workspaces (indexing, binding, delete), with M6 (keys), M7 (export) and M5 (hostname claims) · Owner (other side): the search service · Provider ref: internal',
  ],
  'run-engine': [
    '# Contract: Run engine',
    'Status: Draft · Version 0.3 · Owner (OMR side): C6 Run engine · Owner (other side): modules (job definitions), C3 (start), C4 (queries) · Provider ref: internal',
  ],
  'notes-chart': [
    '# Contract: `notes-site` Helm chart',
    'Status: Draft · Version 1.0 · Owner (OMR side): M4 Delivery (renderer) · Owner (other side): the charts repository · Provider ref: internal',
  ],
  'step-spi': [
    '# Contract: Step SPI',
    'Status: Draft · Version 0.3 · Owner (OMR side): C6 Run engine · Owner (other side): every module that defines or exports steps · Provider ref: internal',
  ],
  stripe: [
    '# Contract: Stripe',
    "Status: Draft · Version 1.0 · Owner (OMR side): M8 Billing · Owner (other side): Stripe (third party); the money flows are the portal's (`contracts/portal.md`) · Provider ref: internal",
  ],
};

/** Line 1 and section 2 ("Owned data") of components/billing.md, adapters.md and ui.md. */
export const COMPONENT_SECTIONS: Record<string, string> = {
  billing:
    '# Component: M8 Billing\n\n## 1. Purpose\n\nLinks workspaces to Stripe and derives the billing state.\n\n## 2. Owned data\n\n| Table | Columns (type, null policy) |\n| ----- | --------------------------- |\n| `billing.billing_links` | id, state, `observedAt`; no nullable intent columns |\n| `billing.billing_observations` | id, state, `observedAt`; no nullable intent columns |\n| `billing.link_history` | id, state, `observedAt`; no nullable intent columns |\n| `billing.plan_revisions` | id, state, `observedAt`; no nullable intent columns |\n| `billing.entitlements` | id, state, `observedAt`; no nullable intent columns |\n| `billing.identity_tombstones` | id, state, `observedAt`; no nullable intent columns |\n| `billing.observation_hints` | id, state, `observedAt`; no nullable intent columns |\n| `billing.checkout_sessions` | id, state, `observedAt`; no nullable intent columns |\n| `billing.purchases` | id, state, `observedAt`; no nullable intent columns |\n\n## 3. Interface\n\nSee the table in `03-components.md`.\n',
  adapters:
    '# Component: Adapters and fakes (A\\*)\n\n## 2. Owned data\n\nNone. Fixtures live in `contracts/cases/<system>/fixtures/` (versioned with the contracts).\n\n## 3. Interface\n\nThe ports.\n',
  ui: '# Component: Admin UI\n\n## 2. Owned data\n\nNone on the server. Per-viewer conveniences (column choice, collapsed panels) live in browser storage.\n\n## 3. Interface\n\nThe screens.\n',
};

/** 02-system-context.md: two more places ADR-0024 is named. */
export const PAGE_02_ADR_0024 = [
  '| `portal`     | The Acme portal                   | Portal API     | Registered machine client: bearer + HMAC body signature + idempotency key; overlapping key rotation | Only workspaces with an **active membership** to it (ADR-0024); create, invite redemption, billing link, domain requests and status reads |',
  '| Which customer commercially owns a workspace                                                        | **Acme** (membership, ADR-0024)                | Authoritative; creation provenance is history only                                      |',
];

/** The Status line of all 27 ADR files, in the order of `ADR_TITLES`: 21 Proposed, 6 Accepted. */
export const ADR_STATUSES = [
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Accepted (Dana, 2026-10-14) · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Accepted (Dana, 2026-10-14); amends the global secrets standard · Date: 2026-10-14 · **v0 retired (S6b, 2026-10-22): `GET /ci/build-config` answers 410; there is no per-site switch**',
  'Status: Accepted (Dana, 2026-10-14) · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Proposed · Date: 2026-10-14',
  'Status: Accepted (standing rule: CI/CD variables hold registry credentials only); closes G3 (`contracts/git-host.md` §11) · Date: 2026-10-14 · Implemented by: `plan/rollout.md` PRE-01, prerequisite OB1',
  'Status: Accepted (Dana, 2026-10-15) · Date: 2026-10-15 · Amends: `components/health.md`, `contracts/checks.md`, `components/delivery.md`, `components/ui.md`',
  'Status: Accepted (Dana, 2026-10-15) · Date: 2026-10-15 · Supersedes: ADR-0005 (the money split) · Amends: ADR-0024, ADR-0026, `components/billing.md`, `contracts/portal.md`, and `plan/slices-1-2.md` A4',
] as const;

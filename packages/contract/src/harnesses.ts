/**
 * The tools that run an agent ("harnesses"), and what each one can be told.
 *
 * An agent has one identity, prompt and memory, and zero or more **profiles** —
 * one per tool, holding only that tool's native settings in that tool's own
 * vocabulary — plus a `default` profile for any tool without one
 * (docs/AGENT_REPO.md §V2.7). Everything the SPA renders for a profile, and
 * everything checkout writes from one, comes from this registry: adding a tool
 * is an entry here, its golden checkout file, and nothing else.
 *
 * Facts verified against each vendor's documentation on 2026-09-26. Tool
 * configuration moves fast, so each entry carries `verifiedAt`; re-verify when
 * touching one.
 */
import { z } from 'zod';
import { ownValue } from './own.js';

export const HARNESS_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'claude-ai',
  'copilot',
  'gemini-cli',
  'windsurf',
  'zed',
  'other',
] as const;
export type Harness = (typeof HARNESS_IDS)[number];
export const HARNESS_KEYS: readonly Harness[] = HARNESS_IDS;

/** A profile is for one harness, or `default` — used by any tool without its own. */
export type ProfileKey = Harness | 'default';
export const PROFILE_KEYS: readonly ProfileKey[] = [...HARNESS_IDS, 'default'];

export const CHECKOUT_MODES = ['primary', 'helper'] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];

/** Where a profile field takes effect. */
export type FieldWhere = 'helper' | 'project' | 'your-config';

export type SafeValues = 'any' | 'tool-names' | readonly (string | boolean)[];

export interface ProfileField {
  /** The key in the stored settings object — the tool's own name where it has one. */
  key: string;
  label: string;
  control: 'model' | 'select' | 'toggle' | 'text' | 'color';
  /** For `select` and `color`: value → label. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  hint: string;
  where: readonly FieldWhere[];
  /**
   * Which values of this field are SAFE: they leave the tool asking, sandboxed or
   * inert. Every field must say, and anything it does not name is treated as
   * **widening** — it lets the tool act without asking, or reach further — so a
   * new option, a boolean flipped the permissive way, or a value nobody classified
   * can only ever fail closed. A widening value is stored and rendered at checkout
   * only when the owner approved exactly that value from a browser session (§V2.7).
   *
   * - `'any'`: inert whatever it says (a model id, a colour, a reasoning level).
   * - `'tool-names'`: a comma-separated list that only *restricts* the tool, safe
   *   while every entry is a bare tool name; an entry with a parenthesised
   *   specifier (`Bash(git *)`) is permission syntax and widens.
   * - an array: exactly these values are safe (booleans compared as booleans).
   */
  safe: SafeValues;
  placeholder?: string;
}

export interface HarnessDef {
  id: Harness;
  label: string;
  short: string;
  /** "reads AGENTS.md" — shown on every picker entry, so nobody wonders whether Codex is covered. */
  reads: string;
  modes: readonly CheckoutMode[];
  /** What "helper" means in this tool, when it has one. */
  helperLabel?: string;
  fields: readonly ProfileField[];
  /** Why a tool has no fields, when it has none. */
  noFieldsNote?: string;
  verifiedAt: string;
  /** How this tool's OAuth client shows up, so a harness claim can be checked against it. */
  oauth?: HarnessOAuth;
}

export interface HarnessOAuth {
  /** The `client_name`s it registers, any case; a trailing `*` matches a prefix. One name may serve several tools. */
  names: readonly string[];
  /** Hostnames every registered redirect URI must be on, when the tool's are fixed. Absent: not checked. */
  redirectHosts?: readonly string[];
}

const opts = (...pairs: Array<[string, string]>) =>
  pairs.map(([value, label]) => ({ value, label }));

const MODEL_HINT =
  'From the model list an admin keeps current, or Custom… for any id the tool accepts.';

export const HARNESSES: Readonly<Record<Harness, HarnessDef>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    short: 'Claude Code',
    reads: 'reads CLAUDE.md and .claude/agents',
    modes: ['primary', 'helper'],
    helperLabel: 'a subagent in .claude/agents',
    verifiedAt: '2026-10-04',
    // "Claude" is the claude.ai connector, which Claude Code also reaches OMR through.
    oauth: { names: ['Claude', 'Claude Code*', 'omr-agent on *'] },
    fields: [
      {
        key: 'model',
        label: 'Model',
        control: 'model',
        hint: MODEL_HINT,
        where: ['helper', 'project'],
        safe: 'any',
      },
      {
        key: 'effort',
        label: 'Effort',
        control: 'select',
        options: opts(
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
          ['xhigh', 'Extra high'],
          ['max', 'Max'],
        ),
        hint: 'How hard Claude thinks. Written as `effort` for a subagent, `effortLevel` for the project.',
        where: ['helper', 'project'],
        safe: 'any',
      },
      {
        key: 'tools',
        label: 'Tools',
        control: 'text',
        placeholder: 'Leave blank to inherit tools',
        hint: 'Comma-separated Claude tool names, e.g. Read, Grep, Bash, or MCP tool names. Leave blank to inherit available tools; “All tools” is not a tool name.',
        where: ['helper'],
        safe: 'tool-names',
      },
      {
        key: 'disallowedTools',
        label: 'Blocked tools',
        control: 'text',
        placeholder: 'None',
        hint: 'Comma-separated tool names this agent may never use.',
        where: ['helper'],
        safe: 'any',
      },
      {
        key: 'permissionMode',
        label: 'Permissions',
        control: 'select',
        options: opts(
          ['default', 'Ask before edits'],
          ['acceptEdits', 'Accept edits'],
          ['plan', 'Plan only'],
          ['manual', 'Manual'],
          ['auto', 'Auto'],
          ['dontAsk', 'Don’t ask'],
          ['bypassPermissions', 'Bypass permissions'],
        ),
        hint: 'How much Claude may do without asking.',
        where: ['helper'],
        safe: ['default', 'plan', 'manual'],
      },
      {
        key: 'color',
        label: 'Colour',
        control: 'color',
        options: opts(
          ['blue', 'Blue'],
          ['cyan', 'Cyan'],
          ['green', 'Green'],
          ['yellow', 'Yellow'],
          ['orange', 'Orange'],
          ['red', 'Red'],
          ['pink', 'Pink'],
          ['purple', 'Purple'],
        ),
        hint: 'The subagent’s colour in Claude Code.',
        where: ['helper'],
        safe: 'any',
      },
    ],
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    short: 'Codex',
    reads: 'reads AGENTS.md',
    modes: ['primary', 'helper'],
    helperLabel: 'a custom agent in .codex/agents',
    verifiedAt: '2026-11-01',
    // Codex reaches OMR through `omr-agent login`, which registers `omr-agent on <host>` on a loopback redirect.
    oauth: { names: ['omr-agent on *'], redirectHosts: ['127.0.0.1', 'localhost', '[::1]'] },
    fields: [
      {
        key: 'model',
        label: 'Model',
        control: 'model',
        hint: MODEL_HINT,
        where: ['helper', 'project'],
        safe: 'any',
      },
      {
        key: 'model_reasoning_effort',
        label: 'Reasoning effort',
        control: 'select',
        options: opts(
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
          ['xhigh', 'Extra high'],
          ['max', 'Max'],
          ['ultra', 'Ultra'],
        ),
        hint: 'Which levels exist depends on the model.',
        where: ['helper', 'project'],
        safe: 'any',
      },
      {
        key: 'approval_policy',
        label: 'Approvals',
        control: 'select',
        options: opts(['on-request', 'Ask when needed'], ['never', 'Never ask']),
        hint: 'Project settings load only in projects Codex trusts.',
        where: ['project'],
        safe: ['on-request'],
      },
      {
        key: 'sandbox_mode',
        label: 'Sandbox',
        control: 'select',
        options: opts(
          ['read-only', 'Read only'],
          ['workspace-write', 'This workspace'],
          ['danger-full-access', 'Full disk access'],
        ),
        hint: 'What Codex’s commands may touch.',
        where: ['helper', 'project'],
        safe: ['read-only', 'workspace-write'],
      },
    ],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    short: 'Cursor',
    reads: 'reads .cursor/rules and AGENTS.md',
    modes: ['primary', 'helper'],
    helperLabel: 'a subagent in .cursor/agents',
    verifiedAt: '2026-09-26',
    fields: [
      {
        key: 'model',
        label: 'Model',
        control: 'model',
        hint: 'For the helper only — Cursor’s own model is set in the app.',
        where: ['helper'],
        safe: 'any',
      },
      {
        key: 'readonly',
        label: 'Read-only helper',
        control: 'toggle',
        hint: 'The helper may read but not change files.',
        where: ['helper'],
        safe: [true],
      },
      {
        key: 'is_background',
        label: 'Run in background',
        control: 'toggle',
        hint: 'The helper runs without blocking the main agent.',
        where: ['helper'],
        safe: 'any',
      },
    ],
  },
  'claude-ai': {
    id: 'claude-ai',
    label: 'Claude (claude.ai & Desktop)',
    short: 'Claude',
    reads: 'no files — uses the connector',
    modes: ['primary'],
    verifiedAt: '2026-09-26',
    oauth: { names: ['Claude', 'Claude.ai'], redirectHosts: ['claude.ai', 'claude.com'] },
    fields: [],
    noFieldsNote: 'Claude has no per-project settings — only added instructions.',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    short: 'Copilot',
    reads: 'reads AGENTS.md and .github/agents',
    modes: ['primary', 'helper'],
    helperLabel: 'a custom agent in .github/agents',
    verifiedAt: '2026-09-26',
    fields: [
      {
        key: 'model',
        label: 'Model',
        control: 'model',
        hint: 'Copilot names models by display name, e.g. “Claude Opus 4.5”.',
        where: ['helper'],
        safe: 'any',
      },
      {
        key: 'tools',
        label: 'Tools',
        control: 'text',
        placeholder: 'All tools',
        hint: 'Comma-separated, e.g. search/codebase, web/fetch. Empty means all tools.',
        where: ['helper'],
        safe: 'tool-names',
      },
      {
        key: 'target',
        label: 'Where it runs',
        control: 'select',
        options: opts(
          ['both', 'VS Code and GitHub'],
          ['vscode', 'VS Code'],
          ['github-copilot', 'GitHub'],
        ),
        hint: 'Which Copilot surfaces offer this agent.',
        where: ['helper'],
        safe: 'any',
      },
    ],
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    short: 'Gemini',
    reads: 'reads GEMINI.md',
    modes: ['primary', 'helper'],
    helperLabel: 'a subagent in .gemini/agents',
    verifiedAt: '2026-09-26',
    fields: [
      {
        key: 'model',
        label: 'Model',
        control: 'model',
        hint: MODEL_HINT,
        where: ['helper', 'project'],
        safe: 'any',
      },
      {
        key: 'approvalMode',
        label: 'Approvals',
        control: 'select',
        options: opts(['default', 'Default'], ['auto_edit', 'Auto-edit'], ['plan', 'Plan only']),
        hint: 'Written as general.defaultApprovalMode in the project settings.',
        where: ['project'],
        safe: ['default', 'plan'],
      },
      {
        key: 'sandbox',
        label: 'Sandbox',
        control: 'toggle',
        hint: 'Run tools inside Gemini’s sandbox.',
        where: ['project'],
        safe: [true],
      },
    ],
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf (Devin Desktop)',
    short: 'Windsurf',
    reads: 'reads .windsurf/rules and AGENTS.md',
    modes: ['primary'],
    verifiedAt: '2026-09-26',
    fields: [],
    noFieldsNote: 'Windsurf reads only instructions from a project — its model is set in the app.',
  },
  zed: {
    id: 'zed',
    label: 'Zed',
    short: 'Zed',
    reads: 'reads the first rules file it finds',
    modes: ['primary'],
    verifiedAt: '2026-09-26',
    fields: [
      {
        key: 'model',
        label: 'Model',
        control: 'model',
        hint: 'provider/model, e.g. anthropic/claude-opus. Goes in your Zed settings.',
        where: ['your-config'],
        safe: 'any',
      },
      {
        key: 'toolPermissions',
        label: 'Tool approvals',
        control: 'select',
        options: opts(['confirm', 'Ask'], ['allow', 'Always allow']),
        hint: 'agent.tool_permissions.default in your Zed settings.',
        where: ['your-config'],
        safe: ['confirm'],
      },
    ],
  },
  other: {
    id: 'other',
    label: 'Other tool (AGENTS.md)',
    short: 'AGENTS.md',
    reads: 'any tool that reads AGENTS.md',
    modes: ['primary'],
    verifiedAt: '2026-09-26',
    fields: [],
    noFieldsNote: 'Any tool that reads AGENTS.md. Connect On My Radar however your tool does it.',
  },
};

/** The `default` profile holds only an addendum: there is no universal model. */
export const DEFAULT_PROFILE_NOTE =
  'Used by any tool without its own profile. There is no universal model, so this is instructions only.';

/**
 * The harness an agent meant, when it spelled one differently. Agents guess —
 * `claude_code`, `ClaudeCode`, `codex-cli`, `AGENTS.md` — and each of those names
 * exactly one tool. v1's ids are kept forever: `agents-md` → `other`,
 * `cursor-rules` → `cursor`, `subagent` mode → `helper`.
 */
const HARNESS_ALIASES: Readonly<Record<string, Harness>> = {
  claudecode: 'claude-code',
  'claude-code-cli': 'claude-code',
  'codex-cli': 'codex',
  'openai-codex': 'codex',
  codexcli: 'codex',
  'cursor-rules': 'cursor',
  cursorrules: 'cursor',
  'cursor-rule': 'cursor',
  'claude-ai': 'claude-ai',
  claudeai: 'claude-ai',
  'claude-desktop': 'claude-ai',
  'github-copilot': 'copilot',
  'copilot-cli': 'copilot',
  vscode: 'copilot',
  gemini: 'gemini-cli',
  geminicli: 'gemini-cli',
  'devin-desktop': 'windsurf',
  devin: 'windsurf',
  cascade: 'windsurf',
  'agents-md': 'other',
  agentsmd: 'other',
  'agents.md': 'other',
  'mcp-prompt': 'claude-ai',
};

export function normalizeHarness(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const folded = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-');
  return (
    ownValue(HARNESS_ALIASES, folded) ??
    ownValue(HARNESS_ALIASES, raw.trim().toLowerCase()) ??
    folded
  );
}

/** A harness name to its registry id, or null when it names none. */
export function resolveHarness(raw: unknown): Harness | null {
  const value = normalizeHarness(raw);
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
    ? (value as Harness)
    : null;
}

/** `verified`: the OAuth client matches the tool. `mismatch`: it is a different tool's. `claimed`: nothing to check it against. */
export type HarnessCheck = 'verified' | 'claimed' | 'mismatch';

/** What the audit trail shows beside a tool name. */
export interface HarnessVerdict {
  harnessCheck: HarnessCheck;
  /** The OAuth client the connection registered as, when it was one. */
  client: string | null;
}

const hostOf = (uri: string): string => {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** The tools whose OAuth client can be called `name` (any case). */
function harnessesNamed(name: string): Harness[] {
  const have = name.trim().toLowerCase();
  return HARNESS_IDS.filter((id) =>
    HARNESSES[id].oauth?.names.some((n) => {
      const want = n.toLowerCase();
      return want.endsWith('*') ? have.startsWith(want.slice(0, -1)) : have === want;
    }),
  );
}

/**
 * The tool a `load_agent` that named none is running in: the one tool its OAuth
 * client can be (`Claude Code*`), or null when it could be several (`omr-agent
 * on *` serves Claude Code and Codex, so its bridge says which it is installed
 * for) or none. A claim still wins; this only fills the gap.
 */
export function inferHarness(clientName: string | null | undefined): Harness | null {
  const named = clientName?.trim() ? harnessesNamed(clientName) : [];
  return named.length === 1 ? (named[0] as Harness) : null;
}

/**
 * Check the tool an agent said it ran in against the OAuth client it connected
 * through. `client` is null for a token, a browser session or a connection that
 * has since been removed: those can only ever be `claimed`.
 */
export function harnessCheck(
  claim: string | null | undefined,
  client: { name: string | null; redirectUris: readonly string[] } | null,
): HarnessCheck {
  const claimed = resolveHarness(claim);
  const name = client?.name?.trim().toLowerCase();
  if (!client || !name || !claimed || claimed === 'other') return 'claimed';
  const named = harnessesNamed(name);
  if (!named.includes(claimed)) return named.length ? 'mismatch' : 'claimed';
  const hosts = HARNESSES[claimed].oauth?.redirectHosts;
  if (!hosts) return 'verified';
  return client.redirectUris.length > 0 &&
    client.redirectUris.every((u) => hosts.includes(hostOf(u)))
    ? 'verified'
    : 'claimed';
}

export function normalizeCheckoutMode(raw: unknown): unknown {
  return raw === 'subagent' ? 'helper' : raw;
}

const HARNESS_LIST = HARNESS_IDS.map((key) => `'${key}'`).join(', ');

export const harnessSchema = z.preprocess(
  normalizeHarness,
  z.enum(HARNESS_IDS as unknown as [Harness, ...Harness[]], {
    errorMap: (issue, ctx) =>
      issue.code === 'invalid_enum_value'
        ? { message: `Unknown tool '${String(issue.received)}'. Use one of ${HARNESS_LIST}.` }
        : { message: ctx.defaultError },
  }),
);

export const profileKeySchema = z.preprocess(
  (raw) => (raw === 'default' ? raw : normalizeHarness(raw)),
  z.enum(PROFILE_KEYS as unknown as [ProfileKey, ...ProfileKey[]], {
    errorMap: () => ({ message: `A profile is for one of ${HARNESS_LIST}, or 'default'.` }),
  }),
);

export const checkoutModeSchema = z.preprocess(normalizeCheckoutMode, z.enum(CHECKOUT_MODES));

/* ------------------------------ profile values ---------------------------- */

/** Model ids: `opus`, `gpt-5-codex`, `anthropic/claude-opus`, `Claude Opus 4.5`, `opus[1m]`. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]() -]{0,119}$/;
/** Tool lists: `Read, Grep, Bash(git *)`, `search/codebase`. */
const TOOL_LIST_PATTERN = /^[A-Za-z0-9_.,:*()/ -]{0,400}$/;

/** Exact vendor names, not permission to use them in any particular session.
 * https://code.claude.com/docs/en/tools-reference (verified 2026-10-04).
 * Task is the documented compatibility alias for Agent. MCP tools depend on
 * the caller's connected servers; their names are validated structurally.
 */
const CLAUDE_TOOL_NAMES = new Set([
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]);

/** Commas inside Agent(worker, researcher) are not list separators. */
function claudeToolEntries(raw: string): string[] | null {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '(' && ++depth > 1) return null;
    if (char === ')' && --depth < 0) return null;
    if (char === ',' && depth === 0) {
      entries.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  entries.push(raw.slice(start).trim());
  return depth || entries.some((entry) => !entry) ? null : entries;
}

function validClaudeTool(entry: string, blocked: boolean): boolean {
  if (entry === 'mcp__*') return blocked;
  if (/^mcp__[A-Za-z0-9][A-Za-z0-9_-]*(?:__(?:[A-Za-z0-9][A-Za-z0-9_.-]*|\*))?$/.test(entry))
    return true;
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\(([^()]+)\))?$/.exec(entry);
  return Boolean(match && CLAUDE_TOOL_NAMES.has(match[1] ?? ''));
}

/** Missing/blank tools means inheritance. Never turn an invalid restriction
 * into inheritance by silently dropping it during import or checkout.
 */
function validateClaudeToolList(name: string, raw: string): string | null {
  const entries = claudeToolEntries(raw);
  const invalid = entries?.find((entry) => !validClaudeTool(entry, name === 'disallowedTools'));
  if (!entries || invalid)
    return `Claude Code '${name}' contains ${invalid ? `an unrecognized tool '${invalid}'` : 'an invalid tool list'}. Use comma-separated exact Claude or MCP tool names. Leave Tools blank to inherit available tools.`;
  return null;
}

export type ProfileSettings = Record<string, string | boolean>;

/** A rejected value, for an error message: strings as themselves, anything else as JSON. */
function shown(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  // Settings arrive as parsed JSON, so anything else is a boolean, number or null.
  return raw === undefined ? 'nothing' : JSON.stringify(raw);
}

/**
 * Validate a profile's settings against its tool's fields: unknown keys and
 * values outside a field's options are refused by name. Every value that can
 * reach a rendered file is a closed option or matches a charset that cannot
 * carry a line break or a quote — these values go into YAML, TOML and JSON.
 */
export function validateProfileSettings(
  key: ProfileKey,
  settings: Record<string, unknown>,
): { ok: true; value: ProfileSettings } | { ok: false; message: string } {
  const fields = key === 'default' ? [] : HARNESSES[key].fields;
  const value: ProfileSettings = {};
  for (const [name, raw] of Object.entries(settings)) {
    if (raw === null || raw === undefined || raw === '') continue;
    const field = fields.find((f) => f.key === name);
    const toolName = key === 'default' ? 'The default profile' : HARNESSES[key].label;
    if (!field)
      return {
        ok: false,
        message: `${toolName} has no setting '${name}'. Its settings: ${fields.map((f) => f.key).join(', ') || 'none'}.`,
      };
    switch (field.control) {
      case 'toggle':
        if (typeof raw !== 'boolean') return { ok: false, message: `'${name}' is on or off.` };
        value[name] = raw;
        break;
      case 'select':
      case 'color':
        if (typeof raw !== 'string' || !field.options?.some((o) => o.value === raw))
          return {
            ok: false,
            message: `'${shown(raw)}' is not a ${field.label.toLowerCase()} ${toolName} accepts.`,
          };
        value[name] = raw;
        break;
      case 'model':
        if (typeof raw !== 'string' || !MODEL_ID_PATTERN.test(raw.trim()))
          return { ok: false, message: `'${shown(raw)}' is not a model id.` };
        value[name] = raw.trim();
        break;
      case 'text':
        if (typeof raw !== 'string' || !TOOL_LIST_PATTERN.test(raw))
          return { ok: false, message: `'${name}' has characters that can’t go in a config file.` };
        if (key === 'claude-code' && (name === 'tools' || name === 'disallowedTools')) {
          if (!raw.trim()) continue;
          const error = validateClaudeToolList(name, raw.trim());
          if (error) return { ok: false, message: error };
        }
        value[name] = raw.trim();
        break;
    }
  }
  return { ok: true, value };
}

/** Comma-separated bare tool names: no parenthesised specifier, which is permission syntax. */
function bareToolNames(raw: string): boolean {
  const entries = raw.split(',').map((entry) => entry.trim());
  return entries.every((entry) => /^[A-Za-z0-9_.:/*-]+$/.test(entry));
}

/**
 * Whether this value of this field is permission-widening: anything the field
 * does not explicitly classify as safe. An unset value (nothing, null, '') is the
 * tool's own default and never widens. Comparison is exact on purpose — there is
 * no normalising that could turn `Danger-Full-Access` or ` never ` into a safe
 * value, because only exact members of `safe` are safe.
 */
export function fieldWidens(field: ProfileField, raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return false;
  const safe = field.safe;
  if (safe === 'any') return false;
  if (safe === 'tool-names') return typeof raw !== 'string' || !bareToolNames(raw);
  return !(safe as readonly unknown[]).includes(raw);
}

/** How a widening value is recorded in `approved_widening`: strings as they are, booleans as text. */
function wideningText(value: string | boolean): string {
  return String(value);
}

/** What a widening value reads as in a "withheld" line. */
function wideningLabel(field: ProfileField, value: string | boolean): string {
  const shown =
    typeof value === 'boolean'
      ? value
        ? 'on'
        : 'off'
      : (field.options?.find((o) => o.value === value)?.label ?? value);
  return `${field.label}: ${shown}`;
}

/** The permission-widening entries of `settings`, keyed by settings key. */
export function wideningValues(
  harness: Harness,
  settings: ProfileSettings,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of HARNESSES[harness].fields) {
    const value = settings[field.key];
    if (value !== undefined && fieldWidens(field, value)) out[field.key] = wideningText(value);
  }
  return out;
}

/**
 * The settings with every permission-widening value removed unless `approved`
 * (the owner's recorded browser decision, `{ key: value }`) names exactly that
 * value, and what was removed. A value nobody approved is unattributed and is
 * never rendered onto a machine.
 */
export function withoutUnapprovedWidening(
  harness: Harness,
  settings: ProfileSettings,
  approved: Readonly<Record<string, string>>,
): { settings: ProfileSettings; stripped: string[] } {
  const unapproved = new Set<string>();
  const stripped: string[] = [];
  for (const field of HARNESSES[harness].fields) {
    const value = settings[field.key];
    if (
      value !== undefined &&
      fieldWidens(field, value) &&
      !(Object.hasOwn(approved, field.key) && approved[field.key] === wideningText(value))
    ) {
      unapproved.add(field.key);
      stripped.push(wideningLabel(field, value));
    }
  }
  return {
    settings: Object.fromEntries(Object.entries(settings).filter(([key]) => !unapproved.has(key))),
    stripped,
  };
}

/** The settings with every permission-widening value removed, and what was removed. */
export function withoutWideningValues(
  harness: Harness,
  settings: ProfileSettings,
): { settings: ProfileSettings; stripped: string[] } {
  return withoutUnapprovedWidening(harness, settings, {});
}

/** Short chips for a profile card: the model first, then the choices that differ from default. */
export function profileSummary(
  harness: ProfileKey,
  settings: ProfileSettings,
): { model: string | null; chips: string[] } {
  if (harness === 'default') return { model: null, chips: ['Instructions only'] };
  const chips: string[] = [];
  let model: string | null = null;
  for (const field of HARNESSES[harness].fields) {
    const value = settings[field.key];
    if (value === undefined || value === '' || value === false) continue;
    if (field.key === 'model') {
      model = String(value);
      continue;
    }
    if (field.control === 'toggle') chips.push(field.label);
    else if (field.control === 'select' || field.control === 'color')
      chips.push(
        `${field.label}: ${field.options?.find((o) => o.value === value)?.label ?? String(value)}`,
      );
    else chips.push(`${field.label}: ${String(value)}`);
  }
  return { model, chips };
}

/* ------------------------------- connecting -------------------------------- */

/** The `omr-agent` release this contract expects; a test pins it to `agent-setup/omr-agent.mjs`. */
export const OMR_AGENT_VERSION = '0.4.0';

/** `omr-agent/0.3.2` from a User-Agent, or null when it is not an omr-agent's. */
export function omrAgentVersion(userAgent: string | null | undefined): string | null {
  return /(?:^|\s)omr-agent\/(\d+\.\d+\.\d+)/.exec(userAgent ?? '')?.[1] ?? null;
}

/** True when `a` is an older release than `b` (both `x.y.z`). */
export function versionBefore(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++)
    if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0);
  return false;
}

/**
 * The tools Codex may run without asking. The server marks every read tool
 * read-only, which Codex already approves, so these are the writes an agent's
 * own loop needs. Not `agent_forget`, `update_agent_brief`, deletes or shares.
 */
export const CODEX_APPROVED_TOOLS = [
  'load_agent',
  'agent_remember',
  'create_blip',
  'update_blip',
  'claim_blip',
  'create_comment',
  'react_to_blip',
  'request_decision',
  'mark_notifications_read',
] as const;

/** The `[mcp_servers.<server>.tools.<tool>]` tables that approve them. */
export function codexApprovalTables(server: string): string {
  return CODEX_APPROVED_TOOLS.map(
    (tool) => `[mcp_servers.${server}.tools.${tool}]\napproval_mode = "approve"`,
  ).join('\n\n');
}

export interface ConnectInstructions {
  /** `command` to run once; `file` to add to; `ui` to click through. */
  kind: 'command' | 'file' | 'ui';
  path: string | null;
  content: string;
  note: string;
}

/**
 * How to connect On My Radar's MCP server to a tool. **No token is ever written
 * into a project file**: every snippet reads it from `$OMR_TOKEN` or the tool's
 * own secret prompt, or uses OAuth where the tool does it.
 */
export function connectInstructions(harness: Harness, mcpUrl: string): ConnectInstructions {
  switch (harness) {
    case 'claude-code':
      return {
        kind: 'command',
        path: null,
        content: `claude mcp add --transport http onmyradar ${mcpUrl} \\\n  --header "Authorization: Bearer $OMR_TOKEN"`,
        note: 'Run once on this machine, with OMR_TOKEN set to a token for this machine.',
      };
    case 'codex':
      return {
        kind: 'file',
        path: '~/.codex/config.toml',
        // Verified against Codex 0.160 (2026-11-01, real `codex exec`): a tool the
        // server marks read-only is approved by default; one that writes is refused
        // when Codex cannot stop to ask (`codex exec`, approval_policy "never"), so
        // load_agent and the agent's own writes need `approval_mode = "approve"` per
        // tool. Only those: deleting, editing a prompt or sharing stays on ask.
        content: `[mcp_servers.onmyradar]\nurl = ${JSON.stringify(mcpUrl)}\nbearer_token_env_var = "OMR_TOKEN"\n\n${codexApprovalTables('onmyradar')}`,
        note:
          'Add to your Codex config, with OMR_TOKEN set in your environment. ' +
          'The approval_mode lines let Codex run an agent’s loop without asking — loading it, remembering, ' +
          'capturing and updating blips, claiming, commenting, reacting, requesting a decision and ' +
          'clearing notifications. Reads need no line. Everything else (forgetting, deleting, sharing, editing prompts) still asks.',
      };
    case 'cursor':
      return {
        kind: 'file',
        path: '~/.cursor/mcp.json',
        content: JSON.stringify(
          {
            mcpServers: {
              onmyradar: { url: mcpUrl, headers: { Authorization: 'Bearer ${env:OMR_TOKEN}' } },
            },
          },
          null,
          2,
        ),
        note: 'Merge into your Cursor MCP config, with OMR_TOKEN set in your environment.',
      };
    case 'claude-ai':
      return {
        kind: 'ui',
        path: null,
        content: mcpUrl,
        note: 'Settings → Connectors → Add custom connector → paste this URL, then sign in.',
      };
    case 'copilot':
      return {
        kind: 'file',
        path: '.vscode/mcp.json',
        content: JSON.stringify(
          {
            inputs: [
              {
                type: 'promptString',
                id: 'omr-token',
                description: 'On My Radar token',
                password: true,
              },
            ],
            servers: {
              onmyradar: {
                type: 'http',
                url: mcpUrl,
                headers: { Authorization: 'Bearer ${input:omr-token}' },
              },
            },
          },
          null,
          2,
        ),
        note: 'VS Code asks for the token once and keeps it out of the file.',
      };
    case 'gemini-cli':
      return {
        kind: 'command',
        path: null,
        content: `gemini mcp add --scope user --transport http \\\n  --header "Authorization: Bearer $OMR_TOKEN" onmyradar ${mcpUrl}`,
        note: 'Run once on this machine, with OMR_TOKEN set.',
      };
    case 'windsurf':
      return {
        kind: 'file',
        path: '~/.config/devin/mcp_config.json',
        content: JSON.stringify(
          {
            mcpServers: {
              onmyradar: {
                serverUrl: mcpUrl,
                headers: { Authorization: 'Bearer ${env:OMR_TOKEN}' },
              },
            },
          },
          null,
          2,
        ),
        note: 'Windsurf’s MCP config is global — merge this in, with OMR_TOKEN set.',
      };
    case 'zed':
      return {
        kind: 'file',
        path: '~/.config/zed/settings.json',
        content: JSON.stringify({ context_servers: { onmyradar: { url: mcpUrl } } }, null, 2),
        note: 'With no Authorization header Zed signs you in with OAuth.',
      };
    case 'other':
      return {
        kind: 'ui',
        path: null,
        content: mcpUrl,
        note: 'Add this as a remote (streamable HTTP) MCP server however your tool does it.',
      };
  }
}

/* ------------------------------- model catalog ----------------------------- */

export interface ModelSeed {
  harness: Harness;
  modelId: string;
  displayName: string;
  family: string;
}

/**
 * What migration 0038 seeds the model catalog with. After that the database is
 * the list, and an admin keeps it current in /admin without a deploy.
 */
export const MODEL_CATALOG_SEED: readonly ModelSeed[] = [
  { harness: 'claude-code', modelId: 'opus', displayName: 'Opus (latest)', family: 'Claude' },
  { harness: 'claude-code', modelId: 'sonnet', displayName: 'Sonnet (latest)', family: 'Claude' },
  { harness: 'claude-code', modelId: 'haiku', displayName: 'Haiku (latest)', family: 'Claude' },
  { harness: 'claude-code', modelId: 'fable', displayName: 'Fable (latest)', family: 'Claude' },
  { harness: 'claude-code', modelId: 'inherit', displayName: 'Same as the session', family: 'Any' },
  { harness: 'codex', modelId: 'gpt-5-codex', displayName: 'gpt-5-codex', family: 'GPT' },
  { harness: 'codex', modelId: 'gpt-5', displayName: 'gpt-5', family: 'GPT' },
  { harness: 'cursor', modelId: 'inherit', displayName: 'Same as Cursor', family: 'Any' },
  {
    harness: 'copilot',
    modelId: 'Claude Opus 4.5',
    displayName: 'Claude Opus 4.5',
    family: 'Claude',
  },
  { harness: 'copilot', modelId: 'GPT-5', displayName: 'GPT-5', family: 'GPT' },
  {
    harness: 'gemini-cli',
    modelId: 'gemini-2.5-pro',
    displayName: 'gemini-2.5-pro',
    family: 'Gemini',
  },
  {
    harness: 'gemini-cli',
    modelId: 'gemini-2.5-flash',
    displayName: 'gemini-2.5-flash',
    family: 'Gemini',
  },
  {
    harness: 'zed',
    modelId: 'anthropic/claude-opus',
    displayName: 'Anthropic · Claude Opus',
    family: 'Claude',
  },
];

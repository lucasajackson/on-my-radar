/**
 * The Agent Repo over MCP: tools (Layer 1 and the checkout, Layer 2), a
 * prompt and resources (Layer 3). `docs/AGENT_REPO.md` is the long version.
 *
 * Every tool is a thin wrapper over the services the REST routes call, with the
 * same `Actor`. No refusal lives here — a tool wrapper may add a better
 * sentence, never a new "no" (DESIGN §22).
 */
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AGENT_REPO,
  CHECKOUT_MODES,
  MAX_REVISION,
  HARNESS_IDS,
  HARNESSES,
  MEMORY_AUTHOR_FILTERS,
  MEMORY_SORTS,
  MEMORY_TYPE_KEYS,
  REMEMBER_MODES,
  activitySchema,
  briefNameSchema,
  checkoutSchema,
  createRepoAgentSchema,
  importAgentSchema,
  profileSettingsSchema,
  setProfileSchema,
  loadAgentSchema,
  memoryNameSchema,
  recallSchema,
  rememberSchema,
  renameBriefSchema,
  updateBriefSchema,
  updatePromptSchema,
  updateRepoAgentSchema,
  forgetSchema,
  type RepoAgentDto,
} from '@onmyradar/contract';
import type { Actor } from '../http.js';
import {
  forget,
  loadAgent,
  loadBlocks,
  recall,
  recallPage,
  remember,
} from '../services/agent-memory.js';
import {
  agentActivity,
  checkoutAgent,
  createRepoAgent,
  exportAgent,
  getBrief,
  getPromptVersion,
  importAgent,
  listBriefs,
  listProfiles,
  listRepoAgents,
  removeProfile,
  setProfile,
  renameBrief,
  updateBrief,
  updatePrompt,
  updateRepoAgent,
} from '../services/repo-agents.js';
import { boundary, guard, guardResult } from './result.js';
import { ApiError, badRequest } from '../http.js';

const AGENT_ARG = z
  .string()
  .min(1)
  .describe('The agent: its id (preferred), your own slug, or a shared agent’s `ref`.');
const SESSION_ARG = z.string().uuid().describe('The session load_agent returned.');

const TOOL_IDS = HARNESS_IDS.map((id) => `'${id}'`).join(', ');
const HARNESS_ARG = z.string().max(40).describe(`Tool: ${TOOL_IDS}.`);

export const AGENT_REPO_INSTRUCTIONS = `

The Agent Repo holds agents (a name, a system prompt, per-tool profiles and a memory) that follow the person to any device and tool. If the person names an agent, or the workspace has .omr/agent.json or an On My Radar agent block in AGENTS.md/CLAUDE.md, call \`load_agent\` first (say which tool you are) and adopt the prompt it returns. Save what you learn with \`agent_remember\`, never to memory files on disk, and pass the same session on create_blip, update_blip and comments to write under the agent's name, cosigned by the person. \`update_agent_prompt\` proposes a change to your own prompt: it takes effect only when its owner accepts, so keep running the version you loaded, and say what changed and why in \`note\`. Briefs are the facts about the product an agent works on (how to run, test and deploy it, invariants, gotchas), and On My Radar is their source of truth: \`load_agent\` lists them by name, read one with \`get_agent_brief\` when your task touches it, and keep it true with \`update_agent_brief\` (with your session) in the same work that changes it. Read another agent's brief by naming that agent; change it from a session of that agent. \`checkout_agent\` returns the exact files that bootstrap an agent in a workspace: apply them verbatim.`;

/**
 * `load_agent`'s multi-block result, inside the same error boundary as every
 * other tool.
 *
 * **Text only — no `structuredContent`.** This result once carried a small
 * `structuredContent` beside the blocks: session, agent and counts. The MCP spec
 * lets a client prefer structured content over text, and Claude Code does — the
 * model was handed the counts and never saw the prompt, the rules or the index.
 * A real session reported "it came with no system prompt and no earlier
 * memories" and ignored its prompt. The session id is in the last text block
 * already, so structured content added nothing but a lossy view that some
 * clients show *instead*. `mcp/structured-content.test.ts` holds the rule for
 * every tool.
 */
function loadResult(actor: Actor, agent: string, raw: unknown) {
  return guardResult('load_agent', async () => {
    const loaded = await loadAgent(actor, agent, loadAgentSchema.parse(raw));
    return { content: loadBlocks(loaded).map((text) => ({ type: 'text' as const, text })) };
  });
}

export function registerAgentRepo(server: McpServer, actor: Actor): void {
  /* ------------------------------- Layer 1 ------------------------------- */

  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description:
        'Agents in the person’s Agent Repo, their own or shared with them: id, handle, name, a ' +
        'short description, what the caller may do to each, the prompt version and whether the ' +
        'prompt is locked or open to other agents’ live edits. Compact by default; pass ' +
        'detail: true for the tools each has profiles for, memory counts by type and the last ' +
        'session. A shared agent the person has not accepted cannot be loaded; they accept it ' +
        'in On My Radar.',
      inputSchema: {
        view: z
          .enum(['mine', 'shared', 'archived'])
          .optional()
          .describe('mine (default): their own; shared: shared with them; archived'),
        includeArchived: z.boolean().optional().describe('Deprecated: the same as view "archived"'),
        detail: z
          .boolean()
          .optional()
          .describe('Full description, profiles, memory counts and last session'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ view, includeArchived, detail }) =>
      guard('list_agents', async () =>
        (
          await listRepoAgents(actor, { view: view ?? (includeArchived ? 'archived' : undefined) })
        ).map((a) => ({
          id: a.id,
          slug: a.slug,
          // Only a shared agent's ref differs from its handle.
          ...(a.ref !== a.slug ? { ref: a.ref } : {}),
          name: a.name,
          description: a.description.slice(0, detail ? 300 : 80),
          role: a.role,
          ...(a.role === 'shared' ? { owner: a.owner.name ?? a.owner.email } : {}),
          access: a.access,
          promptVersion: a.promptVersion,
          ...(a.acceptedVersion !== null ? { runsVersion: a.acceptedVersion } : {}),
          ...(a.awaitingAccept ? { awaitingAccept: true } : {}),
          ...(a.lockPrompt ? { promptLocked: true } : {}),
          ...(a.agentEditsLive ? { agentEditsLive: true } : {}),
          ...(a.archived ? { archived: true } : {}),
          ...(detail
            ? {
                primaryTool: a.primaryHarness,
                profiles: a.profiles.map((p) => p.harness),
                memories: a.memoryCounts,
                lastSession: a.lastSession,
              }
            : {}),
        })),
      ),
  );

  server.registerTool(
    'load_agent',
    {
      title: 'Load an agent',
      description:
        'Load an agent at session start: returns its system prompt with this tool’s addendum ' +
        '(adopt it as your operating instructions), the memory rules, the memory index ' +
        'within a budget, pinned memories, the index of its briefs (read one with ' +
        'get_agent_brief), unread @-mentions, and a session id. Pass that session on memory ' +
        'writes and on create_blip/update_blip/drop/comments to write under the agent’s ' +
        'name. Call this first when a workspace or the person names an agent. If the start-up ' +
        'hook already loaded it ("already loaded, session X"), use that session instead of loading again.',
      inputSchema: {
        agent: AGENT_ARG,
        version: loadAgentSchema.shape.version.describe(
          'A pinned prompt version, when .omr/agent.json pins one. Absent means live.',
        ),
        harness: HARNESS_ARG.optional().describe(
          `Optional: which tool you are (${TOOL_IDS}; aliases such as 'codex-cli' work). Picks the agent’s profile for that tool (its addendum is appended to the prompt) and is recorded on your writes. Profile settings are advisory; omitting harness only skips the addendum.`,
        ),
        workspace: loadAgentSchema.shape.workspace.describe(
          'The directory or project you are working in. Recorded as provenance.',
        ),
        budget: z
          .number()
          .int()
          .min(2_000)
          .max(AGENT_REPO.indexBudgetMax)
          .optional()
          .describe(
            `Characters for the memory index and pinned bodies (default ${AGENT_REPO.indexBudgetDefault}).`,
          ),
      },
    },
    async ({ agent, ...rest }) => loadResult(actor, agent, rest),
  );

  server.registerTool(
    'agent_recall',
    {
      title: 'Recall memories',
      description:
        'Search an agent’s memory by words, fetch one by name, or list by type. Returns { ' +
        'memories, nextCursor } with full bodies and each memory’s revision (pass it to ' +
        'agent_remember to update). When nextCursor is not null, pass it back as cursor with ' +
        'the same filters for the next page.',
      inputSchema: {
        agent: AGENT_ARG,
        query: recallSchema.shape.query.describe('Words to search for'),
        name: memoryNameSchema.optional().describe('Fetch exactly this memory'),
        type: z.enum(MEMORY_TYPE_KEYS as [string, ...string[]]).optional(),
        writtenBy: z
          .enum(MEMORY_AUTHOR_FILTERS)
          .optional()
          .describe(
            'Only memories whose latest revision was written by: agent, people, import or collaborators',
          ),
        sort: z.enum(MEMORY_SORTS).optional().describe('recent (default), name or type'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: recallSchema.shape.cursor.describe('nextCursor from the previous page'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, ...rest }) =>
      guard('agent_recall', () => recallPage(actor, agent, recallSchema.parse(rest))),
  );

  server.registerTool(
    'agent_remember',
    {
      title: 'Remember',
      description:
        'Write to the agent’s memory inside a load session. mode "create" (needs type and ' +
        'description; a near-repeat of a memory you hold is refused with that memory named, ' +
        'and allowSimilar: true overrides), "update" (needs the expectedRevision you read; a ' +
        'stale one is refused with the current body so you can merge) or "append" (adds a ' +
        'dated paragraph, no revision). Nothing here notifies anybody or fetches anything.',
      inputSchema: {
        agent: AGENT_ARG,
        session: SESSION_ARG,
        name: memoryNameSchema.describe('kebab-case key, e.g. "postgres-constraint-traps"'),
        mode: z.enum(REMEMBER_MODES).optional().describe('create (default), update or append'),
        type: z
          .enum(MEMORY_TYPE_KEYS as [string, ...string[]])
          .optional()
          .describe('feedback, user, project or reference — required to create'),
        description: rememberSchema.shape.description.describe(
          'One line for the index — required to create',
        ),
        body: rememberSchema.shape.body.describe('Markdown. For append, the paragraph to add.'),
        expectedRevision: rememberSchema.shape.expectedRevision.describe(
          'The revision you read — required for update',
        ),
        allowSimilar: rememberSchema.shape.allowSimilar.describe(
          'create only: pass true when this really differs from the similar memory the refusal ' +
            'names',
        ),
      },
      annotations: { destructiveHint: false },
    },
    async ({ agent, ...rest }) =>
      guard('agent_remember', () => remember(actor, agent, rememberSchema.parse(rest))),
  );

  server.registerTool(
    'agent_forget',
    {
      title: 'Forget',
      description:
        'Forget a memory that is wrong or obsolete, inside a load session, saying why. Name ' +
        'it by `name` or the `id` agent_recall returned. A person can restore it for 30 ' +
        'days. Prefer an update when it is mostly right.',
      inputSchema: {
        agent: AGENT_ARG,
        session: SESSION_ARG,
        name: memoryNameSchema.optional().describe('The memory’s name — or pass id instead'),
        id: forgetSchema.shape.id.describe('The memory’s id, as agent_recall returned it'),
        reason: forgetSchema.shape.reason,
      },
      annotations: { destructiveHint: true },
    },
    async ({ agent, ...rest }) =>
      guard('agent_forget', () => forget(actor, agent, forgetSchema.parse(rest))),
  );

  server.registerTool(
    'create_agent',
    {
      title: 'Create an agent',
      description:
        'Add an agent to the person’s Agent Repo: a name (the @handle is derived unless you ' +
        'pass slug), a description, a first system prompt, the tool it mostly runs in and ' +
        'that tool’s profile settings. Inert until somebody loads it; sharing is the ' +
        'person’s decision in On My Radar. To import an existing agent in one call, pass ' +
        'profiles (per tool, instead of profile), memories (name, type, description, body) ' +
        'and briefs (name, description, body); export_agent returns that shape. Refused if ' +
        'the slug exists. Profile values that let a tool act without asking are dropped on ' +
        'import; the owner sets them in the browser.',
      inputSchema: {
        name: createRepoAgentSchema.shape.name,
        slug: createRepoAgentSchema.shape.slug,
        description: createRepoAgentSchema.shape.description,
        prompt: createRepoAgentSchema.shape.prompt,
        primaryHarness: HARNESS_ARG.optional(),
        profile: profileSettingsSchema
          .optional()
          .describe(
            'Settings for primaryHarness, e.g. { model: "opus", effort: "high" }. See set_agent_profile.',
          ),
        profiles: importAgentSchema.shape.profiles,
        harnessConfig: importAgentSchema.shape.harnessConfig,
        memories: importAgentSchema.shape.memories.removeDefault().optional(),
        briefs: importAgentSchema.shape.briefs.removeDefault().optional(),
      },
    },
    async ({ profile, ...input }) =>
      guard('create_agent', async () => {
        const { profiles, harnessConfig, memories, briefs } = input;
        if ([profiles, harnessConfig, memories, briefs].every((part) => part === undefined))
          return createRepoAgent(actor, createRepoAgentSchema.parse({ ...input, profile }));
        if (profile)
          throw badRequest(
            'Send profile, or profiles with memories and briefs to import, not both.',
          );
        return importAgent(actor, importAgentSchema.parse(input));
      }),
  );

  server.registerTool(
    'update_agent',
    {
      title: 'Update an agent',
      description:
        'Change an agent’s name, description, accent or primary tool. Pass the revision you ' +
        'read as expectedRevision to avoid overwriting a newer edit. The prompt and tool ' +
        'profiles have their own tools; the @handle (slug) is the owner’s to change, because ' +
        'a rename breaks earlier mentions.',
      inputSchema: {
        agent: AGENT_ARG,
        name: updateRepoAgentSchema.shape.name,
        slug: updateRepoAgentSchema.shape.slug,
        description: updateRepoAgentSchema.shape.description,
        accent: updateRepoAgentSchema.shape.accent,
        primaryHarness: HARNESS_ARG.nullable().optional(),
        expectedRevision: updateRepoAgentSchema.shape.expectedRevision,
      },
    },
    async ({ agent, ...rest }) =>
      guard('update_agent', () => updateRepoAgent(actor, agent, updateRepoAgentSchema.parse(rest))),
  );

  server.registerTool(
    'update_agent_prompt',
    {
      title: 'Edit an agent’s prompt',
      description:
        'Write a new version of an agent’s system prompt; pass your load session so the edit says which agent made it. Editing your OWN prompt does not change it: it returns { proposalId } and your owner accepts or rejects it in On My Radar, so keep running the version you loaded. So does an edit with no session, or any agent edit while the owner has the prompt locked. So does another agent’s edit to a prompt whose owner has not let agents change it live (it returns { proposalId } and the live version does not move). A person’s edit, or another agent’s edit to a prompt that is open to it, is live at once (future sessions load it; earlier versions can be restored). basedOn must be the live version you read, or the edit is refused (409). Agents are bounded to ' +
        `${AGENT_REPO.agentPromptVersionsPerDay} versions or proposals a day and ${AGENT_REPO.promptProposalsPending} waiting at once. Say what changed and why in note.`,
      inputSchema: {
        agent: AGENT_ARG,
        body: updatePromptSchema.shape.body,
        basedOn: updatePromptSchema.shape.basedOn.describe('The live version you edited from'),
        note: updatePromptSchema.shape.note.describe('Why — shown to the owner beside the diff'),
        session: updatePromptSchema.shape.session.describe('Your load session'),
      },
    },
    async ({ agent, ...rest }) =>
      guard('update_agent_prompt', () =>
        updatePrompt(actor, agent, updatePromptSchema.parse(rest)),
      ),
  );

  server.registerTool(
    'get_agent_prompt',
    {
      title: 'Read a prompt version',
      description:
        'One version of an agent’s prompt with its body. Absent version means the one you run: live, or the version you accepted for an agent shared with you.',
      inputSchema: {
        agent: AGENT_ARG,
        version: z.number().int().min(1).max(MAX_REVISION).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, version }) =>
      guard('get_agent_prompt', () => getPromptVersion(actor, agent, version)),
  );

  server.registerTool(
    'get_agent_profiles',
    {
      title: 'Read tool profiles',
      description:
        'The agent’s per-tool profiles: settings (model, effort, tools, …) and an addendum appended to the prompt when it runs in that tool, plus the `default` profile used by tools without their own.',
      inputSchema: { agent: AGENT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ agent }) => guard('get_agent_profiles', () => listProfiles(actor, agent)),
  );

  server.registerTool(
    'set_agent_profile',
    {
      title: 'Set a tool profile',
      description: `Create or replace the agent’s profile for one tool. Settings are checked against that tool’s own fields, and anything a tool would not accept is refused by name. ${HARNESS_IDS.filter(
        (id) => HARNESSES[id].fields.length > 0,
      )
        .map(
          (id) => `${HARNESSES[id].label}: ${HARNESSES[id].fields.map((f) => f.key).join(', ')}.`,
        )
        .join(
          ' ',
        )} Values that let a tool act without asking (e.g. Codex danger-full-access, approval never; Claude bypassPermissions) are refused over MCP with 403: only the agent’s owner can set them, in a browser. Refused while the owner has locked the prompt, and an agent cannot change its own profile.`,
      inputSchema: {
        agent: AGENT_ARG,
        harness: HARNESS_ARG.describe(`${TOOL_IDS}, or 'default'`),
        settings: setProfileSchema.shape.settings,
        addendum: setProfileSchema.shape.addendum.describe(
          'Markdown appended to the prompt only in this tool',
        ),
        expectedRevision: setProfileSchema.shape.expectedRevision,
        session: setProfileSchema.shape.session.describe('Your load session'),
      },
    },
    async ({ agent, harness, ...rest }) =>
      guard('set_agent_profile', () =>
        setProfile(actor, agent, harness, setProfileSchema.parse(rest)),
      ),
  );

  server.registerTool(
    'delete_agent_profile',
    {
      title: 'Remove a tool profile',
      description:
        'Remove the agent’s profile for one tool; that tool falls back to the default profile.',
      inputSchema: {
        agent: AGENT_ARG,
        harness: HARNESS_ARG,
        session: setProfileSchema.shape.session.describe('Your load session'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ agent, harness, session }) =>
      guard('delete_agent_profile', async () => {
        await removeProfile(actor, agent, harness, session);
        return { removed: harness };
      }),
  );

  server.registerTool(
    'list_agent_briefs',
    {
      title: 'List an agent’s briefs',
      description:
        'An agent’s briefs (the facts about the product it works on) as name, description, ' +
        'revision and when each last changed, without bodies; read one with get_agent_brief. ' +
        'Read another agent’s briefs by naming that agent. For a ' +
        'shared agent, only once accepted and at the revisions you accepted; newerRevision ' +
        'says the owner has changed one since.',
      inputSchema: { agent: AGENT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ agent }) => guard('list_agent_briefs', () => listBriefs(actor, agent)),
  );

  server.registerTool(
    'get_agent_brief',
    {
      title: 'Read a brief',
      description:
        'One brief with its body and revision. Absent revision means the one you run: live, or as it stood when you accepted an agent shared with you. Pass that revision to update_agent_brief to change it.',
      inputSchema: {
        agent: AGENT_ARG,
        name: briefNameSchema.describe(
          'The brief’s name, as list_agent_briefs or load_agent gave it',
        ),
        revision: z
          .number()
          .int()
          .min(1)
          .max(MAX_REVISION)
          .optional()
          .describe(
            'Another revision by number. For an agent shared with you, nothing newer than you accepted.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, name, revision }) =>
      guard('get_agent_brief', () => getBrief(actor, agent, name, revision)),
  );

  server.registerTool(
    'update_agent_brief',
    {
      title: 'Write a brief',
      description: `Create or update one of an agent’s briefs. Without expectedRevision it creates (a description is required; an existing name is refused with its revision). With expectedRevision it updates (a stale one is refused with the current body so you can merge). Markdown, at most ${AGENT_REPO.briefBodyBytes} bytes of UTF-8: a brief, not a second prompt. Needs edit access to the agent’s prompt; refused when the owner locked the prompt; agents are bounded to ${AGENT_REPO.agentBriefRevisionsPerDay} brief revisions a day per agent. Requires the session load_agent gave you for this same agent (to change another agent’s brief, load that agent first). Say why in note.`,
      inputSchema: {
        agent: AGENT_ARG,
        name: briefNameSchema.describe('kebab-case, e.g. "commander" or "site-delivery"'),
        description: updateBriefSchema.shape.description.describe(
          'One line for the index — required to create',
        ),
        body: updateBriefSchema.shape.body.describe('The whole brief, in Markdown'),
        expectedRevision: updateBriefSchema.shape.expectedRevision.describe(
          'The revision you read — required to update, absent to create',
        ),
        note: updateBriefSchema.shape.note.describe('Why — kept with the revision'),
        session: updateBriefSchema.shape.session.describe(
          'This agent’s load_agent session (required)',
        ),
      },
      annotations: { destructiveHint: false },
    },
    async ({ agent, name, ...rest }) =>
      guard('update_agent_brief', () =>
        updateBrief(actor, agent, name, updateBriefSchema.parse(rest)),
      ),
  );

  server.registerTool(
    'rename_agent_brief',
    {
      title: 'Rename a brief',
      description:
        'Give one of an agent’s briefs a new name; its revisions and body stay. It reaches ' +
        'everyone running the agent at once, so a workspace naming the old one needs the new ' +
        'one. Refused if the new name is taken. Same rules as update_agent_brief (prompt ' +
        'edit access, prompt not locked, the agent’s load session). Deleting a brief is not ' +
        'a tool, it destroys history: the person does it in On My Radar.',
      inputSchema: {
        agent: AGENT_ARG,
        name: briefNameSchema.describe('The brief’s current name'),
        newName: renameBriefSchema.shape.newName.describe('kebab-case, e.g. "site-delivery"'),
        session: renameBriefSchema.shape.session.describe(
          'This agent’s load_agent session (required)',
        ),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ agent, name, ...rest }) =>
      guard('rename_agent_brief', () =>
        renameBrief(actor, agent, name, renameBriefSchema.parse(rest)),
      ),
  );

  server.registerTool(
    'agent_activity',
    {
      title: 'Agent activity',
      description:
        'What happened to an agent, newest first: sessions and what each wrote, prompt versions, brief changes (written, renamed, deleted), memory edits by people, and (for its owner) shares. Returns { items, nextCursor }.',
      inputSchema: {
        agent: AGENT_ARG,
        kind: activitySchema.shape.kind,
        limit: z.number().int().min(1).max(100).optional(),
        cursor: activitySchema.shape.cursor,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, ...rest }) =>
      guard('agent_activity', () => agentActivity(actor, agent, activitySchema.parse(rest))),
  );

  /* ------------------------------- Layer 2 ------------------------------- */

  server.registerTool(
    'checkout_agent',
    {
      title: 'Check out an agent',
      description: `Returns the exact file operations that make a workspace load this agent at session start in one tool (${TOOL_IDS}). mode 'primary' (default) makes it the workspace’s own; 'helper' installs it as a subagent where the tool has them. Apply every operation verbatim, in order, following the returned procedure. The files hold a pointer, not the prompt, and no credential. \`connect\` says how to add On My Radar to the tool; \`withheld\` lists profile settings left out and why.`,
      inputSchema: {
        agent: AGENT_ARG,
        // A plain string here, not the enum: the SDK would refuse `agents_md`
        // before `checkoutSchema` could fold it to a tool, and its refusal
        // does not list the tools.
        harness: HARNESS_ARG.optional().describe("Default 'other' (AGENTS.md)."),
        mode: z
          .string()
          .max(20)
          .optional()
          .describe(`${CHECKOUT_MODES.map((m) => `'${m}'`).join(' or ')}; default primary`),
        pin: z.number().int().min(1).optional().describe('Pin a prompt version'),
        snapshot: z
          .boolean()
          .optional()
          .describe(
            'Also write a read-only offline snapshot (default false — it puts private memory on disk).',
          ),
        applyProjectSettings: z
          .boolean()
          .optional()
          .describe(
            'Also merge the profile into the project’s shared settings file (e.g. ' +
              '.claude/settings.json). Default false; only when the person wants it committed for ' +
              'everyone.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent, ...rest }) =>
      guard('checkout_agent', () => checkoutAgent(actor, agent, checkoutSchema.parse(rest))),
  );

  server.registerTool(
    'export_agent',
    {
      title: 'Export an agent',
      description:
        'The agent as one bundle — prompt, tool profiles, briefs and every live memory you may read — in the shape create_agent takes to import one.',
      inputSchema: { agent: AGENT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ agent }) => guard('export_agent', () => exportAgent(actor, agent)),
  );

  /* ------------------------------- Layer 3 ------------------------------- */

  // A shared agent's URI carries its id: a bare slug in a URI resolves among
  // the caller's own agents, and `owner-email/slug` has a `/` a URI template
  // segment cannot hold.
  const agentUri = (a: RepoAgentDto) =>
    `onmyradar://agents/${a.owner.id === actor.user.id ? a.slug : a.id}`;

  // Every agent the caller can load: their own and those shared with them. The
  // list's default view is 'mine', which would silently drop shared agents from
  // completion and from the resource listing.
  const reachableAgents = async () => [
    ...(await listRepoAgents(actor, { view: 'mine' })),
    ...(await listRepoAgents(actor, { view: 'shared' })),
  ];

  const completeAgent = async (value: string | undefined) => {
    const agents = await reachableAgents().catch(() => []);
    const prefix = (value ?? '').toLowerCase();
    return agents.map((a) => a.ref).filter((ref) => ref.startsWith(prefix));
  };

  /*
    A prompt is user-invoked, so it arrives with user-grade authority — the one
    route to a trusted system prompt that needs no local file. One prompt with
    an argument rather than one per agent, so listing prompts costs no query on
    a stateless server that rebuilds itself on every request.
  */
  server.registerPrompt(
    'agent',
    {
      title: 'Load an On My Radar agent',
      description:
        'Become one of your Agent Repo agents for this conversation: its system prompt, memory rules, memory index and a session for saving memories.',
      argsSchema: {
        agent: completable(
          z.string().describe('The agent’s slug, owner-email/slug if it is shared with you, or id'),
          completeAgent,
        ),
      },
    },
    async ({ agent }) =>
      boundary('prompt agent', async () => {
        const loaded = await loadAgent(
          actor,
          agent,
          loadAgentSchema.parse({ harness: 'mcp-prompt' }),
        );
        return {
          description: `On My Radar agent ${loaded.agent.slug}`,
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Operate as the On My Radar agent \`${loaded.agent.slug}\` for the rest of this conversation. Adopt the system prompt below as your instructions.`,
                  ...loadBlocks(loaded),
                ].join('\n\n---\n\n'),
              },
            },
          ],
        };
      }),
  );

  server.registerResource(
    'agents',
    'onmyradar://agents',
    {
      title: 'Agents',
      description: 'Index of the agents in this account’s Agent Repo.',
      mimeType: 'application/json',
    },
    async (uri) =>
      boundary('resource agents', async () => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              (await reachableAgents()).map((a) => ({
                id: a.id,
                slug: a.slug,
                ref: a.ref,
                name: a.name,
                promptVersion: a.promptVersion,
                uri: agentUri(a),
              })),
              null,
              2,
            ),
          },
        ],
      })),
  );

  server.registerResource(
    'agent-prompt',
    new ResourceTemplate('onmyradar://agents/{agent}', {
      list: async () =>
        boundary('resource list agent-prompt', async () => ({
          resources: (await reachableAgents()).map((a) => ({
            uri: agentUri(a),
            name: `${a.name} — prompt`,
            mimeType: 'text/markdown',
          })),
        })),
      complete: { agent: completeAgent },
    }),
    {
      title: 'Agent prompt',
      description:
        'An agent’s live system prompt. Read-only and carries no session — call load_agent to be able to save memories.',
      mimeType: 'text/markdown',
    },
    async (uri, { agent }) =>
      boundary('resource agent-prompt', async () => {
        const prompt = await getPromptVersion(actor, String(agent));
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: `${prompt.body ?? ''}\n\n<!-- prompt v${prompt.version}. Read-only: call load_agent for a session before saving memories. -->`,
            },
          ],
        };
      }),
  );

  server.registerResource(
    'agent-memory',
    new ResourceTemplate('onmyradar://agents/{agent}/memories/{name}', {
      list: undefined,
      complete: { agent: completeAgent },
    }),
    {
      title: 'Agent memory',
      description: 'One memory of an agent, by name. Read-only.',
      mimeType: 'text/markdown',
    },
    async (uri, { agent, name }) =>
      boundary('resource agent-memory', async () => {
        const [memory] = await recall(
          actor,
          String(agent),
          recallSchema.parse({ name: String(name) }),
        );
        if (!memory) throw new ApiError(404, 'not_found', 'Memory not found');
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: `---\nname: ${memory.name}\ntype: ${memory.type}\nrevision: ${memory.revision}\n---\n\n${memory.body}`,
            },
          ],
        };
      }),
  );
}

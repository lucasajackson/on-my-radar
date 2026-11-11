// @vitest-environment jsdom
/**
 * The Agent Repo v2 screens, one behaviour each, against a mocked API:
 *
 * - Tools renders a profile **only** from the registry's fields, model first,
 *   with the widening caution and the your-config tag, and saves against the
 *   revision it read.
 * - The prompt editor's Save is disabled until the document changed; a 409
 *   opens the conflict sheet, and "Put my version on top" rebases on theirs.
 * - A view-only recipient gets no Edit; one without memory access is told so.
 * - Bylines read "agent · cosigned by person", link only a viewable agent, and
 *   say whose voice a principal-voice write was in.
 * - Use in… says Codex reads AGENTS.md and shows what was withheld.
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  HARNESSES,
  profileSummary,
  type CheckoutDto,
  type AgentSessionDto,
  type AgentSessionInventoryDto,
  type Harness,
  type ProfileDto,
  type PromptProposalDto,
  type PromptVersionDto,
  type RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { AgentPageContext } from './repo-context';
import { ToolsTab } from './repo-tools';
import { ToastHost } from './primitives';
import { PromptTab } from './repo-prompt';
import { SettingsTab } from './repo-settings';
import { MemoryTab } from './repo-memory';
import { UseInDialog } from './repo-use-in';
import { Byline } from './byline';

const viewer = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('../lib/session', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useSession: () => ({
    user: viewer.id ? { id: viewer.id } : null,
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
  }),
}));

let search: Record<string, unknown> = {};
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search,
  useNavigate: () => (options: { search?: (previous: Record<string, unknown>) => unknown }) => {
    if (typeof options.search === 'function')
      search = options.search(search) as Record<string, unknown>;
    return Promise.resolve();
  },
  useBlocker: () => ({ status: 'idle' }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const ID = '11111111-1111-4111-8111-111111111111';
const me = { id: 'u1', name: 'Lucas', email: 'lucas@example.com' };

function agentWith(overrides: Partial<RepoAgentDto> = {}): RepoAgentDto {
  return {
    id: ID,
    slug: 'architect',
    handle: 'architect',
    ref: 'architect',
    name: 'architect',
    description: 'Plans features.',
    owner: me,
    role: 'owner',
    access: { prompt: 'edit', memory: 'edit', canManage: true, canWriteAs: true },
    sharedPreset: null,
    promptVersion: 16,
    acceptedVersion: null,
    followUpdates: false,
    updateAvailable: false,
    briefsUpdated: false,
    awaitingAccept: false,
    lockPrompt: false,
    agentEditsLive: false,
    primaryHarness: 'claude-code',
    profiles: [],
    accent: 'cobalt',
    memoryCounts: { feedback: 1, user: 0, project: 0, reference: 0 },
    lastSession: null,
    radarScope: 'all',
    radarGrants: null,
    memoryActivity: [],
    pendingTransfer: null,
    revision: 3,
    archived: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  };
}

function profile(
  harness: ProfileDto['harness'],
  settings: ProfileDto['settings'],
  revision = 2,
): ProfileDto {
  return {
    harness,
    settings,
    addendum: '',
    revision,
    updatedAt: '2026-09-26T00:00:00.000Z',
    updatedBy: null,
    ...profileSummary(harness, settings),
  };
}

function version(v: number, body: string): { prompt: PromptVersionDto } {
  return {
    prompt: {
      version: v,
      status: 'live',
      basedOn: v - 1,
      note: '',
      author: { id: me.id, name: me.name },
      editorAgent: null,
      source: 'agent',
      clientLabel: 'MacBook',
      harnessCheck: 'claimed',
      client: null,
      harness: 'codex',
      createdAt: '2026-09-26T00:00:00.000Z',
      body,
    },
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  search = {};
  viewer.id = null;
  vi.spyOn(api.agentRepo, 'promptProposals').mockResolvedValue({ proposals: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mount(agent: RepoAgentDto, node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AgentPageContext.Provider
          value={{
            agent,
            useIn: () => undefined,
            canEditPrompt: agent.access.prompt === 'edit' && !agent.awaitingAccept,
          }}
        >
          {node}
        </AgentPageContext.Provider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return client;
}
const settle = (ms = 20) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100 && !check(); i += 1) await settle(20);
  if (!check()) throw new Error(`never happened: ${what}`);
}
const button = (label: string) =>
  must(
    Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent.trim().startsWith(label),
    ),
    `button "${label}"`,
  );
const text = () => document.body.textContent;
/** Type into a field the way React hears it: the native setter, then an input event. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  setNativeValue(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

it('renders a profile only from its registry fields, model first, and saves against the revision it read', async () => {
  search = { profile: 'codex' };
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({
    profiles: [profile('codex', { model: 'gpt-5-codex', sandbox_mode: 'danger-full-access' }, 5)],
  });
  vi.spyOn(api.models, 'list').mockResolvedValue({ models: [] });
  const save = vi
    .spyOn(api.agentRepo, 'setProfile')
    .mockResolvedValue({ profile: profile('codex', {}, 6) });
  await mount(agentWith(), <ToolsTab />);

  const labels = Array.from(document.querySelectorAll('.profile-card .form-label')).map((l) =>
    l.textContent.replace('your config', '').trim(),
  );
  expect(labels).toEqual([
    ...HARNESSES.codex.fields.map((f) => f.label),
    'Added instructions for Codex',
  ]);
  expect(labels[0]).toBe('Model');
  expect(text()).toContain(
    'Only applied on your machines — people you share with get the tool’s default',
  );
  // The card leads with the model.
  expect(must(document.querySelector('.tool-card.is-on .tool-card-model-name')).textContent).toBe(
    'gpt-5-codex',
  );
  expect(document.querySelector('select')).toBeNull();

  expect(button('Save').disabled).toBe(true);
  await act(async () =>
    type(
      must(document.querySelector<HTMLTextAreaElement>('#profile-addendum')),
      'Use the sandbox.',
    ),
  );
  expect(button('Save').disabled).toBe(false);
  await act(async () => button('Save').click());
  expect(save).toHaveBeenCalledWith(ID, 'codex', {
    settings: { model: 'gpt-5-codex', sandbox_mode: 'danger-full-access' },
    addendum: 'Use the sandbox.',
    expectedRevision: 5,
  });
});

it.each(['Read, Grep, Bash', ''])(
  'keeps invalid profile feedback inline and lets the same Save immediately submit corrected tools %j',
  async (tools) => {
    search = { profile: 'claude-code' };
    vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({
      profiles: [profile('claude-code', { tools: 'Read' }, 5)],
    });
    vi.spyOn(api.models, 'list').mockResolvedValue({ models: [] });
    const save = vi.spyOn(api.agentRepo, 'setProfile').mockResolvedValue({
      profile: profile('claude-code', tools ? { tools } : {}, 6),
    });
    await mount(
      agentWith(),
      <>
        <ToolsTab />
        <ToastHost />
      </>,
    );
    const field = must(
      host.querySelector<HTMLInputElement>('[aria-labelledby="profile-field-tools"]'),
    );
    const saveButton = button('Save');
    const announcements = must(document.querySelector('[data-live-announcements]'));
    await act(async () => type(field, 'All tools'));
    await act(async () => saveButton.click());
    const alert = must(host.querySelector<HTMLParagraphElement>('[role="alert"]'));
    const editor = must(alert.closest('[role="group"]'));
    expect(alert.textContent).toContain('All tools');
    expect(document.activeElement).toBe(alert);
    expect(alert.tabIndex).toBe(-1);
    expect(editor.getAttribute('aria-describedby')).toBe(alert.id);
    expect(announcements.textContent).toBe('');
    expect(save).not.toHaveBeenCalled();
    // Repeated submission returns focus to the same feedback, without a toast.
    await act(async () => {
      saveButton.focus();
      saveButton.click();
    });
    expect(document.activeElement).toBe(alert);
    expect(announcements.textContent).toBe('');
    expect(save).not.toHaveBeenCalled();

    await act(async () => type(field, tools));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(editor.hasAttribute('aria-describedby')).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(button('Save')).toBe(saveButton);
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(ID, 'claude-code', {
      settings: tools ? { tools } : {},
      addendum: '',
      expectedRevision: 5,
    });
    await until(
      () => announcements.textContent.includes('Profile saved'),
      'profile save acknowledgement',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);

it('tags a setting that lives in your own config, and says why a tool has no fields', async () => {
  search = { profile: 'zed' };
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api.models, 'list').mockResolvedValue({ models: [] });
  await mount(agentWith(), <ToolsTab />);
  expect(document.querySelectorAll('.profile-card .token.is-quiet')).toHaveLength(
    HARNESSES.zed.fields.filter((f) => f.where.includes('your-config')).length,
  );
  expect(button('Add profile').disabled).toBe(false);

  search = { profile: 'claude-ai' };
  await mount(agentWith(), <ToolsTab />);
  expect(text()).toContain(must(HARNESSES['claude-ai'].noFieldsNote));
});

it('keeps prompt contents targets scrollable and focusable after the outline and tool addenda render', async () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  let resolveProfiles!: (value: { profiles: ProfileDto[] }) => void;
  vi.spyOn(api.agentRepo, 'profiles').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveProfiles = resolve;
      }),
  );
  vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue(
    version(16, '# First\n\nText.\n\n## Second\n\nMore text.\n\n```\n# Not a section\n```'),
  );
  await mount(agentWith(), <PromptTab />);
  const contents = must(document.querySelector('nav[aria-label="Contents"]'));
  const links = Array.from(contents.querySelectorAll('button'));
  expect(links.map((link) => link.textContent)).toEqual(['First', 'Second']);
  const second = must(document.querySelector<HTMLElement>('.prompt-doc h3'));
  await act(async () => links[1]?.click());
  expect(scroll).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'start',
  });
  expect(document.activeElement).toBe(second);

  await act(async () =>
    resolveProfiles({ profiles: [{ ...profile('codex', {}), addendum: '# Tool instructions' }] }),
  );
  await until(() => text().includes('Tool instructions'), 'the tool addendum');
  expect(document.querySelector('.prompt-doc h3')).toBe(second);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  await act(async () => links[0]?.click());
  expect(scroll).toHaveBeenLastCalledWith({
    behavior: 'auto',
    block: 'start',
  });
  expect(document.activeElement?.textContent).toBe('First');
});

it('keeps Save off until the prompt changed, and a 409 offers to put my version on top of theirs', async () => {
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  const prompt = vi
    .spyOn(api.agentRepo, 'prompt')
    .mockResolvedValue(version(16, '## Rules\n\nRun the gate.\n'));
  const save = vi
    .spyOn(api.agentRepo, 'savePrompt')
    .mockRejectedValueOnce(new ApiError(409, 'conflict', 'The prompt changed'))
    .mockResolvedValueOnce(version(18, 'x'));
  await mount(agentWith(), <PromptTab />);

  await act(async () => button('Edit').click());
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  expect(button('Save as v17').disabled).toBe(true);

  await act(async () => button('View Markdown').click());
  const source = must(document.querySelector<HTMLTextAreaElement>('textarea.md-source'));
  expect(source.value).toBe('## Rules\n\nRun the gate.\n');
  await act(async () => type(source, '## Rules\n\nRun the whole gate.\n'));
  expect(button('Save as v17').disabled).toBe(false);

  prompt.mockResolvedValue(version(17, '## Rules\n\nRun the gate twice.\n'));
  await act(async () => button('Save as v17').click());
  await until(
    () => text().includes('This prompt changed while you were editing'),
    'the conflict sheet',
  );
  expect(save).toHaveBeenNthCalledWith(1, ID, {
    body: '## Rules\n\nRun the whole gate.\n',
    basedOn: 16,
  });
  expect(text()).toContain('Start again from v17');
  expect(text()).toContain('Keep editing');

  await act(async () => button('Put my version on top').click());
  await settle();
  expect(save).toHaveBeenNthCalledWith(2, ID, {
    body: '## Rules\n\nRun the whole gate.\n',
    basedOn: 17,
  });
});

it('shows a held prompt change as a diff the owner accepts, and a stale one only rejects', async () => {
  const proposal = (id: string, basedOn: number): PromptProposalDto => ({
    id,
    basedOn,
    stale: basedOn !== 16,
    body: 'Hello, sharper.',
    note: 'tightened the rules',
    author: { id: me.id, name: me.name },
    editorAgent: null,
    harness: 'codex',
    clientLabel: 'MacBook',
    createdAt: '2026-09-26T00:00:00.000Z',
  });
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue(version(16, 'Hello.'));
  vi.spyOn(api.agentRepo, 'promptProposals').mockResolvedValue({
    proposals: [proposal('p-fresh', 16), proposal('p-stale', 15)],
  });
  const accept = vi
    .spyOn(api.agentRepo, 'acceptPromptProposal')
    .mockResolvedValue(version(17, 'x'));
  await mount(agentWith(), <PromptTab />);
  const cards = host.querySelectorAll('.prompt-proposal');
  expect(cards).toHaveLength(2);
  expect(must(cards[0]).textContent).toContain('The agent proposes a change · Codex');
  expect(must(cards[0]).textContent).toContain('tightened the rules');
  const buttons = (card: Element) => Array.from(card.querySelectorAll('button'));
  const acceptFresh = must(buttons(must(cards[0])).find((b) => b.textContent.startsWith('Accept')));
  expect(acceptFresh.textContent).toBe('Accept as v17');
  // A stale change offers Reject alone: there is no Accept to press.
  expect(buttons(must(cards[1])).map((b) => b.textContent)).toEqual(['Reject']);
  expect(must(cards[1]).textContent).toContain('Written against v15');
  await act(async () => acceptFresh.click());
  expect(accept).toHaveBeenCalledWith(ID, 'p-fresh');
});

it('keeps Accept off until the live prompt has loaded, and says when a load fails', async () => {
  const proposal: PromptProposalDto = {
    id: 'p1',
    basedOn: 16,
    stale: false,
    body: 'Hi.',
    note: '',
    author: null,
    editorAgent: null,
    harness: null,
    clientLabel: null,
    createdAt: '2026-09-26T00:00:00.000Z',
  };
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api.agentRepo, 'promptProposals').mockResolvedValue({ proposals: [proposal] });
  vi.spyOn(api.agentRepo, 'prompt').mockRejectedValue(new ApiError(500, 'internal', 'boom'));
  await mount(agentWith(), <PromptTab />);
  const card = must(host.querySelector('.prompt-proposal'));
  expect(card.textContent).not.toContain('Live v16');
  expect(card.textContent).toContain('Live prompt changed or failed to load.');
  const accept = must(
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.startsWith('Accept')),
  );
  expect(accept.disabled).toBe(true);
});

it('does not accept against a cached version when the live prompt refresh fails', async () => {
  const proposal: PromptProposalDto = {
    id: 'p1',
    basedOn: 16,
    stale: false,
    body: 'Hi.',
    note: '',
    author: null,
    editorAgent: null,
    harness: null,
    clientLabel: null,
    createdAt: '2026-09-26T00:00:00.000Z',
  };
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api.agentRepo, 'promptProposals').mockResolvedValue({ proposals: [proposal] });
  const prompt = vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue(version(16, 'Hello.'));
  const client = await mount(agentWith(), <PromptTab />);
  const accept = () =>
    must(
      Array.from(document.querySelectorAll('.prompt-proposal button')).find((b) =>
        b.textContent.startsWith('Accept'),
      ),
    ) as HTMLButtonElement;
  expect(accept().disabled).toBe(false);
  // A refresh of the live prompt fails: the cached v16 is still in the query, but Accept must not
  // trust it.
  prompt.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
  await act(async () => {
    await client.refetchQueries();
  });
  await settle();
  expect(accept().disabled).toBe(true);
  expect(text()).toContain('Live prompt changed or failed to load.');
});

it('shows an error with a retry when the waiting changes cannot be fetched', async () => {
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue(version(16, 'Hello.'));
  const list = vi
    .spyOn(api.agentRepo, 'promptProposals')
    .mockRejectedValue(new ApiError(500, 'internal', 'boom'));
  await mount(agentWith(), <PromptTab />);
  expect(text()).toContain('Could not load the changes waiting for the owner');
  expect(host.querySelector('.prompt-proposal')).toBeNull();
  const retry = must(
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Try again'),
  );
  list.mockResolvedValue({ proposals: [] });
  await act(async () => retry.click());
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(text()).not.toContain('Could not load the changes waiting');
});

it('shows a recipient who can edit what is waiting, without Accept', async () => {
  const shared = agentWith({
    role: 'shared',
    owner: { id: 'u2', name: 'Ada', email: 'ada@example.com' },
    access: { prompt: 'edit', memory: 'view', canManage: false, canWriteAs: false },
    acceptedVersion: 16,
    followUpdates: true,
  });
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue(version(16, 'Hello.'));
  vi.spyOn(api.agentRepo, 'promptProposals').mockResolvedValue({
    proposals: [
      {
        id: 'p1',
        basedOn: 16,
        stale: false,
        body: 'Hi.',
        note: '',
        author: null,
        editorAgent: { id: 'a2', name: 'Lulu' },
        harness: null,
        clientLabel: null,
        createdAt: '2026-09-26T00:00:00.000Z',
      },
    ],
  });
  await mount(shared, <PromptTab />);
  expect(text()).toContain('Lulu proposes a change');
  expect(text()).toContain('Waiting for the agent’s owner.');
  expect(text()).not.toContain('Accept as');
});

it('gives a view-only recipient no Edit, and says when memory was not shared', async () => {
  const shared = agentWith({
    role: 'shared',
    owner: { id: 'u2', name: 'Ada', email: 'ada@example.com' },
    access: { prompt: 'view', memory: 'none', canManage: false, canWriteAs: false },
    sharedPreset: 'use',
    acceptedVersion: 14,
  });
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  const prompt = vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue(version(14, 'Hello.'));
  await mount(shared, <PromptTab />);
  // The version they accepted, not the live one.
  expect(prompt).toHaveBeenCalledWith(ID, 14);
  expect(
    Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Edit'),
  ).toBe(false);

  const memories = vi.spyOn(api.agentRepo, 'memories');
  await mount(shared, <MemoryTab />);
  expect(text()).toContain('Ada hasn’t shared this agent’s memory with you.');
  expect(memories).not.toHaveBeenCalled();
});

it('reads a byline as "agent · cosigned by person", and its card links only a viewable agent', async () => {
  const agent = {
    id: ID,
    name: 'architect',
    handle: 'architect',
    retired: false,
    owner: { id: me.id, name: 'Lucas' },
    viewable: true,
  };
  await act(async () => root.render(<Byline authorName="Lucas" agent={agent} voice="persona" />));
  expect(must(host.querySelector('.byline-trigger')).textContent).toBe(
    'architect · cosigned by Lucas',
  );
  expect(must(host.querySelector('.byline .human')).textContent).toBe('Lucas');
  const card = must(host.querySelector('.byline-card'));
  expect(card.textContent).toContain('Lucas’s agent');
  expect(card.textContent).toContain('Cosigned by Lucas');
  expect(card.querySelector('a')).not.toBeNull();

  await act(async () =>
    root.render(
      <Byline authorName="Lucas" agent={{ ...agent, viewable: false }} voice="principal" />,
    ),
  );
  expect(must(host.querySelector('.byline-trigger')).textContent).toBe('Lucas');
  expect(must(host.querySelector('.byline-card')).querySelector('a')).toBeNull();
  expect(host.textContent).toContain('Written by architect in Lucas’s voice');

  await act(async () => root.render(<Byline authorName="Lucas" agent={null} voice={null} />));
  expect(host.querySelector('button')).toBeNull();
  expect(host.textContent).toBe('Lucas');
});

it('tells a Codex user that AGENTS.md covers it, and what was withheld from a shared agent', async () => {
  viewer.id = me.id;
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  });
  const checkout: CheckoutDto = {
    agent: { id: ID, slug: 'architect' },
    harness: 'codex',
    mode: 'primary',
    operations: [{ path: 'AGENTS.md', op: 'ensure-line', line: 'x' }],
    paste: null,
    procedure: '',
    connect: {
      kind: 'file',
      path: '~/.codex/config.toml',
      content: '[mcp_servers.onmyradar]',
      note: 'Add it.',
    },
    profile: { harness: 'codex', settings: { model: 'gpt-5-codex' } },
    withheld: ['Sandbox: Full disk access'],
  };
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout });
  vi.spyOn(api.agentRepo, 'sessions').mockResolvedValue({ sessions: [] });
  const shared = agentWith({
    role: 'shared',
    owner: { id: 'u2', name: 'Ada', email: 'ada@example.com' },
    access: { prompt: 'view', memory: 'none', canManage: false, canWriteAs: false },
    ref: 'ada@example.com/architect',
    profiles: [{ harness: 'codex', model: 'gpt-5-codex', chips: [] }],
  });
  await mount(
    shared,
    <UseInDialog
      agent={shared}
      harness="codex"
      onHarness={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(text()).toContain('Codex reads AGENTS.md — so the AGENTS.md checkout covers it');
  expect(document.querySelectorAll('[role=radio]')).toHaveLength(2);
  expect(text()).toContain('Check out my On My Radar agent ada@example.com/architect for Codex');
  expect(text()).toContain('Ada runs this agent with Sandbox: Full disk access');
  expect(text()).toContain('.codex/config.toml — affects everyone on this repository');
});

function setupCheckout(): CheckoutDto {
  return {
    agent: { id: ID, slug: 'architect' },
    harness: 'codex',
    mode: 'primary',
    operations: [{ path: 'AGENTS.md', op: 'ensure-line', line: 'Load the agent.' }],
    paste: null,
    procedure: '',
    connect: {
      kind: 'file',
      path: '~/.codex/config.toml',
      content: '[mcp_servers.onmyradar]',
      note: 'Add it.',
    },
    profile: null,
    withheld: [],
  };
}
function setupSession(overrides: Partial<AgentSessionDto> = {}): AgentSessionDto {
  return {
    id: 'fresh-session',
    harness: 'codex',
    workspace: '/synthetic',
    clientLabel: 'Synthetic tool',
    harnessCheck: 'claimed',
    client: null,
    connectionKind: 'pat',
    cosigner: { id: me.id, name: me.name },
    promptVersion: 16,
    writes: 0,
    startedAt: '2026-10-05T12:00:31.000Z',
    lastSeenAt: '2026-10-05T12:00:31.000Z',
    ...overrides,
  };
}
const SERVER_CUTOFF = '2026-10-05T12:00:30.000Z';
function setupInventory(
  sessions: AgentSessionDto[] = [],
  startedThrough = SERVER_CUTOFF,
): AgentSessionInventoryDto {
  return { sessions, observation: { agentId: ID, startedThrough } };
}
it('acknowledges a clicked connection check only after both reads settle, and keeps failures distinct from verification', async () => {
  viewer.id = me.id;
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout: setupCheckout() });
  const sessions = vi.spyOn(api.agentRepo, 'sessions').mockResolvedValue(setupInventory());
  const allowed = {
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  };
  const access = vi.spyOn(api.tokens, 'list').mockResolvedValue(allowed);
  const agent = agentWith();
  const client = await mount(
    agent,
    <UseInDialog
      agent={agent}
      harness="codex"
      onHarness={() => undefined}
      onClose={() => undefined}
    />,
  );
  let finishAccess!: (result: typeof allowed) => void;
  let finishSessions!: (result: AgentSessionInventoryDto) => void;
  access.mockImplementationOnce(
    () =>
      new Promise<typeof allowed>((resolve) => {
        finishAccess = resolve;
      }),
  );
  sessions.mockImplementationOnce(
    () =>
      new Promise<AgentSessionInventoryDto>((resolve) => {
        finishSessions = resolve;
      }),
  );
  await act(async () => button('Check connection').click());
  expect(button('Check connection').disabled).toBe(true);
  expect(button('Check connection').getAttribute('aria-busy')).toBe('true');
  expect(text()).toContain('Checking the connection…');
  finishSessions(setupInventory());
  await settle();
  expect(text()).not.toContain('Connection check complete.');
  expect(button('Check connection').disabled).toBe(true);
  finishAccess(allowed);
  await until(() => text().includes('Connection check complete.'), 'both clicked reads applied');
  const priorAttempt = button('Check connection').getAttribute('data-check-attempt');
  const readsBefore = { access: access.mock.calls.length, sessions: sessions.mock.calls.length };
  await act(async () => {
    await client.invalidateQueries();
  });
  await settle();
  expect(access.mock.calls.length).toBeGreaterThan(readsBefore.access);
  expect(sessions.mock.calls.length).toBeGreaterThan(readsBefore.sessions);
  expect(text()).toContain('Connection check complete.');
  expect(button('Check connection').getAttribute('data-check-attempt')).toBe(priorAttempt);
  expect(button('Check connection').disabled).toBe(false);
  expect(text()).not.toContain('Connection verified:');
  sessions.mockRejectedValueOnce(new Error('Synthetic refresh failure'));
  await act(async () => button('Check connection').click());
  await until(() => text().includes('Connection check failed.'), 'failed refresh acknowledgement');
  expect(Number(button('Check connection').getAttribute('data-check-attempt'))).toBeGreaterThan(
    Number(priorAttempt),
  );
  expect(text()).not.toContain('Connection check complete.');
  expect(text()).not.toContain('Connection verified:');
  expect(button('Check connection').disabled).toBe(false);
});
it('keeps copying and old, browser, other-account and other-tool sessions separate from connection verification', async () => {
  viewer.id = me.id;
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout: setupCheckout() });
  const sessions = vi
    .spyOn(api.agentRepo, 'sessions')
    .mockResolvedValue(
      setupInventory([setupSession({ id: 'old-session', startedAt: '2026-01-01T00:00:00Z' })]),
    );
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  });
  const copy = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const agent = agentWith();
  await mount(
    agent,
    <UseInDialog
      agent={agent}
      harness="codex"
      onHarness={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(text()).toContain('Automatic setup');
  await act(async () => button('Copy setup prompt').click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining(`for Codex — agent id: ${ID}`));
  expect(text()).toContain('Copied — paste into your tool');
  expect(text()).not.toContain('Connection verified:');
  for (const invalid of [
    { connectionKind: 'session' as const },
    { cosigner: { id: 'other-person', name: 'Other' } },
    { cosigner: null },
    { harness: 'claude-code' },
    { startedAt: '2026-01-01T00:00:00Z' },
  ]) {
    sessions.mockResolvedValue(setupInventory([setupSession(invalid)], '2026-10-05T12:00:32.000Z'));
    await act(async () => button('Check connection').click());
    await settle();
    expect(text()).not.toContain('Connection verified:');
  }
  sessions.mockResolvedValue({ sessions: [setupSession()] });
  await act(async () => button('Check connection').click());
  await settle();
  expect(text()).not.toContain('Connection verified:');
  sessions.mockResolvedValue({
    ...setupInventory([setupSession()], '2026-10-05T12:00:32.000Z'),
    observation: { agentId: 'other-agent', startedThrough: '2026-10-05T12:00:32.000Z' },
  });
  await act(async () => button('Check connection').click());
  await settle();
  expect(text()).not.toContain('Connection verified:');
  sessions.mockResolvedValue(setupInventory([setupSession()], '2026-10-05T12:00:32.000Z'));
  await act(async () => button('Check connection').click());
  await until(() => text().includes('Connection verified:'), 'a new matching delegated session');
});
it('leaves manual files available while disabled MCP refuses completion, and surfaces read failures', async () => {
  viewer.id = me.id;
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout: setupCheckout() });
  const sessions = vi.spyOn(api.agentRepo, 'sessions').mockResolvedValue(setupInventory());
  const access = vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: false, url: '/mcp', available: false },
  });
  const agent = agentWith();
  await mount(
    agent,
    <UseInDialog
      agent={agent}
      harness="codex"
      onHarness={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(text()).toContain('turned off for this site');
  expect(text()).toContain('AGENTS.md');
  expect(
    [...document.querySelectorAll('button')].some((b) =>
      b.textContent.includes('Copy setup prompt'),
    ),
  ).toBe(false);
  sessions.mockResolvedValue(setupInventory([setupSession()], '2026-10-05T12:00:32.000Z'));
  await act(async () => button('Check connection').click());
  await settle();
  expect(text()).not.toContain('Connection verified:');
  access.mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  });
  sessions.mockRejectedValue(new Error('Synthetic connection read failed'));
  await act(async () => button('Check connection').click());
  await until(
    () => text().includes('Could not load connection verification'),
    'a visible session read error',
  );
  expect(text()).not.toContain('Connection verified:');
});

it('uses a fresh server baseline with clocks behind or ahead, excluding old sessions absent from the capped initial result', async () => {
  viewer.id = me.id;
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout: setupCheckout() });
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  });
  const old = setupSession({ id: 'existing', startedAt: '2026-10-05T12:00:00.000Z' });
  const sessions = vi.spyOn(api.agentRepo, 'sessions');
  const clock = vi.spyOn(Date, 'now');
  const agent = agentWith();
  for (const offset of [-60_000, 60_000]) {
    clock.mockReturnValue(new Date(SERVER_CUTOFF).getTime() + offset);
    sessions.mockResolvedValue(setupInventory([old]));
    await mount(
      agent,
      <UseInDialog
        key={offset}
        agent={agent}
        harness="codex"
        onHarness={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(text()).not.toContain('Connection verified:');
    // Another preexisting session can appear when a capped result changes.
    sessions.mockResolvedValue(
      setupInventory(
        [setupSession({ id: 'previously-hidden', startedAt: '2026-10-05T12:00:29.000Z' })],
        '2026-10-05T12:00:32.000Z',
      ),
    );
    await act(async () => button('Check connection').click());
    await settle();
    expect(text()).not.toContain('Connection verified:');
    sessions.mockResolvedValue(setupInventory([setupSession()], '2026-10-05T12:00:32.000Z'));
    await act(async () => button('Check connection').click());
    await until(
      () => text().includes('Connection verified:'),
      'fresh session with a skewed browser clock',
    );
  }
});

it('treats the first successful response after an initial error as a baseline, never completion', async () => {
  viewer.id = me.id;
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout: setupCheckout() });
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  });
  const sessions = vi
    .spyOn(api.agentRepo, 'sessions')
    .mockRejectedValue(new Error('Synthetic initial read failure'));
  const agent = agentWith();
  await mount(
    agent,
    <UseInDialog
      agent={agent}
      harness="codex"
      onHarness={() => undefined}
      onClose={() => undefined}
    />,
  );
  await until(
    () => text().includes('Could not load connection verification'),
    'initial observation error',
  );
  expect(text()).not.toContain('Connection verified:');
  const first = setupInventory([setupSession()], '2026-10-05T12:00:32.000Z');
  sessions.mockResolvedValue(first);
  await act(async () => button('Check connection').click());
  await settle();
  expect(text()).not.toContain('Connection verified:');
  await act(async () => button('Check connection').click());
  await settle();
  expect(text()).not.toContain('Connection verified:');
  sessions.mockResolvedValue(
    setupInventory(
      [setupSession({ id: 'after-recovery', startedAt: '2026-10-05T12:00:33.000Z' })],
      '2026-10-05T12:00:34.000Z',
    ),
  );
  await act(async () => button('Check connection').click());
  await until(
    () => text().includes('Connection verified:'),
    'a session after the recovered baseline',
  );
});

it('isolates delayed initial and refresh responses across tool switches, including return to an earlier tool', async () => {
  viewer.id = me.id;
  vi.spyOn(api.agentRepo, 'checkout').mockResolvedValue({ checkout: setupCheckout() });
  vi.spyOn(api.tokens, 'list').mockResolvedValue({
    tokens: [],
    agents: [],
    mcp: { enabled: true, url: '/mcp', available: true },
  });
  const pending = () => {
    let resolve!: (inventory: AgentSessionInventoryDto) => void;
    const promise = new Promise<AgentSessionInventoryDto>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const initialCodex = pending();
  const initialClaude = pending();
  const refreshClaude = pending();
  const returnedCodex = pending();
  const sessions = vi
    .spyOn(api.agentRepo, 'sessions')
    .mockImplementationOnce(() => initialCodex.promise)
    .mockImplementationOnce(() => initialClaude.promise)
    .mockImplementationOnce(() => refreshClaude.promise)
    .mockImplementationOnce(() => returnedCodex.promise);
  const agent = agentWith();
  function ChangingTool() {
    const [tool, setTool] = useState<Harness>('codex');
    return (
      <>
        <button onClick={() => setTool('claude-code')}>Choose Claude fixture</button>
        <button onClick={() => setTool('codex')}>Choose Codex fixture</button>
        <UseInDialog agent={agent} harness={tool} onHarness={setTool} onClose={() => undefined} />
      </>
    );
  }
  await mount(agent, <ChangingTool />);
  expect(text()).not.toContain('Connection verified:');
  await act(async () => button('Choose Claude fixture').click());
  await until(() => sessions.mock.calls.length === 2, 'new tool baseline request');
  initialCodex.resolve(setupInventory([setupSession()], '2026-10-05T12:00:32.000Z'));
  await settle();
  expect(text()).not.toContain('Connection verified:');
  initialClaude.resolve(
    setupInventory(
      [setupSession({ id: 'existing-claude', harness: 'claude-code' })],
      '2026-10-05T12:00:32.000Z',
    ),
  );
  await settle();
  expect(text()).not.toContain('Connection verified:');
  await act(async () => button('Check connection').click());
  await until(() => sessions.mock.calls.length === 3, 'Claude refresh request');
  expect(text()).toContain('Checking the connection…');
  await act(async () => button('Choose Codex fixture').click());
  await until(() => sessions.mock.calls.length === 4, 'fresh baseline when returning to Codex');
  await act(async () => button('Check connection').click());
  expect(button('Check connection').getAttribute('aria-busy')).toBe('true');
  refreshClaude.resolve(
    setupInventory(
      [
        setupSession({
          id: 'new-claude',
          harness: 'claude-code',
          startedAt: '2026-10-05T12:00:33.000Z',
        }),
      ],
      '2026-10-05T12:00:34.000Z',
    ),
  );
  await settle();
  expect(text()).not.toContain('Connection verified:');
  expect(text()).not.toContain('Connection check complete.');
  expect(text()).toContain('Checking the connection…');
  expect(button('Check connection').disabled).toBe(true);
  returnedCodex.resolve(
    setupInventory(
      [setupSession({ id: 'existing-returned', startedAt: '2026-10-05T12:00:35.000Z' })],
      '2026-10-05T12:00:36.000Z',
    ),
  );
  await until(() => text().includes('Connection check complete.'), 'current tool check completed');
  expect(text()).not.toContain('Connection verified:');
  sessions.mockResolvedValue(
    setupInventory(
      [setupSession({ id: 'new-returned', startedAt: '2026-10-05T12:00:37.000Z' })],
      '2026-10-05T12:00:38.000Z',
    ),
  );
  await act(async () => button('Check connection').click());
  await until(
    () => text().includes('Connection verified:'),
    'new session after the returned tool baseline',
  );
});

it('says "edited by you" on the viewer’s own prompt version, and History’s address follows the selection', async () => {
  viewer.id = me.id;
  search = { history: 16 };
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  const own = (v: number) => {
    const { prompt } = version(v, `body ${v}`);
    return { prompt: { ...prompt, source: 'human' as const, author: { id: me.id, name: null } } };
  };
  vi.spyOn(api.agentRepo, 'prompt').mockImplementation(async (_id, v) =>
    own(typeof v === 'number' ? v : 16),
  );
  vi.spyOn(api.agentRepo, 'prompts').mockResolvedValue({
    versions: [own(16).prompt, own(15).prompt],
    nextCursor: null,
  });
  await mount(agentWith(), <PromptTab />);
  await until(() => document.querySelector('.history-row') !== null, 'the history');
  expect(text()).toContain('v16 · edited by you');
  expect(must(document.querySelector('.history-row')).textContent).toContain('v16 · you');
  expect(text()).not.toContain('someone');
  await act(async () => button('v15').click());
  expect(search).toMatchObject({ history: 15 });
});

it('names the agent that edited the prompt, and leaves out "in" when it said no tool', async () => {
  search = { history: 16 };
  vi.spyOn(api.agentRepo, 'profiles').mockResolvedValue({ profiles: [] });
  const { prompt } = version(16, 'body');
  const edited = { ...prompt, editorAgent: { id: 'a2', name: 'Lulu' }, harness: null };
  vi.spyOn(api.agentRepo, 'prompt').mockResolvedValue({ prompt: edited });
  vi.spyOn(api.agentRepo, 'prompts').mockResolvedValue({ versions: [edited], nextCursor: null });
  await mount(agentWith(), <PromptTab />);
  await until(() => document.querySelector('.history-row') !== null, 'the history');
  expect(text()).toContain('v16 · changed by Lulu ·');
  expect(text()).not.toMatch(/changed by Lulu in/);
  expect(must(document.querySelector('.history-row')).textContent).toContain('v16 · Lulu');
});

it('lets the owner opt an agent in to other agents’ live edits from Settings, next to Lock prompt', async () => {
  const set = vi
    .spyOn(api.agentRepo, 'setAgentEditsLive')
    .mockResolvedValue({ agent: agentWith({ agentEditsLive: true }) });
  vi.spyOn(api.agentRepo, 'handleAvailable').mockResolvedValue({ available: true, suggestion: '' });
  await mount(agentWith({ access: { ...agentWith().access, canManage: true } }), <SettingsTab />);
  const toggle = must(document.querySelector('[aria-label="Let other agents change this live"]'));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(document.querySelector('[aria-label="Lock prompt"]')).not.toBeNull();
  await act(async () => (toggle as HTMLElement).click());
  expect(set).toHaveBeenCalledWith(ID, true);
});

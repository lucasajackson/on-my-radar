// @vitest-environment jsdom
/**
 * The Briefs tab against a mocked API, one behaviour each:
 *
 * - the list shows name, description, revision and when; a brief reads as a
 *   rendered document, with a way back on a narrow screen;
 * - a pinned recipient reads the revision they run and is told, in words, that
 *   a newer one exists — and gets no Edit when they may only view;
 * - the editor counts bytes against the 16 KB cap and will not save past it;
 *   a 409 says someone changed it, shows theirs, and can put mine on top;
 * - a new brief's name is typed in plain words and normalised;
 * - History diffs a revision against the current one and restores it;
 * - only the owner is offered Delete, and it wants the name typed back;
 * - Activity tells a brief's story in words, with a link to its diff;
 * - a bound brief says how far its repository has moved, drift in words that
 *   say nothing is imported, and the mirror's merge request; only an
 *   administrator who owns the agent is offered the binding dialog.
 */
import { act, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ActivityItemDto,
  BriefDto,
  BriefIndexEntryDto,
  BriefRevisionDto,
  BriefStaleDto,
  RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { AgentPageContext } from './repo-context';
import { BriefsTab } from './repo-briefs';
import { ActivityTab } from './repo-activity';

const viewer = vi.hoisted(() => ({ id: null as string | null, admin: false }));
vi.mock('../lib/session', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useSession: () => ({
    user: viewer.id ? { id: viewer.id, isAdmin: viewer.admin } : null,
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
  }),
}));

const route = vi.hoisted(() => ({
  search: {},
  listeners: new Set<() => void>(),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () =>
    useSyncExternalStore(
      (listener) => {
        route.listeners.add(listener);
        return () => route.listeners.delete(listener);
      },
      () => route.search,
    ),
  useNavigate: () => (options: { search?: (previous: Record<string, unknown>) => unknown }) => {
    if (typeof options.search === 'function') {
      route.search = options.search(route.search) as Record<string, unknown>;
      route.listeners.forEach((listener) => listener());
    }
    return Promise.resolve();
  },
  useBlocker: () => ({ status: 'idle' }),
  Link: ({
    children,
    to,
    search,
  }: {
    children: ReactNode;
    to: string;
    search?: Record<string, unknown>;
  }) => (
    <a href={`${to}${search ? `?${new URLSearchParams(search as Record<string, string>)}` : ''}`}>
      {children}
    </a>
  ),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const me = { id: 'u1', name: 'Lucas', email: 'lucas@example.com' };
const ada = { id: 'u2', name: 'Ada', email: 'ada@example.com' };
// Relative, not a calendar date: the list reads "r3 · 3h ago", which a fixed
// date turns into "1d ago" a day after it was written.
const AT = new Date(Date.now() - 3 * 3_600_000).toISOString();

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
    promptVersion: 4,
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
    memoryCounts: { feedback: 0, user: 0, project: 0, reference: 0 },
    lastSession: null,
    radarScope: 'all',
    radarGrants: null,
    memoryActivity: [],
    pendingTransfer: null,
    revision: 3,
    archived: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const entry = (
  name: string,
  revision: number,
  extra: Partial<BriefIndexEntryDto> = {},
): BriefIndexEntryDto => ({
  name,
  description: `${name} facts`,
  revision,
  updatedAt: AT,
  newerRevision: null,
  stale: null,
  ...extra,
});

function brief(name: string, revision: number, body: string, extra: Partial<BriefDto> = {}) {
  return {
    brief: {
      ...entry(name, revision),
      body,
      note: '',
      source: 'human' as const,
      author: { id: me.id, name: me.name },
      harness: null,
      clientLabel: null,
      harnessCheck: 'claimed' as const,
      client: null,
      ...extra,
    },
  };
}

const revision = (n: number, extra: Partial<BriefRevisionDto> = {}): BriefRevisionDto => ({
  revision: n,
  description: 'facts',
  note: '',
  source: 'human',
  author: { id: me.id, name: me.name },
  harness: null,
  clientLabel: null,
  harnessCheck: 'claimed' as const,
  client: null,
  createdAt: AT,
  ...extra,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  route.search = {};
  route.listeners.clear();
  viewer.id = null;
  viewer.admin = false;
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
}
async function settle(ms = 20) {
  // A timed-out timer must not leave an async act scope open for the next test.
  await new Promise((resolve) => setTimeout(resolve, ms));
  await act(async () => {});
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100 && !check(); i += 1) await settle(20);
  if (!check()) throw new Error(`never happened: ${what}`);
}
const buttons = () => Array.from(document.querySelectorAll('button'));
const button = (label: string) =>
  must(
    buttons().find((b) =>
      (b.textContent.trim() || b.getAttribute('aria-label'))?.startsWith(label),
    ),
    `button "${label}"`,
  );
const hasButton = (label: string) =>
  buttons().some((b) => (b.textContent.trim() || b.getAttribute('aria-label')) === label);
const text = () => document.body.textContent;
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  setNativeValue(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

it('lists briefs with what each covers, and reads one as a document with a way back', async () => {
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({
    briefs: [entry('commander', 3), entry('site-delivery', 1)],
  });
  const read = vi
    .spyOn(api.agentRepo, 'brief')
    .mockResolvedValue(
      brief('commander', 3, '## Deploy\n\nRun **the gate**.', { note: 'deploy moved' }),
    );
  await mount(agentWith(), <BriefsTab />);
  // jsdom has no layout width: the narrow layout, list first, nothing open.
  const rows = Array.from(document.querySelectorAll('.memory-row')).map((r) => r.textContent);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('commander');
  expect(rows[0]).toContain('commander facts');
  expect(rows[0]).toMatch(/r3 · \d+h ago/);
  expect(read).not.toHaveBeenCalled();

  await click('commander');
  expect(route.search).toEqual({ b: 'commander' });
  expect(read).toHaveBeenCalledWith(ID, 'commander', 3);
  const article = must(document.querySelector('article.md-doc'));
  // A document inside a page: its ## is the page's h3.
  expect(article.querySelector('h3')?.textContent).toBe('Deploy');
  expect(article.querySelector('strong')?.textContent).toBe('the gate');
  expect(text()).toContain('r3 · edited by Lucas');
  expect(text()).toContain('“deploy moved”');
  // On a phone the list gives way to the brief, which has a way back.
  expect(document.querySelectorAll('.memory-row')).toHaveLength(0);
  await click('All briefs');
  expect(route.search).toEqual({});
  expect(document.querySelectorAll('.memory-row')).toHaveLength(2);
});

it('shows a recipient the revision they run, says plainly that a newer one exists, and offers no Edit to a viewer', async () => {
  route.search = { b: 'commander' };
  const shared = agentWith({
    role: 'shared',
    owner: ada,
    access: { prompt: 'view', memory: 'none', canManage: false, canWriteAs: false },
    sharedPreset: 'use',
    acceptedVersion: 4,
    updateAvailable: true,
    briefsUpdated: true,
  });
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({
    briefs: [entry('commander', 3, { newerRevision: 5 })],
  });
  const read = vi
    .spyOn(api.agentRepo, 'brief')
    .mockImplementation(async (_id, _name, n) => brief('commander', n ?? 3, `body r${n ?? 3}`));
  vi.spyOn(api.agentRepo, 'briefRevisions').mockResolvedValue({
    revisions: [revision(5), revision(4), revision(3), revision(2), revision(1)],
    nextCursor: null,
  });
  await mount(shared, <BriefsTab />);
  expect(read).toHaveBeenCalledWith(ID, 'commander', 3);
  expect(text()).toContain('Ada has changed this brief since you accepted the agent.');
  expect(text()).toContain('You run r3; the latest is r5.');
  expect(hasButton('Edit')).toBe(false);
  expect(hasButton('More actions for commander')).toBe(false);

  // Review changes opens History on the revision they run, compared with the latest.
  await click('Review changes');
  expect(route.search).toMatchObject({ history: 3 });
  await until(() => text().includes('Changes since r3'), 'the review view');
  expect(must(document.querySelector('.segmented .is-on')).textContent).toBe('Changes since r3');
  await until(() => document.querySelector('.prompt-diff') !== null, 'the diff');
  expect(text()).toContain('− r3');
  expect(text()).toContain('+ r5, current');
  expect(text()).toContain('the one you run');
  expect(text()).toContain('newer than yours');
  expect(hasButton('Restore as r6')).toBe(false);
});

it('counts bytes against the 16 KB cap, refuses to save past it, and a 409 shows theirs and puts mine on top', async () => {
  route.search = { b: 'commander' };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 3)] });
  const read = vi
    .spyOn(api.agentRepo, 'brief')
    .mockImplementation(async (_id, _name, n) =>
      n === 4
        ? brief('commander', 4, 'Run the gate twice.\n', { author: { id: ada.id, name: 'Ada' } })
        : brief('commander', n ?? 3, 'Run the gate.\n'),
    );
  const revisions = vi
    .spyOn(api.agentRepo, 'briefRevisions')
    .mockResolvedValue({ revisions: [revision(3)], nextCursor: null });
  const save = vi
    .spyOn(api.agentRepo, 'saveBrief')
    .mockRejectedValueOnce(new ApiError(409, 'conflict', 'Brief changed'))
    .mockResolvedValueOnce({ ...brief('commander', 5, 'x'), created: false });
  await mount(agentWith(), <BriefsTab />);

  process.stdout.write('[brief fixture] byte-cap: brief loaded; opening real rich editor\n');
  await click('Edit');
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  process.stdout.write('[brief fixture] byte-cap: rich editor ready\n');
  expect(button('Save as r4').disabled).toBe(true);
  expect(must(document.querySelector('.brief-size')).textContent).toBe('14 bytes of 16 KB');

  await click('View Markdown');
  const source = must(document.querySelector<HTMLTextAreaElement>('textarea.md-source'));
  process.stdout.write('[brief fixture] byte-cap: Markdown source ready\n');
  expect(source.value).toBe('Run the gate.\n');
  // 6 000 characters of CJK is 18 000 bytes: past the cap, whatever a character count says.
  await act(async () => type(source, '字'.repeat(6_000)));
  expect(must(document.querySelector('.brief-size')).textContent).toBe('17.6 KB of 16 KB');
  expect(must(document.querySelector('.brief-size')).className).toContain('is-over');
  expect(text()).toContain('Too long by 1.6 KB');
  expect(button('Save as r4').disabled).toBe(true);

  await act(async () => type(source, 'Run the whole gate.\n'));
  expect(button('Save as r4').disabled).toBe(false);
  await act(async () =>
    type(
      must(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Why — kept with this revision"]',
        ),
      ),
      'the gate grew',
    ),
  );
  revisions.mockResolvedValue({ revisions: [revision(4), revision(3)], nextCursor: null });
  process.stdout.write(
    '[brief fixture] byte-cap: edited source and note ready; saving against r3\n',
  );
  await click('Save as r4');
  await until(
    () => text().includes('Ada changed this brief while you were editing'),
    'the conflict sheet',
  );
  process.stdout.write('[brief fixture] byte-cap: conflict sheet ready\n');
  expect(save).toHaveBeenNthCalledWith(1, ID, 'commander', {
    body: 'Run the whole gate.\n',
    expectedRevision: 3,
    note: 'the gate grew',
  });
  expect(read).toHaveBeenCalledWith(ID, 'commander', 4);
  expect(text()).toContain('It is now r4, edited by Ada');
  // What they changed, then theirs in full.
  expect(text()).toContain('r3, where you started');
  expect(text()).toContain('r4, theirs');
  await click('Theirs');
  expect(must(document.querySelector('.modal-panel .md-doc')).textContent).toContain(
    'Run the gate twice.',
  );

  await click('Save mine on top');
  process.stdout.write('[brief fixture] byte-cap: save-on-top action dispatched\n');
  expect(save).toHaveBeenNthCalledWith(2, ID, 'commander', {
    body: 'Run the whole gate.\n',
    expectedRevision: 4,
    note: 'the gate grew',
  });
});

it('writes a new brief from plain words: the name is normalised, a taken one is said so', async () => {
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 1)] });
  const save = vi
    .spyOn(api.agentRepo, 'saveBrief')
    .mockResolvedValue({ ...brief('site-delivery', 1, 'x'), created: true });
  await mount(agentWith(), <BriefsTab />);
  await click('New brief');
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  const name = must(document.querySelector<HTMLInputElement>('#brief-name'));
  await act(async () => type(name, 'Commander'));
  expect(name.value).toBe('commander');
  expect(text()).toContain('There’s already a brief called commander.');
  await act(async () => type(name, 'Site Delivery'));
  expect(name.value).toBe('site-delivery');
  await act(async () =>
    type(must(document.querySelector<HTMLInputElement>('#brief-description')), 'How a site ships'),
  );
  await click('View Markdown');
  await act(async () =>
    type(must(document.querySelector<HTMLTextAreaElement>('textarea.md-source')), '# Ship it\n'),
  );
  await click('Add brief');
  expect(save).toHaveBeenCalledWith(ID, 'site-delivery', {
    body: '# Ship it\n',
    description: 'How a site ships',
  });
  expect(route.search).toEqual({ b: 'site-delivery' });
});

it('diffs a revision against the current one in History, and restores it as the next revision', async () => {
  route.search = { b: 'commander', history: 2 };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 3)] });
  vi.spyOn(api.agentRepo, 'brief').mockImplementation(async (_id, _name, n) =>
    brief('commander', n ?? 3, `Line one.\nRevision ${n ?? 3} line.\n`),
  );
  vi.spyOn(api.agentRepo, 'briefRevisions').mockResolvedValue({
    revisions: [
      revision(3),
      revision(2, {
        source: 'agent',
        harness: 'codex',
        clientLabel: 'MacBook',
        note: 'from a session',
      }),
      revision(1),
    ],
    nextCursor: null,
  });
  const save = vi
    .spyOn(api.agentRepo, 'saveBrief')
    .mockResolvedValue({ ...brief('commander', 4, 'x'), created: false });
  await mount(agentWith(), <BriefsTab />);
  await until(() => document.querySelector('.history-list li') !== null, 'the history');
  const rows = Array.from(document.querySelectorAll('.history-row')).map((r) => r.textContent);
  expect(rows[1]).toContain(
    'r2 · written by the agent in Codex (claimed) (MacBook) · cosigned by Lucas',
  );
  expect(rows[1]).toContain('“from a session”');

  await until(() => document.querySelector('.prompt-diff') !== null, 'what r2 changed');
  expect(text()).toContain('− r1');
  expect(text()).toContain('+ r2');
  await click('Compare with current');
  await until(() => text().includes('+ r3, current'), 'the comparison');
  await click('Restore as r4');
  expect(save).toHaveBeenCalledWith(ID, 'commander', {
    body: 'Line one.\nRevision 2 line.\n',
    description: 'commander facts',
    expectedRevision: 3,
    note: 'Restored r2',
  });
});

it('offers Delete to the owner alone, and wants the name typed back before it goes', async () => {
  route.search = { b: 'commander' };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 3)] });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(brief('commander', 3, 'x'));
  const remove = vi.spyOn(api.agentRepo, 'deleteBrief').mockResolvedValue(undefined);
  const rename = vi
    .spyOn(api.agentRepo, 'renameBrief')
    .mockResolvedValue({ brief: entry('product-facts', 3) });

  // Someone the agent is shared with to edit: Rename, but no Delete.
  const editor = agentWith({
    role: 'shared',
    owner: ada,
    access: { prompt: 'edit', memory: 'edit', canManage: false, canWriteAs: true },
    acceptedVersion: 4,
  });
  await mount(editor, <BriefsTab />);
  await click('More actions for commander');
  expect(hasButton('Rename…')).toBe(true);
  expect(hasButton('Delete…')).toBe(false);

  await click('Rename…');
  const field = must(document.querySelector<HTMLInputElement>('#brief-rename'));
  await act(async () => type(field, 'Product Facts'));
  expect(field.value).toBe('product-facts');
  await click('Rename');
  expect(rename).toHaveBeenCalledWith(ID, 'commander', 'product-facts');
  expect(route.search).toEqual({ b: 'product-facts' });

  route.search = { b: 'commander' };
  await mount(agentWith(), <BriefsTab />);
  await click('More actions for commander');
  await click('Delete…');
  expect(text()).toContain('It goes for everyone this agent is shared with, straight away');
  expect(button('Delete brief').disabled).toBe(true);
  const confirm = must(document.querySelector<HTMLInputElement>('.modal-panel input.field'));
  await act(async () => type(confirm, 'commander'));
  await click('Delete brief');
  expect(remove).toHaveBeenCalledWith(ID, 'commander');
  expect(route.search).toEqual({});
});

it('asks a recipient to accept before showing briefs, without asking the server', async () => {
  const list = vi.spyOn(api.agentRepo, 'briefs');
  await mount(agentWith({ role: 'shared', owner: ada, awaitingAccept: true }), <BriefsTab />);
  expect(text()).toContain('Accept this agent to read its briefs');
  expect(list).not.toHaveBeenCalled();
});

it('tells a brief’s story in Activity, in words, with a link to the diff', async () => {
  const item = (brief: ActivityItemDto['brief'], extra: Partial<ActivityItemDto> = {}) => ({
    kind: 'brief' as const,
    at: AT,
    cosigner: { id: me.id, name: me.name },
    byAgent: false,
    harness: null,
    clientLabel: null,
    harnessCheck: 'claimed' as const,
    client: null,
    workspace: null,
    summary: '',
    version: 2,
    note: null,
    memoryChanges: [],
    brief,
    ...extra,
  });
  const activity = vi.spyOn(api.agentRepo, 'activity').mockResolvedValue({
    items: [
      item({ name: 'scratch', op: 'delete', previousName: null }, { version: 1 }),
      item({ name: 'product-facts', op: 'rename', previousName: 'facts' }),
      item(
        { name: 'product-facts', op: 'update', previousName: null },
        { byAgent: true, harness: 'codex', note: 'deploy moved' },
      ),
    ],
    nextCursor: null,
  });
  await mount(agentWith(), <ActivityTab />);
  const lines = Array.from(document.querySelectorAll('.activity-text')).map((l) => l.textContent);
  expect(lines[0]).toContain('Brief scratch deleted');
  expect(lines[1]).toContain('Brief product-facts renamed from facts');
  expect(lines[2]).toContain('Brief product-facts r2 · by the agent in Codex');
  expect(lines[2]).toContain('“deploy moved”');
  const diff = must(
    Array.from(document.querySelectorAll('a')).find((a) => a.textContent === 'View diff'),
  );
  expect(diff.getAttribute('href')).toBe('/repo/$agentId/briefs?b=product-facts&history=2');

  await click('Briefs');
  expect(activity).toHaveBeenLastCalledWith(ID, { kind: 'briefs' });
});

it('tells a held prompt change, and another agent’s edit, in Activity', async () => {
  const prompt = (extra: Partial<ActivityItemDto>): ActivityItemDto => ({
    kind: 'prompt',
    at: AT,
    cosigner: { id: me.id, name: me.name },
    byAgent: true,
    harness: 'codex',
    clientLabel: null,
    harnessCheck: 'claimed',
    client: null,
    workspace: null,
    summary: '',
    version: null,
    note: null,
    memoryChanges: [],
    brief: null,
    ...extra,
  });
  vi.spyOn(api.agentRepo, 'activity').mockResolvedValue({
    items: [
      prompt({ proposal: 'pending' }),
      prompt({ proposal: 'accepted', version: 5, at: '2026-09-25T00:00:00.000Z' }),
      prompt({ proposal: null, editor: 'Lulu', version: 4, at: '2026-09-24T00:00:00.000Z' }),
    ],
    nextCursor: null,
  });
  await mount(agentWith(), <ActivityTab />);
  const lines = Array.from(document.querySelectorAll('.activity-text')).map((l) => l.textContent);
  expect(lines[0]).toContain(
    'Prompt change proposed · by the agent in Codex (claimed) · waiting for the owner',
  );
  expect(lines[1]).toContain('proposed · by the agent in Codex (claimed) · accepted as v5');
  expect(lines[2]).toContain('Prompt v4 · edited by Lulu in Codex (claimed)');
  expect(Array.from(document.querySelectorAll('a')).map((a) => a.textContent)).toContain('Review');
});

it('names the viewer "you" in the byline, History and Activity, and the owner by the name the page knows', async () => {
  viewer.id = me.id;
  route.search = { b: 'commander', history: 2 };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 2)] });
  vi.spyOn(api.agentRepo, 'brief').mockImplementation(async (_id, _name, n) =>
    // A person with no name set: the server sends the id and a null name.
    brief('commander', n ?? 2, `body ${n ?? 2}\n`, { author: { id: me.id, name: null } }),
  );
  vi.spyOn(api.agentRepo, 'briefRevisions').mockResolvedValue({
    revisions: [revision(2, { author: { id: me.id, name: null } }), revision(1)],
    nextCursor: null,
  });
  await mount(agentWith(), <BriefsTab />);
  // Two queries paint this screen — the revision list and the brief itself —
  // and either may land first (CI pipeline 5801 caught the brief arriving
  // second). Wait on an element from each before reading either.
  await until(
    () =>
      document.querySelector('.history-row') !== null &&
      document.querySelector('.brief-meta') !== null,
    'the history and the brief',
  );
  expect(must(document.querySelector('.brief-meta')).textContent).toContain('r2 · edited by you');
  expect(must(document.querySelector('.history-row')).textContent).toContain('r2 · edited by you');
  expect(text()).not.toContain('someone');

  // Selecting a revision moves the address with it, so the link opens what is shown.
  await click('r1');
  expect(route.search).toMatchObject({ b: 'commander', history: 1 });

  // A recipient reads the owner by the name the page already shows for them.
  viewer.id = 'u9';
  vi.spyOn(api.agentRepo, 'activity').mockResolvedValue({
    items: [
      {
        kind: 'brief',
        at: AT,
        cosigner: { id: ada.id, name: null },
        byAgent: false,
        harness: null,
        clientLabel: null,
        harnessCheck: 'claimed' as const,
        client: null,
        workspace: null,
        summary: '',
        version: 1,
        note: null,
        memoryChanges: [],
        brief: { name: 'commander', op: 'create', previousName: null },
      },
    ],
    nextCursor: null,
  });
  await mount(agentWith({ role: 'shared', owner: ada }), <ActivityTab />);
  expect(must(document.querySelector('.activity-text')).textContent).toContain('by Ada');
});

it('keeps the text when the brief is renamed under the edit, and saves it into the new name', async () => {
  route.search = { b: 'facts' };
  const list = vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('facts', 1)] });
  vi.spyOn(api.agentRepo, 'brief').mockImplementation(async (_id, name, n) =>
    brief(name, n ?? 1, name === 'facts' ? 'Run the gate.\n' : '# Facts\n\nRun the **gate**.\n'),
  );
  vi.spyOn(api.agentRepo, 'briefRevisions').mockResolvedValue({
    revisions: [revision(1)],
    nextCursor: null,
  });
  vi.spyOn(api.agentRepo, 'activity').mockResolvedValue({
    items: [
      {
        kind: 'brief',
        at: AT,
        cosigner: null,
        byAgent: false,
        harness: null,
        clientLabel: null,
        harnessCheck: 'claimed' as const,
        client: null,
        workspace: null,
        summary: '',
        version: 1,
        note: null,
        memoryChanges: [],
        brief: { name: 'product-facts', op: 'rename', previousName: 'facts' },
      },
    ],
    nextCursor: null,
  });
  const save = vi
    .spyOn(api.agentRepo, 'saveBrief')
    // The server's words are for agents ("Leave out expectedRevision…"): never shown.
    .mockRejectedValueOnce(
      new ApiError(404, 'not_found', "'x' has no brief called 'facts'. Leave out expectedRevision"),
    )
    .mockResolvedValueOnce({ ...brief('product-facts', 2, 'x'), created: false });
  await mount(agentWith(), <BriefsTab />);
  await click('Edit');
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  await click('View Markdown');
  const source = must(document.querySelector<HTMLTextAreaElement>('textarea.md-source'));
  await act(async () => type(source, 'Run the whole gate.\n'));
  list.mockResolvedValue({ briefs: [entry('product-facts', 1)] });
  await click('Save as r2');
  await until(() => text().includes('renamed or deleted while you were editing'), 'the notice');
  expect(text()).toContain(
    'This brief was renamed or deleted while you were editing. Your text is kept below.',
  );
  expect(text()).toContain('It’s now called product-facts.');
  expect(text()).not.toMatch(/expectedRevision/);
  expect(source.value).toBe('Run the whole gate.\n');
  expect(button('Save as r2').disabled).toBe(true);

  await click('Save it into product-facts');
  await until(() => text().includes('This brief is now called product-facts'), 'the sheet');
  // What they changed reads as words, not Markdown marks; the source is one tap away.
  const changes = must(document.querySelector('.modal-panel .prompt-diff')).textContent;
  expect(changes).not.toContain('**');
  expect(changes).not.toContain('as Markdown');
  await click('Markdown');
  expect(must(document.querySelector('.modal-panel .prompt-diff')).textContent).toContain(
    'as Markdown',
  );
  await click('Save mine on top');
  expect(save).toHaveBeenLastCalledWith(ID, 'product-facts', {
    body: 'Run the whole gate.\n',
    expectedRevision: 1,
  });
});

it('keeps the text when the brief is deleted under the edit, and saves it as a new brief', async () => {
  route.search = { b: 'facts' };
  const list = vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('facts', 1)] });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(brief('facts', 1, 'Run the gate.\n'));
  vi.spyOn(api.agentRepo, 'briefRevisions').mockResolvedValue({
    revisions: [revision(1)],
    nextCursor: null,
  });
  vi.spyOn(api.agentRepo, 'activity').mockResolvedValue({ items: [], nextCursor: null });
  const save = vi
    .spyOn(api.agentRepo, 'saveBrief')
    .mockRejectedValueOnce(new ApiError(404, 'not_found', 'gone'))
    .mockResolvedValueOnce({ ...brief('facts', 1, 'x'), created: true });
  await mount(agentWith(), <BriefsTab />);
  await click('Edit');
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  await click('View Markdown');
  await act(async () =>
    type(must(document.querySelector<HTMLTextAreaElement>('textarea.md-source')), 'Kept text.\n'),
  );
  list.mockResolvedValue({ briefs: [] });
  await click('Save as r2');
  await until(() => text().includes('Your text is kept below.'), 'the notice');
  expect(hasButton('Save it into')).toBe(false);
  await click('Save as a new brief');
  expect(must(document.querySelector<HTMLInputElement>('#brief-name')).value).toBe('facts');
  await click('Add brief');
  expect(save).toHaveBeenLastCalledWith(ID, 'facts', {
    body: 'Kept text.\n',
    description: 'facts facts',
  });
});

it('says plainly when a new brief’s name was taken in the meantime', async () => {
  const list = vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [] });
  vi.spyOn(api.agentRepo, 'saveBrief').mockRejectedValue(
    new ApiError(
      409,
      'conflict',
      'Read it with get_agent_brief and update it with expectedRevision 1.',
    ),
  );
  await mount(agentWith(), <BriefsTab />);
  await click('New brief');
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  await act(async () =>
    type(must(document.querySelector<HTMLInputElement>('#brief-name')), 'deploy'),
  );
  await act(async () =>
    type(must(document.querySelector<HTMLInputElement>('#brief-description')), 'How it ships'),
  );
  await click('View Markdown');
  await act(async () =>
    type(must(document.querySelector<HTMLTextAreaElement>('textarea.md-source')), 'Ship.\n'),
  );
  list.mockResolvedValue({ briefs: [entry('deploy', 1)] });
  await click('Add brief');
  await until(() => text().includes('already a brief called deploy'), 'the message');
  expect(text()).toContain('There’s already a brief called deploy. Choose another name.');
  expect(text()).not.toMatch(/get_agent_brief|expectedRevision/);
});

it('says the brief changed in another tab when the save in between was the viewer’s own', async () => {
  viewer.id = me.id;
  route.search = { b: 'commander' };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 1)] });
  vi.spyOn(api.agentRepo, 'brief').mockImplementation(async (_id, _name, n) =>
    brief('commander', n ?? 1, n === 2 ? 'From the other tab.\n' : 'Start.\n', {
      author: { id: me.id, name: null },
    }),
  );
  const revisions = vi
    .spyOn(api.agentRepo, 'briefRevisions')
    .mockResolvedValue({ revisions: [revision(1)], nextCursor: null });
  vi.spyOn(api.agentRepo, 'saveBrief').mockRejectedValueOnce(
    new ApiError(409, 'conflict', 'Brief changed'),
  );
  await mount(agentWith(), <BriefsTab />);
  await click('Edit');
  await until(() => document.querySelector('.md-rich [contenteditable]') !== null, 'the editor');
  await click('View Markdown');
  await act(async () =>
    type(must(document.querySelector<HTMLTextAreaElement>('textarea.md-source')), 'Mine.\n'),
  );
  revisions.mockResolvedValue({ revisions: [revision(2), revision(1)], nextCursor: null });
  await click('Save as r2');
  await until(() => text().includes('another tab or window'), 'the sheet');
  expect(must(document.querySelector('.modal-panel h2')).textContent).toBe(
    'This brief changed in another tab or window',
  );
  expect(text()).toContain('It is now r2, edited by you');
  expect(text()).not.toContain('Someone');
});

/* ------------------------------ bound to a repository ----------------------------- */

const stale = (over: Partial<BriefStaleDto> = {}): BriefStaleDto => ({
  repo: {
    project: 'lucas/on-my-radar',
    path: 'docs/AGENT-BRIEF.md',
    ref: 'main',
    mirror: false,
    url: 'https://gitlab.test/lucas/on-my-radar/-/blob/main/docs/AGENT-BRIEF.md',
  },
  state: 'behind',
  commitsBehind: 3,
  capped: false,
  revision: 2,
  checkedAt: AT,
  reason: null,
  drift: null,
  mirror: null,
  ...over,
});

it('says how far a bound brief’s repository has moved, in the list and on the brief', async () => {
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({
    briefs: [
      entry('commander', 2, { stale: stale() }),
      entry('current-one', 1, {
        stale: stale({ state: 'current', commitsBehind: 0, revision: 1 }),
      }),
      entry('unbound', 1),
    ],
  });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(
    brief('commander', 2, 'facts', { stale: stale() }),
  );
  await mount(agentWith(), <BriefsTab />);
  const rows = Array.from(document.querySelectorAll('.memory-row'));
  expect(rows[0]?.querySelector('.brief-repo-chip')?.textContent).toBe('3 commits behind');
  expect(rows[0]?.querySelector('.brief-repo-chips')?.getAttribute('aria-label')).toBe(
    'Repository: 3 commits behind lucas/on-my-radar',
  );
  // Current and unbound briefs carry no chip: the list is for what needs a look.
  expect(rows[1]?.querySelector('.brief-repo-chip')).toBeNull();
  expect(rows[2]?.querySelector('.brief-repo-chip')).toBeNull();

  await click('commander');
  const readout = must(document.querySelector('.brief-repo'));
  expect(readout.textContent).toContain('3 commits behind lucas/on-my-radar since r2');
  const link = must(readout.querySelector<HTMLAnchorElement>('a'));
  expect(link.textContent).toBe('lucas/on-my-radar · docs/AGENT-BRIEF.md @ main');
  expect(link.href).toBe('https://gitlab.test/lucas/on-my-radar/-/blob/main/docs/AGENT-BRIEF.md');
  expect(link.target).toBe('_blank');
  expect(readout.querySelector('.brief-repo-state')?.className).toContain('is-behind');
  // Not an admin: no way to change it.
  expect(hasButton('Change…')).toBe(false);
});

it('says "not checked" with the server’s reason rather than an error', async () => {
  route.search = { b: 'commander' };
  const notChecked = stale({
    state: 'not_checked',
    commitsBehind: null,
    revision: null,
    checkedAt: null,
    reason: 'This server has no read token for lucas/on-my-radar.',
  });
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({
    briefs: [entry('commander', 2, { stale: notChecked })],
  });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(brief('commander', 2, 'facts'));
  await mount(agentWith(), <BriefsTab />);
  const readout = must(document.querySelector('.brief-repo'));
  expect(readout.textContent).toContain('not checked against lucas/on-my-radar');
  expect(readout.textContent).toContain('This server has no read token for lucas/on-my-radar.');
  expect(readout.textContent).not.toMatch(/checked \d/);
  expect(document.querySelector('.brief-repo [role="alert"]')).toBeNull();
});

it('reports drift as an edit that stays in the repository, and where the mirror stands', async () => {
  route.search = { b: 'commander' };
  const drifted = stale({
    state: 'current',
    commitsBehind: 0,
    repo: { ...stale().repo, mirror: true },
    drift: {
      kind: 'edited',
      commit: 'abc1234',
      title: 'Tweak the brief by hand',
      at: AT,
      url: 'https://gitlab.test/commit/abc1234',
    },
    mirror: {
      state: 'opened',
      revision: 2,
      mergeRequestUrl: 'https://gitlab.test/mr/7',
      reason: null,
    },
  });
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({
    briefs: [entry('commander', 2, { stale: drifted })],
  });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(brief('commander', 2, 'facts'));
  await mount(agentWith(), <BriefsTab />);
  const banner = must(document.querySelector('.brief-drift'));
  expect(banner.textContent).toContain('Drift: edited in repo.');
  expect(banner.textContent).toContain('Latest: “Tweak the brief by hand” (abc1234).');
  expect(banner.textContent).toContain('is not imported');
  expect(banner.textContent).toContain('its next mirror merge request writes it over that file');
  expect(must(banner.querySelector<HTMLAnchorElement>('a')).href).toBe(
    'https://gitlab.test/commit/abc1234',
  );
  expect(text()).toContain('mirror: merge request open for r2');
  const mr = Array.from(document.querySelectorAll<HTMLAnchorElement>('.brief-repo a')).find((a) =>
    a.textContent.includes('merge request'),
  );
  expect(mr?.href).toBe('https://gitlab.test/mr/7');
});

it('lets an administrator who owns the agent bind a brief, mirror only into a file, and unbind it', async () => {
  viewer.id = me.id;
  viewer.admin = true;
  route.search = { b: 'commander' };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({ briefs: [entry('commander', 2)] });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(brief('commander', 2, 'facts'));
  const bind = vi.spyOn(api.agentRepo, 'bindBrief').mockResolvedValue({ stale: stale() });
  await mount(agentWith(), <BriefsTab />);

  await click('More actions for commander');
  await click('Bind to a repository…');
  const field = (id: string) => must(document.querySelector<HTMLInputElement>(`#${id}`));
  expect(field('binding-path').value).toBe('docs/AGENT-BRIEF.md');
  expect(field('binding-ref').value).toBe('main');

  // An empty project is refused in the schema's words, before any request.
  await click('Bind');
  expect(bind).not.toHaveBeenCalled();
  expect(text()).toContain('A GitLab project path, like group/project');

  await act(async () => type(field('binding-project'), 'lucas/on-my-radar'));
  // A folder can be watched but not mirrored into.
  await act(async () => type(field('binding-path'), 'packages/server/'));
  const mirror = must(document.querySelector<HTMLInputElement>('.brief-binding-mirror input'));
  expect(mirror.disabled).toBe(true);
  expect(text()).toContain('A mirror writes one file');
  await act(async () => type(field('binding-path'), 'docs/AGENT-BRIEF.md'));
  expect(mirror.disabled).toBe(false);
  expect(text()).toContain('Nothing is pushed straight to main');
  await act(async () => mirror.click());
  await click('Bind');
  expect(bind).toHaveBeenCalledWith(ID, 'commander', {
    project: 'lucas/on-my-radar',
    path: 'docs/AGENT-BRIEF.md',
    ref: 'main',
    mirror: true,
  });
});

it('offers an owner who is not an administrator no binding, and a bound brief’s owner Change and Stop checking', async () => {
  viewer.id = me.id;
  route.search = { b: 'commander' };
  vi.spyOn(api.agentRepo, 'briefs').mockResolvedValue({
    briefs: [entry('commander', 2, { stale: stale() })],
  });
  vi.spyOn(api.agentRepo, 'brief').mockResolvedValue(brief('commander', 2, 'facts'));
  const unbind = vi.spyOn(api.agentRepo, 'unbindBrief').mockResolvedValue(undefined);
  await mount(agentWith(), <BriefsTab />);
  await click('More actions for commander');
  expect(hasButton('Repository…')).toBe(false);
  expect(hasButton('Bind to a repository…')).toBe(false);
  await act(async () => root.unmount());

  viewer.admin = true;
  root = createRoot(host);
  await mount(agentWith(), <BriefsTab />);
  await click('Change…');
  expect(must(document.querySelector<HTMLInputElement>('#binding-project')).value).toBe(
    'lucas/on-my-radar',
  );
  await click('Stop checking the repository');
  expect(unbind).toHaveBeenCalledWith(ID, 'commander');
});

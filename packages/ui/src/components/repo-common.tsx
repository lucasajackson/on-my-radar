/**
 * Small pieces every Agent Repo screen shares: the glyph, the meta lines, the
 * "who wrote this" sentences, the switch and the segmented control.
 *
 * The vocabulary is the mental model's (docs/AGENT_REPO.md §V2.1): an *agent*
 * lives here; a *tool* runs it; a *profile* is its settings for one tool; and a
 * person always *cosigns* what an agent writes — set in the human colour, so
 * the two names never read as one.
 */
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import {
  HARNESSES,
  SHARE_PRESETS,
  resolveHarness,
  type Harness,
  type HarnessVerdict,
  type MemoryDto,
  type MemorySource,
  type RadarAccent,
  type RepoAgentDto,
  type SharePreset,
} from '@onmyradar/contract';
import { relativeTime } from '../lib/format';
import { queryKeys, useSession } from '../lib/session';
import { ConfirmDialog } from './primitives';
import { AgentPageContext } from './repo-context';

/** The six accents an agent can wear — the mockup's swatches, as registry keys. */
export const AGENT_ACCENTS: readonly RadarAccent[] = [
  'cobalt',
  'pine',
  'citrus',
  'ember',
  'plum',
  'slate',
];

/** A tool's short name, from whatever an agent reported ("claude_code" → "Claude Code"). */
export function toolName(raw: string | null | undefined): string {
  const harness = resolveHarness(raw);
  if (harness) return HARNESSES[harness].short;
  return raw?.trim() || 'a tool';
}

const CHECK_WHY = {
  verified: 'The connection this ran through is this tool’s own sign-in.',
  claimed:
    'The agent named this tool itself. Tokens, browser sessions and connections since removed cannot be checked.',
  mismatch: 'The agent named this tool, but the connection it ran through belongs to another one.',
} as const;

/** "Claude Code (verified)", "Codex (claimed)", "Codex? (via Claude)". */
export function toolLabel(raw: string | null | undefined, v: HarnessVerdict): string {
  const tool = toolName(raw);
  return v.harnessCheck === 'mismatch'
    ? `${tool}? (via ${(v.client ?? 'another tool').slice(0, 24)})`
    : `${tool} (${v.harnessCheck})`;
}

/** The tool an agent ran in and whether its connection backs that up; nothing without a tool. */
export function HarnessChip({
  harness,
  harnessCheck,
  client,
}: HarnessVerdict & { harness: string | null }) {
  if (!harness) return null;
  return (
    <span className="token harness-chip" data-check={harnessCheck} title={CHECK_WHY[harnessCheck]}>
      {toolLabel(harness, { harnessCheck, client })}
    </span>
  );
}

export function memoryTotal(agent: Pick<RepoAgentDto, 'memoryCounts'>): number {
  return Object.values(agent.memoryCounts).reduce((sum, count) => sum + count, 0);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function presetLabel(preset: SharePreset | 'custom' | null): string {
  if (!preset) return '';
  return preset === 'custom' ? 'Custom access' : SHARE_PRESETS[preset].label;
}

export function personName(person: { name: string | null; email?: string | null } | null): string {
  return person?.name?.trim() || person?.email?.split('@')[0] || 'someone';
}

/**
 * A person who wrote or cosigned something, as the viewer reads them: "you"
 * for the viewer; the owner by the name the page already shows for them (a
 * revision's author carries a name only, so an owner without one read
 * "someone" while the banner above said "ada"); anyone else by name.
 */
export function useWho(): (person: { id: string; name: string | null } | null) => string {
  const me = useSession().user?.id ?? null;
  const owner = useContext(AgentPageContext)?.agent.owner ?? null;
  return (person) => {
    if (!person) return 'someone';
    if (person.id === me) return 'you';
    if (owner && person.id === owner.id) return personName(owner);
    return personName(person);
  };
}

/**
 * "2h ago", "just now", "on Sep 26" — `relativeTime` is a bare mono token
 * ("2h", "now", "Sep 26"), which is right in a meta row of tokens and wrong
 * inside a sentence.
 */
export function ago(iso: string): string {
  const short = relativeTime(iso);
  if (short === 'now') return 'just now';
  return /^\d+[smhd]$/.test(short) ? `${short} ago` : `on ${short}`;
}

/** "used 2h ago in Claude Code", or "not used yet". */
export function usedLine(agent: RepoAgentDto): string {
  const last = agent.lastSession;
  if (!last) return 'not used yet';
  return `used ${ago(last.startedAt)} in ${toolName(last.harness)}`;
}

/** The meta line under an agent's name, on the list and on its page. */
export function agentMeta(agent: RepoAgentDto, { page = false }: { page?: boolean } = {}): string {
  const owner =
    agent.role === 'owner'
      ? page
        ? 'owned by you'
        : null
      : `shared by ${personName(agent.owner)} · ${presetLabel(agent.sharedPreset).toLowerCase()}`;
  return [
    `@${agent.handle}`,
    owner,
    plural(memoryTotal(agent), 'memory', 'memories'),
    usedLine(agent),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Who wrote a memory's current revision, as a sentence fragment: "the agent in
 * Claude Code (MacBook)", "Ada", "Ada (collaborator)", "imported".
 */
export function writerOf(item: {
  source: MemorySource;
  harness: string | null;
  clientLabel: string | null;
  harnessCheck: HarnessVerdict['harnessCheck'];
  client: string | null;
  author: { name: string | null } | null;
  collaborator?: boolean;
}): string {
  if (item.source === 'import') return 'imported';
  if (item.source === 'agent') {
    return `the agent in ${toolLabel(item.harness, item)}${item.clientLabel ? ` (${item.clientLabel})` : ''}`;
  }
  return `${personName(item.author)}${item.collaborator ? ' (collaborator)' : ''}`;
}

/** The provenance line on a memory: "r4 · written by the agent in … · cosigned by Ada". */
export function Provenance({ memory }: { memory: MemoryDto }) {
  return (
    <span>
      r{memory.revision} ·{' '}
      {memory.source === 'import' ? 'imported' : `written by ${writerOf(memory)}`}
      {memory.source === 'agent' && memory.author ? (
        <>
          {' · '}
          <Cosigned name={personName(memory.author)} />
        </>
      ) : null}
      {' · '}
      {ago(memory.updatedAt)}
    </span>
  );
}

/** "cosigned by Ada", with the person in the human colour. */
export function Cosigned({ name }: { name: string }) {
  return (
    <span className="cosign">
      cosigned by <span className="human">{name}</span>
    </span>
  );
}

/** The agent's mark: its accent, its initial. Reads `--accent-fill` from the container. */
export function AgentGlyph({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span className={`agent-glyph ${size === 'lg' ? 'is-lg' : ''}`} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** An on/off control that says what it is to a screen reader. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}

/** A segmented control: one of a few, all visible. Pressed state, not tabs. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={option.value === value ? 'is-on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Every tool, for pickers: label, and its "reads …" line as the description. */
export function toolOptions(
  tools: readonly Harness[] = Object.keys(HARNESSES) as Harness[],
): Array<{ value: Harness; label: string; description: string }> {
  return tools.map((id) => ({
    value: id,
    label: HARNESSES[id].label,
    description: HARNESSES[id].reads,
  }));
}

/** Refetch everything about one agent, and the list it appears in. */
export function useInvalidateAgent(agentId: string): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.repoAgent(agentId) }),
      client.invalidateQueries({ queryKey: queryKeys.repoAgentParts(agentId) }),
      client.invalidateQueries({ queryKey: queryKeys.repoAgents }),
    ]);
  };
}

/**
 * The layout's own width, not the viewport's: the sidebar eats the viewport.
 * `wide` reads true until the first measurement, which lands before paint;
 * `measured` says whether it has, for work that must not start on the guess.
 */
export function useWide(threshold: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [measuredWide, setWide] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWide(node.getBoundingClientRect().width >= threshold);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, wide: measuredWide ?? true, measured: measuredWide !== null };
}

/** Asks once before leaving an edit with changes in it — "the prompt", "this brief". */
export function LeaveGuard({ what }: { what: string }) {
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    enableBeforeUnload: true,
    withResolver: true,
  });
  if (blocker.status !== 'blocked') return null;
  return (
    <ConfirmDialog
      title="Leave without saving?"
      body={`Your changes to ${what} have not been saved.`}
      confirmLabel="Leave"
      danger
      onClose={() => blocker.reset()}
      onConfirm={() => blocker.proceed()}
    />
  );
}

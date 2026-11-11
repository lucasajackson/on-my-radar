/**
 * Use in… — checking an agent out into one tool, in three steps
 * (docs/AGENT_REPO_UI.md §6, docs/AGENT_REPO.md §V2.8): connect On My Radar to
 * the tool, add the agent to a project, check it works.
 *
 * Every byte shown comes from the server's `checkout` — the same pure renderer
 * the MCP tool uses — so what this dialog tells a person to paste and what an
 * agent applies are the same files. The copy that explains them is the part
 * written here, in plain language, because v1's one-line "Commit .omr/…" was
 * not understood by the person it was written for.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import {
  HARNESSES,
  profileSummary,
  resolveHarness,
  type CheckoutMode,
  type FileOperation,
  type Harness,
  type RepoAgentDto,
  type AgentSessionInventoryDto,
} from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys, useSession } from '../lib/session';
import { CopyButton } from './copy-button';
import { Modal, Spinner } from './primitives';
import { QueryError } from './query-error';
import { Select } from './select';
import { Switch, personName, toolOptions } from './repo-common';
import { MintToken } from './repo-token';
import { OnboardPill } from './onboard-pill';

/** Where "also apply these settings to the project" writes, per tool that has one. */
const PROJECT_SETTINGS_FILE: Partial<Record<Harness, string>> = {
  'claude-code': '.claude/settings.json',
  codex: '.codex/config.toml',
  'gemini-cli': '.gemini/settings.json',
};

/** What happens to a file, in words. */
function whatHappens(op: FileOperation): string {
  switch (op.op) {
    case 'write':
      return 'created';
    case 'upsert-block':
      return 'a block is added';
    case 'ensure-line':
      return 'one line is added';
    case 'merge-settings':
      return 'settings are merged in';
    case 'upsert-block-first-existing':
      return 'a block is added to the first rules file Zed reads';
  }
}

/** The text a person would put in the file, for Copy. */
function contentOf(op: FileOperation): string {
  switch (op.op) {
    case 'write':
    case 'upsert-block':
    case 'upsert-block-first-existing':
      return op.content;
    case 'ensure-line':
      return op.line;
    case 'merge-settings':
      return op.format === 'json'
        ? JSON.stringify(op.set, null, 2)
        : Object.entries(op.set)
            .map(
              ([key, value]) =>
                `${key} = ${typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`,
            )
            .join('\n');
  }
}

function Snippet({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <div className="snippet min-h-14">
      <pre>{text}</pre>
      <CopyButton
        value={text}
        label={label}
        className="btn snippet-copy min-h-11 min-w-11"
        iconClassName="h-3.5 w-3.5"
      />
    </div>
  );
}

function Step({
  number,
  done,
  title,
  children,
}: {
  number: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="use-step" aria-label={`Step ${number}: ${title}`}>
      <span className={`use-step-number ${done ? 'is-done' : ''}`} aria-hidden="true">
        {done ? <Check className="h-3.5 w-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-col gap-2.5">
        <h3 className="text-[14.5px] font-semibold">
          {title}
          {done ? <span className="sr-only"> — done</span> : null}
        </h3>
        {children}
      </div>
    </section>
  );
}

export function UseInDialog({
  agent,
  harness,
  onHarness,
  onClose,
}: {
  agent: RepoAgentDto;
  harness: Harness;
  onHarness: (harness: Harness) => void;
  onClose: () => void;
}) {
  const def = HARNESSES[harness];
  const { user } = useSession();
  const availability = useQuery({
    queryKey: [...queryKeys.tokens, user?.id],
    queryFn: () => api.tokens.list(),
    enabled: Boolean(user),
    refetchInterval: 5_000,
  });
  const mcpAvailable = availability.data?.mcp.available === true && !availability.error;
  const [mode, setMode] = useState<CheckoutMode>('primary');
  const [applySettings, setApplySettings] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // Only isolates this setup's network observations from any earlier cache.
  // Changing tools (including A → B → A) must request a new server baseline.
  const observationKey = useMemo(
    () => `${agent.id}:${harness}:${user?.id ?? ''}:${crypto.randomUUID()}`,
    [agent.id, harness, user?.id],
  );
  const [baseline, setBaseline] = useState<{
    key: string;
    startedThrough: number;
    ids: Set<string>;
  } | null>(null);
  const [connectionCheck, setConnectionCheck] = useState<{
    key: string;
    attempt: number;
    state: 'checking' | 'complete' | 'failed';
  } | null>(null);
  const nextCheckAttempt = useRef(0);
  const checkState = connectionCheck?.key === observationKey ? connectionCheck.state : null;
  const effectiveMode: CheckoutMode = def.modes.includes(mode) ? mode : 'primary';
  const settingsFile = PROJECT_SETTINGS_FILE[harness];

  const checkout = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'checkout', harness, effectiveMode, applySettings),
    queryFn: () =>
      api.agentRepo.checkout(agent.id, {
        harness,
        mode: effectiveMode,
        ...(applySettings && settingsFile ? { applyProjectSettings: true } : {}),
      }),
  });
  // Only a new delegated session for this person and selected tool is evidence.
  const sessions = useQuery<AgentSessionInventoryDto>({
    queryKey: queryKeys.repoAgentPart(agent.id, 'sessions', user?.id, harness, observationKey),
    queryFn: () => api.agentRepo.sessions(agent.id),
    enabled: Boolean(user),
    placeholderData: () => undefined,
    refetchInterval: 5_000,
  });
  const observation = sessions.data?.observation;
  const observedThrough = observation ? new Date(observation.startedThrough).getTime() : NaN;
  const validObservation = observation?.agentId === agent.id && Number.isFinite(observedThrough);
  useEffect(() => {
    if (sessions.error || !validObservation || !sessions.data || baseline?.key === observationKey)
      return;
    // The first successful fresh response establishes the cutoff, never success.
    setBaseline({
      key: observationKey,
      startedThrough: observedThrough,
      ids: new Set(sessions.data.sessions.map((session) => session.id)),
    });
  }, [
    baseline?.key,
    observationKey,
    observedThrough,
    sessions.data,
    sessions.error,
    validObservation,
  ]);
  const fromTool = (sessions.data?.sessions ?? []).filter(
    (session) =>
      Boolean(user?.id) &&
      (session.connectionKind === 'pat' || session.connectionKind === 'oauth') &&
      resolveHarness(session.harness) === harness &&
      session.cosigner?.id === user?.id,
  );
  const arrived =
    mcpAvailable &&
    !sessions.error &&
    validObservation &&
    baseline?.key === observationKey &&
    observedThrough >= baseline.startedThrough &&
    fromTool.some(
      (session) =>
        !baseline.ids.has(session.id) &&
        new Date(session.startedAt).getTime() > baseline.startedThrough &&
        new Date(session.startedAt).getTime() <= observedThrough,
    );

  const data = checkout.data?.checkout;
  const hasProfile = agent.profiles.some((profile) => profile.harness === harness);
  const summary = data?.profile
    ? profileSummary(data.profile.harness, data.profile.settings)
    : null;
  const needsToken = Boolean(data && /OMR_TOKEN|omr-token/.test(data.connect.content));
  const sentence = `Check out my On My Radar agent ${agent.ref} for ${def.short} here, and apply the files exactly as checkout_agent returns them.`;

  return (
    <Modal
      title={`Connect ${agent.name} to a tool`}
      size="lg"
      fill
      onClose={onClose}
      action={
        <Select
          aria-label="Tool"
          className="use-tool-select min-h-11 min-w-11"
          menuAlign="end"
          value={harness}
          options={toolOptions()}
          onValueChange={(value) => {
            const next = resolveHarness(value);
            if (next) onHarness(next);
          }}
        />
      }
    >
      <div className="flex flex-col gap-5">
        <p className="note">
          {def.short} {def.reads}
          {harness === 'codex'
            ? ' — so the AGENTS.md checkout covers it, and its Codex profile adds model, reasoning and sandbox settings'
            : ''}
          .
        </p>

        <section aria-label="AI connection availability" className="explain">
          {availability.isLoading ? <p>Checking AI connection access…</p> : null}
          {availability.error ? (
            <QueryError
              error={availability.error}
              resource="AI connection access"
              retry={() => availability.refetch()}
            />
          ) : null}
          {availability.data && !availability.error ? (
            <p>
              {mcpAvailable
                ? 'AI connections (MCP) are available for your account.'
                : 'AI connections (MCP) are turned off for this site.'}
            </p>
          ) : null}
        </section>

        {checkout.isLoading ? <Spinner label="Preparing the files" /> : null}
        {checkout.error ? (
          <QueryError
            error={checkout.error}
            resource="The checkout"
            retry={() => checkout.refetch()}
          />
        ) : null}

        {data ? (
          <>
            <Step number={1} done={arrived} title={`Connect On My Radar to ${def.short}`}>
              {arrived ? (
                <p className="note">
                  Connection verified: a new {def.short} session for this agent arrived from your
                  account.
                </p>
              ) : mcpAvailable ? (
                <>
                  {harness !== 'claude-ai' ? (
                    <>
                      <p className="note">Automatic setup: paste this prompt into {def.short}.</p>
                      <OnboardPill agentId={agent.id} harness={harness} />
                    </>
                  ) : (
                    <p className="note">
                      Add On My Radar in your tool’s connector settings using the manual steps
                      below.
                    </p>
                  )}
                  <p className="note">
                    {harness !== 'claude-ai'
                      ? 'Copying this prompt does not connect the tool. '
                      : ''}
                    You approve access in On My Radar, then start a new tool session.
                  </p>
                  <details open={harness === 'claude-ai'}>
                    <summary className="note min-h-11 cursor-pointer py-3">
                      Set up the connection manually
                    </summary>
                    <p className="note">
                      {data.connect.kind === 'file' && data.connect.path ? (
                        <>
                          Add this to <code className="font-mono">{data.connect.path}</code>.{' '}
                        </>
                      ) : null}
                      {data.connect.note}
                    </p>
                    <Snippet text={data.connect.content} />
                    {needsToken ? (
                      token ? (
                        <>
                          <p className="note">
                            Set it in this machine’s shell profile — never in a project file:
                          </p>
                          <Snippet text={`export OMR_TOKEN=${token}`} />
                        </>
                      ) : (
                        <MintToken
                          agent={agent}
                          tool={def.short}
                          label="Create a token for this machine"
                          onMinted={setToken}
                        />
                      )
                    ) : null}
                  </details>
                </>
              ) : (
                <p className="note">
                  Connection setup is unavailable until AI connection access is confirmed. You can
                  still copy the project files below and read your agent here. Files alone do not
                  connect a tool.
                </p>
              )}
            </Step>

            <Step number={2} done={false} title={`Add ${agent.name} to a project`}>
              {harness === 'claude-ai' ? (
                <>
                  <p className="note">
                    No files — in any chat, choose <strong>agent</strong> from the On My Radar
                    connector, then {agent.name}. Or paste this into a Project’s instructions:
                  </p>
                  {data.paste ? <Snippet text={data.paste} /> : null}
                </>
              ) : (
                <>
                  {def.modes.includes('helper') ? (
                    <div
                      className="radio-cards"
                      role="radiogroup"
                      aria-label="How it joins the project"
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={effectiveMode === 'primary'}
                        className={`radio-card ${effectiveMode === 'primary' ? 'is-on' : ''}`}
                        onClick={() => setMode('primary')}
                      >
                        <strong>This project runs as {agent.name}</strong>
                        <span className="note">Every session here is this agent.</span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={effectiveMode === 'helper'}
                        className={`radio-card ${effectiveMode === 'helper' ? 'is-on' : ''}`}
                        onClick={() => setMode('helper')}
                      >
                        <strong>Available as a helper</strong>
                        <span className="note">
                          Your main agent can hand work to it
                          {def.helperLabel ? ` — ${def.helperLabel}` : ''}.
                        </span>
                      </button>
                    </div>
                  ) : null}
                  {mcpAvailable ? (
                    <>
                      <p className="note">
                        <strong>Easiest:</strong> ask your agent — paste this to it in that project.
                      </p>
                      <Snippet text={sentence} />
                    </>
                  ) : (
                    <p className="note">
                      You can save these project files now. Loading the agent and its live memory
                      requires AI connection access.
                    </p>
                  )}
                  <details className="use-files" open={!mcpAvailable}>
                    <summary className="note min-h-11 cursor-pointer py-3">
                      Or add the files yourself
                    </summary>
                    <ul className="flex flex-col gap-2">
                      {data.operations.map((op, index) => (
                        <li key={`${op.path}-${index}`} className="use-file">
                          <span className="use-file-head">
                            <code className="font-mono text-[12.5px]">{op.path}</code>
                            <span className="note">{whatHappens(op)}</span>
                            <CopyButton
                              value={contentOf(op)}
                              className="btn btn-ghost ml-auto"
                              iconClassName="h-3.5 w-3.5"
                              ariaLabel={`Copy ${op.path}`}
                            />
                          </span>
                          <details>
                            <summary className="note">Show what goes in it</summary>
                            <pre className="snippet-pre">{contentOf(op)}</pre>
                          </details>
                        </li>
                      ))}
                    </ul>
                    {effectiveMode === 'helper' ? (
                      <p className="note">
                        Change its settings in the agent’s {def.short} profile, not in the file —
                        the next checkout rewrites the file.
                      </p>
                    ) : null}
                  </details>
                  <div className="explain">
                    <p>
                      <strong>What these files are.</strong> They tell {def.short} to load this
                      agent from On My Radar when a session starts. They hold only the agent’s name
                      and ID — no prompt, no memory, no password.
                    </p>
                    <p>
                      <strong>Commit them</strong> if you want everyone who works in this repository
                      to get the same agent. People without access to it in On My Radar see a short
                      note and carry on as normal.
                    </p>
                    <p>
                      <strong>Don’t commit them</strong> if the agent is just for you — add them to
                      your ignore file instead.
                    </p>
                  </div>
                </>
              )}
              <p className="note">
                {hasProfile && summary ? (
                  <>
                    {def.short} profile:{' '}
                    {[summary.model, ...summary.chips].filter(Boolean).join(' · ') ||
                      'the tool’s defaults'}{' '}
                    ·{' '}
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      to="/repo/$agentId/tools"
                      params={{ agentId: agent.id }}
                      search={{ profile: harness }}
                    >
                      Edit profile
                    </Link>
                  </>
                ) : (
                  <>
                    Using the default profile ·{' '}
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      to="/repo/$agentId/tools"
                      params={{ agentId: agent.id }}
                      search={{ profile: harness }}
                    >
                      Add a {def.short} profile
                    </Link>
                  </>
                )}
              </p>
              {data.withheld.length > 0 ? (
                <p className="note use-withheld">
                  {personName(agent.owner)} runs this agent with {data.withheld.join(', ')}. Yours
                  uses the {def.short} default for {data.withheld.length === 1 ? 'that' : 'those'} —
                  permission-widening settings are only ever applied on their owner’s machines.
                </p>
              ) : null}
              {settingsFile && harness !== 'claude-ai' ? (
                <div className="use-apply">
                  {/* A switch, not a checkbox input: the dialog focuses its first
                      input on open, and this one sits two screens down. */}
                  <Switch
                    label="Also apply these settings to the project"
                    checked={applySettings}
                    onChange={setApplySettings}
                  />
                  <span className="note">
                    Also apply these settings to the project (
                    <code className="font-mono">{settingsFile}</code> — affects everyone on this
                    repository)
                  </span>
                </div>
              ) : null}
            </Step>

            <Step number={3} done={arrived} title="Verify the connection">
              {sessions.error ? (
                <QueryError
                  error={sessions.error}
                  resource="Connection verification"
                  retry={() => sessions.refetch()}
                />
              ) : null}
              <button
                className="btn min-h-11"
                aria-busy={checkState === 'checking'}
                data-check-attempt={
                  connectionCheck?.key === observationKey ? connectionCheck.attempt : 0
                }
                disabled={checkState === 'checking'}
                onClick={() => {
                  const key = observationKey;
                  const attempt = ++nextCheckAttempt.current;
                  setConnectionCheck({ key, attempt, state: 'checking' });
                  const finish = (state: 'complete' | 'failed') =>
                    setConnectionCheck((current) =>
                      current?.key === key && current.attempt === attempt
                        ? { key, attempt, state }
                        : current,
                    );
                  void Promise.all([availability.refetch(), sessions.refetch()]).then(
                    ([access, inventory]) =>
                      finish(access.error || inventory.error ? 'failed' : 'complete'),
                    () => finish('failed'),
                  );
                }}
              >
                Check connection
              </button>
              <p role="status" aria-live="polite" className="note">
                {checkState === 'checking'
                  ? 'Checking the connection…'
                  : checkState === 'complete'
                    ? 'Connection check complete.'
                    : checkState === 'failed'
                      ? 'Connection check failed. Try again.'
                      : ''}
              </p>
              <p className="note">
                Start a new session in {def.short} and ask:{' '}
                <em>Which On My Radar agent are you?</em> It should answer {agent.name} and mention
                its memory.{' '}
                {arrived
                  ? 'Connection verified: your new session has arrived.'
                  : 'Waiting for a new session from your account in this tool. A copied prompt or an older session is not verification.'}
              </p>
            </Step>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Share an agent — Google-Docs-shaped, because that shape is already learned
 * (docs/AGENT_REPO_UI.md §7). Prompt and memory are shared separately, through
 * four presets that cover almost everything and Custom for the rest
 * (docs/AGENT_REPO.md §V2.6). "Can use" is the default because an agent's
 * memory is where its owner's private context accumulates.
 *
 * A topic share is computed from topic membership at access time — nobody is
 * written as a member — so the row says how many people it reaches.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MEMORY_ACCESS,
  PROMPT_ACCESS,
  SHARE_PRESETS,
  SHARE_PRESET_KEYS,
  type AgentShareDto,
  type MemoryAccess,
  type PromptAccess,
  type RepoAgentDto,
  type SharePreset,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys, useSession, useTopics } from '../lib/session';
import { Modal, Spinner, notify } from './primitives';
import { QueryError } from './query-error';
import { Select } from './select';
import { personName, plural, useInvalidateAgent } from './repo-common';

type Choice = SharePreset | 'custom';
const REMOVE = '__remove__';

const PRESET_OPTIONS = [
  ...SHARE_PRESET_KEYS.map((key) => ({
    value: key,
    label: SHARE_PRESETS[key].label,
    description: SHARE_PRESETS[key].blurb,
  })),
  { value: 'custom', label: 'Custom…', description: 'Choose prompt and memory access separately.' },
];

const isPreset = (value: string): value is SharePreset =>
  (SHARE_PRESET_KEYS as readonly string[]).includes(value);

const ACCESS_LABEL: Record<PromptAccess | MemoryAccess, string> = {
  none: 'None',
  view: 'View',
  edit: 'Edit',
};

type Target = { kind: 'topic'; id: string; label: string; members: number } | null;

export function ShareDialog({ agent, onClose }: { agent: RepoAgentDto; onClose: () => void }) {
  const { user } = useSession();
  const topics = useTopics();
  const invalidate = useInvalidateAgent(agent.id);
  const shares = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'shares'),
    queryFn: () => api.agentRepo.shares(agent.id),
  });
  const [who, setWho] = useState('');
  const [topic, setTopic] = useState<Target>(null);
  const [choice, setChoice] = useState<Choice>('use');
  const [prompt, setPrompt] = useState<PromptAccess>('view');
  const [memory, setMemory] = useState<MemoryAccess>('none');
  const [busy, setBusy] = useState(false);

  const email = who.trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const suggestions =
    !topic && email && !email.includes('@')
      ? (topics.data?.topics ?? [])
          .filter((t) => !t.archived && t.name.toLowerCase().includes(email.toLowerCase()))
          .slice(0, 5)
      : [];
  const access = choice === 'custom' ? { prompt, memory } : { preset: choice };

  const share = () =>
    void (async () => {
      setBusy(true);
      try {
        await api.agentRepo.share(agent.id, {
          ...(topic ? { topicId: topic.id } : { email }),
          ...access,
        });
        await invalidate();
        notify(
          topic
            ? `Shared with everyone in ${topic.label}`
            : `Shared with ${email} — they accept it before it runs`,
        );
        setWho('');
        setTopic(null);
      } catch (error) {
        notify(error instanceof ApiError ? error.message : 'Could not share it', 'error');
      } finally {
        setBusy(false);
      }
    })();

  const blurb =
    choice === 'custom'
      ? 'Choose prompt and memory access separately. Every share includes the prompt.'
      : SHARE_PRESETS[choice].blurb;

  return (
    <Modal title={`Share ${agent.name}`} size="lg" anchor="top" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="share-add">
          <div className="share-who">
            {topic ? (
              <span className="share-chip">
                Array: {topic.label} · {plural(topic.members, 'person', 'people')}
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Not ${topic.label}`}
                  onClick={() => setTopic(null)}
                >
                  ×
                </button>
              </span>
            ) : (
              <input
                className="field"
                aria-label="Email or array"
                placeholder="Email or array"
                value={who}
                autoComplete="off"
                onChange={(event) => setWho(event.target.value)}
              />
            )}
            {suggestions.length > 0 ? (
              <ul className="share-suggestions" aria-label="Arrays">
                {suggestions.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="share-suggestion"
                      onClick={() =>
                        setTopic({ kind: 'topic', id: t.id, label: t.name, members: t.memberCount })
                      }
                    >
                      <span aria-hidden="true">▦</span> Array: {t.name}
                      <span className="note ml-auto">
                        {plural(t.memberCount, 'person', 'people')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <Select
            aria-label="Access"
            className="share-preset"
            value={choice}
            options={PRESET_OPTIONS}
            onValueChange={(value) => {
              if (value === 'custom' || isPreset(value)) setChoice(value);
            }}
          />
          <button
            className="btn btn-accent"
            disabled={busy || (!topic && !isEmail)}
            onClick={share}
          >
            Share
          </button>
        </div>
        <p className="note">{blurb}</p>
        {choice === 'custom' ? (
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2">
              <span className="instrument">Prompt</span>
              <Select
                aria-label="Prompt access"
                className="w-32"
                value={prompt}
                options={PROMPT_ACCESS.map((v) => ({ value: v, label: ACCESS_LABEL[v] }))}
                onValueChange={(value) => {
                  const found = PROMPT_ACCESS.find((v) => v === value);
                  if (found) setPrompt(found);
                }}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="instrument">Memory</span>
              <Select
                aria-label="Memory access"
                className="w-32"
                value={memory}
                options={MEMORY_ACCESS.map((v) => ({ value: v, label: ACCESS_LABEL[v] }))}
                onValueChange={(value) => {
                  const found = MEMORY_ACCESS.find((v) => v === value);
                  if (found) setMemory(found);
                }}
              />
            </label>
          </div>
        ) : null}

        <ul className="share-list" aria-label="Who has access">
          <li className="share-row">
            <span className="share-avatar" aria-hidden="true">
              {(personName(user) || 'Y')[0]?.toUpperCase()}
            </span>
            <span className="min-w-0">
              {personName(user)} <span className="note">(you)</span>
            </span>
            <span className="note">Owner</span>
          </li>
          {shares.isLoading ? <Spinner label="Reading who has it" /> : null}
          {shares.error ? (
            <QueryError error={shares.error} resource="Sharing" retry={() => shares.refetch()} />
          ) : null}
          {(shares.data?.shares ?? []).map((row) => (
            <ShareRow key={`${row.subjectType}:${row.subjectId}`} agent={agent} share={row} />
          ))}
        </ul>
        <p className="instrument">
          People you share with run this prompt in their own tools. They get your changes when they
          choose to update.
        </p>
      </div>
    </Modal>
  );
}

function ShareRow({ agent, share }: { agent: RepoAgentDto; share: AgentShareDto }) {
  const invalidate = useInvalidateAgent(agent.id);
  const [busy, setBusy] = useState(false);
  const options = [
    ...SHARE_PRESET_KEYS.map((key) => ({
      value: key,
      label: SHARE_PRESETS[key].label,
      description: SHARE_PRESETS[key].blurb,
    })),
    ...(share.preset === 'custom'
      ? [
          {
            value: 'custom',
            label: 'Custom access',
            description: `Prompt: ${ACCESS_LABEL[share.prompt]} · Memory: ${ACCESS_LABEL[share.memory]}`,
            disabled: true,
          },
        ]
      : []),
    { value: REMOVE, label: 'Remove', description: 'It stops loading for them at once.' },
  ];
  const sub =
    share.subjectType === 'topic'
      ? `${plural(share.memberCount ?? 0, 'person', 'people')} via array`
      : [
          share.email,
          share.acceptedVersion ? `accepted v${share.acceptedVersion}` : 'waiting to accept',
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <li className="share-row">
      <span className="share-avatar" aria-hidden="true">
        {share.subjectType === 'topic' ? '▦' : (share.label[0] ?? '?').toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate">
          {share.subjectType === 'topic' ? `Topic: ${share.label}` : share.label}
        </span>
        <span className="note block truncate">{sub}</span>
      </span>
      <Select
        aria-label={`${share.label}’s access`}
        className="share-row-preset"
        value={share.preset}
        disabled={busy}
        options={options}
        onValueChange={(value) =>
          void (async () => {
            setBusy(true);
            try {
              if (value === REMOVE) {
                await api.agentRepo.unshare(agent.id, share.subjectType, share.subjectId);
                notify(`${share.label} no longer has ${agent.name}`);
              } else if (isPreset(value)) {
                await api.agentRepo.updateShare(agent.id, share.subjectType, share.subjectId, {
                  preset: value,
                });
                notify(`${share.label}: ${SHARE_PRESETS[value].label}`);
              }
              await invalidate();
            } catch (error) {
              notify(error instanceof ApiError ? error.message : 'Could not change that', 'error');
            } finally {
              setBusy(false);
            }
          })()
        }
      />
    </li>
  );
}

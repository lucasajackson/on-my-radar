/**
 * A new agent, on a page of its own — a prompt is too big a thing to write in
 * a dialog. The name in the reading serif, a one-line "what it's for", and the
 * prompt in the same WYSIWYG editor the Prompt tab uses; beside it the handle
 * (checked as you type), the primary tool and its model — which become the
 * agent's first profile — and its accent.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import {
  AGENT_REPO,
  HARNESSES,
  repoSlugFrom,
  resolveHarness,
  type Harness,
  type RadarAccent,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys } from '../lib/session';
import { slugDraft } from '../lib/slug';
import { useDocumentTitle } from '../lib/title';
import { AccentSwatch, notify } from '../components/primitives';
import { Select } from '../components/select';
import { MarkdownEditor, type MarkdownEditorApi } from '../components/markdown-editor';
import { AGENT_ACCENTS, toolOptions } from '../components/repo-common';
import { ModelControl } from '../components/repo-tools';

export function NewAgentRoute() {
  useDocumentTitle('New agent');
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [handle, setHandle] = useState('');
  const [handleEdited, setHandleEdited] = useState(false);
  const [harness, setHarness] = useState<Harness>('claude-code');
  const [model, setModel] = useState('');
  const [accent, setAccent] = useState<RadarAccent>('cobalt');
  const [promptDirty, setPromptDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const editor = useRef<MarkdownEditorApi | null>(null);

  const slug = repoSlugFrom(handleEdited ? handle : name);
  const [debounced, setDebounced] = useState(slug);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(slug), 300);
    return () => clearTimeout(timer);
  }, [slug]);
  const availability = useQuery({
    queryKey: ['repo-handle', debounced],
    queryFn: () => api.agentRepo.handleAvailable(debounced),
    enabled: Boolean(debounced),
    staleTime: 10_000,
  });
  const checked = availability.data && debounced === slug ? availability.data : null;
  const hasModel = HARNESSES[harness].fields.some((field) => field.control === 'model');

  const create = () =>
    void (async () => {
      setBusy(true);
      try {
        const prompt = promptDirty ? (editor.current?.markdown() ?? '') : '';
        const { agent } = await api.agentRepo.create({
          name: name.trim(),
          ...(slug ? { slug } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(prompt.trim() ? { prompt } : {}),
          primaryHarness: harness,
          ...(hasModel && model ? { profile: { model } } : {}),
          accent,
        });
        await client.invalidateQueries({ queryKey: queryKeys.repoAgents });
        notify(`${agent.name} created`);
        void navigate({ to: '/repo/$agentId', params: { agentId: agent.id } });
      } catch (error) {
        notify(error instanceof ApiError ? error.message : 'Could not create the agent', 'error');
        setBusy(false);
      }
    })();

  return (
    <div className="repo-page new-agent" style={accentStyle(accent)}>
      <Link to="/repo" className="btn btn-ghost agent-back hidden lg:inline-flex">
        <ArrowLeft className="h-4 w-4" />
        Agents
      </Link>
      <header className="repo-head">
        <h1 className="repo-title">New agent</h1>
        <Link to="/repo" className="btn">
          Cancel
        </Link>
        <button
          className="btn btn-accent"
          disabled={busy || !name.trim() || !slug || checked?.available === false}
          onClick={create}
        >
          Create agent
        </button>
      </header>
      <div className="new-agent-grid">
        <div className="min-w-0">
          <input
            className="new-agent-name"
            aria-label="Agent name"
            placeholder="Name your agent"
            value={name}
            autoFocus
            maxLength={AGENT_REPO.nameLength}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="new-agent-for"
            aria-label="What it’s for"
            placeholder="What it’s for — one line tools read to decide when to use it"
            value={description}
            maxLength={AGENT_REPO.descriptionLength}
            onChange={(event) => setDescription(event.target.value)}
          />
          <h2 className="instrument mt-6 mb-2">Prompt</h2>
          <MarkdownEditor
            value=""
            label="Prompt editor"
            meta="Saves as Markdown"
            apiRef={editor}
            onDirtyChange={setPromptDirty}
          />
        </div>
        <aside className="new-agent-aside">
          <div className="panel new-agent-card">
            <label className="instrument" htmlFor="new-agent-handle">
              Handle
            </label>
            <div className="handle-field">
              <span aria-hidden="true">@</span>
              <input
                id="new-agent-handle"
                className="field font-mono text-[13.5px]"
                value={handleEdited ? handle : slug}
                placeholder="release-captain"
                spellCheck={false}
                maxLength={AGENT_REPO.slugLength}
                onChange={(event) => {
                  setHandleEdited(true);
                  setHandle(slugDraft(event.target.value));
                }}
              />
            </div>
            <span
              className={`form-hint ${checked?.available === false ? 'is-danger' : ''}`}
              aria-live="polite"
            >
              {!slug
                ? 'How people @mention it.'
                : checked === null
                  ? 'Checking…'
                  : checked.available
                    ? 'Available · how people @mention it'
                    : `Taken${checked.suggestion ? ` — @${checked.suggestion} is free` : ''}`}
            </span>
          </div>
          <div className="panel new-agent-card">
            <span className="instrument" id="new-agent-tool">
              Primary tool
            </span>
            <Select
              aria-labelledby="new-agent-tool"
              value={harness}
              options={toolOptions()}
              onValueChange={(value) => {
                const next = resolveHarness(value);
                if (next) {
                  setHarness(next);
                  setModel('');
                }
              }}
            />
            {hasModel ? (
              <>
                <span className="instrument mt-1" id="new-agent-model">
                  Model
                </span>
                <ModelControl
                  key={harness}
                  harness={harness}
                  labelId="new-agent-model"
                  value={model}
                  disabled={false}
                  onChange={setModel}
                />
              </>
            ) : null}
            <span className="form-hint">
              This becomes its first tool profile. Add profiles for other tools any time.
            </span>
          </div>
          <div className="panel new-agent-card">
            <span className="instrument" id="new-agent-accent">
              Accent
            </span>
            <div
              className="flex flex-wrap gap-1"
              role="radiogroup"
              aria-labelledby="new-agent-accent"
            >
              {AGENT_ACCENTS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={accent === key}
                  aria-label={key}
                  className="swatch-button"
                  onClick={() => setAccent(key)}
                >
                  <AccentSwatch accent={key} active={accent === key} />
                </button>
              ))}
            </div>
          </div>
          <p className="note">
            It starts with no memories. Use it in a tool and it saves what it learns here.
          </p>
        </aside>
      </div>
    </div>
  );
}

/**
 * The Tools tab: one agent, a profile per tool (docs/AGENT_REPO.md §V2.7).
 *
 * A grid of cards — one per profile, plus Default — each leading with the
 * **model**, because that is the first thing anybody wants to know about how a
 * tool runs the agent. Choosing a card opens that profile's editor below.
 *
 * The editor renders **only** from `HARNESSES[tool].fields`: adding a tool or a
 * setting is a registry change, never a change here. Model is always the first
 * field; its list is the admin-kept catalog plus Custom…, because every tool
 * accepts ids a list does not know yet.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  AGENT_REPO,
  DEFAULT_PROFILE_NOTE,
  fieldWidens,
  HARNESSES,
  PROFILE_KEYS,
  profileSummary,
  validateProfileSettings,
  type Harness,
  type ProfileDto,
  type ProfileField,
  type ProfileKey,
  type ProfileSettings,
  type RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { ConfirmDialog, Spinner, notify } from './primitives';
import { QueryError } from './query-error';
import { Select, type SelectGroup } from './select';
import { Switch, toolOptions, useInvalidateAgent } from './repo-common';
import { useAgentPage } from './repo-context';

const isProfileKey = (value: unknown): value is ProfileKey =>
  (PROFILE_KEYS as readonly unknown[]).includes(value);

export const profileName = (key: ProfileKey): string =>
  key === 'default' ? 'Default' : HARNESSES[key].short;

/** Claude Code's eight colour names, drawn. */
const COLOUR_SWATCH: Record<string, string> = {
  blue: '#60a5fa',
  cyan: '#22d3ee',
  green: '#4ade80',
  yellow: '#facc15',
  orange: '#fb923c',
  red: '#f87171',
  pink: '#f472b6',
  purple: '#c084fc',
};

const WIDENS_NOTE =
  'Lets the tool act without asking, so only you can approve it, here in the browser. Only applied on your machines — people you share with get the tool’s default';

export function ToolsTab() {
  const { agent, canEditPrompt } = useAgentPage();
  const search = useSearch({ from: '/_app/repo/$agentId' });
  const navigate = useNavigate();
  const profiles = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'profiles'),
    queryFn: () => api.agentRepo.profiles(agent.id),
  });
  const [adding, setAdding] = useState(false);
  const editorRef = useRef<HTMLElement>(null);

  const list = profiles.data?.profiles ?? [];
  const byKey = new Map(list.map((profile) => [profile.harness, profile]));
  // The agent's primary tool first, then the rest as the registry orders them.
  const keys = (Object.keys(HARNESSES) as Harness[])
    .filter((key) => byKey.has(key))
    .sort((a, b) => Number(b === agent.primaryHarness) - Number(a === agent.primaryHarness));
  const cards: ProfileKey[] = [...keys, 'default'];
  const requested = isProfileKey(search.profile) ? search.profile : null;
  const selected: ProfileKey = requested ?? agent.primaryHarness ?? keys[0] ?? 'default';
  const missing = (Object.keys(HARNESSES) as Harness[]).filter((key) => !byKey.has(key));

  const choose = (key: ProfileKey) => {
    setAdding(false);
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, profile: key }),
      replace: true,
    }).then(() => editorRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  if (profiles.isLoading) return <Spinner label="Reading its tool profiles" />;
  if (profiles.error)
    return (
      <QueryError
        error={profiles.error}
        resource="Tool profiles"
        retry={() => profiles.refetch()}
      />
    );

  return (
    <div className="tools-tab">
      <p className="note max-w-[75ch]">
        One agent, a profile per tool. When a tool loads the agent it gets only its own profile —
        its model, its settings, and any instructions added just for it. Tools without a profile use
        Default.
      </p>
      <div className="tool-grid">
        {cards.map((key) => (
          <ProfileCard
            key={key}
            agent={agent}
            profileKey={key}
            profile={byKey.get(key) ?? null}
            selected={key === selected}
            onSelect={() => choose(key)}
          />
        ))}
        {canEditPrompt && missing.length > 0 ? (
          adding ? (
            <div className="tool-card is-add is-choosing">
              <Select
                aria-label="Add a profile for"
                value=""
                placeholder="Add a profile for…"
                options={toolOptions(missing)}
                onValueChange={(value) => {
                  if (isProfileKey(value)) choose(value);
                }}
              />
              <button className="btn btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="tool-card is-add" onClick={() => setAdding(true)}>
              + Add a profile for another tool
            </button>
          )
        ) : null}
      </div>

      <section ref={editorRef} className="profile-editor" aria-labelledby="profile-editor-title">
        <h2 id="profile-editor-title" className="instrument">
          {canEditPrompt ? 'Edit profile' : 'Profile'}
        </h2>
        <ProfileEditor
          key={`${selected}:${byKey.get(selected)?.revision ?? 0}`}
          agent={agent}
          profileKey={selected}
          profile={byKey.get(selected) ?? null}
          canEdit={canEditPrompt}
          onRemoved={() => choose(agent.primaryHarness ?? 'default')}
        />
      </section>
    </div>
  );
}

function ProfileCard({
  agent,
  profileKey,
  profile,
  selected,
  onSelect,
}: {
  agent: RepoAgentDto;
  profileKey: ProfileKey;
  profile: ProfileDto | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const summary = profileSummary(profileKey, profile?.settings ?? {});
  const hasFields = profileKey !== 'default' && HARNESSES[profileKey].fields.length > 0;
  const hasModelField =
    profileKey !== 'default' && HARNESSES[profileKey].fields.some((f) => f.control === 'model');
  const chips =
    profileKey === 'default'
      ? profile?.addendum.trim()
        ? ['Instructions only', 'Added instructions']
        : ['Instructions only']
      : [...summary.chips, ...(profile?.addendum.trim() ? ['Added instructions'] : [])];
  return (
    <button
      type="button"
      className={`tool-card ${selected ? 'is-on' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="tool-card-head">
        <strong>{profileName(profileKey)}</strong>
        {profileKey === agent.primaryHarness ? <span className="token">Primary</span> : null}
        <span className="tool-card-reads">
          {profileKey === 'default' ? 'any other tool' : HARNESSES[profileKey].reads}
        </span>
      </span>
      {hasModelField ? (
        <span className="tool-card-model">
          <span className="tool-card-label">Model</span>
          <span className="tool-card-model-name">{summary.model ?? 'Tool’s default'}</span>
        </span>
      ) : (
        <span className="tool-card-model">
          <span className="tool-card-label">Model</span>
          <span className="tool-card-model-name is-none">
            {profileKey === 'default' ? '—' : hasFields ? 'Set in the tool' : 'Set in the app'}
          </span>
        </span>
      )}
      {chips.length > 0 ? (
        <span className="tool-card-chips">
          {chips.map((chip) => (
            <span key={chip} className="chip">
              {chip}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

function modelGroups(
  models: ReadonlyArray<{
    modelId: string;
    displayName: string;
    family: string;
    hidden: boolean;
    deprecated: boolean;
  }>,
  current: string,
): SelectGroup[] {
  const families = new Map<string, SelectGroup['options'][number][]>();
  for (const model of models) {
    if (model.hidden && model.modelId !== current) continue;
    const family = model.family || 'Models';
    const list = families.get(family) ?? [];
    list.push({
      value: model.modelId,
      label: model.displayName,
      ...(model.deprecated ? { description: 'Deprecated' } : {}),
    });
    families.set(family, list);
  }
  return [
    { label: 'Default', options: [{ value: '', label: 'Tool’s default' }] },
    ...[...families].map(([label, options]) => ({ label, options })),
    {
      label: 'Other',
      options: [{ value: CUSTOM, label: 'Custom…', description: 'Any id the tool accepts' }],
    },
  ];
}

/** Not a model id: MODEL_ID_PATTERN requires a letter or digit first. */
const CUSTOM = '__custom__';

export function ModelControl({
  harness,
  value,
  onChange,
  disabled,
  labelId,
}: {
  harness: Harness;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  labelId: string;
}) {
  const models = useQuery({
    queryKey: queryKeys.models(harness),
    queryFn: () => api.models.list(harness),
    staleTime: 5 * 60_000,
  });
  const list = models.data?.models ?? [];
  const known = value === '' || list.some((model) => model.modelId === value);
  const [custom, setCustom] = useState(false);
  const showCustom = custom || (!known && models.isSuccess);
  return (
    <div className="flex flex-col gap-2">
      <Select
        aria-labelledby={labelId}
        value={showCustom ? CUSTOM : value}
        disabled={disabled}
        groups={modelGroups(list, value)}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next);
        }}
      />
      {showCustom ? (
        <input
          className="field font-mono text-[13px]"
          aria-label="Custom model id"
          placeholder="A model id the tool accepts"
          value={value}
          disabled={disabled}
          maxLength={120}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}

function FieldControl({
  harness,
  field,
  value,
  onChange,
  disabled,
}: {
  harness: Harness;
  field: ProfileField;
  value: string | boolean | undefined;
  onChange: (next: string | boolean | undefined) => void;
  disabled: boolean;
}) {
  const labelId = `profile-field-${field.key}`;
  const widening = fieldWidens(field, value);
  const yourConfig = field.where.includes('your-config');
  let control;
  switch (field.control) {
    case 'model':
      control = (
        <ModelControl
          harness={harness}
          labelId={labelId}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(next) => onChange(next || undefined)}
        />
      );
      break;
    case 'select':
      control = (
        <Select
          aria-labelledby={labelId}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          options={[
            { value: '', label: 'Tool’s default' },
            ...(field.options ?? []).map((option) =>
              fieldWidens(field, option.value)
                ? { ...option, label: `${option.label} — needs your approval` }
                : option,
            ),
          ]}
          onValueChange={(next) => onChange(next || undefined)}
        />
      );
      break;
    case 'toggle':
      control = (
        <Switch
          label={field.label}
          checked={value === true}
          disabled={disabled}
          onChange={(next) => onChange(next || undefined)}
        />
      );
      break;
    case 'text':
      control = (
        <input
          className="field"
          aria-labelledby={labelId}
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          maxLength={400}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      );
      break;
    case 'color':
      control = (
        <div className="swatches" role="radiogroup" aria-labelledby={labelId}>
          <button
            type="button"
            role="radio"
            aria-checked={value === undefined}
            aria-label="Tool’s default"
            className={`swatch is-none ${value === undefined ? 'is-on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(undefined)}
          />
          {(field.options ?? []).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value === option.value}
              aria-label={option.label}
              title={option.label}
              className={`swatch ${value === option.value ? 'is-on' : ''}`}
              style={{ background: COLOUR_SWATCH[option.value] ?? 'var(--paper-faint)' }}
              disabled={disabled}
              onClick={() => onChange(option.value)}
            />
          ))}
        </div>
      );
      break;
  }
  return (
    <div className="form-row">
      <span className="form-label" id={labelId}>
        {field.label}
        {yourConfig ? (
          <span
            className="token is-quiet"
            title="Applied by the snippet in Use in…, not by project files"
          >
            your config
          </span>
        ) : null}
      </span>
      <div className="form-control">
        {control}
        {widening ? <span className="token is-caution">{WIDENS_NOTE}</span> : null}
        <span className="form-hint">
          {field.hint}
          {yourConfig ? ' Applied by the snippet in Use in…, not by project files.' : ''}
        </span>
      </div>
    </div>
  );
}

function ProfileEditor({
  agent,
  profileKey,
  profile,
  canEdit,
  onRemoved,
}: {
  agent: RepoAgentDto;
  profileKey: ProfileKey;
  profile: ProfileDto | null;
  canEdit: boolean;
  onRemoved: () => void;
}) {
  const invalidate = useInvalidateAgent(agent.id);
  const [settings, setSettings] = useState<ProfileSettings>(profile?.settings ?? {});
  const [addendum, setAddendum] = useState(profile?.addendum ?? '');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [validationError, setValidationError] = useState<{ message: string } | null>(null);
  const validationId = useId();
  const validationRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (validationError) validationRef.current?.focus();
  }, [validationError]);
  const def = profileKey === 'default' ? null : HARNESSES[profileKey];
  // Model first, always; the registry's order after it.
  const fields = useMemo(
    () =>
      def
        ? [...def.fields].sort(
            (a, b) => Number(b.control === 'model') - Number(a.control === 'model'),
          )
        : [],
    [def],
  );
  const isNew = profile === null && profileKey !== 'default';
  const changed =
    JSON.stringify(settings) !== JSON.stringify(profile?.settings ?? {}) ||
    addendum !== (profile?.addendum ?? '');
  const note = def ? def.noFieldsNote : DEFAULT_PROFILE_NOTE;
  const addendumLabel =
    profileKey === 'default' ? 'Added instructions' : `Added instructions for ${def?.short ?? ''}`;

  const save = () =>
    void (async () => {
      const checked = validateProfileSettings(profileKey, settings);
      if (!checked.ok) {
        setValidationError({ message: checked.message });
        return;
      }
      setValidationError(null);
      setBusy(true);
      try {
        await api.agentRepo.setProfile(agent.id, profileKey, {
          settings: checked.value,
          addendum,
          ...(profile ? { expectedRevision: profile.revision } : {}),
        });
        await invalidate();
        notify(isNew ? `Added a ${profileName(profileKey)} profile` : 'Profile saved');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          notify('Someone changed this profile just now — it has been reloaded', 'error');
          await invalidate();
        } else {
          notify(error instanceof ApiError ? error.message : 'Could not save the profile', 'error');
        }
      } finally {
        setBusy(false);
      }
    })();

  return (
    <div
      className="panel profile-card"
      role="group"
      aria-label={`${profileName(profileKey)} profile settings`}
      aria-describedby={validationError ? validationId : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold">
          {profileKey === 'default' ? 'Default (any other tool)' : def?.label}
        </span>
        {profileKey === agent.primaryHarness ? <span className="token">● Primary tool</span> : null}
        {isNew ? <span className="token is-accent">New profile</span> : null}
        {canEdit && def && profile && profileKey !== agent.primaryHarness ? (
          <button
            className="btn btn-ghost ml-auto"
            disabled={busy}
            onClick={() =>
              void (async () => {
                try {
                  await api.agentRepo.update(agent.id, {
                    primaryHarness: profileKey,
                    expectedRevision: agent.revision,
                  });
                  await invalidate();
                  notify(`${def.short} is its primary tool`);
                } catch (error) {
                  notify(
                    error instanceof ApiError ? error.message : 'Could not change that',
                    'error',
                  );
                }
              })()
            }
          >
            Make primary
          </button>
        ) : null}
      </div>
      {note && fields.length === 0 ? <p className="note">{note}</p> : null}
      {def ? (
        <p className="note">
          {def.short} {def.reads}.
        </p>
      ) : null}
      {def
        ? fields.map((field) => (
            <FieldControl
              key={field.key}
              harness={def.id}
              field={field}
              value={settings[field.key]}
              disabled={!canEdit}
              onChange={(next) => {
                setValidationError(null);
                setSettings((current) => {
                  const { [field.key]: _cleared, ...rest } = current;
                  return next === undefined ? rest : { ...rest, [field.key]: next };
                });
              }}
            />
          ))
        : null}
      <div className="form-row is-top">
        <label className="form-label" htmlFor="profile-addendum">
          {addendumLabel}
        </label>
        <div className="form-control">
          <textarea
            id="profile-addendum"
            className="field min-h-[96px]"
            placeholder={
              profileKey === 'default'
                ? 'Optional. Appended to the prompt in any tool without its own profile.'
                : 'Optional. Appended to the prompt only in this tool.'
            }
            maxLength={AGENT_REPO.profileAddendumLength}
            value={addendum}
            disabled={!canEdit}
            onChange={(event) => setAddendum(event.target.value)}
          />
          <span className="form-hint">
            Markdown. Shown on the Prompt tab under “What each tool also receives”.
          </span>
        </div>
      </div>
      {validationError ? (
        <p
          id={validationId}
          ref={validationRef}
          role="alert"
          tabIndex={-1}
          className="note text-[color:var(--danger)]"
        >
          {validationError.message}
        </p>
      ) : null}
      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {profile && profileKey !== 'default' ? (
            <button
              className="btn btn-danger-quiet"
              disabled={busy}
              onClick={() => setRemoving(true)}
            >
              Remove profile
            </button>
          ) : null}
          <button className="btn btn-accent" disabled={busy || (!changed && !isNew)} onClick={save}>
            {isNew ? 'Add profile' : 'Save'}
          </button>
        </div>
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove the ${profileName(profileKey)} profile?`}
          body={`${profileName(profileKey)} will run this agent with the Default profile from its next checkout.`}
          confirmLabel="Remove profile"
          danger
          busy={busy}
          onClose={() => setRemoving(false)}
          onConfirm={() =>
            void (async () => {
              setBusy(true);
              try {
                await api.agentRepo.removeProfile(agent.id, profileKey);
                await invalidate();
                notify('Profile removed');
                setRemoving(false);
                onRemoved();
              } catch (error) {
                notify(error instanceof ApiError ? error.message : 'Could not remove it', 'error');
                setBusy(false);
              }
            })()
          }
        />
      ) : null}
    </div>
  );
}

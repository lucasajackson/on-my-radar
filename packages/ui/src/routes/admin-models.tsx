/**
 * Admin → Model catalog: the models each tool offers in agent profiles.
 *
 * Stored in the database rather than in `harnesses.ts` so a model released on
 * a Tuesday is in everybody's picker on Tuesday, without a deploy. The seed in
 * `MODEL_CATALOG_SEED` is only the starting point; this screen is the source of
 * truth from then on.
 *
 * Hide, not delete, is the everyday act: a hidden model leaves the picker but
 * every profile that already names it keeps working, because a profile stores
 * the model id, never a catalog row.
 */
import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  HARNESSES,
  HARNESS_IDS,
  type Harness,
  type ModelCatalogEntryDto,
  type UpdateModelCatalogEntryRequest,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { ConfirmDialog, Spinner, notify } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { Select } from '../components/select';
import { useDocumentTitle } from '../lib/title';
import { prefersReducedMotion } from '../lib/motion';

/**
 * Tools whose profiles have a model to pick. Claude (the connector), Windsurf
 * and "Other" have none — the model is chosen in the app, or there is no
 * profile file at all — so a catalog row for them would be offered nowhere.
 */
const hasModelField = (id: Harness) =>
  HARNESSES[id].fields.some((field) => field.control === 'model');
const MODEL_TOOLS = HARNESS_IDS.filter(hasModelField);
const TOOL_OPTIONS = MODEL_TOOLS.map((id) => ({ value: id, label: HARNESSES[id].label }));
const DEFAULT_SORT = 100;

const isHarness = (value: string): value is Harness =>
  (HARNESS_IDS as readonly string[]).includes(value);

/** Catalog order within a tool: the admin's sort order, then by name. */
function byOrder(a: ModelCatalogEntryDto, b: ModelCatalogEntryDto): number {
  return a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName);
}

/** A sort order as typed, or null when it is not one the server will take. */
function parseSort(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 0 && n <= 10_000 ? n : null;
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

export function AdminModelsRoute() {
  useDocumentTitle('Model catalog · Admin');
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.adminModels, queryFn: () => api.admin.models() });
  const [addFor, setAddFor] = useState<Harness>('claude-code');
  /*
    Closed until asked for. Open by default, the form filled a phone's whole
    first screen and pushed the catalog — what you come here to read and
    toggle — below the fold.
  */
  const [adding, setAdding] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  /*
    Both the admin's list and every picker's list. The pickers read the public
    `/api/models`, cached under their own key; a change here must reach them
    without a reload, or "no deploy needed" is only half true.
  */
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.adminModels }),
      client.invalidateQueries({ queryKey: queryKeys.adminOverview }),
      client.invalidateQueries({ queryKey: ['models'] }),
    ]);
  };

  const startAdding = (harness: Harness) => {
    setAddFor(harness);
    setAdding(true);
  };
  // After the form has painted: focusing a form that is not there yet did nothing.
  useEffect(() => {
    if (!adding) return;
    formRef.current?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    formRef.current?.querySelector<HTMLInputElement>('input[name="modelId"]')?.focus();
  }, [adding, addFor]);

  const models = query.data?.models ?? [];
  const grouped = new Map<Harness, ModelCatalogEntryDto[]>(HARNESS_IDS.map((id) => [id, []]));
  for (const model of models) grouped.get(model.harness)?.push(model);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-[17px] font-semibold tracking-tight">Model catalog</h2>
          <p className="mt-1 text-[13.5px] text-[color:var(--paper-dim)]">
            Profiles offer these, plus Custom… for any id a tool accepts. Hiding removes a model
            from the picker without touching profiles that already use it.
          </p>
        </div>
        {adding ? null : (
          <button className="btn btn-accent min-h-11" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add a model
          </button>
        )}
      </header>

      {adding ? (
        <AddModelForm
          formRef={formRef}
          harness={addFor}
          onHarnessChange={setAddFor}
          onAdded={refresh}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {query.isLoading ? (
        <Spinner label="Loading the catalog" />
      ) : query.error ? (
        <QueryError error={query.error} resource="Model catalog" retry={() => query.refetch()} />
      ) : (
        <>
          {/* A tool with no model setting still shows any rows it has, so a row
              added before that was known can be found and deleted. */}
          {HARNESS_IDS.filter((id) => hasModelField(id) || (grouped.get(id)?.length ?? 0) > 0).map(
            (id) => (
              <ToolGroup
                key={id}
                harness={id}
                models={(grouped.get(id) ?? []).sort(byOrder)}
                onChanged={refresh}
                onAdd={() => startAdding(id)}
              />
            ),
          )}
          <p className="instrument">
            No model setting in profiles:{' '}
            {HARNESS_IDS.filter((id) => !hasModelField(id))
              .map((id) => HARNESSES[id].label)
              .join(' · ')}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------------------------- adding --------------------------------- */

function AddModelForm({
  formRef,
  harness,
  onHarnessChange,
  onAdded,
  onClose,
}: {
  formRef: RefObject<HTMLFormElement | null>;
  harness: Harness;
  onHarnessChange: (harness: Harness) => void;
  onAdded: () => Promise<void>;
  onClose: () => void;
}) {
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [family, setFamily] = useState('');
  const [sortOrder, setSortOrder] = useState(String(DEFAULT_SORT));
  const [busy, setBusy] = useState(false);
  const sort = parseSort(sortOrder);
  const ready = modelId.trim() !== '' && displayName.trim() !== '' && sort !== null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const { model } = await api.admin.createModel({
        harness,
        modelId: modelId.trim(),
        displayName: displayName.trim(),
        family: family.trim(),
        sortOrder: sort,
      });
      await onAdded();
      notify(`${model.displayName} added to ${HARNESSES[model.harness].label}`);
      setModelId('');
      setDisplayName('');
      setFamily('');
      setSortOrder(String(DEFAULT_SORT));
    } catch (err) {
      notify(errorText(err, 'Could not add that model'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={formRef}
      className="panel flex scroll-mt-4 flex-col gap-3.5 p-4"
      aria-label="Add a model"
      onSubmit={(event) => void submit(event)}
    >
      <span className="instrument">Add a model</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Tool</span>
          <Select
            className="field"
            aria-label="Tool"
            value={harness}
            onValueChange={(value) => {
              if (isHarness(value)) onHarnessChange(value);
            }}
            options={TOOL_OPTIONS}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Model id</span>
          <input
            className="field font-mono text-[13px]"
            name="modelId"
            value={modelId}
            placeholder="the id the tool accepts"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={120}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Display name</span>
          <input
            className="field"
            value={displayName}
            placeholder="Claude Opus 4.5"
            maxLength={120}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="instrument">Family</span>
            <input
              className="field"
              value={family}
              placeholder="Opus"
              maxLength={60}
              onChange={(event) => setFamily(event.target.value)}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="instrument">Sort order</span>
            <input
              className="field tabular-nums"
              inputMode="numeric"
              value={sortOrder}
              aria-invalid={sort === null}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-[color:var(--paper-faint)]">
          Lower sort orders are offered first. {HARNESSES[harness].label} {HARNESSES[harness].reads}
          .
        </span>
        <div className="flex gap-2">
          <button type="button" className="btn min-h-11" onClick={onClose}>
            Done
          </button>
          <button type="submit" className="btn btn-accent min-h-11" disabled={!ready || busy}>
            <Plus className="h-4 w-4" />
            Add model
          </button>
        </div>
      </div>
    </form>
  );
}

/* ---------------------------------- a tool --------------------------------- */

function ToolGroup({
  harness,
  models,
  onChanged,
  onAdd,
}: {
  harness: Harness;
  models: ModelCatalogEntryDto[];
  onChanged: () => Promise<void>;
  onAdd: () => void;
}) {
  const def = HARNESSES[harness];
  const [deleting, setDeleting] = useState<ModelCatalogEntryDto | null>(null);

  return (
    <section className="flex flex-col gap-2.5" aria-label={def.label}>
      <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[14.5px] font-semibold tracking-tight">{def.label}</span>
        <span className="instrument">{def.reads}</span>
        <span className="instrument ml-auto tabular-nums">
          {models.length === 1 ? '1 model' : `${models.length} models`}
        </span>
      </h3>
      {models.length === 0 ? (
        <div className="panel flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="text-[13px] text-[color:var(--paper-faint)]">
            No models listed. Profiles for {def.short} offer only Custom… until one is added.
          </span>
          <button className="btn min-h-11" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            Add one
          </button>
        </div>
      ) : (
        <ul className="panel divide-y divide-[color:var(--line-soft)]">
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              onChanged={onChanged}
              onDelete={() => setDeleting(model)}
            />
          ))}
        </ul>
      )}

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.displayName}?`}
          confirmLabel="Delete model"
          danger
          body={
            <>
              It leaves the {def.label} picker and this catalog. Profiles that already use{' '}
              <code className="font-mono text-[color:var(--paper)]">{deleting.modelId}</code> keep
              it. To stop offering it but keep the row, hide it instead.
            </>
          }
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            void (async () => {
              const model = deleting;
              setDeleting(null);
              try {
                await api.admin.removeModel(model.id);
                await onChanged();
                notify(`${model.displayName} deleted`);
              } catch (err) {
                notify(errorText(err, 'Could not delete it'), 'error');
              }
            })()
          }
        />
      ) : null}
    </section>
  );
}

/* ---------------------------------- a model -------------------------------- */

function ModelRow({
  model,
  onChanged,
  onDelete,
}: {
  model: ModelCatalogEntryDto;
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // One write at a time per row, so a double tap cannot flip a toggle twice.
  const [busy, setBusy] = useState(false);

  const save = async (input: UpdateModelCatalogEntryRequest, done?: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      await api.admin.updateModel(model.id, input);
      await onChanged();
      if (done) notify(done);
      return true;
    } catch (err) {
      notify(errorText(err, 'Could not save that'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="px-4 py-3">
        <EditModel
          model={model}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(input) =>
            void (async () => {
              if (await save(input, `${input.displayName ?? model.displayName} saved`))
                setEditing(false);
            })()
          }
        />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`text-[14px] ${model.hidden ? 'text-[color:var(--paper-faint)]' : ''}`}>
            {model.displayName}
          </span>
          {model.deprecated ? <span className="instrument">deprecated</span> : null}
          {model.hidden ? <span className="instrument">hidden</span> : null}
        </div>
        <div className="instrument break-all">
          <span className="font-mono">{model.modelId}</span>
          {model.family ? ` · ${model.family}` : ''} · sort {model.sortOrder}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Toggle
          label="Hidden"
          on={model.hidden}
          disabled={busy}
          onToggle={() =>
            void save(
              { hidden: !model.hidden },
              model.hidden
                ? `${model.displayName} is offered again`
                : `${model.displayName} hidden from the picker`,
            )
          }
        />
        <Toggle
          label="Deprecated"
          on={model.deprecated}
          disabled={busy}
          onToggle={() => void save({ deprecated: !model.deprecated })}
        />
        <button
          className="btn btn-ghost min-h-11 min-w-11"
          aria-label={`Edit ${model.displayName}`}
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          className="btn btn-ghost min-h-11 min-w-11"
          aria-label={`Delete ${model.displayName}`}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

/**
 * A two-state control that says its state in words and in its fill, never by a
 * colour alone — and never only on hover.
 */
function Toggle({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="btn min-h-11 text-[12.5px]"
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      style={
        on
          ? {
              borderColor: 'var(--accent-from)',
              color: 'var(--accent-from)',
              background: 'color-mix(in srgb, var(--accent-from) 12%, transparent)',
            }
          : undefined
      }
    >
      {on ? <Check className="h-3.5 w-3.5" /> : null}
      {label}
    </button>
  );
}

function EditModel({
  model,
  busy,
  onCancel,
  onSave,
}: {
  model: ModelCatalogEntryDto;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: UpdateModelCatalogEntryRequest) => void;
}) {
  const [modelId, setModelId] = useState(model.modelId);
  const [displayName, setDisplayName] = useState(model.displayName);
  const [family, setFamily] = useState(model.family);
  const [sortOrder, setSortOrder] = useState(String(model.sortOrder));
  const sort = parseSort(sortOrder);

  // Only what changed, so a save cannot overwrite a toggle flipped in another tab.
  const changes: UpdateModelCatalogEntryRequest = {};
  if (modelId.trim() !== model.modelId) changes.modelId = modelId.trim();
  if (displayName.trim() !== model.displayName) changes.displayName = displayName.trim();
  if (family.trim() !== model.family) changes.family = family.trim();
  if (sort !== null && sort !== model.sortOrder) changes.sortOrder = sort;
  const valid = modelId.trim() !== '' && displayName.trim() !== '' && sort !== null;
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={`Edit ${model.displayName}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && dirty && !busy) onSave(changes);
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Display name</span>
          <input
            className="field"
            value={displayName}
            autoFocus
            maxLength={120}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Model id</span>
          <input
            className="field font-mono text-[13px]"
            value={modelId}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={120}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Family</span>
          <input
            className="field"
            value={family}
            maxLength={60}
            onChange={(event) => setFamily(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="instrument">Sort order</span>
          <input
            className="field tabular-nums"
            inputMode="numeric"
            value={sortOrder}
            aria-invalid={sort === null}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </label>
      </div>
      {modelId.trim() !== model.modelId ? (
        <p className="text-[12.5px] text-[color:var(--paper-dim)]">
          Profiles that already use{' '}
          <code className="font-mono text-[color:var(--paper)]">{model.modelId}</code> keep it; the
          picker offers the new id from now on.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn min-h-11" onClick={onCancel}>
          <X className="h-4 w-4" />
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-accent min-h-11"
          disabled={!valid || !dirty || busy}
        >
          <Check className="h-4 w-4" />
          Save
        </button>
      </div>
    </form>
  );
}

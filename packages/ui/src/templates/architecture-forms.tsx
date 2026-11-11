/**
 * Writing an architecture radar from the page: boundaries and contracts. Each form sits in the
 * column it belongs to (the map's detail rail) rather than over it, so the map stays in view while
 * they are written. The charter itself is edited in place (`architecture-charter.tsx`). The server decides every rule; what is checked here is
 * only what can be said before a request, in the words the server would use.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIMITS,
  type ArchitectureBoundaryDto,
  type ArchitectureContractDto,
  type ArchitectureDto,
} from '@onmyradar/contract';
import { Spinner } from '../components/primitives';
import { Select } from '../components/select';
import { ChipInput } from '../components/chip-input';
import { MarkdownEditor, type MarkdownEditorApi } from '../components/markdown-editor';
import { Switch } from '../components/repo-common';
import { SidePanel } from '../components/side-panel';
import { ApiError, api } from '../lib/api';
import { LinkedSections } from './architecture-links';

/**
 * What a form shows and sends. Until the person changes something it IS what the server has now
 * (so it follows a refetch, text and revision together); from the first change it is their own
 * values, with the revision and the values they started from. A form built from a copy made
 * when it opened, beside a baseline that kept moving, would send the old text over the new.
 */
/**
 * Drafts kept by whoever opens the forms, by key, so a form that is mounted again (the map's detail
 * column becomes a list when the window crosses 820px, a panel becomes a sheet at 1024px) opens on
 * what was typed. The store outlives the form; the opener clears a key when its form is closed or
 * saved.
 */
export interface FormDrafts {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  /** Start over (load the server's version): the form stays open and may be edited again. */
  clear: (key: string) => void;
  /**
   * The form was closed or saved: its draft goes, and a write that arrives after this (a text
   * field reporting what was typed in its last moments, as the form unmounts) is dropped.
   */
  discard: (key: string) => void;
  /** The form is opened again: its draft takes writes. */
  begin: (key: string) => void;
}

export function useFormDrafts(): FormDrafts {
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const closed = useRef(new Set<string>());
  const clear = (key: string) =>
    setDrafts((current) => {
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  return {
    get: (key) => drafts[key],
    set: (key, value) => {
      if (!closed.current.has(key)) setDrafts((current) => ({ ...current, [key]: value }));
    },
    clear,
    discard: (key) => {
      closed.current.add(key);
      clear(key);
    },
    begin: (key) => void closed.current.delete(key),
  };
}

/** The key a boundary's or contract's draft is kept under. */
export const boundaryDraftKey = (id: string | null) => `boundary:${id ?? 'new'}`;
export const contractDraftKey = (id: string | null, ends?: { a: string; b: string }) =>
  `contract:${id ?? `new:${ends?.a ?? ''}:${ends?.b ?? ''}`}`;

type Draft<V> = { values: V; from: V; base: string };

function useDraft<V extends object>(
  source: V,
  revision: string,
  slot?: { drafts: FormDrafts | undefined; key: string },
) {
  const [local, setLocal] = useState<Draft<V> | null>(null);
  const kept = slot?.drafts;
  const key = slot?.key ?? '';
  const draft = kept ? ((kept.get(key) as Draft<V> | undefined) ?? null) : local;
  const setDraft = (next: Draft<V> | null) => {
    if (!kept) setLocal(next);
    else if (next) kept.set(key, next);
    else kept.clear(key);
  };
  // Several edits in one event (a chip added and the box emptied) each build on the last.
  const latest = useRef<Draft<V> | null>(null);
  latest.current = draft;
  const values = draft?.values ?? source;
  return {
    values,
    /** The values the person started from: what "changed" is measured against. */
    from: draft?.from ?? source,
    /** The revision those values are of: what the server is asked to still find. */
    base: draft?.base ?? revision,
    dirty: draft !== null,
    /** Someone wrote it after the person started editing. */
    stale: draft !== null && revision !== '' && draft.base !== revision,
    edit: (patch: Partial<V>) => {
      const was = latest.current;
      const next = {
        values: { ...(was?.values ?? source), ...patch },
        from: was?.from ?? source,
        base: was?.base ?? revision,
      };
      latest.current = next;
      setDraft(next);
    },
    reload: () => setDraft(null),
  };
}

/** Whether the refusal is "someone else wrote it first". */
const isStale = (err: unknown) => err instanceof ApiError && err.code === 'stale';

/** What a tab holds, and the one action that fills it; a reader without write access gets the first only. */
export function EmptyTab({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="arch-empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

/* --------------------------- boundaries and contracts ---------------------- */

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The title is the key an upsert matches on: a new element may not take another's name. */
function nameTaken(data: ArchitectureDto, title: string, own: string | undefined): boolean {
  return [...data.boundaries, ...data.contracts].some(
    (e) => e.id !== own && sameName(e.title, title),
  );
}

/**
 * An element's fields and its own text, from one response, so they are of one revision. It is
 * fetched when the form opens (never from a copy kept from an earlier open) and again whenever the
 * radar is refetched, which the form follows until the person has changed something.
 */
function useElement(radarId: string, id: string | null) {
  return useQuery({
    queryKey: ['architecture', radarId, 'edit', id],
    queryFn: () => api.radars.architecture(radarId, id ?? ''),
    enabled: id !== null,
    gcTime: 0,
  });
}

/** The panel while the element it edits is being read, or could not be: drawn in the same place. */
function Reading({
  title,
  failed,
  onClose,
}: {
  title: string;
  failed: boolean;
  onClose: () => void;
}) {
  return (
    <SidePanel
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      }
    >
      {failed ? (
        <p role="alert" className="note">
          Couldn&apos;t read it. Close this and try again.
        </p>
      ) : (
        <Spinner label="Reading" />
      )}
    </SidePanel>
  );
}

/**
 * The Description or "What it promises" field: Milkdown in a compact box. It opens with the
 * element's text and reports a change only when the words differ from what the form holds, so
 * opening it does not make the form dirty. The form reads the text at Save, not from the debounced
 * report. Remounted (key) when the server's version is loaded over an abandoned edit.
 */
function BodyField({
  label,
  current,
  apiRef,
  onText,
}: {
  label: string;
  /** What the form holds now. */
  current: string;
  apiRef: React.RefObject<MarkdownEditorApi | null>;
  onText: (text: string) => void;
}) {
  const now = useRef(current);
  now.current = current;
  // A panel that is remounted (the window crossed 1024px) opens on what was typed, not on what
  // the element started as.
  const opened = useRef(current);
  return (
    <MarkdownEditor
      value={opened.current}
      variant="compact"
      label={label}
      apiRef={apiRef}
      onDirtyChange={() => undefined}
      onTextChange={(text) => {
        if (text !== now.current) onText(text);
      }}
    />
  );
}

export function BoundaryForm({
  radarId,
  data,
  boundaryId,
  drafts,
  onClose,
  onSaved,
  onRemove,
}: {
  radarId: string;
  data: ArchitectureDto;
  boundaryId: string | null;
  drafts?: FormDrafts | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const snapshot = useElement(radarId, boundaryId);
  if (boundaryId === null)
    return (
      <BoundaryFields
        radarId={radarId}
        data={data}
        boundary={null}
        drafts={drafts}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  const boundary = snapshot.data?.boundaries.find((b) => b.id === boundaryId);
  if (!snapshot.data || !boundary)
    return (
      <Reading title="Boundary" failed={snapshot.isError && !snapshot.data} onClose={onClose} />
    );
  return (
    <BoundaryFields
      radarId={radarId}
      data={snapshot.data}
      boundary={boundary}
      drafts={drafts}
      onClose={onClose}
      onSaved={onSaved}
      onRemove={onRemove}
    />
  );
}

/** The stale-write notice every panel shows: someone else saved first. */
function Stale({ onReload }: { onReload: () => void }) {
  return (
    <p role="alert" className="note">
      This was changed by someone else after you started. Your text is kept below, but it cannot be
      saved over theirs.{' '}
      <button type="button" className="btn btn-ghost" onClick={onReload}>
        Load their version
      </button>
    </p>
  );
}

function BoundaryFields({
  radarId,
  data,
  boundary,
  drafts,
  onClose,
  onSaved,
  onRemove,
}: {
  radarId: string;
  data: ArchitectureDto;
  boundary: ArchitectureBoundaryDto | null;
  drafts?: FormDrafts | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const id = useId();
  const client = useQueryClient();
  const editor = useRef<MarkdownEditorApi | null>(null);
  const draft = useDraft(
    {
      title: boundary?.title ?? '',
      external: boundary?.external ?? false,
      owns: [...(boundary?.owns ?? [])],
      // Typed into the box and not yet a chip.
      ownsText: '',
      body: boundary?.body ?? '',
    },
    boundary?.updatedAt ?? '',
    { drafts, key: boundaryDraftKey(boundary?.id ?? null) },
  );
  const { title, external, owns, ownsText, body } = draft.values;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = title.trim() !== '' && nameTaken(data, title, boundary?.id);
  const ready =
    title.trim() !== '' && !taken && !saving && !draft.stale && (draft.dirty || !boundary);
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    // The editor reports its text a moment after each change; Save reads it now.
    const text = editor.current?.markdown() ?? body;
    try {
      const saved = await api.radars.upsertBoundary(radarId, {
        ...(boundary ? { id: boundary.id, expectedUpdatedAt: draft.base } : {}),
        title: title.trim(),
        external,
        owns: owns.map((item) => item.trim()).filter(Boolean),
        // Only what was changed: an imported boundary's text can be tens of thousands of characters.
        ...(text !== draft.from.body ? { body: text } : {}),
      });
      onSaved(saved.boundary.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that boundary. Try again.');
      if (isStale(err)) void client.invalidateQueries({ queryKey: ['architecture', radarId] });
      setSaving(false);
    }
  };
  return (
    <SidePanel
      title={boundary ? 'Boundary' : 'New boundary'}
      busy={saving}
      onClose={onClose}
      footer={
        <>
          {boundary && onRemove ? (
            <button
              type="button"
              className="btn btn-ghost is-start arch-danger"
              disabled={saving}
              onClick={() => onRemove(boundary.id)}
            >
              Remove boundary
            </button>
          ) : null}
          {boundary ? null : (
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-accent"
            disabled={!ready}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : boundary ? 'Save boundary' : 'Create boundary'}
          </button>
        </>
      }
    >
      {draft.stale ? <Stale onReload={draft.reload} /> : null}
      <div className="panel-field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          className="field"
          value={title}
          maxLength={LIMITS.blipTitle}
          placeholder="Billing"
          disabled={saving}
          onChange={(event) => draft.edit({ title: event.target.value })}
        />
      </div>
      <div className="panel-switch">
        <Switch
          label="Outside our system"
          checked={external}
          disabled={saving}
          onChange={(next) => draft.edit({ external: next })}
        />
        <span>
          Outside our system <small>(a service we use but don&apos;t run, such as Stripe)</small>
        </span>
      </div>
      <div className="panel-field">
        <span className="panel-label">What it owns</span>
        <ChipInput
          label="What it owns"
          values={owns}
          pending={ownsText}
          onPending={(text) => draft.edit({ ownsText: text })}
          disabled={saving}
          onChange={(next) => draft.edit({ owns: next })}
        />
        <p className="panel-hint">
          Paste a list to add several at once. Click a chip to rename it. Drag to reorder.
        </p>
      </div>
      <div className="panel-field">
        <span className="panel-label">Description</span>
        <BodyField
          key={draft.base}
          label="Description"
          current={body}
          apiRef={editor}
          onText={(text) => draft.edit({ body: text })}
        />
      </div>
      {boundary ? <LinkedSections data={data} id={boundary.id} /> : null}
      {taken ? (
        <p role="alert" className="note">
          Another boundary or contract already has that name.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="note">
          {error}
        </p>
      ) : null}
    </SidePanel>
  );
}

export function ContractForm({
  radarId,
  data,
  contractId,
  ends,
  drafts,
  onClose,
  onSaved,
  onRemove,
}: {
  radarId: string;
  data: ArchitectureDto;
  contractId: string | null;
  drafts?: FormDrafts | undefined;
  /** A new contract's two boundaries, when the form is opened from a cell that names them. */
  ends?: { a: string; b: string } | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const snapshot = useElement(radarId, contractId);
  if (contractId === null)
    return (
      <ContractFields
        radarId={radarId}
        data={data}
        contract={null}
        ends={ends}
        drafts={drafts}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  const contract = snapshot.data?.contracts.find((c) => c.id === contractId);
  if (!snapshot.data || !contract)
    return (
      <Reading title="Contract" failed={snapshot.isError && !snapshot.data} onClose={onClose} />
    );
  return (
    <ContractFields
      radarId={radarId}
      data={snapshot.data}
      contract={contract}
      ends={ends}
      drafts={drafts}
      onClose={onClose}
      onSaved={onSaved}
      onRemove={onRemove}
    />
  );
}

function ContractFields({
  radarId,
  data,
  contract,
  ends,
  drafts,
  onClose,
  onSaved,
  onRemove,
}: {
  radarId: string;
  data: ArchitectureDto;
  contract: ArchitectureContractDto | null;
  ends?: { a: string; b: string } | undefined;
  drafts?: FormDrafts | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
  onRemove?: ((id: string) => void) | undefined;
}) {
  const id = useId();
  const client = useQueryClient();
  const editor = useRef<MarkdownEditorApi | null>(null);
  const draft = useDraft(
    {
      title: contract?.title ?? '',
      version: contract?.version ?? '',
      from: contract?.a ?? ends?.a ?? '',
      to: contract?.b ?? ends?.b ?? '',
      body: contract?.body ?? '',
    },
    contract?.updatedAt ?? '',
    { drafts, key: contractDraftKey(contract?.id ?? null, ends) },
  );
  const { title, version, from, to, body } = draft.values;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = data.boundaries.map((b) => ({
    value: b.id,
    label: b.external ? `${b.title} (external)` : b.title,
  }));
  const nameOf = (boundary: string) => data.boundaries.find((b) => b.id === boundary)?.title ?? '';
  const external = (boundary: string) => data.boundaries.find((b) => b.id === boundary)?.external;
  const problem =
    title.trim() !== '' && nameTaken(data, title, contract?.id)
      ? 'Another boundary or contract already has that name.'
      : from !== '' && from === to
        ? 'A contract joins two different boundaries.'
        : from !== '' && to !== '' && external(from) && external(to)
          ? 'A contract needs a boundary inside the application on at least one side.'
          : null;
  const ready =
    title.trim() !== '' &&
    from !== '' &&
    to !== '' &&
    !problem &&
    !saving &&
    !draft.stale &&
    (draft.dirty || !contract);
  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    const text = editor.current?.markdown() ?? body;
    try {
      const saved = await api.radars.upsertContract(radarId, {
        ...(contract ? { id: contract.id, expectedUpdatedAt: draft.base } : {}),
        title: title.trim(),
        ...(version.trim() ? { version: version.trim() } : {}),
        a: from,
        b: to,
        ...(text !== draft.from.body ? { body: text } : {}),
      });
      onSaved(saved.contract.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that contract. Try again.');
      if (isStale(err)) void client.invalidateQueries({ queryKey: ['architecture', radarId] });
      setSaving(false);
    }
  };
  // From the matrix the two ends are the cell's: shown, and swappable, not chosen again.
  const named = ends !== undefined || contract !== null;
  return (
    <SidePanel
      title="Contract"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          {contract && onRemove ? (
            <button
              type="button"
              className="btn btn-ghost is-start arch-danger"
              disabled={saving}
              onClick={() => onRemove(contract.id)}
            >
              Remove contract
            </button>
          ) : null}
          {contract ? null : (
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-accent"
            disabled={!ready}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : contract ? 'Save contract' : 'Create contract'}
          </button>
        </>
      }
    >
      {draft.stale ? <Stale onReload={draft.reload} /> : null}
      {named && from !== '' && to !== '' ? (
        <div className="panel-field">
          <span className="panel-label">Between</span>
          <div className="panel-between">
            <span className="chip">{nameOf(from)}</span>
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            <span className="chip">{nameOf(to)}</span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => draft.edit({ from: to, to: from })}
            >
              Swap
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="panel-field">
            <span className="panel-label">From boundary</span>
            <Select
              aria-label="From boundary"
              value={from}
              onValueChange={(next) => draft.edit({ from: next })}
              options={options}
              placeholder="Choose a boundary"
              disabled={saving}
            />
          </div>
          <div className="panel-field">
            <span className="panel-label">To boundary</span>
            <Select
              aria-label="To boundary"
              value={to}
              onValueChange={(next) => draft.edit({ to: next })}
              options={options}
              placeholder="Choose a boundary"
              disabled={saving}
            />
          </div>
        </>
      )}
      <div className="panel-row">
        <div className="panel-field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            className="field"
            value={title}
            maxLength={LIMITS.blipTitle}
            placeholder="Stripe webhooks"
            disabled={saving}
            onChange={(event) => draft.edit({ title: event.target.value })}
          />
        </div>
        <div className="panel-field">
          <label htmlFor={`${id}-version`}>Version</label>
          <input
            id={`${id}-version`}
            className="field"
            value={version}
            maxLength={32}
            placeholder="1.0"
            disabled={saving}
            onChange={(event) => draft.edit({ version: event.target.value })}
          />
        </div>
      </div>
      <div className="panel-field">
        <span className="panel-label">What it promises</span>
        <BodyField
          key={draft.base}
          label="What it promises"
          current={body}
          apiRef={editor}
          onText={(text) => draft.edit({ body: text })}
        />
      </div>
      {contract ? <LinkedSections data={data} id={contract.id} /> : null}
      {problem ? (
        <p role="alert" className="note">
          {problem}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="note">
          {error}
        </p>
      ) : null}
    </SidePanel>
  );
}

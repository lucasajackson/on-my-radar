import { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  AMEND_LIMITS,
  LIMITS,
  LIVE_ADR_LANES,
  findQuote,
  type ArchitectureDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { MarkdownEditor, type MarkdownEditorApi } from './markdown-editor';
import { Segmented } from './repo-common';
import { Select } from './select';
import { SidePanel } from './side-panel';

type Mode = 'replace' | 'remove';

/**
 * What has been typed into the panel. It lives with whoever opens the panel, not in the panel, so
 * it survives the panel being unmounted by a tab switch or by the window crossing 1024px (which
 * swaps the column for a sheet). `key` names the proposal it belongs to (the quote, or `free`).
 */
export interface AdrDraft {
  key: string;
  title: string;
  mode: Mode;
  replacement: string;
  rationale: string;
  supersedes: string;
  affects: string[];
}

export const emptyAdrDraft = (key: string): AdrDraft => ({
  key,
  title: '',
  mode: 'replace',
  replacement: '',
  rationale: '',
  supersedes: '',
  affects: [],
});

/** Whether closing the panel would lose something somebody wrote. */
export const adrDraftDirty = (draft: AdrDraft | null): boolean =>
  draft !== null &&
  (draft.title.trim() !== '' ||
    draft.rationale.trim() !== '' ||
    draft.replacement.trim() !== '' ||
    draft.supersedes !== '' ||
    draft.affects.length > 0);

/**
 * The Why. The column and the sheet are different places in the tree, so crossing 1024px mounts
 * this again: it opens on what the draft holds then, and is left alone after (a new `value` would
 * make the editor start over under the cursor).
 */
function WhyField({
  current,
  apiRef,
  onText,
}: {
  current: string;
  apiRef: React.RefObject<MarkdownEditorApi | null>;
  onText: (text: string) => void;
}) {
  const opened = useRef(current);
  const now = useRef(current);
  now.current = current;
  return (
    <MarkdownEditor
      value={opened.current}
      variant="compact"
      label="Why"
      apiRef={apiRef}
      onDirtyChange={() => undefined}
      onTextChange={(text) => {
        if (text !== now.current) onText(text);
      }}
    />
  );
}

/**
 * Propose an ADR, in a panel beside the charter. With a quote it amends that span of the charter
 * (the quote arrives from the selection, shown struck through with what replaces it); without one
 * it is a decision on its own: a title and why. "Also affects" names the boundaries and contracts
 * the decision touches, which the ADR then amends on the map.
 */
export function AdrPanel({
  radarId,
  quote,
  pageId = null,
  prefix,
  suffix,
  context,
  architecture,
  draft,
  onDraft,
  onClose,
  onSaved,
}: {
  radarId: string;
  quote?: string | undefined;
  /** The charter's id (it is the radar's): the one "page" the quote is looked for in. */
  pageId?: string | null | undefined;
  /** The words either side of the quote, sent so the server can tell it from a twin elsewhere. */
  prefix?: string | undefined;
  suffix?: string | undefined;
  /** Which match of the quote was selected, and how many the reader saw: the check made here. */
  context?: { occurrence: number; seen: number } | undefined;
  /** The charter and ADR index: the quote is checked against them before anything is sent. */
  architecture: ArchitectureDto;
  draft: AdrDraft;
  onDraft: (patch: Partial<AdrDraft>) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const editor = useRef<MarkdownEditorApi | null>(null);
  const { title, mode, replacement, rationale, supersedes, affects } = draft;
  const setTitle = (next: string) => onDraft({ title: next });
  const setMode = (next: Mode) => onDraft({ mode: next });
  const setReplacement = (next: string) => onDraft({ replacement: next });
  const setRationale = (next: string) => onDraft({ rationale: next });
  const setSupersedes = (next: string) => onDraft({ supersedes: next });
  const setAffects = (next: string[]) => onDraft({ affects: next });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accepted = architecture.adrs.filter((a) => a.lane === 'accepted');
  const elements = [...architecture.boundaries, ...architecture.contracts];
  const elementName = (elementId: string) =>
    elements.find((e) => e.id === elementId)?.title ?? 'an element';
  const removing = mode === 'remove';
  const ready =
    title.trim() !== '' &&
    rationale.trim() !== '' &&
    (quote === undefined || removing || replacement.trim() !== '') &&
    !saving;
  const label = (adr: string) => architecture.adrs.find((a) => a.id === adr)?.label ?? 'an ADR';
  /** Plain-English problems, found here first so a refusal never needs a failed request. */
  // The selected occurrence belongs to the page it was selected on, not to one chosen later.
  const contextFor = (page: string | null) => (page && page === pageId ? context : undefined);
  const problem = (page: string | null): string | null => {
    if (quote === undefined) return null;
    const hit = findQuote(
      architecture.charter.map((p) => ({ id: p.id, markdown: p.markdown ?? '' })),
      quote,
      page ?? undefined,
      contextFor(page),
    );
    if (!('code' in hit)) {
      const live = [...(hit.stack?.layers ?? [])]
        .reverse()
        .find((l) =>
          LIVE_ADR_LANES.some(
            (lane) => lane === architecture.adrs.find((a) => a.id === l.adr)?.lane,
          ),
        );
      return live && live.adr !== supersedes
        ? `That text is already amended by ${label(live.adr)}. Choose it under Supersedes to amend it again.`
        : null;
    }
    if (hit.code === 'quote_ambiguous')
      return `That text appears ${hit.matches.length} times in the charter. Select a longer phrase that appears once.`;
    return 'adr' in hit
      ? `That text is already part of an amendment (${label(hit.adr)}). Select the whole amended span instead.`
      : hit.message;
  };
  const submit = async (page: string | null = pageId) => {
    if (!ready) return;
    const found = problem(page);
    if (found) {
      setError(found);
      return;
    }
    setSaving(true);
    setError(null);
    // The editor reports its text a moment after each change; Save reads it now.
    const why = (editor.current?.markdown() ?? rationale).trim();
    try {
      await api.radars.proposeAdr(radarId, {
        title: title.trim(),
        rationale: why,
        anchors:
          quote === undefined
            ? []
            : [
                {
                  quote,
                  with: removing ? '' : replacement,
                  ...(prefix ? { prefix } : {}),
                  ...(suffix ? { suffix } : {}),
                },
              ],
        ...(supersedes ? { supersedes } : {}),
        ...(affects.length > 0 ? { amends: affects } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not propose that. Try again.');
      setSaving(false);
    }
  };
  const addable = elements.filter((e) => !affects.includes(e.id));
  return (
    <SidePanel
      title="Propose an ADR"
      busy={saving}
      badge={<span className="chip-status is-warn">Stays Proposed until decided</span>}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={!ready}
            onClick={() => void submit(pageId)}
          >
            {saving ? 'Proposing…' : 'Propose ADR'}
          </button>
        </>
      }
    >
      {quote === undefined ? null : (
        <>
          <div className="panel-field">
            <span className="panel-label">The text it changes</span>
            <blockquote
              className={`panel-quote ${removing ? 'is-removed' : ''}`}
              aria-label="Quoted charter text"
            >
              <del>{quote}</del>
              {removing || replacement === '' ? null : <ins>{replacement}</ins>}
            </blockquote>
            <p className="panel-hint">One paragraph, up to {AMEND_LIMITS.quote} characters.</p>
          </div>
          <div className="panel-field">
            <span className="panel-label">What should happen to it</span>
            <Segmented
              label="What should happen to the text"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'replace', label: 'Replace it' },
                { value: 'remove', label: 'Remove it' },
              ]}
            />
          </div>
          {removing ? null : (
            <div className="panel-field">
              <label htmlFor={`${id}-with`}>Replace with</label>
              <input
                id={`${id}-with`}
                className="field"
                value={replacement}
                maxLength={AMEND_LIMITS.with}
                disabled={saving}
                onChange={(event) => setReplacement(event.target.value.replace(/\n/g, ' '))}
              />
            </div>
          )}
        </>
      )}
      <div className="panel-field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          className="field"
          value={title}
          maxLength={LIMITS.blipTitle}
          disabled={saving}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="panel-field">
        <span className="panel-label" id={`${id}-why`}>
          Why
        </span>
        <WhyField current={rationale} apiRef={editor} onText={setRationale} />
      </div>
      <div className="panel-field">
        <span className="panel-label">Also affects</span>
        <div className="chip-row">
          {affects.map((affected) => (
            <span key={affected} className="chip">
              {elementName(affected)}
              <button
                type="button"
                aria-label={`Stop affecting ${elementName(affected)}`}
                onClick={() => setAffects(affects.filter((a) => a !== affected))}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
          {addable.length > 0 ? (
            <Select
              aria-label="Also affects"
              className="chip-select"
              value=""
              placeholder="+ Also affects…"
              onValueChange={(next) => {
                if (next && !affects.includes(next)) setAffects([...affects, next]);
              }}
              options={addable.map((e) => ({
                value: e.id,
                label: 'a' in e ? `${e.title} (contract)` : e.title,
              }))}
            />
          ) : null}
        </div>
      </div>
      {accepted.length > 0 ? (
        <div className="panel-field">
          <span className="panel-label">Supersedes</span>
          <Select
            aria-label="Supersedes"
            value={supersedes}
            onValueChange={setSupersedes}
            options={[
              { value: '', label: 'Nothing' },
              ...accepted.map((adr) => ({ value: adr.id, label: `${adr.label} ${adr.title}` })),
            ]}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="note">
          {error}
        </p>
      ) : null}
    </SidePanel>
  );
}

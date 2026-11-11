/**
 * Rename, add, remove and reorder a radar's lanes.
 *
 * Its own dialog with its own Save rather than a field in the page's draft,
 * because it is its own write with its own refusal: removing a lane that still
 * holds blips is refused by the server, naming the lane and the count, and that
 * answer belongs beside the lanes rather than in a toast over a page of
 * unrelated edits.
 *
 * Every rule is the contract's `validateLanes`, run here on each keystroke and
 * again on the server. What is shown is worded for a person: problems speak of
 * lanes by number and label, never by the ids minted behind them, and nothing
 * is complained about before somebody has touched it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  BLIP_STATE_LABELS,
  BLIP_STATES,
  LANE_LIMITS,
  statusesFor,
  templateFor,
  validateLanes,
  type LaneProblem,
  type RadarDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { draftFromLanes, lanesFromDraft, type LaneDraft } from '../lib/lanes';
import { Modal, notify } from './primitives';
import { Select } from './select';
import { PHONE_QUERY, useMediaQuery } from '../lib/viewport';

const STATE_OPTIONS = BLIP_STATES.map((state) => ({
  value: state,
  label: BLIP_STATE_LABELS[state],
}));

/**
 * A set-level problem, in words that name no minted id. `bad-label` is not
 * here: it is said beside its own row. `bad-id` and `duplicate-id` cannot come
 * from this form (ids are minted unique), so they fall through as worded.
 */
function describe(problem: LaneProblem, supersededLabel: string | null): string | null {
  if (problem.code === 'bad-label') return null;
  if (problem.code === 'lost-superseded-lane') {
    return `Keep the ${supersededLabel ? `“${supersededLabel}”` : 'replaced-entries'} lane: this template files an entry there when a newer one replaces it. Rename it freely.`;
  }
  return problem.message;
}

export function LaneEditor({
  radar,
  onClose,
  onSaved,
}: {
  radar: Pick<RadarDto, 'id' | 'template' | 'templateConfig'>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = useMemo(
    () => draftFromLanes(statusesFor(radar.template, radar.templateConfig)),
    [radar.template, radar.templateConfig],
  );
  const [rows, setRows] = useState<LaneDraft[]>(initial);
  const [added, setAdded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Rows somebody has been in and left, and whether Save has been tried: the
  // two things that earn a complaint.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  // The name field to put the caret in after the next render.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /*
    The move button to keep focus on after a reorder. Reordering moves the
    row's DOM node, which blurs whatever was focused in it, so focus went
    elsewhere and pressing the arrow again did nothing. It stays on the button
    that was pressed, at the row's new place — or on the other direction's once
    the row reaches an end and that one is disabled.
  */
  const [focusMove, setFocusMove] = useState<{ key: string; by: -1 | 1 } | null>(null);
  useEffect(() => {
    if (!focusMove) return;
    const button = (by: -1 | 1) =>
      document.querySelector<HTMLButtonElement>(`[data-lane-move="${focusMove.key}:${by}"]`);
    const same = button(focusMove.by);
    (same && !same.disabled ? same : button(focusMove.by === 1 ? -1 : 1))?.focus();
    setFocusMove(null);
  }, [focusMove, rows]);
  const addButton = useRef<HTMLButtonElement>(null);
  // A whole screen on a phone, where a sheet's top edge would move with every
  // row; anchored to the top on anything wider.
  const phone = useMediaQuery(PHONE_QUERY);

  const lanes = useMemo(() => lanesFromDraft(rows), [rows]);
  const check = useMemo(() => validateLanes(radar.template, lanes), [radar.template, lanes]);
  const dirty = JSON.stringify(lanes) !== JSON.stringify(lanesFromDraft(initial));
  const supersededId = templateFor(radar.template).supersededStatus;
  const supersededLabel =
    statusesFor(radar.template).find((lane) => lane.id === supersededId)?.label ?? null;
  const setProblems = check.ok
    ? []
    : check.problems
        .map((problem) => describe(problem, supersededLabel))
        .filter((message): message is string => message !== null);
  const unnamed = (row: LaneDraft) => !row.label.trim();
  const invalid = setProblems.length > 0 || rows.some(unnamed);

  useEffect(() => {
    if (!focusKey) return;
    document.querySelector<HTMLInputElement>(`[data-lane-name="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey, rows]);

  const change = (next: LaneDraft[]) => {
    setRows(next);
    setRefusal(null);
  };
  const patch = (index: number, fields: Partial<LaneDraft>) =>
    change(rows.map((row, i) => (i === index ? { ...row, ...fields } : row)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(index + by, 0, row);
    change(next);
    setFocusMove({ key: row.key, by });
  };
  const remove = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    change(next);
    // The control that was pressed is gone; the row that took its place is
    // where the person was working.
    const neighbour = next[index] ?? next[index - 1];
    if (neighbour) setFocusKey(neighbour.key);
    else addButton.current?.focus();
  };

  const save = async () => {
    if (invalid) {
      setAttempted(true);
      const first = rows.find(unnamed);
      if (first) setFocusKey(first.key);
      return;
    }
    setBusy(true);
    try {
      await api.radars.update(radar.id, { templateConfig: { lanes } });
      notify('Lanes saved');
      onSaved();
      onClose();
    } catch (err) {
      setRefusal(err instanceof ApiError ? err.message : 'Could not save the lanes');
    } finally {
      setBusy(false);
    }
  };

  const showSetProblems = (dirty || attempted) && setProblems.length > 0;

  return (
    <Modal
      title="Edit lanes"
      description="Left to right is the order on the board. Renaming a lane keeps its blips."
      onClose={onClose}
      anchor="top"
      fill={phone}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save lanes'}
          </button>
        </>
      }
    >
      {/* Seen, not read: each control already carries its own name. */}
      <div className="lane-editor-row lane-editor-head instrument" aria-hidden="true">
        <span>Lane</span>
        <span>Blips here become</span>
        <span />
        <span />
      </div>
      <ol className="lane-editor">
        {rows.map((row, index) => {
          const name = row.label.trim() || `Lane ${index + 1}`;
          const complain = unnamed(row) && (touched.has(row.key) || attempted);
          const errorId = `lane-error-${row.key}`;
          return (
            <li key={row.key} className="lane-editor-row">
              <input
                className="field"
                value={row.label}
                maxLength={LANE_LIMITS.labelMaxLength}
                aria-label={`Lane ${index + 1} name`}
                aria-invalid={complain ? true : undefined}
                aria-describedby={complain ? errorId : undefined}
                data-lane-name={row.key}
                onChange={(event) => patch(index, { label: event.target.value })}
                onBlur={() => setTouched((current) => new Set(current).add(row.key))}
              />
              <Select
                value={row.state}
                options={STATE_OPTIONS}
                aria-label={`What a blip becomes in ${name}`}
                onValueChange={(value) => {
                  const state = BLIP_STATES.find((candidate) => candidate === value);
                  if (state) patch(index, { state });
                }}
              />
              <label className="lane-editor-terminal">
                <input
                  type="checkbox"
                  checked={row.terminal}
                  onChange={(event) => patch(index, { terminal: event.target.checked })}
                />
                Finished
              </label>
              <span className="lane-editor-tools">
                <button
                  className="btn btn-ghost p-1.5"
                  aria-label={`Move ${name} earlier`}
                  data-lane-move={`${row.key}:-1`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  className="btn btn-ghost p-1.5"
                  aria-label={`Move ${name} later`}
                  data-lane-move={`${row.key}:1`}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  className="btn btn-ghost p-1.5"
                  aria-label={`Remove ${name}`}
                  onClick={() => remove(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
              {complain ? (
                <span id={errorId} className="lane-editor-row-error">
                  Lane {index + 1} needs a name
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <button
        ref={addButton}
        className="btn btn-ghost mt-2 self-start"
        disabled={rows.length >= LANE_LIMITS.max}
        onClick={() => {
          const key = `new:${added}`;
          change([...rows, { key, id: null, label: '', state: 'active', terminal: false }]);
          setAdded(added + 1);
          setFocusKey(key);
        }}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add lane
      </button>
      <p className="note mt-3">
        “Finished” lanes can furl to a rail and age out of view. A lane that still holds blips
        cannot be removed — move them out first, or keep the lane and rename it.
      </p>
      {showSetProblems ? (
        <ul className="lane-editor-problems">
          {setProblems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {refusal ? (
        <p className="lane-editor-problems" role="alert">
          {refusal}
        </p>
      ) : null}
    </Modal>
  );
}

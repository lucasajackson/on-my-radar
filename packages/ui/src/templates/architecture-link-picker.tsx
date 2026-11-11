/**
 * The picker that ties a selection to a boundary or contract. It is not a dialog: it takes the
 * selection toolbar's place (the toolbar is already anchored at the selection, floating from
 * 1024px and docked above the tab bar below it), so nothing is drawn over the text and nothing
 * traps focus. Type to narrow the elements; Enter picks the highlighted one; Esc cancels.
 *
 * A boundary can be made in the same breath ("+ New boundary named …"). A contract joins two
 * boundaries, so making one asks for them, one list after the other.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { seamLabel, type ArchitectureDto } from '@onmyradar/contract';
import type { LinkCharterInput } from '../lib/api';

export type LinkKind = 'boundary' | 'contract';
export type LinkElement = LinkCharterInput['element'];

/** Plain words for what the server may answer to a link. */
export function linkProblem(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  switch (code) {
    case 'quote_ambiguous':
      return 'That text appears more than once in the charter. Select a few more words.';
    case 'quote_not_found':
      return "That text isn't in the saved charter. Let it finish saving, then try again.";
    case 'too_many_anchors':
      return 'This charter already has as many links and amendments as it can hold.';
    case 'quote_too_long':
      return 'Links cover 4,000 characters at most. Select less.';
    case 'quote_in_code':
      return "Code can't be anchored. Select the sentence around it.";
    case 'already_linked':
      return message || 'That passage is already linked to it.';
    default:
      return message || 'Could not save that link. Try again.';
  }
}

interface Choice {
  id: string;
  title: string;
  detail: string;
}

const choicesOf = (data: ArchitectureDto, kind: LinkKind): Choice[] =>
  kind === 'boundary'
    ? data.boundaries.map((b) => ({
        id: b.id,
        title: b.title,
        detail: b.external ? 'Outside our system' : (b.owns ?? []).slice(0, 3).join(', '),
      }))
    : data.contracts.map((c) => ({
        id: c.id,
        title: c.title,
        detail: `${seamLabel(c)}${c.version ? ` · v${c.version}` : ''}`,
      }));

/** Matches first (the ones that start with it, then the ones that hold it), then the alphabet. */
function narrow(all: readonly Choice[], typed: string): Choice[] {
  const needle = typed.trim().toLowerCase();
  const rank = (c: Choice): number => {
    const title = c.title.toLowerCase();
    return !needle || title.startsWith(needle) ? 0 : title.includes(needle) ? 1 : 2;
  };
  return all
    .filter((c) => rank(c) < 2)
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

type Step =
  { at: 'pick' } | { at: 'first'; title: string } | { at: 'second'; title: string; a: string };

export function LinkPicker({
  kind,
  data,
  busy,
  problem,
  onPick,
  onCancel,
}: {
  kind: LinkKind;
  data: ArchitectureDto;
  busy: boolean;
  /** What went wrong the last time, in words; shown where the person is looking. */
  problem: string | null;
  onPick: (element: LinkElement) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [active, setActive] = useState(0);
  useEffect(() => input.current?.focus(), [step.at]);

  const what = step.at === 'pick' ? kind : 'boundary';
  const all = useMemo(() => choicesOf(data, what), [data, what]);
  const second = step.at === 'second' ? step.a : null;
  const shown = useMemo(
    () => narrow(all, typed).filter((c) => c.id !== second),
    [all, typed, second],
  );
  const name = typed.trim();
  const exact = all.some((c) => c.title.toLowerCase() === name.toLowerCase());
  const canMake =
    step.at === 'pick' &&
    name !== '' &&
    !exact &&
    (kind === 'boundary' || data.boundaries.length >= 2);
  const noPair = step.at === 'pick' && kind === 'contract' && data.boundaries.length < 2;
  /** The rows, in order: what exists, then the way to make one. */
  const rows: Array<{
    key: string;
    label: string;
    detail?: string;
    make?: boolean;
    run: () => void;
  }> = [
    ...shown.map((c) => ({
      key: c.id,
      label: c.title,
      detail: c.detail,
      run: () => {
        if (step.at === 'first') {
          setStep({ at: 'second', title: step.title, a: c.id });
          setTyped('');
        } else if (step.at === 'second') {
          onPick({ kind: 'contract', title: step.title, a: step.a, b: c.id });
        } else onPick(c.id);
      },
    })),
    ...(canMake
      ? [
          {
            key: 'new',
            label: `New ${kind} named “${name}”`,
            make: true,
            run: () => {
              if (kind === 'boundary') onPick({ kind: 'boundary', title: name });
              else {
                setStep({ at: 'first', title: name });
                setTyped('');
              }
            },
          },
        ]
      : []),
  ];
  const at = Math.min(active, Math.max(0, rows.length - 1));
  const prompt =
    step.at === 'first'
      ? `“${step.title}” is between… pick the first boundary`
      : step.at === 'second'
        ? 'and the second boundary'
        : `Search ${kind === 'boundary' ? 'boundaries' : 'contracts'}`;

  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length > 0)
        setActive((at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === 'Enter') {
      // Enter picks from the field or a row; on Cancel it is Cancel's own.
      const from = event.target instanceof Element ? event.target : null;
      if (!from?.closest('input, [role="option"]')) return;
      event.preventDefault();
      if (!busy) rows[at]?.run();
    }
  };

  return (
    <div className="link-picker" role="group" aria-label={`Link to ${kind}`} onKeyDown={keys}>
      <div className="link-picker-head">
        <input
          ref={input}
          className="field link-picker-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={rows[at] ? `${id}-${rows[at].key}` : undefined}
          aria-autocomplete="list"
          aria-label={prompt}
          placeholder={prompt}
          value={typed}
          maxLength={200}
          disabled={busy}
          onChange={(event) => {
            setTyped(event.target.value);
            setActive(0);
          }}
        />
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ul id={`${id}-list`} className="link-picker-list" role="listbox" aria-label={prompt}>
        {rows.map((row, k) => (
          <li
            key={row.key}
            id={`${id}-${row.key}`}
            role="option"
            aria-selected={k === at}
            className={`link-picker-row${k === at ? ' is-active' : ''}${row.make ? ' is-new' : ''}`}
            onPointerEnter={() => setActive(k)}
            onClick={() => {
              if (!busy) row.run();
            }}
          >
            <span className="link-picker-title">
              {row.make ? '+ ' : ''}
              {row.label}
            </span>
            {row.detail ? <span className="link-picker-detail">{row.detail}</span> : null}
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="link-picker-empty" role="presentation">
            {noPair
              ? 'A contract joins two boundaries. Add them on the Map first.'
              : typed.trim() === ''
                ? `No ${what}s yet. Type a name to make one.`
                : `No ${what} matches.`}
          </li>
        ) : null}
      </ul>
      {problem ? (
        <p className="link-picker-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

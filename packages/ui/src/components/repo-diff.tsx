/**
 * A line diff that reads like a review, not a patch — for prompt versions and
 * memory revisions.
 *
 * Lines wrap — a prompt line is a paragraph, and one unwrapped line ran off the
 * side of the dialog. Both sides are named, so it is never a guess which text
 * is which. A removed line directly followed by the line that replaced it is
 * diffed word by word: the words that changed are marked and the rest stays
 * quiet, rather than the whole paragraph printed twice in two colours.
 *
 * `ignoreFormatting` compares what the Markdown *says* rather than how it is
 * spelled (docs/AGENT_REPO.md §V2.4): the first WYSIWYG save of a prompt may
 * re-pad a table, and a one-word edit must not read as a rewrite.
 */
import { useMemo, useState } from 'react';
import { lineDiff, withContext, wordDiff, type WordPart } from '../lib/diff';
import { plainText, renderMarkdown } from '../lib/markdown';
import { Spinner } from './primitives';
import { Segmented, Switch } from './repo-common';

/** Markdown → the words it renders to, one line per block. Formatting-blind. */
export function renderedText(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => plainText(block, 100_000))
    .filter(Boolean)
    .join('\n');
}

export function DiffView({
  before,
  after,
  beforeLabel,
  afterLabel,
  ignoreFormatting = false,
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  ignoreFormatting?: boolean;
}) {
  const rows = useMemo(
    () =>
      withContext(
        ignoreFormatting
          ? lineDiff(renderedText(before), renderedText(after))
          : lineDiff(before, after),
      ),
    [before, after, ignoreFormatting],
  );
  const words = useMemo(() => {
    const parts = new Map<number, WordPart[]>();
    let index = 0;
    while (index < rows.length) {
      const removed: number[] = [];
      while (rows[index]?.kind === 'remove') removed.push(index++);
      const added: number[] = [];
      while (rows[index]?.kind === 'add') added.push(index++);
      removed.forEach((at, k) => {
        const partner = added[k];
        const left = rows[at];
        const right = partner === undefined ? undefined : rows[partner];
        if (partner === undefined || left?.kind !== 'remove' || right?.kind !== 'add') return;
        const diff = wordDiff(left.text, right.text);
        parts.set(at, diff.before);
        parts.set(partner, diff.after);
      });
      if (removed.length === 0 && added.length === 0) index += 1;
    }
    return parts;
  }, [rows]);
  const unchanged = rows.every((row) => row.kind === 'same' || row.kind === 'gap');
  return (
    <div className="prompt-diff">
      <p className="prompt-diff-legend instrument">
        <span className="is-remove">− {beforeLabel}</span>
        <span className="is-add">+ {afterLabel}</span>
        {ignoreFormatting ? null : <span>· as Markdown</span>}
      </p>
      {unchanged ? (
        <p className="note">{ignoreFormatting ? 'They say the same thing.' : 'No difference.'}</p>
      ) : (
        <div className="prompt-diff-body scroll-area" role="table" aria-label="Changes">
          {rows.map((row, i) =>
            row.kind === 'gap' ? (
              <div key={i} className="instrument prompt-diff-gap" role="row">
                ··· {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
              </div>
            ) : (
              <div key={i} className={`prompt-diff-line is-${row.kind}`} role="row">
                <span className="prompt-diff-mark" aria-hidden="true">
                  {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''}
                </span>
                <span className="sr-only">
                  {row.kind === 'add' ? 'Added: ' : row.kind === 'remove' ? 'Removed: ' : ''}
                </span>
                <span className="prompt-diff-text">
                  {words
                    .get(i)
                    ?.map((part, k) =>
                      part.changed ? (
                        <mark key={k}>{part.text}</mark>
                      ) : (
                        <span key={k}>{part.text}</span>
                      ),
                    ) ??
                    (row.text || ' ')}
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** What a History drawer shows of the version selected in it. */
export type CompareView = 'changes' | 'current' | 'read';

/**
 * What can actually be shown for a version: the first one changed nothing,
 * and the current one has nothing newer to compare with.
 */
export function compareView(view: CompareView, previous: number, isCurrent: boolean): CompareView {
  if (view === 'changes' && previous <= 0) return 'read';
  if (view === 'current' && isCurrent) return previous > 0 ? 'changes' : 'read';
  return view;
}

interface Pair {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
}

/**
 * The lower half of a History drawer — for prompt versions and brief
 * revisions alike: which version this is, what to show of it (what it changed,
 * how it differs from the current one, or the version itself), the
 * formatting-blind switch, and the diff or the document. The drawer owns the
 * list and fetches the texts; this only shows them.
 */
export function VersionCompare({
  name,
  isCurrent,
  shown,
  onView,
  hasPrevious,
  currentLabel,
  loading,
  changes,
  current,
  body,
}: {
  /** The selected version as the page writes it: "v3", "r3". */
  name: string;
  isCurrent: boolean;
  /** Already passed through `compareView`. */
  shown: CompareView;
  onView: (view: CompareView) => void;
  hasPrevious: boolean;
  /** "Compare with current", or a recipient's "Changes since v3". */
  currentLabel: string;
  loading: boolean;
  changes: Pair | null;
  current: Pair | null;
  body: string | null;
}) {
  const [ignoreFormatting, setIgnoreFormatting] = useState(false);
  const pair = shown === 'changes' ? changes : shown === 'current' ? current : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="instrument">
          {name}
          {isCurrent ? ' · current' : ''}
        </span>
        <Segmented
          label="Show"
          value={shown}
          onChange={onView}
          options={[
            ...(hasPrevious ? [{ value: 'changes' as const, label: 'What it changed' }] : []),
            ...(!isCurrent ? [{ value: 'current' as const, label: currentLabel }] : []),
            { value: 'read' as const, label: 'Read' },
          ]}
        />
      </div>
      {loading ? <Spinner label="Reading that version" /> : null}
      {shown !== 'read' ? (
        <label className="flex items-center gap-2">
          <Switch
            label="Ignore formatting"
            checked={ignoreFormatting}
            onChange={setIgnoreFormatting}
          />
          <span className="note">Ignore formatting</span>
        </label>
      ) : null}
      {pair ? (
        <DiffView {...pair} ignoreFormatting={ignoreFormatting} />
      ) : shown === 'read' && body !== null ? (
        <div
          className="md-doc prompt-doc is-small"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body, { tagLinks: false }) }}
        />
      ) : null}
    </>
  );
}

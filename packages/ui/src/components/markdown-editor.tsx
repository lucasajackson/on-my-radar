/**
 * The WYSIWYG Markdown editor, for a prompt and for a memory.
 *
 * The page being read becomes editable in place — same measure, same type — so
 * editing looks like the document you were reading (docs/AGENT_REPO_UI.md §3).
 * Milkdown loads **only when this mounts**, through a dynamic import, so
 * reading a prompt never downloads it; until it arrives the rendered document
 * stands in as the skeleton.
 *
 * **View Markdown** swaps to the raw source in a monospace textarea: lossless,
 * and the escape hatch for anything the WYSIWYG schema cannot express. It is
 * lossless on purpose — if the rich view was never touched, the textarea holds
 * the original text, not the editor's re-serialization of it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Bold,
  Code,
  Columns3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Redo2,
  Rows3,
  SquareCode,
  Table,
  TextQuote,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { AnchorDraw, EditorAction, EditorHandle, EditorStatus } from '../lib/milkdown';
import { renderMarkdown } from '../lib/markdown';
import { Select } from './select';

export interface MarkdownEditorApi {
  /** What Save would write: the edited document, or the original when untouched. */
  markdown: () => string;
  /** The rich view normalised formatting on load (table padding, autolinks). */
  normalised: () => boolean;
  /**
   * What was typed in the last moment, which has not been reported yet: handed over once, and
   * not reported again. Null when everything typed has been reported.
   */
  takePending: () => string | null;
}

type Mode = 'rich' | 'source';

const IDLE_STATUS: EditorStatus = {
  block: 'paragraph',
  bold: false,
  italic: false,
  code: false,
  link: false,
  inTable: false,
  language: null,
};

const BLOCKS = {
  prompt: [
    { value: 'paragraph', label: 'Paragraph' },
    { value: 'h1', label: 'Heading 1' },
    { value: 'h2', label: 'Heading 2' },
    { value: 'h3', label: 'Heading 3' },
  ],
  // A memory sits inside a page that already has headings: nothing above H3.
  memory: [
    { value: 'paragraph', label: 'Paragraph' },
    { value: 'h3', label: 'Heading 3' },
  ],
  // The charter: the whole document, so every block and a table.
  charter: [
    { value: 'paragraph', label: 'Paragraph' },
    { value: 'h1', label: 'Heading 1' },
    { value: 'h2', label: 'Heading 2' },
    { value: 'h3', label: 'Heading 3' },
  ],
  // A short field in a side panel (an ADR's Why, a contract's promise): the same blocks as a memory.
  compact: [
    { value: 'paragraph', label: 'Paragraph' },
    { value: 'h3', label: 'Heading 3' },
  ],
} as const;

const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();

export function MarkdownEditor({
  value,
  variant = 'prompt',
  label,
  meta,
  apiRef,
  onDirtyChange,
  onNormalised,
  onTextChange,
  anchors,
  locked = false,
  autoFocus = false,
}: {
  /** The text being edited, as stored. The baseline "changed" is measured against. */
  value: string;
  /**
   * `memory` is the smaller toolbar: no tables, no headings above H3. `compact` is the one for a
   * field inside a side panel: bold, italic, code, link, list, quote and undo, in a box that grows
   * with its text, with View Markdown offered only when the rich editor could not load.
   */
  variant?: 'prompt' | 'memory' | 'compact' | 'charter';
  /** The editable region's accessible name. */
  label: string;
  /** Instrument text beside View Markdown ("Editing v16 · saves as Markdown"). */
  meta?: ReactNode;
  apiRef: RefObject<MarkdownEditorApi | null>;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Opening the document re-wrote its formatting (table padding, autolinks) —
   * so the first save's note can say so rather than the diff looking like a
   * rewrite nobody made.
   */
  onNormalised?: () => void;
  /**
   * The document as it changes, as Markdown — for a live size count. In the
   * rich view it is serialised at most every 150 ms while typing, not on every
   * keystroke.
   */
  onTextChange?: (markdown: string) => void;
  /**
   * Text to underline as amended (the charter): drawn over the document, never written into it.
   * Keep the object the same between renders; a new one is drawn again.
   */
  anchors?: AnchorDraw | null;
  /** Hold the document still: nothing can be typed or run while it is true. */
  locked?: boolean;
  autoFocus?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('rich');
  /** The text the current rich editor was created from. Starts as `value`. */
  const [text, setText] = useState(value);
  const [source, setSource] = useState(value);
  const [status, setStatus] = useState<EditorStatus>(IDLE_STATUS);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [language, setLanguage] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;
  const normalisedRef = useRef(onNormalised);
  normalisedRef.current = onNormalised;
  const lastDirty = useRef<boolean | null>(null);
  const textChangeRef = useRef(onTextChange);
  textChangeRef.current = onTextChange;
  const measuring = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mineRef = useRef<MarkdownEditorApi | null>(null);
  const takePendingRef = useRef((): string | null => {
    if (!measuring.current) return null;
    clearTimeout(measuring.current);
    measuring.current = null;
    return apiRef.current?.markdown() ?? null;
  });
  /** Report the document's Markdown soon — once per burst of typing. */
  const measureRef = useRef(() => {
    if (!textChangeRef.current || measuring.current) return;
    measuring.current = setTimeout(() => {
      measuring.current = null;
      const markdown = apiRef.current?.markdown();
      if (markdown !== undefined) textChangeRef.current?.(markdown);
    }, 150);
  });
  useEffect(
    () => () => {
      // Closing within the moment before a report: say what was typed rather than drop it.
      const markdown = takePendingRef.current();
      if (markdown !== null) textChangeRef.current?.(markdown);
      // This editor is gone: nobody may read what it held as if it were the document now.
      if (apiRef.current === mineRef.current) apiRef.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs, read when the editor goes
    [],
  );

  const report = (dirty: boolean) => {
    if (lastDirty.current === dirty) return;
    lastDirty.current = dirty;
    dirtyRef.current(dirty);
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  // The rich editor: created when the rich view is showing, from `text`.
  useEffect(() => {
    if (mode !== 'rich') return;
    const host = root.current;
    if (!host) return;
    let disposed = false;
    const live = () => !disposed;
    setReady(false);
    void (async () => {
      try {
        const { createEditor } = await import('../lib/milkdown');
        if (!live()) return;
        const created = await createEditor(host, text, () => {
          const current = handle.current;
          if (!current) return;
          setStatus(current.status());
          reportRef.current(!same(text, value) || current.changed());
          measureRef.current();
        });
        if (!live()) {
          await created.destroy();
          return;
        }
        handle.current = created;
        const editable = host.querySelector<HTMLElement>('[contenteditable]');
        if (editable) {
          editable.setAttribute('role', 'textbox');
          editable.setAttribute('aria-multiline', 'true');
          editable.setAttribute('aria-label', label);
          editable.setAttribute('spellcheck', 'true');
        }
        setStatus(created.status());
        setReady(true);
        reportRef.current(!same(text, value));
        textChangeRef.current?.(text);
        if (!same(created.initialMarkdown, text)) normalisedRef.current?.();
        if (autoFocus) created.focus();
      } catch (error) {
        if (live()) setFailed(error instanceof Error ? error.message : 'The editor did not load');
      }
    })();
    return () => {
      disposed = true;
      const current = handle.current;
      handle.current = null;
      // Text typed in the last moments has not been reported yet: say so before it is gone, so
      // a form that is closing or remounting keeps it.
      if (current && measuring.current) {
        clearTimeout(measuring.current);
        measuring.current = null;
        textChangeRef.current?.(current.markdown());
      }
      if (current) void current.destroy();
      host.replaceChildren();
    };
  }, [mode, text, value, label, autoFocus]);

  useEffect(() => {
    if (ready && mode === 'rich') handle.current?.setAnchors(anchors ?? null);
  }, [ready, mode, anchors]);

  useEffect(() => {
    if (ready && mode === 'rich') handle.current?.setEditable(!locked);
  }, [ready, mode, locked]);

  const api: MarkdownEditorApi = {
    markdown: () => {
      if (mode === 'source') return source;
      const current = handle.current;
      return current?.changed() ? current.markdown() : text;
    },
    normalised: () => {
      const current = handle.current;
      return mode === 'rich' && current !== null && !same(current.initialMarkdown, text);
    },
    takePending: () => takePendingRef.current(),
  };
  apiRef.current = api;
  mineRef.current = api;

  const run = (action: EditorAction) => {
    const current = handle.current;
    if (!current) return;
    current.run(action);
    current.focus();
  };

  const toSource = () => {
    const current = handle.current;
    const next = current?.changed() ? current.markdown() : text;
    setSource(next);
    setMode('source');
    report(!same(next, value));
  };
  const toRich = () => {
    setText(source);
    setMode('rich');
  };

  const skeleton = useMemo(() => renderMarkdown(text, { tagLinks: false }), [text]);
  const compact = variant === 'compact';
  const blocks = BLOCKS[variant];
  const blockValue = blocks.some((b) => b.value === status.block) ? status.block : '';

  const tool = (
    name: string,
    icon: ReactNode,
    action: EditorAction | (() => void),
    options: { pressed?: boolean; shortcut?: string } = {},
  ) => (
    <button
      type="button"
      className="md-tool"
      aria-label={name}
      title={options.shortcut ? `${name} (${options.shortcut})` : name}
      aria-pressed={options.pressed}
      disabled={!ready || locked}
      // Keep the editor's selection: a click must not blur the document first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (typeof action === 'function' ? action() : run(action))}
    >
      {icon}
    </button>
  );

  return (
    <div
      className={`md-editor ${compact ? 'is-compact' : ''} ${variant === 'charter' ? 'is-charter' : ''}`}
    >
      <div className="md-toolbar" role="toolbar" aria-label="Formatting">
        {mode === 'rich' ? (
          <div className="md-tools">
            <Select
              aria-label="Text style"
              className="md-block-select"
              value={blockValue}
              placeholder="Text style"
              disabled={!ready || locked}
              options={blocks}
              onValueChange={(next) => {
                if (next === 'paragraph' || next === 'h1' || next === 'h2' || next === 'h3')
                  run({ kind: 'block', to: next });
              }}
            />
            <span className="md-toolgroup">
              {tool('Bold', <Bold />, { kind: 'bold' }, { pressed: status.bold, shortcut: '⌘B' })}
              {tool(
                'Italic',
                <Italic />,
                { kind: 'italic' },
                { pressed: status.italic, shortcut: '⌘I' },
              )}
              {tool(
                'Inline code',
                <Code />,
                { kind: 'code' },
                { pressed: status.code, shortcut: '⌘E' },
              )}
              {tool('Link', <Link2 />, () => setLinking(''), { pressed: status.link })}
            </span>
            <span className="md-toolgroup">
              {tool('Bulleted list', <List />, { kind: 'bullet' }, { shortcut: '⌘⌥8' })}
              {compact ? null : (
                <>
                  {tool('Numbered list', <ListOrdered />, { kind: 'ordered' }, { shortcut: '⌘⌥7' })}
                  {tool('Task list', <ListChecks />, { kind: 'task' })}
                </>
              )}
            </span>
            <span className="md-toolgroup">
              {tool('Quote', <TextQuote />, { kind: 'quote' }, { shortcut: '⌘⇧B' })}
              {compact ? null : (
                <>
                  {tool('Code block', <SquareCode />, { kind: 'codeBlock' }, { shortcut: '⌘⌥C' })}
                  {variant === 'prompt' || variant === 'charter'
                    ? tool('Table', <Table />, { kind: 'table' })
                    : null}
                  {tool('Divider', <Minus />, { kind: 'rule' })}
                </>
              )}
            </span>
            <span className="md-toolgroup">
              {tool('Undo', <Undo2 />, { kind: 'undo' }, { shortcut: '⌘Z' })}
              {compact ? null : tool('Redo', <Redo2 />, { kind: 'redo' }, { shortcut: '⇧⌘Z' })}
            </span>
            {status.inTable ? (
              <span className="md-toolgroup" aria-label="Table">
                {tool('Add a row below', <Rows3 />, { kind: 'addRow' })}
                {tool('Add a column to the right', <Columns3 />, { kind: 'addCol' })}
                {tool('Delete the selected cells', <Trash2 />, { kind: 'deleteCells' })}
              </span>
            ) : null}
            {status.block === 'code' ? (
              <input
                className="field md-language"
                aria-label="Code block language"
                placeholder={status.language || 'language'}
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    run({ kind: 'language', language: language.trim() });
                    setLanguage('');
                  }
                }}
              />
            ) : null}
          </div>
        ) : null}
        {compact && !failed && mode === 'rich' ? null : (
          <span className="md-toolbar-end">
            {meta ? <span className="instrument">{meta}</span> : null}
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={mode === 'source'}
              onClick={mode === 'rich' ? toSource : toRich}
            >
              {mode === 'rich' ? 'View Markdown' : 'Back to page'}
            </button>
          </span>
        )}
      </div>

      {linking !== null && mode === 'rich' ? (
        <form
          className="md-linkbar"
          onSubmit={(event) => {
            event.preventDefault();
            const href = linking.trim();
            if (href) run({ kind: 'link', href });
            setLinking(null);
          }}
        >
          <input
            className="field"
            type="url"
            aria-label="Link address"
            placeholder="https://"
            value={linking}
            autoFocus
            onChange={(event) => setLinking(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setLinking(null);
              }
            }}
          />
          <button type="submit" className="btn" disabled={!linking.trim()}>
            Apply
          </button>
          {status.link ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                run({ kind: 'link', href: '' });
                setLinking(null);
              }}
            >
              Remove link
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={() => setLinking(null)}>
            Cancel
          </button>
        </form>
      ) : null}

      {failed ? (
        <p className="note text-[color:var(--danger)]" role="alert">
          The editor did not load ({failed}). View Markdown still edits the source.
        </p>
      ) : null}

      {mode === 'source' ? (
        <textarea
          className="field md-source"
          aria-label={`${label} — Markdown source`}
          value={source}
          spellCheck={false}
          onChange={(event) => {
            setSource(event.target.value);
            report(!same(event.target.value, value));
            textChangeRef.current?.(event.target.value);
          }}
        />
      ) : (
        <>
          {!ready && !failed ? (
            <div
              className={`md-doc md-skeleton ${variant === 'memory' || compact ? 'is-memory' : ''}`}
              aria-busy="true"
              aria-label="Loading the editor"
              dangerouslySetInnerHTML={{ __html: skeleton }}
            />
          ) : null}
          <div
            ref={root}
            className={`md-doc md-rich ${variant === 'memory' || compact ? 'is-memory' : ''}`}
            hidden={!ready}
          />
        </>
      )}
    </div>
  );
}

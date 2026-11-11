import { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';

/** Where a pointer is, for dragging a chip to a new place. */
interface Drag {
  from: number;
  at: { x: number; y: number };
  moved: boolean;
  over: number;
}
/** How far a press travels before it is a drag and not a click to rename. */
const DRAG_PX = 5;

/** What a paste or a typed run holds: one per line or comma, trimmed, blanks gone. */
export const splitList = (text: string): string[] =>
  text
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * A list of short strings as chips (a boundary's "What it owns"). Enter or a comma adds what is
 * typed; pasting a list adds every item in it; a click renames a chip; dragging (pointer, so it
 * works under a finger) or Alt with the arrow keys reorders; the cross removes. Text left in the
 * box when focus leaves is added too, so nothing typed is lost by not pressing Enter. The value is
 * the same plain list of strings the server stores.
 */
export function ChipInput({
  values,
  onChange,
  label,
  placeholder = 'Type, then Enter or comma',
  maxItems = 100,
  maxLength = 200,
  disabled = false,
  pending,
  onPending,
}: {
  values: readonly string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
  maxItems?: number;
  maxLength?: number;
  disabled?: boolean;
  /**
   * The text in the box that is not a chip yet, when whoever holds the list keeps it too: a form
   * that is closed and reopened (a tab switch) gets it back with the chips.
   */
  pending?: string;
  onPending?: (text: string) => void;
}) {
  const id = useId();
  const [kept, keep] = useState('');
  const text = pending ?? kept;
  const setText = onPending ?? keep;
  const [renaming, setRenaming] = useState<{ index: number; text: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const chips = useRef<Array<HTMLElement | null>>([]);
  const input = useRef<HTMLInputElement>(null);

  const clean = (items: string[]) => items.map((item) => item.slice(0, maxLength));
  /** Add items after the last, skipping any already there (case-insensitively). */
  const add = (items: string[]) => {
    const seen = new Set(values.map((v) => v.toLowerCase()));
    const fresh: string[] = [];
    for (const item of clean(items)) {
      if (seen.has(item.toLowerCase())) continue;
      seen.add(item.toLowerCase());
      fresh.push(item);
    }
    if (fresh.length > 0) onChange([...values, ...fresh].slice(0, maxItems));
  };
  /**
   * A chip that was moved is a new button, and the keyboard follows it once it is drawn. Only if
   * the focus has nowhere else to be: by then it may be in the box of a chip being renamed, which
   * it must not be taken from.
   */
  const followFocus = (to: number) =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !active.classList.contains('chip-body')) return;
      chips.current[to]?.querySelector('button')?.focus();
    });
  const commitText = () => {
    add(splitList(text));
    setText('');
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= values.length || to === from) return;
    const next = [...values];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    onChange(next);
  };
  const commitRename = () => {
    if (!renaming) return;
    const next = renaming.text.trim().slice(0, maxLength);
    const clash = values.some(
      (v, i) => i !== renaming.index && v.toLowerCase() === next.toLowerCase(),
    );
    if (next && !clash && next !== values[renaming.index])
      onChange(values.map((v, i) => (i === renaming.index ? next : v)));
    setRenaming(null);
  };
  /** The chip under a point, or the nearest on its row. */
  const overAt = (x: number, y: number): number => {
    let best = -1;
    let bestGap = Infinity;
    chips.current.forEach((chip, index) => {
      if (!chip) return;
      const box = chip.getBoundingClientRect();
      const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
      const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      const gap = dx + dy * 4;
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    return best;
  };

  return (
    <div
      className="chip-input"
      data-disabled={disabled || undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget) input.current?.focus();
      }}
    >
      <ul className="chip-list" aria-label={label}>
        {values.map((value, index) =>
          renaming?.index === index ? (
            <li key={`${value}-${index}`} className="chip-item">
              <input
                className="chip-edit"
                aria-label={`Rename ${value}`}
                value={renaming.text}
                maxLength={maxLength}
                size={Math.max(4, renaming.text.length + 1)}
                autoFocus
                onChange={(event) => setRenaming({ index, text: event.target.value })}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(null);
                  }
                }}
              />
            </li>
          ) : (
            <li
              key={`${value}-${index}`}
              ref={(node) => {
                chips.current[index] = node;
              }}
              className={`chip-item ${drag?.moved && drag.from === index ? 'is-dragging' : ''} ${
                drag?.moved && drag.over === index && drag.from !== index ? 'is-over' : ''
              }`}
            >
              <button
                type="button"
                className="chip-body"
                disabled={disabled}
                aria-label={`${value}. Click to rename, drag or Alt with the arrow keys to move.`}
                onPointerDown={(event) => {
                  if (event.button !== 0 && event.pointerType === 'mouse') return;
                  setDrag({
                    from: index,
                    at: { x: event.clientX, y: event.clientY },
                    moved: false,
                    over: index,
                  });
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // A synthetic pointer has nothing to capture; the drag still works.
                  }
                }}
                onPointerMove={(event) => {
                  if (!drag || drag.from !== index) return;
                  const far =
                    Math.hypot(event.clientX - drag.at.x, event.clientY - drag.at.y) >= DRAG_PX;
                  if (!drag.moved && !far) return;
                  setDrag({ ...drag, moved: true, over: overAt(event.clientX, event.clientY) });
                }}
                onPointerUp={(event) => {
                  const now = drag;
                  setDrag(null);
                  if (!now || now.from !== index) return;
                  if (now.moved) move(now.from, overAt(event.clientX, event.clientY));
                  else setRenaming({ index, text: value });
                }}
                onPointerCancel={() => setDrag(null)}
                // A press with a pointer renames on release (above); this is the activation that
                // has none, a screen reader's or the Space key's.
                onClick={(event) => {
                  if (event.detail === 0) setRenaming({ index, text: value });
                }}
                onKeyDown={(event) => {
                  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) {
                    event.preventDefault();
                    move(index, index - 1);
                    followFocus(index - 1);
                  } else if (
                    event.altKey &&
                    (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                  ) {
                    event.preventDefault();
                    move(index, index + 1);
                    followFocus(index + 1);
                  } else if (event.key === 'Enter' || event.key === 'F2') {
                    event.preventDefault();
                    setRenaming({ index, text: value });
                  }
                }}
              >
                {value}
              </button>
              <button
                type="button"
                className="chip-remove"
                disabled={disabled}
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((_, i) => i !== index))}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </li>
          ),
        )}
        <li className="chip-add">
          <input
            ref={input}
            id={`${id}-add`}
            className="chip-text"
            aria-label={`Add to ${label}`}
            placeholder={values.length === 0 ? placeholder : 'Add…'}
            value={text}
            disabled={disabled || values.length >= maxItems}
            onChange={(event) => {
              const next = event.target.value;
              // A comma ends an item, wherever it was typed.
              if (next.includes(',')) {
                const parts = next.split(',');
                add(splitList(parts.slice(0, -1).join(',')));
                setText(parts.at(-1) ?? '');
              } else setText(next.slice(0, maxLength));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                // Enter adds the item and never submits the form around it.
                event.preventDefault();
                commitText();
              } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
                onChange(values.slice(0, -1));
              }
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text');
              if (!/[\n,]/.test(pasted)) return;
              event.preventDefault();
              // What was typed so far is an item of its own; the pasted list follows it.
              add([...splitList(text), ...splitList(pasted)]);
              setText('');
            }}
            onBlur={() => {
              // The box is moved in the page when a panel is, which blurs it and puts focus straight
              // back: that is not leaving it, and what is typed stays text until it is.
              queueMicrotask(() => {
                if (document.activeElement !== input.current) commitText();
              });
            }}
          />
        </li>
      </ul>
    </div>
  );
}

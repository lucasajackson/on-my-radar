/**
 * A stand-in for `lib/milkdown` in jsdom tests, which cannot run ProseMirror's layout. A test mocks
 * the module with `fakeMilkdown`, finds the editor a form opened (`fakeEditors`), and types into it
 * with `type`: the form sees exactly what it would see from the real editor, a change and its text.
 */
import type { AnchorDraw, EditorHandle } from './milkdown';

export interface FakeEditor {
  /** What the editor opened with. */
  initial: string;
  /** What it holds now. */
  text: () => string;
  /** The editor was destroyed (its form closed, or a refetch made another in its place). */
  destroyed: boolean;
  /** Replace the document, as typing would. A held document takes nothing. */
  type: (next: string) => void;
  /** Replace it as an input method or a paste can, held or not. */
  force: (next: string) => void;
  /** The document is held still (a final save is running). */
  locked: () => boolean;
  /** The amended spans last drawn on it, null when none. */
  anchors: () => AnchorDraw | null;
}

export const fakeEditors: FakeEditor[] = [];

export const fakeMilkdown = {
  createEditor: (
    _root: HTMLElement,
    value: string,
    onUpdate: () => void,
  ): Promise<EditorHandle> => {
    let text = value;
    let changed = false;
    let drawn: AnchorDraw | null = null;
    let locked = false;
    const entry: FakeEditor = {
      anchors: () => drawn,
      locked: () => locked,
      initial: value,
      destroyed: false,
      text: () => text,
      type: (next) => {
        if (locked) return;
        text = next;
        changed = true;
        onUpdate();
      },
      force: (next) => {
        text = next;
        changed = true;
        onUpdate();
      },
    };
    fakeEditors.push(entry);
    return Promise.resolve({
      markdown: () => text,
      changed: () => changed,
      initialMarkdown: value,
      run: () => undefined,
      status: () => ({
        block: 'paragraph',
        bold: false,
        italic: false,
        code: false,
        link: false,
        inTable: false,
        language: null,
      }),
      focus: () => undefined,
      setEditable: (editable) => {
        locked = !editable;
      },
      setAnchors: (map) => {
        drawn = map;
        return map !== null;
      },
      destroy: () => {
        entry.destroyed = true;
        return Promise.resolve();
      },
    });
  },
};

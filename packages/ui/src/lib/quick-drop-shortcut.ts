import { useEffect } from 'react';

/**
 * ⌘K / Ctrl+K, wherever you are.
 *
 * Deliberately ignored while the caret is in a text field: the shortcut must
 * never eat a keystroke somebody is already using to write something down,
 * which would be exactly the wrong failure for this application to have.
 */
export function useQuickDropShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      event.preventDefault();
      onOpen();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onOpen]);
}

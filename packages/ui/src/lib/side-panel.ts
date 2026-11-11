import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether a side panel is open beside the page (the architecture radar's Propose ADR, boundary and
 * contract panels). The shell reads it to furl its sidebar to the glyph rail while one is open on
 * a narrow desktop, so the panel and the thing it edits both fit. A count, not a flag: a panel
 * that closes as another opens must not leave the sidebar furled or unfurled by mistake.
 * Never written to the saved sidebar preference: it is a state of the screen, not a choice.
 */
let open = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Register an open panel for as long as `active`. */
export function useRegisterSidePanel(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    open += 1;
    emit();
    return () => {
      open -= 1;
      emit();
    };
  }, [active]);
}

export function useSidePanelOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open > 0,
    () => false,
  );
}

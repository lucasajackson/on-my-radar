/** Layer-aware background isolation for portaled dialogs, including nested confirmations. */
const layers: Array<{ panel: HTMLElement; depth: number }> = [];
const previous = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();

export function isTopModal(panel: HTMLElement): boolean {
  return (
    layers.reduce<(typeof layers)[number] | undefined>(
      (top, layer) => (!top || layer.depth >= top.depth ? layer : top),
      undefined,
    )?.panel === panel
  );
}

function syncIsolation() {
  for (const [element, state] of previous) {
    element.inert = state.inert;
    if (state.hidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', state.hidden);
  }
  previous.clear();
  const active = layers.find((layer) => isTopModal(layer.panel));
  if (!active) return;
  for (const element of Array.from(document.body.children)) {
    if (
      !(element instanceof HTMLElement) ||
      element.contains(active.panel) ||
      element.matches('[data-live-announcements]')
    )
      continue;
    previous.set(element, { inert: element.inert, hidden: element.getAttribute('aria-hidden') });
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
}

export function isolateModal(panel: HTMLElement, depth: number): () => void {
  const layer = { panel, depth };
  layers.push(layer);
  syncIsolation();
  return () => {
    const index = layers.indexOf(layer);
    if (index !== -1) layers.splice(index, 1);
    syncIsolation();
  };
}

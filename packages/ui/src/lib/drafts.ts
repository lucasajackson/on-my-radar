/**
 * Unsent capture text, kept per composer until it is sent.
 *
 * Capture has to be cheaper than the thought, and losing a half-written thought
 * to an Escape or a click on the sidebar makes it the most expensive thing on
 * the page. Each composer keeps its text under a key (`radar:<id>`,
 * `quick-drop`) here: restored when the composer comes back, cleared when the
 * blip is sent.
 *
 * `sessionStorage` when the browser allows it, which survives a reload and a
 * navigation within the tab and goes when the tab does — the right lifetime for
 * a draft that has not been saved anywhere. Memory otherwise (a private window,
 * blocked storage), which survives navigation but not a reload; `draftsPersist()`
 * says which, so a composer can warn before a draft is lost for good.
 */
import { useCallback, useState } from 'react';

const PREFIX = 'omr:draft:';
/** Every key the charter editor keeps starts with this: `charter-draft:<user>:<radar>`, `charter-mine:…`. */
export const CHARTER_DRAFTS = 'charter-';
const memory = new Map<string, string>();

let probed: { store: Storage | null } | undefined;

/** Probed once per page: whether storage is usable does not change while typing. */
function storage(): Storage | null {
  if (probed) return probed.store;
  try {
    const store = window.sessionStorage;
    const probe = `${PREFIX}probe`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    probed = { store };
  } catch {
    probed = { store: null };
  }
  return probed.store;
}

export function readDraft(key: string): string {
  const store = storage();
  try {
    return store?.getItem(PREFIX + key) ?? memory.get(key) ?? '';
  } catch {
    return memory.get(key) ?? '';
  }
}

export function writeDraft(key: string, value: string): void {
  memory.set(key, value);
  if (!value) memory.delete(key);
  const store = storage();
  try {
    if (value) store?.setItem(PREFIX + key, value);
    else store?.removeItem(PREFIX + key);
  } catch {
    // Quota or a revoked permission: memory still holds it for this session.
  }
}

/**
 * Drop every draft whose key starts with `prefix`: what a browser keeps for one person is not
 * for the next (sign-out, a different account).
 */
export function forgetDrafts(prefix: string): void {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  const store = storage();
  try {
    if (!store) return;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX + prefix)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Revoked storage: nothing was kept there to forget.
  }
}

/** Whether a draft outlives a reload here, or only a navigation. */
export function draftsPersist(): boolean {
  return storage() !== null;
}

/**
 * A composer's text, drafted under `key`. `null` keeps it in component state
 * only, for a composer that has nowhere to be restored to yet.
 */
export function useDraft(key: string | null): [string, (value: string) => void] {
  const [value, setValue] = useState(() => (key ? readDraft(key) : ''));
  const [boundTo, setBoundTo] = useState(key);
  // A composer reused for another radar picks up that radar's draft, in render
  // rather than an effect, so the old text never flashes under the new radar.
  if (boundTo !== key) {
    setBoundTo(key);
    setValue(key ? readDraft(key) : '');
  }
  const set = useCallback(
    (next: string) => {
      setValue(next);
      if (key) writeDraft(key, next);
    },
    [key],
  );
  return [value, set];
}

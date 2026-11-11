import { useSyncExternalStore } from 'react';
import { relativeTime } from '../lib/format';

/**
 * "4m" that keeps counting. `relativeTime` is computed at render, and a card that nothing
 * re-renders said "now" until the next reload. Every instance shares one timer (started by the
 * first, stopped with the last), so a hundred timestamps cost one wake-up a minute. The timer
 * is cleared while the tab is hidden and restarts, with an immediate tick, when it is shown.
 */
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const visible = () => document.visibilityState === 'visible';

function bump() {
  tick += 1;
  listeners.forEach((l) => l());
}

function sync() {
  const wanted = listeners.size > 0 && visible();
  if (wanted && timer === undefined) timer = setInterval(bump, 60_000);
  else if (!wanted && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function onVisibility() {
  if (visible()) bump();
  sync();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) document.addEventListener('visibilitychange', onVisibility);
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener('visibilitychange', onVisibility);
    sync();
  };
}

export function RelativeTime({ iso }: { iso: string }) {
  useSyncExternalStore(subscribe, () => tick);
  return <>{relativeTime(iso)}</>;
}

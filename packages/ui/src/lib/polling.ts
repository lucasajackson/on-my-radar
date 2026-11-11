import { useSyncExternalStore } from 'react';

/**
 * Live-ish views without a push channel: every refresh is the ordinary authorized API call.
 *
 * `refetchInterval` is false while the document is hidden, so TanStack clears its timer
 * rather than keeping one that fires and does nothing; it is re-evaluated on the render the
 * visibility change causes. `refetchOnWindowFocus` catches up the moment the tab comes
 * back, and `staleTime` must not exceed the interval or that catch-up would find the data
 * still fresh. `poll: false` is the same query without the interval: a list of many threads
 * refetches on focus only, and the list above it carries new ones.
 */
export const LIVE_POLL_MS = 15_000;

function onVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

export function useLivePoll(poll = true) {
  const visible = useSyncExternalStore(
    onVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
  return {
    refetchInterval: poll && visible ? LIVE_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  } as const;
}

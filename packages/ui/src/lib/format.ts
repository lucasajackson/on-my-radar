/** Small display helpers. The instrument voice is terse on purpose. */

const UNITS: Array<[limit: number, divisor: number, suffix: string]> = [
  [60_000, 1000, 's'],
  [3_600_000, 60_000, 'm'],
  [86_400_000, 3_600_000, 'h'],
  [2_592_000_000, 86_400_000, 'd'],
];

/** "just now", "4m", "3h", "12d", then a date. Compact enough for a mono meta row. */
export function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (elapsed < 45_000) return 'now';
  for (const [limit, divisor, suffix] of UNITS) {
    // Floored, not rounded: rounding turned 59.6 seconds into "60s" and 23h40m
    // into "24h" — a unit's own upper bound, which the next unit exists to say.
    if (elapsed < limit) return `${Math.floor(elapsed / divisor)}${suffix}`;
  }
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A link's host, without the `www.`, for a compact source line. The URL itself if it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

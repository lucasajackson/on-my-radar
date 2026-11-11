/**
 * The charter's history, in the words a reader sees (plan e715ea20, U3). Pure: what a version row
 * says, how a stamp reads, and where a diff's changes sit in the document that is drawn.
 */
import type { CharterDiffDto, CharterVersionDto } from '@onmyradar/contract';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "30 Oct, 2:14pm": the day and the clock, the way the banner names a version. */
export function stampOf(iso: string): string {
  const at = new Date(iso);
  const hours = at.getHours();
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? ''}, ${hours % 12 === 0 ? 12 : hours % 12}:${minutes}${hours < 12 ? 'am' : 'pm'}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the stamp. */
export function agoOf(iso: string, now = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < 45_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} d ago`;
  return stampOf(iso);
}

const ADR_LANE: Record<string, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  repealed: 'Repealed',
};

/**
 * Why a version exists, as a row says it: "Accepted ADR-0027", "Edited", "Restored from v3",
 * "Migrated". The lane is the one the ADR was in when the version was sealed (`lane`), not the one
 * it is in now.
 */
export function whyOf(version: CharterVersionDto): string {
  const { subject } = version;
  switch (version.cause) {
    case 'adr':
      return subject
        ? `${ADR_LANE[version.lane ?? ''] ?? 'Changed'} ${subject.label}`
        : 'ADR decided';
    case 'anchor':
      if (!subject) return 'Anchor changed';
      return subject.lane === 'boundary' || subject.lane === 'contract'
        ? `Linked ${subject.label}`
        : `Re-anchored ${subject.label}`;
    case 'restore':
      return version.restoredFrom ? `Restored from v${version.restoredFrom}` : 'Restored';
    case 'migration':
      return 'Migrated';
    default:
      return 'Edited';
  }
}

/**
 * "Ada", or "Scout" for an agent (its person is `onBehalfOf`). The version the migration seeded
 * has no author; it is the migration's.
 */
export function whoOf(version: CharterVersionDto): string {
  if (version.by.name) return version.by.name;
  if (version.cause === 'migration') return 'Migration';
  return version.by.kind === 'agent' ? 'an agent' : 'someone';
}

/** One change of a diff, placed in the newer document. */
export interface Change {
  /** 0-based, in document order. */
  index: number;
  /** The words only the older version has (cut at 400 characters), or null. */
  struck: string | null;
  /** The words only the newer one has, as offsets into its projection, or null. */
  inserted: { start: number; end: number; text: string } | null;
  /** Where the struck words belong in the newer text: its offset. */
  at: number;
  section: string[] | null;
}

/**
 * The changes of a diff with their place in the newer text. A hunk gives the older text's range
 * for a deletion and the newer text's for an insertion, so the place of one in the other's
 * coordinates is found by walking the hunks: between two hunks the texts are equal, and the offset
 * between them is the same all along it.
 */
export function changesOf(diff: CharterDiffDto): Change[] {
  let prevA = 0;
  let prevB = 0;
  return diff.hunks.map((hunk, index) => {
    const aStart = hunk.struck
      ? hunk.struck.start
      : prevA + ((hunk.inserted?.start ?? prevB) - prevB);
    const bStart = hunk.inserted ? hunk.inserted.start : prevB + (aStart - prevA);
    prevA = hunk.struck ? hunk.struck.end : aStart;
    prevB = hunk.inserted ? hunk.inserted.end : bStart;
    return {
      index,
      struck: hunk.struck ? hunk.struck.text : null,
      inserted: hunk.inserted,
      at: bStart,
      section: hunk.section,
    };
  });
}

/**
 * Whether the document drawn is the text the diff was made on: every inserted passage that was
 * not cut for the answer is found at its offsets. A document that changed since (somebody saved
 * between the two reads) fails, and nothing is drawn on the wrong words.
 */
export function changesFit(changes: readonly Change[], text: string): boolean {
  return changes.every(
    ({ inserted }) =>
      inserted === null ||
      inserted.text.endsWith('…') ||
      text.slice(inserted.start, inserted.end) === inserted.text,
  );
}

/** "3 changes", "1 change", "No changes". */
export function countOf(total: number): string {
  return total === 0 ? 'No changes' : `${total} ${total === 1 ? 'change' : 'changes'}`;
}

/** The note above a diff that lists fewer changes than it found, or one that is not word-exact. */
export function limitNote(diff: CharterDiffDto): string | null {
  if (diff.truncated)
    return `Showing the first ${diff.hunks.length} of ${diff.stats.hunks} changes.`;
  if (!diff.exact) return 'Some stretches are shown as wholly replaced.';
  return null;
}

/** A version as the URL names it. */
export function versionParams(version: number, anchorId?: string | null): string {
  const params = new URLSearchParams({ version: String(version) });
  if (anchorId) params.set('anchor', anchorId);
  return params.toString();
}

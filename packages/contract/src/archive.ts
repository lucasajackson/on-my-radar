/**
 * Blip archiving — when finished work stops being loaded, and how it comes back.
 *
 * ## The problem this exists for
 *
 * A sprint board never accumulates because time does the cleaning: the sprint
 * ends, the board is torn down, Done is wiped. Kanban drops that boundary, so
 * **Done grows forever by construction.** `templateConfig.collapseDone` was the
 * previous answer and it is a display fix for a data problem — thirty stale
 * cards occupy 44px instead of a column, but they are still there, still
 * counted, and still loaded.
 *
 * ## One axis, and it is derived
 *
 * A blip is live or archived. There is no third state beside `state` and
 * `status`, and archiving **never writes either of them** — which is what makes
 * the answer to "where does a resurrected card go" trivially *the lane it was
 * already in*, because it never left.
 *
 * Archived-ness is **computed, never stored**. There is no `blips.archived_at`
 * column, no sweep, and no background job. A row is archived when
 *
 *   - its `state` is one of {@link ARCHIVABLE_STATES}, and
 *   - its radar's template declares `archives`, and
 *   - its radar's window is on, and
 *   - nothing has happened to it for that many days.
 *
 * This is the third time this application has made that choice and the reasoning
 * has not changed: `blips.search` is GENERATED rather than trigger-maintained,
 * `lastActivityAt` is a subquery rather than a column, and the topic cascade is
 * read at authorization time rather than written into `radar_members`. **A
 * derived value that is computed cannot drift from its source.**
 *
 * The payoff here is specific and large. "Activity resurrects" — commenting on,
 * editing or moving an archived blip brings it back — is not an event handler
 * that three write paths have to remember to call. It is a consequence of the
 * definition: the clock *is* the activity, so the moment anything touches the
 * row it is inside the window again. A stored flag would need maintaining on
 * comment insert **and** comment delete **and** edit **and** lane move **and**
 * radar move, and the first path that forgot would leave a blip invisible with
 * nothing to say why.
 *
 * ## What it costs, stated plainly
 *
 * The boundary moves with the wall clock, so a blip can cross it between two
 * pages of the same scroll and not be shown on either. That is the same class of
 * mutability the `discussion` order already admits, and much rarer: the boundary
 * is thirty days wide, not one reply. No *live* row can be duplicated or skipped
 * — the keyset is unchanged, and removing rows from a result set moves nothing.
 */
import type { BlipState } from './domain.js';

/**
 * The only states a window may apply to. Work that is not finished never ages
 * out, however long it has sat there — a stale Backlog is a fact about you, and
 * hiding it would be the app taking a view.
 */
export const ARCHIVABLE_STATES = ['done', 'dropped'] as const satisfies readonly BlipState[];

/**
 * One number, not one per template.
 *
 * A per-template default would be a second dial with nothing behind it: the only
 * two templates that archive at all are the board and the reading list, and
 * there is no argument that a finished card should age out at a different rate
 * from a finished article. Two constants where one will do is a number that has
 * to be justified twice and reconciled the first time they disagree. The
 * per-radar override is where the variation actually lives, because that is
 * where the person with an opinion is.
 *
 * If a template ever genuinely needs its own, `archives: true` becomes
 * `archives: { after: n }` and this stays the fallback. Shipping that dial before
 * there is a second value to put in it is decoration.
 */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

/** A stored window of zero means never — an explicit choice, not an absence. */
export const ARCHIVE_NEVER = 0;

/** Ten years. Wide enough to mean "effectively never" without meaning "overflow". */
export const MAX_ARCHIVE_AFTER_DAYS = 3650;

/** What the settings control offers. `0` renders as "Never". */
export const ARCHIVE_WINDOW_CHOICES: readonly number[] = [
  ARCHIVE_NEVER,
  7,
  14,
  30,
  60,
  90,
  180,
  365,
];

/** True when this blip's triage state puts it in reach of a window. */
/** `string`: a stored state, which a newer build may have written. */
export function isArchivableState(state: string): boolean {
  return (ARCHIVABLE_STATES as readonly string[]).includes(state);
}

/**
 * The window that actually applies, in days. `0` means nothing here ever ages
 * out — which is the answer for every template that has not opted in, whatever
 * number happens to be stored on the radar.
 *
 * `archives` is asked of the caller rather than looked up here so this file
 * stays free of the template registry and the registry stays free of this one.
 */
export function archiveWindow(archives: boolean, stored: number | null | undefined): number {
  if (!archives) return ARCHIVE_NEVER;
  const days = stored ?? DEFAULT_ARCHIVE_AFTER_DAYS;
  if (!Number.isFinite(days) || days <= 0) return ARCHIVE_NEVER;
  return Math.min(Math.trunc(days), MAX_ARCHIVE_AFTER_DAYS);
}

/**
 * The instant a blip becomes archived, or null when it never will on current
 * facts. **May be in the future** — this is the moment, not the verdict.
 *
 * `clock` is the last thing that happened to the row: the later of its own
 * `updatedAt` (which every edit and every lane move bumps) and its
 * `lastActivityAt` (which is its newest comment). That pair is exactly the three
 * resurrection triggers, which is not a coincidence — it is the definition.
 */
export function archiveMoment(input: {
  /** A stored state, which a newer build may have written. */
  state: string;
  windowDays: number;
  updatedAt: Date;
  lastActivityAt?: Date | null;
}): Date | null {
  if (input.windowDays <= 0) return null;
  if (!isArchivableState(input.state)) return null;
  const activity = input.lastActivityAt ?? null;
  const from =
    activity && activity.getTime() > input.updatedAt.getTime() ? activity : input.updatedAt;
  return new Date(from.getTime() + input.windowDays * 24 * 60 * 60 * 1000);
}

/**
 * `archivedAt` as it appears on the wire: the moment it aged out, or null when
 * it has not. The DTO reads exactly as a stored column would, which is the whole
 * point — the storage decision is ours, the contract is theirs.
 */
export function archivedAtOf(
  input: Parameters<typeof archiveMoment>[0],
  now: Date = new Date(),
): string | null {
  const moment = archiveMoment(input);
  if (!moment || moment.getTime() > now.getTime()) return null;
  return moment.toISOString();
}

/** How the window reads in a sentence. Used by the settings control and its hint. */
export function archiveWindowLabel(days: number): string {
  if (days <= 0) return 'Never';
  if (days === 365) return 'After a year';
  if (days % 30 === 0 && days >= 60) return `After ${days / 30} months`;
  if (days % 7 === 0 && days < 30) return `After ${days / 7} week${days === 7 ? '' : 's'}`;
  return `After ${days} days`;
}

/**
 * The search that shows one radar's archive — what the lane header's count links
 * to, and the reason there is no bespoke archive screen.
 *
 * **The radar's id, not its name.** `in:` resolves an exact id first and only
 * then falls back to name matching, and that fallback returns *every* substring
 * match — `in:"Design"` means both "Design notes" and "Design system". A header
 * that says 34 and links to a page showing 51 is worse than no link. The search
 * page renders the resolved filter with the radar's name beside it, so nothing
 * about the id is left for the reader to decode.
 *
 * Not lane-scoped, and it cannot be: `status:` is deliberately absent from the
 * grammar because a lane id means nothing outside its own template.
 */
export function archiveSearchFor(radarId: string): string {
  return `in:${radarId} is:archived`;
}

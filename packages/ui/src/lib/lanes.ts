/**
 * A lane set being edited on the settings page.
 *
 * The rules a lane set must satisfy are not restated here: the editor runs the
 * contract's `validateLanes`, the same function the server runs, and shows its
 * problems verbatim. What lives here is only what a form needs and an agent
 * does not — ids for lanes somebody has named but never saved.
 */
import { LANE_LIMITS, type BlipState, type BlipStatusDef } from '@onmyradar/contract';
import { slugDraft } from './slug';

export interface LaneDraft {
  /** React key, stable across reorders and renames. */
  readonly key: string;
  /**
   * The stored id, or null for a lane added in this draft. A saved lane keeps
   * its id through any rename — the id is what blips are filed under, and a
   * rename that minted a new one would strand every blip in the lane.
   */
  readonly id: string | null;
  readonly label: string;
  readonly state: BlipState;
  readonly terminal: boolean;
}

export function draftFromLanes(lanes: readonly BlipStatusDef[]): LaneDraft[] {
  return lanes.map((lane) => ({
    key: `saved:${lane.id}`,
    id: lane.id,
    label: lane.label,
    state: lane.state,
    terminal: lane.terminal ?? false,
  }));
}

/**
 * What would be sent. A new lane's id comes from its label, made unique
 * against every other lane in the set, so nobody is asked to invent a slug.
 */
export function lanesFromDraft(rows: readonly LaneDraft[]): BlipStatusDef[] {
  const taken = new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
  return rows.map((row) => {
    const id = row.id ?? mintId(row.label, taken);
    taken.add(id);
    return {
      id,
      label: row.label.trim(),
      state: row.state,
      ...(row.terminal ? { terminal: true } : {}),
    };
  });
}

function mintId(label: string, taken: ReadonlySet<string>): string {
  const max = LANE_LIMITS.idMaxLength;
  const base = slugDraft(label, max).replace(/-+$/, '') || 'lane';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

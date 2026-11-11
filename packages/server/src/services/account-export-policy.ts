import type { Actor } from '../http.js';
import { forbidden } from '../http.js';

/** Service-level guard: a future route or indirect caller cannot substitute a
 * requested account ID or widen an agent's granted export access. */
export function accountExportOwnerId(actor: Actor | null): string {
  if (
    actor?.kind !== 'user' ||
    !actor.sessionId ||
    actor.agent ||
    actor.connection ||
    actor.user.state !== 'active'
  ) {
    throw forbidden('Account downloads require your active signed-in human session.');
  }
  return actor.user.id;
}

/** A collector supplies a reviewed, static field policy for each table.
 * Every returned field must be classified, including fields intentionally
 * omitted from the export. New schema fields therefore fail closed. */
export function projectAccountExportRow(
  row: Record<string, unknown>,
  included: readonly string[],
  excluded: readonly string[],
): Record<string, unknown> {
  const keep = new Set(included);
  const omit = new Set(excluded);
  if (
    keep.size !== included.length ||
    omit.size !== excluded.length ||
    included.some((key) => omit.has(key))
  )
    throw new Error('Ambiguous export field policy');
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!keep.has(key) && !omit.has(key)) throw new Error('Unclassified account export field');
    if (keep.has(key)) result[key] = row[key];
  }
  for (const key of included) {
    if (!Object.hasOwn(row, key)) throw new Error('Missing account export field');
  }
  return result;
}

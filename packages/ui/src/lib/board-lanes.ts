/**
 * Which of a board's lanes are drawn open when the width cannot hold them all.
 *
 * Explicit furls are out first: those are a decision the budget may not
 * overturn. What is left competes for `budget` open slots. A lane somebody
 * opened from its rail comes first, most recent first; then lanes with cards in
 * them, working before finished; then the empty ones, working before finished.
 * `order` breaks ties. At least one lane is always open.
 *
 * Railing by template order alone narrowed a lane holding the only cards on the
 * board while two empty lanes beside it stayed open.
 */
export function openLanes({
  lanes,
  order,
  furled,
  wanted,
  counts,
  budget,
}: {
  lanes: ReadonlyArray<{ id: string; terminal?: boolean }>;
  order: readonly string[];
  furled: ReadonlySet<string>;
  wanted: readonly string[];
  counts: (laneId: string) => number;
  budget: number;
}): Set<string> {
  const rank = (id: string) => {
    const at = wanted.indexOf(id);
    if (at >= 0) return at - wanted.length;
    const terminal = lanes.find((lane) => lane.id === id)?.terminal === true;
    return (terminal ? 2 : 0) + (counts(id) > 0 ? 0 : 1);
  };
  const contending = order
    .filter((id) => !furled.has(id))
    .sort((a, b) => rank(a) - rank(b) || order.indexOf(a) - order.indexOf(b));
  return new Set(contending.slice(0, Math.max(1, budget)));
}

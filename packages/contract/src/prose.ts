/**
 * "A, B or C" — a refusal sentence's list of the options that would have
 * worked. Three copies of this were written longhand, each reaching for the
 * last item by index. Internal to the contract; not re-exported.
 */
export function listWithOr(items: readonly string[]): string {
  const last = items.at(-1);
  if (last === undefined) return '';
  return items.length === 1 ? last : `${items.slice(0, -1).join(', ')} or ${last}`;
}

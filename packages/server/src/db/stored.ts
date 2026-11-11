/**
 * A column value as the database may actually hold it.
 *
 * jsonb columns are typed with `$type<T>()`, which is a promise about what this
 * build writes, not about what is there: a row written by an older or newer
 * build, or by hand, is not bound by it, and NOT NULL keeps out SQL null but not
 * a JSON null. Passing a value through here widens its type to admit that, so
 * the fallback written beside it is a guard the compiler agrees is needed
 * rather than one a lint rule would have deleted as impossible.
 */
export function asStored<T>(value: T): T | null | undefined {
  return value;
}

/**
 * The value, or a failure that says what was missing.
 *
 * For tests, in place of a non-null assertion. `x!` tells the compiler
 * something it cannot check and, when it is wrong, fails a line later with
 * "Cannot read properties of null" about a different expression. This fails
 * where the assumption was made, and says which one.
 */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}, found none`);
  return value;
}

/**
 * Set a field's value the way typing does, so React's value tracker sees a
 * change and fires onChange. Assigning `.value` directly is swallowed; the
 * prototype's own setter is the one React does not intercept.
 */
export function setNativeValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Reflect.set(prototype, 'value', value, field);
}

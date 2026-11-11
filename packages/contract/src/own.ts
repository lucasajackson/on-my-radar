/**
 * Registry lookups by a key that came from outside: a request, a stored
 * column, a search box.
 *
 * Every registry here is a plain object literal, so it inherits from
 * `Object.prototype`, and both `key in REGISTRY` and `REGISTRY[key]` see
 * `constructor`, `toString`, `__proto__` and the rest. That made
 * `isRadarTemplate('constructor')` true, parsed `has:constructor` into a filter
 * whose value was `function Object() { [native code] }`, and made
 * `harnessConfigSchema` throw a TypeError on `{ constructor: {} }` instead of
 * refusing it. Own properties only.
 *
 * Deliberately not re-exported from the package index: it is how the contract
 * reads its own registries, not vocabulary.
 */
export function isOwnKey<K extends string>(
  record: Readonly<Record<K, unknown>>,
  key: unknown,
): key is K {
  return typeof key === 'string' && Object.hasOwn(record, key);
}

export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

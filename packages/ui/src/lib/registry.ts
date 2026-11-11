/**
 * A registry entry by a key that came from the server.
 *
 * The registries (glyphs, accents, surfaces, templates, blip and notification
 * kinds) are total over the keys this build knows, so indexing one says the
 * result always exists. A key the server sent can be newer than the build — a
 * glyph added last week, a notification kind this tab predates — and then it
 * does not. This asks the question honestly: `undefined` for a key the build
 * has never heard of, so the caller's fallback is a real branch rather than a
 * cast that promised the key was known.
 */
export function entry<V>(registry: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(registry, key) ? registry[key] : undefined;
}

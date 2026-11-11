/**
 * Whether the person has asked for no motion.
 *
 * Read at the moment it matters rather than held in state, because it is
 * consulted inside pointer handlers and route effects where a stale value would
 * animate something the person has said not to animate. `matchMedia` is cheap
 * and the answer changes about once a year.
 *
 * The rule this file serves is that reduced motion means **no** motion, not a
 * shorter one. Every caller uses it to skip the animation entirely — no
 * transform, no duration — and the stylesheet carries the same rule for
 * everything that is purely CSS. A 1ms transition is still a transition, and
 * the setting exists for people for whom that is not a distinction.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

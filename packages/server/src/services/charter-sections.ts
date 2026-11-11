/**
 * The charter's sections, for `read_architecture`'s `outline` and `sections`.
 *
 * A section is a heading and everything up to the next heading of the same or a higher level (its
 * own subsections included), so asking for "## Operations" returns its "### Runbooks" too. A
 * heading's slug is its text lower-cased with punctuation dropped and spaces made hyphens (what a
 * reader would guess), numbered `-1`, `-2` when the same heading recurs. Pure; code fences hide
 * their `#` lines.
 */
export interface Section {
  slug: string;
  level: number;
  heading: string;
  /** The heading line through the line before the next heading of the same or a higher level. */
  markdown: string;
}

export const slugOf = (heading: string): string =>
  heading
    .toLowerCase()
    // Inline markup and links are not part of what a reader types.
    .replace(/[`*_~]|\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

export function sectionsOf(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const found: Array<{ line: number; level: number; heading: string; slug: string }> = [];
  const seen = new Map<string, number>();
  let fence = false;
  lines.forEach((text, line) => {
    if (/^\s*```/.test(text)) fence = !fence;
    const match = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (!match) return;
    const heading = (match[2] ?? '').trim();
    const base = slugOf(heading) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.push({
      line,
      level: (match[1] ?? '').length,
      heading,
      slug: n === 0 ? base : `${base}-${n}`,
    });
  });
  return found.map((h, i) => {
    const next = found.slice(i + 1).find((x) => x.level <= h.level);
    const end = next ? next.line : lines.length;
    return {
      slug: h.slug,
      level: h.level,
      heading: h.heading,
      markdown: lines.slice(h.line, end).join('\n').replace(/\s+$/, ''),
    };
  });
}

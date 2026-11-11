// @vitest-environment jsdom
/**
 * The editor's one job: a prompt comes out meaning what it meant going in
 * (docs/AGENT_REPO.md §V2.4). Each fixture is parsed and serialized by the
 * editor exactly as "open, change nothing, save" would, and then:
 *
 * - it must **render to the same HTML** as the original — through markdown-it
 *   (CommonMark + GFM tables and strikethrough, the strict check) and through
 *   the app's own `lib/markdown` (what the read view shows);
 * - every fenced code block must survive **byte for byte**;
 * - a second round trip must write **exactly** what the first did (idempotent),
 *   so only the first save of a prompt can ever normalise it.
 *
 * An editor upgrade that starts losing content fails here, not in somebody's
 * prompt.
 */
import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { renderMarkdown } from './markdown';
import { roundTrip } from './milkdown';

const TORTURE = `# Heading

Intro with **bold**, _em_, \`code\`, a [link](https://example.com "t") and a line
break.

| Col A | Col \`B\` | Right |
| :---- | :-----: | ----: |
| a1 | **b1** | 3 |
| a\\|2 | | 4 |

\`\`\`ts
const x = \`template \${1}\`; // <b>not html</b>
if (a < b && c > d) {}
\`\`\`

\`\`\`
plain fence
\`\`\`

- item one
  - nested
- item two

1. first
2. second

> quote with \`code\`

- [ ] task
- [x] done

Text with <angle> brackets & ampersand, a #hashtag, @mention, and \\*escaped\\*.

---

Final paragraph ~~struck~~.
`;

/** Shapes real prompts have: rule lists, a gate block, a table of checks. */
const PROMPT_SHAPES = `## 1. What On My Radar is

A **blip** is anything you want out of your head. A **radar** is a container for blips on one topic.

## 2. How you work here

- Everything lands in the one service layer, so REST and MCP both get it.
- A refusal an agent can act on lives in the service, never in the tool router.
  - Nested detail with \`inline code\` and _emphasis_.
- Run the full gate before every commit.

### The gate

\`\`\`bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
\`\`\`

| Check | Why |
| --- | --- |
| migrate twice | the second run must be a no-op |
| phone suite | layouts at real widths |

1. Read \`docs/DESIGN.md\`.
2. Verify against a real Postgres.
3. Do not push without being asked.

> **Why:** a gate that cannot fail is decoration.
`;

const md = new MarkdownIt({ html: false, linkify: false });
const squash = (html: string) => html.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const fences = (source: string) =>
  [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);

describe.each([
  ['the torture fixture', TORTURE],
  ['prompt shapes', PROMPT_SHAPES],
])('the Milkdown round trip of %s', (_name, source) => {
  it('renders to the same HTML, keeps every fence, and is idempotent', async () => {
    const once = await roundTrip(source);
    const twice = await roundTrip(once);

    expect(squash(md.render(once))).toBe(squash(md.render(source)));
    expect(squash(renderMarkdown(once, { tagLinks: false }))).toBe(
      squash(renderMarkdown(source, { tagLinks: false })),
    );
    expect(fences(once)).toEqual(fences(source));
    expect(twice).toBe(once);
  });
});

describe('the fixture itself', () => {
  /*
    A vacuous-pass guard: if the fixture stopped containing the hard cases, the
    round-trip test above would still pass and prove nothing.
  */
  it('still exercises the hard cases', () => {
    const html = md.render(TORTURE);
    expect(html).toContain('<table>');
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain('a|2');
    expect(html).toContain('<s>struck</s>');
    expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;');
    expect(html).toContain('<blockquote>');
    expect(html).toMatch(/<ul>\s*<li>nested<\/li>/);
    expect(fences(TORTURE)).toHaveLength(2);
  });
});

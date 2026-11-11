// @vitest-environment jsdom
/**
 * Anchors against the real editor. A synthetic charter (four pages, over 90k
 * characters, shaped like an architecture radar's) goes through Milkdown the
 * way "open, change nothing, save" does:
 *
 * - the three ADR amendments that inline `:amend[...]` markers lost (the editor
 *   escapes `[` in table cells) are all still anchored by the resolver;
 * - the projection is what the editor shows: the text of every block in the
 *   ProseMirror document, in order, equals the projection's blocks, and a
 *   selection read from the editor (`textBetween`) is found by `resolveSelection`.
 *
 * The contract's own tests hold the resolver to its properties on generated
 * documents; this file is the check against the editor that will drive it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  normalizeText,
  parseMarkers,
  projectMarkdown,
  replaceMarkers,
  resolveAnchors,
  resolveSelection,
} from '@onmyradar/contract';
import { STRINGIFY_OPTIONS, roundTrip } from './milkdown';

// vitest runs in packages/ui; the fixtures are the contract package's.
const fixture = (k: number): string =>
  readFileSync(resolve(process.cwd(), `../contract/test/fixtures/acme-charter-${k}.md`), 'utf8');
const pages = [1, 2, 3, 4].map(fixture);
const written = pages.map((p) => replaceMarkers(p, (m) => m.quote)).join('\n\n');
const quotes = pages.flatMap((p) => parseMarkers(p).map((m) => m.quote));

async function openDoc(markdown: string): Promise<{ doc: ProseNode; close: () => Promise<void> }> {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, ...STRINGIFY_OPTIONS }));
    })
    .use(commonmark)
    .use(gfm)
    .create();
  return {
    doc: editor.action((ctx) => ctx.get(editorViewCtx).state.doc),
    close: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

/** Text blocks of a ProseMirror document the way the projection counts them: not code blocks, not empty. */
function blocksOfDoc(doc: ProseNode): Array<{ text: string; from: number; to: number }> {
  const out: Array<{ text: string; from: number; to: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') return false;
    if (!node.isTextblock) return true;
    const text = normalizeText(node.textBetween(0, node.content.size, '\n\n', ' '));
    if (text) out.push({ text, from: pos + 1, to: pos + 1 + node.content.size });
    return false;
  });
  return out;
}

describe('Acme charter through Milkdown', () => {
  it('a no-op save keeps all three live anchors (markers lost two of them)', async () => {
    // What the markers did: the editor rewrote them.
    let kept = 0;
    for (const page of pages)
      kept += ((await roundTrip(page)).match(/:amend\[[^\]]*\]\{adr=/g) ?? []).length;
    expect(kept).toBeLessThan(quotes.length);

    const before = projectMarkdown(written);
    const anchors = quotes.map((quote, n) => {
      const sel = resolveSelection(before, { quote });
      if (!sel.ok) throw new Error(`${quote}: ${sel.code}`);
      return {
        id: `a${n}`,
        state: 'anchored' as const,
        selector: sel.selector,
        start: sel.start,
        end: sel.end,
      };
    });
    expect(anchors).toHaveLength(3);

    // Open and save as it is, and again after squeezing every table and swapping list markers,
    // which the editor then writes back padded and normalised: a lot of churn, no change of words.
    const squeezed = written
      .split('\n')
      .map((line) =>
        line.startsWith('|')
          ? line.replace(/ {2,}/g, ' ').replace(/-{4,}/g, '---')
          : line.replace(/^(\s*)- /, '$1* '),
      )
      .join('\n');
    for (const source of [written, squeezed]) {
      const saved = await roundTrip(source);
      const rewritten = source.split('\n').filter((l) => !new Set(saved.split('\n')).has(l)).length;
      if (source === squeezed) expect(rewritten).toBeGreaterThan(100);
      const after = projectMarkdown(saved);
      const result = resolveAnchors(before, after, anchors);
      expect(result.anchors.map((a) => a.outcome)).toEqual(['kept', 'kept', 'kept']);
      result.anchors.forEach((a, n) =>
        expect(after.text.slice(a.start ?? 0, a.end ?? 0)).toBe(quotes[n]),
      );
      // the editor's churn is invisible to the projection
      expect(after.text).toBe(before.text);
    }
  }, 180_000);

  it('the projection is the text of the editor: same blocks, same words', async () => {
    const { doc, close } = await openDoc(written);
    try {
      const p = projectMarkdown(written);
      const fromDoc = blocksOfDoc(doc).map((b) => b.text);
      const fromProjection = p.blocks.map((b) => p.text.slice(b.start, b.end));
      expect(fromProjection.length).toBeGreaterThan(500);
      expect(fromDoc).toEqual(fromProjection);
    } finally {
      await close();
    }
  }, 180_000);

  it('what a reader selects in the editor is found by the resolver', async () => {
    const { doc, close } = await openDoc(written);
    try {
      const p = projectMarkdown(written);
      const blocks = blocksOfDoc(doc);
      let tried = 0;
      for (let i = 0; i + 1 < blocks.length; i += 37) {
        const [a, b] = blocks.slice(i, i + 2);
        if (!a || !b) throw new Error('block pair');
        // a quote inside one block, and one that crosses the block boundary
        const inside = doc.textBetween(a.from, a.to).slice(0, 48);
        const across = doc.textBetween(
          a.to - Math.min(12, a.to - a.from),
          b.from + Math.min(12, b.to - b.from),
          '\n\n',
        );
        for (const quote of [inside, across]) {
          if (!normalizeText(quote)) continue;
          tried++;
          const sel = resolveSelection(p, { quote });
          // a phrase that recurs in the charter is legitimately ambiguous without context
          if (!sel.ok) expect(sel.code).toBe('quote_ambiguous');
          else expect(p.text.slice(sel.start, sel.end)).toBe(normalizeText(quote));
        }
      }
      expect(tried).toBeGreaterThan(20);
    } finally {
      await close();
    }
  }, 180_000);
});

describe('line breaks in a selection', () => {
  // The fixtures' only <br> sit inside a fenced diagram, so this is where breaks meet the editor.
  // Milkdown's <br> is an inline node with no text of its own, so a reader's selection must be read with
  // textBetween(from, to, '\n\n', ' '): a leaf then counts as a space, which is what the projection says.
  const md =
    '| H1 | H2 |\n| - | - |\n| left<br>right | c |\n\nline one  \nline two and\\\nline three\n\nplain soft\nwrap here\n';

  it('a quote across a <br>, a hard break or a soft wrap resolves to the words', async () => {
    const { doc, close } = await openDoc(md);
    try {
      const p = projectMarkdown(md);
      const blocks = blocksOfDoc(doc);
      expect(blocks.map((b) => b.text)).toEqual(p.blocks.map((b) => p.text.slice(b.start, b.end)));
      for (const [needle, want] of [
        ['left', 'left right'],
        ['line one', 'line one line two and line three'],
        ['plain soft', 'plain soft wrap here'],
      ] as const) {
        const block = blocks.find((b) => b.text.startsWith(needle));
        if (!block) throw new Error(needle);
        const quote = doc.textBetween(block.from, block.to, '\n\n', ' ');
        const sel = resolveSelection(p, { quote });
        if (!sel.ok) throw new Error(`${needle}: ${sel.code}`);
        expect(p.text.slice(sel.start, sel.end)).toBe(want);
      }
    } finally {
      await close();
    }
  });
});

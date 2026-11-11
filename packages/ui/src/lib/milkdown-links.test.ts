// @vitest-environment jsdom
/**
 * Links in the real editor: a link may run across paragraphs, and each block it covers is drawn;
 * an ADR amendment stays within one block.
 */
import { describe, expect, it } from 'vitest';
import { createEditor } from './milkdown';

const TEXT = 'First paragraph here.\n\nSecond paragraph here.\n\nThird.';

async function drawn(spans: Parameters<Awaited<ReturnType<typeof createEditor>>['setAnchors']>[0]) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await createEditor(
    root,
    'First paragraph here.\n\nSecond paragraph here.\n\nThird.',
    () => undefined,
  );
  const ok = editor.setAnchors(spans);
  const out = {
    ok,
    links: Array.from(root.querySelectorAll('.charter-link')).map((e) => e.textContent),
    amends: Array.from(root.querySelectorAll('.charter-anchor')).map((e) => e.textContent),
  };
  await editor.destroy();
  root.remove();
  return out;
}

describe('link decorations in the editor', () => {
  it('draws a link that runs across paragraphs in each block it covers', async () => {
    // "paragraph here." of the first block, the whole second block, and "Thi" of the third.
    const start = TEXT.indexOf('paragraph');
    const end = TEXT.indexOf('rd.');
    const out = await drawn({
      text: TEXT,
      spans: [{ start, end, labels: [], link: { ids: ['a'], kind: 'boundary' } }],
    });
    expect(out.ok).toBe(true);
    expect(out.links).toEqual(['paragraph here.', 'Second paragraph here.', 'Thi']);
  });

  it('still draws only within one block for an amendment', async () => {
    const start = TEXT.indexOf('paragraph');
    const end = TEXT.indexOf('rd.');
    const out = await drawn({ text: TEXT, spans: [{ start, end, labels: ['ADR-1'] }] });
    expect(out.amends).toEqual([]);
    const inside = await drawn({
      text: TEXT,
      spans: [{ start, end: start + 9, labels: ['ADR-1'] }],
    });
    expect(inside.amends).toEqual(['paragraph']);
  });
});

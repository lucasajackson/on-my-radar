import { describe, expect, it } from 'vitest';
import { MAX_CELLS, lineDiff, withContext } from './diff';

describe('lineDiff', () => {
  it('survives a proposal as large as a prompt may be, and still reconstructs both sides', () => {
    // 128,000 characters of one-character lines on each side: 64k x 64k cells
    // uncapped, which is a RangeError or gigabytes.
    const before = Array.from({ length: 64_000 }, (_, i) => String(i % 10)).join('\n');
    const after = Array.from({ length: 64_000 }, (_, i) => String((i + 3) % 10)).join('\n');
    expect(64_000 * 64_000).toBeGreaterThan(MAX_CELLS);
    const lines = lineDiff(before, after);
    expect(
      lines
        .filter((l) => l.kind !== 'add')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(before);
    expect(
      lines
        .filter((l) => l.kind !== 'remove')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(after);
  });

  it('reports a changed paragraph as a removal and an addition, the rest unchanged', () => {
    const before = 'a\nb\nc\nd';
    const after = 'a\nB\nc\nd\ne';
    expect(lineDiff(before, after)).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'add', text: 'e' },
    ]);
  });

  it('reconstructs both sides exactly', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 7', 'line seven').replace('line 40\n', '');
    const diff = lineDiff(before, after);
    const side = (kinds: string[]) =>
      diff
        .filter((l) => kinds.includes(l.kind))
        .map((l) => l.text)
        .join('\n');
    expect(side(['same', 'remove'])).toBe(before);
    expect(side(['same', 'add'])).toBe(after);
  });

  it('collapses long unchanged runs to a gap', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const rows = withContext(lineDiff(before, before.replace('l15', 'changed')), 2);
    expect(rows[0]).toEqual({ kind: 'gap', count: 13 });
    expect(rows.filter((r) => r.kind === 'gap')).toHaveLength(2);
  });
});

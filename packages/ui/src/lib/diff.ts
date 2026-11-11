/**
 * A line diff for reviewing a prompt proposal. Longest common subsequence over
 * lines. The point is a readable review, not a patch format.
 *
 * The table is quadratic, and "prompts are thousands of lines at most" was a
 * hope rather than a limit: a prompt may be 128,000 characters, which is 64,000
 * one-character lines, and a proposal that size on both sides asked for four
 * billion cells — a RangeError, or gigabytes, on the screen whose job is to let
 * a person review what an agent proposed. So past `MAX_CELLS` the changed middle
 * is shown whole, removed then added: still true, and still reviewable.
 */
export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

/** 4M cells is 16 MB of Uint32 — comfortably inside any phone's budget. */
export const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the shared head and tail first: most proposals change a paragraph.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  if (rows * cols > MAX_CELLS) {
    return [
      ...a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text })),
      ...midA.map((text): DiffLine => ({ kind: 'remove', text })),
      ...midB.map((text): DiffLine => ({ kind: 'add', text })),
      ...a.slice(endA).map((text): DiffLine => ({ kind: 'same', text })),
    ];
  }
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  for (;;) {
    const left = midA[i];
    const right = midB[j];
    if (left === undefined || right === undefined) break;
    if (left === right) {
      out.push({ kind: 'same', text: left });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      out.push({ kind: 'remove', text: left });
      i += 1;
    } else {
      out.push({ kind: 'add', text: right });
      j += 1;
    }
  }
  for (const text of midA.slice(i)) out.push({ kind: 'remove', text });
  for (const text of midB.slice(j)) out.push({ kind: 'add', text });
  for (const text of a.slice(endA)) out.push({ kind: 'same', text });
  return out;
}

/** Collapse long unchanged runs so a review shows what changed and a little context. */
export function withContext(
  lines: DiffLine[],
  context = 3,
): Array<DiffLine | { kind: 'gap'; count: number }> {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k += 1
    )
      keep.add(k);
  });
  const out: Array<DiffLine | { kind: 'gap'; count: number }> = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (gap) out.push({ kind: 'gap', count: gap });
      gap = 0;
      out.push(line);
    } else gap += 1;
  });
  if (gap) out.push({ kind: 'gap', count: gap });
  return out;
}

export type WordPart = { changed: boolean; text: string };

/**
 * The words that changed between a removed line and the added line that
 * replaced it — so a one-word edit to a long prompt line highlights the word,
 * not the whole line twice. Whitespace is kept as its own token so the parts
 * join back to exactly the original line. Past the same cell cap as
 * `lineDiff`, the whole line is marked changed.
 */
export function wordDiff(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const a = before.split(/(\s+)/).filter((token) => token !== '');
  const b = after.split(/(\s+)/).filter((token) => token !== '');
  const cols = b.length + 1;
  if ((a.length + 1) * cols > MAX_CELLS) {
    return { before: [{ changed: true, text: before }], after: [{ changed: true, text: after }] };
  }
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const left: WordPart[] = [];
  const right: WordPart[] = [];
  const push = (parts: WordPart[], changed: boolean, text: string) => {
    const last = parts.at(-1);
    if (last?.changed === changed) last.text += text;
    else parts.push({ changed, text });
  };
  let i = 0;
  let j = 0;
  for (;;) {
    const x = a[i];
    const y = b[j];
    if (x === undefined || y === undefined) break;
    if (x === y) {
      push(left, false, x);
      push(right, false, y);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      push(left, true, x);
      i += 1;
    } else {
      push(right, true, y);
      j += 1;
    }
  }
  for (const x of a.slice(i)) push(left, true, x);
  for (const y of b.slice(j)) push(right, true, y);
  return { before: left, after: right };
}

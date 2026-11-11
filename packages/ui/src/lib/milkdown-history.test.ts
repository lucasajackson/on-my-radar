// @vitest-environment jsdom
/**
 * The history viewer against the real editor: A synthetic charter (90k+ characters) is
 * opened read-only, its text is the server's projection, and a diff's changes are drawn on the
 * words they name: insertions marked where they are, struck words where they were.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diffText,
  projectMarkdown,
  replaceMarkers,
  type CharterDiffDto,
} from '@onmyradar/contract';
import { changesFit, changesOf } from './charter-history';
import { createViewer } from './milkdown-history';

const fixture = (k: number): string =>
  readFileSync(resolve(process.cwd(), `../contract/test/fixtures/acme-charter-${k}.md`), 'utf8');
const written = [1, 2, 3, 4].map((k) => replaceMarkers(fixture(k), (m) => m.quote)).join('\n\n');

/** The server's diff (services/charter-versions.ts), on two markdown texts. */
function diffOf(before: string, after: string): CharterDiffDto {
  const a = projectMarkdown(before).text;
  const b = projectMarkdown(after).text;
  const diff = diffText(a, b);
  const hunks: CharterDiffDto['hunks'] = [];
  let ai = 0;
  let bi = 0;
  const gap = (aTo: number, bTo: number) => {
    if (aTo <= ai && bTo <= bi) return;
    hunks.push({
      section: null,
      struck: aTo > ai ? { start: ai, end: aTo, text: a.slice(ai, aTo) } : null,
      inserted: bTo > bi ? { start: bi, end: bTo, text: b.slice(bi, bTo) } : null,
    });
  };
  for (const run of diff.runs) {
    gap(run.oldStart, run.newStart);
    ai = run.oldStart + run.length;
    bi = run.newStart + run.length;
  }
  gap(a.length, b.length);
  return {
    from: { version: 1 },
    to: { version: 'head' },
    identical: a === b,
    exact: diff.exact,
    truncated: false,
    stats: { hunks: hunks.length, struckChars: 0, insertedChars: 0 },
    hunks,
  };
}

describe('the history viewer', () => {
  it('opens the Acme charter read-only; its text is the projection, so offsets land on the words', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const viewer = await createViewer(root, written);
    try {
      expect(viewer.text()).toBe(projectMarkdown(written).text);
      expect(root.querySelector('[contenteditable="true"]')).toBeNull();
    } finally {
      await viewer.destroy();
      root.remove();
    }
  }, 180_000);

  it('draws a diff on the words it names: insertions where they are, struck words where they were', async () => {
    // Change a word, drop a sentence, add a paragraph, and take a whole block away.
    const before = written;
    let after = written
      .replace('The ', 'The very ')
      .replace(/\n\n## [^\n]+\n/, '\n\n## A new heading\n');
    after = `${after}\n\nA closing paragraph that only the newer text has.`;
    const diff = diffOf(before, after);
    expect(diff.hunks.length).toBeGreaterThan(1);
    const changes = changesOf(diff);
    const root = document.createElement('div');
    document.body.append(root);
    const viewer = await createViewer(root, after);
    try {
      expect(changesFit(changes, viewer.text())).toBe(true);
      viewer.setMarks({ changes, current: 0 });
      for (const change of changes) {
        if (change.inserted) {
          const drawn = Array.from(
            root.querySelectorAll(`.diff-ins[data-change="${change.index}"]`),
          )
            .map((el) => el.textContent)
            .join('');
          expect(drawn.replace(/\s+/g, '')).toBe(change.inserted.text.replace(/\s+/g, ''));
        }
        if (change.struck) {
          const del = root.querySelector(`del[data-change="${change.index}"]`);
          expect(del?.textContent.replace(/\s+/g, '')).toBe(
            change.struck.replaceAll('\n\n', ' ¶ ').replace(/\s+/g, ''),
          );
        }
      }
      expect(root.querySelectorAll('.is-current').length).toBeGreaterThan(0);
      // A document that is not the one the diff was made on is told apart.
      expect(changesFit(changes, `${viewer.text()} changed`.replace('The', 'Th'))).toBe(false);
    } finally {
      await viewer.destroy();
      root.remove();
    }
  }, 180_000);
  it('keeps struck words when the newer text has no prose left to place them by', async () => {
    // All the prose was deleted and only a code block is kept: the projection has no words.
    const before = '# Rules\n\nBilling owns the decision.\n\n```\nkeep()\n```\n';
    const after = '```\nkeep()\n```\n';
    const diff = diffOf(before, after);
    const changes = changesOf(diff);
    expect(changes.some((c) => c.struck !== null && c.inserted === null)).toBe(true);
    const root = document.createElement('div');
    document.body.append(root);
    const viewer = await createViewer(root, after);
    try {
      viewer.setMarks({ changes, current: 0 });
      const struck = [...root.querySelectorAll('del.diff-del')].map((el) => el.textContent);
      expect(struck.join(' ')).toContain('Billing owns the decision');
      // the first change is a place Next and Previous can go to
      expect(root.querySelector('del[data-change="0"]')).not.toBeNull();
    } finally {
      await viewer.destroy();
      root.remove();
    }
  }, 60_000);
});

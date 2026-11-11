import { describe, expect, it } from 'vitest';
import { memoryTokens, similarMemories } from './memory-similarity.js';

const held = [
  {
    name: 'codex-review-cap-2',
    revision: 3,
    description: 'Hard cap of 2 Codex review rounds per MR',
  },
  { name: 'postgres-constraint-traps', revision: 1, description: 'Traps with partial indexes' },
];

describe('similarMemories', () => {
  it('reads number words and plurals as the same token', () => {
    expect([...memoryTokens('Two Codex rounds')].sort()).toEqual(['2', 'codex', 'round']);
  });

  it('finds the existing memory when a lesson is filed again under another name', () => {
    for (const name of ['2-codex-rounds-cap', 'codex-two-review-cap', 'codex-review-cap']) {
      const hit = similarMemories({ name, description: '2 Codex rounds cap' }, held);
      expect(
        hit.map((m) => m.name),
        name,
      ).toEqual(['codex-review-cap-2']);
    }
  });

  it('leaves an unrelated memory alone', () => {
    const none = similarMemories(
      { name: 'ui-select-lint', description: 'No native select in packages/ui' },
      held,
    );
    expect(none).toEqual([]);
  });

  it('is empty when there is nothing to compare', () => {
    expect(similarMemories({ name: 'x', description: 'y' }, [])).toEqual([]);
  });
});

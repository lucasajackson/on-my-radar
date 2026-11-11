import { expect, it } from 'vitest';
import { reactionName } from './conversation';

it('says what a reaction is, how many, whether one is yours, and what pressing does', () => {
  expect(reactionName({ label: 'Thumbs up', count: 1, mine: true }, true)).toBe(
    'Thumbs up, 1 reaction, yours. Remove yours.',
  );
  expect(reactionName({ label: 'Thumbs up', count: 3, mine: true }, true)).toBe(
    'Thumbs up, 3 reactions including yours. Remove yours.',
  );
  expect(reactionName({ label: 'Heart', count: 2, mine: false }, true)).toBe(
    'Heart, 2 reactions. Add yours.',
  );
  // Read-only: no promise of an action that is not there.
  expect(reactionName({ label: 'Heart', count: 2, mine: false }, false)).toBe(
    'Heart, 2 reactions.',
  );
});

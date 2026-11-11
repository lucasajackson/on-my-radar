import { expect, it } from 'vitest';
import type { CommentDto } from '@onmyradar/contract';
import { replyHandle } from './conversation';
import type { MentionCandidate } from './mention-input';

const person = { id: 'u1', name: 'Lucas Jackson', email: 'lucas@example.com' };
const claude = { id: 'a1', name: 'Claude', handle: 'claude', retired: false };
const candidates: MentionCandidate[] = [
  { key: 'u1', name: 'Lucas Jackson', handle: 'lucas', handles: ['lucas'], actsFor: null },
  { key: 'a1', name: 'Claude', handle: 'lucas.claude', handles: ['claude'], actsFor: 'Lucas' },
];
const reply = (fields: Partial<CommentDto>) =>
  ({ author: person, agent: null, voice: null, ...fields }) as CommentDto;

it('answers a person by the handle they answer to, not by a name with a space in it', () => {
  // "@Lucas Jackson" stops at the space and resolves only by luck.
  expect(replyHandle(reply({}), candidates)).toBe('lucas');
});

it('answers an agent speaking in its own voice, by its unambiguous handle', () => {
  expect(replyHandle(reply({ agent: claude, voice: 'persona' }), candidates)).toBe('lucas.claude');
});

it('falls back to the address a person signs in with when the list does not know them', () => {
  expect(replyHandle(reply({}), [])).toBe('lucas');
});

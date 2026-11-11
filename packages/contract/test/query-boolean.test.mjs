/**
 * Query-string booleans. There used to be two parsers: the Agent Repo's strict
 * one, and `boolish`, which read every unrecognised word as false — so
 * `?unreadOnly=ture` silently listed everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSchema, listBlipsSchema, listNotificationsSchema } from '../dist/index.js';

test('the words a query string carries parse both ways', () => {
  for (const [input, expected] of [
    ['true', true],
    ['1', true],
    [true, true],
    ['false', false],
    ['0', false],
    [false, false],
  ]) {
    assert.equal(listNotificationsSchema.parse({ unreadOnly: input }).unreadOnly, expected, input);
    assert.equal(listBlipsSchema.parse({ includeArchived: input }).includeArchived, expected);
  }
});

test('anything else is refused rather than read as false', () => {
  for (const input of ['ture', 'yes', '', 'False ', 2]) {
    assert.equal(listNotificationsSchema.safeParse({ unreadOnly: input }).success, false, input);
    assert.equal(listBlipsSchema.safeParse({ includeArchived: input }).success, false, input);
  }
});

test('the Agent Repo reads the same way', () => {
  assert.equal(checkoutSchema.parse({ snapshot: 'false' }).snapshot, false);
  assert.equal(checkoutSchema.safeParse({ snapshot: 'yes please' }).success, false);
});

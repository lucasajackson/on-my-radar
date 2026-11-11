import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markNotificationsReadSchema } from '../dist/index.js';

const id = '00000000-0000-4000-8000-000000000001';

test('only named notifications can be marked unread again', () => {
  assert.equal(markNotificationsReadSchema.safeParse({ all: true, read: false }).success, false);
  assert.equal(markNotificationsReadSchema.safeParse({ radarId: id, read: false }).success, false);
  assert.equal(markNotificationsReadSchema.safeParse({ ids: [id], read: false }).success, true);
  assert.equal(markNotificationsReadSchema.safeParse({ all: true }).success, true);
  assert.equal(markNotificationsReadSchema.safeParse({ all: true, read: true }).success, true);
});

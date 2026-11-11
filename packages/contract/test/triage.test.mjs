/**
 * The triage rules the web and iOS share, pinned — the four the owner decided
 * when the two were unified (UI-CONTRACT §11, 2026-09-26). The iOS mirror
 * checks the same answers through the snapshot's triage vectors; this is the
 * contract's own statement of them. Runs against the built package, as the
 * snapshot test does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTarget, allowsTriageGesture, deferTarget } from '../dist/index.js';

const stream = { template: 'stream' };
const reading = { template: 'reading' };
const decisions = { template: 'decisions' };

test('1. a lane template moves between its lanes, in its own words', () => {
  const finish = advanceTarget(reading, { state: 'inbox', status: 'unread' });
  assert.equal(finish?.status, 'finished');
  assert.equal(finish?.state, undefined);
  assert.equal(finish?.label, 'Finished');
  assert.equal(finish?.acknowledgement, 'Moved to Finished');
});

test('2. reopening goes back to work, not to the inbox', () => {
  const reopened = advanceTarget(stream, { state: 'done' });
  assert.deepEqual(
    { state: reopened?.state, label: reopened?.label, reopens: reopened?.reopens },
    { state: 'active', label: 'Reopen', reopens: true },
  );
  // With lanes: the working lane (`active`), not the first one (`unread`).
  assert.equal(advanceTarget(reading, { state: 'done', status: 'finished' })?.status, 'reading');
  assert.equal(
    advanceTarget(reading, { state: 'done', status: 'finished' })?.label,
    'Back to Reading',
  );
  // A settled lane that is not marked terminal reopens too, rather than targeting itself.
  assert.equal(advanceTarget(decisions, { state: 'done', status: 'accepted' })?.status, 'proposed');
});

test('3. deferring is a gradient: Later, then Dropped; settled reopens', () => {
  assert.equal(deferTarget(stream, { state: 'inbox' })?.state, 'later');
  const drop = deferTarget(stream, { state: 'later' });
  assert.equal(drop?.state, 'dropped');
  assert.equal(drop?.label, 'Drop');
  assert.equal(drop?.reopens, false);
  assert.equal(deferTarget(stream, { state: 'dropped' })?.state, 'active');
  assert.equal(deferTarget(stream, { state: 'dropped' })?.reopens, true);
});

test('4. no gesture where a template has no triage to show', () => {
  assert.equal(allowsTriageGesture({ template: 'microblog' }), false);
  assert.equal(advanceTarget({ template: 'microblog' }, { state: 'inbox' }), null);
  assert.equal(allowsTriageGesture(stream), true);
  assert.equal(allowsTriageGesture(reading), true);
  // A board and a decision log keep their refusals.
  assert.equal(allowsTriageGesture({ template: 'kanban' }), false);
  assert.equal(allowsTriageGesture(decisions), false);
});

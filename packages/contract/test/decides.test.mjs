/** `decides`: what answering a decision request does is declared on the template, never branched on by id. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cwd } from 'node:process';
import { URL } from 'node:url';
import { RADAR_TEMPLATES, RADAR_TEMPLATE_IDS, decidesFor, laneMoveAllowed } from '../dist/index.js';

const declaring = RADAR_TEMPLATE_IDS.filter((id) => RADAR_TEMPLATES[id].decides);

test('a declaration names lanes the template has, and a move its own rules allow', () => {
  assert.deepEqual([...declaring].sort(), ['architecture', 'decisions']);
  for (const id of declaring) {
    const { from, outcomes } = RADAR_TEMPLATES[id].decides;
    const lanes = RADAR_TEMPLATES[id].statuses.map((lane) => lane.id);
    assert.ok(lanes.includes(from), `${id}: from ${from}`);
    assert.ok(outcomes.length > 0 && !outcomes.includes(from), `${id}: outcomes`);
    for (const outcome of outcomes) {
      assert.ok(lanes.includes(outcome), `${id}: outcome ${outcome}`);
      assert.equal(laneMoveAllowed(id, from, outcome), true, `${id}: ${from} -> ${outcome}`);
    }
  }
});

test('decidesFor answers in the radar’s own lanes, and is null where nothing is declared', () => {
  assert.deepEqual(
    decidesFor('decisions').outcomes.map((lane) => lane.id),
    ['accepted', 'rejected'],
  );
  for (const id of RADAR_TEMPLATE_IDS.filter((t) => !declaring.includes(t)))
    assert.equal(decidesFor(id), null, id);
  assert.equal(decidesFor('no-such-template'), null);
  // A radar that renamed away an outcome keeps the others; one that lost `from` decides nothing.
  const lane = (id) => ({ id, label: id, state: 'inbox' });
  assert.deepEqual(
    decidesFor('decisions', { lanes: [lane('proposed'), lane('accepted')] }).outcomes.map(
      (l) => l.id,
    ),
    ['accepted'],
  );
  assert.equal(decidesFor('decisions', { lanes: [lane('accepted'), lane('rejected')] }), null);
});

test('the decision code reads the declaration and never a template id', () => {
  for (const file of [
    '../server/src/services/decisions.ts',
    '../ui/src/components/decision-requests.tsx',
  ]) {
    const source = readFileSync(new URL(file, `file://${cwd()}/`), 'utf8');
    for (const id of RADAR_TEMPLATE_IDS)
      assert.doesNotMatch(
        source,
        new RegExp(`(===|!==|case)\\s*'${id}'`),
        `${file} branches on '${id}'`,
      );
  }
});

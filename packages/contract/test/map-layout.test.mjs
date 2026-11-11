/**
 * `layoutMap` is ported to the iOS app, which checks its own drawing against these numbers: the
 * layout without an aspect must never move, and the one with an aspect must be shaped for the box.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutMap } from '../dist/index.js';

// A large architecture's size: 24 of ours, 16 outside, and a seam from each outside system plus a chain inside.
const inside = Array.from({ length: 24 }, (_, i) => ({
  id: `i${String(i).padStart(2, '0')}`,
  title: `M${i + 1} Module ${i + 1}`,
  external: false,
}));
const outside = Array.from({ length: 16 }, (_, i) => ({
  id: `x${String(i).padStart(2, '0')}`,
  title: `System ${i + 1}`,
  external: true,
}));
const boundaries = [...inside, ...outside];
const contracts = [
  ...outside.map((x, i) => ({
    id: `cx${x.id}`,
    title: `Link ${i + 1}`,
    version: '1.0',
    a: inside[(i * 3) % 24].id,
    b: x.id,
  })),
  ...inside.slice(1).map((b, i) => ({
    id: `ci${b.id}`,
    title: `Step ${i + 1}`,
    version: null,
    a: inside[i].id,
    b: b.id,
  })),
];
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('without an aspect the layout is the one every client draws', () => {
  const fixed = layoutMap(boundaries, contracts);
  assert.equal(sha(layoutMap(boundaries, contracts, {})), sha(fixed));
  assert.equal(sha(layoutMap(boundaries, contracts, { aspect: Number.NaN })), sha(fixed));
  assert.equal(sha(fixed), 'b472fac2f0aa6ea386ad8690d3931326957d815dfc7a3a94bc704e4370b02d0a');
});

test('with an aspect the drawing is shaped like the box, and still has every element once', () => {
  const fixed = layoutMap(boundaries, contracts);
  assert.ok(fixed.width / fixed.height > 2.5, 'the fixed layout is a wide strip');
  const map = layoutMap(boundaries, contracts, { aspect: 1.4 });
  const shape = map.width / map.height;
  assert.ok(shape > 1.2 && shape < 1.7, `aspect 1.4 gave ${shape.toFixed(2)}`);
  assert.equal(map.boxes.length, 40);
  assert.equal(map.seams.length, contracts.length);
});

test('the frame keeps its label clear of the first row of boxes', () => {
  for (const aspect of [0.8, 1.4, 2.4]) {
    const map = layoutMap(boundaries, contracts, { aspect });
    // The label is drawn 22 below the frame's top, 11px tall.
    for (const box of map.boxes.filter((b) => !b.external))
      assert.ok(box.y >= map.frame.y + 28, `aspect ${aspect}: ${box.id} at ${box.y - map.frame.y}`);
  }
});

test('a hundred boundaries in a chain are laid out for a box in well under a second', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    id: `b${String(i).padStart(3, '0')}`,
    title: `Module ${i + 1}`,
    external: false,
  }));
  const chain = many.slice(1).map((b, i) => ({
    id: `c${b.id}`,
    title: `Step ${i + 1}`,
    version: null,
    a: many[i].id,
    b: b.id,
  }));
  layoutMap(many, chain, { aspect: 1.4 }); // warm up
  const started = performance.now();
  const map = layoutMap(many, chain, { aspect: 1.4 });
  const took = performance.now() - started;
  // About 100ms here; the margin is for a busy CI runner. It was 7s before the search was bounded.
  assert.ok(took < 1000, `took ${took.toFixed(0)}ms`);
  assert.equal(map.boxes.length, 100);
  assert.equal(map.seams.length, 99);
  const shape = map.width / map.height;
  assert.ok(shape > 0.9 && shape < 2.2, `aspect 1.4 gave ${shape.toFixed(2)}`);
  // The default layout is not slower for it.
  const fixedStart = performance.now();
  layoutMap(many, chain);
  assert.ok(performance.now() - fixedStart < 4000);
});

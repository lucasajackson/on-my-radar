/**
 * The contract snapshot is what `on-my-radar-ios` vendors to catch its Swift
 * mirror drifting. Nothing ran it, so the package script sat broken — it pointed
 * `--experimental-strip-types` at a source tree whose imports end in `.js`, and
 * died on ERR_MODULE_NOT_FOUND before printing a byte.
 *
 * This runs the script's own runtime step, as written in package.json, against
 * the built package (CI builds the contract before any test). It does not run
 * the `tsc` step: `pnpm -r test` runs packages concurrently, and rewriting
 * `dist` underneath the server's suite would be a flake of our own making.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeSteps = pkg.scripts.snapshot
  .split('&&')
  .map((step) => step.trim())
  .filter((step) => step.startsWith('node '));

const run = () =>
  runtimeSteps.map((step) =>
    execSync(step, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
  );

test('the snapshot script has a runtime step', () => {
  assert.equal(runtimeSteps.length, 1, pkg.scripts.snapshot);
});

test('the snapshot script prints the registries and the behaviour vectors', () => {
  const [out] = run();
  const snapshot = JSON.parse(out);
  assert.equal(snapshot.format, 1);
  assert.ok(snapshot.registries.blipKinds.includes('link'));
  for (const kind of ['inference', 'triage', 'availability']) {
    assert.ok(snapshot.vectors[kind].length > 0, `no ${kind} vectors`);
  }
  assert.ok(snapshot.vectors.normalisation.tags.length > 0, 'no tag vectors');
  assert.ok(snapshot.vectors.normalisation.mentions.length > 0, 'no mention vectors');
});

test('the snapshot is deterministic, so a refresh with no change is no diff', () => {
  assert.equal(run()[0], run()[0]);
});

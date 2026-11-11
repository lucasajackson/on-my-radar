/**
 * Every registry is a plain object literal, so `key in REGISTRY` and
 * `REGISTRY[key]` both see Object.prototype. A key from a request or a stored
 * column must be one the registry declares, not one every object inherits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEME_AXES,
  harnessSchema,
  profileKeySchema,
  resolveHarness,
  validateProfileSettings,
  withoutWideningValues,
  isBlipReaction,
  isRadarAccent,
  isRadarGlyph,
  isRadarTemplate,
  isThemePreset,
  parseSearchQuery,
} from '../dist/index.js';

const INHERITED = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

test('registry guards refuse inherited keys', () => {
  for (const guard of [
    isRadarTemplate,
    isRadarAccent,
    isRadarGlyph,
    isBlipReaction,
    isThemePreset,
  ]) {
    for (const key of INHERITED) assert.equal(guard(key), false, `${guard.name}('${key}')`);
  }
  // …and still accept a declared one, so the test cannot pass by refusing everything.
  assert.equal(isRadarTemplate('stream'), true);
  assert.equal(isRadarAccent('cobalt'), true);
});

test('has: with an inherited key is a problem, not a filter', () => {
  for (const key of ['constructor', '__proto__']) {
    const parsed = parseSearchQuery(`has:${key}`);
    assert.deepEqual(parsed.tokens, [], key);
    assert.equal(parsed.problems.length, 1, key);
  }
  assert.deepEqual(
    parseSearchQuery('has:link').tokens.map((token) => token.value),
    ['link'],
  );
});

test('a tool name or setting that every object inherits is refused, never thrown or stored', () => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(resolveHarness(key), null, `resolveHarness('${key}')`);
    assert.equal(harnessSchema.safeParse(key).success, false, `harnessSchema '${key}'`);
    assert.equal(profileKeySchema.safeParse(key).success, false, `profileKeySchema '${key}'`);
    // A setting key: refused by name, not looked up on the prototype.
    const settings = JSON.parse(`{"${key}": "x"}`);
    assert.equal(validateProfileSettings('claude-code', settings).ok, false, `setting '${key}'`);
    assert.deepEqual(withoutWideningValues('claude-code', settings).stripped, [], `strip '${key}'`);
  }
  // …and a real one still passes, so the test cannot pass by refusing everything.
  assert.equal(resolveHarness('Claude Code'), 'claude-code');
  assert.equal(validateProfileSettings('claude-code', { model: 'opus' }).ok, true);
});

test('theme labels fall back to the raw value for an inherited key', () => {
  for (const axis of THEME_AXES) {
    assert.equal(axis.labelFor('constructor'), 'constructor', axis.key);
  }
});

/**
 * Every field of every tool says which of its values are safe, and every other
 * value is permission-widening. The table below is checked against the registry in
 * both directions, so a field added without an explicit classification here (and
 * therefore without anyone having thought about what it grants) fails this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESSES,
  fieldWidens,
  validateProfileSettings,
  wideningValues,
  withoutUnapprovedWidening,
  withoutWideningValues,
} from '../dist/index.js';

/** `harness.field` -> values that must be safe / must widen. */
const EXPECT = {
  'claude-code.model': { safe: ['opus', 'sonnet'], widens: [] },
  'claude-code.effort': { safe: ['low', 'max'], widens: [] },
  'claude-code.tools': {
    safe: ['Read, Grep', 'Bash', 'mcp__srv__tool'],
    widens: ['Bash(git *)', 'Read, Bash(npm run *)', 'Agent(worker)'],
  },
  'claude-code.disallowedTools': { safe: ['Bash', 'mcp__*'], widens: [] },
  'claude-code.permissionMode': {
    safe: ['default', 'plan', 'manual'],
    widens: ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'BypassPermissions', ' plan '],
  },
  'claude-code.color': { safe: ['blue', 'red'], widens: [] },
  'codex.model': { safe: ['gpt-5-codex'], widens: [] },
  'codex.model_reasoning_effort': { safe: ['low', 'ultra'], widens: [] },
  'codex.approval_policy': {
    safe: ['on-request'],
    widens: ['never', 'Never', ' never ', 'NEVER', 'untrusted', 'on-failure', 7],
  },
  'codex.sandbox_mode': {
    safe: ['read-only', 'workspace-write'],
    widens: [
      'danger-full-access',
      'Danger-Full-Access',
      ' danger-full-access',
      'DANGER-FULL-ACCESS',
    ],
  },
  'cursor.model': { safe: ['claude-opus'], widens: [] },
  'cursor.readonly': { safe: [true], widens: [false] },
  'cursor.is_background': { safe: [true, false], widens: [] },
  'copilot.model': { safe: ['Claude Opus 4.5'], widens: [] },
  'copilot.tools': { safe: ['search/codebase, web/fetch'], widens: ['execute(rm *)'] },
  'copilot.target': { safe: ['both', 'vscode', 'github-copilot'], widens: [] },
  'gemini-cli.model': { safe: ['gemini-2.5-pro'], widens: [] },
  'gemini-cli.approvalMode': {
    safe: ['default', 'plan'],
    widens: ['auto_edit', 'yolo', 'Default', ' default'],
  },
  'gemini-cli.sandbox': { safe: [true], widens: [false] },
  'zed.model': { safe: ['anthropic/claude-opus'], widens: [] },
  'zed.toolPermissions': { safe: ['confirm'], widens: ['allow', 'Allow', ' confirm'] },
};

const fieldsOf = () =>
  Object.values(HARNESSES).flatMap((h) => h.fields.map((field) => ({ harness: h.id, field })));

test('every field of every tool has an explicit classification in the table, and vice versa', () => {
  const generated = fieldsOf().map(({ harness, field }) => `${harness}.${field.key}`);
  assert.deepEqual([...generated].sort(), Object.keys(EXPECT).sort());
});

test('every field declares what is safe, in a shape that matches its control', () => {
  for (const { harness, field } of fieldsOf()) {
    const where = `${harness}.${field.key}`;
    const safe = field.safe;
    assert.ok(safe === 'any' || safe === 'tool-names' || Array.isArray(safe), `${where}: safe`);
    if (field.control === 'toggle') {
      assert.ok(
        safe === 'any' || (Array.isArray(safe) && safe.every((v) => typeof v === 'boolean')),
        where,
      );
    }
    if (field.control === 'select' || field.control === 'color') {
      if (Array.isArray(safe)) {
        const options = field.options.map((o) => o.value);
        assert.ok(
          safe.every((v) => options.includes(v)),
          `${where}: safe values are options`,
        );
      }
    }
    if (field.control === 'text') assert.ok(safe === 'any' || safe === 'tool-names', `${where}`);
  }
});

test('safe values are safe and everything else widens', () => {
  for (const { harness, field } of fieldsOf()) {
    const where = `${harness}.${field.key}`;
    const { safe, widens } = EXPECT[where];
    for (const value of safe) assert.equal(fieldWidens(field, value), false, `${where}=${value}`);
    for (const value of widens) assert.equal(fieldWidens(field, value), true, `${where}=${value}`);
    // Every option the tool offers is classified one way or the other, none left over.
    for (const option of field.options ?? []) {
      assert.equal(
        fieldWidens(field, option.value),
        !(safe.includes(option.value) || field.safe === 'any'),
        `${where} option ${option.value}`,
      );
    }
    // A value nobody has heard of is never safe where the field is a closed set.
    if (Array.isArray(field.safe)) assert.equal(fieldWidens(field, 'zz-unknown'), true, where);
  }
});

test('unset is the tool’s default and never widens', () => {
  for (const { field } of fieldsOf())
    for (const unset of [undefined, null, ''])
      assert.equal(fieldWidens(field, unset), false, `${field.key}=${unset}`);
});

test('wideningValues, withoutWideningValues and withoutUnapprovedWidening agree for booleans too', () => {
  assert.deepEqual(wideningValues('gemini-cli', { sandbox: false, approvalMode: 'plan' }), {
    sandbox: 'false',
  });
  assert.deepEqual(wideningValues('cursor', { readonly: false, is_background: false }), {
    readonly: 'false',
  });
  const stripped = withoutWideningValues('cursor', {
    model: 'x',
    readonly: false,
    is_background: true,
  });
  assert.deepEqual(stripped.settings, { model: 'x', is_background: true });
  assert.deepEqual(stripped.stripped, ['Read-only helper: off']);
  // Approval is for exactly that value.
  assert.deepEqual(
    withoutUnapprovedWidening('gemini-cli', { sandbox: false }, { sandbox: 'false' }).settings,
    { sandbox: false },
  );
  assert.deepEqual(
    withoutUnapprovedWidening(
      'codex',
      { sandbox_mode: 'danger-full-access' },
      { sandbox_mode: 'read-only' },
    ).settings,
    {},
  );
  assert.deepEqual(
    withoutUnapprovedWidening('codex', { sandbox_mode: 'danger-full-access' }, { toString: 'x' })
      .settings,
    {},
  );
});

test('enum values differing only in case or whitespace are refused at validation', () => {
  for (const [harness, settings] of [
    ['codex', { sandbox_mode: 'Danger-Full-Access' }],
    ['codex', { approval_policy: ' never ' }],
    ['claude-code', { permissionMode: 'BypassPermissions' }],
    ['zed', { toolPermissions: 'Allow' }],
    ['gemini-cli', { approvalMode: 'YOLO' }],
  ])
    assert.equal(validateProfileSettings(harness, settings).ok, false, JSON.stringify(settings));
});

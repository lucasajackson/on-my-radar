/**
 * The Codex path: the bridge in agent-setup/ is plain JS with no imports, so
 * what it shares with this contract is held equal here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_APPROVED_TOOLS,
  OMR_AGENT_VERSION,
  inferHarness,
  omrAgentVersion,
  validateProfileSettings,
  versionBefore,
} from '../dist/index.js';
import * as bridge from '../../../agent-setup/omr-agent.mjs';

test('the bridge and the contract name the same release and the same approved tools', () => {
  assert.equal(bridge.VERSION, OMR_AGENT_VERSION);
  assert.deepEqual(bridge.CODEX_APPROVED_TOOLS, [...CODEX_APPROVED_TOOLS]);
  for (const tool of CODEX_APPROVED_TOOLS) {
    assert.ok(bridge.DEFAULT_BRIDGE_TOOLS.includes(tool), `${tool} is not a bridge tool`);
  }
});

test('a version comes out of the bridge User-Agent and compares as numbers', () => {
  assert.equal(omrAgentVersion(`omr-agent/${bridge.VERSION}`), bridge.VERSION);
  assert.equal(omrAgentVersion('node'), null);
  assert.equal(omrAgentVersion(undefined), null);
  assert.ok(versionBefore('0.3.2', '0.4.0') && versionBefore('0.9.0', '0.10.0'));
  assert.ok(!versionBefore('0.4.0', '0.4.0') && !versionBefore('1.0.0', '0.4.0'));
});

test('a load that names no tool gets one only when its OAuth client can be just one', () => {
  assert.equal(inferHarness('Claude Code (plugin)'), 'claude-code');
  assert.equal(inferHarness('Claude.ai'), 'claude-ai');
  assert.equal(inferHarness('omr-agent on Mac'), null, 'Claude Code and Codex both use it');
  assert.equal(inferHarness('Claude'), null);
  assert.equal(inferHarness(null), null);
});

test('a setting a tool does not have is refused with the ones it does', () => {
  const r = validateProfileSettings('codex', { effort: 'high' });
  assert.equal(r.ok, false);
  assert.match(
    r.message,
    /no setting 'effort'.*model, model_reasoning_effort, approval_policy, sandbox_mode/,
  );
});

/**
 * The tool an agent says it ran in is checked against the OAuth client it
 * connected through. Only a client whose registered name (and, where the tool
 * has fixed ones, redirect host) is the tool's own verifies it; a token, a
 * browser session or a removed connection can only ever be `claimed`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessCheck } from '../dist/index.js';

const claude = { name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] };
const loopbackClaude = { name: 'Claude', redirectUris: ['http://127.0.0.1:53682/callback'] };
const omrAgent = {
  name: 'omr-agent on Lucass-MacBook-Pro.local',
  redirectUris: ['http://127.0.0.1:49152/callback'],
};

test('an OAuth client named Claude backs claude.ai and Claude Code', () => {
  assert.equal(harnessCheck('claude-ai', claude), 'verified');
  assert.equal(harnessCheck('claude_code', claude), 'verified');
});

test('a codex claim through the Claude client is a mismatch (the eval case)', () => {
  assert.equal(harnessCheck('codex', claude), 'mismatch');
});

test('omr-agent backs Codex on loopback, and nothing else on a Claude host', () => {
  assert.equal(harnessCheck('codex', omrAgent), 'verified');
  assert.equal(harnessCheck('cursor', omrAgent), 'mismatch');
  assert.equal(
    harnessCheck('codex', { ...omrAgent, redirectUris: ['https://evil.example/cb'] }),
    'claimed',
  );
});

test('a token, a browser session or a removed connection is only ever claimed', () => {
  assert.equal(harnessCheck('claude-code', null), 'claimed');
  assert.equal(harnessCheck('codex', null), 'claimed');
});

test('a loopback client registered as Claude cannot verify claude.ai', () => {
  assert.equal(harnessCheck('claude-ai', loopbackClaude), 'claimed');
  assert.equal(
    harnessCheck('claude-ai', {
      name: 'Claude',
      redirectUris: [...claude.redirectUris, 'http://127.0.0.1:1/cb'],
    }),
    'claimed',
  );
  assert.equal(harnessCheck('codex', loopbackClaude), 'mismatch');
});

test('an unrecognised client name or claim has nothing to contradict', () => {
  assert.equal(
    harnessCheck('codex', { name: 'Some App', redirectUris: ['https://x.example'] }),
    'claimed',
  );
  assert.equal(harnessCheck('mystery-tool', claude), 'claimed');
  assert.equal(harnessCheck('other', claude), 'claimed');
  assert.equal(harnessCheck(null, claude), 'claimed');
  assert.equal(harnessCheck('claude-ai', { name: null, redirectUris: [] }), 'claimed');
});

test('omr-agent verifies Codex on every loopback spelling', () => {
  for (const uri of ['http://localhost:49152/callback', 'http://[::1]:49152/callback']) {
    assert.equal(harnessCheck('codex', { ...omrAgent, redirectUris: [uri] }), 'verified', uri);
  }
});

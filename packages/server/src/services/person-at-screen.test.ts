import { describe, expect, it } from 'vitest';
import type { Actor } from '../http.js';
import { isHumanSession, isPersonAtScreen } from './agents.js';

const user = { id: 'u' } as Actor['user'];

describe('isPersonAtScreen', () => {
  it('counts only a cookie session that is not an MCP call', () => {
    expect(isPersonAtScreen({ user, kind: 'user', viaCookie: true })).toBe(true);
    expect(isPersonAtScreen({ user, kind: 'user' })).toBe(false);
    // The trap S1b closed: a cookie that arrives on /mcp is still a credential an agent could hold.
    expect(isPersonAtScreen({ user, kind: 'user', viaCookie: true, invocation: 'mcp' })).toBe(
      false,
    );
    expect(isPersonAtScreen({ user, kind: 'agent' })).toBe(false);
  });
});

describe('isHumanSession', () => {
  it('adds only the native app’s own session token, never on /mcp', () => {
    expect(isHumanSession({ user, kind: 'user', viaCookie: true })).toBe(true);
    expect(isHumanSession({ user, kind: 'user', appSession: true })).toBe(true);
    expect(isHumanSession({ user, kind: 'user', appSession: true, invocation: 'mcp' })).toBe(false);
    // A web or CLI session token, a PAT and an OAuth grant carry no marker.
    expect(isHumanSession({ user, kind: 'user', sessionId: 's' })).toBe(false);
    expect(isHumanSession({ user, kind: 'agent', appSession: true })).toBe(false);
    // S1b's prompt and profile rule is unchanged: the app token is not a person at the screen.
    expect(isPersonAtScreen({ user, kind: 'user', appSession: true })).toBe(false);
  });
});

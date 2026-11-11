import { describe, expect, it } from 'vitest';
import type { Actor } from '../http.js';
import { accountExportOwnerId, projectAccountExportRow } from './account-export-policy.js';

const human = {
  kind: 'user',
  sessionId: 'human-session',
  user: { id: 'owner', state: 'active' },
} as Actor;

describe('account export service boundaries', () => {
  it('takes ownership only from an active human session', () => {
    expect(accountExportOwnerId(human)).toBe('owner');
    for (const kind of ['agent', 'webhook', 'integration'] as const)
      expect(() => accountExportOwnerId({ ...human, kind })).toThrow();
    expect(() => accountExportOwnerId(null)).toThrow();
    const withoutSession = { ...human };
    delete withoutSession.sessionId;
    expect(() => accountExportOwnerId(withoutSession)).toThrow();
    expect(() =>
      accountExportOwnerId({ ...human, user: { ...human.user, state: 'suspended' } }),
    ).toThrow();
    expect(() =>
      accountExportOwnerId({
        ...human,
        agent: { agentId: 'a', ownerId: 'owner', name: 'A', handle: 'a' },
      }),
    ).toThrow();
  });

  it('omits credential fields and refuses newly introduced unclassified fields', () => {
    const row = { id: 'owner', name: 'Human', tokenHash: 'do-not-export' };
    expect(projectAccountExportRow(row, ['id', 'name'], ['tokenHash'])).toEqual({
      id: 'owner',
      name: 'Human',
    });
    expect(() =>
      projectAccountExportRow({ ...row, newCredential: 'secret' }, ['id', 'name'], ['tokenHash']),
    ).toThrow('Unclassified');
    expect(() => projectAccountExportRow({ id: 'owner' }, ['id', 'name'], [])).toThrow('Missing');
    expect(() => projectAccountExportRow(row, ['id', 'id'], ['name', 'tokenHash'])).toThrow(
      'Ambiguous',
    );
    expect(() => projectAccountExportRow(row, ['id'], ['id', 'name', 'tokenHash'])).toThrow(
      'Ambiguous',
    );
  });
});

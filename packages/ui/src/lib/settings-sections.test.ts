import { describe, expect, it } from 'vitest';
import { legacySettingsTarget, sectionForPath } from './settings-sections';

describe('settings section URLs', () => {
  it.each([
    ['connections', { to: '/settings/connections' }],
    ['integrations', { to: '/settings/connections' }],
    ['email-capture', { to: '/settings/email' }],
    ['notifications', { to: '/settings/notifications' }],
    ['billing', null],
    ['', null],
    ['unknown', null],
  ])('sends /settings#%s to its section', (hash, expected) => {
    expect(legacySettingsTarget('/settings', hash)).toEqual(expected);
  });

  it('never redirects a section URL', () => {
    expect(legacySettingsTarget('/settings/data', 'connections')).toBeNull();
  });

  it('knows which section a path is in', () => {
    expect(sectionForPath('/settings')).toBeNull();
    expect(sectionForPath('/settings/notifications')).toBe('notifications');
    expect(sectionForPath('/settings/billing/')).toBeNull();
    expect(sectionForPath('/settings/nope')).toBeNull();
  });
});

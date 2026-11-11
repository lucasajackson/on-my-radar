import { expect, it } from 'vitest';
import { labelForPath } from './shell';

it('names the screen the back control actually returns to', () => {
  expect(labelForPath('/radar/r1/settings', null)).toBe('Settings');
  expect(labelForPath('/radar/r1', null)).toBe('Radar');
  expect(labelForPath('/notifications', null)).toBe('Activity');
  expect(labelForPath('/search', null)).toBe('Search');
  expect(labelForPath('/t/garden', null)).toBe('Tag');
  // Every admin section returns to the dashboard, not to a bare "Back".
  expect(labelForPath('/admin', null)).toBe('Admin');
  expect(labelForPath('/admin/models', null)).toBe('Admin');
});

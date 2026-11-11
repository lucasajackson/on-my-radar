import { expect, it } from 'vitest';
import { chipLabel } from './search-input';

// West of UTC, where a naive local conversion of a UTC-midnight bound shows the
// day before. Node applies a TZ change to every Date made after it.
process.env['TZ'] = 'America/New_York';

const chip = (raw: string, label: string) => ({
  field: raw.split(':')[0] ?? '',
  raw,
  resolved: true,
  label,
});

it('shows a typed date as that calendar date, not as a UTC instant or the day before', () => {
  const shown = chipLabel(chip('after:2026-09-01', '2026-09-01T00:00:00.000Z'));
  expect(shown).not.toContain('T00:00');
  // The day that was typed — never Aug 31, which a local conversion gives here.
  expect(shown).toMatch(/Sep\w* 1\b|\b1 Sep/);
  expect(shown).not.toMatch(/Aug/);
});

it('shows a span as the moment it resolved to, with what was typed', () => {
  const shown = chipLabel(chip('after:7d', '2026-09-19T14:30:00.000Z'));
  expect(shown).not.toContain('Z');
  expect(shown.endsWith('(7d)')).toBe(true);
});

it('leaves every other filter as the server labelled it', () => {
  expect(chipLabel(chip('in:work', 'Work'))).toBe('Work');
});

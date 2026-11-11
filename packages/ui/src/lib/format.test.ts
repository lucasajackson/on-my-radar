import { afterEach, expect, it, vi } from 'vitest';
import { relativeTime } from './format';

afterEach(() => {
  vi.useRealTimers();
});

it('never names a unit by its own upper bound', () => {
  vi.useFakeTimers();
  const now = new Date('2026-09-26T12:00:00Z');
  vi.setSystemTime(now);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  expect(relativeTime(ago(59_600))).toBe('59s');
  expect(relativeTime(ago(59 * 60_000 + 40_000))).toBe('59m');
  expect(relativeTime(ago(23 * 3_600_000 + 40 * 60_000))).toBe('23h');
  expect(relativeTime(ago(90_000))).toBe('1m');
  expect(relativeTime(ago(10_000))).toBe('now');
});

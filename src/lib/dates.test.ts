import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, dateKey, daysBetween, dueBucket, formatDate, relativeDue, todayKey } from './dates';

afterEach(() => vi.useRealTimers());

describe('dueBucket', () => {
  const now = new Date(2026, 8, 19, 23, 30); // 19 Sep 2026, 11:30pm local

  it('splits overdue, today and upcoming against the local day', () => {
    expect(dueBucket('2026-09-18', now)).toBe('overdue');
    expect(dueBucket('2026-09-19', now)).toBe('today');
    expect(dueBucket('2026-09-20', now)).toBe('upcoming');
  });

  it('returns none for an unusable date', () => {
    expect(dueBucket('', now)).toBe('none');
    expect(dueBucket('not a date', now)).toBe('none');
  });

  it('handles a full ISO timestamp', () => {
    expect(dueBucket('2026-09-19T08:00:00.000Z', new Date(2026, 8, 19, 12))).toBe('today');
  });
});

describe('addDays / daysBetween', () => {
  it('round-trips', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 10));
    expect(addDays(7)).toBe('2026-09-26');
    expect(daysBetween('2026-09-26')).toBe(7);
    expect(daysBetween('2026-09-19')).toBe(0);
    expect(daysBetween('2026-09-12')).toBe(-7);
  });

  it('crosses a month boundary', () => {
    expect(addDays(15, new Date(2026, 8, 19))).toBe('2026-10-04');
  });
});

describe('formatting', () => {
  it('formats dates and keys', () => {
    expect(todayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dateKey('2026-09-19T23:00:00')).toBe('2026-09-19');
    expect(formatDate('2026-09-19')).toMatch(/Sep 19/);
    expect(formatDate('')).toBe('');
  });

  it('describes a due date in words', () => {
    const now = new Date(2026, 8, 19);
    expect(relativeDue('2026-09-19', now)).toBe('Today');
    expect(relativeDue('2026-09-20', now)).toBe('Tomorrow');
    expect(relativeDue('2026-09-18', now)).toBe('1 day overdue');
    expect(relativeDue('2026-09-14', now)).toBe('5 days overdue');
    expect(relativeDue('2026-09-22', now)).toBe('In 3 days');
  });
});

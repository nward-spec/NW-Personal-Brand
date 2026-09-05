import { describe, expect, it } from 'vitest';
import { addDays, dayKeyOf, formatDayHeading, formatWeekRange, isoWeekNumber, weekDates, weekStartOf } from './week';

describe('weekStartOf', () => {
  it('returns Monday for every day of the journal week', () => {
    for (const d of ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-21', '2026-03-22']) {
      expect(weekStartOf(d)).toBe('2026-03-16');
    }
  });
  it('rolls a Sunday back to the previous Monday, not forward', () => {
    expect(weekStartOf('2026-03-22')).toBe('2026-03-16');
    expect(weekStartOf('2026-03-23')).toBe('2026-03-23');
  });
  it('accepts Date objects in local time', () => {
    expect(weekStartOf(new Date(2026, 2, 19, 23, 59))).toBe('2026-03-16');
  });
});

describe('dates', () => {
  it('lists seven consecutive dates from Monday', () => {
    expect(weekDates('2026-03-16')).toEqual(['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-21', '2026-03-22']);
  });
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2025-12-29', 6)).toBe('2026-01-04');
  });
  it('maps dates to day keys', () => {
    expect(dayKeyOf('2026-03-16')).toBe('mon');
    expect(dayKeyOf('2026-03-22')).toBe('sun');
  });
});

describe('formatting', () => {
  it('matches the journal header', () => {
    expect(isoWeekNumber('2026-03-16')).toBe(12);
    expect(formatWeekRange('2026-03-16')).toBe('16 – 22 Mar 2026');
    expect(formatDayHeading('2026-03-16')).toBe('Mon 16 Mar');
  });
  it('handles weeks spanning months and years', () => {
    expect(formatWeekRange('2026-03-30')).toBe('30 Mar – 5 Apr 2026');
    expect(formatWeekRange('2025-12-29')).toBe('29 Dec 2025 – 4 Jan 2026');
    expect(isoWeekNumber('2025-12-29')).toBe(1);
  });
});

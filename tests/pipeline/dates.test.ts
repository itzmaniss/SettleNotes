import { describe, expect, test } from 'bun:test';
import {
  dueLocalToUtc,
  nextWeekWeekday,
  nowContext,
  upcomingWeekday,
  utcToSgtLocal,
} from '../../lib/pipeline/dates';

// 2026-10-28 is a Wednesday, 2026-10-30 is a Friday, 2026-11-01 a Sunday.
const WED = new Date('2026-10-28T09:00:00+08:00');
const FRI = new Date('2026-10-30T09:00:00+08:00');
const SAT = new Date('2026-10-31T09:00:00+08:00');
const SUN = new Date('2026-11-01T09:00:00+08:00');
const YEAR_END_MON = new Date('2026-12-28T09:00:00+08:00');

describe('nowContext', () => {
  test('iso, weekday and dateLocal reflect Singapore time', () => {
    const ctx = nowContext(new Date('2026-10-30T17:50:00+08:00'));
    expect(ctx.iso).toBe('2026-10-30T17:50:00+08:00');
    expect(ctx.weekday).toBe('Friday');
    expect(ctx.dateLocal).toBe('2026-10-30');
  });

  test('a UTC instant that is the next day in SGT rolls dateLocal forward', () => {
    // 2026-10-30T17:00Z is 2026-10-31 01:00 in Singapore.
    const ctx = nowContext(new Date('2026-10-30T17:00:00.000Z'));
    expect(ctx.dateLocal).toBe('2026-10-31');
    expect(ctx.weekday).toBe('Saturday');
  });

  test('upcoming has 14 entries including today, formatted as calendar lines', () => {
    const ctx = nowContext(FRI);
    expect(ctx.upcoming).toHaveLength(14);
    expect(ctx.upcoming[0]).toBe('Fri 30 Oct 2026');
    expect(ctx.upcoming[1]).toBe('Sat 31 Oct 2026');
    expect(ctx.upcoming[13]).toBe('Thu 12 Nov 2026');
  });
});

describe('dueLocalToUtc', () => {
  test('converts SGT midnight-adjacent times across the +8 offset', () => {
    expect(dueLocalToUtc('2026-11-06T23:59')).toBe('2026-11-06T15:59:00.000Z');
    expect(dueLocalToUtc('2026-10-29T17:00')).toBe('2026-10-29T09:00:00.000Z');
  });

  test('accepts a date-only value as 23:59 SGT', () => {
    expect(dueLocalToUtc('2026-10-30')).toBe('2026-10-30T15:59:00.000Z');
  });

  test('month and year rollover stay exact', () => {
    expect(dueLocalToUtc('2026-12-31T23:59')).toBe('2026-12-31T15:59:00.000Z');
    // SGT New Year morning is still Dec 31 in UTC.
    expect(dueLocalToUtc('2027-01-01T00:30')).toBe('2026-12-31T16:30:00.000Z');
  });

  test('leap day is accepted only in leap years', () => {
    expect(dueLocalToUtc('2028-02-29')).toBe('2028-02-29T15:59:00.000Z');
    expect(dueLocalToUtc('2027-02-29')).toBeNull();
  });

  test('impossible dates and malformed strings return null instead of rolling over', () => {
    expect(dueLocalToUtc('2026-02-30')).toBeNull();
    expect(dueLocalToUtc('2026-13-01')).toBeNull();
    expect(dueLocalToUtc('2026-10-30T25:00')).toBeNull();
    expect(dueLocalToUtc('2026-10-30T23:60')).toBeNull();
    expect(dueLocalToUtc('garbage')).toBeNull();
    expect(dueLocalToUtc('')).toBeNull();
    expect(dueLocalToUtc('2026-10-30 23:59')).toBeNull();
  });
});

describe('utcToSgtLocal', () => {
  test('converts UTC ISO to SGT wall clock without seconds', () => {
    expect(utcToSgtLocal('2026-10-30T15:59:00.000Z')).toBe('2026-10-30T23:59');
    expect(utcToSgtLocal('2026-12-31T16:30:00.000Z')).toBe('2027-01-01T00:30');
  });

  test('roundtrips through dueLocalToUtc', () => {
    const samples = [
      '2026-10-30T15:59:00.000Z',
      '2026-11-06T15:59:00.000Z',
      '2027-01-01T01:05:00.000Z',
      '2028-02-28T15:59:00.000Z',
      '2026-06-15T08:00:00.000Z',
    ];
    for (const iso of samples) {
      expect(dueLocalToUtc(utcToSgtLocal(iso))).toBe(iso);
    }
  });

  test('returns empty string for unparseable input', () => {
    expect(utcToSgtLocal('not a date')).toBe('');
  });
});

describe('upcomingWeekday', () => {
  test('today counts when today is the weekday', () => {
    expect(upcomingWeekday(FRI, 5)).toBe('2026-10-30');
  });

  test('finds the coming weekday within this week', () => {
    expect(upcomingWeekday(WED, 5)).toBe('2026-10-30');
    expect(upcomingWeekday(WED, 1)).toBe('2026-11-02'); // coming Monday
  });
});

describe('nextWeekWeekday', () => {
  test('on a Friday, next Friday is 7 days later', () => {
    expect(nextWeekWeekday(FRI, 5)).toBe('2026-11-06');
  });

  test('on other weekdays, next Friday is the Friday of the following Mon-Sun week', () => {
    expect(nextWeekWeekday(WED, 5)).toBe('2026-11-06');
  });

  test('on Saturday and Sunday the next Mon-Sun week still starts the coming Monday', () => {
    expect(nextWeekWeekday(SAT, 5)).toBe('2026-11-06');
    expect(nextWeekWeekday(SUN, 5)).toBe('2026-11-06');
    expect(nextWeekWeekday(SAT, 1)).toBe('2026-11-02');
    expect(nextWeekWeekday(SUN, 1)).toBe('2026-11-02');
  });

  test('next Tuesday and Wednesday from a Wednesday land in the following week', () => {
    expect(nextWeekWeekday(WED, 2)).toBe('2026-11-03');
    expect(nextWeekWeekday(WED, 3)).toBe('2026-11-04');
  });

  test('rolls over month and year boundaries', () => {
    expect(nextWeekWeekday(FRI, 1)).toBe('2026-11-02'); // Oct -> Nov
    expect(nextWeekWeekday(YEAR_END_MON, 1)).toBe('2027-01-04'); // Dec -> Jan
    expect(nextWeekWeekday(YEAR_END_MON, 5)).toBe('2027-01-08');
  });

  test('ignores invalid weekday numbers', () => {
    expect(upcomingWeekday(FRI, 7)).toBe('');
    expect(upcomingWeekday(FRI, -1)).toBe('');
    expect(nextWeekWeekday(FRI, 9)).toBe('');
  });
});

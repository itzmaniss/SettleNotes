// Pure date helpers for the Understand pipeline. Singapore is fixed UTC+8
// with no DST, so SGT wall-clock time is just epoch + offset and every date
// calculation below avoids Date's rollover behaviour by validating parts.

export const SGT_TZ = 'Asia/Singapore';

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export type NowContext = {
  /** ISO instant with explicit +08:00 offset, e.g. 2026-10-30T17:50:00+08:00. */
  iso: string;
  /** Weekday name in Singapore, e.g. 'Friday'. */
  weekday: string;
  /** Local calendar date 'YYYY-MM-DD' in Singapore. */
  dateLocal: string;
  /** Next 14 days including today, lines like 'Fri 30 Oct 2026'. */
  upcoming: string[];
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Epoch milliseconds shifted into SGT wall clock, so UTC getters read SGT.
function sgtShifted(now: Date): Date {
  return new Date(now.getTime() + SGT_OFFSET_MS);
}

function isValidWeekday(weekday: number): boolean {
  return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6;
}

// Whole days since 1970-01-01 in SGT calendar terms.
function sgtDayIndex(now: Date): number {
  return Math.floor((now.getTime() + SGT_OFFSET_MS) / DAY_MS);
}

function dayIndexToUtcDate(index: number): Date {
  return new Date(index * DAY_MS);
}

function dayIndexToDateStr(index: number): string {
  return dayIndexToUtcDate(index).toISOString().slice(0, 10);
}

function dayIndexToWeekday(index: number): number {
  return dayIndexToUtcDate(index).getUTCDay();
}

export function nowContext(now: Date): NowContext {
  const shifted = sgtShifted(now);
  const today = sgtDayIndex(now);
  const upcoming: string[] = [];
  for (let offset = 0; offset < 14; offset++) {
    const d = dayIndexToUtcDate(today + offset);
    upcoming.push(
      `${WEEKDAY_NAMES[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    );
  }
  return {
    iso: `${dayIndexToDateStr(today)}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}+08:00`,
    weekday: WEEKDAY_NAMES[shifted.getUTCDay()],
    dateLocal: dayIndexToDateStr(today),
    upcoming,
  };
}

function daysInMonth(year: number, month: number): number {
  // month is 1-based; day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDueLocal(dueLocal: string): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(dueLocal.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 23 : Number(match[4]);
  const minute = match[5] === undefined ? 59 : Number(match[5]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

/**
 * 'YYYY-MM-DDTHH:mm' in SGT (or date-only, meaning 23:59) to a UTC ISO string.
 * Returns null for malformed or impossible dates instead of letting JS roll
 * them over (2026-02-30, hour 25, and so on).
 */
export function dueLocalToUtc(dueLocal: string): string | null {
  const parts = parseDueLocal(dueLocal);
  if (!parts) return null;
  const { year, month, day, hour, minute } = parts;
  // SGT wall clock is UTC+8, so the UTC instant is 8 hours earlier.
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SGT_OFFSET_MS).toISOString();
}

/**
 * UTC ISO string to 'YYYY-MM-DDTHH:mm' in SGT, for showing open-task
 * deadlines to the model. Returns '' when the input is not a parseable date.
 */
export function utcToSgtLocal(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const shifted = sgtShifted(t);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

/** 'YYYY-MM-DD' of the first given weekday on or after today (today counts). */
export function upcomingWeekday(now: Date, weekday: number): string {
  if (!isValidWeekday(weekday)) return '';
  const today = sgtDayIndex(now);
  for (let offset = 0; offset < 7; offset++) {
    const index = today + offset;
    if (dayIndexToWeekday(index) === weekday) return dayIndexToDateStr(index);
  }
  return '';
}

/**
 * 'YYYY-MM-DD' of the given weekday inside the FOLLOWING Monday-to-Sunday
 * week (the week that starts after the current Mon-Sun week ends, so it is
 * computed even when today is Sat or Sun). This is what 'next Fri' means.
 */
export function nextWeekWeekday(now: Date, weekday: number): string {
  if (!isValidWeekday(weekday)) return '';
  const today = sgtDayIndex(now);
  // Monday of the current Mon-Sun week (may be in the past for Sat/Sun).
  const currentMonday = today - ((dayIndexToWeekday(today) + 6) % 7);
  const nextMonday = currentMonday + 7;
  for (let offset = 0; offset < 7; offset++) {
    const index = nextMonday + offset;
    if (dayIndexToWeekday(index) === weekday) return dayIndexToDateStr(index);
  }
  return '';
}

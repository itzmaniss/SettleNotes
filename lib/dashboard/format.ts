// Dashboard view-model formatting: Singapore wall-clock dates, due lines and
// history timestamps. Pure, no server-only, unit tested in tests/dashboard.

export type DueLine = { text: string; overdue: boolean };

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseIso(iso: string | null): Date | null {
  if (iso == null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Epoch shifted so UTC getters read SGT wall clock (fixed UTC+8, no DST).
function sgtShifted(date: Date): Date {
  return new Date(date.getTime() + SGT_OFFSET_MS);
}

function sgtDayIndex(date: Date): number {
  return Math.floor((date.getTime() + SGT_OFFSET_MS) / DAY_MS);
}

// '9:00am', '11:59pm', midnight as '12:00am', noon as '12:00pm'.
export function formatSgtTime(date: Date): string {
  const shifted = sgtShifted(date);
  const hour24 = shifted.getUTCHours();
  const meridiem = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(shifted.getUTCMinutes()).padStart(2, "0")}${meridiem}`;
}

// 'Fri 6 Nov'
function formatSgtDateParts(date: Date): string {
  const shifted = sgtShifted(date);
  return `${WEEKDAY_SHORT[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${MONTH_SHORT[shifted.getUTCMonth()]}`;
}

// 'Fri 6 Nov, 11:59pm'. Empty string for unparseable input.
export function formatSgtDateTime(iso: string): string {
  const date = parseIso(iso);
  if (date == null) return "";
  return `${formatSgtDateParts(date)}, ${formatSgtTime(date)}`;
}

// 'Fri 6 Nov'. Empty string for unparseable input.
export function formatSgtDateShort(iso: string): string {
  const date = parseIso(iso);
  if (date == null) return "";
  return formatSgtDateParts(date);
}

// Due line for a finished task: never overdue-flavoured, the work is closed.
// 'Done' or 'Done, was due Fri 30 Oct' with the date as history, not pressure.
export function formatDoneDueLine(iso: string | null): string {
  const due = parseIso(iso);
  if (due == null) return "Done";
  return `Done, was due ${formatSgtDateParts(due)}`;
}

// Due line for a task row. Calendar-day overdue counting in Singapore time,
// so a deadline that passed at 11:59pm reads 'Overdue by 1 day' at 12:01am.
export function formatDueLine(iso: string | null, now: Date): DueLine {
  const due = parseIso(iso);
  if (due == null) return { text: "No deadline", overdue: false };
  if (due.getTime() < now.getTime()) {
    const days = sgtDayIndex(now) - sgtDayIndex(due);
    if (days <= 0) return { text: "Overdue today", overdue: true };
    return { text: `Overdue by ${days} day${days === 1 ? "" : "s"}`, overdue: true };
  }
  const dueDay = sgtDayIndex(due);
  const todayDay = sgtDayIndex(now);
  if (dueDay === todayDay) return { text: `Today, ${formatSgtTime(due)}`, overdue: false };
  if (dueDay === todayDay + 1) return { text: `Tomorrow, ${formatSgtTime(due)}`, overdue: false };
  return { text: `${formatSgtDateParts(due)}, ${formatSgtTime(due)}`, overdue: false };
}

// 'TUE 3 NOV' header stamp for the nav pill.
export function todayHeading(now: Date): string {
  const shifted = sgtShifted(now);
  return `${WEEKDAY_SHORT[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${MONTH_SHORT[shifted.getUTCMonth()]}`.toUpperCase();
}

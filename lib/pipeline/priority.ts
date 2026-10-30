// Pure priority scoring for the task list. Spec: docs/ARCHITECTURE.md 4.4.
// score = urgency(hoursUntilDue) * KIND_WEIGHT[kind] * EFFORT_FACTOR[effort].
// Every constant below is tunable; tests assert ordering, not exact values.

import type { TaskEffort, TaskRow } from "@/lib/db/types";

export const KIND_WEIGHT: Record<TaskRow["kind"], number> = {
  test: 1.3,
  assignment: 1.2,
  review: 1.0,
  math_practice: 1.0,
  reading: 0.8,
  other: 0.7,
};

export const EFFORT_FACTOR: Record<TaskEffort, number> = {
  large: 1.2,
  medium: 1.0,
  small: 0.9,
};

// A task whose effort the model never stated behaves like medium.
export const DEFAULT_EFFORT_FACTOR = 1.0;

// Urgency curve, piecewise linear in hours until due, monotone non-increasing:
//   overdue:   10, growing +1 per day overdue, capped after 7 days (max 17, so
//              a task three weeks late cannot swamp everything forever).
//   due now:   8, decaying to 6 at 24h (due in hours beats tomorrow).
//   24h..1 wk: 6 decaying to 4 (tomorrow beats next week).
//   1 wk..1 mo: 4 decaying to 2, then flat 2 for anything further out.
//   no due:    1 (lowest, still positive so it never drops out of the list).
export const URGENCY = {
  overdueBase: 10,
  overdueCapDays: 7,
  dueNow: 8,
  tomorrow: 6,
  week: 4,
  monthFloor: 2,
  none: 1,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Singapore calendar days: fixed UTC+8, no DST. SGT day number is epoch days
// shifted by 8h; epoch day 0 (1970-01-01) was a Thursday, hence the +3 offset.
const SGT_OFFSET_MS = 8 * HOUR_MS;

function parseTime(iso: string | null): number | null {
  if (iso == null) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

export function urgency(hoursUntilDue: number | null): number {
  if (hoursUntilDue == null) return URGENCY.none;
  if (hoursUntilDue < 0) {
    return URGENCY.overdueBase + Math.min(-hoursUntilDue / 24, URGENCY.overdueCapDays);
  }
  if (hoursUntilDue <= 24) {
    return URGENCY.tomorrow + (URGENCY.dueNow - URGENCY.tomorrow) * (1 - hoursUntilDue / 24);
  }
  if (hoursUntilDue <= 24 * 7) {
    return URGENCY.week + (URGENCY.tomorrow - URGENCY.week) * (1 - (hoursUntilDue - 24) / (24 * 6));
  }
  return Math.max(
    URGENCY.monthFloor,
    URGENCY.week - ((hoursUntilDue - 24 * 7) / (24 * 30)) * (URGENCY.week - URGENCY.monthFloor),
  );
}

export function scoreTask(task: Pick<TaskRow, "kind" | "due_at" | "effort">, now: Date): number {
  const due = parseTime(task.due_at);
  const hoursUntilDue = due == null ? null : (due - now.getTime()) / HOUR_MS;
  const effortFactor = task.effort == null ? DEFAULT_EFFORT_FACTOR : EFFORT_FACTOR[task.effort];
  return urgency(hoursUntilDue) * KIND_WEIGHT[task.kind] * effortFactor;
}

export function sortByPriority<T extends Pick<TaskRow, "kind" | "due_at" | "effort" | "created_at">>(
  tasks: T[],
  now: Date,
): T[] {
  // Decorate with the original index so the order is stable on every engine.
  const decorated = tasks.map((task, index) => ({ task, index, score: scoreTask(task, now) }));
  decorated.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const dueA = parseTime(a.task.due_at);
    const dueB = parseTime(b.task.due_at);
    if (dueA !== dueB) {
      if (dueA == null) return 1; // null due dates tiebreak last
      if (dueB == null) return -1;
      return dueA - dueB;
    }
    const createdA = parseTime(a.task.created_at);
    const createdB = parseTime(b.task.created_at);
    if (createdA !== createdB) return (createdA ?? 0) - (createdB ?? 0);
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.task);
}

export type Bucket = "overdue" | "today" | "this_week" | "later";

function sgtDayNumber(timeMs: number): number {
  return Math.floor((timeMs + SGT_OFFSET_MS) / DAY_MS);
}

function sgtWeekdayMonday0(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

// Overdue is decided on the instant (a deadline that passed this morning is
// overdue, not "today"); day boundaries are Singapore calendar days.
export function bucketOf(task: Pick<TaskRow, "due_at">, now: Date): Bucket {
  const due = parseTime(task.due_at);
  if (due == null) return "later";
  const nowMs = now.getTime();
  if (due < nowMs) return "overdue";
  const dueDay = sgtDayNumber(due);
  const todayDay = sgtDayNumber(nowMs);
  if (dueDay === todayDay) return "today";
  const weekStartDay = todayDay - sgtWeekdayMonday0(todayDay);
  if (dueDay <= weekStartDay + 6) return "this_week";
  return "later";
}

export function groupByBucket<T extends Pick<TaskRow, "kind" | "due_at" | "effort" | "created_at">>(
  tasks: T[],
  now: Date,
): Record<Bucket, T[]> {
  const buckets: Record<Bucket, T[]> = { overdue: [], today: [], this_week: [], later: [] };
  for (const task of tasks) buckets[bucketOf(task, now)].push(task);
  for (const key of Object.keys(buckets) as Bucket[]) buckets[key] = sortByPriority(buckets[key], now);
  return buckets;
}

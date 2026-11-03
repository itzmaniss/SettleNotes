// Pure spaced-review scheduling for weak spots (PRD F4). Singapore is fixed
// UTC+8 with no DST, so day maths run on SGT calendar days via the same
// shifted-epoch trick as lib/pipeline/dates.ts. The due moment is the END of
// the target SGT day (23:59), so a review only turns overdue once that whole
// day is gone.

export const REVIEW_SPACING = {
  firstGapDays: 3,
  laterGapDays: 1,
  recurringFromOccurrences: 3,
  dueHourSgt: 23,
  dueMinuteSgt: 59,
} as const;

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Whole days since 1970-01-01 counted in SGT calendar terms.
function sgtDayIndex(date: Date): number {
  return Math.floor((date.getTime() + SGT_OFFSET_MS) / DAY_MS);
}

// A non-integer or non-positive count means the row was just created, so it
// schedules like a first occurrence.
function normalizeOccurrences(occurrences: number): number {
  if (!Number.isInteger(occurrences) || occurrences < 1) return 1;
  return occurrences;
}

export type ReviewSchedule = { dueAt: string; daysAhead: 1 | 3; recurring: boolean };

// 1st occurrence lands +3 SGT days out, every later one +1 day and flagged
// recurring from the third. dueAt is that target SGT day at 23:59 SGT as a
// UTC ISO string.
export function scheduleReview(occurrences: number, now: Date): ReviewSchedule {
  const count = normalizeOccurrences(occurrences);
  const daysAhead: 1 | 3 =
    count === 1 ? REVIEW_SPACING.firstGapDays : REVIEW_SPACING.laterGapDays;
  // A day index D spans epoch [D*day - 8h, (D+1)*day - 8h); adding the 23:59
  // wall time onto D*day - 8h lands at 15:59 UTC of the same SGT day.
  const dueMs =
    (sgtDayIndex(now) + daysAhead) * DAY_MS -
    SGT_OFFSET_MS +
    (REVIEW_SPACING.dueHourSgt * 60 + REVIEW_SPACING.dueMinuteSgt) * 60 * 1000;
  return {
    dueAt: new Date(dueMs).toISOString(),
    daysAhead,
    recurring: count >= REVIEW_SPACING.recurringFromOccurrences,
  };
}

// ---- quiz outcome scheduling -------------------------------------------------

// After a quiz went well (2 or more right) the slip has stuck for now, so the
// weak spot's next review moves a full week out. The due moment is the same
// end of a SGT day as every other review due date.
export const QUIZ_SUCCESS_GAP_DAYS = 7;

export type QuizSuccessSchedule = { dueAt: string };

// Pure helper used by the review quiz flow when the student does well. It
// does not touch occurrences: only a new diagnosis may bump that counter.
export function scheduleReviewAfterQuizSuccess(now: Date): QuizSuccessSchedule {
  const dueMs =
    (sgtDayIndex(now) + QUIZ_SUCCESS_GAP_DAYS) * DAY_MS -
    SGT_OFFSET_MS +
    (REVIEW_SPACING.dueHourSgt * 60 + REVIEW_SPACING.dueMinuteSgt) * 60 * 1000;
  return { dueAt: new Date(dueMs).toISOString() };
}

// 'tomorrow' when the due SGT date is the next SGT day, else the short
// weekday ('Fri'). Empty string for unparseable input.
export function reviewDayWord(dueAtIso: string, now: Date): string {
  const due = new Date(dueAtIso);
  if (Number.isNaN(due.getTime())) return "";
  if (sgtDayIndex(due) === sgtDayIndex(now) + 1) return "tomorrow";
  const shifted = new Date(due.getTime() + SGT_OFFSET_MS);
  return WEEKDAY_SHORT[shifted.getUTCDay()];
}

export type ReviewReplyInfo = { occurrences: number; dueAt: string; now: Date };

// The sentence the bot appends after recording a weak spot. Plain text, no
// dashes, so it survives any Telegram parse mode.
export function reviewReply({ occurrences, dueAt, now }: ReviewReplyInfo): string {
  const day = reviewDayWord(dueAt, now);
  if (normalizeOccurrences(occurrences) >= REVIEW_SPACING.recurringFromOccurrences) {
    return `This one keeps coming up, so I've added a quick review for ${day}.`;
  }
  return `I've added a review for ${day} so this sticks.`;
}

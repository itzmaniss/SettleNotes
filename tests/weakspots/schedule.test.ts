import { describe, expect, test } from "bun:test";
import { REVIEW_SPACING, reviewDayWord, reviewReply, scheduleReview } from "../../lib/weakspots/schedule";

// 09:00 SGT, Wednesday 28 October 2026.
const NOW = new Date("2026-10-28T01:00:00.000Z");
// 18:00 SGT, Friday 30 October 2026.
const LATER = new Date("2026-10-30T10:00:00.000Z");

function assertNoDashes(text: string): void {
  expect(text.includes("\u2014")).toBe(false);
  expect(text.includes("\u2013")).toBe(false);
}

describe("REVIEW_SPACING", () => {
  test("encodes the PRD spacing", () => {
    expect(REVIEW_SPACING.firstGapDays).toBe(3);
    expect(REVIEW_SPACING.laterGapDays).toBe(1);
    expect(REVIEW_SPACING.recurringFromOccurrences).toBe(3);
    expect(REVIEW_SPACING.dueHourSgt).toBe(23);
    expect(REVIEW_SPACING.dueMinuteSgt).toBe(59);
  });
});

describe("scheduleReview", () => {
  test("1st occurrence: +3 days at 23:59 SGT, not recurring", () => {
    expect(scheduleReview(1, NOW)).toEqual({
      dueAt: "2026-10-31T15:59:00.000Z", // Sat 31 Oct, 11:59pm SGT
      daysAhead: 3,
      recurring: false,
    });
  });

  test("2nd occurrence: +1 day, not recurring", () => {
    expect(scheduleReview(2, NOW)).toEqual({
      dueAt: "2026-10-29T15:59:00.000Z", // Thu 29 Oct, 11:59pm SGT
      daysAhead: 1,
      recurring: false,
    });
  });

  test("3rd and 7th: +1 day and recurring", () => {
    const third = scheduleReview(3, NOW);
    expect(third.daysAhead).toBe(1);
    expect(third.recurring).toBe(true);
    expect(third.dueAt).toBe("2026-10-29T15:59:00.000Z");
    const seventh = scheduleReview(7, NOW);
    expect(seventh.daysAhead).toBe(1);
    expect(seventh.recurring).toBe(true);
    expect(seventh.dueAt).toBe("2026-10-29T15:59:00.000Z");
  });

  test("0 and non-integer counts schedule like a first occurrence", () => {
    expect(scheduleReview(0, NOW).daysAhead).toBe(3);
    expect(scheduleReview(0, NOW).recurring).toBe(false);
    expect(scheduleReview(2.5, NOW).daysAhead).toBe(3);
    expect(scheduleReview(2.5, NOW).recurring).toBe(false);
    expect(scheduleReview(2.5, NOW).dueAt).toBe("2026-10-31T15:59:00.000Z");
  });

  test("SGT boundary: 17:30Z is already the next SGT day", () => {
    // 2026-10-31T17:30Z is 01:30 SGT on Sunday 1 November.
    const now = new Date("2026-10-31T17:30:00.000Z");
    expect(scheduleReview(1, now).dueAt).toBe("2026-11-04T15:59:00.000Z");
    expect(scheduleReview(2, now).dueAt).toBe("2026-11-02T15:59:00.000Z");
  });

  test("month and year rollover from 30 December", () => {
    // 2026-12-30T10:00Z is 18:00 SGT; +3 SGT days is 2 January 2027.
    const now = new Date("2026-12-30T10:00:00.000Z");
    expect(scheduleReview(1, now).dueAt).toBe("2027-01-02T15:59:00.000Z");
  });
});

describe("reviewDayWord", () => {
  test("due day three SGT days out reads as the short weekday", () => {
    expect(reviewDayWord("2026-10-31T15:59:00.000Z", NOW)).toBe("Sat");
  });

  test("due next SGT day reads as tomorrow", () => {
    expect(reviewDayWord("2026-10-31T15:59:00.000Z", LATER)).toBe("tomorrow");
  });

  test("unparseable input is empty", () => {
    expect(reviewDayWord("not a date", NOW)).toBe("");
  });
});

describe("reviewReply", () => {
  test("first occurrence names the weekday", () => {
    const reply = reviewReply({ occurrences: 1, dueAt: "2026-10-31T15:59:00.000Z", now: NOW });
    expect(reply).toBe("I've added a review for Sat so this sticks.");
    assertNoDashes(reply);
  });

  test("second occurrence reads tomorrow", () => {
    const reply = reviewReply({ occurrences: 2, dueAt: "2026-10-31T15:59:00.000Z", now: LATER });
    expect(reply).toBe("I've added a review for tomorrow so this sticks.");
    assertNoDashes(reply);
  });

  test("third and later get the recurring wording", () => {
    const third = reviewReply({ occurrences: 3, dueAt: "2026-10-31T15:59:00.000Z", now: LATER });
    expect(third).toBe("This one keeps coming up, so I've added a quick review for tomorrow.");
    assertNoDashes(third);
    const fifth = reviewReply({ occurrences: 5, dueAt: "2026-10-31T15:59:00.000Z", now: NOW });
    expect(fifth).toBe("This one keeps coming up, so I've added a quick review for Sat.");
    assertNoDashes(fifth);
  });
});

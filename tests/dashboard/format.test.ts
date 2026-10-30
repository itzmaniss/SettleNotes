import { describe, expect, test } from "bun:test";
import {
  formatDoneDueLine,
  formatDueLine,
  formatSgtDateShort,
  formatSgtDateTime,
  formatSgtTime,
  todayHeading,
} from "@/lib/dashboard/format";

// Reference instants. SGT is UTC+8 all year.
// now = Tue 3 Nov 2026, 12:00pm SGT (mock header says TUE 3 NOV).
const NOW = new Date("2026-11-03T04:00:00.000Z");

describe("formatSgtTime", () => {
  test("morning, evening and midnight rollovers", () => {
    expect(formatSgtTime(new Date("2026-11-03T01:00:00.000Z"))).toBe("9:00am");
    expect(formatSgtTime(new Date("2026-11-03T15:59:00.000Z"))).toBe("11:59pm");
    expect(formatSgtTime(new Date("2026-11-03T16:00:00.000Z"))).toBe("12:00am");
    expect(formatSgtTime(new Date("2026-11-03T04:00:00.000Z"))).toBe("12:00pm");
  });
});

describe("formatSgtDateTime and formatSgtDateShort", () => {
  test("weekday, day, month, time", () => {
    expect(formatSgtDateTime("2026-11-06T15:59:00.000Z")).toBe("Fri 6 Nov, 11:59pm");
    expect(formatSgtDateShort("2026-11-06T15:59:00.000Z")).toBe("Fri 6 Nov");
  });

  test("unparseable input is empty", () => {
    expect(formatSgtDateTime("nope")).toBe("");
    expect(formatSgtDateShort("nope")).toBe("");
  });
});

describe("formatDueLine", () => {
  test("null means no deadline", () => {
    expect(formatDueLine(null, NOW)).toEqual({ text: "No deadline", overdue: false });
  });

  test("unparseable means no deadline", () => {
    expect(formatDueLine("garbage", NOW)).toEqual({ text: "No deadline", overdue: false });
  });

  test("same Singapore calendar day", () => {
    expect(formatDueLine("2026-11-03T15:59:00.000Z", NOW)).toEqual({
      text: "Today, 11:59pm",
      overdue: false,
    });
  });

  test("next calendar day", () => {
    expect(formatDueLine("2026-11-04T01:00:00.000Z", NOW)).toEqual({
      text: "Tomorrow, 9:00am",
      overdue: false,
    });
  });

  test("beyond tomorrow shows weekday, date and time", () => {
    expect(formatDueLine("2026-11-06T15:59:00.000Z", NOW)).toEqual({
      text: "Fri 6 Nov, 11:59pm",
      overdue: false,
    });
  });

  test("overdue earlier today is not counted in days", () => {
    expect(formatDueLine("2026-11-03T01:00:00.000Z", NOW)).toEqual({
      text: "Overdue today",
      overdue: true,
    });
  });

  test("overdue by whole Singapore calendar days", () => {
    expect(formatDueLine("2026-11-01T15:59:00.000Z", NOW)).toEqual({
      text: "Overdue by 2 days",
      overdue: true,
    });
    expect(formatDueLine("2026-11-02T15:59:00.000Z", NOW)).toEqual({
      text: "Overdue by 1 day",
      overdue: true,
    });
  });

  test("Singapore midnight boundary: due 31 Oct 11:59pm, now 1 Nov 12:00am", () => {
    const now = new Date("2026-11-01T16:00:00.000Z");
    expect(formatDueLine("2026-11-01T15:59:00.000Z", now)).toEqual({
      text: "Overdue by 1 day",
      overdue: true,
    });
  });
});

describe("formatDoneDueLine", () => {
  test("done with no or unparseable deadline reads just Done", () => {
    expect(formatDoneDueLine(null)).toBe("Done");
    expect(formatDoneDueLine("garbage")).toBe("Done");
  });

  test("done keeps the old date as history, never overdue wording", () => {
    expect(formatDoneDueLine("2026-10-30T15:59:00.000Z")).toBe("Done, was due Fri 30 Oct");
    expect(formatDoneDueLine("2026-11-03T01:00:00.000Z")).not.toMatch(/[Oo]verdue/);
  });
});

describe("todayHeading", () => {
  test("nav stamp in SGT", () => {
    expect(todayHeading(NOW)).toBe("TUE 3 NOV");
    expect(todayHeading(new Date("2026-11-03T15:59:00.000Z"))).toBe("TUE 3 NOV");
    expect(todayHeading(new Date("2026-11-03T16:00:00.000Z"))).toBe("WED 4 NOV");
  });
});

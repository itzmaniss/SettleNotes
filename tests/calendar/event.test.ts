import { describe, expect, test } from "bun:test";
import {
  buildEvent,
  CALENDAR_NAME,
  EVENT_DURATION_MINUTES,
  eventHash,
  isSyncable,
  REMINDER_MINUTES,
  type CalendarTask,
} from "../../lib/calendar/event";

function task(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    title: "Math assignment",
    course: "E-Math",
    due_at: "2026-10-31T16:00:00.000Z",
    status: "open",
    ...over,
  };
}

describe("calendar event shape", () => {
  test("constants hold the agreed shape", () => {
    expect(EVENT_DURATION_MINUTES).toBe(15);
    expect(REMINDER_MINUTES).toEqual([1440, 60]);
    expect(CALENDAR_NAME).toBe("Settle");
  });

  test("midnight SGT deadline starts at midnight with +08:00", () => {
    const event = buildEvent(task({ due_at: "2026-10-31T16:00:00.000Z" }));
    expect(event.summary).toBe("Math assignment");
    expect(event.description).toContain("E-Math");
    expect(event.description).toContain("Added by SettleNotes");
    expect(event.start).toEqual({ dateTime: "2026-11-01T00:00:00+08:00", timeZone: "Asia/Singapore" });
    expect(event.end).toEqual({ dateTime: "2026-11-01T00:15:00+08:00", timeZone: "Asia/Singapore" });
    expect(event.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 1440 },
        { method: "popup", minutes: 60 },
      ],
    });
  });

  test("23:59 deadline ends after midnight", () => {
    const event = buildEvent(task({ due_at: "2026-11-01T15:59:00.000Z" }));
    expect(event.start.dateTime).toBe("2026-11-01T23:59:00+08:00");
    expect(event.end.dateTime).toBe("2026-11-02T00:14:00+08:00");
  });

  test("course is optional in the description", () => {
    const event = buildEvent(task({ course: null }));
    expect(event.description).toBe("Added by SettleNotes");
  });

  test("hostile titles are stripped of controls and capped at 200 chars", () => {
    const event = buildEvent(task({ title: "line one\nline two\r\n\twith tab" }));
    expect(event.summary).not.toContain("\n");
    expect(event.summary).toBe("line oneline twowith tab");

    const long = buildEvent(task({ title: "z".repeat(5000) }));
    expect(long.summary).toHaveLength(200);

    const markup = buildEvent(task({ title: "**bold** and </script> tag" }));
    expect(markup.summary).toBe("**bold** and </script> tag");
    expect(() => JSON.stringify(markup)).not.toThrow();
  });

  test("no due date is not syncable and buildEvent throws", () => {
    const dateless = task({ due_at: null });
    expect(isSyncable(dateless)).toBe(false);
    expect(() => buildEvent(dateless)).toThrow(/due date/);
  });

  test("done and dismissed tasks are not syncable", () => {
    expect(isSyncable(task({ status: "done" }))).toBe(false);
    expect(isSyncable(task({ status: "dismissed" }))).toBe(false);
    expect(isSyncable(task())).toBe(true);
  });

  test("eventHash is stable and changes with the body", () => {
    const first = buildEvent(task());
    expect(eventHash(first)).toBe(eventHash(buildEvent(task())));
    expect(eventHash(first)).not.toBe(eventHash(buildEvent(task({ title: "Other" }))));
    expect(eventHash(first)).toMatch(/^[0-9a-f]{64}$/);
  });
});

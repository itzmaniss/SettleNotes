import { describe, expect, test } from "bun:test";
import { describeTaskEvent, eventChangedDueAt, eventWording } from "@/lib/dashboard/history";
import { event } from "./fixtures";

describe("eventWording", () => {
  test("fixed wording per action", () => {
    expect(eventWording("created")).toBe("Added");
    expect(eventWording("updated")).toBe("Moved");
    expect(eventWording("completed")).toBe("Ticked off");
    expect(eventWording("reopened")).toBe("Reopened");
  });
});

describe("eventChangedDueAt", () => {
  test("true only for a real deadline change", () => {
    expect(eventChangedDueAt({ dueAt: "2026-11-05T00:00:00.000Z" }, { dueAt: "2026-11-06T00:00:00.000Z" })).toBe(true);
    expect(eventChangedDueAt({ dueAt: "2026-11-05T00:00:00.000Z" }, { title: "x" })).toBe(false);
    expect(eventChangedDueAt(null, { dueAt: "2026-11-06T00:00:00.000Z" })).toBe(false);
    expect(eventChangedDueAt("junk", { dueAt: "2026-11-06T00:00:00.000Z" })).toBe(false);
  });
});

describe("describeTaskEvent", () => {
  test("created events say Added with no change line", () => {
    const summary = describeTaskEvent(event({ action: "created" }));
    expect(summary.action).toBe("Added");
    expect(summary.change).toBeNull();
  });

  test("completed events say Ticked off", () => {
    const summary = describeTaskEvent(
      event({ action: "completed", before: { status: "open" }, after: { status: "done" } }),
    );
    expect(summary.action).toBe("Ticked off");
    expect(summary.change).toBeNull();
  });

  test("due date move reads from X to Y", () => {
    const summary = describeTaskEvent(
      event({
        action: "updated",
        before: { dueAt: "2026-11-05T15:59:00.000Z" },
        after: { dueAt: "2026-11-13T15:59:00.000Z" },
      }),
    );
    expect(summary.action).toBe("Moved");
    expect(summary.change).toBe("due date from Thu 5 Nov, 11:59pm to Fri 13 Nov, 11:59pm");
  });

  test("title, course, kind and effort changes are listed", () => {
    const summary = describeTaskEvent(
      event({
        action: "updated",
        before: { title: "Lab 4", course: "CS2040", kind: "assignment", effort: "small" },
        after: { title: "CS2040 Lab 4", course: "CS2040R", kind: "test", effort: "large" },
      }),
    );
    expect(summary.change).toBe(
      'title "Lab 4" to "CS2040 Lab 4", course "CS2040" to "CS2040R", kind "assignment" to "test", effort "small" to "large"',
    );
  });

  test("untyped garbage in before/after never crashes and reports nothing", () => {
    expect(describeTaskEvent(event({ before: "junk", after: null })).change).toBeNull();
    expect(describeTaskEvent(event({ before: 3, after: [1, 2] })).change).toBeNull();
    expect(
      describeTaskEvent(event({ before: { dueAt: 42 }, after: { dueAt: true } })).change,
    ).toBeNull();
  });
});

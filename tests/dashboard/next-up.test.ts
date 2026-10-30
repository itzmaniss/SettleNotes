import { describe, expect, test } from "bun:test";
import { groupForDashboard, pickNextUp } from "@/lib/dashboard/next-up";
import { task } from "./fixtures";

// Wed 4 Nov 2026, 12:00pm SGT.
const NOW = new Date("2026-11-04T04:00:00.000Z");

describe("pickNextUp", () => {
  test("picks the highest priority open task", () => {
    const sooner = task({ id: "sooner", kind: "test", due_at: "2026-11-04T06:00:00.000Z" });
    const later = task({ id: "later", kind: "assignment", due_at: "2026-11-20T00:00:00.000Z" });
    expect(pickNextUp([later, sooner], NOW)?.id).toBe("sooner");
  });

  test("ignores done and dismissed tasks", () => {
    const done = task({ id: "done", kind: "test", due_at: "2026-11-04T06:00:00.000Z", status: "done" });
    const open = task({ id: "open", kind: "reading", due_at: "2026-12-01T00:00:00.000Z" });
    expect(pickNextUp([done, open], NOW)?.id).toBe("open");
    expect(pickNextUp([done], NOW)).toBeNull();
  });

  test("empty list gives null", () => {
    expect(pickNextUp([], NOW)).toBeNull();
  });
});

describe("groupForDashboard", () => {
  test("buckets by Singapore calendar day and week, ordered, empties skipped", () => {
    const overdue = task({ id: "overdue", due_at: "2026-11-03T01:00:00.000Z" });
    const today = task({ id: "today", due_at: "2026-11-04T10:00:00.000Z" });
    const thisWeek = task({ id: "week", due_at: "2026-11-06T10:00:00.000Z" });
    const later = task({ id: "later", due_at: "2026-12-01T10:00:00.000Z" });
    const noDue = task({ id: "noDue", due_at: null });

    const sections = groupForDashboard([later, noDue, thisWeek, today, overdue], NOW);
    expect(sections.map((section) => section.bucket)).toEqual(["overdue", "today", "this_week", "later"]);
    expect(sections.map((section) => section.label)).toEqual(["Overdue", "Today", "This week", "Later"]);
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["overdue"]);
    expect(sections[1].tasks.map((t) => t.id)).toEqual(["today"]);
    expect(sections[2].tasks.map((t) => t.id)).toEqual(["week"]);
    expect(sections[3].tasks.map((t) => t.id)).toEqual(["later", "noDue"]);
  });

  test("empty buckets are dropped entirely", () => {
    const today = task({ id: "today", due_at: "2026-11-04T10:00:00.000Z" });
    const sections = groupForDashboard([today], NOW);
    expect(sections.map((section) => section.bucket)).toEqual(["today"]);
  });

  test("no tasks gives no sections", () => {
    expect(groupForDashboard([], NOW)).toEqual([]);
  });

  test("done tasks leave the buckets and land in a final Done section, newest first", () => {
    const overdue = task({ id: "overdue", due_at: "2026-11-03T01:00:00.000Z" });
    const doneRecent = task({
      id: "done-recent",
      status: "done",
      due_at: "2026-11-01T01:00:00.000Z",
      updated_at: "2026-11-04T00:00:00.000Z",
    });
    const doneOlder = task({
      id: "done-older",
      status: "done",
      due_at: "2026-11-02T01:00:00.000Z",
      updated_at: "2026-11-03T00:00:00.000Z",
    });
    const sections = groupForDashboard([doneOlder, overdue, doneRecent], NOW);
    expect(sections.map((section) => section.bucket)).toEqual(["overdue", "done"]);
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["overdue"]);
    expect(sections[1].label).toBe("Done");
    expect(sections[1].tasks.map((t) => t.id)).toEqual(["done-recent", "done-older"]);
  });

  test("a done task due in the future never lands in Today or This week", () => {
    const done = task({ id: "done", status: "done", due_at: "2026-11-05T10:00:00.000Z" });
    const sections = groupForDashboard([done], NOW);
    expect(sections.map((section) => section.bucket)).toEqual(["done"]);
  });
});

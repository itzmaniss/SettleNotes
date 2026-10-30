import { describe, expect, test } from "bun:test";
import { kindSticker, statusSticker } from "@/lib/dashboard/stickers";
import { event, task } from "./fixtures";

const NOW = new Date("2026-11-03T04:00:00.000Z");

describe("kindSticker", () => {
  test("known kinds map to a label and tone", () => {
    expect(kindSticker("test")).toEqual({ label: "test", tone: "pop" });
    expect(kindSticker("assignment")).toEqual({ label: "assignment", tone: "card" });
    expect(kindSticker("review")).toEqual({ label: "review", tone: "accent" });
    expect(kindSticker("math_practice")).toEqual({ label: "math", tone: "card" });
    expect(kindSticker("reading")).toEqual({ label: "reading", tone: "card" });
  });

  test("other gets no sticker", () => {
    expect(kindSticker("other")).toBeNull();
  });
});

describe("statusSticker", () => {
  test("moved when the latest event updated the due date", () => {
    const moved = event({
      action: "updated",
      before: { dueAt: "2026-11-05T15:59:00.000Z" },
      after: { dueAt: "2026-11-13T15:59:00.000Z" },
      evidence: "prof say extend to nxt fri liao",
    });
    expect(statusSticker(task({ due_at: "2026-11-13T15:59:00.000Z" }), moved, NOW)).toEqual({
      label: "moved",
      tone: "pop",
    });
  });

  test("moved wins over overdue", () => {
    const moved = event({
      action: "updated",
      before: { dueAt: "2026-11-01T00:00:00.000Z" },
      after: { dueAt: "2026-11-02T00:00:00.000Z" },
    });
    const late = task({ due_at: "2026-11-01T00:00:00.000Z" });
    expect(statusSticker(late, moved, NOW)).toEqual({ label: "moved", tone: "pop" });
  });

  test("overdue when past due and the latest event is not a due-date move", () => {
    const completed = event({ action: "completed", before: { status: "open" }, after: { status: "done" } });
    const late = task({ due_at: "2026-11-01T00:00:00.000Z" });
    expect(statusSticker(late, completed, NOW)).toEqual({ label: "overdue", tone: "destructive" });
    expect(statusSticker(late, null, NOW)).toEqual({ label: "overdue", tone: "destructive" });
  });

  test("an update that changed the title only is not a move", () => {
    const renamed = event({
      action: "updated",
      before: { title: "Lab 4" },
      after: { title: "CS2040 Lab 4" },
    });
    const future = task({ due_at: "2026-11-13T00:00:00.000Z" });
    expect(statusSticker(future, renamed, NOW)).toBeNull();
  });

  test("equal instants in different formats are not a move", () => {
    // 2026-11-13T23:59:00+08:00 is the same instant as 2026-11-13T15:59Z.
    const sameInstant = event({
      action: "updated",
      before: { dueAt: "2026-11-13T15:59:00.000Z" },
      after: { dueAt: "2026-11-13T23:59:00.000+08:00" },
    });
    const future = task({ due_at: "2026-11-13T15:59:00.000Z" });
    expect(statusSticker(future, sameInstant, NOW)).toBeNull();
  });

  test("no due date and no relevant event gives no sticker", () => {
    expect(statusSticker(task({ due_at: null }), null, NOW)).toBeNull();
    expect(statusSticker(task({ due_at: "garbage" }), null, NOW)).toBeNull();
  });
});

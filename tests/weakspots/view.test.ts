import { describe, expect, test } from "bun:test";
import type { TaskRow, WeakSpotRow } from "../../lib/db/types";
import { buildWeakSpotViewItems, weakSpotTopicLabel } from "../../lib/weakspots/view";
import { task, weakSpot } from "../dashboard/fixtures";

// Noon SGT, Tuesday 3 November 2026.
const NOW = new Date("2026-11-03T04:00:00.000Z");

function spot(overrides: Partial<WeakSpotRow> = {}): WeakSpotRow {
  return weakSpot({ id: "spot-1", ...overrides });
}

describe("weakSpotTopicLabel", () => {
  test("known topics use the friendly label", () => {
    expect(weakSpotTopicLabel("differentiation_chain_rule")).toBe("Chain rule");
  });

  test("unknown topics fall back to the raw string", () => {
    expect(weakSpotTopicLabel("odd topic")).toBe("odd topic");
  });
});

describe("buildWeakSpotViewItems", () => {
  test("maps counts, pips, recurrence and the last seen date", () => {
    const [item] = buildWeakSpotViewItems([spot({ occurrences: 3 })], new Map(), NOW);
    expect(item.topicLabel).toBe("Chain rule");
    expect(item.timesLine).toBe("3 times");
    expect(item.pips).toEqual({ segments: 3, filled: 3 });
    expect(item.recurring).toBe(true);
    expect(item.lastSeenLine).toBe("last seen Fri 30 Oct");
    expect(item.misconception).toBe("forgot the inner derivative");
  });

  test("recurring only from three occurrences", () => {
    const [one] = buildWeakSpotViewItems([spot({ occurrences: 1 })], new Map(), NOW);
    expect(one.recurring).toBe(false);
    expect(one.timesLine).toBe("1 time");
    expect(one.pips).toEqual({ segments: 3, filled: 1 });
    const [five] = buildWeakSpotViewItems([spot({ id: "s5", occurrences: 5 })], new Map(), NOW);
    expect(five.recurring).toBe(true);
    expect(five.pips).toEqual({ segments: 5, filled: 5 });
  });

  test("an open review task wins with a link and the due line", () => {
    const openTask: TaskRow = task({
      id: "review-9",
      kind: "review",
      due_at: "2026-11-05T15:59:00.000Z",
    });
    const [item] = buildWeakSpotViewItems(
      [spot()],
      new Map([["spot-1", openTask]]),
      NOW,
    );
    expect(item.review).toEqual({
      kind: "task",
      href: "/tasks/review-9",
      text: "Review due Thu 5 Nov, 11:59pm",
    });
  });

  test("without a task, next_review_at becomes the scheduled line", () => {
    const [item] = buildWeakSpotViewItems([spot()], new Map(), NOW);
    expect(item.review).toEqual({ kind: "scheduled", text: "Next review Fri 6 Nov" });
  });

  test("no task and no next review reads as nothing scheduled", () => {
    const [item] = buildWeakSpotViewItems([spot({ next_review_at: null })], new Map(), NOW);
    expect(item.review).toEqual({ kind: "none", text: "No review scheduled" });
  });

  test("an unparseable next review falls back to nothing scheduled", () => {
    const [item] = buildWeakSpotViewItems(
      [spot({ next_review_at: "not a date" })],
      new Map(),
      NOW,
    );
    expect(item.review).toEqual({ kind: "none", text: "No review scheduled" });
  });

  test("row order is preserved; the query already sorts", () => {
    const items = buildWeakSpotViewItems(
      [spot({ id: "a", occurrences: 1 }), spot({ id: "b", occurrences: 4 })],
      new Map(),
      NOW,
    );
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("unknown topics keep the raw label in the view model", () => {
    const [item] = buildWeakSpotViewItems([spot({ topic: "odd topic" })], new Map(), NOW);
    expect(item.topicLabel).toBe("odd topic");
  });
});

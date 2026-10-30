import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EFFORT_FACTOR,
  EFFORT_FACTOR,
  KIND_WEIGHT,
  URGENCY,
  bucketOf,
  groupByBucket,
  scoreTask,
  sortByPriority,
  urgency,
  type Bucket,
} from "../../lib/pipeline/priority";
import type { TaskEffort, TaskKind } from "../../lib/db/types";

// Wed 4 Nov 2026, 13:00 SGT. That makes the current SGT week Mon 2 .. Sun 8 Nov.
const NOW = new Date("2026-11-04T05:00:00.000Z");

const mkTask = (over: {
  id?: string;
  kind?: TaskKind;
  due_at?: string | null;
  effort?: TaskEffort | null;
  created_at?: string;
}) => ({
  id: over.id ?? "t1",
  kind: over.kind ?? ("assignment" as TaskKind),
  due_at: over.due_at !== undefined ? over.due_at : "2026-11-05T15:59:00.000Z",
  effort: over.effort !== undefined ? over.effort : ("medium" as TaskEffort | null),
  created_at: over.created_at ?? "2026-11-04T00:00:00.000Z",
});

describe("tunable constants", () => {
  test("kind weights match ARCHITECTURE 4.4", () => {
    expect(KIND_WEIGHT).toEqual({
      test: 1.3,
      assignment: 1.2,
      review: 1.0,
      math_practice: 1.0,
      reading: 0.8,
      other: 0.7,
    });
  });

  test("effort factors match ARCHITECTURE 4.4 and null effort uses the default", () => {
    expect(EFFORT_FACTOR).toEqual({ large: 1.2, medium: 1.0, small: 0.9 });
    expect(DEFAULT_EFFORT_FACTOR).toBe(1.0);
  });
});

describe("urgency", () => {
  test("ordering: overdue > due in 2h > tomorrow > next week > a month out > none", () => {
    const values = [urgency(-2), urgency(2), urgency(24), urgency(24 * 7), urgency(24 * 30), urgency(null)];
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i]).toBeGreaterThan(values[i + 1]);
    }
    expect(urgency(null)).toBeGreaterThan(0);
  });

  test("more overdue scores higher but growth is capped", () => {
    expect(urgency(-48)).toBeGreaterThan(urgency(-24));
    expect(urgency(-24 * 30)).toBe(URGENCY.overdueBase + URGENCY.overdueCapDays);
    expect(urgency(-24 * 365)).toBe(urgency(-24 * 30));
  });

  test("dated tasks never decay below the month floor", () => {
    expect(urgency(24 * 365)).toBe(URGENCY.monthFloor);
  });
});

describe("scoreTask", () => {
  test("due in 2h beats tomorrow beats next week beats no due date", () => {
    const scores = [
      scoreTask(mkTask({ due_at: "2026-11-04T07:00:00.000Z" }), NOW), // 2h out
      scoreTask(mkTask({ due_at: "2026-11-05T05:00:00.000Z" }), NOW), // 24h out
      scoreTask(mkTask({ due_at: "2026-11-12T05:00:00.000Z" }), NOW), // ~1 week out
      scoreTask(mkTask({ due_at: null }), NOW),
    ];
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    }
  });

  test("same urgency: test beats assignment beats review/math_practice beats reading beats other", () => {
    const dueAt = "2026-11-05T15:59:00.000Z";
    const byKind = (kind: TaskKind) => scoreTask(mkTask({ kind, due_at: dueAt }), NOW);
    expect(byKind("test")).toBeGreaterThan(byKind("assignment"));
    expect(byKind("assignment")).toBeGreaterThan(byKind("review"));
    expect(byKind("review")).toBeCloseTo(byKind("math_practice"), 12);
    expect(byKind("review")).toBeGreaterThan(byKind("reading"));
    expect(byKind("reading")).toBeGreaterThan(byKind("other"));
  });

  test("effort factor tiebreaks: large > medium > small, null behaves like medium", () => {
    const dueAt = "2026-11-05T15:59:00.000Z";
    const byEffort = (effort: TaskEffort | null) => scoreTask(mkTask({ effort, due_at: dueAt }), NOW);
    expect(byEffort("large")).toBeGreaterThan(byEffort("medium"));
    expect(byEffort("medium")).toBeGreaterThan(byEffort("small"));
    expect(byEffort(null)).toBeCloseTo(byEffort("medium"), 12);
  });

  test("more overdue ranks higher within the same kind", () => {
    const less = scoreTask(mkTask({ due_at: "2026-11-03T05:00:00.000Z" }), NOW); // 1 day overdue
    const more = scoreTask(mkTask({ due_at: "2026-10-28T05:00:00.000Z" }), NOW); // 7 days overdue
    expect(more).toBeGreaterThan(less);
  });
});

describe("sortByPriority", () => {
  test("sorts descending by score and does not mutate the input", () => {
    const input = [
      mkTask({ id: "week", due_at: "2026-11-12T05:00:00.000Z" }),
      mkTask({ id: "overdue", due_at: "2026-11-03T05:00:00.000Z" }),
      mkTask({ id: "soon", due_at: "2026-11-04T07:00:00.000Z" }),
      mkTask({ id: "none", due_at: null }),
    ];
    const snapshot = [...input];
    const sorted = sortByPriority(input, NOW);
    expect(input).toEqual(snapshot); // non-mutating
    expect(sorted.map((task) => task.id)).toEqual(["overdue", "soon", "week", "none"]);
  });

  test("ties break by earlier due_at, then earlier created_at, then input order", () => {
    // review + medium gives weight and effort factor exactly 1.0, and any task
    // a week or more overdue sits on the capped urgency, so scores are exactly
    // equal while due dates differ.
    const input = [
      mkTask({
        id: "less-overdue",
        kind: "review",
        effort: "medium",
        due_at: "2026-10-28T05:00:00.000Z",
      }),
      mkTask({
        id: "more-overdue",
        kind: "review",
        effort: "medium",
        due_at: "2026-10-27T05:00:00.000Z",
      }),
    ];
    const sorted = sortByPriority(input, NOW);
    expect(sorted.map((task) => task.id)).toEqual(["more-overdue", "less-overdue"]);

    const sameDue = [
      mkTask({ id: "created-later", created_at: "2026-11-04T02:00:00.000Z", due_at: "2026-10-27T05:00:00.000Z" }),
      mkTask({ id: "created-earlier", created_at: "2026-11-03T02:00:00.000Z", due_at: "2026-10-27T05:00:00.000Z" }),
    ];
    expect(sortByPriority(sameDue, NOW).map((task) => task.id)).toEqual(["created-earlier", "created-later"]);

    const identical = [
      mkTask({ id: "a", created_at: "2026-11-03T02:00:00.000Z" }),
      mkTask({ id: "b", created_at: "2026-11-03T02:00:00.000Z" }),
    ];
    expect(sortByPriority(identical, NOW).map((task) => task.id)).toEqual(["a", "b"]);
  });

  test("null due dates sort last among equal scores", () => {
    const input = [
      mkTask({ id: "dated", kind: "review", effort: "medium", due_at: "2026-10-27T05:00:00.000Z" }),
      mkTask({ id: "undated", kind: "review", effort: "medium", due_at: null }),
    ];
    expect(sortByPriority(input, NOW).map((task) => task.id)).toEqual(["dated", "undated"]);
  });
});

describe("bucketOf (Singapore days, UTC+8)", () => {
  test("23:59 SGT today is today, 00:00 SGT is a new day", () => {
    expect(bucketOf({ due_at: "2026-11-04T15:59:00.000Z" }, NOW)).toBe("today"); // Wed 23:59 SGT
    expect(bucketOf({ due_at: "2026-11-04T16:00:00.000Z" }, NOW)).toBe("this_week"); // Thu 00:00 SGT
  });

  test("rest of the Monday-to-Sunday week is this_week", () => {
    expect(bucketOf({ due_at: "2026-11-06T10:00:00.000Z" }, NOW)).toBe("this_week"); // Fri
    expect(bucketOf({ due_at: "2026-11-08T15:59:00.000Z" }, NOW)).toBe("this_week"); // Sun 23:59 SGT
    expect(bucketOf({ due_at: "2026-11-08T16:00:00.000Z" }, NOW)).toBe("later"); // Mon 00:00 SGT
  });

  test("from Saturday, Sunday is still this_week; from Sunday, Monday is later", () => {
    const saturday = new Date("2026-11-07T05:00:00.000Z"); // Sat 13:00 SGT
    const sunday = new Date("2026-11-08T05:00:00.000Z"); // Sun 13:00 SGT
    expect(bucketOf({ due_at: "2026-11-08T15:59:00.000Z" }, saturday)).toBe("this_week"); // Sun 23:59 SGT
    expect(bucketOf({ due_at: "2026-11-08T16:00:00.000Z" }, saturday)).toBe("later"); // Mon 00:00 SGT
    expect(bucketOf({ due_at: "2026-11-08T15:59:00.000Z" }, sunday)).toBe("today"); // due today, not yet passed
    expect(bucketOf({ due_at: "2026-11-08T16:00:00.000Z" }, sunday)).toBe("later"); // Mon 00:00 SGT
  });

  test("overdue is decided on the instant, even earlier today", () => {
    expect(bucketOf({ due_at: "2026-11-03T10:00:00.000Z" }, NOW)).toBe("overdue"); // yesterday
    expect(bucketOf({ due_at: "2026-11-04T01:00:00.000Z" }, NOW)).toBe("overdue"); // 09:00 SGT today, now 13:00
    expect(bucketOf({ due_at: "2026-11-04T05:00:00.000Z" }, NOW)).toBe("today"); // due exactly now
  });

  test("beyond the week and missing due dates are later", () => {
    expect(bucketOf({ due_at: "2026-11-11T10:00:00.000Z" }, NOW)).toBe("later");
    expect(bucketOf({ due_at: null }, NOW)).toBe("later");
  });
});

describe("groupByBucket", () => {
  test("buckets every task and sorts each bucket by priority", () => {
    const tasks = [
      mkTask({ id: "later", due_at: "2026-11-11T10:00:00.000Z" }),
      mkTask({ id: "overdue-mild", due_at: "2026-11-04T03:00:00.000Z" }), // 2h overdue, test? no: assignment
      mkTask({ id: "overdue-old", kind: "review", effort: "medium", due_at: "2026-10-27T05:00:00.000Z" }), // capped urgency 17
      mkTask({ id: "today", due_at: "2026-11-04T12:00:00.000Z" }),
      mkTask({ id: "week", due_at: "2026-11-06T10:00:00.000Z" }),
      mkTask({ id: "none", due_at: null }),
    ];
    const buckets = groupByBucket(tasks, NOW);
    expect(Object.keys(buckets).sort()).toEqual(["later", "overdue", "this_week", "today"].sort());
    expect(buckets.overdue.map((task) => task.id)).toEqual(["overdue-old", "overdue-mild"]);
    expect(buckets.today.map((task) => task.id)).toEqual(["today"]);
    expect(buckets.this_week.map((task) => task.id)).toEqual(["week"]);
    const laterIds = buckets.later.map((task) => task.id);
    expect(laterIds).toContain("later");
    expect(laterIds).toContain("none");
    // no due date scores below any dated task in the same bucket
    expect(laterIds[laterIds.length - 1]).toBe("none");
    for (const key of Object.keys(buckets) as Bucket[]) {
      expect(Array.isArray(buckets[key as Bucket])).toBe(true);
    }
  });
});

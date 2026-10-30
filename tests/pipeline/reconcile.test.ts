import { describe, expect, test } from "bun:test";
import {
  JACCARD_MATCH_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
  jaccard,
  normalizeTitleTokens,
  planReconcile,
  type OpenTaskLite,
  type Op,
  type ReconcileAction,
} from "../../lib/pipeline/reconcile";

// Fri 30 Oct 2026, 13:00 SGT.
const NOW = new Date("2026-10-30T05:00:00.000Z");

const action = (over: Partial<ReconcileAction> = {}): ReconcileAction => ({
  type: "create",
  taskId: null,
  title: null,
  course: null,
  kind: null,
  dueAt: null,
  effort: null,
  evidence: "verbatim quote",
  confidence: 0.9,
  ...over,
});

const task = (over: Partial<OpenTaskLite> = {}): OpenTaskLite => ({
  id: "t1",
  title: "Lab 4 report",
  course: "CS2030",
  kind: "assignment",
  due_at: "2026-11-06T15:59:00.000Z",
  effort: "medium",
  status: "open",
  ...over,
});

const createsOf = (ops: Op[]) => ops.filter((op): op is Extract<Op, { op: "create" }> => op.op === "create");

describe("normalizeTitleTokens", () => {
  test("lowercases, strips punctuation and drops stopwords", () => {
    expect(normalizeTitleTokens("The Lab-4 Report, for CS2030!", null)).toEqual([
      "lab",
      "4",
      "report",
      "cs2030",
    ]);
  });

  test("course tokens join the title's token set", () => {
    expect(normalizeTitleTokens("Lab 4 report", "CS 2030")).toEqual([
      "lab",
      "4",
      "report",
      "cs",
      "2030",
    ]);
    expect(normalizeTitleTokens("Lab 4 report", null)).toEqual(["lab", "4", "report"]);
  });
});

describe("jaccard", () => {
  test("identical token sets score 1", () => {
    expect(jaccard(["a", "b", "c"], ["c", "b", "a"])).toBe(1);
  });

  test("disjoint token sets score 0", () => {
    expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
  });

  test("partial overlap scores intersection over union", () => {
    expect(jaccard(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3, 10);
  });

  test("empty token sets never match", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("planReconcile: ignored and clarified", () => {
  test("type none is ignored", () => {
    expect(planReconcile([action({ type: "none" })], [task()], NOW)).toEqual([]);
  });

  test("low confidence becomes clarify with no write", () => {
    const a = action({ title: "New essay", confidence: 0.49 });
    const ops = planReconcile([a], [task()], NOW);
    expect(ops).toEqual([{ op: "clarify", reason: "low_confidence", action: a }]);
  });

  test("confidence exactly 0.5 passes", () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.5);
    const ops = planReconcile([action({ title: "New essay", confidence: 0.5 })], [task()], NOW);
    expect(createsOf(ops)).toHaveLength(1);
  });

  test("NaN and Infinity confidence are treated as 0 -> clarify", () => {
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ops = planReconcile([action({ title: "New essay", confidence })], [task()], NOW);
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ op: "clarify", reason: "low_confidence" });
    }
  });
});

describe("planReconcile: ownership", () => {
  test("update with known id patches only changed fields with verbatim evidence", () => {
    const ops = planReconcile(
      [
        action({
          type: "update",
          taskId: "t1",
          title: "Lab 4 report",
          dueAt: "2026-11-08T15:59:00.000Z",
          evidence: "prof say extend to nxt fri liao",
        }),
      ],
      [task()],
      NOW,
    );
    expect(ops).toEqual([
      {
        op: "update",
        taskId: "t1",
        patch: { dueAt: "2026-11-08T15:59:00.000Z" },
        event: {
          action: "updated",
          before: { dueAt: "2026-11-06T15:59:00.000Z" },
          after: { dueAt: "2026-11-08T15:59:00.000Z" },
          evidence: "prof say extend to nxt fri liao",
        },
      },
    ]);
  });

  test("update to the same due instant in different string formatting is a no-op", () => {
    const ops = planReconcile(
      [
        action({
          type: "update",
          taskId: "t1",
          title: "Lab 4 report",
          dueAt: "2026-11-06T23:59:00+08:00",
        }),
      ],
      [task({ due_at: "2026-11-06T15:59:00.000Z" })],
      NOW,
    );
    expect(ops).toEqual([]);
  });

  test("update that changes nothing is a no-op", () => {
    const ops = planReconcile(
      [action({ type: "update", taskId: "t1", title: "Lab 4 report", kind: "assignment" })],
      [task()],
      NOW,
    );
    expect(ops).toEqual([]);
  });

  test("unknown id with title downgrades to create", () => {
    const ops = planReconcile(
      [action({ type: "update", taskId: "missing", title: "New essay", course: "GER1000" })],
      [task()],
      NOW,
    );
    expect(ops).toEqual([
      {
        op: "create",
        fields: {
          title: "New essay",
          course: "GER1000",
          kind: "other",
          dueAt: null,
          effort: null,
        },
        event: {
          action: "created",
          before: null,
          after: {
            title: "New essay",
            course: "GER1000",
            kind: "other",
            dueAt: null,
            effort: null,
          },
          evidence: "verbatim quote",
        },
      },
    ]);
  });

  test("unknown id without title is dropped", () => {
    for (const title of [null, "   "]) {
      expect(planReconcile([action({ type: "update", taskId: "missing", title })], [task()], NOW)).toEqual([]);
    }
  });

  test("complete with unknown id is dropped", () => {
    expect(planReconcile([action({ type: "complete", taskId: "missing" })], [task()], NOW)).toEqual([]);
  });

  test("update targeting a done task is treated as unknown (downgraded, never patched)", () => {
    const ops = planReconcile(
      [action({ type: "update", taskId: "t1", title: "Lab 4 report" })],
      [task({ status: "done" })],
      NOW,
    );
    // The done task is not in the open view, so the action takes the unknown
    // path: with a title present it downgrades to a create instead of
    // patching a task that is already done.
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("create");
  });

  test("update for someone else's task (absent from openTasks) behaves as unknown", () => {
    const ops = planReconcile(
      [action({ type: "update", taskId: "someone-elses", title: "Brand new thing" })],
      [task()],
      NOW,
    );
    expect(createsOf(ops)).toHaveLength(1);
    expect(createsOf(ops)[0].fields.title).toBe("Brand new thing");
  });
});

describe("planReconcile: fuzzy dedupe", () => {
  test("create fuzzy-matching an open task becomes an update on it", () => {
    const ops = planReconcile(
      [action({ title: "CS2030 Lab 4 report", dueAt: "2026-11-09T15:59:00.000Z" })],
      [task({ title: "Lab 4 report", course: "CS2030" })],
      NOW,
    );
    expect(ops).toEqual([
      {
        op: "update",
        taskId: "t1",
        patch: {
          title: "CS2030 Lab 4 report",
          dueAt: "2026-11-09T15:59:00.000Z",
        },
        event: {
          action: "updated",
          before: { title: "Lab 4 report", dueAt: "2026-11-06T15:59:00.000Z" },
          after: { title: "CS2030 Lab 4 report", dueAt: "2026-11-09T15:59:00.000Z" },
          evidence: "verbatim quote",
        },
      },
    ]);
  });

  test("create matching an open task but changing nothing emits no op", () => {
    const ops = planReconcile(
      [action({ title: "Lab 4 report", course: "CS2030", kind: "assignment", dueAt: "2026-11-06T15:59:00.000Z", effort: "medium" })],
      [task()],
      NOW,
    );
    expect(ops).toEqual([]);
  });

  test("create below the Jaccard threshold stays a create", () => {
    expect(JACCARD_MATCH_THRESHOLD).toBe(0.6);
    const ops = planReconcile([action({ title: "CS2030 essay outline" })], [task()], NOW);
    expect(createsOf(ops)).toHaveLength(1);
  });

  test("create at exactly the 0.6 threshold matches (3 of 5 tokens shared)", () => {
    const ops = planReconcile(
      [action({ title: "alpha beta gamma delta echo" })],
      [task({ id: "t2", title: "alpha beta gamma", course: null })],
      NOW,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "update", taskId: "t2" });
  });

  test("two near-duplicate creates in one batch collapse into one create", () => {
    const ops = planReconcile(
      [
        action({ title: "Write CS2030 lab report", evidence: "first quote" }),
        action({
          title: "CS2030 lab report write",
          dueAt: "2026-11-12T15:59:00.000Z",
          effort: "large",
          evidence: "second quote",
        }),
      ],
      [],
      NOW,
    );
    // The merge patches the earlier create with anything the second action
    // supplies that differs, exactly like an update would, so the newer title
    // wins while evidence keeps both quotes.
    expect(ops).toEqual([
      {
        op: "create",
        fields: {
          title: "CS2030 lab report write",
          course: null,
          kind: "other",
          dueAt: "2026-11-12T15:59:00.000Z",
          effort: "large",
        },
        event: {
          action: "created",
          before: null,
          after: {
            title: "CS2030 lab report write",
            course: null,
            kind: "other",
            dueAt: "2026-11-12T15:59:00.000Z",
            effort: "large",
          },
          evidence: "first quote | second quote",
        },
      },
    ]);
  });

  test("best Jaccard wins; ties go to the earlier due date, then first in list", () => {
    const tieTasks = [
      task({ id: "early-due", title: "lab report", course: null, due_at: "2026-12-01T00:00:00.000Z" }),
      task({ id: "late-due", title: "report lab", course: null, due_at: "2026-11-01T00:00:00.000Z" }),
    ];
    const byDue = planReconcile([action({ title: "lab report now" })], tieTasks, NOW);
    expect(byDue).toEqual([expect.objectContaining({ op: "update", taskId: "late-due" })]);

    const sameDue = [
      task({ id: "first", title: "lab report", course: null }),
      task({ id: "second", title: "report lab", course: null }),
    ];
    const byOrder = planReconcile([action({ title: "lab report now" })], sameDue, NOW);
    expect(byOrder).toEqual([expect.objectContaining({ op: "update", taskId: "first" })]);
  });

  test("dedupe sees title updates made earlier in the same batch", () => {
    // After the first action the running title is "Lab 5 report", so the
    // second create matches it (0.75) and, supplying nothing new, becomes a
    // no-op instead of a second create. Without the update in between,
    // "Lab 5 report" vs "Lab 4 report" + CS2030 scores 0.5 and would create.
    const ops = planReconcile(
      [
        action({ type: "update", taskId: "t1", title: "Lab 5 report" }),
        action({ title: "Lab 5 report" }),
      ],
      [task()],
      NOW,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "update", taskId: "t1", patch: { title: "Lab 5 report" } });
  });
});

describe("planReconcile: complete", () => {
  test("complete emits a completed event", () => {
    const ops = planReconcile(
      [action({ type: "complete", taskId: "t1", evidence: "done liao" })],
      [task()],
      NOW,
    );
    expect(ops).toEqual([
      {
        op: "complete",
        taskId: "t1",
        event: {
          action: "completed",
          before: { status: "open" },
          after: { status: "done" },
          evidence: "done liao",
        },
      },
    ]);
  });

  test("a complete for the same task twice emits once", () => {
    const ops = planReconcile(
      [action({ type: "complete", taskId: "t1" }), action({ type: "complete", taskId: "t1" })],
      [task()],
      NOW,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("complete");
  });

  test("a complete after an update in the same batch still works", () => {
    const ops = planReconcile(
      [
        action({ type: "update", taskId: "t1", title: "Lab 4 report v2" }),
        action({ type: "complete", taskId: "t1" }),
      ],
      [task()],
      NOW,
    );
    expect(ops.map((op) => op.op)).toEqual(["update", "complete"]);
  });

  test("an update after a complete in the same batch is dropped, not duplicated", () => {
    const ops = planReconcile(
      [
        action({ type: "complete", taskId: "t1" }),
        action({ type: "update", taskId: "t1", title: "Lab 4 report v2" }),
      ],
      [task()],
      NOW,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("complete");
  });
});

describe("planReconcile: create defaults", () => {
  test("kind null defaults to other", () => {
    const ops = planReconcile([action({ title: "Buy groceries" })], [], NOW);
    expect(createsOf(ops)[0].fields.kind).toBe("other");
  });

  test("create keeps an explicit kind", () => {
    const ops = planReconcile([action({ title: "MA2001 quiz", kind: "test" })], [], NOW);
    expect(createsOf(ops)[0].fields.kind).toBe("test");
  });

  test("create without a title is dropped", () => {
    for (const title of [null, "   "]) {
      expect(planReconcile([action({ title })], [], NOW)).toEqual([]);
    }
  });

  test("a due date in the past is still allowed and keeps the evidence", () => {
    const ops = planReconcile(
      [action({ title: "Lab 3 writeup", dueAt: "2026-10-20T15:59:00.000Z", evidence: "overdue quote" })],
      [],
      NOW,
    );
    expect(createsOf(ops)).toEqual([
      {
        op: "create",
        fields: {
          title: "Lab 3 writeup",
          course: null,
          kind: "other",
          dueAt: "2026-10-20T15:59:00.000Z",
          effort: null,
        },
        event: {
          action: "created",
          before: null,
          after: {
            title: "Lab 3 writeup",
            course: null,
            kind: "other",
            dueAt: "2026-10-20T15:59:00.000Z",
            effort: null,
          },
          evidence: "overdue quote",
        },
      },
    ]);
  });
});

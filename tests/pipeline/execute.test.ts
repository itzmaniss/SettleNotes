import { describe, expect, test } from "bun:test";
import type {
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
} from "../../lib/db/queries";
import type { TaskRow } from "../../lib/db/types";
import { executeOps, type ExecuteDeps } from "../../lib/pipeline/execute";
import type { Op, TaskFields } from "../../lib/pipeline/reconcile";

function taskRow(id: string, title: string): TaskRow {
  return {
    id,
    user_id: "user-1",
    title,
    course: null,
    kind: "other",
    due_at: null,
    effort: null,
    status: "open",
    origin: "capture",
    source_upload_id: "upload-1",
    weak_spot_id: null,
    created_at: "2026-10-28T01:00:00.000Z",
    updated_at: "2026-10-28T01:00:00.000Z",
  };
}

type Call = { fn: string; args: unknown };

// Fake DB that records every call in order so ordering (insertTask before its
// event) can be asserted from one log.
function makeDb(failOn?: string): { db: ExecuteDeps; log: Call[]; events: InsertTaskEventInput[] } {
  const log: Call[] = [];
  const events: InsertTaskEventInput[] = [];
  const db: ExecuteDeps = {
    insertTask: async (i: InsertTaskInput) => {
      log.push({ fn: "insertTask", args: i });
      if (failOn === "insertTask") throw new Error("insert failed");
      return taskRow(`task-${log.length}`, i.title);
    },
    updateTask: async (id: string, userId: string, patch: UpdateTaskPatch) => {
      log.push({ fn: "updateTask", args: { id, userId, patch } });
      if (failOn === "updateTask") throw new Error("update failed");
      return taskRow(id, "CS2030 Lab 4");
    },
    insertTaskEvent: async (i: InsertTaskEventInput) => {
      log.push({ fn: "insertTaskEvent", args: i });
      if (failOn === "insertTaskEvent") throw new Error("event failed");
      events.push(i);
    },
  };
  return { db, log, events };
}

const FIELDS: TaskFields = {
  title: "MA2001 Quiz 2",
  course: "MA2001",
  kind: "test",
  dueAt: "2026-11-10T15:59:00.000Z",
  effort: "medium",
};

const CTX = { userId: "user-1", uploadId: "upload-1" };

describe("executeOps", () => {
  test("create: inserts the task with capture origin and source upload, then its event", async () => {
    const { db, log, events } = makeDb();
    const op: Op = {
      op: "create",
      fields: FIELDS,
      event: { action: "created", before: null, after: FIELDS, evidence: "quiz nxt week" },
    };
    const result = await executeOps([op], CTX, db);

    expect(result.created).toHaveLength(1);
    expect(result.created[0].title).toBe(FIELDS.title);
    expect(log[0]).toMatchObject({ fn: "insertTask" });
    const insertArgs = log[0].args as InsertTaskInput;
    expect(insertArgs).toMatchObject({
      userId: "user-1",
      title: FIELDS.title,
      course: FIELDS.course,
      kind: FIELDS.kind,
      dueAt: FIELDS.dueAt,
      effort: FIELDS.effort,
      origin: "capture",
      sourceUploadId: "upload-1",
    });
    expect(log[1]).toMatchObject({ fn: "insertTaskEvent" });
    expect(events[0]).toMatchObject({
      taskId: result.created[0].id,
      uploadId: "upload-1",
      action: "created",
      before: null,
      after: FIELDS,
      evidence: "quiz nxt week",
    });
  });

  test("update: patches the task by id and user, then records before/after and evidence", async () => {
    const { db, log, events } = makeDb();
    const op: Op = {
      op: "update",
      taskId: "task-9",
      patch: { dueAt: "2026-11-06T15:59:00.000Z" },
      event: {
        action: "updated",
        before: { dueAt: "2026-10-30T15:59:00.000Z" },
        after: { dueAt: "2026-11-06T15:59:00.000Z" },
        evidence: "extend to nxt fri",
      },
    };
    const result = await executeOps([op], CTX, db);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].task.id).toBe("task-9");
    expect(result.updated[0].before).toEqual({ dueAt: "2026-10-30T15:59:00.000Z" });
    expect(result.updated[0].after).toEqual({ dueAt: "2026-11-06T15:59:00.000Z" });
    expect(log[0].args).toEqual({
      id: "task-9",
      userId: "user-1",
      patch: { dueAt: "2026-11-06T15:59:00.000Z" },
    });
    expect(events[0]).toMatchObject({
      taskId: "task-9",
      action: "updated",
      evidence: "extend to nxt fri",
    });
  });

  test("complete: writes status done and a completed event", async () => {
    const { db, log, events } = makeDb();
    const op: Op = {
      op: "complete",
      taskId: "task-5",
      event: {
        action: "completed",
        before: { status: "open" },
        after: { status: "done" },
        evidence: "submitted liao",
      },
    };
    const result = await executeOps([op], CTX, db);

    expect(result.completed).toHaveLength(1);
    expect(log[0].args).toEqual({ id: "task-5", userId: "user-1", patch: { status: "done" } });
    expect(events[0]).toMatchObject({ taskId: "task-5", action: "completed" });
    expect(log.filter((c) => c.fn === "insertTaskEvent")).toHaveLength(1);
  });

  test("clarify: no db writes, action collected", async () => {
    const { db, log } = makeDb();
    const action = {
      type: "create" as const,
      taskId: null,
      title: "Mystery thing",
      course: null,
      kind: null,
      dueAt: null,
      effort: null,
      evidence: "do the thing",
      confidence: 0.2,
    };
    const result = await executeOps([{ op: "clarify", reason: "low_confidence", action }], CTX, db);

    expect(result.clarify).toEqual([action]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.completed).toEqual([]);
    expect(log).toEqual([]);
  });

  test("ops run sequentially: each create is immediately followed by its event", async () => {
    const { db, log } = makeDb();
    const ops: Op[] = [
      { op: "create", fields: { ...FIELDS, title: "One" }, event: { action: "created", before: null, after: FIELDS, evidence: "e1" } },
      { op: "create", fields: { ...FIELDS, title: "Two" }, event: { action: "created", before: null, after: FIELDS, evidence: "e2" } },
    ];
    await executeOps(ops, CTX, db);

    expect(log.map((c) => c.fn)).toEqual([
      "insertTask",
      "insertTaskEvent",
      "insertTask",
      "insertTaskEvent",
    ]);
  });

  test("a failing create throws and no event is written for it", async () => {
    const { db, log } = makeDb("insertTask");
    const op: Op = {
      op: "create",
      fields: FIELDS,
      event: { action: "created", before: null, after: FIELDS, evidence: "boom" },
    };
    await expect(executeOps([op], CTX, db)).rejects.toThrow("insert failed");
    expect(log.filter((c) => c.fn === "insertTaskEvent")).toHaveLength(0);
  });

  test("a failing update stops the batch and later ops do not run", async () => {
    const { db, log } = makeDb("updateTask");
    const ops: Op[] = [
      { op: "update", taskId: "task-9", patch: { dueAt: "2026-11-06T15:59:00.000Z" }, event: { action: "updated", before: {}, after: {}, evidence: "e" } },
      { op: "create", fields: FIELDS, event: { action: "created", before: null, after: FIELDS, evidence: "never" } },
    ];
    await expect(executeOps(ops, CTX, db)).rejects.toThrow("update failed");
    expect(log.filter((c) => c.fn === "insertTask")).toHaveLength(0);
  });
});

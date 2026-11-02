import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./fake-supabase";
import { TASK_A1, USER_A, USER_B, baseTables } from "./fixtures";
import {
  OWNED_TABLES,
  allZero,
  countOwnedRows,
  nonzeroEntries,
  type OwnedCounts,
} from "../../lib/privacy/counts";

const ZERO_COUNTS: OwnedCounts = {
  uploads: 0,
  tasks: 0,
  task_events: 0,
  starters: 0,
  weak_spots: 0,
  subscriptions: 0,
  usage_events: 0,
  pending_actions: 0,
  purchase_confirmations: 0,
  login_tokens: 0,
  ai_calls: 0,
};

describe("countOwnedRows", () => {
  test("counts every owned table for user A only", async () => {
    const fake = makeFakeDb(baseTables());
    const counts = await countOwnedRows(fake.client, USER_A);
    expect(counts).toEqual({
      uploads: 2,
      tasks: 2,
      task_events: 2,
      starters: 1,
      weak_spots: 1,
      subscriptions: 1,
      usage_events: 1,
      pending_actions: 1,
      purchase_confirmations: 1,
      login_tokens: 1,
      ai_calls: 2,
    });
  });

  test("task_events and starters are counted through their task, never another user's", async () => {
    const fake = makeFakeDb(baseTables());
    const countsA = await countOwnedRows(fake.client, USER_A);
    const countsB = await countOwnedRows(fake.client, USER_B);
    expect(countsA.task_events).toBe(2);
    expect(countsA.starters).toBe(1);
    expect(countsB.task_events).toBe(1);
    expect(countsB.starters).toBe(1);
    expect(countsB.purchase_confirmations).toBe(1);
  });

  test("a task with several events counts all of them for the right user", async () => {
    const tables = baseTables();
    const extraTask = "cccc0000-0000-4000-8000-000000000009";
    tables.tasks.push({
      id: extraTask,
      user_id: USER_A,
      title: "extra",
      course: null,
      kind: "other",
      due_at: null,
      effort: null,
      status: "open",
      origin: "capture",
      source_upload_id: null,
      weak_spot_id: null,
      created_at: "2026-10-06T00:00:00.000Z",
      updated_at: "2026-10-06T00:00:00.000Z",
    });
    tables.task_events.push(
      {
        id: "eeee0000-0000-4000-8000-000000000010",
        task_id: extraTask,
        upload_id: null,
        action: "created",
        before: null,
        after: {},
        evidence: null,
        created_at: "2026-10-06T00:00:01.000Z",
      },
      {
        id: "eeee0000-0000-4000-8000-000000000011",
        task_id: extraTask,
        upload_id: null,
        action: "updated",
        before: {},
        after: {},
        evidence: null,
        created_at: "2026-10-06T00:00:02.000Z",
      },
    );
    const fake = makeFakeDb(tables);
    const counts = await countOwnedRows(fake.client, USER_A);
    expect(counts.tasks).toBe(3);
    expect(counts.task_events).toBe(4);
    void TASK_A1;
  });

  test("zero rows come back as zeros, including the join tables", async () => {
    const fake = makeFakeDb({ users: [{ id: USER_A }], tasks: [] });
    const counts = await countOwnedRows(fake.client, USER_A);
    expect(allZero(counts)).toBe(true);
  });

  test("every count query carries the user filter and touches no billing events", async () => {
    const fake = makeFakeDb(baseTables());
    await countOwnedRows(fake.client, USER_A);
    const selects = fake.ops.filter((op) => op.kind === "select");
    expect(selects.length).toBe(OWNED_TABLES.length);
    for (const op of selects) {
      if (op.kind !== "select") continue;
      const hit = op.filters.some(
        (f) => (f.column === "user_id" || f.column === "tasks.user_id") && f.value === USER_A,
      );
      expect(hit).toBe(true);
      expect(op.table).not.toBe("billing_events");
    }
  });

  test("allZero and nonzeroEntries describe the counts", () => {
    expect(allZero(ZERO_COUNTS)).toBe(true);
    expect(
      nonzeroEntries({ ...ZERO_COUNTS, uploads: 2, ai_calls: 3 }),
    ).toEqual([
      ["uploads", 2],
      ["ai_calls", 3],
    ]);
  });
});

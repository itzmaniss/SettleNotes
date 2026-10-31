import { describe, expect, test } from "bun:test";
import type { User } from "grammy/types";
import type { PendingActionRow } from "../../lib/clarify/types";
import type { TaskRow, UserRow } from "../../lib/db/types";
import type { ExecuteContext, ExecuteResult } from "../../lib/pipeline/execute";
import type { Op } from "../../lib/pipeline/reconcile";
import {
  createPendingActionCallback,
  type CallbackContextLike,
} from "../../lib/telegram/callbacks";

const UUID = "5b1f8a2e-9c3d-4e6f-8a7b-2c1d0e9f8a7b";
const NOW = new Date("2026-10-31T09:00:00+08:00");
const FAILURE_TEXT = "Sorry, something went wrong on my side. Please try that again in a moment.";

const user: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  terms_accepted_at: null,
  terms_version: null,
  created_at: "2026-10-01T01:00:00.000Z",
};

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    user_id: "user-1",
    title: "CS2030 Lab 4",
    course: "CS2030",
    kind: "assignment",
    due_at: "2026-10-30T15:59:00.000Z",
    effort: "medium",
    status: "open",
    origin: "capture",
    source_upload_id: "upload-1",
    weak_spot_id: null,
    created_at: "2026-10-27T01:00:00.000Z",
    updated_at: "2026-10-27T01:00:00.000Z",
    ...overrides,
  };
}

function makeRow(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: UUID,
    user_id: "user-1",
    upload_id: "upload-1",
    kind: "create",
    task_id: null,
    payload: {
      title: "MA2001 Quiz 2",
      course: "MA2001",
      kind: "test",
      dueAt: "2026-11-10T15:59:00.000Z",
      effort: null,
      evidence: "got quiz 2 on tue",
    },
    status: "pending",
    expires_at: "2026-11-01T09:00:00.000Z",
    created_at: "2026-10-31T01:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}

type HarnessOptions = {
  row?: PendingActionRow | null;
  // A user row other than the owner, returned by the user lookup.
  lookupUser?: UserRow | null;
  openTask?: TaskRow | null;
  claimLosesRace?: boolean;
  applyError?: Error;
};

function makeHarness(options: HarnessOptions = {}) {
  const row = options.row === undefined ? makeRow() : options.row;
  const foundUser = options.lookupUser === undefined ? user : options.lookupUser;
  const calls = {
    answered: 0,
    claims: [] as Array<{ id: string; userId: string; status: string; now: Date }>,
    resets: 0,
    ops: [] as Op[][],
    executeCtx: [] as ExecuteContext[],
    openTaskLookups: [] as Array<{ taskId: string; userId: string }>,
    edits: [] as Array<{ text: string; markup: unknown }>,
    replies: [] as Array<{ text: string; markup: unknown }>,
  };

  const handler = createPendingActionCallback({
    getUserByTelegramId: async () => foundUser,
    // Scoped like the real query: another user's id finds nothing.
    getPendingAction: async (_id, userId) => (row != null && userId === row.user_id ? row : null),
    claimPendingAction: async (id, userId, status, now) => {
      calls.claims.push({ id, userId, status, now });
      if (options.claimLosesRace) return null;
      return { ...row!, status, resolved_at: now.toISOString() };
    },
    resetPendingAction: async () => {
      calls.resets += 1;
    },
    getOpenTask: async (taskId, userId) => {
      calls.openTaskLookups.push({ taskId, userId });
      return options.openTask === undefined ? makeTask() : options.openTask;
    },
    executeOps: async (ops, ctx) => {
      calls.ops.push(ops);
      calls.executeCtx.push(ctx);
      if (options.applyError) throw options.applyError;
      return fakeResult(ops, options.openTask === undefined ? makeTask() : options.openTask);
    },
    now: () => NOW,
  });

  const ctx: CallbackContextLike = {
    from: { id: 101, is_bot: false, first_name: "Tim" } as User,
    callbackQuery: { data: `pa:y:${UUID}` },
    answerCallbackQuery: async () => {
      calls.answered += 1;
      return true;
    },
    editMessageText: async (text, other) => {
      calls.edits.push({ text, markup: other?.reply_markup });
      return {};
    },
    reply: async (text, other) => {
      calls.replies.push({ text, markup: other?.reply_markup });
      return {};
    },
  };

  return { handler, ctx, calls, row };
}

// A tiny executor stand-in that turns the applied op into the result shape
// the real executeOps would produce.
function fakeResult(ops: Op[], task: TaskRow | null): ExecuteResult {
  const op = ops[0];
  if (op.op === "create") {
    return {
      created: [{ ...makeTask(), id: "new-1", title: op.fields.title, due_at: op.fields.dueAt }],
      updated: [],
      completed: [],
      clarify: [],
    };
  }
  if (op.op === "complete") {
    return { created: [], updated: [], completed: [makeTask({ status: "done" })], clarify: [] };
  }
  if (op.op === "update") {
    const updated = { ...task!, ...op.patch, due_at: op.patch.dueAt ?? task!.due_at };
    return {
      created: [],
      updated: [{ task: updated, before: op.event.before, after: op.event.after }],
      completed: [],
      clarify: [],
    };
  }
  throw new Error("unexpected op in fakeResult");
}

const EMPTY_MARKUP = { inline_keyboard: [] };

describe("pending action taps: yes", () => {
  test("create applies once through executeOps with the stored payload and confirms", async () => {
    const { handler, ctx, calls } = makeHarness();
    await handler(ctx);

    expect(calls.answered).toBe(1);
    expect(calls.claims).toEqual([
      { id: UUID, userId: "user-1", status: "accepted", now: NOW },
    ]);
    expect(calls.ops).toHaveLength(1);
    const op = calls.ops[0][0];
    expect(op.op).toBe("create");
    if (op.op !== "create") return;
    expect(op.fields).toEqual({
      title: "MA2001 Quiz 2",
      course: "MA2001",
      kind: "test",
      dueAt: "2026-11-10T15:59:00.000Z",
      effort: null,
    });
    // The audit event carries the evidence quote, like the confident path.
    expect(op.event).toEqual({
      action: "created",
      before: null,
      after: op.fields,
      evidence: "got quiz 2 on tue",
    });
    expect(calls.executeCtx[0]).toEqual({ userId: "user-1", uploadId: "upload-1" });
    expect(calls.resets).toBe(0);
    expect(calls.edits).toEqual([
      { text: "Added: MA2001 Quiz 2 (due Tue 10 Nov, 11:59pm)", markup: EMPTY_MARKUP },
    ]);
  });

  test("a create without a due date confirms without one", async () => {
    const base = makeRow();
    const payload = base.payload as { dueAt: string | null };
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({ payload: { ...payload, dueAt: null } }),
    });
    await handler(ctx);
    expect(calls.edits[0].text).toBe("Added: MA2001 Quiz 2");
  });

  test("update applies the stored due with before values from the current task", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({
        kind: "update",
        task_id: "task-1",
        payload: { dueAt: "2026-11-06T15:59:00.000Z", evidence: "maybe extend lab 4" },
      }),
      openTask: makeTask(),
    });
    await handler(ctx);

    expect(calls.openTaskLookups).toEqual([{ taskId: "task-1", userId: "user-1" }]);
    const op = calls.ops[0][0];
    expect(op.op).toBe("update");
    if (op.op !== "update") return;
    expect(op.taskId).toBe("task-1");
    expect(op.patch).toEqual({ dueAt: "2026-11-06T15:59:00.000Z" });
    expect(op.event).toEqual({
      action: "updated",
      before: { dueAt: "2026-10-30T15:59:00.000Z" },
      after: { dueAt: "2026-11-06T15:59:00.000Z" },
      evidence: "maybe extend lab 4",
    });
    expect(calls.edits[0].text).toBe("Moved CS2030 Lab 4 to Fri 6 Nov, 11:59pm (was Fri 30 Oct, 11:59pm)");
  });

  test("a title-only update confirms in the summary's updated wording", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({
        kind: "update",
        task_id: "task-1",
        payload: { title: "CS2030 Lab 4 report", evidence: "add the report part" },
      }),
      openTask: makeTask(),
    });
    await handler(ctx);
    expect(calls.edits[0].text).toBe("Updated CS2030 Lab 4 report.");
    expect(calls.ops[0][0].op).toBe("update");
  });

  test("complete applies through the same op shape and ticks the task off", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({
        kind: "complete",
        task_id: "task-1",
        payload: { evidence: "done liao" },
      }),
      openTask: makeTask(),
    });
    await handler(ctx);

    const op = calls.ops[0][0];
    expect(op).toEqual({
      op: "complete",
      taskId: "task-1",
      event: {
        action: "completed",
        before: { status: "open" },
        after: { status: "done" },
        evidence: "done liao",
      },
    });
    expect(calls.edits[0].text).toBe("Ticked off: CS2030 Lab 4");
  });
});

describe("pending action taps: no", () => {
  test("no dismisses the row, writes nothing and clears the keyboard", async () => {
    const { handler, ctx, calls } = makeHarness();
    ctx.callbackQuery = { data: `pa:n:${UUID}` };
    await handler(ctx);

    expect(calls.answered).toBe(1);
    expect(calls.claims).toEqual([
      { id: UUID, userId: "user-1", status: "dismissed", now: NOW },
    ]);
    expect(calls.ops).toHaveLength(0);
    expect(calls.resets).toBe(0);
    expect(calls.edits).toEqual([{ text: "Okay, I left it alone.", markup: EMPTY_MARKUP }]);
  });
});

describe("pending action taps: refusals and races", () => {
  test("a double tap loses the claim and is told it is already handled", async () => {
    const { handler, ctx, calls } = makeHarness({ claimLosesRace: true });
    await handler(ctx);

    expect(calls.answered).toBe(1);
    expect(calls.claims).toHaveLength(1);
    expect(calls.ops).toHaveLength(0);
    expect(calls.edits).toEqual([{ text: "Already handled.", markup: undefined }]);
  });

  test("an expired row gets the expired note and is never claimed", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({ expires_at: "2026-10-30T09:00:00.000Z" }),
    });
    await handler(ctx);

    expect(calls.claims).toHaveLength(0);
    expect(calls.ops).toHaveLength(0);
    expect(calls.edits).toEqual([
      {
        text: "That one has expired. Send it to me again if you still need it.",
        markup: undefined,
      },
    ]);
  });

  test("an already resolved row is already handled", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({ status: "accepted", resolved_at: NOW.toISOString() }),
    });
    await handler(ctx);
    expect(calls.claims).toHaveLength(0);
    expect(calls.edits[0].text).toBe("Already handled.");
  });

  test("another user tapping the same button finds nothing scoped to them", async () => {
    const { handler, ctx, calls } = makeHarness({
      // The lookup resolves a different account, so the scoped load finds no row.
      lookupUser: { ...user, id: "user-2", telegram_user_id: 999 },
    });
    await handler(ctx);

    expect(calls.answered).toBe(1);
    expect(calls.claims).toHaveLength(0);
    expect(calls.ops).toHaveLength(0);
    expect(calls.edits[0].text).toBe("Already handled.");
  });

  test("a sender with no user row is already handled", async () => {
    const { handler, ctx, calls } = makeHarness({ lookupUser: null });
    await handler(ctx);
    expect(calls.ops).toHaveLength(0);
    expect(calls.edits[0].text).toBe("Already handled.");
  });

  test("a task that is gone or closed since gets did-nothing and no writes", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({ kind: "complete", task_id: "task-1", payload: { evidence: "done liao" } }),
      openTask: null,
    });
    await handler(ctx);

    expect(calls.ops).toHaveLength(0);
    expect(calls.resets).toBe(0);
    expect(calls.edits).toEqual([
      { text: "That task has changed, so I did nothing.", markup: EMPTY_MARKUP },
    ]);
  });

  test("a stored payload that no longer validates resets the row and answers with the failure", async () => {
    const { handler, ctx, calls } = makeHarness({
      row: makeRow({ payload: { junk: "corrupted after a manual edit" } }),
    });
    await handler(ctx);

    expect(calls.resets).toBe(1);
    expect(calls.ops).toHaveLength(0);
    expect(calls.edits[0].text).toBe(FAILURE_TEXT);
  });
});

describe("pending action taps: failures", () => {
  test("an apply failure hands the row back to pending and shows the friendly failure", async () => {
    const { handler, ctx, calls } = makeHarness({ applyError: new Error("db updateTask failed") });
    await handler(ctx);

    expect(calls.answered).toBe(1);
    expect(calls.ops).toHaveLength(1);
    expect(calls.resets).toBe(1);
    expect(calls.edits[0].text).toBe(FAILURE_TEXT);
  });

  test("the tap is always answered, even for malformed or foreign callback data", async () => {
    for (const data of ["pa:yes:abc", "otherbot:join", `pa:y:${"z".repeat(36)}`, ""]) {
      const { handler, ctx, calls } = makeHarness();
      ctx.callbackQuery = { data };
      await handler(ctx);
      expect(calls.answered).toBe(1);
      expect(calls.claims).toHaveLength(0);
      expect(calls.ops).toHaveLength(0);
      expect(calls.edits).toHaveLength(0);
    }
  });

  test("a lookup failure still answers the tap and never throws out of the handler", async () => {
    const answered: number[] = [];
    const edits: string[] = [];
    const breaking = createPendingActionCallback({
      getUserByTelegramId: async () => {
        throw new Error("db getUserByTelegramId failed: connection gone");
      },
      getPendingAction: async () => null,
      claimPendingAction: async () => null,
      resetPendingAction: async () => {},
      getOpenTask: async () => null,
      executeOps: async () => {
        throw new Error("not reached");
      },
      now: () => NOW,
    });
    await breaking({
      from: { id: 101, is_bot: false, first_name: "Tim" } as User,
      callbackQuery: { data: `pa:y:${UUID}` },
      answerCallbackQuery: async () => {
        answered.push(1);
        return true;
      },
      editMessageText: async (text) => {
        edits.push(text);
        return {};
      },
      reply: async () => {},
    });

    expect(answered).toHaveLength(1);
    expect(edits).toEqual([FAILURE_TEXT]);
  });

  test("an edit failure falls back to a plain reply with the same text", async () => {
    const { handler, ctx, calls } = makeHarness();
    ctx.editMessageText = async () => {
      throw new Error("message is too old to edit");
    };
    await handler(ctx);

    expect(calls.answered).toBe(1);
    expect(calls.replies).toEqual([
      { text: "Added: MA2001 Quiz 2 (due Tue 10 Nov, 11:59pm)", markup: EMPTY_MARKUP },
    ]);
  });

  test("both the edit and the reply failing still does not throw", async () => {
    const { handler, ctx, calls } = makeHarness();
    ctx.editMessageText = async () => {
      throw new Error("message is too old to edit");
    };
    ctx.reply = async () => {
      throw new Error("chat not reachable");
    };
    await handler(ctx);
    expect(calls.answered).toBe(1);
  });
});

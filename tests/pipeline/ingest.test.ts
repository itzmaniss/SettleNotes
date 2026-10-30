import { describe, expect, test } from "bun:test";
import type { FinishUploadPatch, InsertTaskInput, InsertTaskEventInput, UpdateTaskPatch } from "../../lib/db/queries";
import type { TaskRow, UploadRow, UserRow } from "../../lib/db/types";
import type { GenerateObjectOptions, MetaClient } from "../../lib/meta/client";
import { executeOps } from "../../lib/pipeline/execute";
import { createIngestDeps, ingestContent, type IngestDeps, type IngestInput } from "../../lib/pipeline/ingest";
import type { UnderstandOutput } from "../../lib/pipeline/understand";
import { summaryReply } from "../../lib/telegram/replies";

const NOW = new Date("2026-10-28T09:00:00+08:00");
const USAGE = { inputTokens: 900, outputTokens: 200, cachedTokens: 0, costUsd: 0.002, latencyMs: 700 };

const user: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  created_at: "2026-10-01T01:00:00.000Z",
};

const openTask: TaskRow = {
  id: "task-1",
  user_id: "user-1",
  title: "CS2030 Lab 4",
  course: "CS2030",
  kind: "assignment",
  due_at: "2026-10-30T15:59:00.000Z",
  effort: "medium",
  status: "open",
  origin: "capture",
  source_upload_id: null,
  weak_spot_id: null,
  created_at: "2026-10-27T01:00:00.000Z",
  updated_at: "2026-10-27T01:00:00.000Z",
};

const upload: UploadRow = {
  id: "upload-1",
  user_id: "user-1",
  kind: "text",
  telegram_file_id: null,
  mime_type: null,
  storage_path: null,
  text_content: "prof say extend lab 4 to nxt fri liao",
  classified_as: null,
  status: "processing",
  error: null,
  created_at: "2026-10-28T01:00:00.000Z",
};

type FakeDb = {
  inserts: InsertTaskInput[];
  updates: Array<{ id: string; userId: string; patch: UpdateTaskPatch }>;
  events: InsertTaskEventInput[];
  finished: Array<{ id: string; patch: FinishUploadPatch }>;
  openTasks: TaskRow[];
};

function makeFakeDb(openTasks: TaskRow[] = [openTask]): FakeDb & Pick<IngestDeps, "listOpenTasks" | "executeOps" | "finishUpload"> {
  const db: FakeDb = { inserts: [], updates: [], events: [], finished: [], openTasks };
  return {
    ...db,
    listOpenTasks: async () => db.openTasks,
    // The REAL executor runs against the fake db deps.
    executeOps: (ops, ctx) =>
      executeOps(ops, ctx, {
        insertTask: async (i) => {
          const row: TaskRow = {
            id: `new-${db.inserts.length + 1}`,
            user_id: i.userId,
            title: i.title,
            course: i.course ?? null,
            kind: i.kind,
            due_at: i.dueAt ?? null,
            effort: i.effort ?? null,
            status: "open",
            origin: i.origin ?? "capture",
            source_upload_id: i.sourceUploadId ?? null,
            weak_spot_id: null,
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          };
          db.inserts.push(i);
          return row;
        },
        updateTask: async (id, userId, patch) => {
          db.updates.push({ id, userId, patch });
          const found = db.openTasks.find((t) => t.id === id);
          return { ...(found ?? openTask), ...patch, due_at: patch.dueAt ?? (found?.due_at ?? null) } as TaskRow;
        },
        insertTaskEvent: async (i) => {
          db.events.push(i);
        },
      }),
    finishUpload: async (id, patch) => {
      db.finished.push({ id, patch });
    },
  } as FakeDb & Pick<IngestDeps, "listOpenTasks" | "executeOps" | "finishUpload">;
}

function makeGenerateObject(output: UnderstandOutput | Error) {
  const calls: GenerateObjectOptions<unknown>[] = [];
  const generateObject: MetaClient["generateObject"] = async (opts) => {
    calls.push(opts as GenerateObjectOptions<unknown>);
    if (output instanceof Error) throw output;
    return { data: output as never, usage: USAGE };
  };
  return { generateObject, calls };
}

const EXTEND_OUTPUT: UnderstandOutput = {
  input_kind: "plain_message",
  extracted_text: "prof say extend lab 4 to nxt fri liao",
  actions: [
    {
      type: "update",
      task_ref: "T1",
      title: null,
      course: null,
      kind: null,
      due_local: "2026-11-06T23:59",
      effort: null,
      evidence: "extend lab 4 to nxt fri",
      confidence: 0.9,
    },
  ],
  needs_clarification: null,
};

function makeInput(overrides: Partial<IngestInput> = {}): IngestInput {
  return { user, upload, text: "prof say extend lab 4 to nxt fri liao", ...overrides };
}

function assertNoDashes(text: string): void {
  expect(text.includes("\u2014")).toBe(false);
  expect(text.includes("\u2013")).toBe(false);
}

describe("ingestContent: the extend end to end case", () => {
  test("Singlish extend runs real understand + reconcile + execute and produces one update, one event, a done upload and a friendly reply", async () => {
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(EXTEND_OUTPUT);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput());

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(outcome.clarification).toBeNull();
    expect(outcome.inputKind).toBe("plain_message");
    expect(outcome.pdfTruncated).toBe(false);

    // Exactly one update, no creates.
    expect(fakeDb.updates).toHaveLength(1);
    expect(fakeDb.updates[0]).toEqual({
      id: "task-1",
      userId: "user-1",
      patch: { dueAt: "2026-11-06T15:59:00.000Z" },
    });
    expect(fakeDb.inserts).toHaveLength(0);

    // One audit event with the model's evidence quote.
    expect(fakeDb.events).toHaveLength(1);
    expect(fakeDb.events[0]).toMatchObject({
      taskId: "task-1",
      uploadId: "upload-1",
      action: "updated",
      before: { dueAt: "2026-10-30T15:59:00.000Z" },
      after: { dueAt: "2026-11-06T15:59:00.000Z" },
      evidence: "extend lab 4 to nxt fri",
    });

    // The upload finished as done and classified.
    expect(fakeDb.finished).toEqual([
      { id: "upload-1", patch: { status: "done", classifiedAs: "other", storagePath: null } },
    ]);

    // The reply names the task and the new Singapore deadline.
    const reply = summaryReply(outcome);
    expect(reply).toContain("CS2030 Lab 4");
    expect(reply).toContain("Fri 6 Nov, 11:59pm");
    expect(reply).toContain("Fri 30 Oct, 11:59pm");
    assertNoDashes(reply);
  });
});

describe("ingestContent: create, clarify and nothing branches", () => {
  const CREATE_OUTPUT: UnderstandOutput = {
    input_kind: "plain_message",
    extracted_text: "got quiz 2 on tue",
    actions: [
      {
        type: "create",
        task_ref: null,
        title: "MA2001 Quiz 2",
        course: "MA2001",
        kind: "test",
        due_local: "2026-11-10",
        effort: null,
        evidence: "got quiz 2 on tue",
        confidence: 0.9,
      },
    ],
    needs_clarification: null,
  };

  test("create path: inserts one task with capture origin and source upload, date-only due goes to 23:59", async () => {
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(CREATE_OUTPUT);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput({ text: "got quiz 2 on tue" }));

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.inserts[0]).toMatchObject({
      userId: "user-1",
      title: "MA2001 Quiz 2",
      course: "MA2001",
      kind: "test",
      dueAt: "2026-11-10T15:59:00.000Z",
      origin: "capture",
      sourceUploadId: "upload-1",
    });
    expect(fakeDb.events[0]).toMatchObject({ action: "created", evidence: "got quiz 2 on tue" });

    const reply = summaryReply(outcome);
    expect(reply).toContain("Added 1 task:");
    expect(reply).toContain("- MA2001 Quiz 2 (due Tue 10 Nov, 11:59pm)");
    assertNoDashes(reply);
  });

  test("two actions: both executed, reply lists both changes", async () => {
    const two: UnderstandOutput = {
      input_kind: "chat_screenshot",
      extracted_text: "x",
      actions: [
        CREATE_OUTPUT.actions[0],
        EXTEND_OUTPUT.actions[0],
      ],
      needs_clarification: null,
    };
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(two);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput());

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.updates).toHaveLength(1);
    const reply = summaryReply(outcome);
    expect(reply).toContain("Added 1 task:");
    expect(reply).toContain("Moved CS2030 Lab 4 to Fri 6 Nov, 11:59pm (was Fri 30 Oct, 11:59pm)");
    assertNoDashes(reply);
  });

  test("low confidence: no writes, the action surfaces as a gentle question", async () => {
    const unsure: UnderstandOutput = {
      input_kind: "plain_message",
      extracted_text: "x",
      actions: [
        { ...CREATE_OUTPUT.actions[0], confidence: 0.3 },
      ],
      needs_clarification: null,
    };
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(unsure);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput());

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(fakeDb.inserts).toHaveLength(0);
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.events).toHaveLength(0);
    expect(outcome.result.clarify).toHaveLength(1);
    const reply = summaryReply(outcome);
    expect(reply).toContain('I wasn\'t sure about "MA2001 Quiz 2", could you confirm?');
    assertNoDashes(reply);
  });

  test("model question passes through verbatim on the nothing branch", async () => {
    const question: UnderstandOutput = {
      input_kind: "other",
      extracted_text: "x",
      actions: [],
      needs_clarification: "Which module is this deadline for?",
    };
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(question);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput({ text: "something vague" }));
    expect(outcome).toEqual({ kind: "nothing", clarification: "Which module is this deadline for?" });
    expect(fakeDb.finished).toHaveLength(1);
    expect(fakeDb.finished[0].patch.status).toBe("done");
  });

  test("update for an unknown ref without a title is dropped: nothing branch, no writes", async () => {
    const unknown: UnderstandOutput = {
      input_kind: "plain_message",
      extracted_text: "x",
      actions: [
        {
          type: "update",
          task_ref: "T99",
          title: null,
          course: null,
          kind: null,
          due_local: "2026-11-06T23:59",
          effort: null,
          evidence: "push the thing",
          confidence: 0.9,
        },
      ],
      needs_clarification: null,
    };
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(unknown);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput());
    expect(outcome).toEqual({ kind: "nothing", clarification: null });
    expect(fakeDb.inserts).toHaveLength(0);
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.events).toHaveLength(0);
  });

  test("invalid due_local maps to dueAt null, so a create lands without a deadline", async () => {
    const bad: UnderstandOutput = {
      input_kind: "plain_message",
      extracted_text: "x",
      actions: [
        { ...CREATE_OUTPUT.actions[0], due_local: "2026-02-30T25:00" },
      ],
      needs_clarification: null,
    };
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(bad);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    await ingestContent(deps, makeInput());
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.inserts[0].dueAt).toBeNull();
  });

  test("a task_ref holding a raw task id (not one of our refs) can never select a task", async () => {
    const sneaky: UnderstandOutput = {
      input_kind: "plain_message",
      extracted_text: "x",
      actions: [
        {
          type: "update",
          task_ref: "task-1",
          title: null,
          course: null,
          kind: null,
          due_local: "2026-11-06T23:59",
          effort: null,
          evidence: "moving the real id as a ref",
          confidence: 0.9,
        },
      ],
      needs_clarification: null,
    };
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(sneaky);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput());
    // 'task-1' is not a ref in refToTaskId, so the action maps to taskId null
    // and is dropped (no title to downgrade to a create).
    expect(outcome).toEqual({ kind: "nothing", clarification: null });
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.inserts).toHaveLength(0);
  });
});

describe("ingestContent: math working and errors", () => {
  const MATH_OUTPUT: UnderstandOutput = {
    input_kind: "math_working",
    extracted_text: "x + 2 = 5, so x = 5",
    actions: [],
    needs_clarification: null,
  };

  test("math_working: no reconcile, no writes, hook called, upload done as math_working", async () => {
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(MATH_OUTPUT);
    const hookInputs: unknown[] = [];
    const deps: IngestDeps = {
      ...createIngestDeps(),
      generateObject,
      ...fakeDb,
      now: () => NOW,
      onMathWorking: async (input) => {
        hookInputs.push(input);
        return null;
      },
    };

    const outcome = await ingestContent(deps, makeInput({ image: { base64: "aGk=", mimeType: "image/jpeg" }, text: null }));

    expect(outcome).toEqual({ kind: "math_pending" });
    expect(hookInputs).toHaveLength(1);
    expect(fakeDb.inserts).toHaveLength(0);
    expect(fakeDb.updates).toHaveLength(0);
    expect(fakeDb.events).toHaveLength(0);
    expect(fakeDb.finished[0].patch).toEqual({ status: "done", classifiedAs: "math_working", storagePath: null });
  });

  test("math_working works without the hook too", async () => {
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(MATH_OUTPUT);
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    const outcome = await ingestContent(deps, makeInput());
    expect(outcome).toEqual({ kind: "math_pending" });
    expect(fakeDb.finished[0].patch.status).toBe("done");
  });

  test("understand errors propagate and the upload is left for the caller to fail", async () => {
    const fakeDb = makeFakeDb();
    const { generateObject } = makeGenerateObject(new Error("Meta API down"));
    const deps: IngestDeps = { ...createIngestDeps(), generateObject, ...fakeDb, now: () => NOW };

    await expect(ingestContent(deps, makeInput())).rejects.toThrow("Meta API down");
    expect(fakeDb.finished).toHaveLength(0);
    expect(fakeDb.inserts).toHaveLength(0);
  });
});

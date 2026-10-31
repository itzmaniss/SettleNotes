import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import type {
  FinishUploadPatch,
  InsertStarterInput,
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
} from "../../lib/db/queries";
import type { TaskRow, UploadRow, UserRow } from "../../lib/db/types";
import { quotaHitReply } from "../../lib/billing/copy";
import type { GenerateObjectOptions, MetaClient } from "../../lib/meta/client";
import { executeOps } from "../../lib/pipeline/execute";
import { createIngestDeps, ingestContent, type IngestDeps, type IngestInput } from "../../lib/pipeline/ingest";
import type { StartersDeps } from "../../lib/pipeline/starters";
import type { UnderstandOutput } from "../../lib/pipeline/understand";
import { summaryReply } from "../../lib/telegram/replies";

const NOW = new Date("2026-10-28T09:00:00+08:00");
// 1 Nov 2026 00:00 SGT, the reset instant used by the refused-claim fake.
const NOV_1_SGT = new Date("2026-10-31T16:00:00Z");
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

describe("ingestContent: starter wiring end to end", () => {
  const BRIEF_OUTPUT: UnderstandOutput = {
    input_kind: "assignment_brief",
    extracted_text: "lab 4 brief",
    actions: [
      {
        type: "create",
        task_ref: null,
        title: "CS2030 Lab 4",
        course: "CS2030",
        kind: "assignment",
        due_local: "2026-11-06T23:59",
        effort: null,
        evidence: "submit lab 4 by friday",
        confidence: 0.9,
      },
    ],
    needs_clarification: null,
  };

  function makeStarterDepsFake(generateObject: MetaClient["generateObject"]) {
    const startersInserted: InsertStarterInput[] = [];
    const claims: Array<{ userId: string; feature: string; uploadId: string | null }> = [];
    const starters: StartersDeps = {
      generateObject,
      insertTask: async () => {
        throw new Error("fallback task creation is not expected in this test");
      },
      insertTaskEvent: async () => {},
      insertStarter: async (i) => {
        startersInserted.push(i);
        return {
          id: `starter-${startersInserted.length}`,
          task_id: i.taskId,
          type: i.type,
          content: i.content,
          annotated_image_path: i.annotatedImagePath ?? null,
          created_at: NOW.toISOString(),
        };
      },
      uploadBuffer: async () => {},
      claimFeature: async (args) => {
        claims.push(args);
        return { ok: true as const, usageId: `usage-${claims.length}`, plan: "free" as const };
      },
      consumeUsage: async () => {},
      releaseUsage: async () => {},
      now: () => NOW,
    };
    return { starters, startersInserted };
  }

  test("a PDF assignment brief creates the task, inserts the checklist starter and the reply carries the checklist line", async () => {
    const calls: GenerateObjectOptions<unknown>[] = [];
    const briefItems = Array.from({ length: 9 }, (_, i) => ({
      id: `raw-${i + 1}`,
      text: `Requirement ${i + 1}`,
      category: "deliverable" as const,
      page: i + 1,
      done: true,
    }));
    const generateObject: MetaClient["generateObject"] = async (opts) => {
      calls.push(opts as GenerateObjectOptions<unknown>);
      const data = opts.purpose === "understand" ? BRIEF_OUTPUT : { items: briefItems };
      return { data: data as never, usage: USAGE };
    };
    const fakeDb = makeFakeDb([]);
    const { starters, startersInserted } = makeStarterDepsFake(generateObject);
    const deps: IngestDeps = {
      ...createIngestDeps(),
      generateObject,
      ...fakeDb,
      starters,
      now: () => NOW,
    };

    const outcome = await ingestContent(
      deps,
      makeInput({ pdf: { base64: "JVBERi0=", filename: "lab4-brief.pdf" }, text: null }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(outcome.inputKind).toBe("assignment_brief");

    // The task was captured normally...
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.inserts[0]).toMatchObject({
      title: "CS2030 Lab 4",
      kind: "assignment",
      origin: "capture",
      sourceUploadId: "upload-1",
    });
    expect(fakeDb.events[0]).toMatchObject({ action: "created", evidence: "submit lab 4 by friday" });

    // ...and the checklist starter was inserted against it.
    expect(calls.some((c) => c.purpose === "checklist")).toBe(true);
    expect(startersInserted).toHaveLength(1);
    expect(startersInserted[0]).toMatchObject({ taskId: "new-1", type: "checklist" });
    expect((startersInserted[0].content as { items: unknown[] }).items).toHaveLength(9);

    // The upload finished done as a brief and the reply has the starter line.
    expect(fakeDb.finished).toEqual([
      { id: "upload-1", patch: { status: "done", classifiedAs: "assignment_brief", storagePath: null } },
    ]);
    expect(outcome.starter).toEqual({ status: "made", type: "checklist", count: 9 });

    const reply = summaryReply(outcome);
    expect(reply).toContain("Added 1 task:");
    expect(reply).toContain("- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)");
    expect(reply).toContain("I also made a checklist of 9 things to hand in. Tick them off on your dashboard.");
    assertNoDashes(reply);
  });

  test("a quota-blocked brief still creates the task and the reply carries the quota sentence", async () => {
    const calls: GenerateObjectOptions<unknown>[] = [];
    const generateObject: MetaClient["generateObject"] = async (opts) => {
      calls.push(opts as GenerateObjectOptions<unknown>);
      // Only understand may run: a refused quota means no starter AI call.
      if (opts.purpose !== "understand") {
        throw new Error(`the ${opts.purpose} call must not run when quota is refused`);
      }
      return { data: BRIEF_OUTPUT as never, usage: USAGE };
    };
    const fakeDb = makeFakeDb([]);
    const { starters, startersInserted } = makeStarterDepsFake(generateObject);
    starters.claimFeature = async () => ({
      ok: false as const,
      reason: "quota" as const,
      used: 1,
      limit: 1,
      plan: "free" as const,
      resetsAt: NOV_1_SGT,
    });
    const deps: IngestDeps = {
      ...createIngestDeps(),
      generateObject,
      ...fakeDb,
      starters,
      now: () => NOW,
    };

    const outcome = await ingestContent(
      deps,
      makeInput({ pdf: { base64: "JVBERi0=", filename: "lab4-brief.pdf" }, text: null }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(fakeDb.inserts).toHaveLength(1); // the capture still wrote its task
    expect(fakeDb.inserts[0]).toMatchObject({ title: "CS2030 Lab 4", kind: "assignment" });
    expect(calls.some((c) => c.purpose === "checklist")).toBe(false);
    expect(startersInserted).toHaveLength(0);
    expect(outcome.starter).toEqual({
      status: "blocked",
      text: quotaHitReply({ feature: "brief_checklist", limit: 1, resetsAt: NOV_1_SGT, reason: "quota" }),
    });
    const reply = summaryReply(outcome);
    expect(reply).toContain("Added 1 task:");
    expect(reply).toContain("- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)");
    expect(reply).toContain(
      "You've used your 1 free brief checklist for October. They reset on 1 Nov.",
    );
    assertNoDashes(reply);
  });

  test("math_working with image bytes runs the diagnosis and returns the annotated math outcome", async () => {
    const jpeg = Buffer.from(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 30 } },
      })
        .jpeg()
        .toBuffer(),
    );
    const mathOutput: UnderstandOutput = {
      input_kind: "math_working",
      extracted_text: "x + 2 = 5",
      actions: [],
      needs_clarification: null,
    };
    const DIAGNOSIS = {
      steps: [
        { index: 1, latex_or_text: "x + 2 = 5", bbox: { x1: 50, y1: 50, x2: 300, y2: 120 } },
        { index: 2, latex_or_text: "x = 5 - 2 = 2", bbox: { x1: 100, y1: 200, x2: 400, y2: 300 } },
      ],
      is_correct: false,
      first_error_step: 2,
      what_went_wrong: "5 - 2 is 3, not 2",
      misconception: { topic: "sign_errors", detail: "the subtraction slipped" },
      correct_next_step: "x = 3",
      final_answer_check: "The answer should be x = 3.",
      practice: [{ question: "7 - 3 = ?", answer: "4" }],
    };
    const calls: GenerateObjectOptions<unknown>[] = [];
    const generateObject: MetaClient["generateObject"] = async (opts) => {
      calls.push(opts as GenerateObjectOptions<unknown>);
      const data = opts.purpose === "understand" ? mathOutput : DIAGNOSIS;
      return { data: data as never, usage: USAGE };
    };
    const fakeDb = makeFakeDb();
    const uploaded: Array<{ path: string; contentType: string }> = [];
    const startersInserted: InsertStarterInput[] = [];
    const mathTask: TaskRow = {
      id: "math-task-1",
      user_id: "user-1",
      title: "Math check: Sign errors",
      course: null,
      kind: "math_practice",
      due_at: null,
      effort: null,
      status: "open",
      origin: "capture",
      source_upload_id: "upload-1",
      weak_spot_id: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const starters: StartersDeps = {
      generateObject,
      insertTask: async (i) => {
        fakeDb.inserts.push(i);
        return mathTask;
      },
      insertTaskEvent: async (i) => {
        fakeDb.events.push(i);
      },
      insertStarter: async (i) => {
        startersInserted.push(i);
        return {
          id: "starter-1",
          task_id: i.taskId,
          type: i.type,
          content: i.content,
          annotated_image_path: i.annotatedImagePath ?? null,
          created_at: NOW.toISOString(),
        };
      },
      uploadBuffer: async (path, _buffer, contentType) => {
        uploaded.push({ path, contentType });
      },
      claimFeature: async () => ({ ok: true as const, usageId: "usage-1", plan: "free" as const }),
      consumeUsage: async () => {},
      releaseUsage: async () => {},
      now: () => NOW,
    };
    const hookInputs: unknown[] = [];
    const deps: IngestDeps = {
      ...createIngestDeps(),
      generateObject,
      ...fakeDb,
      starters,
      now: () => NOW,
      onMathWorking: async (input) => {
        hookInputs.push(input);
        return null;
      },
    };

    const outcome = await ingestContent(
      deps,
      makeInput({
        image: { base64: jpeg.toString("base64"), mimeType: "image/jpeg" },
        imageMeta: { buffer: jpeg, width: 8, height: 8 },
        text: null,
      }),
    );

    expect(outcome.kind).toBe("math");
    if (outcome.kind !== "math") return;
    expect(hookInputs).toHaveLength(1); // the legacy hook still fires
    expect(calls.some((c) => c.purpose === "math")).toBe(true);
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.inserts[0]).toMatchObject({ title: "Math check: Sign errors", kind: "math_practice" });
    expect(fakeDb.events[0]).toMatchObject({ action: "created", evidence: "5 - 2 is 3, not 2" });
    expect(startersInserted).toHaveLength(1);
    expect(startersInserted[0]).toMatchObject({ taskId: "math-task-1", type: "math_diagnosis" });
    expect(uploaded).toEqual([{ path: "user-1/upload-1/annotated.jpg", contentType: "image/jpeg" }]);
    expect(startersInserted[0].annotatedImagePath).toBe("user-1/upload-1/annotated.jpg");
    expect(outcome.annotated).toBeInstanceOf(Buffer);
    expect(outcome.caption).toContain("Step 2 is where it slipped: 5 - 2 is 3, not 2");
    expect(outcome.practiceText).toContain("7 - 3 = ?");
    expect(outcome.extra).toBeNull();
    expect(fakeDb.finished[0].patch).toEqual({ status: "done", classifiedAs: "math_working", storagePath: null });
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

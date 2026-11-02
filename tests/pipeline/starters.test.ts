import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { FinishUploadPatch, InsertStarterInput, InsertTaskEventInput, InsertTaskInput } from "../../lib/db/queries";
import type { StarterRow, TaskRow, UploadRow, UserRow } from "../../lib/db/types";
import { quotaHitReply } from "../../lib/billing/copy";
import type { ClaimArgs } from "../../lib/billing/entitlements";
import { BudgetExceededError } from "../../lib/meta/client";
import type { GenerateObjectOptions, MetaClient, Usage } from "../../lib/meta/client";
import { executeOps } from "../../lib/pipeline/execute";
import { createIngestDeps, ingestContent, type IngestDeps, type IngestInput } from "../../lib/pipeline/ingest";
import {
  attachDocumentStarter,
  createStartersDeps,
  runMathDiagnosis,
  titleFromFilename,
  type StartersDeps,
} from "../../lib/pipeline/starters";
import type { UnderstandOutput } from "../../lib/pipeline/understand";
import { EmptyChecklistError } from "../../lib/starters/checklist";
import { FlashcardsTooThinError, NoStudyMaterialError } from "../../lib/starters/flashcards";
import { summaryReply } from "../../lib/telegram/replies";

// ingest deps read the lazy env proxy (textModel/textEffort) at call time, and
// bun auto-loads .env into process.env. Pin the vars here, exactly like
// tests/media/storage.test.ts does, so whichever file parses env first in a
// full run caches the same values for all of them.
const PINNED_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_BOT_USERNAME: "settle_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
  ALLOWED_TELEGRAM_IDS: "101",
  MODEL_API_KEY: "test-model-key",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SECRET_KEY: "test-supabase-key",
  SUPABASE_DB_URL: "postgresql://test:***@localhost:5432/test",
  SESSION_SECRET: "test-session-secret-0123456789",
  SUPABASE_STORAGE_BUCKET: "test-bucket",
};
for (const [key, value] of Object.entries(PINNED_ENV)) process.env[key] = value;
delete process.env.META_TEXT_MODEL;
delete process.env.META_TEXT_EFFORT;

const NOW = new Date("2026-10-28T09:00:00+08:00");
// 1 Nov 2026 00:00 SGT, the reset instant used by the refused-claim fakes.
const NOV_1_SGT = new Date("2026-10-31T16:00:00Z");
const USAGE: Usage = { inputTokens: 900, outputTokens: 200, cachedTokens: 0, costUsd: 0.002, latencyMs: 700 };

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

const upload: UploadRow = {
  id: "upload-1",
  user_id: "user-1",
  kind: "document",
  telegram_file_id: null,
  mime_type: "application/pdf",
  storage_path: null,
  text_content: null,
  classified_as: null,
  status: "processing",
  error: null,
  created_at: "2026-10-28T01:00:00.000Z",
};

const PDF = { base64: "JVBERi0=", filename: "lab4-brief.pdf" };

function taskRow(id: string, title: string): TaskRow {
  return {
    id,
    user_id: "user-1",
    title,
    course: "CS2030",
    kind: "assignment",
    due_at: "2026-11-06T15:59:00.000Z",
    effort: null,
    status: "open",
    origin: "capture",
    source_upload_id: null,
    weak_spot_id: null,
    created_at: "2026-10-27T01:00:00.000Z",
    updated_at: "2026-10-27T01:00:00.000Z",
  };
}

// One fake generateObject for every purpose, so e2e runs drive real understand
// plus the real starter generators against canned data.
function makePurposeGenerateObject(byPurpose: Record<string, unknown | Error>) {
  const calls: GenerateObjectOptions<unknown>[] = [];
  const generateObject: MetaClient["generateObject"] = async (opts) => {
    calls.push(opts as GenerateObjectOptions<unknown>);
    const next = byPurpose[opts.purpose];
    if (next === undefined) throw new Error(`no fake data for purpose ${opts.purpose}`);
    if (next instanceof Error) throw next;
    return { data: next as never, usage: USAGE };
  };
  return { generateObject, calls };
}

function makeStartersDeps(
  generateObject: MetaClient["generateObject"],
  billing: { claim?: "ok" | "refuse" | "throw" } = {},
) {
  const inserted: InsertTaskInput[] = [];
  const events: InsertTaskEventInput[] = [];
  const starters: InsertStarterInput[] = [];
  const uploads: Array<{ path: string; size: number; contentType: string }> = [];
  const claims: ClaimArgs[] = [];
  const consumed: string[] = [];
  const released: string[] = [];
  let seq = 0;
  const deps: StartersDeps = {
    generateObject,
    insertTask: async (i) => {
      inserted.push(i);
      seq += 1;
      return {
        id: `new-${seq}`,
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
    },
    insertTaskEvent: async (i) => {
      events.push(i);
    },
    insertStarter: async (i) => {
      starters.push(i);
      const row: StarterRow = {
        id: `starter-${starters.length}`,
        task_id: i.taskId,
        type: i.type,
        content: i.content,
        annotated_image_path: i.annotatedImagePath ?? null,
        created_at: NOW.toISOString(),
      };
      return row;
    },
    uploadBuffer: async (path, buffer, contentType) => {
      uploads.push({ path, size: buffer.byteLength, contentType });
    },
    claimFeature: async (args) => {
      claims.push(args);
      if (billing.claim === "refuse") {
        return {
          ok: false as const,
          reason: "quota" as const,
          used: 1,
          limit: 1,
          plan: "free" as const,
          resetsAt: NOV_1_SGT,
        };
      }
      if (billing.claim === "throw") throw new Error("claim_usage rpc missing");
      return { ok: true as const, usageId: `usage-${claims.length}`, plan: "free" as const };
    },
    consumeUsage: async (usageId) => {
      consumed.push(usageId);
    },
    releaseUsage: async (usageId) => {
      released.push(usageId);
    },
    now: () => NOW,
  };
  return { deps, inserted, events, starters, uploads, claims, consumed, released };
}

function checklistItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `raw-${i + 1}`,
    text: `Requirement ${i + 1}`,
    category: "deliverable" as const,
    page: i + 1,
    done: true,
  }));
}

function flashcardsData(cards: number, practice: number) {
  return {
    cards: Array.from({ length: cards }, (_, i) => ({ front: `Front ${i + 1}`, back: `Back ${i + 1}`, page: i + 1 })),
    practice: Array.from({ length: practice }, (_, i) => ({ question: `Question ${i + 1}`, answer: `Answer ${i + 1}`, page: i + 1 })),
  };
}

const MATH_WRONG = {
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

const MATH_CORRECT = {
  steps: [
    { index: 1, latex_or_text: "2x = 6", bbox: { x1: 10, y1: 10, x2: 200, y2: 80 } },
    { index: 2, latex_or_text: "x = 3", bbox: null },
  ],
  is_correct: true,
  first_error_step: null,
  what_went_wrong: null,
  misconception: null,
  correct_next_step: null,
  final_answer_check: "x = 3 is right.",
  practice: [],
};

const MATH_UNREADABLE = {
  steps: [],
  is_correct: false,
  first_error_step: null,
  what_went_wrong: "too blurry",
  misconception: null,
  correct_next_step: null,
  final_answer_check: "",
  practice: [],
};

async function tinyJpeg(): Promise<{ buffer: Buffer; width: number; height: number }> {
  const buffer = Buffer.from(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 30 } } })
      .jpeg()
      .toBuffer(),
  );
  return { buffer, width: 8, height: 8 };
}

function assertNoDashes(text: string): void {
  expect(text.includes("\u2014")).toBe(false);
  expect(text.includes("\u2013")).toBe(false);
}

describe("attachDocumentStarter", () => {
  test("checklist attaches to the first created task", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: { items: checklistItems(2) } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4"), taskRow("task-b", "CS2030 Lab 5")],
      updated: [],
    });

    expect("summary" in result && result.summary).toEqual({ type: "checklist", count: 2 });
    if (!("summary" in result)) return;
    expect(result.task.id).toBe("task-a");
    expect(fake.starters).toHaveLength(1);
    expect(fake.starters[0]).toMatchObject({ taskId: "task-a", type: "checklist" });
    expect(fake.inserted).toHaveLength(0);
  });

  test("attaches to the first updated task when nothing was created", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: { items: checklistItems(3) } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [],
      updated: [{ task: taskRow("task-b", "CS2030 Lab 4") }],
    });

    if (!("summary" in result)) throw new Error("expected an attach");
    expect(result.task.id).toBe("task-b");
    expect(fake.starters[0].taskId).toBe("task-b");
  });

  test("assignment brief with no task is skipped before any AI call", async () => {
    const { generateObject, calls } = makePurposeGenerateObject({ checklist: { items: checklistItems(2) } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [],
      updated: [],
    });

    expect("skipped" in result && result.skipped).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(fake.starters).toHaveLength(0);
    expect(fake.inserted).toHaveLength(0);
  });

  test("flashcards attach to a created task with card and practice counts", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: flashcardsData(12, 4) });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [taskRow("task-a", "Cell division")],
      updated: [],
    });

    if (!("summary" in result)) throw new Error("expected an attach");
    expect(result.summary).toEqual({ type: "flashcards", count: 12, secondaryCount: 4 });
    expect(result.task.id).toBe("task-a");
    expect(fake.starters[0]).toMatchObject({ taskId: "task-a", type: "flashcards" });
  });

  test("flashcards with no task create one Revise reading task with a created event", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: flashcardsData(10, 3) });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: { base64: "JVBERi0=", filename: "chapter_4-photosynthesis.pdf" },
      inputKind: "lecture_slides",
      created: [],
      updated: [],
    });

    if (!("summary" in result)) throw new Error("expected an attach");
    expect(fake.inserted).toEqual([
      {
        userId: "user-1",
        title: "Revise: chapter 4 photosynthesis",
        course: null,
        kind: "reading",
        dueAt: null,
        effort: null,
        origin: "capture",
        sourceUploadId: "upload-1",
      },
    ]);
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]).toMatchObject({
      taskId: result.task.id,
      uploadId: "upload-1",
      action: "created",
      evidence: "chapter_4-photosynthesis.pdf",
    });
    expect(fake.starters[0].taskId).toBe(result.task.id);
  });

  test.each([
    ["Lecture_04-Cell_Division.pdf", "Lecture 04 Cell Division"],
    ["w1.notes.final.PDF", "w1.notes.final"],
    ["__mixed--parts__.pdf", "mixed parts"],
    ["no extension here", "no extension here"],
    [`${"a".repeat(100)}.pdf`, `Revise placeholder`],
  ])("fallback title rule for %s", (filename, expected) => {
    if (expected === "Revise placeholder") {
      // A 100 char stem is cut to 80 and never keeps trailing spaces.
      expect(titleFromFilename(filename)).toHaveLength(80);
      expect(titleFromFilename(filename).endsWith(" ")).toBe(false);
      return;
    }
    expect(titleFromFilename(filename)).toBe(expected);
  });

  test("EmptyChecklistError is returned, never thrown, and no starter is written", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: { items: [] } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("error" in result && result.error instanceof EmptyChecklistError).toBe(true);
    expect(fake.starters).toHaveLength(0);
  });

  test("NoStudyMaterialError is returned for slides with nothing teachable", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: { cards: [], practice: [] } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [taskRow("task-a", "Cell division")],
      updated: [],
    });

    expect("error" in result && result.error instanceof NoStudyMaterialError).toBe(true);
  });

  test("FlashcardsTooThinError is returned after the thickness retry", async () => {
    const { generateObject, calls } = makePurposeGenerateObject({ flashcards: flashcardsData(2, 1) });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [taskRow("task-a", "Cell division")],
      updated: [],
    });

    expect("error" in result && result.error instanceof FlashcardsTooThinError).toBe(true);
    expect(calls).toHaveLength(2); // the one regeneration happened
  });

  test("an unknown generator error is returned as is", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: new Error("kaboom") });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("error" in result && result.error.message).toBe("kaboom");
  });

  test("a failed fallback keeps the created Revise task on the error result", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: { cards: [], practice: [] } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: { base64: "JVBERi0=", filename: "chapter_9.pdf" },
      inputKind: "lecture_slides",
      created: [],
      updated: [],
    });

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error instanceof NoStudyMaterialError).toBe(true);
    expect(result.task?.title).toBe("Revise: chapter 9");
    expect(fake.inserted).toHaveLength(1); // the task write survives
  });
});

describe("runMathDiagnosis", () => {
  test("wrong working writes the practice task, the starter and the annotated upload", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: "find x" });

    if (result.status !== "wrong") throw new Error("expected a wrong diagnosis");
    expect(fake.inserted).toEqual([
      {
        userId: "user-1",
        title: "Math check: Sign errors",
        course: null,
        kind: "math_practice",
        dueAt: null,
        effort: null,
        origin: "capture",
        sourceUploadId: "upload-1",
      },
    ]);
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]).toMatchObject({ action: "created", evidence: "5 - 2 is 3, not 2" });
    expect(fake.uploads).toEqual([
      { path: "user-1/upload-1/annotated.jpg", contentType: "image/jpeg", size: expect.any(Number) },
    ]);
    expect(fake.starters).toHaveLength(1);
    expect(fake.starters[0]).toMatchObject({
      taskId: result.task.id,
      type: "math_diagnosis",
      annotatedImagePath: "user-1/upload-1/annotated.jpg",
    });
    expect(result.outcome.annotated).toBeInstanceOf(Buffer);
    expect(result.outcome.annotated!.byteLength).toBeGreaterThan(0);
    expect(result.outcome.caption).toContain("Step 2 is where it slipped: 5 - 2 is 3, not 2");
    expect(result.outcome.caption).toContain("(Sign errors)");
    expect(result.outcome.practiceText).toContain("7 - 3 = ?");
    expect(result.outcome.extra).toBeNull();
    assertNoDashes(result.outcome.caption);
  });

  test("wrong working without a usable box skips the annotated upload", async () => {
    const image = await tinyJpeg();
    const noBox = {
      ...MATH_WRONG,
      steps: [
        { index: 1, latex_or_text: "x + 2 = 5", bbox: { x1: 50, y1: 50, x2: 300, y2: 120 } },
        { index: 2, latex_or_text: "x = 5 - 2 = 2", bbox: null },
      ],
    };
    const { generateObject } = makePurposeGenerateObject({ math: noBox });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    if (result.status !== "wrong") throw new Error("expected a wrong diagnosis");
    expect(fake.uploads).toHaveLength(0);
    expect(fake.starters[0].annotatedImagePath).toBeNull();
    expect(result.outcome.annotated).toBeNull();
  });

  test("correct working writes nothing and answers with text only", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_CORRECT });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("correct");
    expect(fake.inserted).toHaveLength(0);
    expect(fake.events).toHaveLength(0);
    expect(fake.starters).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(result.outcome.caption.startsWith("Every step checks out.")).toBe(true);
    expect(result.outcome.annotated).toBeNull();
    expect(result.outcome.practiceText).toBeNull();
    expect(result.outcome.extra).toBeNull();
  });

  test("unreadable working writes nothing and asks for a sharper photo", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_UNREADABLE });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("unreadable");
    expect(fake.inserted).toHaveLength(0);
    expect(fake.starters).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(result.outcome.caption).toBe(
      "I couldn't read that working clearly. Could you send a sharper photo, with the page flat and well lit?",
    );
    expect(result.outcome.annotated).toBeNull();
    expect(result.outcome.practiceText).toBeNull();
  });

  test("a failing model call propagates before anything is written", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: new Error("Meta API down") });
    const fake = makeStartersDeps(generateObject);

    await expect(
      runMathDiagnosis(fake.deps, { user, upload, image, caption: null }),
    ).rejects.toThrow("Meta API down");
    expect(fake.inserted).toHaveLength(0);
    expect(fake.starters).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
  });

  test("onDiagnosisRecorded: a returned string lands in extra", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject);
    fake.deps.onDiagnosisRecorded = async () => "I will bring this back for review soon.";

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("wrong");
    expect(result.outcome.extra).toBe("I will bring this back for review soon.");
  });

  test("onDiagnosisRecorded: an exception is swallowed, logged and extra stays null", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject);
    fake.deps.onDiagnosisRecorded = async () => {
      throw new Error("weak spot db down");
    };

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("wrong");
    expect(result.outcome.extra).toBeNull();
    expect(fake.starters).toHaveLength(1); // the starter write survived the hook
  });
});

describe("usage gate: document starters", () => {
  test("brief: claims once with the upload id and feature, consumes on success, never releases", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: { items: checklistItems(2) } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("summary" in result).toBe(true);
    expect(fake.claims).toEqual([
      { userId: "user-1", feature: "brief_checklist", uploadId: "upload-1" },
    ]);
    expect(fake.consumed).toEqual(["usage-1"]);
    expect(fake.released).toEqual([]);
  });

  test("slides: the claimed feature is slides_flashcards", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: flashcardsData(10, 3) });
    const fake = makeStartersDeps(generateObject);

    await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [taskRow("task-a", "Cell division")],
      updated: [],
    });

    expect(fake.claims).toEqual([
      { userId: "user-1", feature: "slides_flashcards", uploadId: "upload-1" },
    ]);
    expect(fake.consumed).toEqual(["usage-1"]);
  });

  test("a throwing AI call releases the claimed use and the error handling is unchanged", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: new Error("kaboom") });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("error" in result && result.error.message).toBe("kaboom");
    expect(fake.released).toEqual(["usage-1"]);
    expect(fake.consumed).toEqual([]);
  });

  test("an empty checklist releases instead of consuming", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: { items: [] } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("error" in result && result.error instanceof EmptyChecklistError).toBe(true);
    expect(fake.released).toEqual(["usage-1"]);
    expect(fake.consumed).toEqual([]);
  });

  test("slides with no study material release", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: { cards: [], practice: [] } });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [taskRow("task-a", "Cell division")],
      updated: [],
    });

    expect("error" in result && result.error instanceof NoStudyMaterialError).toBe(true);
    expect(fake.released).toEqual(["usage-1"]);
    expect(fake.consumed).toEqual([]);
  });

  test("too-thin flashcards release", async () => {
    const { generateObject } = makePurposeGenerateObject({ flashcards: flashcardsData(2, 1) });
    const fake = makeStartersDeps(generateObject);

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [taskRow("task-a", "Cell division")],
      updated: [],
    });

    expect("error" in result && result.error instanceof FlashcardsTooThinError).toBe(true);
    expect(fake.released).toEqual(["usage-1"]);
    expect(fake.consumed).toEqual([]);
  });

  test("quota refused brief: no AI call, no starter, the blocked text is the quota reply", async () => {
    const { generateObject, calls } = makePurposeGenerateObject({ checklist: { items: checklistItems(2) } });
    const fake = makeStartersDeps(generateObject, { claim: "refuse" });

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect(calls).toHaveLength(0); // the generateObject fake was never touched
    expect(fake.starters).toHaveLength(0);
    if (!("blocked" in result)) throw new Error("expected a blocked result");
    expect(result.blocked).toBe(
      quotaHitReply({ feature: "brief_checklist", limit: 1, resetsAt: NOV_1_SGT, reason: "quota" }),
    );
    expect(fake.consumed).toEqual([]);
    expect(fake.released).toEqual([]);
  });

  test("quota refused slides keep the fallback Revise task they already wrote", async () => {
    const { generateObject, calls } = makePurposeGenerateObject({ flashcards: flashcardsData(10, 3) });
    const fake = makeStartersDeps(generateObject, { claim: "refuse" });

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "lecture_slides",
      created: [],
      updated: [],
    });

    if (!("blocked" in result)) throw new Error("expected a blocked result");
    expect(result.task?.title).toBe("Revise: lab4 brief");
    expect(fake.inserted).toHaveLength(1); // the task write survived the refusal
    expect(calls).toHaveLength(0);
    expect(fake.starters).toHaveLength(0);
  });

  test("a broken ledger (claim throws) never blocks the checklist: one log line, no settle calls", async () => {
    const { generateObject, calls } = makePurposeGenerateObject({ checklist: { items: checklistItems(2) } });
    const fake = makeStartersDeps(generateObject, { claim: "throw" });
    const logs: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    let result: Awaited<ReturnType<typeof attachDocumentStarter>>;
    try {
      result = await attachDocumentStarter(fake.deps, {
        user,
        upload,
        pdf: PDF,
        inputKind: "assignment_brief",
        created: [taskRow("task-a", "CS2030 Lab 4")],
        updated: [],
      });
    } finally {
      console.error = originalError;
    }

    expect("summary" in result).toBe(true);
    expect(calls).toHaveLength(1); // the AI call ran anyway
    expect(fake.consumed).toEqual([]); // no ledger row, nothing to settle
    expect(fake.released).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(String(logs[0]?.[0])).toContain("usage gate unavailable");
  });

  test("a throwing consume never masks the result", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: { items: checklistItems(2) } });
    const fake = makeStartersDeps(generateObject);
    fake.deps.consumeUsage = async () => {
      throw new Error("ledger down");
    };

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("summary" in result && result.summary).toEqual({ type: "checklist", count: 2 });
  });

  test("a throwing release never masks the original error", async () => {
    const { generateObject } = makePurposeGenerateObject({ checklist: new Error("kaboom") });
    const fake = makeStartersDeps(generateObject);
    fake.deps.releaseUsage = async () => {
      throw new Error("ledger down");
    };

    const result = await attachDocumentStarter(fake.deps, {
      user,
      upload,
      pdf: PDF,
      inputKind: "assignment_brief",
      created: [taskRow("task-a", "CS2030 Lab 4")],
      updated: [],
    });

    expect("error" in result && result.error.message).toBe("kaboom");
  });
});

describe("usage gate: math diagnosis", () => {
  test("claims with the upload id and consumes once after a usable diagnosis", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: "find x" });

    expect(result.status).toBe("wrong");
    expect(fake.claims).toEqual([
      { userId: "user-1", feature: "math_diagnosis", uploadId: "upload-1" },
    ]);
    expect(fake.consumed).toEqual(["usage-1"]);
    expect(fake.released).toEqual([]);
  });

  test("a correct diagnosis consumes too", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_CORRECT });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("correct");
    expect(fake.consumed).toEqual(["usage-1"]);
    expect(fake.released).toEqual([]);
  });

  test("an unreadable photo releases instead of consuming", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_UNREADABLE });
    const fake = makeStartersDeps(generateObject);

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("unreadable");
    expect(fake.consumed).toEqual([]);
    expect(fake.released).toEqual(["usage-1"]);
    expect(fake.inserted).toHaveLength(0);
    expect(fake.starters).toHaveLength(0);
  });

  test("a failing model call releases and still propagates", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: new Error("Meta API down") });
    const fake = makeStartersDeps(generateObject);

    await expect(
      runMathDiagnosis(fake.deps, { user, upload, image, caption: null }),
    ).rejects.toThrow("Meta API down");
    expect(fake.consumed).toEqual([]);
    expect(fake.released).toEqual(["usage-1"]);
    expect(fake.inserted).toHaveLength(0);
  });

  test("quota refused: no AI call, no task, and the whole reply is the quota text", async () => {
    const image = await tinyJpeg();
    const { generateObject, calls } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject);
    fake.deps.claimFeature = async (args) => {
      fake.claims.push(args);
      return {
        ok: false as const,
        reason: "quota" as const,
        used: 3,
        limit: 3,
        plan: "free" as const,
        resetsAt: NOV_1_SGT,
      };
    };

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.outcome).toEqual({
      caption: quotaHitReply({ feature: "math_diagnosis", limit: 3, resetsAt: NOV_1_SGT, reason: "quota" }),
      annotated: null,
      practiceText: null,
      extra: null,
    });
    expect(calls).toHaveLength(0); // no AI call at all
    expect(fake.inserted).toHaveLength(0); // no task either
    expect(fake.starters).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.consumed).toEqual([]);
    expect(fake.released).toEqual([]);
  });

  test("a broken ledger never blocks the diagnosis", async () => {
    const image = await tinyJpeg();
    const { generateObject, calls } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject, { claim: "throw" });
    const logs: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    let result: Awaited<ReturnType<typeof runMathDiagnosis>>;
    try {
      result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });
    } finally {
      console.error = originalError;
    }

    expect(result.status).toBe("wrong");
    expect(calls).toHaveLength(1);
    expect(fake.consumed).toEqual([]);
    expect(fake.released).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(String(logs[0]?.[0])).toContain("usage gate unavailable");
  });

  test("a throwing consume never breaks the diagnosis reply", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ math: MATH_WRONG });
    const fake = makeStartersDeps(generateObject);
    fake.deps.consumeUsage = async () => {
      throw new Error("ledger down");
    };

    const result = await runMathDiagnosis(fake.deps, { user, upload, image, caption: null });

    expect(result.status).toBe("wrong");
    expect(fake.starters).toHaveLength(1);
  });
});

describe("createStartersDeps", () => {
  test("onDiagnosisRecorded defaults to the real weak-spot recorder and overrides win", () => {
    const deps = createStartersDeps();
    expect(typeof deps.onDiagnosisRecorded).toBe("function");
    const custom = async () => "custom line";
    expect(createStartersDeps({ onDiagnosisRecorded: custom }).onDiagnosisRecorded).toBe(custom);
  });

  test("the usage gate defaults are wired functions, resolved lazily", () => {
    const deps = createStartersDeps();
    expect(typeof deps.claimFeature).toBe("function");
    expect(typeof deps.consumeUsage).toBe("function");
    expect(typeof deps.releaseUsage).toBe("function");
    // Overriding one billing seam leaves the others on their defaults.
    const consume = async () => {};
    expect(createStartersDeps({ consumeUsage: consume }).consumeUsage).toBe(consume);
    expect(typeof createStartersDeps({ consumeUsage: consume }).claimFeature).toBe("function");
  });
});


// ---- end to end through ingestContent (failure isolation) ----

// The REAL executeOps runs against these fake db deps, so created tasks carry
// real ids by the time the starter step runs.
function makeE2eDb() {
  const inserts: InsertTaskInput[] = [];
  const updates: Array<{ id: string; userId: string; patch: Record<string, unknown> }> = [];
  const events: InsertTaskEventInput[] = [];
  const finished: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let seq = 0;
  const taskFromInput = (i: InsertTaskInput): TaskRow => {
    seq += 1;
    return {
      id: `new-${seq}`,
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
  };
  return {
    inserts,
    updates,
    events,
    finished,
    listOpenTasks: async () => [] as TaskRow[],
    executeOps: (ops: Parameters<typeof executeOps>[0], ctx: { userId: string; uploadId: string }) =>
      executeOps(ops, ctx, {
        insertTask: async (i) => {
          inserts.push(i);
          return taskFromInput(i);
        },
        updateTask: async (id, userId, patch) => {
          updates.push({ id, userId, patch: patch as Record<string, unknown> });
          return { ...taskFromInput({ userId, title: "x", kind: "other" }), id, ...patch } as TaskRow;
        },
        insertTaskEvent: async (i) => {
          events.push(i);
        },
      }),
    finishUpload: async (id: string, patch: FinishUploadPatch) => {
      finished.push({ id, patch: patch as Record<string, unknown> });
    },
  };
}

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
  answer_to_student: null,
};

const SLIDES_OUTPUT: UnderstandOutput = {
  input_kind: "lecture_slides",
  extracted_text: "photosynthesis slides",
  actions: [],
  needs_clarification: null,
  answer_to_student: null,
};

const MATH_OUTPUT: UnderstandOutput = {
  input_kind: "math_working",
  extracted_text: "x + 2 = 5",
  actions: [],
  needs_clarification: null,
  answer_to_student: null,
};

function makeInput(overrides: Partial<IngestInput> = {}): IngestInput {
  return { user, upload, text: null, ...overrides };
}

function e2eDeps(
  purposeData: Record<string, unknown | Error>,
  fakeDb: ReturnType<typeof makeE2eDb>,
  starters: ReturnType<typeof makeStartersDeps>,
  generateObject: MetaClient["generateObject"],
): IngestDeps {
  return {
    ...createIngestDeps(),
    generateObject,
    listOpenTasks: fakeDb.listOpenTasks,
    executeOps: fakeDb.executeOps,
    finishUpload: fakeDb.finishUpload,
    starters: starters.deps,
    now: () => NOW,
  };
}

describe("ingestContent: starter wiring end to end", () => {
  test("a failed checklist never fails the capture: task stays, upload done, plain sentence added", async () => {
    const { generateObject } = makePurposeGenerateObject({
      understand: BRIEF_OUTPUT,
      checklist: new EmptyChecklistError(),
    });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({ pdf: PDF }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(fakeDb.inserts).toHaveLength(1); // the task survived
    expect(starters.starters).toHaveLength(0);
    expect(outcome.starter).toEqual({ status: "failed", reason: "empty_checklist" });
    expect(fakeDb.finished[0].patch.status).toBe("done"); // the upload still finished
    const reply = summaryReply(outcome);
    expect(reply).toContain("CS2030 Lab 4");
    expect(reply).toContain("I couldn't find a list of requirements in that PDF.");
    assertNoDashes(reply);
  });

  test("slides with no model task create the Revise task and the reply shows it with the flashcards line", async () => {
    const { generateObject } = makePurposeGenerateObject({
      understand: SLIDES_OUTPUT,
      flashcards: flashcardsData(14, 4),
    });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({ pdf: { base64: PDF.base64, filename: "chapter_4-photosynthesis.pdf" } }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    // The fallback task is folded into the created list so the reply shows it.
    expect(outcome.result.created).toHaveLength(1);
    expect(outcome.result.created[0]).toMatchObject({
      title: "Revise: chapter 4 photosynthesis",
      kind: "reading",
      due_at: null,
    });
    expect(starters.starters[0]).toMatchObject({ taskId: outcome.result.created[0].id, type: "flashcards" });
    expect(outcome.starter).toEqual({ status: "made", type: "flashcards", count: 14, secondaryCount: 4 });
    const reply = summaryReply(outcome);
    expect(reply).toContain("Added 1 task:");
    expect(reply).toContain("- Revise: chapter 4 photosynthesis");
    expect(reply).toContain("I also made 14 flashcards and 4 practice questions from your slides.");
    assertNoDashes(reply);
  });

  test("no study material keeps the Revise task and adds its sentence", async () => {
    const { generateObject } = makePurposeGenerateObject({
      understand: SLIDES_OUTPUT,
      flashcards: { cards: [], practice: [] },
    });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({ pdf: { base64: PDF.base64, filename: "chapter_9-ecology.pdf" } }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(outcome.result.created).toHaveLength(1); // the Revise task was not lost
    expect(outcome.starter).toEqual({ status: "failed", reason: "no_study_material" });
    expect(fakeDb.finished[0].patch.status).toBe("done");
    const reply = summaryReply(outcome);
    expect(reply).toContain("Revise: chapter 9 ecology");
    expect(reply).toContain("That PDF didn't look like study material, so I skipped the flashcards.");
    assertNoDashes(reply);
  });

  test("too thin flashcards keep the Revise task and add their sentence", async () => {
    const { generateObject } = makePurposeGenerateObject({
      understand: SLIDES_OUTPUT,
      flashcards: flashcardsData(2, 1),
    });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({ pdf: { base64: PDF.base64, filename: "chapter_9-ecology.pdf" } }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(outcome.result.created).toHaveLength(1);
    expect(outcome.starter).toEqual({ status: "failed", reason: "too_thin" });
    expect(fakeDb.finished[0].patch.status).toBe("done");
    expect(summaryReply(outcome)).toContain(
      "There wasn't enough on those slides for a full set of flashcards.",
    );
  });

  test("an unknown starter error adds the generic sentence and keeps everything written", async () => {
    const { generateObject } = makePurposeGenerateObject({
      understand: BRIEF_OUTPUT,
      checklist: new Error("kaboom"),
    });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({ pdf: PDF }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(outcome.starter).toEqual({ status: "failed", reason: "generic" });
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.finished[0].patch.status).toBe("done");
    expect(summaryReply(outcome)).toContain(
      "I added the task but couldn't build the extra help this time. Try sending the file again.",
    );
  });

  test("a budget refusal after the task was written stays isolated: sentence, done upload, no throw", async () => {
    const { generateObject } = makePurposeGenerateObject({
      understand: BRIEF_OUTPUT,
      checklist: new BudgetExceededError(12.5, 10),
    });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({ pdf: PDF }),
    );

    expect(outcome.kind).toBe("tasks");
    if (outcome.kind !== "tasks") return;
    expect(outcome.starter).toEqual({ status: "failed", reason: "generic" });
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.finished[0].patch.status).toBe("done");
    expect(summaryReply(outcome)).toContain(
      "I added the task but couldn't build the extra help this time.",
    );
  });

  test("math photo end to end: outcome carries the annotated buffer and the upload finishes as math_working", async () => {
    const image = await tinyJpeg();
    const { generateObject } = makePurposeGenerateObject({ understand: MATH_OUTPUT, math: MATH_WRONG });
    const fakeDb = makeE2eDb();
    const starters = makeStartersDeps(generateObject);

    const outcome = await ingestContent(
      e2eDeps({}, fakeDb, starters, generateObject),
      makeInput({
        image: { base64: image.buffer.toString("base64"), mimeType: "image/jpeg" },
        imageMeta: image,
      }),
    );

    expect(outcome.kind).toBe("math");
    if (outcome.kind !== "math") return;
    expect(outcome.annotated).toBeInstanceOf(Buffer);
    expect(outcome.caption).toContain("Step 2 is where it slipped");
    expect(starters.inserted).toHaveLength(1);
    expect(starters.inserted[0].kind).toBe("math_practice");
    expect(starters.starters[0].type).toBe("math_diagnosis");
    expect(fakeDb.finished).toEqual([
      { id: "upload-1", patch: { status: "done", classifiedAs: "math_working", storagePath: null } },
    ]);
  });
});

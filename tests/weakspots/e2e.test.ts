import { describe, expect, mock, test } from "bun:test";
import type {
  InsertStarterInput,
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
  UpsertWeakSpotInput,
} from "../../lib/db/queries";
import type { StarterRow, TaskRow } from "../../lib/db/types";
import type { GenerateObjectOptions, MetaClient, Usage } from "../../lib/meta/client";
import { createStartersDeps, runMathDiagnosis } from "../../lib/pipeline/starters";
import type { MathDiagnosis } from "../../lib/starters/types";
import { createDiagnosisRecorder } from "../../lib/weakspots/record";

// 09:00 SGT, Wednesday 28 October 2026.
const NOW = new Date("2026-10-28T01:00:00.000Z");
const USAGE: Usage = { inputTokens: 900, outputTokens: 200, cachedTokens: 0, costUsd: 0.002, latencyMs: 700 };

mock.module("server-only", () => ({}));

const user = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  created_at: "2026-10-01T01:00:00.000Z",
};

const uploadRow = {
  id: "upload-1",
  user_id: "user-1",
  kind: "photo",
  telegram_file_id: "file-1",
  mime_type: "image/jpeg",
  storage_path: null,
  text_content: null,
  classified_as: "math_working",
  status: "processing",
  error: null,
  created_at: NOW.toISOString(),
};

// Wrong working with no bbox, so the e2e never needs a real annotated JPEG.
const MATH_WRONG: MathDiagnosis = {
  steps: [
    { index: 1, latex_or_text: "5 - 8 = 3", bbox: null },
  ],
  is_correct: false,
  first_error_step: 1,
  what_went_wrong: "the minus sign slipped",
  misconception: { topic: "sign_errors", detail: "subtracting the wrong way round" },
  correct_next_step: "8 - 5 = 3, so 5 - 8 = -3",
  final_answer_check: "The answer should be -3.",
  practice: [{ question: "5 - 8 = ?", answer: "-3" }],
};

function makeGenerateObject(): MetaClient["generateObject"] {
  return async (opts: GenerateObjectOptions<unknown>) => {
    if (opts.purpose !== "math") throw new Error(`no fake data for purpose ${opts.purpose}`);
    return { data: MATH_WRONG as never, usage: USAGE };
  };
}

// In-memory weak-spot state shared across diagnoses, like the real tables.
function makeRecorderDeps() {
  const reviewTasks: TaskRow[] = [];
  const events: InsertTaskEventInput[] = [];
  const starters: InsertStarterInput[] = [];
  const updates: Array<{ id: string; userId: string; patch: UpdateTaskPatch }> = [];
  let occurrences = 0;
  let reviewSeq = 0;

  const openReview = (): TaskRow | null => reviewTasks[reviewTasks.length - 1] ?? null;

  const deps = {
    upsertWeakSpot: async (i: UpsertWeakSpotInput) => {
      occurrences += 1;
      return {
        id: "spot-1",
        user_id: i.userId,
        topic: i.topic,
        latest_misconception: i.misconception,
        occurrences,
        last_seen_at: i.now.toISOString(),
        next_review_at: null,
      };
    },
    setWeakSpotNextReview: async () => ({
      id: "spot-1",
      user_id: "user-1",
      topic: "sign_errors",
      latest_misconception: "x",
      occurrences,
      last_seen_at: NOW.toISOString(),
      next_review_at: null,
    }),
    findOpenReviewTask: async () => openReview(),
    insertTask: async (i: InsertTaskInput) => {
      reviewSeq += 1;
      const row: TaskRow = {
        id: `review-${reviewSeq}`,
        user_id: i.userId,
        title: i.title,
        course: i.course ?? null,
        kind: i.kind,
        due_at: i.dueAt ?? null,
        effort: i.effort ?? null,
        status: "open",
        origin: i.origin ?? "capture",
        source_upload_id: i.sourceUploadId ?? null,
        weak_spot_id: i.weakSpotId ?? null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      };
      reviewTasks.push(row);
      return row;
    },
    insertTaskEvent: async (i: InsertTaskEventInput) => {
      events.push(i);
    },
    insertStarter: async (i: InsertStarterInput) => {
      starters.push(i);
      const row: StarterRow = {
        id: `starter-${starters.length}`,
        task_id: i.taskId,
        type: i.type,
        content: i.content,
        annotated_image_path: null,
        created_at: NOW.toISOString(),
      };
      return row;
    },
    updateTask: async (id: string, userId: string, patch: UpdateTaskPatch) => {
      updates.push({ id, userId, patch });
      const row = reviewTasks.find((task) => task.id === id) ?? ({} as TaskRow);
      return { ...row, ...patch } as TaskRow;
    },
    now: () => NOW,
  };
  return { deps, reviewTasks, events, starters, updates };
}

describe("weak-spot loop end to end", () => {
  test("a wrong math diagnosis records the weak spot and appends the review sentence to extra", async () => {
    const recorder = makeRecorderDeps();
    const mathTasks: InsertTaskInput[] = [];
    const deps = createStartersDeps({
      generateObject: makeGenerateObject(),
      insertTask: async (i) => {
        mathTasks.push(i);
        return {
          id: `math-task-${mathTasks.length}`,
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
      insertTaskEvent: async () => {},
      insertStarter: async (i) => ({
        id: "starter-math",
        task_id: i.taskId,
        type: i.type,
        content: i.content,
        annotated_image_path: null,
        created_at: NOW.toISOString(),
      }),
      uploadBuffer: async () => {},
      // Billing fakes: this e2e must never reach the real usage ledger (the
      // 0002 migration may not be applied), and a real claim would resolve
      // the shared env cache mid-suite and break later env-pinning tests.
      claimFeature: async () => ({ ok: true as const, usageId: "", plan: "pro" as const }),
      consumeUsage: async () => {},
      releaseUsage: async () => {},
      now: () => NOW,
      onDiagnosisRecorded: createDiagnosisRecorder(recorder.deps),
    });

    const result = await runMathDiagnosis(deps, {
      user,
      upload: uploadRow as Parameters<typeof runMathDiagnosis>[1]["upload"],
      image: { buffer: Buffer.from("stub-jpeg"), width: 8, height: 8 },
      caption: null,
    });

    expect(result.status).toBe("wrong");
    expect(mathTasks[0].kind).toBe("math_practice");
    // First occurrence: +3 days, Saturday 31 Oct SGT.
    expect(result.outcome.extra).toBe("I've added a review for Sat so this sticks.");
    expect(recorder.reviewTasks).toHaveLength(1);
    expect(recorder.reviewTasks[0]).toMatchObject({
      kind: "review",
      origin: "weak_spot",
      due_at: "2026-10-31T15:59:00.000Z",
      weak_spot_id: "spot-1",
    });
    expect(recorder.starters[0]).toMatchObject({
      taskId: recorder.reviewTasks[0].id,
      type: "review_practice",
    });
  });

  test("a second wrong diagnosis reschedules the same review task, no duplicate", async () => {
    const recorder = makeRecorderDeps();
    const deps = createStartersDeps({
      generateObject: makeGenerateObject(),
      insertTask: async (i) => ({
        id: `math-task-${i.title}`,
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
      }),
      insertTaskEvent: async () => {},
      insertStarter: async (i) => ({
        id: "starter-math",
        task_id: i.taskId,
        type: i.type,
        content: i.content,
        annotated_image_path: null,
        created_at: NOW.toISOString(),
      }),
      uploadBuffer: async () => {},
      // Billing fakes: this e2e must never reach the real usage ledger (the
      // 0002 migration may not be applied), and a real claim would resolve
      // the shared env cache mid-suite and break later env-pinning tests.
      claimFeature: async () => ({ ok: true as const, usageId: "", plan: "pro" as const }),
      consumeUsage: async () => {},
      releaseUsage: async () => {},
      now: () => NOW,
      onDiagnosisRecorded: createDiagnosisRecorder(recorder.deps),
    });
    const ctx = {
      user,
      upload: uploadRow as Parameters<typeof runMathDiagnosis>[1]["upload"],
      image: { buffer: Buffer.from("stub-jpeg"), width: 8, height: 8 },
      caption: null,
    };

    const first = await runMathDiagnosis(deps, ctx);
    expect(first.outcome.extra).toBe("I've added a review for Sat so this sticks.");

    const second = await runMathDiagnosis(deps, ctx);
    expect(second.outcome.extra).toBe("I've added a review for tomorrow so this sticks.");
    expect(recorder.reviewTasks).toHaveLength(1); // still the one review task
    expect(recorder.updates).toEqual([
      { id: recorder.reviewTasks[0].id, userId: "user-1", patch: { dueAt: "2026-10-29T15:59:00.000Z" } },
    ]);
    expect(recorder.events[1]).toMatchObject({ action: "updated", evidence: "subtracting the wrong way round" });
    expect(recorder.starters).toHaveLength(2); // fresh practice both times
  });

  test("a correct diagnosis appends no extra and records nothing", async () => {
    const recorder = makeRecorderDeps();
    const deps = createStartersDeps({
      generateObject: async (opts) => {
        if (opts.purpose !== "math") throw new Error(`no fake data for purpose ${opts.purpose}`);
        return {
          data: {
            ...MATH_WRONG,
            is_correct: true,
            first_error_step: null,
            what_went_wrong: null,
            misconception: null,
            correct_next_step: null,
          } as never,
          usage: USAGE,
        };
      },
      insertTask: async () => ({}) as TaskRow,
      insertTaskEvent: async () => {},
      insertStarter: async () => ({}) as StarterRow,
      uploadBuffer: async () => {},
      // Billing fakes: this e2e must never reach the real usage ledger (the
      // 0002 migration may not be applied), and a real claim would resolve
      // the shared env cache mid-suite and break later env-pinning tests.
      claimFeature: async () => ({ ok: true as const, usageId: "", plan: "pro" as const }),
      consumeUsage: async () => {},
      releaseUsage: async () => {},
      now: () => NOW,
      onDiagnosisRecorded: createDiagnosisRecorder(recorder.deps),
    });

    const result = await runMathDiagnosis(deps, {
      user,
      upload: uploadRow as Parameters<typeof runMathDiagnosis>[1]["upload"],
      image: { buffer: Buffer.from("stub-jpeg"), width: 8, height: 8 },
      caption: null,
    });

    expect(result.status).toBe("correct");
    expect(result.outcome.extra).toBeNull();
    expect(recorder.reviewTasks).toHaveLength(0);
  });
});

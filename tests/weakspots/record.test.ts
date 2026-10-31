import { describe, expect, mock, test } from "bun:test";
import type {
  InsertStarterInput,
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
  UpsertWeakSpotInput,
} from "../../lib/db/queries";
import type { StarterRow, TaskRow } from "../../lib/db/types";
import type { MathDiagnosis } from "../../lib/starters/types";
import { ReviewPracticeSchema } from "../../lib/starters/types";
import { createDiagnosisRecorder, recordWeakSpot, type WeakSpotRecorderDeps } from "../../lib/weakspots/record";

// 09:00 SGT, Wednesday 28 October 2026.
const NOW = new Date("2026-10-28T01:00:00.000Z");

mock.module("server-only", () => ({}));

const user = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  created_at: "2026-10-01T01:00:00.000Z",
};

const sourceTask: TaskRow = {
  id: "math-task-1",
  user_id: "user-1",
  title: "Math check: Sign errors",
  course: "MA1521",
  kind: "math_practice",
  due_at: null,
  effort: null,
  status: "open",
  origin: "capture",
  source_upload_id: "upload-9",
  weak_spot_id: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const DIAGNOSIS: MathDiagnosis = {
  steps: [{ index: 1, latex_or_text: "5 - 8 = 3", bbox: null }],
  is_correct: false,
  first_error_step: 1,
  what_went_wrong: "the minus sign slipped",
  misconception: { topic: "sign_errors", detail: "subtracting the wrong way round" },
  correct_next_step: "8 - 5 = 3, so 5 - 8 = -3",
  final_answer_check: "The answer should be -3.",
  practice: [{ question: "5 - 8 = ?", answer: "-3" }],
};

function reviewTaskRow(id: string, dueAt: string): TaskRow {
  return {
    id,
    user_id: "user-1",
    title: "Review: Sign errors",
    course: "MA1521",
    kind: "review",
    due_at: dueAt,
    effort: "small",
    status: "open",
    origin: "weak_spot",
    source_upload_id: null,
    weak_spot_id: "spot-1",
    created_at: "2026-10-25T01:00:00.000Z",
    updated_at: "2026-10-25T01:00:00.000Z",
  };
}

function makeDeps(overrides: Partial<WeakSpotRecorderDeps> = {}, startOccurrences = 0) {
  const calls = {
    upserts: [] as UpsertWeakSpotInput[],
    nextReviews: [] as Array<{ userId: string; weakSpotId: string; nextReviewAt: Date | null }>,
    openLookups: [] as Array<{ userId: string; weakSpotId: string }>,
    inserted: [] as InsertTaskInput[],
    events: [] as InsertTaskEventInput[],
    starters: [] as InsertStarterInput[],
    updates: [] as Array<{ id: string; userId: string; patch: UpdateTaskPatch }>,
  };
  let occurrences = startOccurrences;
  let openReview: TaskRow | null = null;

  const deps: WeakSpotRecorderDeps = {
    upsertWeakSpot: async (i) => {
      calls.upserts.push(i);
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
    setWeakSpotNextReview: async (userId, weakSpotId, nextReviewAt) => {
      calls.nextReviews.push({ userId, weakSpotId, nextReviewAt });
      return {
        id: weakSpotId,
        user_id: userId,
        topic: "sign_errors",
        latest_misconception: "x",
        occurrences: 1,
        last_seen_at: NOW.toISOString(),
        next_review_at: nextReviewAt?.toISOString() ?? null,
      };
    },
    findOpenReviewTask: async (userId, weakSpotId) => {
      calls.openLookups.push({ userId, weakSpotId });
      return openReview;
    },
    insertTask: async (i) => {
      calls.inserted.push(i);
      return reviewTaskRow(`review-${calls.inserted.length}`, i.dueAt ?? "");
    },
    insertTaskEvent: async (i) => {
      calls.events.push(i);
    },
    insertStarter: async (i) => {
      calls.starters.push(i);
      const row: StarterRow = {
        id: `starter-${calls.starters.length}`,
        task_id: i.taskId,
        type: i.type,
        content: i.content,
        annotated_image_path: null,
        created_at: NOW.toISOString(),
      };
      return row;
    },
    updateTask: async (id, userId, patch) => {
      calls.updates.push({ id, userId, patch });
      return { ...openReview!, ...patch } as TaskRow;
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls, setOpenReview: (task: TaskRow | null) => { openReview = task; } };
}

describe("recordWeakSpot: first occurrence", () => {
  test("creates the review task due +3 days with a created event, starter and weekday reply", async () => {
    const { deps, calls } = makeDeps();

    const reply = await recordWeakSpot(deps, { user, task: sourceTask, diagnosis: DIAGNOSIS });

    expect(calls.upserts).toEqual([
      {
        userId: "user-1",
        topic: "sign_errors",
        misconception: "subtracting the wrong way round",
        now: NOW,
        nextReviewAt: null,
      },
    ]);
    expect(calls.nextReviews).toEqual([
      { userId: "user-1", weakSpotId: "spot-1", nextReviewAt: new Date("2026-10-31T15:59:00.000Z") },
    ]);
    expect(calls.inserted).toEqual([
      {
        userId: "user-1",
        title: "Review: Sign errors",
        course: "MA1521",
        kind: "review",
        dueAt: "2026-10-31T15:59:00.000Z",
        effort: "small",
        origin: "weak_spot",
        weakSpotId: "spot-1",
        sourceUploadId: "upload-9",
      },
    ]);
    expect(calls.events).toEqual([
      {
        taskId: "review-1",
        action: "created",
        before: null,
        after: {
          title: "Review: Sign errors",
          course: "MA1521",
          kind: "review",
          dueAt: "2026-10-31T15:59:00.000Z",
          effort: "small",
        },
        evidence: "subtracting the wrong way round",
      },
    ]);
    expect(calls.starters).toHaveLength(1);
    expect(calls.starters[0]).toMatchObject({ taskId: "review-1", type: "review_practice" });
    const parsed = ReviewPracticeSchema.safeParse(calls.starters[0].content);
    expect(parsed.success).toBe(true);
    expect(reply).toBe("I've added a review for Sat so this sticks.");
  });
});

describe("recordWeakSpot: review already open", () => {
  test("second occurrence reschedules to +1 day with an updated event and no second task", async () => {
    const { deps, calls, setOpenReview } = makeDeps({}, 1); // the row already stood at 1
    setOpenReview(reviewTaskRow("review-open", "2026-10-31T15:59:00.000Z"));

    const reply = await recordWeakSpot(deps, { user, task: sourceTask, diagnosis: DIAGNOSIS });

    expect(calls.upserts).toHaveLength(1); // occurrences bumped to 2
    expect(calls.inserted).toHaveLength(0); // no duplicate task
    expect(calls.updates).toEqual([
      { id: "review-open", userId: "user-1", patch: { dueAt: "2026-10-29T15:59:00.000Z" } },
    ]);
    expect(calls.events).toEqual([
      {
        taskId: "review-open",
        action: "updated",
        before: { dueAt: "2026-10-31T15:59:00.000Z" },
        after: { dueAt: "2026-10-29T15:59:00.000Z" },
        evidence: "subtracting the wrong way round",
      },
    ]);
    expect(calls.starters[0].taskId).toBe("review-open");
    expect(reply).toBe("I've added a review for tomorrow so this sticks.");
  });

  test("third and later occurrences use the recurring wording", async () => {
    const { deps, calls, setOpenReview } = makeDeps();
    setOpenReview(reviewTaskRow("review-open", "2026-10-31T15:59:00.000Z"));
    // Pretend the row already stood at 2, so this diagnosis makes 3.
    const depsWithPreset: WeakSpotRecorderDeps = {
      ...deps,
      upsertWeakSpot: async (i) => {
        calls.upserts.push(i);
        return {
          id: "spot-1",
          user_id: i.userId,
          topic: i.topic,
          latest_misconception: i.misconception,
          occurrences: 3,
          last_seen_at: i.now.toISOString(),
          next_review_at: null,
        };
      },
    };

    const reply = await recordWeakSpot(depsWithPreset, { user, task: sourceTask, diagnosis: DIAGNOSIS });

    expect(calls.updates[0].patch.dueAt).toBe("2026-10-29T15:59:00.000Z");
    expect(reply).toBe("This one keeps coming up, so I've added a quick review for tomorrow.");
    expect(calls.inserted).toHaveLength(0);
  });
});

describe("recordWeakSpot: nothing to record", () => {
  test("a correct diagnosis writes nothing and returns null", async () => {
    const { deps, calls } = makeDeps();
    const reply = await recordWeakSpot(deps, {
      user,
      task: sourceTask,
      diagnosis: { ...DIAGNOSIS, is_correct: true, misconception: null, what_went_wrong: null },
    });
    expect(reply).toBeNull();
    expect(calls.upserts).toHaveLength(0);
    expect(calls.nextReviews).toHaveLength(0);
    expect(calls.openLookups).toHaveLength(0);
    expect(calls.inserted).toHaveLength(0);
    expect(calls.events).toHaveLength(0);
    expect(calls.starters).toHaveLength(0);
  });

  test("a wrong diagnosis without a misconception writes nothing and returns null", async () => {
    const { deps, calls } = makeDeps();
    const reply = await recordWeakSpot(deps, {
      user,
      task: sourceTask,
      diagnosis: { ...DIAGNOSIS, misconception: null },
    });
    expect(reply).toBeNull();
    expect(calls.upserts).toHaveLength(0);
    expect(calls.inserted).toHaveLength(0);
  });
});

describe("recordWeakSpot: starter and errors", () => {
  test("empty practice skips the starter but the task still stands", async () => {
    const { deps, calls } = makeDeps();
    const reply = await recordWeakSpot(deps, {
      user,
      task: sourceTask,
      diagnosis: { ...DIAGNOSIS, practice: [] },
    });
    expect(calls.inserted).toHaveLength(1);
    expect(calls.starters).toHaveLength(0);
    expect(reply).toBe("I've added a review for Sat so this sticks.");
  });

  test("an upsert error propagates", async () => {
    const { deps } = makeDeps({
      upsertWeakSpot: async () => {
        throw new Error("db upsertWeakSpot failed: sad");
      },
    });
    expect(recordWeakSpot(deps, { user, task: sourceTask, diagnosis: DIAGNOSIS })).rejects.toThrow(
      "db upsertWeakSpot failed: sad",
    );
  });

  test("an insertTask error propagates", async () => {
    const { deps } = makeDeps({
      insertTask: async () => {
        throw new Error("db insertTask failed: sad");
      },
    });
    expect(recordWeakSpot(deps, { user, task: sourceTask, diagnosis: DIAGNOSIS })).rejects.toThrow(
      "db insertTask failed: sad",
    );
  });

  test("info.now overrides deps.now", async () => {
    const { deps, calls } = makeDeps();
    const later = new Date("2026-11-06T02:00:00.000Z");
    await recordWeakSpot(deps, { user, task: sourceTask, diagnosis: DIAGNOSIS, now: later });
    expect(calls.upserts[0].now).toBe(later);
    // +3 SGT days from 6 Nov is 9 Nov.
    expect(calls.nextReviews[0].nextReviewAt).toEqual(new Date("2026-11-09T15:59:00.000Z"));
  });
});

describe("createDiagnosisRecorder", () => {
  test("runs recordWeakSpot against the injected deps", async () => {
    const { deps, calls } = makeDeps();
    const recorder = createDiagnosisRecorder(deps);
    const reply = await recorder({ user, task: sourceTask, diagnosis: DIAGNOSIS });
    expect(reply).toBe("I've added a review for Sat so this sticks.");
    expect(calls.inserted).toHaveLength(1);
  });
});

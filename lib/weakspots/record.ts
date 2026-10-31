// The weak-spot half of PRD F4: every math diagnosis with a misconception
// upserts the weak spot, points it at its spaced review, and makes sure one
// open review task carries the targeted practice. Pure scheduling lives in
// schedule.ts; every dependency is injected here so tests run the real flow
// against fakes. Errors propagate: the caller (recordedExtra) already swallows
// them so the diagnosis reply survives a db hiccup.

import type {
  InsertStarterInput,
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
  UpsertWeakSpotInput,
} from "@/lib/db/queries";
import {
  insertStarter as realInsertStarter,
  insertTask as realInsertTask,
  insertTaskEvent as realInsertTaskEvent,
  updateTask as realUpdateTask,
  upsertWeakSpot as realUpsertWeakSpot,
} from "@/lib/db/queries";
import type { StarterRow, TaskRow, UserRow, WeakSpotRow } from "@/lib/db/types";
import { MATH_TOPIC_LABELS, ReviewPracticeSchema, type MathDiagnosis } from "@/lib/starters/types";
import { findOpenReviewTask as realFindOpenReviewTask, setWeakSpotNextReview as realSetWeakSpotNextReview } from "./queries";
import { reviewReply, scheduleReview } from "./schedule";

export type WeakSpotRecorderDeps = {
  upsertWeakSpot: (i: UpsertWeakSpotInput) => Promise<WeakSpotRow>;
  setWeakSpotNextReview: (userId: string, weakSpotId: string, nextReviewAt: Date | null) => Promise<WeakSpotRow>;
  findOpenReviewTask: (userId: string, weakSpotId: string) => Promise<TaskRow | null>;
  insertTask: (i: InsertTaskInput) => Promise<TaskRow>;
  insertTaskEvent: (i: InsertTaskEventInput) => Promise<void>;
  insertStarter: (i: InsertStarterInput) => Promise<StarterRow>;
  updateTask: (id: string, userId: string, patch: UpdateTaskPatch) => Promise<TaskRow>;
  now: () => Date;
};

export type RecordWeakSpotInfo = {
  user: UserRow;
  task: TaskRow;
  diagnosis: MathDiagnosis;
  now?: Date;
};

export async function recordWeakSpot(
  deps: WeakSpotRecorderDeps,
  info: RecordWeakSpotInfo
): Promise<string | null> {
  const { user, task, diagnosis } = info;
  const misconception = diagnosis.is_correct ? null : diagnosis.misconception;
  if (misconception == null) return null;

  const now = info.now ?? deps.now();
  // upsertWeakSpot increments occurrences and returns the bumped row.
  const row = await deps.upsertWeakSpot({
    userId: user.id,
    topic: misconception.topic,
    misconception: misconception.detail,
    now,
    nextReviewAt: null,
  });
  const schedule = scheduleReview(row.occurrences, now);
  await deps.setWeakSpotNextReview(user.id, row.id, new Date(schedule.dueAt));

  // Reschedule the existing open review instead of stacking duplicates; the
  // new misconception detail rides along as the event evidence.
  const open = await deps.findOpenReviewTask(user.id, row.id);
  let reviewTaskId: string;
  if (open != null) {
    await deps.updateTask(open.id, user.id, { dueAt: schedule.dueAt });
    await deps.insertTaskEvent({
      taskId: open.id,
      action: "updated",
      before: { dueAt: open.due_at },
      after: { dueAt: schedule.dueAt },
      evidence: misconception.detail,
    });
    reviewTaskId = open.id;
  } else {
    const title = `Review: ${MATH_TOPIC_LABELS[misconception.topic]}`;
    const created = await deps.insertTask({
      userId: user.id,
      title,
      course: task.course,
      kind: "review",
      dueAt: schedule.dueAt,
      effort: "small",
      origin: "weak_spot",
      weakSpotId: row.id,
      sourceUploadId: task.source_upload_id,
    });
    await deps.insertTaskEvent({
      taskId: created.id,
      action: "created",
      before: null,
      after: { title, course: task.course, kind: "review", dueAt: schedule.dueAt, effort: "small" },
      evidence: misconception.detail,
    });
    reviewTaskId = created.id;
  }

  // A fresh practice set every time, so the review task always reflects the
  // latest diagnosis. No practice means no starter, the task still stands.
  const practice = diagnosis.practice.map((item) => ({ question: item.question, answer: item.answer }));
  if (practice.length > 0) {
    const parsed = ReviewPracticeSchema.safeParse({
      topic: misconception.topic,
      misconception: misconception.detail,
      practice,
    });
    if (parsed.success) {
      await deps.insertStarter({ taskId: reviewTaskId, type: "review_practice", content: parsed.data });
    }
  }

  return reviewReply({ occurrences: row.occurrences, dueAt: schedule.dueAt, now });
}

export type DiagnosisRecorder = (info: RecordWeakSpotInfo) => Promise<string | null>;

// What createStartersDeps wires in as the default onDiagnosisRecorded hook.
// The real db wrappers resolve the Supabase client inside their bodies, so
// building this never touches the environment.
export function createDiagnosisRecorder(
  overrides: Partial<WeakSpotRecorderDeps> = {}
): DiagnosisRecorder {
  return async (info) => {
    const deps: WeakSpotRecorderDeps = {
      upsertWeakSpot: (i) => realUpsertWeakSpot(i),
      setWeakSpotNextReview: realSetWeakSpotNextReview,
      findOpenReviewTask: realFindOpenReviewTask,
      insertTask: realInsertTask,
      insertTaskEvent: realInsertTaskEvent,
      insertStarter: realInsertStarter,
      updateTask: realUpdateTask,
      now: () => new Date(),
      ...overrides,
    };
    return recordWeakSpot(deps, info);
  };
}

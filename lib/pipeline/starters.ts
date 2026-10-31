// Starter orchestration: attaches the task's first step after a capture and
// runs the math diagnosis. Pure-ish like ingest.ts: every dependency is
// injected, so tests run the real orchestration against fakes. Starter
// failures for document uploads are returned (never thrown) so a broken
// starter cannot fail a capture that already wrote its task; math failures
// propagate so the caller marks the upload failed.
import type { InsertStarterInput, InsertTaskEventInput, InsertTaskInput } from "@/lib/db/queries";
import {
  insertStarter as realInsertStarter,
  insertTask as realInsertTask,
  insertTaskEvent as realInsertTaskEvent,
} from "@/lib/db/queries";
import type { StarterRow, TaskRow, UploadRow, UserRow } from "@/lib/db/types";
import { annotatedPath, uploadBuffer as realUploadBuffer } from "@/lib/media/storage";
import type { MetaClient } from "@/lib/meta/client";
import { getMetaClient } from "@/lib/meta/index";
import { generateStarterFor } from "@/lib/starters/index";
import { diagnoseAndAnnotate } from "@/lib/starters/math";
import { MATH_TOPIC_LABELS, type MathDiagnosis } from "@/lib/starters/types";
import { createDiagnosisRecorder } from "@/lib/weakspots/record";

export type DiagnosisRecordedInfo = {
  user: UserRow;
  task: TaskRow;
  diagnosis: MathDiagnosis;
};

export type StartersDeps = {
  generateObject: MetaClient["generateObject"];
  insertTask: (i: InsertTaskInput) => Promise<TaskRow>;
  insertTaskEvent: (i: InsertTaskEventInput) => Promise<void>;
  insertStarter: (i: InsertStarterInput) => Promise<StarterRow>;
  uploadBuffer: (path: string, buffer: Buffer, contentType: string) => Promise<void>;
  now: () => Date;
  // Plugged in by a later card (weak-spot tracker): called after a math
  // diagnosis starter is stored. A returned string is appended to the reply.
  onDiagnosisRecorded?: (info: DiagnosisRecordedInfo) => Promise<string | null>;
};

export function createStartersDeps(overrides: Partial<StartersDeps> = {}): StartersDeps {
  return {
    generateObject: (opts) => getMetaClient().generateObject(opts),
    insertTask: realInsertTask,
    insertTaskEvent: realInsertTaskEvent,
    insertStarter: realInsertStarter,
    uploadBuffer: (path, buffer, contentType) => realUploadBuffer(path, buffer, contentType),
    now: () => new Date(),
    // The weak-spot loop (PRD F4). The recorder builds itself at call time
    // and its db wrappers resolve the client inside their bodies, so nothing
    // here touches the environment until a diagnosis actually lands.
    onDiagnosisRecorded: (info) => createDiagnosisRecorder()(info),
    ...overrides,
  };
}

// What the reply layer needs to build the "I also made ..." line.
export type StarterFailureReason =
  | "empty_checklist"
  | "no_study_material"
  | "too_thin"
  | "generic";

export type StarterReplyInfo =
  | { status: "made"; type: "checklist"; count: number }
  | { status: "made"; type: "flashcards"; count: number; secondaryCount: number }
  | { status: "failed"; reason: StarterFailureReason };

export type DocumentStarterContext = {
  user: UserRow;
  upload: UploadRow;
  pdf: { base64: string; filename: string };
  inputKind: "assignment_brief" | "lecture_slides";
  // Reconcile outcome; the first created task wins, else the first updated.
  created: TaskRow[];
  updated: Array<{ task: TaskRow }>;
};

export type DocumentStarterResult =
  | { task: TaskRow; starter: StarterRow; summary: DocumentStarterSummary }
  | { skipped: string }
  // task is set when a fallback task was created before the failure, so the
  // caller can keep it visible instead of losing the write.
  | { error: Error; task?: TaskRow };

export type DocumentStarterSummary =
  | { type: "checklist"; count: number }
  | { type: "flashcards"; count: number; secondaryCount: number };

export async function attachDocumentStarter(
  deps: StartersDeps,
  ctx: DocumentStarterContext,
): Promise<DocumentStarterResult> {
  let target = ctx.created[0] ?? ctx.updated[0]?.task ?? null;
  let fallbackTask: TaskRow | undefined;

  if (target == null && ctx.inputKind === "lecture_slides") {
    // Slides rarely state a deadline, so Understand often produces no task;
    // make a lightweight revision task so the flashcards have somewhere to
    // live instead of dropping them.
    const title = `Revise: ${titleFromFilename(ctx.pdf.filename)}`;
    fallbackTask = await deps.insertTask({
      userId: ctx.user.id,
      title,
      course: null,
      kind: "reading",
      dueAt: null,
      effort: null,
      origin: "capture",
      sourceUploadId: ctx.upload.id,
    });
    await deps.insertTaskEvent({
      taskId: fallbackTask.id,
      uploadId: ctx.upload.id,
      action: "created",
      before: null,
      after: { title, course: null, kind: "reading", dueAt: null, effort: null },
      evidence: ctx.pdf.filename,
    });
    target = fallbackTask;
  }

  if (target == null) return { skipped: "no task was created or updated" };

  try {
    const result = await generateStarterFor(
      { generateObject: deps.generateObject },
      {
        userId: ctx.user.id,
        task: {
          title: target.title,
          course: target.course,
          kind: target.kind,
          due_at: target.due_at,
        },
        upload: { classified_as: ctx.inputKind, kind: ctx.upload.kind },
        pdf: ctx.pdf,
      },
    );
    if (result == null) return { skipped: "no generator for this upload" };

    const starter = await deps.insertStarter({
      taskId: target.id,
      type: result.type,
      content: result.content,
    });
    const summary: DocumentStarterSummary =
      result.type === "checklist"
        ? { type: "checklist", count: countItems(result.content, "items") }
        : {
            type: "flashcards",
            count: countItems(result.content, "cards"),
            secondaryCount: countItems(result.content, "practice"),
          };
    return { task: target, starter, summary };
  } catch (error) {
    // Logged without stacks or env values; the caller turns this into a plain
    // sentence in the reply while the task stays written.
    console.error(
      "[starters] starter generation failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    return fallbackTask != null ? { error: toError(error), task: fallbackTask } : { error: toError(error) };
  }
}

// 'lecture_04-cell_division.pdf' -> 'lecture 04 cell division', max 80 chars.
export function titleFromFilename(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base.slice(0, 80).trim();
}

function countItems(content: unknown, key: "items" | "cards" | "practice"): number {
  const items = (content as { items?: unknown; cards?: unknown; practice?: unknown } | null)?.[key];
  return Array.isArray(items) ? items.length : 0;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type MathRunContext = {
  user: UserRow;
  upload: UploadRow;
  image: { buffer: Buffer; width: number; height: number };
  caption: string | null;
};

export type MathOutcomePayload = {
  caption: string;
  annotated: Buffer | null;
  practiceText: string | null;
  extra: string | null;
};

export type MathRunResult =
  | { status: "wrong"; task: TaskRow; starter: StarterRow; outcome: MathOutcomePayload }
  | { status: "correct"; outcome: MathOutcomePayload }
  | { status: "unreadable"; outcome: MathOutcomePayload };

// Diagnoses the photo and, when the working is wrong, writes the practice
// task plus the diagnosis starter (with the annotated JPEG uploaded to
// Storage). Errors from the model call propagate: no task is written in that
// case, so the caller failing the upload loses nothing.
export async function runMathDiagnosis(
  deps: StartersDeps,
  ctx: MathRunContext,
): Promise<MathRunResult> {
  const result = await diagnoseAndAnnotate(
    { generateObject: deps.generateObject },
    { userId: ctx.user.id, image: ctx.image, caption: ctx.caption },
  );
  const diagnosis = result.content;

  if (result.unreadable) {
    return {
      status: "unreadable",
      outcome: { caption: result.caption, annotated: null, practiceText: null, extra: null },
    };
  }

  if (diagnosis.is_correct) {
    return {
      status: "correct",
      outcome: {
        caption: result.caption,
        annotated: result.annotated,
        practiceText: result.practiceText,
        extra: null,
      },
    };
  }

  const label =
    diagnosis.misconception != null ? MATH_TOPIC_LABELS[diagnosis.misconception.topic] : "Math working";
  const title = `Math check: ${label}`;
  const task = await deps.insertTask({
    userId: ctx.user.id,
    title,
    course: null,
    kind: "math_practice",
    dueAt: null,
    effort: null,
    origin: "capture",
    sourceUploadId: ctx.upload.id,
  });
  await deps.insertTaskEvent({
    taskId: task.id,
    uploadId: ctx.upload.id,
    action: "created",
    before: null,
    after: { title, course: null, kind: "math_practice", dueAt: null, effort: null },
    evidence: diagnosis.what_went_wrong,
  });

  let annotatedImagePath: string | null = null;
  if (result.annotated != null) {
    annotatedImagePath = annotatedPath(ctx.user.id, ctx.upload.id);
    await deps.uploadBuffer(annotatedImagePath, result.annotated, "image/jpeg");
  }
  const starter = await deps.insertStarter({
    taskId: task.id,
    type: "math_diagnosis",
    content: diagnosis,
    annotatedImagePath,
  });

  return {
    status: "wrong",
    task,
    starter,
    outcome: {
      caption: result.caption,
      annotated: result.annotated,
      practiceText: result.practiceText,
      extra: await recordedExtra(deps, ctx, task, diagnosis),
    },
  };
}

async function recordedExtra(
  deps: StartersDeps,
  ctx: MathRunContext,
  task: TaskRow,
  diagnosis: MathDiagnosis,
): Promise<string | null> {
  if (deps.onDiagnosisRecorded == null) return null;
  try {
    return await deps.onDiagnosisRecorded({ user: ctx.user, task, diagnosis });
  } catch (error) {
    // The weak-spot hook must never break the diagnosis reply.
    console.error(
      "[starters] onDiagnosisRecorded failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

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
import { quotaHitReply } from "@/lib/billing/copy";
import type { ClaimArgs, ClaimRefused, ClaimResult } from "@/lib/billing/entitlements";
import type { Feature } from "@/lib/billing/plans";
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
  // Usage gate seams (lib/billing): one claim before each gated AI call, then
  // consume on success or release on failure. The defaults resolve the billing
  // module lazily at call time, so importing this file never loads billing or
  // touches the environment.
  claimFeature: (args: ClaimArgs) => Promise<ClaimResult>;
  consumeUsage: (usageId: string) => Promise<void>;
  releaseUsage: (usageId: string) => Promise<void>;
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
    // Resolved on first call, never at import time: the entitlements module
    // pulls in the Supabase client through the billing queries.
    claimFeature: (args) => import("@/lib/billing/entitlements").then((m) => m.claimFeature(args)),
    consumeUsage: (usageId) => import("@/lib/billing/entitlements").then((m) => m.consumeUsage(usageId)),
    releaseUsage: (usageId) => import("@/lib/billing/entitlements").then((m) => m.releaseUsage(usageId)),
    now: () => new Date(),
    // The weak-spot loop (PRD F4). The recorder builds itself at call time
    // and its db wrappers resolve the client inside their bodies, so nothing
    // here touches the environment until a diagnosis actually lands.
    onDiagnosisRecorded: (info) => createDiagnosisRecorder()(info),
    ...overrides,
  };
}

// Outcome of one gate check: either a claim to settle (usageId may be "" when
// no ledger row was needed) or a refusal to turn into the quota reply.
type StarterClaimGate =
  | { ok: true; usageId: string }
  | { ok: false; refusal: ClaimRefused };

// One claim right before a gated AI call. The usage ledger can be missing or
// unreachable (the billing migration may not be applied yet): a claim failure
// logs one plain line and carries on as if the claim succeeded, with
// consume and release becoming no-ops for this call. A broken ledger must
// never block a checklist, a flashcard set or a math diagnosis.
async function claimStarterUse(
  deps: StartersDeps,
  args: { userId: string; feature: Feature; uploadId: string },
): Promise<StarterClaimGate> {
  try {
    const claim = await deps.claimFeature(args);
    if (claim.ok) return { ok: true, usageId: claim.usageId };
    return { ok: false, refusal: claim };
  } catch (error) {
    console.error(
      "[starters] usage gate unavailable, continuing without it:",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: true, usageId: "" };
  }
}

// Consume and release are best effort: a ledger failure must never mask the
// real result or the real error.
async function settleUsage(deps: StartersDeps, op: "consume" | "release", usageId: string): Promise<void> {
  if (usageId === "") return;
  try {
    if (op === "consume") await deps.consumeUsage(usageId);
    else await deps.releaseUsage(usageId);
  } catch (error) {
    console.error(
      `[starters] usage ${op} failed:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function quotaTextFor(feature: Feature, refusal: ClaimRefused): string {
  return quotaHitReply({
    feature,
    limit: refusal.limit,
    resetsAt: refusal.resetsAt,
    reason: refusal.reason,
  });
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
  | { status: "failed"; reason: StarterFailureReason }
  // Quota refused before the AI call: the fully worded quota reply text is
  // carried through to the student verbatim.
  | { status: "blocked"; text: string };

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
  // Quota refused before the AI call. task is set when a fallback task was
  // created before the refusal, so the caller keeps it visible.
  | { blocked: string; task?: TaskRow }
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

  // The gate sits between the task write and the AI call: understand, reconcile
  // and the task above are never gated, only the expensive starter call is.
  const feature: Feature =
    ctx.inputKind === "assignment_brief" ? "brief_checklist" : "slides_flashcards";
  const gate = await claimStarterUse(deps, {
    userId: ctx.user.id,
    feature,
    uploadId: ctx.upload.id,
  });
  if (!gate.ok) {
    return {
      blocked: quotaTextFor(feature, gate.refusal),
      ...(fallbackTask != null ? { task: fallbackTask } : {}),
    };
  }

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
    if (result == null) {
      // No generator means no AI call ran, so the claimed use is given back.
      await settleUsage(deps, "release", gate.usageId);
      return { skipped: "no generator for this upload" };
    }

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
    await settleUsage(deps, "consume", gate.usageId);
    return { task: target, starter, summary };
  } catch (error) {
    // A failed or garbled call must never use up quota: give the claimed use
    // back before the usual isolation handling.
    await settleUsage(deps, "release", gate.usageId);
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
  | { status: "unreadable"; outcome: MathOutcomePayload }
  // Quota refused before the diagnosis ran: outcome.caption is the whole
  // reply, every other field is null.
  | { status: "blocked"; outcome: MathOutcomePayload };

// Diagnoses the photo and, when the working is wrong, writes the practice
// task plus the diagnosis starter (with the annotated JPEG uploaded to
// Storage). The diagnosis is gated: one claim before the model call, consumed
// only when a usable diagnosis comes back and everything after it succeeded.
// Errors from the model call propagate (after the claimed use is released) so
// no task is written and the caller marks the upload failed, losing nothing.
export async function runMathDiagnosis(
  deps: StartersDeps,
  ctx: MathRunContext,
): Promise<MathRunResult> {
  const gate = await claimStarterUse(deps, {
    userId: ctx.user.id,
    feature: "math_diagnosis",
    uploadId: ctx.upload.id,
  });
  if (!gate.ok) {
    return {
      status: "blocked",
      outcome: {
        caption: quotaTextFor("math_diagnosis", gate.refusal),
        annotated: null,
        practiceText: null,
        extra: null,
      },
    };
  }
  try {
    const result = await diagnoseAndAnnotate(
      { generateObject: deps.generateObject },
      { userId: ctx.user.id, image: ctx.image, caption: ctx.caption },
    );
    const diagnosis = result.content;

    if (result.unreadable) {
      // A garbled photo is a failed diagnosis: the use is given back so the
      // sharper-photo retry stays free.
      await settleUsage(deps, "release", gate.usageId);
      return {
        status: "unreadable",
        outcome: { caption: result.caption, annotated: null, practiceText: null, extra: null },
      };
    }

    if (diagnosis.is_correct) {
      await settleUsage(deps, "consume", gate.usageId);
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

    const extra = await recordedExtra(deps, ctx, task, diagnosis);
    await settleUsage(deps, "consume", gate.usageId);
    return {
      status: "wrong",
      task,
      starter,
      outcome: {
        caption: result.caption,
        annotated: result.annotated,
        practiceText: result.practiceText,
        extra,
      },
    };
  } catch (error) {
    await settleUsage(deps, "release", gate.usageId);
    throw error;
  }
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

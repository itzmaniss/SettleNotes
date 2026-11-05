// Pure-ish ingest orchestration: understand -> map to reconcile actions ->
// plan -> execute -> attach the first-step starter -> mark the upload done.
// All I/O is injected, so tests run the real pipeline against fakes. Errors
// propagate to the caller (the Telegram handler marks the upload failed);
// document-starter failures are the one exception: they are isolated below so
// a captured task is never lost to a broken starter.
import type { FinishUploadPatch } from "@/lib/db/queries";
import { listOpenTasks as realListOpenTasks, finishUpload as realFinishUpload } from "@/lib/db/queries";
import type { TaskRow, UploadClassifiedAs, UploadRow, UserRow } from "@/lib/db/types";
import { buildPendingActions } from "@/lib/clarify/build";
import { insertPendingAction as realInsertPendingAction } from "@/lib/clarify/queries";
import type { PendingActionInput, PendingActionRow } from "@/lib/clarify/types";
import { getMetaClient } from "@/lib/meta/index";
import type { MetaClient } from "@/lib/meta/client";
import { BudgetExceededError } from "@/lib/meta/client";
import type { ReasoningEffort } from "@/lib/meta/client";
import { env } from "@/lib/env";
import type { ConversationTurn } from "@/lib/pipeline/conversation";
import { dueLocalToUtc, utcToSgtLocal } from "@/lib/pipeline/dates";
import { executeOps, type ExecuteResult } from "@/lib/pipeline/execute";
import { triggerCalendarSync } from "@/lib/calendar/trigger";
import {
  planReconcile,
  type OpenTaskLite,
  type Op,
  type ReconcileAction,
} from "@/lib/pipeline/reconcile";
import {
  attachDocumentStarter,
  createStartersDeps,
  runMathDiagnosis,
  type StartersDeps,
  type StarterReplyInfo,
  type StarterFailureReason,
} from "@/lib/pipeline/starters";
import { EmptyChecklistError } from "@/lib/starters/checklist";
import { FlashcardsTooThinError, NoStudyMaterialError } from "@/lib/starters/flashcards";
import { understand } from "@/lib/pipeline/understand";
import type { UnderstandAction, UnderstandOutput } from "@/lib/pipeline/understand";

export type IngestDeps = {
  generateObject: MetaClient["generateObject"];
  listOpenTasks: (userId: string) => Promise<TaskRow[]>;
  executeOps: (ops: Op[], ctx: { userId: string; uploadId: string }) => Promise<ExecuteResult>;
  finishUpload: (id: string, patch: FinishUploadPatch) => Promise<void>;
  // Stores one low-confidence action for a Yes/No tap. Injected so tests fake
  // it; a failure is caught per action and falls back to the text-only line.
  insertPendingAction: (i: PendingActionInput) => Promise<PendingActionRow>;
  now: () => Date;
  // Optional faster model and effort for text only understand calls. Null
  // means "use the default model / effort low", exactly as before. Image and
  // pdf calls ignore both and stay on the default model at effort medium.
  textModel?: string | null;
  textEffort?: ReasoningEffort | null;
  // Starter orchestration deps (defaults built lazily in createIngestDeps).
  starters?: StartersDeps;
  // Legacy hook from before the built-in math diagnosis existed; still fired
  // for observers, its return value is unused.
  onMathWorking?: (input: MathWorkingInput) => Promise<string | null>;
};

export type MathWorkingInput = {
  user: UserRow;
  upload: UploadRow;
  image?: { base64: string; mimeType?: string };
  text?: string | null;
};

export type IngestInput = {
  user: UserRow;
  upload: UploadRow;
  text?: string | null;
  image?: { base64: string; mimeType?: string };
  // Normalised image bytes for the math annotator; the base64 image above
  // stays the understanding input.
  imageMeta?: { buffer: Buffer; width: number; height: number };
  pdf?: { base64: string; filename: string; tooManyPages?: boolean };
  // Storage path of the original file, uploaded by the handler after the
  // upload row existed. Written into the row here so the DB stays truthful.
  storagePath?: string | null;
  // Earlier turns of this conversation, oldest first. Set by the handler for
  // plain text messages only; photos, documents and voice never carry it.
  recentExchange?: ConversationTurn[];
};

export type PendingPrompt = { pendingId: string; text: string };

export type IngestOutcome =
  | {
      kind: "tasks";
      result: ExecuteResult;
      clarification: string | null;
      // Plain answer to a question about what Settle did; null whenever any
      // real action ran (actions win), so it rides along but is only shown
      // for the nothing outcome. Optional so older callers stay valid.
      answer?: string | null;
      inputKind: UnderstandOutput["input_kind"];
      pdfTruncated: boolean;
      starter: StarterReplyInfo | null;
      // Low-confidence actions that got Yes/No buttons; one message each,
      // sent after the summary. `result.clarify` keeps only the actions that
      // fell back to the text-only line.
      pendingPrompts: PendingPrompt[];
    }
  | { kind: "nothing"; clarification: string | null; answer?: string | null }
  | { kind: "math"; caption: string; annotated: Buffer | null; practiceText: string | null; extra: string | null }
  // Math photo refused by the usage gate: no task, no diagnosis, the whole
  // reply is the quota text.
  | { kind: "quota"; text: string }
  // No longer produced by the default flow; kept for callers that inject no
  // starters deps or no image bytes for a math upload.
  | { kind: "math_pending" };

// understand's input_kind vocabulary maps onto uploads.classified_as; a plain
// message is stored as "other" since there is no separate bucket for it.
const CLASSIFIED_AS: Record<UnderstandOutput["input_kind"], UploadClassifiedAs> = {
  chat_screenshot: "chat_screenshot",
  assignment_brief: "assignment_brief",
  lecture_slides: "lecture_slides",
  math_working: "math_working",
  plain_message: "other",
  other: "other",
};

export function createIngestDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    generateObject: (opts) => getMetaClient().generateObject(opts),
    listOpenTasks: realListOpenTasks,
    executeOps: (ops, ctx) => executeOps(ops, ctx),
    finishUpload: realFinishUpload,
    insertPendingAction: (i) => realInsertPendingAction(i),
    now: () => new Date(),
    // Read at call time through the lazy env proxy, never at import time.
    // Blank env values are already normalised to undefined, which behaves
    // like null here: default model, default effort.
    get textModel() {
      return env.META_TEXT_MODEL ?? null;
    },
    get textEffort() {
      return env.META_TEXT_EFFORT ?? null;
    },
    // Built on first access: the real deps only resolve the Meta and Supabase
    // clients inside their functions, so nothing is read at import time.
    get starters() {
      return createStartersDeps();
    },
    ...overrides,
  };
}

// The model only ever names tasks by short ref; the id used for any write must
// come from our own refToTaskId map, never from anything the model emitted.
const DATE_ONLY_DUE = /^\d{4}-\d{2}-\d{2}$/;

function toReconcileAction(
  action: UnderstandAction,
  refToTaskId: Record<string, string>,
  openTasksById: Map<string, TaskRow>,
): ReconcileAction {
  let dueAt: string | null = null;
  if (action.due_local != null) {
    dueAt = dueLocalToUtc(action.due_local);
    // A day-only change to an existing task keeps its time of day: the
    // student said "tues", not "tues at midnight", so the old local clock
    // time is merged back in. Creates and tasks without a due date keep the
    // 23:59 end of day default.
    if (
      action.type === "update" &&
      DATE_ONLY_DUE.test(action.due_local.trim()) &&
      action.task_ref != null
    ) {
      const taskId = refToTaskId[action.task_ref];
      const current = taskId != null ? openTasksById.get(taskId) : undefined;
      const oldLocal = current?.due_at != null ? utcToSgtLocal(current.due_at) : "";
      if (oldLocal !== "") {
        const merged = dueLocalToUtc(`${action.due_local.trim()}${oldLocal.slice(10)}`);
        if (merged != null) dueAt = merged;
      }
    }
  }
  return {
    type: action.type,
    taskId: action.task_ref == null ? null : (refToTaskId[action.task_ref] ?? null),
    title: action.title,
    course: action.course,
    kind: action.kind,
    // An unparseable due_local becomes null (no deadline) instead of crashing.
    dueAt,
    effort: action.effort,
    evidence: action.evidence,
    confidence: action.confidence,
  };
}

export async function ingestContent(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
  const now = deps.now();
  const openTasks: TaskRow[] = await deps.listOpenTasks(input.user.id);
  const openTasksById = new Map(openTasks.map((task) => [task.id, task]));

  const { output, refToTaskId } = await understand(
    { generateObject: deps.generateObject },
    {
      userId: input.user.id,
      now,
      openTasks: openTasks.map(toUnderstandOpenTask),
      text: input.text ?? null,
      image: input.image,
      pdf: input.pdf
        ? { base64: input.pdf.base64, filename: input.pdf.filename }
        : undefined,
      recentExchange: input.recentExchange,
      // Text only calls may run on the faster configured text model; image
      // and pdf calls ignore both options inside understand().
      textModel: deps.textModel ?? undefined,
      textEffort: deps.textEffort ?? undefined,
    },
  );

  const finishDone = (classifiedAs: UploadClassifiedAs): Promise<void> =>
    deps.finishUpload(input.upload.id, {
      status: "done",
      classifiedAs,
      storagePath: input.storagePath ?? null,
    });

  if (output.input_kind === "math_working") {
    await deps.onMathWorking?.({
      user: input.user,
      upload: input.upload,
      image: input.image,
      text: input.text,
    });
    if (deps.starters == null || input.imageMeta == null) {
      // Nothing to diagnose with: keep the legacy pending outcome.
      await finishDone("math_working");
      return { kind: "math_pending" };
    }
    // Diagnosis errors propagate on purpose: no task is written before the
    // model call succeeds, so failing the upload here loses nothing. A quota
    // refusal is not an error: the upload still finishes as a math photo and
    // the whole reply is the quota text.
    const math = await runMathDiagnosis(deps.starters, {
      user: input.user,
      upload: input.upload,
      image: input.imageMeta,
      caption: input.text ?? null,
    });
    await finishDone("math_working");
    if (math.status === "blocked") return { kind: "quota", text: math.outcome.caption };
    return { kind: "math", ...math.outcome };
  }

  const actions = output.actions.map((action) => toReconcileAction(action, refToTaskId, openTasksById));
  const ops = planReconcile(actions, openTasks as OpenTaskLite[], now);
  const result = await deps.executeOps(ops, {
    userId: input.user.id,
    uploadId: input.upload.id,
  });

  // Low-confidence actions become Yes/No prompts. A row that cannot be built
  // (no resolvable target, no title) or cannot be stored keeps today's
  // text-only line instead; neither can lose the task writes above.
  const pendingPrompts: PendingPrompt[] = [];
  const clarifyFallbacks: ReconcileAction[] = [];
  if (result.clarify.length > 0) {
    const built = buildPendingActions(
      result.clarify,
      { userId: input.user.id, uploadId: input.upload.id },
      openTasks,
    );
    clarifyFallbacks.push(...built.fallbacks);
    for (const draft of built.drafts) {
      try {
        const row = await deps.insertPendingAction(draft.input);
        pendingPrompts.push({ pendingId: row.id, text: draft.text });
      } catch (error) {
        console.error(
          "[ingest] failed to store a pending action:",
          error instanceof Error ? error.message : String(error),
        );
        clarifyFallbacks.push(draft.action);
      }
    }
  }

  const { starter, created } = await attachStarterIfDocument(deps, input, output.input_kind, result);
  await finishDone(CLASSIFIED_AS[output.input_kind]);

  // A slides-only upload can gain its revision task inside the starter step;
  // fold it into the created list so the reply shows it like any other task.
  const hasWrites =
    created.length > 0 || result.updated.length > 0 || result.completed.length > 0;
  if (hasWrites) void triggerCalendarSync(input.user.id);
  if (!hasWrites && clarifyFallbacks.length === 0 && pendingPrompts.length === 0) {
    return { kind: "nothing", clarification: output.needs_clarification, answer: output.answer_to_student };
  }
  return {
    kind: "tasks",
    result: { ...result, created, clarify: clarifyFallbacks },
    clarification: output.needs_clarification,
    answer: output.answer_to_student,
    inputKind: output.input_kind,
    pdfTruncated: input.pdf?.tooManyPages ?? false,
    starter,
    pendingPrompts,
  };
}

// Checklist for briefs, flashcards for slides, and only ever for PDF uploads.
// Never throws (budget excepted, see inside): the capture already succeeded.
async function attachStarterIfDocument(
  deps: IngestDeps,
  input: IngestInput,
  inputKind: UnderstandOutput["input_kind"],
  result: ExecuteResult,
): Promise<{ starter: StarterReplyInfo | null; created: TaskRow[] }> {
  const created = [...result.created];
  if (
    deps.starters == null ||
    input.pdf == null ||
    (inputKind !== "assignment_brief" && inputKind !== "lecture_slides")
  ) {
    return { starter: null, created };
  }

  const attempt = await attachDocumentStarter(deps.starters, {
    user: input.user,
    upload: input.upload,
    pdf: { base64: input.pdf.base64, filename: input.pdf.filename },
    inputKind,
    created: result.created,
    updated: result.updated,
  });

  if ("summary" in attempt) {
    if (!created.some((task) => task.id === attempt.task.id)) created.push(attempt.task);
    return {
      starter:
        attempt.summary.type === "checklist"
          ? { status: "made", type: "checklist", count: attempt.summary.count }
          : {
              status: "made",
              type: "flashcards",
              count: attempt.summary.count,
              secondaryCount: attempt.summary.secondaryCount,
            },
      created,
    };
  }
  if ("skipped" in attempt) return { starter: null, created };
  if ("blocked" in attempt) {
    // Quota refused: the capture stays (any fallback task included), the
    // starter is skipped and the reply carries the quota sentence verbatim.
    if (attempt.task != null && !created.some((task) => task.id === attempt.task!.id)) {
      created.push(attempt.task);
    }
    return { starter: { status: "blocked", text: attempt.blocked }, created };
  }

  if (attempt.task != null && !created.some((task) => task.id === attempt.task!.id)) {
    created.push(attempt.task);
  }
  // A budget refusal with nothing written yet is rethrown so the handler shows
  // the budget reply; once a task exists, isolating wins over failing.
  const tasksWritten =
    created.length > 0 || result.updated.length > 0 || result.completed.length > 0;
  if (attempt.error instanceof BudgetExceededError && !tasksWritten) throw attempt.error;
  return { starter: { status: "failed", reason: starterFailureReason(attempt.error) }, created };
}

function starterFailureReason(error: unknown): StarterFailureReason {
  if (error instanceof EmptyChecklistError) return "empty_checklist";
  if (error instanceof NoStudyMaterialError) return "no_study_material";
  if (error instanceof FlashcardsTooThinError) return "too_thin";
  return "generic";
}

function toUnderstandOpenTask(task: TaskRow) {
  return {
    id: task.id,
    title: task.title,
    course: task.course,
    kind: task.kind,
    due_at: task.due_at,
  };
}

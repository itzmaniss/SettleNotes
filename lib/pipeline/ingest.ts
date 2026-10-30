// Pure-ish ingest orchestration: understand -> map to reconcile actions ->
// plan -> execute -> mark the upload done. All I/O is injected, so tests run
// the real pipeline against fakes. Errors propagate to the caller (the
// Telegram handler marks the upload failed); nothing is swallowed here.
import type { FinishUploadPatch } from "@/lib/db/queries";
import { listOpenTasks as realListOpenTasks, finishUpload as realFinishUpload } from "@/lib/db/queries";
import type { TaskRow, UploadClassifiedAs, UploadRow, UserRow } from "@/lib/db/types";
import { getMetaClient } from "@/lib/meta/index";
import type { MetaClient } from "@/lib/meta/client";
import { dueLocalToUtc } from "@/lib/pipeline/dates";
import { executeOps, type ExecuteResult } from "@/lib/pipeline/execute";
import {
  planReconcile,
  type OpenTaskLite,
  type Op,
  type ReconcileAction,
} from "@/lib/pipeline/reconcile";
import { understand } from "@/lib/pipeline/understand";
import type { UnderstandAction, UnderstandOutput } from "@/lib/pipeline/understand";

export type IngestDeps = {
  generateObject: MetaClient["generateObject"];
  listOpenTasks: (userId: string) => Promise<TaskRow[]>;
  executeOps: (ops: Op[], ctx: { userId: string; uploadId: string }) => Promise<ExecuteResult>;
  finishUpload: (id: string, patch: FinishUploadPatch) => Promise<void>;
  now: () => Date;
  // Plugged in by a later card: real math diagnosis. Returning a string lets
  // that card hand back reply text; unused for now.
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
  pdf?: { base64: string; filename: string; tooManyPages?: boolean };
  // Storage path of the original file, uploaded by the handler after the
  // upload row existed. Written into the row here so the DB stays truthful.
  storagePath?: string | null;
};

export type IngestOutcome =
  | {
      kind: "tasks";
      result: ExecuteResult;
      clarification: string | null;
      inputKind: UnderstandOutput["input_kind"];
      pdfTruncated: boolean;
    }
  | { kind: "nothing"; clarification: string | null }
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
    now: () => new Date(),
    ...overrides,
  };
}

// The model only ever names tasks by short ref; the id used for any write must
// come from our own refToTaskId map, never from anything the model emitted.
function toReconcileAction(
  action: UnderstandAction,
  refToTaskId: Record<string, string>,
): ReconcileAction {
  return {
    type: action.type,
    taskId: action.task_ref == null ? null : (refToTaskId[action.task_ref] ?? null),
    title: action.title,
    course: action.course,
    kind: action.kind,
    // An unparseable due_local becomes null (no deadline) instead of crashing.
    dueAt: action.due_local == null ? null : dueLocalToUtc(action.due_local),
    effort: action.effort,
    evidence: action.evidence,
    confidence: action.confidence,
  };
}

export async function ingestContent(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
  const now = deps.now();
  const openTasks: TaskRow[] = await deps.listOpenTasks(input.user.id);

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
    },
  );

  const finishDone = (classifiedAs: UploadClassifiedAs): Promise<void> =>
    deps.finishUpload(input.upload.id, {
      status: "done",
      classifiedAs,
      storagePath: input.storagePath ?? null,
    });

  if (output.input_kind === "math_working") {
    // Math diagnosis is a later card; no reconcile, no task writes.
    await deps.onMathWorking?.({
      user: input.user,
      upload: input.upload,
      image: input.image,
      text: input.text,
    });
    await finishDone("math_working");
    return { kind: "math_pending" };
  }

  const actions = output.actions.map((action) => toReconcileAction(action, refToTaskId));
  const ops = planReconcile(actions, openTasks as OpenTaskLite[], now);
  const result = await deps.executeOps(ops, {
    userId: input.user.id,
    uploadId: input.upload.id,
  });
  await finishDone(CLASSIFIED_AS[output.input_kind]);

  const hasWrites =
    result.created.length > 0 || result.updated.length > 0 || result.completed.length > 0;
  if (!hasWrites && result.clarify.length === 0) {
    return { kind: "nothing", clarification: output.needs_clarification };
  }
  return {
    kind: "tasks",
    result,
    clarification: output.needs_clarification,
    inputKind: output.input_kind,
    pdfTruncated: input.pdf?.tooManyPages ?? false,
  };
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

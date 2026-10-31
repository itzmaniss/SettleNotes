// Pure build step for clarifications: turns the low-confidence actions the
// reconciler set aside into stored pending actions plus prompt copy. No I/O
// and no clock, so tests cover every conversion. The caller (ingest) has
// already mapped task refs to ids and due_local to UTC instants, using the
// same conversions as the confident path.
import type { ReconcileAction } from "@/lib/pipeline/reconcile";
import {
  completeClarifyPrompt,
  createClarifyPrompt,
  updateClarifyPrompt,
  updateDueClarifyPrompt,
} from "@/lib/telegram/replies";
import type {
  CompletePendingPayload,
  CreatePendingPayload,
  PendingActionInput,
  UpdatePendingPayload,
} from "./types";

// Prompts per capture: everything past the cap falls back to the text-only
// line so one messy screenshot cannot bury the chat in buttons.
export const MAX_PENDING_PROMPTS = 3;

export type OpenTaskTitleSource = { id: string; title: string };

export type PendingDraft = {
  input: PendingActionInput;
  text: string;
  // Kept so a failed insert can fall back to today's text-only line.
  action: ReconcileAction;
};

export type BuiltPendingActions = {
  drafts: PendingDraft[];
  fallbacks: ReconcileAction[];
};

export function buildPendingActions(
  clarify: ReconcileAction[],
  ctx: { userId: string; uploadId: string },
  openTasks: OpenTaskTitleSource[],
): BuiltPendingActions {
  const drafts: PendingDraft[] = [];
  const fallbacks: ReconcileAction[] = [];
  for (const action of clarify) {
    if (drafts.length >= MAX_PENDING_PROMPTS) {
      fallbacks.push(action);
      continue;
    }
    const draft = buildDraft(action, ctx, openTasks);
    if (draft == null) fallbacks.push(action);
    else drafts.push(draft);
  }
  return { drafts, fallbacks };
}

function buildDraft(
  action: ReconcileAction,
  ctx: { userId: string; uploadId: string },
  openTasks: OpenTaskTitleSource[],
): PendingDraft | null {
  if (action.type === "create") return createDraft(action, ctx);
  if (action.type === "update") return updateDraft(action, ctx, openTasks);
  if (action.type === "complete") return completeDraft(action, ctx, openTasks);
  return null;
}

function createDraft(
  action: ReconcileAction,
  ctx: { userId: string; uploadId: string },
): PendingDraft | null {
  const title = action.title?.trim() ?? "";
  if (title === "") return null;
  const payload: CreatePendingPayload = {
    title,
    course: action.course?.trim() ? action.course.trim() : null,
    // Same default kind the confident create path uses.
    kind: action.kind ?? "other",
    dueAt: action.dueAt,
    effort: action.effort,
    evidence: action.evidence,
  };
  return {
    input: { userId: ctx.userId, uploadId: ctx.uploadId, kind: "create", taskId: null, payload },
    text: createClarifyPrompt(title, action.dueAt),
    action,
  };
}

function updateDraft(
  action: ReconcileAction,
  ctx: { userId: string; uploadId: string },
  openTasks: OpenTaskTitleSource[],
): PendingDraft | null {
  // An update with no resolvable target gets no buttons: with no task to
  // change there is nothing to confirm.
  if (action.taskId == null) return null;
  const task = openTasks.find((t) => t.id === action.taskId);
  if (task == null) return null;
  const payload: UpdatePendingPayload = { evidence: action.evidence };
  const title = action.title?.trim() ?? "";
  if (title !== "") payload.title = title;
  if (action.dueAt != null) payload.dueAt = action.dueAt;
  // Nothing to apply means nothing to confirm.
  if (payload.title == null && payload.dueAt == null) return null;
  return {
    input: {
      userId: ctx.userId,
      uploadId: ctx.uploadId,
      kind: "update",
      taskId: action.taskId,
      payload,
    },
    text:
      payload.dueAt != null
        ? updateDueClarifyPrompt(task.title, payload.dueAt)
        : updateClarifyPrompt(task.title),
    action,
  };
}

function completeDraft(
  action: ReconcileAction,
  ctx: { userId: string; uploadId: string },
  openTasks: OpenTaskTitleSource[],
): PendingDraft | null {
  if (action.taskId == null) return null;
  const task = openTasks.find((t) => t.id === action.taskId);
  if (task == null) return null;
  const payload: CompletePendingPayload = { evidence: action.evidence };
  return {
    input: {
      userId: ctx.userId,
      uploadId: ctx.uploadId,
      kind: "complete",
      taskId: action.taskId,
      payload,
    },
    text: completeClarifyPrompt(task.title),
    action,
  };
}

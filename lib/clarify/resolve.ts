// What happens when the Yes/No button of a clarification is tapped. All I/O
// is injected, so tests drive the real flow against fakes and the Telegram
// wrapper in lib/telegram/callbacks.ts stays a thin adapter.
//
// Guarantees, in order:
// - the tap is always answered (the spinner stops even on errors);
// - the row is claimed atomically before anything is applied, so a double tap
//   applies at most once;
// - applying goes through executeOps, so task_events are written exactly like
//   the confident path;
// - a failed apply hands the row back to pending and never throws here.
import type { Op, TaskFields } from "@/lib/pipeline/reconcile";
import type { ExecuteContext, ExecuteDeps, ExecuteResult } from "@/lib/pipeline/execute";
import {
  clearedKeyboard,
  commandFailedReply,
  pendingAppliedReply,
  pendingDismissedReply,
  pendingExpiredReply,
  pendingHandledReply,
  pendingTaskChangedReply,
  PENDING_CALLBACK_DATA_PATTERN,
} from "@/lib/telegram/replies";
import type { TaskRow, UserRow } from "@/lib/db/types";
import {
  parsePendingPayload,
  type ParsedPendingPayload,
  type PendingActionRow,
} from "./types";
import type { ClaimStatus } from "./queries";

export type ResolverDeps = {
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  getPendingAction: (id: string, userId: string) => Promise<PendingActionRow | null>;
  claimPendingAction: (
    id: string,
    userId: string,
    status: ClaimStatus,
    now: Date,
  ) => Promise<PendingActionRow | null>;
  resetPendingAction: (id: string, userId: string) => Promise<void>;
  getOpenTask: (taskId: string, userId: string) => Promise<TaskRow | null>;
  executeOps: (
    ops: Op[],
    ctx: ExecuteContext,
    db?: ExecuteDeps,
  ) => Promise<ExecuteResult>;
  now?: () => Date;
};

// What the resolver needs from the chat: answer the tap, rewrite the prompt
// message, and a plain-reply fallback for when that message is too old to edit.
export type TapView = {
  answerCallbackQuery: () => Promise<unknown>;
  editMessageText: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
};

export type TapInput = {
  // Raw callback data; the resolver matches it so the answer always happens
  // in exactly one place, including for taps that are not ours.
  data: string;
  telegramUserId: number;
};

export async function resolvePendingTap(
  deps: ResolverDeps,
  view: TapView,
  input: TapInput,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  let answered = false;
  const answer = async (): Promise<void> => {
    if (answered) return;
    answered = true;
    try {
      await view.answerCallbackQuery();
    } catch {
      // Stopping the spinner is best effort; the outcome matters more.
    }
  };

  try {
    await answer();
    const match = PENDING_CALLBACK_DATA_PATTERN.exec(input.data);
    // Taps on other bots' buttons (or anything unexpected) are answered and
    // silently ignored.
    if (match == null) return;
    const yes = match[1] === "y";
    const pendingId = match[2];

    const user = await deps.getUserByTelegramId(input.telegramUserId);
    if (user == null) {
      await editQuietly(view, pendingHandledReply());
      return;
    }
    const row = await deps.getPendingAction(pendingId, user.id);
    if (row == null || row.status !== "pending") {
      await editQuietly(view, pendingHandledReply());
      return;
    }
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= now().getTime()) {
      await editQuietly(view, pendingExpiredReply());
      return;
    }
    const claimed = await deps.claimPendingAction(
      pendingId,
      user.id,
      yes ? "accepted" : "dismissed",
      now(),
    );
    if (claimed == null) {
      // A second tap, or Telegram redelivering the first one.
      await editQuietly(view, pendingHandledReply());
      return;
    }

    if (!yes) {
      await editQuietly(view, pendingDismissedReply(), { reply_markup: clearedKeyboard() });
      return;
    }
    await applyClaimed(deps, view, row, user.id);
  } catch (error) {
    await answer();
    console.error(
      "[clarify] tap could not be resolved:",
      error instanceof Error ? error.message : String(error),
    );
    await editQuietly(view, commandFailedReply());
  }
}

// Applies an accepted row. Every failure after the claim resets the row to
// pending so the student can tap again, logs one line, and shows the generic
// friendly failure.
async function applyClaimed(
  deps: ResolverDeps,
  view: TapView,
  row: PendingActionRow,
  userId: string,
): Promise<void> {
  try {
    const parsed = parsePendingPayload(row.kind, row.payload);
    if (parsed == null) throw new Error("stored payload did not match its kind");

    const task =
      parsed.kind === "create" ? null : await deps.getOpenTask(row.task_id ?? "", userId);
    if (parsed.kind !== "create" && task == null) {
      // Gone, or no longer open, since the prompt went out. The claim stands
      // (the prompt is spent) but nothing is written.
      await editQuietly(view, pendingTaskChangedReply(), { reply_markup: clearedKeyboard() });
      return;
    }

    const ops = buildApplyOps(parsed, task);
    const result = await deps.executeOps(ops, {
      userId,
      // Empty string stands in for "upload deleted since"; the write deps
      // translate it to null so no uuid column ever sees it.
      uploadId: row.upload_id ?? "",
    });
    await editQuietly(view, pendingAppliedReply(row.kind, result), {
      reply_markup: clearedKeyboard(),
    });
  } catch (error) {
    try {
      await deps.resetPendingAction(row.id, userId);
    } catch (resetError) {
      console.error(
        "[clarify] failed to hand the pending action back:",
        resetError instanceof Error ? resetError.message : String(resetError),
      );
    }
    console.error(
      "[clarify] applying the stored action failed:",
      error instanceof Error ? error.message : String(error),
    );
    await editQuietly(view, commandFailedReply());
  }
}

// The same Op shapes the confident path builds in lib/pipeline/reconcile.ts,
// so executeOps writes task_events with the right action and evidence.
export function buildApplyOps(parsed: ParsedPendingPayload, task: TaskRow | null): Op[] {
  if (parsed.kind === "create") {
    const p = parsed.payload;
    const fields: TaskFields = {
      title: p.title,
      course: p.course,
      kind: p.kind,
      dueAt: p.dueAt,
      effort: p.effort,
    };
    return [
      {
        op: "create",
        fields,
        event: { action: "created", before: null, after: fields, evidence: p.evidence },
      },
    ];
  }
  if (parsed.kind === "complete") {
    return [
      {
        op: "complete",
        taskId: task!.id,
        event: {
          action: "completed",
          before: { status: "open" },
          after: { status: "done" },
          evidence: parsed.payload.evidence,
        },
      },
    ];
  }
  const patch: Partial<TaskFields> = {};
  const before: Partial<TaskFields> = {};
  if (parsed.payload.title != null) {
    before.title = task!.title;
    patch.title = parsed.payload.title;
  }
  if (parsed.payload.dueAt != null) {
    before.dueAt = task!.due_at;
    patch.dueAt = parsed.payload.dueAt;
  }
  return [
    {
      op: "update",
      taskId: task!.id,
      patch,
      event: { action: "updated", before, after: { ...patch }, evidence: parsed.payload.evidence },
    },
  ];
}

// Editing can fail for old messages (Telegram stops allowing edits after 48
// hours); fall back to a plain reply so the student still sees the outcome.
async function editQuietly(
  view: TapView,
  text: string,
  other?: { reply_markup?: unknown },
): Promise<void> {
  try {
    await view.editMessageText(text, other);
  } catch (editError) {
    try {
      await view.reply(text, other);
    } catch (replyError) {
      console.error(
        "[clarify] could not answer the tap in chat:",
        replyError instanceof Error ? replyError.message : String(replyError),
      );
      void editError;
    }
  }
}

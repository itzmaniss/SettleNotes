import "server-only";
import type { User } from "grammy/types";
import {
  getUserByTelegramId as realGetUserByTelegramId,
  getPendingAction as realGetPendingAction,
  claimPendingAction as realClaimPendingAction,
  resetPendingAction as realResetPendingAction,
  getOpenTask as realGetOpenTask,
} from "@/lib/clarify/queries";
import {
  resolvePendingTap,
  type ResolverDeps,
  type TapView,
  type TapInput,
} from "@/lib/clarify/resolve";
import {
  insertTask as realInsertTask,
  insertTaskEvent as realInsertTaskEvent,
  updateTask as realUpdateTask,
} from "@/lib/db/queries";
import { executeOps as realExecuteOps } from "@/lib/pipeline/execute";
import type { ExecuteDeps } from "@/lib/pipeline/execute";

// Both entry points (webhook and long polling) must ask Telegram to deliver
// callback_query updates, or the Yes/No buttons render but every tap goes
// nowhere. Exported so the scripts share one list and tests can pin it.
export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;

// Minimal structural view of a grammY callback context, so tests pass tiny
// fakes instead of building a real Bot (same idea as BotContextLike).
export type CallbackContextLike = {
  from?: User;
  callbackQuery?: { data?: string };
  answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
  editMessageText: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
};

export type PendingActionCallback = (ctx: CallbackContextLike) => Promise<void>;

export function createPendingActionCallback(
  deps: Partial<ResolverDeps> = {},
): PendingActionCallback {
  const fullDeps: ResolverDeps = {
    getUserByTelegramId: deps.getUserByTelegramId ?? realGetUserByTelegramId,
    getPendingAction: deps.getPendingAction ?? realGetPendingAction,
    claimPendingAction: deps.claimPendingAction ?? realClaimPendingAction,
    resetPendingAction: deps.resetPendingAction ?? realResetPendingAction,
    getOpenTask: deps.getOpenTask ?? realGetOpenTask,
    // The confident path's executor with the same write functions underneath;
    // only the wrappers differ, mapping "no upload" to null so no uuid column
    // ever receives an empty string.
    executeOps:
      deps.executeOps ??
      ((ops, ctx) => realExecuteOps(ops, ctx, realApplyDeps())),
    now: deps.now,
  };
  const resolve = (view: TapView, input: TapInput) => resolvePendingTap(fullDeps, view, input);

  return async (ctx: CallbackContextLike): Promise<void> => {
    // resolvePendingTap never throws (it catches, answers and logs internally),
    // so nothing escapes into polling or after().
    await resolve(
      {
        answerCallbackQuery: () => ctx.answerCallbackQuery(),
        editMessageText: (text, other) => ctx.editMessageText(text, other),
        reply: (text, other) => ctx.reply(text, other),
      } satisfies TapView,
      { data: ctx.callbackQuery?.data ?? "", telegramUserId: ctx.from?.id ?? 0 },
    );
  };
}

function orNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

function realApplyDeps(): ExecuteDeps {
  return {
    insertTask: (i) => realInsertTask({ ...i, sourceUploadId: orNull(i.sourceUploadId) }),
    updateTask: realUpdateTask,
    insertTaskEvent: (i) => realInsertTaskEvent({ ...i, uploadId: orNull(i.uploadId) }),
  };
}

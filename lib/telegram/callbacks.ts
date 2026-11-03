import "server-only";
import type { User } from "grammy/types";
import type { UserRow } from "@/lib/db/types";
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
import type { RateLimitCheck } from "@/lib/telegram/limits";
import {
  commandFailedReply,
  quizRateLimitedReply,
  REVIEW_START_CALLBACK_DATA_PATTERN,
} from "@/lib/telegram/replies";
import {
  createReviewFlowDeps,
  reviewUnavailableReply,
  startReviewQuiz,
} from "@/lib/weakspots/review-flow";
import type { ReviewStartOutcome } from "@/lib/weakspots/review-flow";

// Both entry points (webhook and long polling) must ask Telegram to deliver
// callback_query and pre_checkout_query updates, or the Yes/No buttons render
// but every tap goes nowhere and Stars checkouts never arrive. Exported so
// the scripts share one list and tests can pin it.
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "pre_checkout_query",
] as const;

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

// ---- the Start review tap ----------------------------------------------------

// Structural view of a grammY callback context with the chat, so the tap can
// be ignored outside private chats and answered in place.
export type ReviewCallbackContextLike = {
  from?: User;
  chat?: { id: number; type: string };
  callbackQuery?: { data?: string };
  answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
  editMessageText: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  reply: (
    text: string,
    other?: { reply_markup?: unknown; reply_parameters?: unknown },
  ) => Promise<unknown>;
};

export type ReviewStartCallbackDeps = {
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  start: (userId: string, reviewTaskId: string) => Promise<ReviewStartOutcome>;
  // Same per-user gate the ingest handlers use, since starting the quiz can
  // make one model call when nothing is stored. Optional so tests omit it.
  checkRateLimit?: RateLimitCheck;
};

// A failed reply must never throw out of a callback handler.
async function replyQuietly(ctx: ReviewCallbackContextLike, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (error) {
    console.error("[telegram] reply failed:", error instanceof Error ? error.message : String(error));
  }
}

// The rate gate for quiz actions: refused means one friendly line and no AI
// call; a failing lookup fails open exactly like the ingest gate.
async function passQuizGate(
  ctx: ReviewCallbackContextLike,
  check: RateLimitCheck | undefined,
  userId: string,
): Promise<boolean> {
  if (check === undefined) return true;
  let verdict: RateLimitOutcomeOf;
  try {
    verdict = await check(userId);
  } catch (error) {
    console.error(
      "[telegram] rate limit lookup failed, letting the quiz through:",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
  if (verdict.allowed) return true;
  await replyQuietly(ctx, quizRateLimitedReply(verdict));
  return false;
}

type RateLimitOutcomeOf = Awaited<ReturnType<RateLimitCheck>>;

/**
 * Handles the rv:start taps. Registered next to pc:ok behind the consent
 * gate and BEFORE the pending action callback (which swallows every tap):
 * non rv: data is handed to next() so pa: taps still arrive. The tap is
 * answered first, ignored outside private chats, and only ever starts the
 * owner's own open review task; a stale or foreign id gets the fresh-start
 * line, never someone else's quiz.
 */
export function createReviewStartCallback(
  deps: Partial<ReviewStartCallbackDeps> = {},
): (ctx: ReviewCallbackContextLike, next?: () => Promise<void>) => Promise<void> {
  const getUser = deps.getUserByTelegramId ?? realGetUserByTelegramId;
  const start =
    deps.start ??
    ((userId: string, reviewTaskId: string) =>
      startReviewQuiz(createReviewFlowDeps(), userId, reviewTaskId));
  const check = deps.checkRateLimit;

  return async (ctx, next) => {
    const data = ctx.callbackQuery?.data ?? "";
    if (!REVIEW_START_CALLBACK_DATA_PATTERN.test(data)) {
      if (next !== undefined) return next();
      return;
    }
    try {
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.error(
        "[telegram] answering the review tap failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (ctx.chat?.type !== "private") return;
    const from = ctx.from;
    if (from === undefined) return;
    try {
      const user = await getUser(from.id);
      if (user == null) {
        await replyQuietly(ctx, reviewUnavailableReply());
        return;
      }
      if (!(await passQuizGate(ctx, check, user.id))) return;
      const reviewTaskId = data.slice(reviewStartDataPrefix.length);
      const outcome = await start(user.id, reviewTaskId);
      await replyQuietly(ctx, outcome.message);
    } catch (error) {
      console.error(
        "[telegram] review start failed:",
        error instanceof Error ? error.message : String(error),
      );
      await replyQuietly(ctx, commandFailedReply());
    }
  };
}

const reviewStartDataPrefix = "rv:start:";

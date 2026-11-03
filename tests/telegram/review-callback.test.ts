import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import type { UserRow } from "../../lib/db/types";
import type { RateLimitCheck, RateLimitOutcome } from "../../lib/telegram/limits";
import { createReviewStartCallback, type ReviewCallbackContextLike } from "../../lib/telegram/callbacks";
import { registerHandlers } from "../../lib/telegram/bot";
import {
  reviewStartCallbackData,
  REVIEW_START_BUTTON_TEXT,
  REVIEW_START_CALLBACK_DATA_PATTERN,
  startReviewKeyboard,
  rateLimitReply,
} from "../../lib/telegram/replies";
import { reviewUnavailableReply } from "../../lib/weakspots/review-flow";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const USER: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  terms_accepted_at: "2026-01-01T00:00:00.000Z",
  terms_version: "2026-01",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("the Start review button", () => {
  test("exact shape: one button, Start review, rv:start:<id>", () => {
    const keyboard = startReviewKeyboard(UUID);
    const rows = (keyboard as unknown as { inline_keyboard: Array<Array<Record<string, string>>> }).inline_keyboard;
    expect(rows).toEqual([[{ text: REVIEW_START_BUTTON_TEXT, callback_data: `rv:start:${UUID}` }]]);
    expect(REVIEW_START_BUTTON_TEXT).toBe("Start review");
  });

  test("callback data stays under Telegram's 64 byte cap", () => {
    const data = reviewStartCallbackData(UUID);
    expect(new TextEncoder().encode(data).length).toBeLessThan(64);
    expect(REVIEW_START_CALLBACK_DATA_PATTERN.test(data)).toBe(true);
    expect(REVIEW_START_CALLBACK_DATA_PATTERN.test(`rv:start:not-a-uuid`)).toBe(false);
  });
});

function fakeCallbackCtx(data: string, chatType: string = "private") {
  const events: string[] = [];
  const replies: string[] = [];
  const ctx: ReviewCallbackContextLike = {
    from: { id: 101, is_bot: false, first_name: "Tim" },
    chat: { id: 101, type: chatType },
    callbackQuery: { data },
    answerCallbackQuery: async () => {
      events.push("answered");
      return {};
    },
    editMessageText: async () => {
      events.push("edited");
      return {};
    },
    reply: async (text: string) => {
      events.push("replied");
      replies.push(text);
      return {};
    },
  };
  return { ctx, events, replies };
}

function callbackDeps(overrides: Record<string, unknown> = {}) {
  const started: Array<{ userId: string; reviewTaskId: string }> = [];
  const deps = {
    getUserByTelegramId: async () => USER,
    start: async (userId: string, reviewTaskId: string) => {
      started.push({ userId, reviewTaskId });
      return { kind: "started" as const, message: "Question 1 message" };
    },
    ...overrides,
  };
  return { deps, started };
}

describe("the review start callback", () => {
  test("answers first, then starts the quiz named in the data", async () => {
    const { deps, started } = callbackDeps();
    const handler = createReviewStartCallback(deps);
    const { ctx, events, replies } = fakeCallbackCtx(`rv:start:${UUID}`);
    await handler(ctx);
    expect(events[0]).toBe("answered");
    expect(events).toContain("replied");
    expect(started).toEqual([{ userId: "user-1", reviewTaskId: UUID }]);
    expect(replies).toEqual(["Question 1 message"]);
  });

  test("a tap outside a private chat is ignored after the answer", async () => {
    const { deps, started } = callbackDeps();
    const handler = createReviewStartCallback(deps);
    const { ctx, events, replies } = fakeCallbackCtx(`rv:start:${UUID}`, "group");
    await handler(ctx);
    expect(events).toEqual(["answered"]);
    expect(started).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("an unknown student gets the fresh start line", async () => {
    const { deps, started } = callbackDeps({
      getUserByTelegramId: async () => null,
    });
    const handler = createReviewStartCallback(deps);
    const { ctx, replies } = fakeCallbackCtx(`rv:start:${UUID}`);
    await handler(ctx);
    expect(started).toHaveLength(0);
    expect(replies).toEqual([reviewUnavailableReply()]);
  });

  test("a refused rate limit stops before any start", async () => {
    const { deps, started } = callbackDeps();
    const check: RateLimitCheck = async () =>
      ({ allowed: false, retryAfterSeconds: 30 }) as RateLimitOutcome;
    const handler = createReviewStartCallback({ ...deps, checkRateLimit: check });
    const { ctx, replies } = fakeCallbackCtx(`rv:start:${UUID}`);
    await handler(ctx);
    expect(started).toHaveLength(0);
    expect(replies).toEqual([rateLimitReply(30)]);
  });

  test("a failing rate limit lookup fails open", async () => {
    const { deps, started } = callbackDeps();
    const check: RateLimitCheck = async () => {
      throw new Error("db down");
    };
    const handler = createReviewStartCallback({ ...deps, checkRateLimit: check });
    const { ctx } = fakeCallbackCtx(`rv:start:${UUID}`);
    await handler(ctx);
    expect(started).toEqual([{ userId: "user-1", reviewTaskId: UUID }]);
  });

  test("a start failure answers with the command failure line, never throws", async () => {
    const { deps, started } = callbackDeps({
      start: async () => {
        throw new Error("db down");
      },
    });
    const handler = createReviewStartCallback(deps);
    const { ctx, events, replies } = fakeCallbackCtx(`rv:start:${UUID}`);
    await handler(ctx);
    expect(started).toHaveLength(0);
    expect(events).toContain("answered");
    expect(replies).toHaveLength(1);
  });
});

describe("registration order in registerHandlers", () => {
  function recordingBot() {
    const commands: string[] = [];
    const callbacks: Array<(ctx: never, next?: () => Promise<void>) => Promise<void>> = [];
    const fake = {
      command: (name: string) => {
        commands.push(name);
      },
      on: (event: string, handler: (ctx: never, next?: () => Promise<void>) => Promise<void>) => {
        if (event === "callback_query:data") callbacks.push(handler);
      },
    } as unknown as Bot;
    return { fake, commands, callbacks };
  }

  test("the review callback is registered before the pending action swallower", async () => {
    const { fake, commands, callbacks } = recordingBot();
    registerHandlers(fake);
    expect(commands).toContain("review");
    // At least four callback handlers: tc:ok, pc:, rv:, pa:.
    expect(callbacks.length).toBeGreaterThanOrEqual(4);
    // Walk the handlers with an rv: tap in a GROUP chat: the review callback
    // matches the data, answers the tap and stops (its private-chat guard),
    // all without touching any database path. If the pending action callback
    // were ever registered before it, that swallower would consume the tap
    // instead and the consumer would be the last handler.
    const events: string[] = [];
    let handedOn = false;
    const groupCtx = {
      from: { id: 101, is_bot: false, first_name: "Tim" },
      chat: { id: -100, type: "group", title: "class" },
      callbackQuery: { data: `rv:start:${UUID}` },
      answerCallbackQuery: async () => {
        events.push("answered");
        return {};
      },
      editMessageText: async () => ({}),
      reply: async () => ({}),
    };
    for (const handler of callbacks) {
      handedOn = false;
      await handler(groupCtx as never, async () => {
        handedOn = true;
      });
      if (!handedOn) break;
    }
    expect(events).toEqual(["answered"]);
    expect(handedOn).toBe(false);
  });
});

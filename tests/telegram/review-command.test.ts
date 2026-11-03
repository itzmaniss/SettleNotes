import { describe, expect, test } from "bun:test";
import type { UserRow } from "../../lib/db/types";
import type { RateLimitCheck, RateLimitOutcome } from "../../lib/telegram/limits";
import { createReviewCommand, type CommandContextLike } from "../../lib/telegram/commands";
import { commandFailedReply, rateLimitReply } from "../../lib/telegram/replies";
import { noReviewWaitingReply } from "../../lib/weakspots/review-flow";

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

function fakeCtx(): { ctx: CommandContextLike; replies: string[] } {
  const replies: string[] = [];
  return {
    ctx: {
      from: { id: 101, is_bot: false, first_name: "Tim" },
      chat: { id: 101, type: "private", first_name: "Tim" },
      message: { text: "/review", date: 1, message_id: 5, chat: { id: 101, type: "private", first_name: "Tim" } },
      reply: async (text: string) => {
        replies.push(text);
        return {};
      },
    },
    replies,
  };
}

describe("createReviewCommand", () => {
  test("starts the quiz and replies with its message", async () => {
    const started: string[] = [];
    const command = createReviewCommand({
      getUserByTelegramId: async () => USER,
      start: async (userId) => {
        started.push(userId);
        return { kind: "started", message: "Let us practise a few questions like the one you slipped on. Question 1 of 3:" };
      },
    });
    const { ctx, replies } = fakeCtx();
    await command(ctx);
    expect(started).toEqual(["user-1"]);
    expect(replies).toEqual(["Let us practise a few questions like the one you slipped on. Question 1 of 3:"]);
  });

  test("no review waiting answers with the friendly line", async () => {
    const command = createReviewCommand({
      getUserByTelegramId: async () => USER,
      start: async () => ({ kind: "none", message: noReviewWaitingReply() }),
    });
    const { ctx, replies } = fakeCtx();
    await command(ctx);
    expect(replies).toEqual([noReviewWaitingReply()]);
  });

  test("an unknown student gets the get started line, no start call", async () => {
    const started: string[] = [];
    const command = createReviewCommand({
      getUserByTelegramId: async () => null,
      start: async (userId) => {
        started.push(userId);
        return { kind: "started", message: "x" };
      },
    });
    const { ctx, replies } = fakeCtx();
    await command(ctx);
    expect(started).toHaveLength(0);
    expect(replies).toEqual(["Send me something first and I will start your list."]);
  });

  test("a refused rate limit stops the command with the retry line", async () => {
    const started: string[] = [];
    const check: RateLimitCheck = async () =>
      ({ allowed: false, retryAfterSeconds: 45 }) as RateLimitOutcome;
    const command = createReviewCommand({
      getUserByTelegramId: async () => USER,
      start: async (userId) => {
        started.push(userId);
        return { kind: "started", message: "x" };
      },
      checkRateLimit: check,
    });
    const { ctx, replies } = fakeCtx();
    await command(ctx);
    expect(started).toHaveLength(0);
    expect(replies).toEqual([rateLimitReply(45)]);
  });

  test("a failing rate limit lookup fails open", async () => {
    const started: string[] = [];
    const check: RateLimitCheck = async () => {
      throw new Error("db down");
    };
    const command = createReviewCommand({
      getUserByTelegramId: async () => USER,
      start: async (userId) => {
        started.push(userId);
        return { kind: "started", message: "started" };
      },
      checkRateLimit: check,
    });
    const { ctx, replies } = fakeCtx();
    await command(ctx);
    expect(started).toEqual(["user-1"]);
    expect(replies).toEqual(["started"]);
  });

  test("a start failure answers with the command failure line", async () => {
    const command = createReviewCommand({
      getUserByTelegramId: async () => USER,
      start: async () => {
        throw new Error("db down");
      },
    });
    const { ctx, replies } = fakeCtx();
    await command(ctx);
    expect(replies).toEqual([commandFailedReply()]);
  });
});

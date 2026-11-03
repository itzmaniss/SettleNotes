import { describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import type { UserRow } from "../../lib/db/types";
import type { RateLimitCheck, RateLimitOutcome } from "../../lib/telegram/limits";
import {
  KNOWN_COMMANDS,
  createReviewQuizIntercept,
  handlePhotoMessage,
  handleTextMessage,
  matchesReviewPhrase,
  REVIEW_PHRASES,
  type BotContextLike,
  type ReviewQuizIntercept,
} from "../../lib/telegram/handlers";
import { dailyCapReply, rateLimitReply } from "../../lib/telegram/replies";
import type { UpsertUserInput } from "../../lib/db/queries";

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

function fakeCtx(text: string): { ctx: BotContextLike; replies: string[] } {
  const replies: string[] = [];
  const ctx: BotContextLike = {
    from: { id: 101, is_bot: false, first_name: "Tim" },
    chat: { id: 101, type: "private", first_name: "Tim" },
    message: { text, date: 1, message_id: 7, chat: { id: 101, type: "private" } } as Message,
    reply: async (replyText: string) => {
      replies.push(replyText);
      return {};
    },
    replyWithPhoto: async () => ({}),
    replyWithChatAction: async () => ({}),
    api: { getFile: async () => ({}) },
  };
  return { ctx, replies };
}

function fakeIngest() {
  const ingested: string[] = [];
  const ingest = async (input: { text?: string | null }) => {
    ingested.push(input.text ?? "");
    return { kind: "nothing" as const, answer: null, clarification: null };
  };
  return { ingested, ingest };
}

function baseDeps() {
  const upserts: UpsertUserInput[] = [];
  const started: string[] = [];
  const answered: Array<{ userId: string; text: string }> = [];
  let sessionLive = false;
  return {
    upserts,
    started,
    answered,
    deps: {
      upsertUser: async (i: UpsertUserInput) => {
        upserts.push(i);
        return USER;
      },
      start: async (userId: string) => {
        started.push(userId);
        sessionLive = true;
        return { kind: "started" as const, message: "started message" };
      },
      answer: async (userId: string, text: string) => {
        answered.push({ userId, text });
        return { kind: "answered" as const, message: "feedback message" };
      },
      hasSession: () => sessionLive,
      botToken: "",
    },
  };
}

describe("matchesReviewPhrase", () => {
  test("the listed short phrases match, in any case, with punctuation", () => {
    for (const phrase of REVIEW_PHRASES) {
      expect(matchesReviewPhrase(phrase)).toBe(true);
      expect(matchesReviewPhrase(phrase.toUpperCase())).toBe(true);
    }
    expect(matchesReviewPhrase("Can we do the review now?")).toBe(true);
    expect(matchesReviewPhrase("  quiz me! ")).toBe(true);
  });

  test("non matches reach the normal pipeline", () => {
    expect(matchesReviewPhrase("what is a review")).toBe(false);
    expect(matchesReviewPhrase("please do the review of chapter 3 for me")).toBe(false);
    expect(matchesReviewPhrase("review")).toBe(false);
    expect(matchesReviewPhrase("")).toBe(false);
    const long = "can we do the review now because I really need to practise this topic today please";
    expect(long.length).toBeGreaterThanOrEqual(60);
    expect(matchesReviewPhrase(long)).toBe(false);
  });
});

describe("the review quiz text intercept", () => {
  test("a phrase starts the quiz and the pipeline never sees the message", async () => {
    const { deps, started, upserts } = baseDeps();
    const intercept = createReviewQuizIntercept(deps);
    const { ctx, replies } = fakeCtx("do the review");
    const consumed = await intercept.interceptText(ctx);
    expect(consumed).toBe(true);
    expect(started).toEqual(["user-1"]);
    expect(replies).toEqual(["started message"]);
    expect(upserts[0]).toMatchObject({ telegramUserId: 101 });
  });

  test("while a session is live the next text is the answer", async () => {
    const { deps, answered } = baseDeps();
    const intercept = createReviewQuizIntercept(deps);
    // Prime the session the same way the start does.
    await intercept.interceptText(fakeCtx("do the review").ctx);
    const { ctx, replies } = fakeCtx("4");
    const consumed = await intercept.interceptText(ctx);
    expect(consumed).toBe(true);
    expect(answered).toEqual([{ userId: "user-1", text: "4" }]);
    expect(replies).toEqual(["feedback message"]);
  });

  test("a plain message with no session and no phrase falls through", async () => {
    const { deps, started, answered } = baseDeps();
    const intercept = createReviewQuizIntercept(deps);
    const { ctx } = fakeCtx("what is a review");
    const consumed = await intercept.interceptText(ctx);
    expect(consumed).toBe(false);
    expect(started).toHaveLength(0);
    expect(answered).toHaveLength(0);
  });

  test("commands are never consumed, in or out of a session", async () => {
    const { deps, started, answered } = baseDeps();
    const intercept = createReviewQuizIntercept(deps);
    await intercept.interceptText(fakeCtx("do the review").ctx);
    const consumed = await intercept.interceptText(fakeCtx("/tasks").ctx);
    expect(consumed).toBe(false);
    expect(started).toHaveLength(1);
    expect(answered).toHaveLength(0);
  });

  test("a refused rate limit stops the start with the retry line", async () => {
    const { deps, started } = baseDeps();
    const check: RateLimitCheck = async () => ({
      allowed: false,
      retryAfterSeconds: 60,
    }) as RateLimitOutcome;
    const intercept = createReviewQuizIntercept({ ...deps, checkRateLimit: check });
    const { ctx, replies } = fakeCtx("do the review");
    const consumed = await intercept.interceptText(ctx);
    expect(consumed).toBe(true);
    expect(started).toHaveLength(0);
    expect(replies).toEqual([rateLimitReply(60)]);
  });

  test("the daily cap gets the pause for today line", async () => {
    const { deps, started } = baseDeps();
    const check: RateLimitCheck = async () => ({
      allowed: false,
      retryAfterSeconds: 86400,
      window: "day",
    }) as RateLimitOutcome;
    const intercept = createReviewQuizIntercept({ ...deps, checkRateLimit: check });
    const { ctx, replies } = fakeCtx("quiz me");
    await intercept.interceptText(ctx);
    expect(started).toHaveLength(0);
    expect(replies).toEqual([dailyCapReply()]);
  });

  test("a failing rate limit lookup fails open and the quiz starts", async () => {
    const { deps, started } = baseDeps();
    const check: RateLimitCheck = async () => {
      throw new Error("db down");
    };
    const intercept = createReviewQuizIntercept({ ...deps, checkRateLimit: check });
    const { ctx } = fakeCtx("do the review");
    const consumed = await intercept.interceptText(ctx);
    expect(consumed).toBe(true);
    expect(started).toEqual(["user-1"]);
  });

  test("a rate limited answer is refused before the check runs", async () => {
    const { deps, answered } = baseDeps();
    let calls = 0;
    const check: RateLimitCheck = async () => {
      calls += 1;
      if (calls === 1) return { allowed: true } as RateLimitOutcome;
      return { allowed: false, retryAfterSeconds: 60 } as RateLimitOutcome;
    };
    const intercept = createReviewQuizIntercept({ ...deps, checkRateLimit: check });
    await intercept.interceptText(fakeCtx("do the review").ctx);
    const { ctx, replies } = fakeCtx("4");
    const consumed = await intercept.interceptText(ctx);
    expect(consumed).toBe(true);
    expect(answered).toHaveLength(0);
    expect(replies).toEqual([rateLimitReply(60)]);
  });
});

describe("handleTextMessage with the quiz wired in", () => {
  function handlerDeps(review: ReviewQuizIntercept) {
    const { ingested, ingest } = fakeIngest();
    return {
      ingested,
      deps: {
        upsertUser: async () => USER,
        createUpload: async () => ({
          id: "upload-1",
          user_id: USER.id,
          kind: "text",
          telegram_file_id: null,
          mime_type: null,
          storage_path: null,
          text_content: null,
          classified_as: null,
          status: "processing",
          error: null,
          created_at: "2026-01-01T00:00:00.000Z",
        }),
        finishUpload: async () => {},
        downloadTelegramFile: async () => {
          throw new Error("no downloads in this test");
        },
        normalizeImage: async () => {
          throw new Error("no images in this test");
        },
        inspectPdf: () => {
          throw new Error("no pdfs in this test");
        },
        uploadOriginal: async () => {
          throw new Error("no uploads in this test");
        },
        ingest,
        botToken: "",
        appBaseUrl: "https://settle.example",
        review,
      },
    };
  }

  test("a quiz answer is consumed and the pipeline is untouched", async () => {
    const { deps, answered } = baseDeps();
    const review = createReviewQuizIntercept(deps);
    await review.interceptText(fakeCtx("do the review").ctx);
    const { ingested, deps: hd } = handlerDeps(review);
    const { ctx, replies } = fakeCtx("4");
    await handleTextMessage(ctx, hd as never);
    expect(replies).toEqual(["feedback message"]);
    expect(ingested).toHaveLength(0);
    expect(answered).toHaveLength(1);
  });

  test("a non quiz message still reaches the pipeline", async () => {
    const { deps } = baseDeps();
    const review = createReviewQuizIntercept(deps);
    const { ingested, deps: hd } = handlerDeps(review);
    const { ctx } = fakeCtx("I have a test on friday, remind me to study");
    await handleTextMessage(ctx, hd as never);
    expect(ingested).toHaveLength(1);
  });

  test("a known command typed during a session works normally", async () => {
    const { deps, answered } = baseDeps();
    const review = createReviewQuizIntercept(deps);
    await review.interceptText(fakeCtx("do the review").ctx);
    const { ingested, deps: hd } = handlerDeps(review);
    const { ctx, replies } = fakeCtx("/tasks");
    await handleTextMessage(ctx, hd as never);
    // The command branch answers nothing here (the /tasks command middleware
    // owns it); the message is not eaten as an answer.
    expect(replies).toHaveLength(0);
    expect(ingested).toHaveLength(0);
    expect(answered).toHaveLength(0);
  });

  test("an unknown command during a session still gets the unknown command line", async () => {
    const { deps, answered } = baseDeps();
    const review = createReviewQuizIntercept(deps);
    await review.interceptText(fakeCtx("do the review").ctx);
    const { ingested, deps: hd } = handlerDeps(review);
    const { ctx, replies } = fakeCtx("/frobnicate");
    await handleTextMessage(ctx, hd as never);
    expect(replies).toHaveLength(1);
    expect(ingested).toHaveLength(0);
    expect(answered).toHaveLength(0);
  });

  test("an expired session hands the message to the pipeline", async () => {
    const { deps, answered } = baseDeps();
    const review = createReviewQuizIntercept(deps);
    await review.interceptText(fakeCtx("do the review").ctx);
    // Simulate expiry: the session disappears underneath.
    const expired = createReviewQuizIntercept({ ...deps, hasSession: () => false });
    const { ingested, deps: hd } = handlerDeps(expired);
    const { ctx } = fakeCtx("4");
    await handleTextMessage(ctx, hd as never);
    expect(ingested).toEqual(["4"]);
    expect(answered).toHaveLength(0);
  });
});

describe("photos are never quiz answers", () => {
  test("a photo during a live session runs the normal photo pipeline", async () => {
    const { deps, answered } = baseDeps();
    const review = createReviewQuizIntercept(deps);
    await review.interceptText(fakeCtx("do the review").ctx);
    const { ingested, ingest } = fakeIngest();
    let reviewTouched = false;
    const spyReview: ReviewQuizIntercept = {
      interceptText: async () => {
        reviewTouched = true;
        return true;
      },
    };
    const deps2 = {
      upsertUser: async () => USER,
      createUpload: async () => ({
        id: "upload-1",
        user_id: USER.id,
        kind: "photo",
        telegram_file_id: "file-1",
        mime_type: "image/jpeg",
        storage_path: null,
        text_content: null,
        classified_as: null,
        status: "processing",
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      finishUpload: async () => {},
      downloadTelegramFile: async () => Buffer.from("jpeg"),
      normalizeImage: async () => ({ buffer: Buffer.from("jpeg"), mimeType: "image/jpeg", width: 4, height: 4 }),
      inspectPdf: () => {
        throw new Error("no pdfs in this test");
      },
      uploadOriginal: async () => "user-1/upload-1/original.jpg",
      ingest,
      botToken: "",
      appBaseUrl: "https://settle.example",
      // Deliberately wired to prove the photo path never consults it.
      review: spyReview,
    };
    const photoCtx: BotContextLike = {
      from: { id: 101, is_bot: false, first_name: "Tim" },
      chat: { id: 101, type: "private", first_name: "Tim" },
      message: {
        date: 1,
        message_id: 9,
        chat: { id: 101, type: "private", first_name: "Tim" },
        photo: [{ file_id: "file-1", file_unique_id: "u", width: 4, height: 4 }],
      } as Message,
      reply: async () => ({}),
      replyWithPhoto: async () => ({}),
      replyWithChatAction: async () => ({}),
      api: { getFile: async () => ({ file_path: "x" }) },
    };
    await handlePhotoMessage(photoCtx, deps2 as never);
    // The photo went through the pipeline, never through the quiz seam.
    expect(reviewTouched).toBe(false);
    expect(answered).toHaveLength(0);
    expect(ingested).toHaveLength(1);
  });
});

describe("review joins the known commands", () => {
  test("/review is a known command so the text handler leaves it alone", () => {
    expect(KNOWN_COMMANDS.has("/review")).toBe(true);
  });
});

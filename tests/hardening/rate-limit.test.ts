import { describe, expect, test } from "bun:test";
import { rateLimitReply } from "../../lib/telegram/replies";
import { handleDocumentMessage, handlePhotoMessage, handleTextMessage, handleVoiceMessage } from "../../lib/telegram/handlers";
import { makeCtx, makeDeps } from "./helpers";

const limited = {
  checkRateLimit: async () => ({ allowed: false as const, retryAfterSeconds: 60 }),
};

describe("rate limit gate on ingesting handlers", () => {
  test("a limited text message gets exactly one reply and no upload, download or AI call", async () => {
    const spy = makeCtx({ text: "quiz moved to fri", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps, uploads, downloads, ingests, finished, upserts } = makeDeps(limited);

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([rateLimitReply(60)]);
    expect(upserts).toHaveLength(1);
    expect(uploads).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(ingests).toHaveLength(0);
    expect(finished).toHaveLength(0);
  });

  test("the wait quoted in the reply is the retryAfter passed through", async () => {
    const spy = makeCtx({ text: "hi", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps } = makeDeps({
      checkRateLimit: async () => ({ allowed: false as const, retryAfterSeconds: 7 }),
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([rateLimitReply(7)]);
  });

  test("a limited photo is refused before any download", async () => {
    const spy = makeCtx({
      photo: [{ file_id: "photo-1", width: 100, height: 100 }],
      caption: null,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, uploads, downloads, ingests } = makeDeps(limited);

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([rateLimitReply(60)]);
    expect(downloads).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(ingests).toHaveLength(0);
  });

  test("a limited supported document is refused before any download", async () => {
    const spy = makeCtx({
      document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "brief.pdf" },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, uploads, downloads, ingests } = makeDeps(limited);

    await handleDocumentMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([rateLimitReply(60)]);
    expect(downloads).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(ingests).toHaveLength(0);
  });

  test("a limited voice note is refused before any download, conversion or transcription", async () => {
    const spy = makeCtx({
      voice: { file_id: "voice-1", duration: 4, mime_type: "audio/ogg" },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    let converted = 0;
    let transcribed = 0;
    const { deps, uploads, downloads, ingests, finished } = makeDeps({
      ...limited,
      fileBuffer: Buffer.from("ogg"),
      convertAudio: async (input) => {
        converted += 1;
        return { wav: Buffer.from(input), seconds: 1 };
      },
      transcribe: async () => {
        transcribed += 1;
        return { text: "hi", seconds: 1, costUsd: 0, latencyMs: 1 };
      },
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([rateLimitReply(60)]);
    expect(uploads).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(ingests).toHaveLength(0);
    expect(finished).toHaveLength(0);
    expect(converted).toBe(0);
    expect(transcribed).toBe(0);
  });

  test("an allowed message flows normally and the check ran once with the user's id", async () => {
    const spy = makeCtx({ text: "quiz moved to fri", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const checkedWith: string[] = [];
    const { deps, uploads, ingests } = makeDeps({
      checkRateLimit: async (userId) => {
        checkedWith.push(userId);
        return { allowed: true as const };
      },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(checkedWith).toEqual(["user-1"]);
    expect(uploads).toHaveLength(1);
    expect(ingests).toHaveLength(1);
    expect(spy.replies).toHaveLength(1);
  });

  test("a failing rate limit lookup fails open and the message is processed", async () => {
    const spy = makeCtx({ text: "quiz moved to fri", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps, uploads, ingests } = makeDeps({
      checkRateLimit: async () => {
        throw new Error("database is briefly unreachable");
      },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(uploads).toHaveLength(1);
    expect(ingests).toHaveLength(1);
    expect(spy.replies.map((r) => r.text)).toEqual(["Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)"]);
  });

  test("a failing rate limit reply never throws out of the handler", async () => {
    const spy = makeCtx({ text: "hi", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps, uploads } = makeDeps(limited);
    spy.ctx.reply = async () => {
      throw new Error("telegram send failed");
    };

    await expect(handleTextMessage(spy.ctx, deps)).resolves.toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  test("unknown commands stay exempt from the rate limit", async () => {
    const spy = makeCtx({ text: "/foo bar", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    let checks = 0;
    const { deps } = makeDeps({
      checkRateLimit: async () => {
        checks += 1;
        return { allowed: false as const, retryAfterSeconds: 60 };
      },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(checks).toBe(0);
    expect(spy.replies).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { Context, NextFunction } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import type { CreateUploadInput, FinishUploadPatch, UpsertUserInput } from "../../lib/db/queries";
import type { TaskRow, UploadRow, UserRow } from "../../lib/db/types";
import { BudgetExceededError } from "../../lib/meta/client";
import { FileTooLargeError } from "../../lib/telegram/files";
import {
  allowlistMiddleware,
  handleDocumentMessage,
  handleOtherMessage,
  handlePhotoMessage,
  handleTextMessage,
  type BotContextLike,
  type HandlerDeps,
} from "../../lib/telegram/handlers";
import {
  budgetReply,
  failureReply,
  fileTooLargeReply,
  mathPendingReply,
  pdfTruncatedNote,
  REFUSAL_TEXT,
  unknownCommandReply,
  unsupportedFileReply,
} from "../../lib/telegram/replies";

const NOW = new Date("2026-10-28T09:00:00+08:00");
const FAKE_TOKEN = "secret-bot-token";

const user: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  created_at: "2026-10-01T01:00:00.000Z",
};

const createdTask: TaskRow = {
  id: "task-1",
  user_id: "user-1",
  title: "CS2030 Lab 4",
  course: "CS2030",
  kind: "assignment",
  due_at: "2026-11-06T15:59:00.000Z",
  effort: "medium",
  status: "open",
  origin: "capture",
  source_upload_id: "upload-1",
  weak_spot_id: null,
  created_at: "2026-10-28T01:00:00.000Z",
  updated_at: "2026-10-28T01:00:00.000Z",
};

async function tinyJpeg(): Promise<Buffer> {
  return Buffer.from(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 30 } } })
      .jpeg()
      .toBuffer(),
  );
}

function makePdf(pageCount: number): Buffer {
  const pages: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    pages.push(`${i} 0 obj << /Type /Page /Parent 100 0 R >> endobj\n`);
  }
  const body =
    `%PDF-1.4\n${pages.join("")}` +
    `100 0 obj << /Type /Pages /Kids [] /Count ${pageCount} >> endobj\n` +
    `trailer << /Root 100 0 R >>\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

type CtxSpy = {
  ctx: BotContextLike;
  replies: Array<{ text: string; other?: { reply_markup?: unknown } }>;
  photos: Array<{ caption?: string; bytes: number; markup: unknown }>;
  typingCount: () => number;
};

function makeCtx(message: Record<string, unknown>): CtxSpy {
  const replies: Array<{ text: string; other?: { reply_markup?: unknown } }> = [];
  const photos: CtxSpy["photos"] = [];
  let typing = 0;
  const ctx: BotContextLike = {
    from: { id: 101, is_bot: false, first_name: "Tim" } as User,
    chat: { id: 101, type: "private", first_name: "Tim" } as Chat,
    message: message as unknown as Message,
    reply: async (text, other) => {
      replies.push({ text, other });
      return {};
    },
    replyWithPhoto: async (photo, other) => {
      // InputFile keeps the bytes in its (type-private) fileData field.
      const fileData = (photo as unknown as { fileData?: unknown }).fileData;
      photos.push({
        caption: other?.caption,
        bytes: fileData instanceof Uint8Array ? fileData.byteLength : 0,
        markup: other?.reply_markup,
      });
      return {};
    },
    replyWithChatAction: async () => {
      typing += 1;
      return true;
    },
    api: {
      getFile: async (fileId) => ({ file_path: `downloads/${fileId}`, file_size: 100 }),
    },
  };
  return { ctx, replies, photos, typingCount: () => typing };
}

type DepsSpy = {
  deps: HandlerDeps;
  uploads: CreateUploadInput[];
  finished: Array<{ id: string; patch: FinishUploadPatch }>;
  downloads: string[];
  originals: Array<{ userId: string; uploadId: string; mimeType: string; size: number }>;
  ingests: Array<Record<string, unknown>>;
  upserts: UpsertUserInput[];
};

function makeDeps(overrides: {
  fileBuffer?: Buffer;
  ingestOutcome?: Awaited<ReturnType<HandlerDeps["ingest"]>>;
  ingestError?: Error;
} = {}): DepsSpy {
  const uploads: CreateUploadInput[] = [];
  const finished: Array<{ id: string; patch: FinishUploadPatch }> = [];
  const downloads: string[] = [];
  const originals: DepsSpy["originals"] = [];
  const ingests: Array<Record<string, unknown>> = [];
  const upserts: UpsertUserInput[] = [];

  const deps: HandlerDeps = {
    upsertUser: async (i) => {
      upserts.push(i);
      return user;
    },
    createUpload: async (i) => {
      uploads.push(i);
      return {
        id: `upload-${uploads.length}`,
        user_id: i.userId,
        kind: i.kind,
        telegram_file_id: i.telegramFileId ?? null,
        mime_type: i.mimeType ?? null,
        storage_path: null,
        text_content: i.textContent ?? null,
        classified_as: null,
        status: "processing",
        error: null,
        created_at: NOW.toISOString(),
      } satisfies UploadRow;
    },
    finishUpload: async (id, patch) => {
      finished.push({ id, patch });
    },
    downloadTelegramFile: async (fileId) => {
      downloads.push(fileId);
      if (overrides.ingestError === undefined && overrides.fileBuffer === undefined) {
        throw new Error("no file buffer configured in test");
      }
      const buffer = overrides.fileBuffer ?? Buffer.alloc(0);
      return { buffer, filePath: `downloads/${fileId}`, sizeBytes: buffer.byteLength };
    },
    normalizeImage: async (buffer) => ({
      buffer,
      width: 8,
      height: 8,
      mimeType: "image/jpeg" as const,
    }),
    inspectPdf: (buffer) => {
      const pages = buffer.toString("latin1").match(/\/Type\s*\/Page\b/g);
      const pageCount = pages ? pages.length : null;
      return { pageCount, tooManyPages: pageCount !== null && pageCount > 50 };
    },
    uploadOriginal: async (args) => {
      originals.push({
        userId: args.userId,
        uploadId: args.uploadId,
        mimeType: args.mimeType,
        size: args.buffer.byteLength,
      });
      return `${args.userId}/${args.uploadId}/original.jpg`;
    },
    ingest: async (input) => {
      ingests.push(input as Record<string, unknown>);
      if (overrides.ingestError) throw overrides.ingestError;
      // The real ingestContent finishes the upload; the fake pipeline does the
      // same so handler-level tests can assert create-then-finish.
      finished.push({
        id: input.upload.id,
        patch: {
          status: "done",
          classifiedAs: "other",
          storagePath: input.storagePath ?? null,
        },
      });
      return (
        overrides.ingestOutcome ?? {
          kind: "tasks",
          result: { created: [createdTask], updated: [], completed: [], clarify: [] },
          clarification: null,
          inputKind: "plain_message",
          pdfTruncated: false,
          starter: null,
        }
      );
    },
    botToken: FAKE_TOKEN,
    appBaseUrl: "https://settle.example.com",
    now: () => NOW,
    typingIntervalMs: 5,
  };
  return { deps, uploads, finished, downloads, originals, ingests, upserts };
}

describe("text messages", () => {
  test("happy path: one reply, typing started and cleared, upload created then finished", async () => {
    const spy = makeCtx({ text: "prof say extend lab 4 to nxt fri liao", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps, uploads, finished, ingests, upserts } = makeDeps();

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toBe("Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)");
    const markup = spy.replies[0].other?.reply_markup as { inline_keyboard: Array<Array<{ text: string; url: string }>> };
    expect(markup.inline_keyboard[0][0]).toEqual({ text: "Open dashboard", url: "https://settle.example.com/dashboard" });

    expect(upserts).toEqual([{ telegramUserId: 101, telegramChatId: 101, firstName: "Tim" }]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      userId: "user-1",
      kind: "text",
      textContent: "prof say extend lab 4 to nxt fri liao",
      telegramFileId: null,
    });
    expect(ingests).toHaveLength(1);
    expect(ingests[0]).toMatchObject({ user, text: "prof say extend lab 4 to nxt fri liao" });
    expect(finished).toEqual([
      { id: "upload-1", patch: { status: "done", classifiedAs: "other", storagePath: null } },
    ]);

    // Typing ran at least once while working and stops once the handler ends.
    expect(spy.typingCount()).toBeGreaterThanOrEqual(1);
    const countAfter = spy.typingCount();
    await Bun.sleep(30);
    expect(spy.typingCount()).toBe(countAfter);
  });

  test("unknown /foo command gets a friendly nudge and nothing is stored", async () => {
    const spy = makeCtx({ text: "/foo bar", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps, uploads } = makeDeps();

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([unknownCommandReply()]);
    expect(uploads).toHaveLength(0);
  });

  test("known /start command is left to its own handler", async () => {
    const spy = makeCtx({ text: "/start", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps, uploads } = makeDeps();

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });
});

describe("photo messages", () => {
  test("largest photo wins, image is normalised, stored and passed to ingest with the caption", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx({
      photo: [
        { file_id: "photo-small", width: 320, height: 240 },
        { file_id: "photo-big", width: 1280, height: 960 },
      ],
      caption: "lab 4 extend to nxt fri",
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, uploads, downloads, originals, ingests, finished } = makeDeps({ fileBuffer: jpeg });

    await handlePhotoMessage(spy.ctx, deps);

    expect(downloads).toEqual(["photo-big"]);
    expect(uploads[0]).toMatchObject({ kind: "photo", telegramFileId: "photo-big", mimeType: "image/jpeg" });
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({ userId: "user-1", uploadId: "upload-1", mimeType: "image/jpeg" });
    const ingestInput = ingests[0] as { text: string | null; image: { base64: string; mimeType: string }; storagePath: string };
    expect(ingestInput.text).toBe("lab 4 extend to nxt fri");
    expect(ingestInput.image.mimeType).toBe("image/jpeg");
    expect(ingestInput.image.base64.length).toBeGreaterThan(0);
    expect(ingestInput.storagePath).toBe("user-1/upload-1/original.jpg");
    expect(finished[0].patch).toMatchObject({ status: "done", storagePath: "user-1/upload-1/original.jpg" });
  });
});

describe("document messages", () => {
  test("pdf: inspected, stored, ingested with base64 and filename", async () => {
    const pdf = makePdf(3);
    const spy = makeCtx({
      document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "brief.pdf" },
      caption: null,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, downloads, originals, ingests } = makeDeps({ fileBuffer: pdf });

    await handleDocumentMessage(spy.ctx, deps);

    expect(downloads).toEqual(["doc-1"]);
    expect(originals[0]).toMatchObject({ mimeType: "application/pdf", uploadId: "upload-1" });
    const ingestInput = ingests[0] as { pdf: { base64: string; filename: string; tooManyPages: boolean } };
    expect(ingestInput.pdf).toMatchObject({ filename: "brief.pdf", tooManyPages: false });
    expect(ingestInput.pdf.base64).toBe(pdf.toString("base64"));
    expect(spy.replies[0].text).toBe("Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)");
  });

  test("pdf over 50 pages adds the truncation note to the reply", async () => {
    const pdf = makePdf(60);
    const spy = makeCtx({
      document: { file_id: "doc-2", mime_type: "application/pdf", file_name: "slides.pdf" },
      caption: null,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, ingests } = makeDeps({ fileBuffer: pdf });

    await handleDocumentMessage(spy.ctx, deps);

    const ingestInput = ingests[0] as { pdf: { tooManyPages: boolean } };
    expect(ingestInput.pdf.tooManyPages).toBe(true);
    expect(spy.replies[0].text).toContain(pdfTruncatedNote());
  });

  test("unsupported mime: friendly reply, no download, no upload row", async () => {
    const spy = makeCtx({
      document: { file_id: "doc-3", mime_type: "application/zip", file_name: "notes.zip" },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, downloads, uploads } = makeDeps();

    await handleDocumentMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([unsupportedFileReply()]);
    expect(downloads).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  test("missing mime counts as unsupported", async () => {
    const spy = makeCtx({
      document: { file_id: "doc-4" },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps } = makeDeps();

    await handleDocumentMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([unsupportedFileReply()]);
  });
});

describe("error handling", () => {
  const baseMessage = {
    text: "hello",
    date: 1,
    chat: { id: 101, type: "private" },
    from: { id: 101, is_bot: false, first_name: "Tim" },
  };

  test("FileTooLargeError: file reply, upload marked failed", async () => {
    const spy = makeCtx({
      photo: [{ file_id: "photo-1", width: 100, height: 100 }],
      caption: null,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, finished } = makeDeps({ fileBuffer: Buffer.alloc(4) });
    deps.downloadTelegramFile = async () => {
      throw new FileTooLargeError("Telegram file is 999999999 bytes", {
        sizeBytes: 999999999,
        maxBytes: 20 * 1024 * 1024,
      });
    };

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([fileTooLargeReply()]);
    expect(finished).toHaveLength(1);
    expect(finished[0].patch.status).toBe("failed");
    expect(finished[0].patch.error).toContain("999999999");
  });

  test("BudgetExceededError: budget reply, upload marked failed", async () => {
    const spy = makeCtx(baseMessage);
    const { deps, finished } = makeDeps({ ingestError: new BudgetExceededError(12.5, 10) });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([budgetReply()]);
    expect(finished).toHaveLength(1);
    expect(finished[0].patch.status).toBe("failed");
  });

  test("generic error: failure reply, upload failed with a short message that never contains the bot token", async () => {
    const spy = makeCtx(baseMessage);
    const { deps, finished } = makeDeps({
      ingestError: new Error(`pipeline blew up near bot${FAKE_TOKEN} endpoint`),
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([failureReply()]);
    expect(finished).toHaveLength(1);
    expect(finished[0].patch.status).toBe("failed");
    expect(finished[0].patch.error).not.toContain(FAKE_TOKEN);
    expect(finished[0].patch.error!.length).toBeLessThanOrEqual(300);
  });

  test("a failing reply never throws out of the handler", async () => {
    const spy = makeCtx(baseMessage);
    const { deps } = makeDeps({ ingestError: new Error("boom") });
    spy.ctx.reply = async () => {
      throw new Error("telegram send failed");
    };

    await expect(handleTextMessage(spy.ctx, deps)).resolves.toBeUndefined();
  });

  test("very long error messages are truncated to 300 characters", async () => {
    const spy = makeCtx(baseMessage);
    const { deps, finished } = makeDeps({ ingestError: new Error("x".repeat(1000)) });

    await handleTextMessage(spy.ctx, deps);

    expect(finished[0].patch.error!.length).toBeLessThanOrEqual(300);
  });
});

describe("math pending and other message types", () => {
  test("the legacy math_pending outcome still gets the pending text", async () => {
    const spy = makeCtx({ text: "see my working", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps } = makeDeps({ ingestOutcome: { kind: "math_pending" } });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([mathPendingReply()]);
  });

  test("voice notes and stickers get the supported-types reply for now", async () => {
    const spy = makeCtx({
      voice: { file_id: "voice-1", duration: 3 },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });

    await handleOtherMessage(spy.ctx);

    expect(spy.replies.map((r) => r.text)).toEqual([unsupportedFileReply()]);
  });

  test("messages without a sender are ignored entirely", async () => {
    const ctx: BotContextLike = {
      chat: { id: -100, type: "channel" } as Chat,
      message: { text: "hi", date: 1, chat: { id: -100, type: "channel" } } as Message,
      reply: async () => ({}),
      replyWithPhoto: async () => ({}),
      replyWithChatAction: async () => ({}),
      api: { getFile: async () => ({}) },
    };
    const { deps, uploads } = makeDeps();

    await handleTextMessage(ctx, deps);

    expect(uploads).toHaveLength(0);
  });
});

describe("math diagnosis replies", () => {
  const photoMessage = {
    photo: [{ file_id: "photo-1", width: 100, height: 100 }],
    caption: null,
    date: 1,
    chat: { id: 101, type: "private" },
    from: { id: 101, is_bot: false, first_name: "Tim" },
  };

  test("wrong working: annotated photo goes out with the caption, then the practice message", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Step 2 is where it slipped: 5 - 2 is 3, not 2",
        annotated: Buffer.from("annotated-jpeg-bytes"),
        practiceText: "1 to try:\n1. 7 - 3 = ?\n\nAnswers:\n1. 4",
        extra: null,
      },
    });

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.photos).toHaveLength(1);
    expect(spy.photos[0].caption).toBe("Step 2 is where it slipped: 5 - 2 is 3, not 2");
    expect(spy.photos[0].bytes).toBe("annotated-jpeg-bytes".length);
    expect(spy.photos[0].markup).toBeUndefined();
    expect(spy.replies.map((r) => r.text)).toEqual(["1 to try:\n1. 7 - 3 = ?\n\nAnswers:\n1. 4"]);
    // The practice message carries no keyboard of its own.
    expect(spy.replies[0].other).toBeUndefined();
  });

  test("correct working: caption only, as a text reply, no photo", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Every step checks out. x = 3 is right.",
        annotated: null,
        practiceText: null,
        extra: null,
      },
    });

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.photos).toHaveLength(0);
    expect(spy.replies.map((r) => r.text)).toEqual(["Every step checks out. x = 3 is right."]);
  });

  test("an extra note from the weak-spot hook is appended after the caption and practice messages", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Every step checks out. x = 3 is right.",
        annotated: null,
        practiceText: "1 to try:\n1. 9 - 4 = ?",
        extra: "I will bring sign slips back for review.",
      },
    });

    await handlePhotoMessage(spy.ctx, deps);

    // No annotated photo, so the caption goes out as a normal text reply.
    expect(spy.replies.map((r) => r.text)).toEqual([
      "Every step checks out. x = 3 is right.",
      "1 to try:\n1. 9 - 4 = ?",
      "I will bring sign slips back for review.",
    ]);
  });

  test("a failed photo send falls back to the caption as text", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Step 1 is where it slipped: dropped a sign",
        annotated: Buffer.from("annotated-jpeg-bytes"),
        practiceText: null,
        extra: null,
      },
    });
    spy.ctx.replyWithPhoto = async () => {
      throw new Error("telegram photo send failed");
    };

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual(["Step 1 is where it slipped: dropped a sign"]);
  });
});

describe("quota refused math photo", () => {
  const photoMessage = {
    photo: [{ file_id: "photo-1", width: 100, height: 100 }],
    caption: null,
    date: 1,
    chat: { id: 101, type: "private" },
    from: { id: 101, is_bot: false, first_name: "Tim" },
  };

  test("the quota outcome sends one plain text reply, no photo and no keyboard", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const quotaText =
      "You've used your 3 free math checks for October. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan.";
    const { deps, finished } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: { kind: "quota", text: quotaText },
    });

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toBe(quotaText);
    expect(spy.replies[0].other).toBeUndefined(); // no dashboard keyboard gimmick
    expect(spy.photos).toHaveLength(0); // no annotated photo
    // The reply states the limit and points to the dashboard; it never sells.
    expect(quotaText.toLowerCase()).not.toMatch(/\b(buy|upgrade|subscribe|price|pricing|checkout)\b/);
    expect(quotaText).not.toContain("S$");
    assertNoDashes(quotaText);
    // The upload was still finished by the pipeline, not marked failed.
    expect(finished[0].patch.status).toBe("done");
  });
});

function assertNoDashes(text: string): void {
  expect(text.includes("\u2014")).toBe(false);
  expect(text.includes("\u2013")).toBe(false);
}

describe("allowlistMiddleware", () => {
  function fakeContext(fromId?: number, chatId?: number): Context {
    return {
      from: fromId === undefined ? undefined : ({ id: fromId, is_bot: false, first_name: "X" } as User),
      chat: chatId === undefined ? undefined : ({ id: chatId, type: "private" } as Chat),
    } as unknown as Context;
  }

  test("allowed sender passes through to next", async () => {
    const refusals: number[] = [];
    let nextCalls = 0;
    const next: NextFunction = async () => {
      nextCalls += 1;
    };
    const mw = allowlistMiddleware([101], async (chatId) => {
      refusals.push(chatId);
    });

    await mw(fakeContext(101, 101), next);

    expect(nextCalls).toBe(1);
    expect(refusals).toEqual([]);
  });

  test("stranger gets the refusal reply on their chat and never reaches handlers", async () => {
    const refusals: number[] = [];
    let nextCalls = 0;
    const next: NextFunction = async () => {
      nextCalls += 1;
    };
    const mw = allowlistMiddleware([101], async (chatId) => {
      refusals.push(chatId);
    });

    await mw(fakeContext(999, 999), next);

    expect(nextCalls).toBe(0);
    expect(refusals).toEqual([999]);
  });

  test("an update without a sender is silently ignored", async () => {
    const refusals: number[] = [];
    let nextCalls = 0;
    const next: NextFunction = async () => {
      nextCalls += 1;
    };
    const mw = allowlistMiddleware([101], async (chatId) => {
      refusals.push(chatId);
    });

    await mw(fakeContext(undefined, -100), next);

    expect(nextCalls).toBe(0);
    expect(refusals).toEqual([]);
  });

  test("the refusal text matches the webhook route's wording", () => {
    expect(REFUSAL_TEXT).toBe(
      "Hi! Settle is in private testing right now, so I can't help you yet. Come back soon.",
    );
  });
});

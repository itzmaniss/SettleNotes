import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { Context, NextFunction } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import type { CreateUploadInput, FinishUploadPatch, UpsertUserInput } from "../../lib/db/queries";
import type { TaskRow, UploadRow, UserRow } from "../../lib/db/types";
import { AudioConversionError } from "../../lib/media/audio";
import { BudgetExceededError } from "../../lib/meta/client";
import type { TranscribeArgs, TranscribeResult } from "../../lib/meta/transcribe";
import { createConversationMemory, type ConversationMemory } from "../../lib/pipeline/conversation";
import { FileTooLargeError } from "../../lib/telegram/files";
import {
  allowlistMiddleware,
  handleDocumentMessage,
  handleOtherMessage,
  handlePhotoMessage,
  handleTextMessage,
  handleVoiceMessage,
  replyParamsFor,
  type BotContextLike,
  type HandlerDeps,
} from "../../lib/telegram/handlers";
import {
  budgetReply,
  emptyTranscriptReply,
  failureReply,
  fileTooLargeReply,
  heardPrefix,
  mathPendingReply,
  nothingFoundReply,
  pdfTruncatedNote,
  rateLimitReply,
  REFUSAL_TEXT,
  unknownCommandReply,
  unsupportedFileReply,
  voiceTooLongReply,
} from "../../lib/telegram/replies";

const NOW = new Date("2026-10-28T09:00:00+08:00");
const FAKE_TOKEN = "secret-bot-token";

const user: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  terms_accepted_at: null,
  terms_version: null,
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
  replies: Array<{
    text: string;
    other?: { reply_markup?: unknown; reply_parameters?: unknown; parse_mode?: unknown };
  }>;
  photos: Array<{ caption?: string; bytes: number; markup: unknown; replyParams: unknown }>;
  typingCount: () => number;
};

function makeCtx(message: Record<string, unknown>): CtxSpy {
  const replies: Array<{
    text: string;
    other?: { reply_markup?: unknown; reply_parameters?: unknown; parse_mode?: unknown };
  }> = [];
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
        replyParams: other?.reply_parameters,
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
  convertAudio?: NonNullable<HandlerDeps["convertAudio"]>;
  transcribe?: NonNullable<HandlerDeps["transcribe"]>;
  listOpenTasks?: NonNullable<HandlerDeps["listOpenTasks"]>;
  conversation?: ConversationMemory;
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
    convertAudio:
      overrides.convertAudio ??
      (async () => ({ wav: Buffer.from("fake-wav"), seconds: 1 })),
    transcribe:
      overrides.transcribe ??
      (async (): Promise<TranscribeResult> => {
        throw new Error("no transcriber configured in test");
      }),
    listOpenTasks: overrides.listOpenTasks ?? (async () => []),
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
          pendingPrompts: [],
        }
      );
    },
    botToken: FAKE_TOKEN,
    appBaseUrl: "https://settle.example.com",
    now: () => NOW,
    typingIntervalMs: 5,
    ...(overrides.conversation ? { conversation: overrides.conversation } : {}),
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

  test("stored low-confidence actions become their own Yes/No messages after the summary", async () => {
    const UUID = "5b1f8a2e-9c3d-4e6f-8a7b-2c1d0e9f8a7b";
    const spy = makeCtx({ text: "got quiz 2 on tue maybe", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps } = makeDeps({
      ingestOutcome: {
        kind: "tasks",
        result: { created: [], updated: [], completed: [], clarify: [] },
        clarification: null,
        inputKind: "plain_message",
        pdfTruncated: false,
        starter: null,
        pendingPrompts: [
          { pendingId: UUID, text: 'I think this is a new task: "MA2001 Quiz 2". Add it?' },
        ],
      },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(2);
    expect(spy.replies[0].text).toBe("Your list is up to date.");
    expect(spy.replies[1].text).toBe('I think this is a new task: "MA2001 Quiz 2". Add it?');
    const markup = spy.replies[1].other?.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard[0].map((b) => b.text)).toEqual(["Yes", "No"]);
    expect(markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      `pa:y:${UUID}`,
      `pa:n:${UUID}`,
    ]);
  });

  test("a text-only clarify fallback keeps the unsure line and sends no prompt message", async () => {
    const spy = makeCtx({ text: "not sure what this is", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps } = makeDeps({
      ingestOutcome: {
        kind: "tasks",
        result: {
          created: [],
          updated: [],
          completed: [],
          clarify: [
            {
              type: "complete",
              taskId: null,
              title: null,
              course: null,
              kind: null,
              dueAt: null,
              effort: null,
              evidence: "done with the mystery thing",
              confidence: 0.3,
            },
          ],
        },
        clarification: null,
        inputKind: "plain_message",
        pdfTruncated: false,
        starter: null,
        pendingPrompts: [],
      },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toContain('I wasn\'t sure about "done with the mystery thing", could you confirm?');
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

  test("stickers still get the supported-types reply", async () => {
    const spy = makeCtx({
      sticker: { file_id: "sticker-1" },
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
    expect(spy.replies.map((r) => r.text)).toEqual([
      "1 to try:\n1. 7 - 3 = ?\n\n<tg-spoiler>Answers:\n1. 4</tg-spoiler>",
    ]);
    // The practice message hides the answers block behind a spoiler and
    // travels as escaped HTML, with no keyboard of its own.
    expect(spy.replies[0].other).toEqual({ parse_mode: "HTML" });
  });

  test("a rejected HTML practice send falls back to plain text, answers visible", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const practiceText = "1 to try:\n1. 7 - 3 = ?\n\nAnswers:\n1. 4";
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Step 2 is where it slipped: 5 - 2 is 3, not 2",
        annotated: null,
        practiceText,
        extra: null,
      },
    });
    // Telegram rejecting the HTML (a 400 parse error) on the first send.
    const realReply = spy.ctx.reply.bind(spy.ctx);
    spy.ctx.reply = async (text, other) => {
      if (other && "parse_mode" in other) {
        throw new Error("Bad Request: can't parse entities");
      }
      return realReply(text, other);
    };

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(2);
    // The same practice set, unescaped, answers visible, no parse mode.
    expect(spy.replies[1].text).toBe(practiceText);
    expect(spy.replies[1].other).toBeUndefined();
    expect(spy.replies[1].text).not.toContain("<tg-spoiler>");
  });

  test("the spoiler send keeps the reply linked to the student's message", async () => {
    const jpeg = await tinyJpeg();
    const linkedMessage = {
      message_id: 55,
      photo: [{ file_id: "photo-1", width: 100, height: 100 }],
      caption: null,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    };
    const spy = makeCtx(linkedMessage);
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Step 1 is where it slipped: dropped a sign",
        annotated: null,
        practiceText: "1 to try:\n1. 9 - 4 = ?\n\nAnswers:\n1. 5",
        extra: null,
      },
    });

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies[1].other).toEqual({
      reply_parameters: { message_id: 55, allow_sending_without_reply: true },
      parse_mode: "HTML",
    });
    expect(spy.replies[1].text).toContain("<tg-spoiler>Answers:\n1. 5</tg-spoiler>");
  });

  test("a practice set too long for one Telegram message goes out plain", async () => {
    const jpeg = await tinyJpeg();
    const spy = makeCtx(photoMessage);
    const longQuestion = "x".repeat(4100);
    const practiceText = `1 to try:\n1. Solve ${longQuestion}=0.\n\nAnswers:\n1. x=0.`;
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Every step checks out.",
        annotated: null,
        practiceText,
        extra: null,
      },
    });

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(2);
    expect(spy.replies[1].text).toBe(practiceText);
    expect(spy.replies[1].other).toBeUndefined();
    expect(spy.replies[1].text).not.toContain("<tg-spoiler>");
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

describe("voice notes", () => {
  const TRANSCRIPT = "prof say extend lab 4 to nxt fri liao";
  const LONG = "a".repeat(250);

  function voiceMessage(duration: number): Record<string, unknown> {
    return {
      voice: { file_id: "voice-1", duration, mime_type: "audio/ogg" },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    };
  }

  test("happy path: transcript runs through ingest as text, reply quotes what was heard", async () => {
    const spy = makeCtx(voiceMessage(4));
    let transcribeArgs: TranscribeArgs | undefined;
    const { deps, uploads, finished, downloads, ingests } = makeDeps({
      fileBuffer: Buffer.from("ogg-bytes"),
      convertAudio: async (input) => {
        expect(input.toString()).toBe("ogg-bytes");
        return { wav: Buffer.from("wav-bytes"), seconds: 3.7 };
      },
      transcribe: async (args) => {
        transcribeArgs = args;
        return { text: TRANSCRIPT, seconds: 3.7, costUsd: 0.000185, latencyMs: 40 };
      },
      listOpenTasks: async () => [createdTask],
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(downloads).toEqual(["voice-1"]);
    expect(uploads[0]).toMatchObject({
      kind: "voice",
      telegramFileId: "voice-1",
      mimeType: "audio/ogg",
      textContent: null,
    });
    expect(transcribeArgs).toMatchObject({ userId: "user-1", seconds: 3.7, keywords: ["CS2030"] });
    expect(Buffer.from(transcribeArgs!.wav).toString()).toBe("wav-bytes");

    expect(ingests).toHaveLength(1);
    const ingestInput = ingests[0] as { text?: string; image?: unknown; pdf?: unknown };
    expect(ingestInput.text).toBe(TRANSCRIPT);
    expect(ingestInput.image).toBeUndefined();
    expect(ingestInput.pdf).toBeUndefined();
    // Voice is understood on its own; it never reads or writes the memory.
    expect("recentExchange" in (ingests[0] as Record<string, unknown>)).toBe(false);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toBe(
      `${heardPrefix(TRANSCRIPT)}\n\nAdded 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)`,
    );

    // Ingest finished the row, then the handler stored the transcript on it.
    expect(finished).toHaveLength(2);
    expect(finished[1]).toEqual({ id: "upload-1", patch: { status: "done", textContent: TRANSCRIPT } });

    expect(spy.typingCount()).toBeGreaterThanOrEqual(1);
    const countAfter = spy.typingCount();
    await Bun.sleep(30);
    expect(spy.typingCount()).toBe(countAfter);
  });

  test("keywords come from the open tasks' course codes, nulls and duplicates skipped", async () => {
    const spy = makeCtx(voiceMessage(5));
    let keywords: string[] | undefined;
    const { deps } = makeDeps({
      fileBuffer: Buffer.from("ogg"),
      transcribe: async (args) => {
        keywords = args.keywords;
        return { text: "hi", seconds: 1, costUsd: 0.00005, latencyMs: 5 };
      },
      listOpenTasks: async () => [
        createdTask,
        { ...createdTask, id: "task-2", course: "MA2001" },
        { ...createdTask, id: "task-3", course: null },
        { ...createdTask, id: "task-4", course: "CS2030" },
      ],
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(keywords).toEqual(["CS2030", "MA2001"]);
  });

  test("over 3 minutes: refused before any download or upload row", async () => {
    const spy = makeCtx(voiceMessage(201));
    const { deps, downloads, uploads, finished } = makeDeps();

    await handleVoiceMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([voiceTooLongReply()]);
    expect(downloads).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(finished).toHaveLength(0);
  });

  test("exactly 180 seconds is still accepted", async () => {
    const spy = makeCtx(voiceMessage(180));
    const { deps, downloads } = makeDeps({
      fileBuffer: Buffer.from("ogg"),
      transcribe: async () => ({ text: "hi", seconds: 180, costUsd: 0.009, latencyMs: 10 }),
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(downloads).toEqual(["voice-1"]);
  });

  test("empty transcript: friendly retry reply, upload marked failed, ingest never runs", async () => {
    const spy = makeCtx(voiceMessage(4));
    const { deps, finished, ingests } = makeDeps({
      fileBuffer: Buffer.from("ogg"),
      transcribe: async () => ({ text: "   ", seconds: 2, costUsd: 0.0001, latencyMs: 10 }),
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([emptyTranscriptReply()]);
    expect(ingests).toHaveLength(0);
    expect(finished).toHaveLength(1);
    expect(finished[0].patch.status).toBe("failed");
    expect(finished[0].patch.error).toContain("empty");
  });

  test("budget exceeded on transcribe: budget reply, upload marked failed", async () => {
    const spy = makeCtx(voiceMessage(4));
    const { deps, finished } = makeDeps({
      fileBuffer: Buffer.from("ogg"),
      transcribe: async () => {
        throw new BudgetExceededError(12, 10);
      },
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([budgetReply()]);
    expect(finished[0].patch.status).toBe("failed");
  });

  test("conversion failure: failure reply, upload marked failed", async () => {
    const spy = makeCtx(voiceMessage(4));
    const { deps, finished } = makeDeps({
      fileBuffer: Buffer.from("ogg"),
      convertAudio: async () => {
        throw new AudioConversionError("audio conversion failed: unreadable");
      },
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([failureReply()]);
    expect(finished[0].patch.status).toBe("failed");
  });

  test("a failing reply never throws out of the voice handler", async () => {
    const spy = makeCtx(voiceMessage(4));
    const { deps } = makeDeps({ ingestError: new Error("boom") });
    spy.ctx.reply = async () => {
      throw new Error("telegram send failed");
    };

    await expect(handleVoiceMessage(spy.ctx, deps)).resolves.toBeUndefined();
  });

  test("audio attachments take the same flow as voice notes", async () => {
    const spy = makeCtx({
      audio: { file_id: "audio-1", duration: 6, mime_type: "audio/mpeg" },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    const { deps, uploads, downloads } = makeDeps({
      fileBuffer: Buffer.from("mp3-bytes"),
      transcribe: async () => ({ text: "quiz moved to wed", seconds: 6, costUsd: 0.0003, latencyMs: 12 }),
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(downloads).toEqual(["audio-1"]);
    expect(uploads[0]).toMatchObject({ kind: "voice", telegramFileId: "audio-1", mimeType: "audio/mpeg" });
    expect(spy.replies[0].text).toContain('I heard: "quiz moved to wed"');
  });

  test("a long transcript is quoted only up to 200 characters", async () => {
    const spy = makeCtx(voiceMessage(4));
    const { deps } = makeDeps({
      fileBuffer: Buffer.from("ogg"),
      transcribe: async () => ({ text: LONG, seconds: 10, costUsd: 0.0005, latencyMs: 10 }),
    });

    await handleVoiceMessage(spy.ctx, deps);

    expect(spy.replies[0].text.startsWith(heardPrefix(LONG))).toBe(true);
    expect(spy.replies[0].text).toContain(`"${"a".repeat(200)}..."`);
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

  test("a callback_query from an allowed user reaches the handlers", async () => {
    const refusals: number[] = [];
    let nextCalls = 0;
    const next: NextFunction = async () => {
      nextCalls += 1;
    };
    const mw = allowlistMiddleware([101], async (chatId) => {
      refusals.push(chatId);
    });
    const ctx = {
      from: { id: 101, is_bot: false, first_name: "Tim" } as User,
      chat: { id: 101, type: "private" } as Chat,
      callbackQuery: { data: `pa:y:${"5b1f8a2e-9c3d-4e6f-8a7b-2c1d0e9f8a7b"}` },
    } as unknown as Context;

    await mw(ctx, next);

    expect(nextCalls).toBe(1);
    expect(refusals).toEqual([]);
  });

  test("a stranger tapping a Yes/No button gets the refusal and never reaches the callback handler", async () => {
    const refusals: number[] = [];
    let nextCalls = 0;
    const next: NextFunction = async () => {
      nextCalls += 1;
    };
    const mw = allowlistMiddleware([101], async (chatId) => {
      refusals.push(chatId);
    });
    const ctx = {
      from: { id: 999, is_bot: false, first_name: "Stranger" } as User,
      chat: { id: 999, type: "private" } as Chat,
      callbackQuery: { data: `pa:y:${"5b1f8a2e-9c3d-4e6f-8a7b-2c1d0e9f8a7b"}` },
    } as unknown as Context;

    await mw(ctx, next);

    expect(nextCalls).toBe(0);
    expect(refusals).toEqual([999]);
  });

  test("the refusal text matches the webhook route's wording", () => {
    expect(REFUSAL_TEXT).toBe(
      "Hi! Settle is in private testing right now, so I can't help you yet. Come back soon.",
    );
  });
});

describe("replyParamsFor", () => {
  test("builds exactly the reply parameters for a message id", () => {
    expect(replyParamsFor({ message_id: 42 } as Message)).toEqual({
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
  });

  test("a missing message or message id falls back to a plain reply", () => {
    expect(replyParamsFor(undefined)).toBeUndefined();
    expect(replyParamsFor({} as Message)).toBeUndefined();
  });
});

describe("replies are visibly linked to the student's message", () => {
  function ctxWithId(message: Record<string, unknown>, id: number): CtxSpy {
    return makeCtx({ ...message, message_id: id, date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
  }

  const REPLY_PARAMS = (id: number) => ({ reply_parameters: { message_id: id, allow_sending_without_reply: true } });

  test("the task summary reply answers the message it came from", async () => {
    const spy = ctxWithId({ text: "prof say extend lab 4 to nxt fri liao" }, 55);
    const { deps } = makeDeps();

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies[0].other).toEqual({
      ...REPLY_PARAMS(55),
      reply_markup: spy.replies[0].other?.reply_markup,
    });
    expect(spy.replies[0].other?.reply_markup).toBeDefined();
  });

  test("the clarification question reply answers the message it came from", async () => {
    const spy = ctxWithId({ text: "not sure which one" }, 56);
    const { deps } = makeDeps({
      ingestOutcome: { kind: "nothing", clarification: "Which task do you mean?" },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toBe("Which task do you mean?");
    expect(spy.replies[0].other).toEqual({
      ...REPLY_PARAMS(56),
      reply_markup: spy.replies[0].other?.reply_markup,
    });
    expect(spy.replies[0].other?.reply_markup).toBeDefined();
  });

  test("the error reply answers the message it came from", async () => {
    const spy = ctxWithId({ text: "hello" }, 57);
    const { deps } = makeDeps({ ingestError: new Error("boom") });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([failureReply()]);
    expect(spy.replies[0].other).toEqual(REPLY_PARAMS(57));
  });

  test("the quota reply answers the message it came from", async () => {
    const jpeg = await tinyJpeg();
    const spy = ctxWithId(
      { photo: [{ file_id: "photo-1", width: 100, height: 100 }], caption: null },
      58,
    );
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: { kind: "quota", text: "quota text" },
    });

    await handlePhotoMessage(spy.ctx, deps);

    expect(spy.replies[0].text).toBe("quota text");
    expect(spy.replies[0].other).toEqual(REPLY_PARAMS(58));
  });

  test("the rate limit reply answers the message it came from", async () => {
    const spy = ctxWithId({ text: "hello" }, 59);
    const { deps } = makeDeps();
    deps.checkRateLimit = async () => ({ allowed: false, retryAfterSeconds: 30, window: "minute" });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies.map((r) => r.text)).toEqual([rateLimitReply(30)]);
    expect(spy.replies[0].other).toEqual(REPLY_PARAMS(59));
    expect(spy.replies[0].other?.reply_markup).toBeUndefined();
  });

  test("the annotated math photo answers the message it came from", async () => {
    const jpeg = await tinyJpeg();
    const spy = ctxWithId(
      { photo: [{ file_id: "photo-1", width: 100, height: 100 }], caption: null },
      60,
    );
    const { deps } = makeDeps({
      fileBuffer: jpeg,
      ingestOutcome: {
        kind: "math",
        caption: "Step 2 slipped",
        annotated: Buffer.from("annotated-jpeg-bytes"),
        practiceText: null,
        extra: null,
      },
    });

    await handlePhotoMessage(spy.ctx, deps);

    // replyParams holds the reply_parameters object itself.
    expect(spy.photos[0].replyParams).toEqual(REPLY_PARAMS(60).reply_parameters);
  });

  test("without a message id the reply stays plain, as before", async () => {
    const spy = makeCtx({ text: "hello", date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
    const { deps } = makeDeps({
      ingestOutcome: { kind: "nothing", clarification: "Which task do you mean?" },
    });

    await handleTextMessage(spy.ctx, deps);

    // No reply_parameters at all: the fallback keeps the plain reply.
    expect(spy.replies[0].other?.reply_parameters).toBeUndefined();
  });
});

describe("short term conversation memory", () => {
  function ctxWithMessage(message: Record<string, unknown>, id: number): CtxSpy {
    return makeCtx({ ...message, message_id: id, date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
  }

  const QUESTION = "What is the new due date for the MA2001 tutorial next week?";

  test("a follow up text is understood with the question it answers, keyed by internal user id", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const first = ctxWithMessage({ text: "nvm prof for 2001 say change tutorial to next week liao" }, 11);
    const d1 = makeDeps({ conversation: memory, ingestOutcome: { kind: "nothing", clarification: QUESTION } });
    await handleTextMessage(first.ctx, d1.deps);

    // Nothing was held yet, so the first message went in on its own.
    expect((d1.ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([]);

    const second = ctxWithMessage({ text: "tuesday also" }, 12);
    const d2 = makeDeps({ conversation: memory, ingestOutcome: { kind: "nothing", clarification: null } });
    await handleTextMessage(second.ctx, d2.deps);

    expect((d2.ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([
      { role: "student", text: "nvm prof for 2001 say change tutorial to next week liao" },
      { role: "settle", text: QUESTION },
    ]);
    // userKey is the internal user id, never the Telegram id.
    expect(memory.recent("user-1")).toEqual([
      { role: "student", text: "nvm prof for 2001 say change tutorial to next week liao" },
      { role: "settle", text: QUESTION },
      { role: "student", text: "tuesday also" },
    ]);
    expect(memory.recent("101")).toEqual([]);
  });

  test("photos and documents never read or write the memory", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const jpeg = await tinyJpeg();
    const photo = ctxWithMessage({
      photo: [{ file_id: "photo-1", width: 100, height: 100 }],
      caption: "extend lab 4 please",
    }, 13);
    const dPhoto = makeDeps({ fileBuffer: jpeg, conversation: memory });
    await handlePhotoMessage(photo.ctx, dPhoto.deps);

    expect("recentExchange" in (dPhoto.ingests[0] as Record<string, unknown>)).toBe(false);

    const pdf = makePdf(2);
    const doc = ctxWithMessage({
      document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "brief.pdf" },
      caption: null,
    }, 14);
    const dDoc = makeDeps({ fileBuffer: pdf, conversation: memory });
    await handleDocumentMessage(doc.ctx, dDoc.deps);

    expect("recentExchange" in (dDoc.ingests[0] as Record<string, unknown>)).toBe(false);
    expect(memory.recent("user-1")).toEqual([]);
  });
});

describe("answers to student questions", () => {
  function ctxAsking(question: string, id: number): CtxSpy {
    return makeCtx({ text: question, message_id: id, date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
  }
  const ANSWER = "I only moved the date; the 11pm time stayed the same.";

  test("an answer with no actions is sent instead of the nothing-found line", async () => {
    const spy = ctxAsking("why did you change the time?", 71);
    const { deps } = makeDeps({
      ingestOutcome: { kind: "nothing", clarification: null, answer: ANSWER },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toBe(ANSWER);
    expect(spy.replies[0].text).not.toBe(nothingFoundReply());
  });

  test("the answer goes out as a reply to the student's message", async () => {
    const spy = ctxAsking("why did you change the time?", 72);
    const { deps } = makeDeps({
      ingestOutcome: { kind: "nothing", clarification: null, answer: ANSWER },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies[0].other?.reply_parameters).toEqual({
      message_id: 72,
      allow_sending_without_reply: true,
    });
  });

  test("with real actions the normal summary is sent and any answer is ignored", async () => {
    const spy = ctxAsking("why did you change the time?", 73);
    const { deps } = makeDeps({
      ingestOutcome: {
        kind: "tasks",
        result: { created: [createdTask], updated: [], completed: [], clarify: [] },
        clarification: null,
        answer: ANSWER,
        inputKind: "plain_message",
        pdfTruncated: false,
        starter: null,
        pendingPrompts: [],
      },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(spy.replies).toHaveLength(1);
    expect(spy.replies[0].text).toBe("Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)");
    expect(spy.replies[0].text).not.toContain(ANSWER);
  });

  test("a blank answer falls back to the clarification, then the nothing-found line", async () => {
    const spyClarify = ctxAsking("why?", 74);
    const d1 = makeDeps({ ingestOutcome: { kind: "nothing", clarification: "Which task do you mean?", answer: "   " } });
    await handleTextMessage(spyClarify.ctx, d1.deps);
    expect(spyClarify.replies[0].text).toBe("Which task do you mean?");

    const spyNone = ctxAsking("why?", 75);
    const d2 = makeDeps({ ingestOutcome: { kind: "nothing", clarification: null, answer: "" } });
    await handleTextMessage(spyNone.ctx, d2.deps);
    expect(spyNone.replies[0].text).toBe(nothingFoundReply());
  });
});

describe("replies to Settle's own messages become context", () => {
  const BOT_ID = 424242;
  const CONFIRMATION = "Moved MA2001 tutorial to Tue 10 Nov, 11:59pm (was Tue 3 Nov, 11:00pm)";
  const QUESTION = "why did you change the time?";

  function ctxReplyingTo(repliedFromId: number | undefined, replied: Record<string, unknown>, id: number, opts: { me?: boolean } = {}): CtxSpy {
    const spy = makeCtx({
      text: QUESTION,
      message_id: id,
      reply_to_message: {
        message_id: 1,
        ...(repliedFromId === undefined ? {} : { from: { id: repliedFromId, is_bot: true, first_name: "Settle" } }),
        ...replied,
      },
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    });
    if (opts.me !== false) spy.ctx.me = { id: BOT_ID };
    return spy;
  }

  test("a reply to one of Settle's own messages joins as the last settle turn", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxReplyingTo(BOT_ID, { text: CONFIRMATION }, 76);
    const { deps, ingests } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: null },
    });

    await handleTextMessage(spy.ctx, deps);

    expect((ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([
      { role: "settle", text: CONFIRMATION },
    ]);
    // Context only: the replied-to line is never stored as its own memory turn.
    expect(memory.recent("user-1")).toEqual([{ role: "student", text: QUESTION }]);
  });

  test("a replied-to photo caption counts the same way", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxReplyingTo(BOT_ID, { caption: CONFIRMATION }, 77);
    const { deps, ingests } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: null },
    });

    await handleTextMessage(spy.ctx, deps);

    expect((ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([
      { role: "settle", text: CONFIRMATION },
    ]);
  });

  test("a reply to someone else's message is never used as context", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxReplyingTo(999, { text: "a stranger's message" }, 78);
    const { deps, ingests } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: null },
    });

    await handleTextMessage(spy.ctx, deps);

    expect((ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([]);
  });

  test("a reply whose bot sender is unknown to us is not used either", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxReplyingTo(BOT_ID, { text: CONFIRMATION }, 79, { me: false });
    const { deps, ingests } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: null },
    });

    await handleTextMessage(spy.ctx, deps);

    expect((ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([]);
  });

  test("the replied-to line is not appended twice when memory already ends with it", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    memory.remember("user-1", { role: "settle", text: CONFIRMATION });
    const spy = ctxReplyingTo(BOT_ID, { text: CONFIRMATION }, 80);
    const { deps, ingests } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: null },
    });

    await handleTextMessage(spy.ctx, deps);

    expect((ingests[0] as { recentExchange?: unknown }).recentExchange).toEqual([
      { role: "settle", text: CONFIRMATION },
    ]);
  });
});

describe("Settle's replies join the conversation memory", () => {
  function ctxSaying(text: string, id: number): CtxSpy {
    return makeCtx({ text, message_id: id, date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
  }

  test("after a successful change the confirmation line is remembered as a settle turn", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxSaying("prof changed 2001 tut to nex week liao", 81);
    const { deps } = makeDeps({ conversation: memory });

    await handleTextMessage(spy.ctx, deps);

    expect(memory.recent("user-1")).toEqual([
      { role: "student", text: "prof changed 2001 tut to nex week liao" },
      { role: "settle", text: "Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)" },
    ]);
  });

  test("a plain answer is remembered so a follow up question has material", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxSaying("why did you change the time?", 82);
    const { deps } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: "I only moved the date; the time stayed." },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(memory.recent("user-1")).toEqual([
      { role: "student", text: "why did you change the time?" },
      { role: "settle", text: "I only moved the date; the time stayed." },
    ]);
  });

  test("the generic nothing-found line carries no context and is not remembered", async () => {
    const memory = createConversationMemory({ now: () => 0 });
    const spy = ctxSaying("hehe nice one la", 83);
    const { deps } = makeDeps({
      conversation: memory,
      ingestOutcome: { kind: "nothing", clarification: null, answer: null },
    });

    await handleTextMessage(spy.ctx, deps);

    expect(memory.recent("user-1")).toEqual([{ role: "student", text: "hehe nice one la" }]);
  });
});

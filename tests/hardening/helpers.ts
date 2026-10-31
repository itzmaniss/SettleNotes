// Shared fake context and fake deps for the hardening behaviour tests, in the
// same style as tests/telegram/handlers.test.ts so the fakes stay familiar.
import type { Chat, Message, User } from "grammy/types";
import type { CreateUploadInput, FinishUploadPatch, UpsertUserInput } from "../../lib/db/queries";
import type { TaskRow, UploadRow, UserRow } from "../../lib/db/types";
import type { BotContextLike, HandlerDeps } from "../../lib/telegram/handlers";

export const NOW = new Date("2026-10-28T09:00:00+08:00");
export const FAKE_TOKEN = "secret-bot-token";

export const testUser: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  created_at: "2026-10-01T01:00:00.000Z",
};

let taskSeq = 0;

export function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  taskSeq += 1;
  return {
    id: `task-${taskSeq}`,
    user_id: "user-1",
    title: `Task ${taskSeq}`,
    course: null,
    kind: "other",
    due_at: null,
    effort: null,
    status: "open",
    origin: "capture",
    source_upload_id: null,
    weak_spot_id: null,
    created_at: "2026-10-28T01:00:00.000Z",
    updated_at: "2026-10-28T01:00:00.000Z",
    ...overrides,
  };
}

export const createdTask: TaskRow = makeTask({
  id: "task-1",
  title: "CS2030 Lab 4",
  course: "CS2030",
  kind: "assignment",
  due_at: "2026-11-06T15:59:00.000Z",
  effort: "medium",
});

export type CtxSpy = {
  ctx: BotContextLike;
  replies: Array<{ text: string; other?: { reply_markup?: unknown } }>;
  photos: Array<{ caption?: string; bytes: number; markup: unknown }>;
  typingCount: () => number;
};

export function makeCtx(message: Record<string, unknown>): CtxSpy {
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

export type DepsSpy = {
  deps: HandlerDeps;
  uploads: CreateUploadInput[];
  finished: Array<{ id: string; patch: FinishUploadPatch }>;
  downloads: string[];
  originals: Array<{ userId: string; uploadId: string; mimeType: string; size: number }>;
  ingests: Array<Record<string, unknown>>;
  upserts: UpsertUserInput[];
};

export function makeDeps(
  overrides: Partial<HandlerDeps> & { fileBuffer?: Buffer; ingestError?: Error } = {},
): DepsSpy {
  const uploads: CreateUploadInput[] = [];
  const finished: Array<{ id: string; patch: FinishUploadPatch }> = [];
  const downloads: string[] = [];
  const originals: DepsSpy["originals"] = [];
  const ingests: Array<Record<string, unknown>> = [];
  const upserts: UpsertUserInput[] = [];
  const fileBuffer = overrides.fileBuffer;
  const ingestError = overrides.ingestError;
  delete overrides.fileBuffer;
  delete overrides.ingestError;

  const deps: HandlerDeps = {
    upsertUser: async (i) => {
      upserts.push(i);
      return testUser;
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
      if (fileBuffer === undefined) {
        throw new Error("no file buffer configured in test");
      }
      return { buffer: fileBuffer, filePath: `downloads/${fileId}`, sizeBytes: fileBuffer.byteLength };
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
    convertAudio: async (input) => ({ wav: Buffer.from(input), seconds: 1 }),
    transcribe: async () => {
      throw new Error("no transcriber configured in test");
    },
    listOpenTasks: async () => [],
    ingest: async (input) => {
      ingests.push(input as Record<string, unknown>);
      if (ingestError) throw ingestError;
      // The real ingestContent finishes the upload; the fake pipeline does the
      // same so handler-level tests can assert create-then-finish.
      finished.push({
        id: input.upload.id,
        patch: { status: "done", classifiedAs: "other", storagePath: input.storagePath ?? null },
      });
      return {
        kind: "tasks",
        result: { created: [createdTask], updated: [], completed: [], clarify: [] },
        clarification: null,
        inputKind: "plain_message",
        pdfTruncated: false,
        starter: null,
      };
    },
    botToken: FAKE_TOKEN,
    appBaseUrl: "https://settle.example.com",
    now: () => NOW,
    typingIntervalMs: 5,
    ...overrides,
  };
  return { deps, uploads, finished, downloads, originals, ingests, upserts };
}

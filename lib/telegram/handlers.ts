import "server-only";
import { InputFile, type Bot, type Context, type NextFunction } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import { createUpload, finishUpload, upsertUser } from "@/lib/db/queries";
import type {
  CreateUploadInput,
  FinishUploadPatch,
  UpsertUserInput,
} from "@/lib/db/queries";
import type { UploadKind, UploadRow, UserRow } from "@/lib/db/types";
import { env } from "@/lib/env";
import { BudgetExceededError } from "@/lib/meta/client";
import { inspectPdf, isSupportedMime, normalizeImage, UnsupportedMimeError } from "@/lib/media/normalize";
import { uploadOriginal } from "@/lib/media/storage";
import { createIngestDeps, ingestContent } from "@/lib/pipeline/ingest";
import type { IngestInput, IngestOutcome } from "@/lib/pipeline/ingest";
import { isAllowedUser } from "@/lib/telegram/guards";
import { downloadTelegramFile, FileTooLargeError, type FileFetchDeps } from "@/lib/telegram/files";
import {
  budgetReply,
  dashboardKeyboard,
  failureReply,
  fileTooLargeReply,
  mathPendingReply,
  nothingFoundReply,
  pdfTruncatedNote,
  summaryReply,
  unknownCommandReply,
  unsupportedFileReply,
} from "@/lib/telegram/replies";

// Minimal structural view of a grammY context, so handler tests can pass tiny
// fakes instead of building a real Bot.
export type BotContextLike = {
  from?: User;
  chat?: Chat;
  message?: Message;
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  replyWithPhoto: (
    photo: InputFile,
    other?: { caption?: string; reply_markup?: unknown },
  ) => Promise<unknown>;
  replyWithChatAction: (action: string) => Promise<unknown>;
  api: { getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }> };
};

export type HandlerDeps = {
  upsertUser: (i: UpsertUserInput) => Promise<UserRow>;
  createUpload: (i: CreateUploadInput) => Promise<UploadRow>;
  finishUpload: (id: string, patch: FinishUploadPatch) => Promise<void>;
  downloadTelegramFile: typeof downloadTelegramFile;
  normalizeImage: typeof normalizeImage;
  inspectPdf: typeof inspectPdf;
  uploadOriginal: typeof uploadOriginal;
  ingest: (input: IngestInput) => Promise<IngestOutcome>;
  botToken: string;
  appBaseUrl: string;
  now?: () => Date;
  typingIntervalMs?: number;
};

export function createHandlerDeps(): HandlerDeps {
  const deps: HandlerDeps = {
    upsertUser,
    createUpload,
    finishUpload,
    downloadTelegramFile,
    normalizeImage,
    inspectPdf,
    uploadOriginal,
    // Read at call time, never at import time.
    ingest: (input) => ingestContent(createIngestDeps(deps.now ? { now: deps.now } : {}), input),
    get botToken() {
      return env.TELEGRAM_BOT_TOKEN;
    },
    get appBaseUrl() {
      return env.APP_BASE_URL;
    },
  };
  return deps;
}

export const KNOWN_COMMANDS = new Set(["/start", "/help", "/dashboard"]);
const DEFAULT_TYPING_INTERVAL_MS = 4_000;
const MAX_STORED_ERROR_LENGTH = 300;

type MessageSpec = {
  kind: UploadKind;
  text: string | null;
  file?: { fileId: string; mimeType: string | null; filename: string | null };
};

export function registerIngestHandlers(bot: Bot, deps: HandlerDeps = createHandlerDeps()): void {
  bot.on("message:text", (ctx) => handleTextMessage(ctx as unknown as BotContextLike, deps));
  bot.on("message:photo", (ctx) => handlePhotoMessage(ctx as unknown as BotContextLike, deps));
  bot.on("message:document", (ctx) => handleDocumentMessage(ctx as unknown as BotContextLike, deps));
  // Voice, sticker, video and anything else we cannot read yet.
  bot.on("message", (ctx) => handleOtherMessage(ctx as unknown as BotContextLike));
}

export async function handleTextMessage(ctx: BotContextLike, deps: HandlerDeps): Promise<void> {
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) {
    const command = text.slice(1).split(/[\s@]/)[0] ?? "";
    if (KNOWN_COMMANDS.has(`/${command}`)) return; // /start and /help run earlier in the chain
    await replySafely(ctx, unknownCommandReply());
    return;
  }
  await processMessage(ctx, deps, { kind: "text", text });
}

export async function handlePhotoMessage(ctx: BotContextLike, deps: HandlerDeps): Promise<void> {
  const photo = ctx.message?.photo;
  if (!photo || photo.length === 0) {
    await replySafely(ctx, failureReply());
    return;
  }
  const largest = photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  await processMessage(ctx, deps, {
    kind: "photo",
    text: ctx.message?.caption ?? null,
    file: { fileId: largest.file_id, mimeType: "image/jpeg", filename: null },
  });
}

export async function handleDocumentMessage(ctx: BotContextLike, deps: HandlerDeps): Promise<void> {
  const document = ctx.message?.document;
  if (!document) {
    await replySafely(ctx, failureReply());
    return;
  }
  const mime = document.mime_type ?? null;
  if (mime == null || !isSupportedMime(mime)) {
    // Nothing to download, store or spend credits on.
    await replySafely(ctx, unsupportedFileReply());
    return;
  }
  await processMessage(ctx, deps, {
    kind: "document",
    text: ctx.message?.caption ?? null,
    file: { fileId: document.file_id, mimeType: mime, filename: document.file_name ?? null },
  });
}

export async function handleOtherMessage(ctx: BotContextLike): Promise<void> {
  if (ctx.from === undefined) return;
  await replySafely(ctx, unsupportedFileReply());
}

async function processMessage(ctx: BotContextLike, deps: HandlerDeps, spec: MessageSpec): Promise<void> {
  if (ctx.from === undefined) return;

  let upload: UploadRow | undefined;
  // The interval is injectable so tests never wait for a real tick.
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  try {
    try {
      await ctx.replyWithChatAction("typing");
    } catch {
      // The typing indicator is best effort; the real work matters more.
    }
    typingTimer = setInterval(() => {
      void ctx.replyWithChatAction("typing").catch(() => {});
    }, deps.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS);

    const user = await deps.upsertUser({
      telegramUserId: ctx.from.id,
      telegramChatId: ctx.chat?.id ?? ctx.from.id,
      firstName: ctx.from.first_name ?? null,
    });

    const createInput: CreateUploadInput = {
      userId: user.id,
      kind: spec.kind,
      telegramFileId: spec.file?.fileId ?? null,
      mimeType: spec.file?.mimeType ?? null,
      textContent: spec.text,
    };
    upload = await deps.createUpload(createInput);

    let ingestInput: IngestInput;
    if (spec.file) {
      const { buffer } = await deps.downloadTelegramFile(spec.file.fileId, {
        getFile: (fileId) => ctx.api.getFile(fileId),
        botToken: deps.botToken,
      } satisfies FileFetchDeps);

      if (spec.file.mimeType === "application/pdf") {
        const { tooManyPages } = deps.inspectPdf(buffer);
        const storagePath = await deps.uploadOriginal({
          userId: user.id,
          uploadId: upload.id,
          buffer,
          mimeType: "application/pdf",
        });
        ingestInput = {
          user,
          upload,
          text: spec.text,
          pdf: {
            base64: buffer.toString("base64"),
            filename: spec.file.filename ?? "document.pdf",
            tooManyPages,
          },
          storagePath,
        };
      } else {
        const normalized = await deps.normalizeImage(buffer);
        const storagePath = await deps.uploadOriginal({
          userId: user.id,
          uploadId: upload.id,
          buffer: normalized.buffer,
          mimeType: normalized.mimeType,
        });
        ingestInput = {
          user,
          upload,
          text: spec.text,
          image: {
            base64: normalized.buffer.toString("base64"),
            mimeType: normalized.mimeType,
          },
          // Same bytes with their size, for the math annotator.
          imageMeta: { buffer: normalized.buffer, width: normalized.width, height: normalized.height },
          storagePath,
        };
      }
    } else {
      ingestInput = { user, upload, text: spec.text };
    }

    const outcome = await deps.ingest(ingestInput);

    if (outcome.kind === "math") {
      await sendMathOutcome(ctx, outcome, deps.botToken);
      return;
    }
    if (outcome.kind === "quota") {
      // Refused math photo: the quota text on its own, no photo, no keyboard.
      await replySafely(ctx, outcome.text);
      return;
    }

    let text: string;
    if (outcome.kind === "tasks") {
      text = summaryReply(outcome);
    } else if (outcome.kind === "nothing") {
      text = outcome.clarification ?? nothingFoundReply();
    } else {
      // Legacy pending outcome; the default flow diagnoses math inline now.
      text = mathPendingReply();
    }
    if (ingestInput.pdf?.tooManyPages) {
      text = `${text}\n\n${pdfTruncatedNote()}`;
    }

    const keyboard = dashboardKeyboard(deps.appBaseUrl);
    await replySafely(ctx, text, keyboard ? { reply_markup: keyboard } : undefined);
  } catch (error) {
    if (upload !== undefined) {
      try {
        await deps.finishUpload(upload.id, {
          status: "failed",
          error: shortError(error, deps.botToken),
        });
      } catch (finishError) {
        console.error("[telegram] failed to mark upload failed:", messageOf(finishError, deps.botToken));
      }
    }
    console.error("[telegram] message processing failed:", messageOf(error, deps.botToken));
    await replySafely(ctx, failureTextFor(error));
  } finally {
    if (typingTimer !== undefined) clearInterval(typingTimer);
  }
}

// Math reply: the annotated photo (or the caption as text when there is
// nothing to circle), then the practice questions, then any extra note from
// the weak-spot hook. A failed photo send falls back to the caption as text
// so the student still gets the diagnosis.
async function sendMathOutcome(
  ctx: BotContextLike,
  outcome: Extract<IngestOutcome, { kind: "math" }>,
  botToken: string,
): Promise<void> {
  if (outcome.annotated != null) {
    try {
      await ctx.replyWithPhoto(new InputFile(outcome.annotated), { caption: outcome.caption });
    } catch (error) {
      console.error("[telegram] photo reply failed:", messageOf(error, botToken));
      await replySafely(ctx, outcome.caption);
    }
  } else {
    await replySafely(ctx, outcome.caption);
  }
  if (outcome.practiceText != null) await replySafely(ctx, outcome.practiceText);
  if (outcome.extra != null) await replySafely(ctx, outcome.extra);
}

async function replySafely(
  ctx: BotContextLike,
  text: string,
  other?: { reply_markup?: unknown },
): Promise<void> {
  try {
    await ctx.reply(text, other);
  } catch (error) {
    // A failed reply must never bubble into after() or polling.
    console.error("[telegram] reply failed:", error instanceof Error ? error.message : String(error));
  }
}

function failureTextFor(error: unknown): string {
  if (error instanceof FileTooLargeError) return fileTooLargeReply();
  if (error instanceof UnsupportedMimeError) return unsupportedFileReply();
  if (error instanceof BudgetExceededError) return budgetReply();
  return failureReply();
}

function messageOf(error: unknown, botToken: string): string {
  let msg = error instanceof Error ? error.message : String(error);
  if (botToken.length > 0) msg = msg.split(botToken).join("[redacted]");
  return msg;
}

// Stored error stays short, human-readable and free of secrets (no stacks,
// no tokens, no env values).
function shortError(error: unknown, botToken: string): string {
  const msg = messageOf(error, botToken);
  return msg.length > MAX_STORED_ERROR_LENGTH
    ? `${msg.slice(0, MAX_STORED_ERROR_LENGTH - 3)}...`
    : msg;
}

/**
 * First middleware on the bot: anyone outside ALLOWED_TELEGRAM_IDS gets the
 * refusal reply once and never reaches the handlers. Needed because
 * scripts/poll.ts runs this bot without the webhook route's guards, and any
 * stranger finding the dev bot could otherwise spend Meta credits.
 */
export function allowlistMiddleware(
  allowed: number[],
  refuse: (chatId: number) => Promise<unknown>,
) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const senderId = ctx.from?.id;
    if (senderId === undefined) return; // no sender to allowlist: ignore
    if (isAllowedUser(senderId, allowed)) return next();
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) await refuse(chatId);
  };
}

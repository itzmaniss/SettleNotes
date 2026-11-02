import "server-only";
import { InputFile, type Bot, type Context, type NextFunction } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import { createUpload, finishUpload, listOpenTasks, upsertUser } from "@/lib/db/queries";
import type {
  CreateUploadInput,
  FinishUploadPatch,
  UpsertUserInput,
} from "@/lib/db/queries";
import type { TaskRow, UploadKind, UploadRow, UserRow } from "@/lib/db/types";
import { env } from "@/lib/env";
import { BudgetExceededError, MetaApiError, MetaTimeoutError } from "@/lib/meta/client";
import { AudioTooLongError, convertToWav16kMono, isVoiceTooLong } from "@/lib/media/audio";
import {
  courseKeywords,
  createRealTranscriber,
  type TranscribeArgs,
  type TranscribeResult,
  type Transcriber,
} from "@/lib/meta/transcribe";
import { inspectPdf, isSupportedMime, InvalidPdfError, normalizeImage, UnsupportedMimeError } from "@/lib/media/normalize";
import { uploadOriginal } from "@/lib/media/storage";
import { conversationMemory, type ConversationMemory } from "@/lib/pipeline/conversation";
import { createIngestDeps, ingestContent } from "@/lib/pipeline/ingest";
import type { IngestInput, IngestOutcome, PendingPrompt } from "@/lib/pipeline/ingest";
import { isAccessAllowed, type AccessPolicy } from "@/lib/telegram/access";
import {
  countRecentUploads,
  createRateLimiter,
  type RateLimitCheck,
} from "@/lib/telegram/limits";
import { downloadTelegramFile, FileTooLargeError, type FileFetchDeps } from "@/lib/telegram/files";
import {
  budgetReply,
  dailyCapReply,
  dashboardKeyboard,
  emptyTranscriptReply,
  failureReply,
  aiBusyReply,
  fileTooLargeReply,
  heardPrefix,
  mathPendingReply,
  nothingFoundReply,
  pendingActionKeyboard,
  pdfTruncatedNote,
  pdfUnreadableReply,
  rateLimitReply,
  summaryReply,
  unknownCommandReply,
  unsupportedFileReply,
  voiceTooLongReply,
} from "@/lib/telegram/replies";

// Minimal structural view of a grammY context, so handler tests can pass tiny
// fakes instead of building a real Bot.
export type BotContextLike = {
  from?: User;
  chat?: Chat;
  message?: Message;
  reply: (
    text: string,
    other?: { reply_markup?: unknown; reply_parameters?: unknown },
  ) => Promise<unknown>;
  replyWithPhoto: (
    photo: InputFile,
    other?: { caption?: string; reply_markup?: unknown; reply_parameters?: unknown },
  ) => Promise<unknown>;
  replyWithChatAction: (action: string) => Promise<unknown>;
  api: { getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }> };
};

// The parameters that make a send visually answer an incoming message.
// allow_sending_without_reply keeps the reply working when the student has
// already deleted the original message. No message (or one without an id)
// returns undefined, meaning: send a plain reply.
export function replyParamsFor(
  message?: Pick<Message, "message_id">,
): { reply_parameters: { message_id: number; allow_sending_without_reply: true } } | undefined {
  const id = message?.message_id;
  return typeof id === "number" && Number.isInteger(id)
    ? { reply_parameters: { message_id: id, allow_sending_without_reply: true } }
    : undefined;
}

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
  // Voice note path, all optional with lazy real defaults so tests can inject
  // fakes and non-voice handlers never touch audio or the transcriber.
  convertAudio?: (input: Buffer) => Promise<{ wav: Buffer; seconds: number }>;
  transcribe?: (args: TranscribeArgs) => Promise<TranscribeResult>;
  listOpenTasks?: (userId: string) => Promise<TaskRow[]>;
  now?: () => Date;
  typingIntervalMs?: number;
  // Per-user upload rate limit (uploads table backed). Optional so tests and
  // command handlers can omit it; the real one is built lazily in
  // createHandlerDeps and fails open when its lookup throws.
  checkRateLimit?: RateLimitCheck;
  // Short term conversation memory. Optional so tests can inject a fresh one;
  // defaults to the module level instance (in memory only, never persisted).
  conversation?: ConversationMemory;
};

export function createHandlerDeps(): HandlerDeps {
  let realTranscriber: Transcriber | undefined;
  let rateLimiter: ReturnType<typeof createRateLimiter> | undefined;
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
    convertAudio: (input) => convertToWav16kMono(input),
    listOpenTasks,
    get transcribe() {
      // Built once and resolved at call time so importing handlers.ts never
      // reads env or opens the DB.
      realTranscriber ??= createRealTranscriber();
      const transcriber = realTranscriber;
      return (args: TranscribeArgs) => transcriber.transcribe(args);
    },
    get checkRateLimit(): RateLimitCheck {
      const limiter = (rateLimiter ??= createRateLimiter({
        countRecentUploads,
        ...(deps.now ? { now: deps.now } : {}),
      }));
      return (userId) => limiter.check(userId);
    },
  };
  return deps;
}

export const KNOWN_COMMANDS = new Set([
  "/start",
  "/help",
  "/dashboard",
  "/tasks",
  "/done",
  "/pro",
  "/paysupport",
]);
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
  // Voice notes and audio files share the transcribe flow. Registered before
  // the catch-all so they never land in handleOtherMessage.
  bot.on("message:voice", (ctx) => handleVoiceMessage(ctx as unknown as BotContextLike, deps));
  bot.on("message:audio", (ctx) => handleVoiceMessage(ctx as unknown as BotContextLike, deps));
  // Voice, sticker, video and anything else we cannot read yet.
  bot.on("message", (ctx) => handleOtherMessage(ctx as unknown as BotContextLike));
}

export async function handleTextMessage(ctx: BotContextLike, deps: HandlerDeps): Promise<void> {
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) {
    const command = text.slice(1).split(/[\s@]/)[0] ?? "";
    // Commands run in their own handlers earlier in the chain; seeing one here
    // means it was already answered (or is /tasks or /done), so stay quiet.
    if (KNOWN_COMMANDS.has(`/${command}`)) return;
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

// Voice notes and audio files: transcribe first, then the transcript runs
// through the same ingest flow as a text message. Not gated by the usage
// ledger. Same guarantees as processMessage: typing while working, the upload
// row is marked failed on any error, replies never throw out of the handler.
export async function handleVoiceMessage(ctx: BotContextLike, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const voice = ctx.message?.voice ?? ctx.message?.audio;
  if (voice == null) {
    await replySafely(ctx, failureReply());
    return;
  }
  // Telegram reports the duration up front, so refuse before any download.
  if (isVoiceTooLong(voice.duration)) {
    await replySafely(ctx, voiceTooLongReply());
    return;
  }

  const convert = deps.convertAudio ?? ((input: Buffer) => convertToWav16kMono(input));
  const transcribe = deps.transcribe ?? createRealTranscriber().transcribe;
  const listOpen = deps.listOpenTasks ?? listOpenTasks;

  let upload: UploadRow | undefined;
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
    if (!(await passRateLimit(ctx, deps, user.id))) return;

    upload = await deps.createUpload({
      userId: user.id,
      kind: "voice",
      telegramFileId: voice.file_id,
      mimeType: voice.mime_type ?? null,
      textContent: null,
    });

    const { buffer } = await deps.downloadTelegramFile(voice.file_id, {
      getFile: (fileId) => ctx.api.getFile(fileId),
      botToken: deps.botToken,
    } satisfies FileFetchDeps);

    // Course codes from the student's open tasks bias the transcriber toward
    // the words it is most likely to mishear.
    const keywords = courseKeywords(await listOpen(user.id));
    const { wav, seconds } = await convert(buffer);
    const { text: transcript } = await transcribe({ userId: user.id, wav, seconds, keywords });

    const heard = transcript.trim();
    if (heard.length === 0) {
      await deps.finishUpload(upload.id, {
        status: "failed",
        error: "voice transcript was empty",
      });
      await replySafely(ctx, emptyTranscriptReply());
      return;
    }

    const outcome = await deps.ingest({ user, upload, text: transcript });

    // Store what was heard on the upload row. Ingest has already finished the
    // row as done, so this is a small best effort follow-up write; a failure
    // here must not fail a capture that succeeded.
    try {
      await deps.finishUpload(upload.id, { status: "done", textContent: heard });
    } catch (error) {
      console.error("[telegram] failed to store voice transcript:", messageOf(error, deps.botToken));
    }

    if (outcome.kind === "math") {
      await sendMathOutcome(ctx, { ...outcome, caption: withHeard(heard, outcome.caption) }, deps.botToken);
      return;
    }
    if (outcome.kind === "quota") {
      await replySafely(ctx, withHeard(heard, outcome.text));
      return;
    }

    let text: string;
    if (outcome.kind === "tasks") {
      text = summaryReply(outcome);
    } else if (outcome.kind === "nothing") {
      text = outcome.clarification ?? nothingFoundReply();
    } else {
      text = mathPendingReply();
    }
    const keyboard = dashboardKeyboard(deps.appBaseUrl);
    await replySafely(ctx, withHeard(heard, text), keyboard ? { reply_markup: keyboard } : undefined);
    if (outcome.kind === "tasks") await sendPendingPrompts(ctx, outcome.pendingPrompts);
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
    console.error("[telegram] voice message processing failed:", messageOf(error, deps.botToken));
    await replySafely(ctx, failureTextFor(error));
  } finally {
    if (typingTimer !== undefined) clearInterval(typingTimer);
  }
}

function withHeard(heard: string, text: string): string {
  return `${heardPrefix(heard)}\n\n${text}`;
}

export async function handleOtherMessage(ctx: BotContextLike): Promise<void> {
  if (ctx.from === undefined) return;
  await replySafely(ctx, unsupportedFileReply());
}

// Rate limit gate for every ingesting message type. Runs after the user row
// is upserted (the counter needs its id) and BEFORE the upload row, any
// download and any AI call. Limited => one friendly reply, nothing stored.
// A failing lookup fails open: log one line, never throw, let it through.
async function passRateLimit(ctx: BotContextLike, deps: HandlerDeps, userId: string): Promise<boolean> {
  const check = deps.checkRateLimit;
  if (check === undefined) return true;
  try {
    const verdict = await check(userId);
    if (verdict.allowed) return true;
    // Minute limit gets the short retry line, the daily cap the pause-for-
    // today one. Fail open exactly like the minute check on lookup errors.
    await replySafely(
      ctx,
      verdict.window === "day" ? dailyCapReply() : rateLimitReply(verdict.retryAfterSeconds),
    );
    return false;
  } catch (error) {
    console.error(
      "[telegram] rate limit lookup failed, letting the message through:",
      messageOf(error, deps.botToken),
    );
    return true;
  }
}

async function processMessage(ctx: BotContextLike, deps: HandlerDeps, spec: MessageSpec): Promise<void> {
  if (ctx.from === undefined) return;

  const memory = deps.conversation ?? conversationMemory;
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

    if (!(await passRateLimit(ctx, deps, user.id))) return;

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
      // Text messages continue an ongoing conversation: hand the model the
      // last few turns so a follow up like "tuesday also" is read together
      // with the question it answers. Photos, documents and voice transcripts
      // are understood on their own and never touch the memory.
      ingestInput = {
        user,
        upload,
        text: spec.text,
        recentExchange: memory.recent(user.id),
      };
    }

    const outcome = await deps.ingest(ingestInput);

    if (spec.kind === "text") {
      // Understanding is done, so this exchange joins the short term memory:
      // what the student said, then the question Settle asked back, if any.
      const said = (spec.text ?? "").trim();
      if (said.length > 0) memory.remember(user.id, { role: "student", text: said });
      if (
        (outcome.kind === "tasks" || outcome.kind === "nothing") &&
        outcome.clarification != null
      ) {
        memory.remember(user.id, { role: "settle", text: outcome.clarification });
      }
    }

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
    // Clarification buttons come after the summary so the list stays readable.
    if (outcome.kind === "tasks") await sendPendingPrompts(ctx, outcome.pendingPrompts);
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
      // The annotated photo is the direct answer to the math photo sent in.
      await ctx.replyWithPhoto(new InputFile(outcome.annotated), {
        caption: outcome.caption,
        ...replyParamsFor(ctx.message),
      });
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
  // One funnel for every answer to an incoming message, so each send is
  // linked to the message it replies to. Other stays undefined (not an empty
  // object) when there is nothing to attach, which some replies assert on.
  const options = { ...replyParamsFor(ctx.message), ...other };
  const hasOptions = Object.keys(options).length > 0;
  try {
    await ctx.reply(text, hasOptions ? options : undefined);
  } catch (error) {
    // A failed reply must never bubble into after() or polling.
    console.error("[telegram] reply failed:", error instanceof Error ? error.message : String(error));
  }
}

// One message per stored low-confidence action, each with its own Yes/No
// keyboard. A failed send only loses that one prompt; the row expires unused.
async function sendPendingPrompts(ctx: BotContextLike, prompts: PendingPrompt[]): Promise<void> {
  for (const prompt of prompts) {
    await replySafely(ctx, prompt.text, { reply_markup: pendingActionKeyboard(prompt.pendingId) });
  }
}

function failureTextFor(error: unknown): string {
  if (error instanceof FileTooLargeError) return fileTooLargeReply();
  if (error instanceof UnsupportedMimeError) return unsupportedFileReply();
  if (error instanceof InvalidPdfError) return pdfUnreadableReply();
  if (error instanceof BudgetExceededError) return budgetReply();
  if (error instanceof MetaTimeoutError || error instanceof MetaApiError) return aiBusyReply();
  // Only ever raised on the voice path, where the student-facing copy fits.
  if (error instanceof AudioTooLongError) return voiceTooLongReply();
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
 * First middleware on the bot: anyone the access policy refuses gets the
 * refusal reply once and never reaches the handlers. Needed because
 * scripts/poll.ts runs this bot without the webhook route's guards, and any
 * stranger finding the dev bot could otherwise spend Meta credits. The policy
 * comes from lib/telegram/access.getAccessPolicy (a bare id list is also
 * accepted), so flipping ALLOWLIST_ENABLED changes polling and the webhook
 * the same way.
 *
 * answerPreCheckout (optional) covers the payment case: a pre_checkout_query
 * has no chat to refuse in, and leaving it unanswered would hang the payer's
 * checkout for ten seconds before Telegram fails it, so a stranger's query is
 * answered false with a friendly message instead.
 */
export function allowlistMiddleware(
  access: AccessPolicy | number[],
  refuse: (chatId: number) => Promise<unknown>,
  answerPreCheckout?: (queryId: string) => Promise<unknown>,
) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const senderId = ctx.from?.id;
    if (senderId === undefined) return; // no sender to allowlist: ignore
    if (isAccessAllowed(senderId, access)) return next();
    if (ctx.preCheckoutQuery !== undefined) {
      if (answerPreCheckout !== undefined) await answerPreCheckout(ctx.preCheckoutQuery.id);
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) await refuse(chatId);
  };
}

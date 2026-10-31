import { describe, expect, test } from "bun:test";
import { InvalidImageError, InvalidPdfError } from "../../lib/media/normalize";
import { BudgetExceededError, MetaApiError, MetaTimeoutError } from "../../lib/meta/client";
import * as replies from "../../lib/telegram/replies";
import { handleDocumentMessage, handlePhotoMessage, handleTextMessage } from "../../lib/telegram/handlers";
import { FAKE_TOKEN, makeCtx, makeDeps } from "./helpers";

const sender = { chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } };
const photoMsg = () => makeCtx({ photo: [{ file_id: "p1", width: 100, height: 100 }], caption: null, date: 1, ...sender });
const textMsg = () => makeCtx({ text: "lab moved to fri", date: 1, ...sender });
const pdfMsg = () =>
  makeCtx({ document: { file_id: "d1", mime_type: "application/pdf", file_name: "brief.pdf" }, date: 1, ...sender });

describe("error paths reach the student as friendly copy and mark the upload failed", () => {
  test("a garbled image asks for a clearer photo, stores nothing else, never reaches the pipeline", async () => {
    const spy = photoMsg();
    const { deps, ingests, finished } = makeDeps({
      fileBuffer: Buffer.from("not an image"),
      normalizeImage: async () => {
        throw new InvalidImageError("could not decode image");
      },
    });
    await handlePhotoMessage(spy.ctx, deps);
    expect(spy.replies.map((r) => r.text)).toEqual([replies.failureReply()]);
    expect(replies.failureReply()).toContain("clearer photo");
    expect(ingests).toHaveLength(0);
    expect(finished).toHaveLength(1);
    expect(finished[0].patch.status).toBe("failed");
  });

  test("an unreadable or password protected PDF gets its own friendly reply", async () => {
    const spy = pdfMsg();
    const { deps, ingests, finished } = makeDeps({
      fileBuffer: Buffer.from("%PDF-garbage"),
      inspectPdf: () => {
        throw new InvalidPdfError("encrypted");
      },
    });
    await handleDocumentMessage(spy.ctx, deps);
    expect(spy.replies.map((r) => r.text)).toEqual([replies.pdfUnreadableReply()]);
    expect(ingests).toHaveLength(0);
    expect(finished[0].patch.status).toBe("failed");
  });

  test("a Meta timeout does not blame the student's file", async () => {
    const spy = textMsg();
    const { deps, finished } = makeDeps({ ingestError: new MetaTimeoutError(60000) });
    await handleTextMessage(spy.ctx, deps);
    expect(spy.replies.map((r) => r.text)).toEqual([replies.aiBusyReply()]);
    expect(spy.replies[0].text).not.toContain("clearer");
    expect(finished[0].patch.status).toBe("failed");
  });

  test("a Meta API error gets the same trouble-on-my-side reply", async () => {
    const spy = textMsg();
    const { deps } = makeDeps({ ingestError: new MetaApiError(503, "upstream down") });
    await handleTextMessage(spy.ctx, deps);
    expect(spy.replies.map((r) => r.text)).toEqual([replies.aiBusyReply()]);
  });

  test("budget exceeded gets the daily limit reply", async () => {
    const spy = textMsg();
    const { deps } = makeDeps({ ingestError: new BudgetExceededError(5, 5) });
    await handleTextMessage(spy.ctx, deps);
    expect(spy.replies.map((r) => r.text)).toEqual([replies.budgetReply()]);
  });

  test("an unknown crash gets the generic reply and the stored error never contains the bot token", async () => {
    const spy = textMsg();
    const { deps, finished } = makeDeps({ ingestError: new Error(`boom at https://api.telegram.org/bot${FAKE_TOKEN}/getFile`) });
    await handleTextMessage(spy.ctx, deps);
    expect(spy.replies.map((r) => r.text)).toEqual([replies.failureReply()]);
    expect(JSON.stringify(finished[0].patch)).not.toContain(FAKE_TOKEN);
  });

  test("a failing reply is never rethrown on the error paths", async () => {
    const spy = textMsg();
    spy.ctx.reply = async () => {
      throw new Error("telegram down");
    };
    const { deps } = makeDeps({ ingestError: new MetaTimeoutError(1000) });
    await expect(handleTextMessage(spy.ctx, deps)).resolves.toBeUndefined();
  });
});

// Every fixed reply a student can see. Functions that take arguments are
// called with plain sample values.
const SAMPLES: Record<string, string> = {
  rateLimitReply: replies.rateLimitReply(60),
  tasksEmptyReply: replies.tasksEmptyReply(),
  tasksMoreLine: replies.tasksMoreLine(2),
  tasksNextHint: replies.tasksNextHint(),
  tasksListLine: replies.tasksListLine(1, { title: "CS2030 Lab 4", due_at: "2026-11-06T15:59:00.000Z" }, new Date("2026-10-28T01:00:00Z")),
  noUserYetReply: replies.noUserYetReply(),
  doneMissingReply: replies.doneMissingReply(),
  doneOutOfRangeReply1: replies.doneOutOfRangeReply(1),
  doneOutOfRangeReply3: replies.doneOutOfRangeReply(3),
  doneSuccessReply: replies.doneSuccessReply({ title: "Lab", dueAt: null }, { title: "Quiz", dueAt: "2026-11-06T15:59:00.000Z" }),
  pdfUnreadableReply: replies.pdfUnreadableReply(),
  commandFailedReply: replies.commandFailedReply(),
  failureReply: replies.failureReply(),
  aiBusyReply: replies.aiBusyReply(),
  budgetReply: replies.budgetReply(),
  fileTooLargeReply: replies.fileTooLargeReply(),
  unsupportedFileReply: replies.unsupportedFileReply(),
  unknownCommandReply: replies.unknownCommandReply(),
  nothingFoundReply: replies.nothingFoundReply(),
  mathPendingReply: replies.mathPendingReply(),
  voiceTooLongReply: replies.voiceTooLongReply(),
  emptyTranscriptReply: replies.emptyTranscriptReply(),
  pdfTruncatedNote: replies.pdfTruncatedNote(),
  REFUSAL_TEXT: replies.REFUSAL_TEXT,
};

// Words that mean something to engineers but not to a student on Telegram.
const JARGON = /\b(api|timeout|timed out|schema|model|token|json|exception|stack|http|rate limit|quota exceeded|null|undefined)\b/i;

describe("tone scan over every fixed student-facing reply", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    test(`${name}: no em or en dashes, no engineer jargon, not empty`, () => {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[\u2014\u2013]/);
      expect(text).not.toMatch(JARGON);
    });
  }
});

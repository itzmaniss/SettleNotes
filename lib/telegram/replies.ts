// All student-facing reply copy. Pure functions, no I/O, and plain Telegram
// text (no parse_mode), so nothing ever needs escaping. No em or en dashes
// anywhere in this file: students read every string here.
import { InlineKeyboard } from "grammy";
import { RATE_LIMIT } from "@/lib/telegram/limits";
import { REFUND_WINDOW_DAYS } from "@/lib/billing/stars";
import type { PendingActionKind } from "@/lib/clarify/types";
import type { ExecuteResult } from "@/lib/pipeline/execute";
import type { StarterReplyInfo } from "@/lib/pipeline/starters";

export const REFUSAL_TEXT =
  "Hi! Settle is in private testing right now, so I can't help you yet. Come back soon.";

const SG_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** 'Fri 6 Nov, 11:59pm' in Singapore time, or 'no deadline'. */
export function formatDue(iso: string | null): string {
  if (iso == null) return "no deadline";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "no deadline";
  const shifted = new Date(t.getTime() + SG_OFFSET_MS);
  const hours = shifted.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const ampm = hours < 12 ? "am" : "pm";
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]}, ${hour12}:${minutes}${ampm}`;
}

export type SummaryOutcome = {
  result: ExecuteResult;
  clarification: string | null;
  starter?: StarterReplyInfo | null;
};

// The "I also made ..." line appended to a capture summary: one line for a
// made starter, one plain sentence for a starter that failed, and the quota
// text verbatim for a starter the usage gate refused. Null means say
// nothing extra.
export function starterLine(starter: StarterReplyInfo | null | undefined): string | null {
  if (starter == null) return null;
  if (starter.status === "blocked") {
    // Fully worded by lib/billing/copy.ts, which guarantees the no-selling
    // rules; pass it through untouched.
    return starter.text;
  }
  if (starter.status === "failed") {
    switch (starter.reason) {
      case "empty_checklist":
        return "I couldn't find a list of requirements in that PDF.";
      case "no_study_material":
        return "That PDF didn't look like study material, so I skipped the flashcards.";
      case "too_thin":
        return "There wasn't enough on those slides for a full set of flashcards.";
      default:
        return "I added the task but couldn't build the extra help this time. Try sending the file again.";
    }
  }
  if (starter.type === "checklist") {
    const things = starter.count === 1 ? "thing" : "things";
    return `I also made a checklist of ${starter.count} ${things} to hand in. Tick them off on your dashboard.`;
  }
  const cards = `${starter.count} ${starter.count === 1 ? "flashcard" : "flashcards"}`;
  const questions =
    starter.secondaryCount === 1 ? "practice question" : "practice questions";
  return `I also made ${cards} and ${starter.secondaryCount} ${questions} from your slides.`;
}

export function summaryReply(outcome: SummaryOutcome): string {
  const { created, updated, completed, clarify } = outcome.result;
  const lines: string[] = [];

  if (created.length === 1) {
    lines.push("Added 1 task:");
  } else if (created.length > 1) {
    lines.push(`Added ${created.length} tasks:`);
  }
  for (const task of created) {
    lines.push(task.due_at == null ? `- ${task.title}` : `- ${task.title} (due ${formatDue(task.due_at)})`);
  }

  for (const change of updated) {
    if (change.after.dueAt !== undefined) {
      const was = change.before.dueAt == null ? null : change.before.dueAt;
      lines.push(`Moved ${change.task.title} to ${formatDue(change.after.dueAt ?? null)} (was ${formatDue(was)})`);
    } else {
      lines.push(`Updated ${change.task.title}.`);
    }
  }

  if (completed.length === 1) {
    lines.push(`Ticked off: ${completed[0].title}`);
  } else if (completed.length > 1) {
    lines.push("Ticked off:");
    for (const task of completed) lines.push(`- ${task.title}`);
  }

  for (const action of clarify) {
    const what = (action.title ?? action.evidence).trim() || "that one";
    lines.push(`I wasn't sure about "${what}", could you confirm?`);
  }

  if (outcome.clarification) {
    lines.push(outcome.clarification);
  }

  const starter = starterLine(outcome.starter);
  if (starter != null) {
    lines.push(starter);
  }

  return lines.length > 0 ? lines.join("\n") : "Your list is up to date.";
}

export function nothingFoundReply(): string {
  return "I read that, but I could not find any tasks in it. Send me something with a deadline and I will add it for you.";
}

export function mathPendingReply(): string {
  return "That looks like math working. Checking it is almost ready, so hang tight.";
}

export function failureReply(): string {
  return "Sorry, I couldn't read that one. Could you send a clearer photo or the PDF instead?";
}

// The AI service being slow or down is not the student's fault, so this one
// does not ask them to resend a better file.
export function aiBusyReply(): string {
  return "I'm having trouble on my side right now. Please send that again in a minute.";
}

export function budgetReply(): string {
  return "My daily reading limit is used up, so I cannot process this one right now. Please try again tomorrow.";
}

export function fileTooLargeReply(): string {
  return "That file is over 20 MB, which is too big for me to download. Try sending a smaller file, or split it into a few photos.";
}

export function unsupportedFileReply(): string {
  return "I can read text messages, photos (JPG, PNG or WebP) and PDF files for now. That file type is not something I can open yet.";
}

export function unknownCommandReply(): string {
  return "I do not know that command yet. Send /help to see what I can do.";
}

export function pdfTruncatedNote(): string {
  return "Note: that PDF has more than 50 pages, so I only read the first 50.";
}

export function voiceTooLongReply(): string {
  return "That voice note is a bit long for me. Could you send one under 3 minutes?";
}

export function emptyTranscriptReply(): string {
  return "I couldn't hear anything in that voice note. Could you try again a bit closer to the mic?";
}

const HEARD_PREFIX_MAX_CHARS = 200;

// Quotes back what Settle heard, trimmed so the quote stays short. The voice
// handler joins this with a blank line and the normal reply text.
export function heardPrefix(transcript: string): string {
  const heard = transcript.trim();
  const quoted =
    heard.length > HEARD_PREFIX_MAX_CHARS ? `${heard.slice(0, HEARD_PREFIX_MAX_CHARS)}...` : heard;
  return `I heard: "${quoted}"`;
}

// Rate limit: the cap number comes from the shared constant so the copy can
// never drift from the enforcement in limits.ts. The wait is rounded up to
// whole seconds, singular or plural.
export function rateLimitReply(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const wait = seconds === 1 ? "1 second" : `${seconds} seconds`;
  return `I can only take about ${RATE_LIMIT.max} things a minute, so give me ${wait} and send that again.`;
}

// Daily cap: no numbers on purpose. The cap lives in limits.ts, and what the
// student needs to know is that the day is done and nothing was lost.
export function dailyCapReply(): string {
  return "That is a lot for one day, so I am pausing for today. Everything you have sent is saved. Try again tomorrow.";
}

export function tasksEmptyReply(): string {
  return "You have nothing open. Nice.";
}

export function tasksMoreLine(hidden: number): string {
  return `+${hidden} more on your dashboard`;
}

export function tasksNextHint(): string {
  return "Reply /done 1 to tick off the first one.";
}

// One numbered /tasks line. No deadline means no due part at all; an overdue
// deadline gets a plain marker word inside the brackets.
export function tasksListLine(
  index: number,
  task: { title: string; due_at: string | null },
  now: Date,
): string {
  const due = formatDue(task.due_at);
  if (due === "no deadline") return `${index}. ${task.title}`;
  const overdue = Date.parse(task.due_at ?? "") < now.getTime();
  return `${index}. ${task.title} (due ${due}${overdue ? ", overdue" : ""})`;
}

export function noUserYetReply(): string {
  return "Send me something first and I will start your list.";
}

export function doneMissingReply(): string {
  return "Tell me which one, like /done 1. Send /tasks to see the numbers.";
}

export function doneOutOfRangeReply(count: number): string {
  const noun = count === 1 ? "task" : "tasks";
  const pronoun = count === 1 ? "it" : "them";
  return `I only have ${count} open ${noun} right now. Send /tasks to see ${pronoun}.`;
}

export function doneSuccessReply(
  done: { title: string; dueAt: string | null },
  next: { title: string; dueAt: string | null } | null,
): string {
  const lines = [`Ticked off: ${done.title}`];
  if (next != null) {
    const due = formatDue(next.dueAt);
    lines.push(due === "no deadline" ? `Next up: ${next.title}` : `Next up: ${next.title} (due ${due})`);
  }
  return lines.join("\n");
}

export function pdfUnreadableReply(): string {
  return "I couldn't open that PDF. It may need a password or the file may be damaged. Try saving a fresh copy and sending that instead.";
}

export function commandFailedReply(): string {
  return "Sorry, something went wrong on my side. Please try that again in a moment.";
}

const DASHBOARD_PATH = "/dashboard";

/**
 * 'Open dashboard' URL button, but only for URLs Telegram accepts (https and
 * not loopback, otherwise the whole reply send would fail). Undefined means
 * the caller should send the reply without a keyboard.
 */
export function dashboardKeyboard(appBaseUrl: string): InlineKeyboard | undefined {
  let base: URL;
  try {
    base = new URL(appBaseUrl);
  } catch {
    return undefined;
  }
  const hostname = base.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (base.protocol !== "https:" || LOOPBACK_HOSTS.has(hostname)) return undefined;
  const url = `${base.href.replace(/\/+$/, "")}${DASHBOARD_PATH}`;
  return new InlineKeyboard().url("Open dashboard", url);
}

// ---- Pro subscription (Telegram Stars) -------------------------------------
// Telegram policy: inside the bot, Stars is the only purchase path we may
// talk about. These strings never mention the website, Stripe, discounts or
// fiat prices, and the only number in the /pro offer is the Stars amount
// handed in by the caller, which comes from PLANS.pro.price.stars.

export function proNotOnSaleReply(): string {
  return "Pro is not on sale yet. I will let you know when it is.";
}

export function proInvoiceReply(starsPerMonth: number): string {
  return `Pro is ${starsPerMonth} Stars a month for unlimited math checks, brief checklists and flashcards. Tap the button below to pay.`;
}

export function proInvoiceKeyboard(invoiceUrl: string): InlineKeyboard {
  return new InlineKeyboard().url("Pay with Stars", invoiceUrl);
}

export function proActivatedReply(currentPeriodEnd: Date): string {
  return `Pro is on. It runs until ${formatDue(currentPeriodEnd.toISOString())}. Thanks for backing Settle.`;
}

export function proActiveReply(currentPeriodEnd: Date | null): string {
  const until =
    currentPeriodEnd == null ? "" : ` It runs until ${formatDue(currentPeriodEnd.toISOString())}.`;
  return `Pro is already on.${until} Thanks for backing Settle!`;
}

const PAY_SUPPORT_TEMPLATE =
  "Need help with a payment? Message the person who runs this bot and include your Telegram username and what went wrong. Refunds for the first {days} days are given on request.";

export function paySupportReply(): string {
  return PAY_SUPPORT_TEMPLATE.replace("{days}", String(REFUND_WINDOW_DAYS));
}

// Shown when a pre-checkout cannot even be checked (internal error) or when
// a payer outside the allowlist tries to buy: always with the reassurance
// that nothing was charged.
export const PRE_CHECKOUT_CLOSED_REPLY =
  "Settle is in private testing right now, so checkout is not open. Come back soon.";

export function preCheckoutErrorReply(): string {
  return "I could not check this purchase in time, so it was stopped. You have not been charged. Please send /pro again in a moment.";
}

// ---- Low-confidence clarifications: one prompt message with Yes/No buttons,
// backed by a pending_actions row (migration 0003).

// Telegram caps callback data at 64 bytes; the pattern also keeps taps on
// other bots' buttons (same chat, different data) from reaching the flow.
export const PENDING_CALLBACK_DATA_PATTERN = /^pa:(y|n):([0-9a-f-]{36})$/;

export function pendingActionCallbackData(pendingId: string, yes: boolean): string {
  return `pa:${yes ? "y" : "n"}:${pendingId}`;
}

export function pendingActionKeyboard(pendingId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Yes", pendingActionCallbackData(pendingId, true))
    .text("No", pendingActionCallbackData(pendingId, false));
}

// Telegram keeps a message's old keyboard when an edit omits reply_markup;
// an empty button matrix is how it actually goes away. The default
// constructor would still carry one empty row.
export function clearedKeyboard(): InlineKeyboard {
  return new InlineKeyboard([]);
}

export function createClarifyPrompt(title: string, dueAt: string | null): string {
  if (dueAt == null) return `I think this is a new task: "${title}". Add it?`;
  return `I think this is a new task: "${title}", due ${formatDue(dueAt)}. Add it?`;
}

export function updateDueClarifyPrompt(taskTitle: string, newDueAt: string): string {
  return `Should I move "${taskTitle}" to ${formatDue(newDueAt)}?`;
}

export function updateClarifyPrompt(taskTitle: string): string {
  return `Should I update "${taskTitle}"?`;
}

export function completeClarifyPrompt(taskTitle: string): string {
  return `Did you finish "${taskTitle}"?`;
}

export function pendingExpiredReply(): string {
  return "That one has expired. Send it to me again if you still need it.";
}

export function pendingHandledReply(): string {
  return "Already handled.";
}

export function pendingDismissedReply(): string {
  return "Okay, I left it alone.";
}

export function pendingTaskChangedReply(): string {
  return "That task has changed, so I did nothing.";
}

// The tap-time confirmation, in the same wording style as summaryReply.
// Empty result lists (should not happen) fall back to the generic line so a
// broken apply never confirms a write that did not land.
export function pendingAppliedReply(
  kind: PendingActionKind,
  result: Pick<ExecuteResult, "created" | "updated" | "completed">,
): string {
  if (kind === "create") {
    const task = result.created[0];
    if (task == null) return commandFailedReply();
    return task.due_at == null
      ? `Added: ${task.title}`
      : `Added: ${task.title} (due ${formatDue(task.due_at)})`;
  }
  if (kind === "complete") {
    const task = result.completed[0];
    if (task == null) return commandFailedReply();
    return `Ticked off: ${task.title}`;
  }
  const change = result.updated[0];
  if (change == null) return commandFailedReply();
  if (change.after.dueAt !== undefined) {
    const was = change.before.dueAt ?? null;
    return `Moved ${change.task.title} to ${formatDue(change.after.dueAt ?? null)} (was ${formatDue(was)})`;
  }
  return `Updated ${change.task.title}.`;
}

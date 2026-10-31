// All student-facing reply copy. Pure functions, no I/O, and plain Telegram
// text (no parse_mode), so nothing ever needs escaping. No em or en dashes
// anywhere in this file: students read every string here.
import { InlineKeyboard } from "grammy";
import { RATE_LIMIT } from "@/lib/telegram/limits";
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

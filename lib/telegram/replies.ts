// All student-facing reply copy. Pure functions, no I/O, and plain Telegram
// text (no parse_mode), so nothing ever needs escaping. No em or en dashes
// anywhere in this file: students read every string here.
import { InlineKeyboard } from "grammy";
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

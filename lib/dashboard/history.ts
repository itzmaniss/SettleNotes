// Task event wording and before/after change descriptions for the history
// list and the moved sticker. task_events.before/after are untyped jsonb
// (Partial<TaskFields> from lib/pipeline/reconcile when written by us), so
// every read here is defensive.

import type { TaskEventAction, TaskEventRow } from "@/lib/db/types";
import { formatSgtDateTime } from "./format";

const ACTION_WORDING: Record<TaskEventAction, string> = {
  created: "Added",
  updated: "Moved",
  completed: "Ticked off",
  reopened: "Reopened",
};

export function eventWording(action: TaskEventAction): string {
  return ACTION_WORDING[action];
}

function fieldOf(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record == null) return undefined;
  return (record as Record<string, unknown>)[key];
}

function dueInstant(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

// True when before/after carry a real deadline change. Compares instants so
// the same moment in a different format is not a change.
export function eventChangedDueAt(before: unknown, after: unknown): boolean {
  const beforeTime = dueInstant(fieldOf(before, "dueAt"));
  const afterTime = dueInstant(fieldOf(after, "dueAt"));
  if (beforeTime != null && afterTime != null) return beforeTime !== afterTime;
  const beforeRaw = fieldOf(before, "dueAt");
  const afterRaw = fieldOf(after, "dueAt");
  if (typeof beforeRaw === "string" && typeof afterRaw === "string") return beforeRaw !== afterRaw;
  return false;
}

function describeDue(iso: unknown): string {
  const text = typeof iso === "string" ? formatSgtDateTime(iso) : "";
  return text === "" ? "no deadline" : text;
}

function textChange(before: unknown, after: unknown): string | null {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return null;
  return `"${before}" to "${after}"`;
}

export type EventSummary = { action: string; change: string | null };

// Human summary of one task_event: the wording plus what changed. Fields we
// do not recognise are ignored; only fields present on both sides count.
export function describeTaskEvent(
  event: Pick<TaskEventRow, "action" | "before" | "after">,
): EventSummary {
  const changes: string[] = [];

  const beforeDue = fieldOf(event.before, "dueAt");
  const afterDue = fieldOf(event.after, "dueAt");
  if (beforeDue !== undefined && afterDue !== undefined && eventChangedDueAt(event.before, event.after)) {
    changes.push(`due date from ${describeDue(beforeDue)} to ${describeDue(afterDue)}`);
  }

  const titleChange = textChange(fieldOf(event.before, "title"), fieldOf(event.after, "title"));
  if (titleChange != null) changes.push(`title ${titleChange}`);

  const courseChange = textChange(fieldOf(event.before, "course"), fieldOf(event.after, "course"));
  if (courseChange != null) changes.push(`course ${courseChange}`);

  const kindChange = textChange(fieldOf(event.before, "kind"), fieldOf(event.after, "kind"));
  if (kindChange != null) changes.push(`kind ${kindChange}`);

  const effortChange = textChange(fieldOf(event.before, "effort"), fieldOf(event.after, "effort"));
  if (effortChange != null) changes.push(`effort ${effortChange}`);

  return { action: ACTION_WORDING[event.action], change: changes.length > 0 ? changes.join(", ") : null };
}

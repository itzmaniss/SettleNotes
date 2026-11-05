import { createHash } from "node:crypto";
import type { TaskRow } from "@/lib/db/types";

// Single place for the Google event shape: a deadline becomes a timed event
// starting at the deadline, so changing the shape is a one line edit here.
export const EVENT_DURATION_MINUTES = 15;
export const REMINDER_MINUTES: number[] = [1440, 60];
export const CALENDAR_NAME = "Settle";
export const CALENDAR_TIME_ZONE = "Asia/Singapore";
export const EVENT_SUMMARY_MAX_LENGTH = 200;

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

export type CalendarTask = Pick<TaskRow, "title" | "course" | "due_at" | "status">;

export type CalendarEventBody = {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: { useDefault: false; overrides: { method: "popup"; minutes: number }[] };
};

// Open tasks with a parsable due date. Done, dismissed and dateless tasks are
// never written to Google; their links are removed by planSync instead.
export function isSyncable(task: CalendarTask): boolean {
  if (task.status !== "open") return false;
  if (!task.due_at) return false;
  return !Number.isNaN(Date.parse(task.due_at));
}

function stripControls(text: string): string {
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

// due_at is stored UTC; Google wants the SGT wall clock with an explicit
// offset, so shift by a fixed +8 (Singapore has no DST) and format manually.
function toSgtDateTime(epochMs: number): string {
  const shifted = new Date(epochMs + SGT_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${date}T${time}+08:00`;
}

export function buildEvent(task: CalendarTask): CalendarEventBody {
  if (!isSyncable(task)) {
    throw new Error("calendar buildEvent needs an open task with a due date");
  }
  const dueMs = Date.parse(task.due_at as string);
  const lines: string[] = [];
  if (task.course) lines.push(`Course: ${stripControls(task.course)}`);
  lines.push("Added by SettleNotes");
  return {
    summary: stripControls(task.title).slice(0, EVENT_SUMMARY_MAX_LENGTH),
    description: lines.join("\n"),
    start: { dateTime: toSgtDateTime(dueMs), timeZone: CALENDAR_TIME_ZONE },
    end: { dateTime: toSgtDateTime(dueMs + EVENT_DURATION_MINUTES * 60 * 1000), timeZone: CALENDAR_TIME_ZONE },
    reminders: {
      useDefault: false,
      overrides: REMINDER_MINUTES.map((minutes) => ({ method: "popup" as const, minutes })),
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .sort();
  return `{${entries.join(",")}}`;
}

// Content hash of the event body. planSync compares it against the stored
// synced_hash to decide whether a task needs a patch.
export function eventHash(event: CalendarEventBody): string {
  return createHash("sha256").update(stableStringify(event)).digest("hex");
}

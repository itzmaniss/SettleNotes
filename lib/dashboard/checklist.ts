// Pure checklist toggle logic plus the injectable runners the server actions
// call. Everything here is unit tested without a database.

import type { StarterRow, TaskRow, TaskStatus } from "@/lib/db/types";
import { parseStarterContent, type Checklist } from "@/lib/starters/types";
import type { ActionResult } from "./types";

// Flips exactly one item. An unknown id means the UI is stale or the content
// changed under us, so it throws instead of quietly returning the same list.
export function applyChecklistToggle(content: Checklist, itemId: string, done: boolean): Checklist {
  let touched = false;
  const items = content.items.map((item) => {
    if (item.id !== itemId) return item;
    touched = true;
    return item.done === done ? item : { ...item, done };
  });
  if (!touched) throw new Error("That item is not on the checklist anymore.");
  return { items };
}

export type ChecklistToggleDeps = {
  getStarterForTask: (userId: string, taskId: string) => Promise<StarterRow | null>;
  updateStarterContent: (userId: string, taskId: string, starterId: string, content: unknown) => Promise<void>;
};

export async function runToggleChecklistItem(
  deps: ChecklistToggleDeps,
  userId: string,
  taskId: string,
  starterId: string,
  itemId: string,
  done: boolean,
): Promise<ActionResult> {
  const starter = await deps.getStarterForTask(userId, taskId);
  if (starter == null) return { ok: false, error: "That task is not on your list anymore." };
  if (starter.id !== starterId) return { ok: false, error: "That checklist is not attached to this task anymore." };
  const parsed = parseStarterContent("checklist", starter.content);
  if (!parsed.ok || parsed.data.type !== "checklist") {
    return { ok: false, error: "That task has no checklist to tick." };
  }
  let next: Checklist;
  try {
    next = applyChecklistToggle(parsed.data.content, itemId, done);
  } catch {
    return { ok: false, error: "That item is not on the checklist anymore." };
  }
  try {
    await deps.updateStarterContent(userId, taskId, starterId, next);
  } catch {
    return { ok: false, error: "Could not save that tick. Try again in a moment." };
  }
  return { ok: true };
}

export type TaskStatusDeps = {
  setTaskStatusForUser: (userId: string, taskId: string, status: TaskStatus) => Promise<TaskRow>;
};

export async function runSetTaskDone(
  deps: TaskStatusDeps,
  userId: string,
  taskId: string,
  done: boolean,
): Promise<ActionResult> {
  try {
    await deps.setTaskStatusForUser(userId, taskId, done ? "done" : "open");
  } catch {
    return { ok: false, error: "Could not update the task. Try again in a moment." };
  }
  return { ok: true };
}

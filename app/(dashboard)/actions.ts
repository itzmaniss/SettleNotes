"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { triggerCalendarSync } from "@/lib/calendar/trigger";
import { runSetTaskDone, runToggleChecklistItem } from "@/lib/dashboard/checklist";
import type { ActionResult } from "@/lib/dashboard/types";
import {
  getStarterForTask,
  setTaskStatusForUser,
  updateStarterContent,
} from "@/lib/db/dashboard-queries";

const toggleInputSchema = z.object({
  taskId: z.uuid(),
  starterId: z.uuid(),
  itemId: z.string().min(1),
  done: z.boolean(),
});

const doneInputSchema = z.object({
  taskId: z.uuid(),
  done: z.boolean(),
});

const BAD_INPUT = "That request did not look right. Refresh the page and try again.";

export async function toggleChecklistItem(
  taskId: string,
  starterId: string,
  itemId: string,
  done: boolean,
): Promise<ActionResult> {
  const parsed = toggleInputSchema.safeParse({ taskId, starterId, itemId, done });
  if (!parsed.success) return { ok: false, error: BAD_INPUT };
  const { userId } = await requireSessionUser();
  const result = await runToggleChecklistItem(
    { getStarterForTask, updateStarterContent },
    userId,
    parsed.data.taskId,
    parsed.data.starterId,
    parsed.data.itemId,
    parsed.data.done,
  );
  if (result.ok) revalidatePath(`/tasks/${parsed.data.taskId}`);
  return result;
}

export async function setTaskDone(taskId: string, done: boolean): Promise<ActionResult> {
  const parsed = doneInputSchema.safeParse({ taskId, done });
  if (!parsed.success) return { ok: false, error: BAD_INPUT };
  const { userId } = await requireSessionUser();
  const result = await runSetTaskDone(
    { setTaskStatusForUser },
    userId,
    parsed.data.taskId,
    parsed.data.done,
  );
  if (result.ok) {
    revalidatePath("/dashboard");
    revalidatePath(`/tasks/${parsed.data.taskId}`);
    void triggerCalendarSync(userId);
  }
  return result;
}

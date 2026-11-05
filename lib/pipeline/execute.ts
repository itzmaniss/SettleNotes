// Thin sequential executor for reconcile ops. A failure in one op throws so
// the caller can mark the upload failed; ops before the failure stay written
// (the task_events audit trail shows how far it got).
import type {
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
} from "@/lib/db/queries";
import type { TaskRow } from "@/lib/db/types";
import type { Op, ReconcileAction, TaskFields } from "@/lib/pipeline/reconcile";
import { triggerCalendarSync } from "@/lib/calendar/trigger";
import {
  insertTask as realInsertTask,
  insertTaskEvent as realInsertTaskEvent,
  updateTask as realUpdateTask,
} from "@/lib/db/queries";

export type ExecuteContext = {
  userId: string;
  uploadId: string;
};

export type ExecuteDeps = {
  insertTask: (i: InsertTaskInput) => Promise<TaskRow>;
  updateTask: (id: string, userId: string, patch: UpdateTaskPatch) => Promise<TaskRow>;
  insertTaskEvent: (i: InsertTaskEventInput) => Promise<void>;
};

export type ExecuteResult = {
  created: TaskRow[];
  updated: Array<{ task: TaskRow; before: Partial<TaskFields>; after: Partial<TaskFields> }>;
  completed: TaskRow[];
  clarify: ReconcileAction[];
};

export async function executeOps(
  ops: Op[],
  ctx: ExecuteContext,
  db: ExecuteDeps = {
    insertTask: realInsertTask,
    updateTask: realUpdateTask,
    insertTaskEvent: realInsertTaskEvent,
  },
): Promise<ExecuteResult> {
  const result: ExecuteResult = { created: [], updated: [], completed: [], clarify: [] };

  for (const op of ops) {
    switch (op.op) {
      case "create": {
        const task = await db.insertTask({
          userId: ctx.userId,
          title: op.fields.title,
          course: op.fields.course,
          kind: op.fields.kind,
          dueAt: op.fields.dueAt,
          effort: op.fields.effort,
          origin: "capture",
          sourceUploadId: ctx.uploadId,
        });
        await db.insertTaskEvent({
          taskId: task.id,
          uploadId: ctx.uploadId,
          action: "created",
          before: op.event.before,
          after: op.event.after,
          evidence: op.event.evidence,
        });
        result.created.push(task);
        break;
      }
      case "update": {
        const task = await db.updateTask(op.taskId, ctx.userId, op.patch);
        await db.insertTaskEvent({
          taskId: task.id,
          uploadId: ctx.uploadId,
          action: "updated",
          before: op.event.before,
          after: op.event.after,
          evidence: op.event.evidence,
        });
        result.updated.push({ task, before: op.event.before, after: op.event.after });
        break;
      }
      case "complete": {
        const task = await db.updateTask(op.taskId, ctx.userId, { status: "done" });
        await db.insertTaskEvent({
          taskId: task.id,
          uploadId: ctx.uploadId,
          action: "completed",
          before: op.event.before,
          after: op.event.after,
          evidence: op.event.evidence,
        });
        result.completed.push(task);
        break;
      }
      case "clarify":
        result.clarify.push(op.action);
        break;
    }
  }

  if (result.created.length > 0 || result.updated.length > 0 || result.completed.length > 0) {
    void triggerCalendarSync(ctx.userId);
  }
  return result;
}

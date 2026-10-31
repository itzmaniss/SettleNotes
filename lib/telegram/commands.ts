import "server-only";
import type { Chat, Message, User } from "grammy/types";
import { getSupabase } from "@/lib/db/client";
import { insertTaskEvent, listOpenTasks, updateTask } from "@/lib/db/queries";
import type { InsertTaskEventInput, UpdateTaskPatch } from "@/lib/db/queries";
import type { TaskRow, UserRow } from "@/lib/db/types";
import { sortByPriority } from "@/lib/pipeline/priority";
import {
  commandFailedReply,
  doneMissingReply,
  doneOutOfRangeReply,
  doneSuccessReply,
  noUserYetReply,
  tasksEmptyReply,
  tasksListLine,
  tasksMoreLine,
  tasksNextHint,
} from "@/lib/telegram/replies";

// Minimal structural view of a grammY command context, so tests can pass tiny
// fakes like handlers.ts BotContextLike.
export type CommandContextLike = {
  from?: User;
  chat?: Chat;
  message?: Message;
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
};

export type TasksCommandDeps = {
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  listOpenTasks: (userId: string) => Promise<TaskRow[]>;
  now?: () => Date;
};

export type DoneCommandDeps = TasksCommandDeps & {
  updateTask: (id: string, userId: string, patch: UpdateTaskPatch) => Promise<TaskRow>;
  insertTaskEvent: (i: InsertTaskEventInput) => Promise<void>;
};

// /tasks shows this many tasks, and /done <n> resolves n against the SAME cut.
export const TASKS_LIST_LIMIT = 5;

// Ordering contract shared by /tasks and /done: open tasks ranked with the
// dashboard's sortByPriority, then cut to the top TASKS_LIST_LIMIT. /done n
// always means index n-1 of that cut, so the numbers in a /tasks reply are
// exactly the numbers /done accepts, and both stay in sync by construction.
export function renderTasksList(tasks: TaskRow[], now: Date): string {
  if (tasks.length === 0) return tasksEmptyReply();
  const shown = sortByPriority(tasks, now).slice(0, TASKS_LIST_LIMIT);
  const lines = shown.map((task, i) => tasksListLine(i + 1, task, now));
  const hidden = tasks.length - shown.length;
  if (hidden > 0) lines.push(tasksMoreLine(hidden));
  lines.push(tasksNextHint());
  return lines.join("\n");
}

// Accepts "/done 2", "/done   2" and "/done@BotName 2". A missing argument,
// a non-integer, zero or a negative number all return null.
export function parseDoneTarget(text: string | null | undefined): number | null {
  if (text == null) return null;
  const match = /^\/done(?:@\S+)?\s+(\S+)\s*$/.exec(text.trim());
  if (match == null) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

async function realGetUserByTelegramId(telegramUserId: number): Promise<UserRow | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select()
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) {
    const suffix = error.code ? ` [${error.code}]` : "";
    throw new Error(`db getUserByTelegramId failed${suffix}: ${error.message}`);
  }
  return (data as UserRow | null) ?? null;
}

// A failed reply must never throw out of a command handler.
async function replyQuietly(ctx: CommandContextLike, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (error) {
    console.error("[telegram] reply failed:", error instanceof Error ? error.message : String(error));
  }
}

export function createTasksCommand(deps: Partial<TasksCommandDeps> = {}) {
  const getUser = deps.getUserByTelegramId ?? realGetUserByTelegramId;
  const listOpen = deps.listOpenTasks ?? listOpenTasks;
  const now = deps.now ?? (() => new Date());
  return async (ctx: CommandContextLike): Promise<void> => {
    const from = ctx.from;
    if (!from) return;
    try {
      const user = await getUser(from.id);
      if (user == null) {
        await replyQuietly(ctx, noUserYetReply());
        return;
      }
      const tasks = await listOpen(user.id);
      await replyQuietly(ctx, renderTasksList(tasks, now()));
    } catch (error) {
      console.error("[telegram] /tasks failed:", error instanceof Error ? error.message : String(error));
      await replyQuietly(ctx, commandFailedReply());
    }
  };
}

export function createDoneCommand(deps: Partial<DoneCommandDeps> = {}) {
  const getUser = deps.getUserByTelegramId ?? realGetUserByTelegramId;
  const listOpen = deps.listOpenTasks ?? listOpenTasks;
  const update = deps.updateTask ?? updateTask;
  const insertEvent = deps.insertTaskEvent ?? insertTaskEvent;
  const now = deps.now ?? (() => new Date());
  return async (ctx: CommandContextLike): Promise<void> => {
    const from = ctx.from;
    if (!from) return;
    try {
      const n = parseDoneTarget(ctx.message?.text);
      if (n == null) {
        await replyQuietly(ctx, doneMissingReply());
        return;
      }
      const user = await getUser(from.id);
      if (user == null) {
        await replyQuietly(ctx, noUserYetReply());
        return;
      }
      const tasks = await listOpen(user.id);
      const shown = sortByPriority(tasks, now()).slice(0, TASKS_LIST_LIMIT);
      if (n > shown.length) {
        await replyQuietly(ctx, doneOutOfRangeReply(tasks.length));
        return;
      }
      const target = shown[n - 1];
      // Same write shape as a complete op in lib/pipeline/execute.ts, scoped
      // by the user's id. Ticking the same number twice just moves to the
      // next task, so the reply always names the task it ticked.
      const updated = await update(target.id, user.id, { status: "done" });
      await insertEvent({
        taskId: target.id,
        uploadId: null,
        action: "completed",
        before: { status: "open" },
        after: { status: "done" },
        evidence: "marked done in chat",
      });
      const next = sortByPriority(tasks.filter((t) => t.id !== target.id), now())[0] ?? null;
      await replyQuietly(
        ctx,
        doneSuccessReply(
          { title: updated.title, dueAt: updated.due_at },
          next == null ? null : { title: next.title, dueAt: next.due_at },
        ),
      );
    } catch (error) {
      console.error("[telegram] /done failed:", error instanceof Error ? error.message : String(error));
      await replyQuietly(ctx, commandFailedReply());
    }
  };
}

import { describe, expect, test } from "bun:test";
import type { Chat, Message, User } from "grammy/types";
import type { InsertTaskEventInput, UpdateTaskPatch } from "../../lib/db/queries";
import type { TaskRow, UserRow } from "../../lib/db/types";
import { sortByPriority } from "../../lib/pipeline/priority";
import {
  createDoneCommand,
  createTasksCommand,
  parseDoneTarget,
  renderTasksList,
  type CommandContextLike,
  type DoneCommandDeps,
  type TasksCommandDeps,
} from "../../lib/telegram/commands";
import { handleTextMessage } from "../../lib/telegram/handlers";
import {
  commandFailedReply,
  doneMissingReply,
  doneOutOfRangeReply,
  doneSuccessReply,
  formatDue,
  noUserYetReply,
  tasksEmptyReply,
  tasksMoreLine,
  tasksNextHint,
} from "../../lib/telegram/replies";
import { makeCtx, makeDeps, makeTask, NOW, testUser } from "./helpers";

// Seven open tasks whose priority order at NOW is: the overdue review first,
// then the near test, then the rest by the dashboard's own ranking, and the
// no-deadline task last.
const overdueTask = makeTask({
  id: "task-overdue",
  title: "Quiz corrections",
  kind: "review",
  due_at: "2026-10-27T02:00:00.000Z",
});
const quizTask = makeTask({
  id: "task-quiz",
  title: "MA2001 Quiz",
  kind: "test",
  due_at: "2026-10-29T01:00:00.000Z",
});
const slidesTask = makeTask({
  id: "task-slides",
  title: "Bio slides summary",
  kind: "assignment",
  due_at: "2026-10-29T15:00:00.000Z",
});
const labTask = makeTask({
  id: "task-lab",
  title: "CS2030 Lab 4",
  kind: "assignment",
  due_at: "2026-10-30T15:59:00.000Z",
});
const physicsTask = makeTask({
  id: "task-physics",
  title: "Physics practice set",
  kind: "math_practice",
  due_at: "2026-10-28T22:00:00.000Z",
});
const readingTask = makeTask({
  id: "task-reading",
  title: "Read chapter 3",
  kind: "reading",
  due_at: "2026-11-05T16:00:00.000Z",
});
const reflectionTask = makeTask({
  id: "task-reflection",
  title: "GER1000 reflection",
  kind: "other",
  due_at: null,
});
const sevenTasks = [
  overdueTask,
  quizTask,
  slidesTask,
  labTask,
  physicsTask,
  readingTask,
  reflectionTask,
];

describe("renderTasksList (pure)", () => {
  test("empty list says so and offers nothing to tick", () => {
    expect(renderTasksList([], NOW)).toBe(tasksEmptyReply());
  });

  test("one task with a deadline gets a numbered line and the /done hint", () => {
    expect(renderTasksList([labTask], NOW)).toBe(
      "1. CS2030 Lab 4 (due Fri 30 Oct, 11:59pm)\nReply /done 1 to tick off the first one.",
    );
  });

  test("exactly five tasks show five lines, no more-line", () => {
    const text = renderTasksList(sevenTasks.slice(0, 5), NOW);
    const lines = text.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe(tasksNextHint());
    expect(text).not.toContain("more on your dashboard");
  });

  test("seven tasks show the top five, then +2 more, then the hint", () => {
    const text = renderTasksList(sevenTasks, NOW);
    const lines = text.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[5]).toBe(tasksMoreLine(2));
    expect(lines[6]).toBe(tasksNextHint());
    expect(lines[0]).toBe("1. Quiz corrections (due Tue 27 Oct, 10:00am, overdue)");
  });

  test("an overdue deadline carries the plain marker word", () => {
    const text = renderTasksList([overdueTask], NOW);
    expect(text).toContain("1. Quiz corrections (due Tue 27 Oct, 10:00am, overdue)");
  });

  test("a task with no deadline has no due part at all", () => {
    expect(renderTasksList([reflectionTask], NOW)).toBe(
      "1. GER1000 reflection\nReply /done 1 to tick off the first one.",
    );
  });

  test("the numbering follows the dashboard ranking on the same fixtures", () => {
    const text = renderTasksList(sevenTasks, NOW);
    const listed = text
      .split("\n")
      .filter((line) => /^\d+\./.test(line))
      .map((line) => line.replace(/^\d+\. /, "").replace(/ \(due .*\)$/, ""));
    expect(listed).toEqual(sortByPriority(sevenTasks, NOW).slice(0, 5).map((t) => t.title));
    // Human-checkable anchor: the overdue task beats everything and the
    // no-deadline task is not in the top five here.
    expect(listed[0]).toBe("Quiz corrections");
    expect(listed).not.toContain("GER1000 reflection");
  });
});

function makeCommandCtx(text: string) {
  const replies: string[] = [];
  const ctx: CommandContextLike = {
    from: { id: 101, is_bot: false, first_name: "Tim" } as User,
    chat: { id: 101, type: "private" } as Chat,
    message: {
      text,
      message_id: 1,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false, first_name: "Tim" },
    } as unknown as Message,
    reply: async (t) => {
      replies.push(t);
      return {};
    },
  };
  return { ctx, replies };
}

function makeTasksEnv(tasks: TaskRow[], user: UserRow | null = testUser) {
  const { ctx, replies } = makeCommandCtx("/tasks");
  let listed = 0;
  const deps: TasksCommandDeps = {
    getUserByTelegramId: async () => user,
    listOpenTasks: async () => {
      listed += 1;
      return tasks;
    },
    now: () => NOW,
  };
  return { ctx, replies, deps, listed: () => listed };
}

describe("/tasks command", () => {
  test("renders the same list the pure renderer produces", async () => {
    const env = makeTasksEnv(sevenTasks);
    await createTasksCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([renderTasksList(sevenTasks, NOW)]);
    expect(env.replies[0]).toContain("+2 more on your dashboard");
    expect(env.listed()).toBe(1);
  });

  test("nothing open yet", async () => {
    const env = makeTasksEnv([]);
    await createTasksCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([tasksEmptyReply()]);
  });

  test("no user row points at /start semantics and never lists tasks", async () => {
    const env = makeTasksEnv(sevenTasks, null);
    await createTasksCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([noUserYetReply()]);
    expect(env.listed()).toBe(0);
  });

  test("a database failure becomes a friendly retry reply, never a throw", async () => {
    const { ctx, replies } = makeCommandCtx("/tasks");
    const deps: TasksCommandDeps = {
      getUserByTelegramId: async () => testUser,
      listOpenTasks: async () => {
        throw new Error("db exploded");
      },
      now: () => NOW,
    };
    await createTasksCommand(deps)(ctx);
    expect(replies).toEqual([commandFailedReply()]);
  });

  test("a message without a sender is ignored", async () => {
    const env = makeTasksEnv(sevenTasks);
    const noFrom = { ...env.ctx, from: undefined };
    await createTasksCommand(env.deps)(noFrom);
    expect(env.replies).toEqual([]);
  });
});

function makeDoneEnv(tasks: TaskRow[], text: string, user: UserRow | null = testUser) {
  const { ctx, replies } = makeCommandCtx(text);
  const updates: Array<{ id: string; userId: string; patch: UpdateTaskPatch }> = [];
  const events: InsertTaskEventInput[] = [];
  // The fake update removes the task from the live list, so a second /done of
  // the same number ticks the next task, like the real database would.
  const live = [...tasks];
  const deps: DoneCommandDeps = {
    getUserByTelegramId: async () => user,
    listOpenTasks: async () => [...live],
    updateTask: async (id, userId, patch) => {
      updates.push({ id, userId, patch });
      const index = live.findIndex((t) => t.id === id);
      if (index >= 0) live.splice(index, 1);
      const original = tasks.find((t) => t.id === id) as TaskRow;
      return { ...original, status: "done" };
    },
    insertTaskEvent: async (e) => {
      events.push(e);
    },
    now: () => NOW,
  };
  return { ctx, replies, deps, updates, events };
}

describe("parseDoneTarget (pure)", () => {
  test("accepts plain, padded and bot-suffixed forms", () => {
    expect(parseDoneTarget("/done 2")).toBe(2);
    expect(parseDoneTarget("/done   3")).toBe(3);
    expect(parseDoneTarget("/done@SettleBot 1")).toBe(1);
    expect(parseDoneTarget("/done@SettleBot   5")).toBe(5);
  });

  test("rejects missing, non-integer, zero and negative targets", () => {
    expect(parseDoneTarget("/done")).toBeNull();
    expect(parseDoneTarget("/done@SettleBot")).toBeNull();
    expect(parseDoneTarget("/done abc")).toBeNull();
    expect(parseDoneTarget("/done 0")).toBeNull();
    expect(parseDoneTarget("/done -1")).toBeNull();
    expect(parseDoneTarget("/done 1.5")).toBeNull();
    expect(parseDoneTarget("/done 2 3")).toBeNull();
    expect(parseDoneTarget("/tasks")).toBeNull();
    expect(parseDoneTarget(undefined)).toBeNull();
  });
});

describe("/done command", () => {
  test("a valid number ticks that task with the same write shape as executeOps", async () => {
    const env = makeDoneEnv(sevenTasks, "/done 2");
    const ranked = sortByPriority(sevenTasks, NOW);
    const target = ranked[1];
    const next = sortByPriority(sevenTasks.filter((t) => t.id !== target.id), NOW)[0];

    await createDoneCommand(env.deps)(env.ctx);

    expect(env.updates).toEqual([{ id: target.id, userId: "user-1", patch: { status: "done" } }]);
    expect(env.events).toEqual([
      {
        taskId: target.id,
        uploadId: null,
        action: "completed",
        before: { status: "open" },
        after: { status: "done" },
        evidence: "marked done in chat",
      },
    ]);
    expect(env.replies).toEqual([
      `Ticked off: ${target.title}\nNext up: ${next.title} (due ${formatDue(next.due_at)})`,
    ]);
  });

  test("extra spaces still resolve", async () => {
    const env = makeDoneEnv(sevenTasks, "/done   1");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.updates[0].id).toBe(sortByPriority(sevenTasks, NOW)[0].id);
  });

  test("the @BotName suffix still resolves", async () => {
    const env = makeDoneEnv(sevenTasks, "/done@SettleBot 1");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.updates[0].id).toBe(overdueTask.id);
    expect(env.replies[0]).toContain("Ticked off: Quiz corrections");
  });

  test("missing or malformed numbers get the how-to reply and nothing is written", async () => {
    for (const text of ["/done", "/done@SettleBot", "/done abc", "/done 0", "/done -1", "/done 1.5"]) {
      const env = makeDoneEnv(sevenTasks, text);
      await createDoneCommand(env.deps)(env.ctx);
      expect(env.replies, text).toEqual([doneMissingReply()]);
      expect(env.updates, text).toHaveLength(0);
      expect(env.events, text).toHaveLength(0);
    }
  });

  test("a number beyond the list reports the real count, singular", async () => {
    const env = makeDoneEnv([overdueTask], "/done 2");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([doneOutOfRangeReply(1)]);
    expect(env.updates).toHaveLength(0);
  });

  test("a number beyond the list reports the real count, plural", async () => {
    const env = makeDoneEnv([overdueTask, quizTask, reflectionTask], "/done 4");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([doneOutOfRangeReply(3)]);
    expect(env.updates).toHaveLength(0);
  });

  test("only the top five are tickable even with more open tasks", async () => {
    const env = makeDoneEnv(sevenTasks, "/done 6");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([doneOutOfRangeReply(7)]);
    expect(env.updates).toHaveLength(0);
  });

  test("ticking the only task omits the next-up line", async () => {
    const env = makeDoneEnv([overdueTask], "/done 1");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual(["Ticked off: Quiz corrections"]);
  });

  test("the next-up line skips the due part when the task has no deadline", async () => {
    const env = makeDoneEnv([overdueTask, reflectionTask], "/done 1");
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([doneSuccessReply(
      { title: "Quiz corrections", dueAt: "2026-10-27T02:00:00.000Z" },
      { title: "GER1000 reflection", dueAt: null },
    )]);
    expect(env.replies[0]).toBe("Ticked off: Quiz corrections\nNext up: GER1000 reflection");
  });

  test("a double /done 1 ticks the next task and always names it", async () => {
    const env = makeDoneEnv([overdueTask, quizTask, labTask], "/done 1");
    await createDoneCommand(env.deps)(env.ctx);
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies[0]).toContain("Ticked off: Quiz corrections");
    expect(env.replies[1]).toContain("Ticked off: MA2001 Quiz");
    expect(env.updates.map((u) => u.id)).toEqual([overdueTask.id, quizTask.id]);
    expect(env.events).toHaveLength(2);
  });

  test("no user row points at /start semantics and nothing is written", async () => {
    const env = makeDoneEnv(sevenTasks, "/done 1", null);
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([noUserYetReply()]);
    expect(env.updates).toHaveLength(0);
    expect(env.events).toHaveLength(0);
  });

  test("a failing write becomes a friendly retry reply and no event is logged", async () => {
    const env = makeDoneEnv(sevenTasks, "/done 1");
    env.deps.updateTask = async () => {
      throw new Error("db exploded");
    };
    await createDoneCommand(env.deps)(env.ctx);
    expect(env.replies).toEqual([commandFailedReply()]);
    expect(env.events).toHaveLength(0);
  });
});

describe("command texts never reach the ingest pipeline", () => {
  test("a '/tasks' or '/done 1' text through the text handler stores nothing and stays quiet", async () => {
    for (const text of ["/tasks", "/done 1", "/done@SettleBot 2"]) {
      const spy = makeCtx({ text, date: 1, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "Tim" } });
      const { deps, uploads, ingests, finished } = makeDeps();

      await handleTextMessage(spy.ctx, deps);

      expect(spy.replies, text).toHaveLength(0);
      expect(uploads, text).toHaveLength(0);
      expect(ingests, text).toHaveLength(0);
      expect(finished, text).toHaveLength(0);
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  applyChecklistToggle,
  runSetTaskDone,
  runToggleChecklistItem,
  type ChecklistToggleDeps,
  type TaskStatusDeps,
} from "@/lib/dashboard/checklist";
import { ChecklistSchema } from "@/lib/starters/types";
import { starter, task } from "./fixtures";

const CONTENT = {
  items: [
    { id: "a", text: "Submit the PDF", category: "deliverable" as const, page: 4, done: false },
    { id: "b", text: "Name file as MATRIC_LAB4.pdf", category: "submission_rule" as const, page: 4, done: false },
    { id: "c", text: "Explain your reasoning", category: "rubric" as const, page: 5, done: true },
  ],
};

describe("applyChecklistToggle", () => {
  test("flips only the target item", () => {
    const next = applyChecklistToggle(CONTENT, "b", true);
    expect(next.items.map((item) => item.done)).toEqual([false, true, true]);
    // untouched items keep their identity, only the toggled one is new
    expect(next.items[0]).toBe(CONTENT.items[0]);
    expect(next.items[2]).toBe(CONTENT.items[2]);
  });

  test("result stays schema valid", () => {
    const next = applyChecklistToggle(CONTENT, "a", true);
    expect(ChecklistSchema.safeParse(next).success).toBe(true);
  });

  test("toggling back off works", () => {
    const next = applyChecklistToggle(CONTENT, "c", false);
    expect(next.items[2].done).toBe(false);
  });

  test("unknown id errors", () => {
    expect(() => applyChecklistToggle(CONTENT, "missing", true)).toThrow(/not on the checklist/);
  });
});

describe("runToggleChecklistItem", () => {
  const checklistStarter = starter({ id: "starter-1", type: "checklist", content: CONTENT });

  function deps() {
    const calls: { starterLoadedFor: Array<{ userId: string; taskId: string }>; saved: unknown[] } = {
      starterLoadedFor: [],
      saved: [],
    };
    const fake: ChecklistToggleDeps = {
      getStarterForTask: async (userId, taskId) => {
        calls.starterLoadedFor.push({ userId, taskId });
        return currentStarter;
      },
      updateStarterContent: async (userId, taskId, starterId, content) => {
        calls.saved.push({ userId, taskId, starterId, content });
      },
    };
    let currentStarter: typeof checklistStarter = checklistStarter;
    return { calls, fake, setStarter: (s: typeof checklistStarter | null) => (currentStarter = s as never) };
  }

  test("happy path flips one item and persists", async () => {
    const { calls, fake } = deps();
    const result = await runToggleChecklistItem(fake, "user-1", "task-1", "starter-1", "b", true);
    expect(result).toEqual({ ok: true });
    expect(calls.starterLoadedFor).toEqual([{ userId: "user-1", taskId: "task-1" }]);
    expect(calls.saved).toHaveLength(1);
    const saved = calls.saved[0] as { starterId: string; content: { items: { id: string; done: boolean }[] } };
    expect(saved.starterId).toBe("starter-1");
    expect(saved.content.items.find((item) => item.id === "b")?.done).toBe(true);
  });

  test("missing task or starter is a plain human failure", async () => {
    const { fake, setStarter } = deps();
    setStarter(null);
    const result = await runToggleChecklistItem(fake, "user-1", "task-1", "starter-1", "b", true);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not on your list/);
  });

  test("starter id mismatch fails", async () => {
    const { fake } = deps();
    const result = await runToggleChecklistItem(fake, "user-1", "task-1", "starter-9", "b", true);
    expect(result.ok).toBe(false);
  });

  test("a non checklist starter fails cleanly", async () => {
    const { fake, setStarter } = deps();
    setStarter(starter({ type: "flashcards", content: { cards: [], practice: [] } }));
    const result = await runToggleChecklistItem(fake, "user-1", "task-1", "starter-1", "b", true);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/no checklist/);
  });

  test("corrupt stored content fails cleanly", async () => {
    const { fake, setStarter } = deps();
    setStarter(starter({ content: { nonsense: true } }));
    const result = await runToggleChecklistItem(fake, "user-1", "task-1", "starter-1", "b", true);
    expect(result.ok).toBe(false);
  });

  test("unknown item id fails without saving", async () => {
    const { calls, fake } = deps();
    const result = await runToggleChecklistItem(fake, "user-1", "task-1", "starter-1", "missing", true);
    expect(result.ok).toBe(false);
    expect(calls.saved).toHaveLength(0);
  });

  test("a save failure returns a retry hint", async () => {
    const failing: ChecklistToggleDeps = {
      getStarterForTask: async () => checklistStarter,
      updateStarterContent: async () => {
        throw new Error("db down");
      },
    };
    const result = await runToggleChecklistItem(failing, "user-1", "task-1", "starter-1", "b", true);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/Try again/);
  });
});

describe("runSetTaskDone", () => {
  function deps() {
    const calls: Array<{ userId: string; taskId: string; status: string }> = [];
    const fake: TaskStatusDeps = {
      setTaskStatusForUser: async (userId, taskId, status) => {
        calls.push({ userId, taskId, status });
        return task({ status });
      },
    };
    return { calls, fake };
  }

  test("done true sets status done", async () => {
    const { calls, fake } = deps();
    const result = await runSetTaskDone(fake, "user-1", "task-1", true);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ userId: "user-1", taskId: "task-1", status: "done" }]);
  });

  test("done false reopens", async () => {
    const { calls, fake } = deps();
    await runSetTaskDone(fake, "user-1", "task-1", false);
    expect(calls[0].status).toBe("open");
  });

  test("a failure returns a plain human error", async () => {
    const failing: TaskStatusDeps = {
      setTaskStatusForUser: async () => {
        throw new Error("task task-1 not found for this user");
      },
    };
    const result = await runSetTaskDone(failing, "user-1", "task-1", true);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/Could not update the task/);
  });
});

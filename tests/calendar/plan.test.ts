import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { planSync } = await import("../../lib/calendar/sync");
const { buildEvent, eventHash } = await import("../../lib/calendar/event");
import type { PlanLink, PlanTask } from "../../lib/calendar/sync";

function openTask(id: string, title = "Task"): PlanTask {
  return { id, title, course: null, due_at: "2026-10-31T16:00:00.000Z", status: "open" };
}

function linkFor(task: PlanTask): PlanLink {
  return { task_id: task.id, google_event_id: `ev-${task.id}`, synced_hash: eventHash(buildEvent(task)) };
}

describe("planSync", () => {
  test("creates syncable tasks with no link", () => {
    const tasks = [openTask("a"), openTask("b")];
    const plan = planSync(tasks, []);
    expect(plan.create.map((t) => t.id)).toEqual(["a", "b"]);
    expect(plan.patch).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  test("patches only the link whose hash differs", () => {
    const same = openTask("same");
    const changed = openTask("changed");
    const links = [linkFor(same), { ...linkFor(changed), synced_hash: "stale" }];
    const moved = { ...changed, title: "Renamed task" };
    const plan = planSync([same, moved], links);
    expect(plan.create).toEqual([]);
    expect(plan.patch).toHaveLength(1);
    expect(plan.patch[0].task.title).toBe("Renamed task");
    expect(plan.patch[0].link.task_id).toBe("changed");
    expect(plan.remove).toEqual([]);
  });

  test("no-op when everything matches", () => {
    const tasks = [openTask("a"), openTask("b")];
    expect(planSync(tasks, tasks.map(linkFor))).toEqual({ create: [], patch: [], remove: [] });
  });

  test("removes links whose task is missing, done, or dateless", () => {
    const gone: PlanLink = { task_id: "gone", google_event_id: "ev-gone", synced_hash: "h" };
    const doneTask = { ...openTask("done"), status: "done" as const };
    const dateless = { ...openTask("dateless"), due_at: null };
    const doneLink: PlanLink = { task_id: "done", google_event_id: "ev-done", synced_hash: "h" };
    const datelessLink: PlanLink = { task_id: "dateless", google_event_id: "ev-dateless", synced_hash: "h" };
    const plan = planSync([doneTask, dateless], [gone, doneLink, datelessLink]);
    expect(plan.create).toEqual([]);
    expect(plan.patch).toEqual([]);
    expect(plan.remove.map((l) => l.task_id).sort()).toEqual(["dateless", "done", "gone"]);
  });

  test("dateless and done tasks are never created", () => {
    const plan = planSync(
      [{ ...openTask("x"), due_at: null }, { ...openTask("y"), status: "dismissed" as const }],
      []
    );
    expect(plan).toEqual({ create: [], patch: [], remove: [] });
  });
});

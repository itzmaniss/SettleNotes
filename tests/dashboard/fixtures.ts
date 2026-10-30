import type { StarterRow, TaskEventRow, TaskRow, WeakSpotRow } from "@/lib/db/types";

export function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    user_id: "user-1",
    title: "CS2040 Lab 4",
    course: "CS2040",
    kind: "assignment",
    due_at: null,
    effort: "medium",
    status: "open",
    origin: "capture",
    source_upload_id: null,
    weak_spot_id: null,
    created_at: "2026-10-30T01:00:00.000Z",
    updated_at: "2026-10-30T01:00:00.000Z",
    ...overrides,
  };
}

export function event(overrides: Partial<TaskEventRow> = {}): TaskEventRow {
  return {
    id: "event-1",
    task_id: "task-1",
    upload_id: null,
    action: "created",
    before: null,
    after: { title: "CS2040 Lab 4", course: "CS2040", kind: "assignment", dueAt: null, effort: "medium" },
    evidence: "lab 4 due nxt fri",
    created_at: "2026-10-30T01:00:00.000Z",
    ...overrides,
  };
}

export function starter(overrides: Partial<StarterRow> = {}): StarterRow {
  return {
    id: "starter-1",
    task_id: "task-1",
    type: "checklist",
    content: { items: [] },
    annotated_image_path: null,
    created_at: "2026-10-30T01:00:00.000Z",
    ...overrides,
  };
}

export function weakSpot(overrides: Partial<WeakSpotRow> = {}): WeakSpotRow {
  return {
    id: "spot-1",
    user_id: "user-1",
    topic: "differentiation_chain_rule",
    latest_misconception: "forgot the inner derivative",
    occurrences: 1,
    last_seen_at: "2026-10-30T01:00:00.000Z",
    next_review_at: "2026-11-06T01:00:00.000Z",
    ...overrides,
  };
}

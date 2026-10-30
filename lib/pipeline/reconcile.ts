// Pure reconcile planner: turns validated model actions into DB ops.
// No I/O, no Date.now(). Spec: docs/ARCHITECTURE.md 4.3.
//
// Normalisation decisions (left to this card by the spec):
// - Tokens: lowercase, strip non-alphanumerics, split on whitespace, drop the
//   stopwords the/a/an/for/of/and/to. Course tokens join the title's set so
//   "CS2030 Lab 4 report" and "Lab 4 report CS2030" collapse.
// - JACCARD_MATCH_THRESHOLD = 0.6. Best score wins; ties go to the candidate
//   with the earliest due instant (null due dates rank last), then to the
//   candidate that appears first in the running view (loaded tasks in order,
//   then batch-created tasks in creation order).
// - Titles/courses are trimmed before comparing and storing; an empty or
//   whitespace-only course counts as not supplied. dueAt compares as instants
//   (unparseable strings fall back to exact equality); other fields compare
//   exactly.
// - A complete for an unknown task is dropped, never downgraded to a create:
//   a "done liao" about a task we cannot find must not conjure a new open
//   task. The same applies once a task was completed earlier in the batch;
//   a later update for it is dropped too (a task that just left the open view
//   is not a valid dedupe target, so the fallback create would duplicate it).
// - Merging a near-duplicate create into a task created earlier in the same
//   batch appends the second action's evidence with " | " so the audit trail
//   keeps both quotes.

import type { TaskEffort, TaskKind, TaskRow } from "@/lib/db/types";

export type ReconcileAction = {
  type: "create" | "update" | "complete" | "none";
  taskId: string | null; // real task id, already mapped from the model's short ref by the caller; null when the ref was unknown or absent
  title: string | null;
  course: string | null;
  kind: "assignment" | "test" | "reading" | "math_practice" | "other" | null;
  dueAt: string | null; // UTC ISO, already converted by the caller; null when none stated
  effort: "small" | "medium" | "large" | null;
  evidence: string;
  confidence: number;
};

export type OpenTaskLite = Pick<
  TaskRow,
  "id" | "title" | "course" | "kind" | "due_at" | "effort" | "status"
>;

export type TaskFields = {
  title: string;
  course: string | null;
  kind: TaskKind;
  dueAt: string | null;
  effort: TaskEffort | null;
};

export type Op =
  | {
      op: "create";
      fields: TaskFields;
      event: { action: "created"; before: null; after: TaskFields; evidence: string };
    }
  | {
      op: "update";
      taskId: string;
      patch: Partial<TaskFields>;
      event: {
        action: "updated";
        before: Partial<TaskFields>;
        after: Partial<TaskFields>;
        evidence: string;
      };
    }
  | {
      op: "complete";
      taskId: string;
      event: { action: "completed"; before: { status: "open" }; after: { status: "done" }; evidence: string };
    }
  | { op: "clarify"; reason: "low_confidence"; action: ReconcileAction };

// Tunable: below this the action only surfaces in the clarification reply.
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
// Tunable: how aggressive create-vs-existing dedupe is.
export const JACCARD_MATCH_THRESHOLD = 0.6;

const STOPWORDS = new Set(["the", "a", "an", "for", "of", "and", "to"]);

export function normalizeTitleTokens(title: string, course: string | null): string[] {
  const tokenize = (value: string): string[] =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0 && !STOPWORDS.has(token));
  const tokens = tokenize(title);
  if (course != null) tokens.push(...tokenize(course));
  return tokens;
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

type ViewTask = {
  id: string;
  title: string;
  course: string | null;
  kind: TaskKind;
  dueAt: string | null;
  effort: TaskEffort | null;
  order: number;
  // Index into ops of the create op that made this task, when it was created
  // earlier in the same batch (null for tasks loaded from the DB).
  createOpIndex: number | null;
};

function dueTime(iso: string | null): number | null {
  if (iso == null) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

function dueAtEquals(a: string | null, b: string | null): boolean {
  const timeA = dueTime(a);
  const timeB = dueTime(b);
  if (timeA != null && timeB != null) return timeA === timeB;
  return a === b;
}

function isEarlierDue(a: ViewTask, b: ViewTask): boolean {
  const timeA = dueTime(a.dueAt);
  const timeB = dueTime(b.dueAt);
  if (timeA == null) return false; // null due dates rank last
  return timeB == null || timeA < timeB;
}

function hasTitle(title: string | null): boolean {
  return title != null && title.trim() !== "";
}

function suppliedFields(action: ReconcileAction): Partial<TaskFields> {
  const fields: Partial<TaskFields> = {};
  if (hasTitle(action.title)) fields.title = action.title!.trim();
  if (action.course != null && action.course.trim() !== "") fields.course = action.course.trim();
  if (action.kind != null) fields.kind = action.kind;
  if (action.dueAt != null) fields.dueAt = action.dueAt;
  if (action.effort != null) fields.effort = action.effort;
  return fields;
}

function diffFields(
  current: ViewTask,
  supplied: Partial<TaskFields>,
): { patch: Partial<TaskFields>; before: Partial<TaskFields> } {
  const patch: Partial<TaskFields> = {};
  const before: Partial<TaskFields> = {};
  if (supplied.title != null && supplied.title !== current.title.trim()) {
    before.title = current.title;
    patch.title = supplied.title;
  }
  if (supplied.course != null && supplied.course !== (current.course ?? "").trim()) {
    before.course = current.course;
    patch.course = supplied.course;
  }
  if (supplied.kind != null && supplied.kind !== current.kind) {
    before.kind = current.kind;
    patch.kind = supplied.kind;
  }
  if (supplied.dueAt != null && !dueAtEquals(supplied.dueAt, current.dueAt)) {
    before.dueAt = current.dueAt;
    patch.dueAt = supplied.dueAt;
  }
  if (supplied.effort != null && supplied.effort !== current.effort) {
    before.effort = current.effort;
    patch.effort = supplied.effort;
  }
  return { patch, before };
}

export function planReconcile(
  actions: ReconcileAction[],
  openTasks: OpenTaskLite[],
  now: Date,
): Op[] {
  // `now` is part of the contract for future gating; past due dates are
  // deliberately allowed (students log overdue items), so nothing uses it.
  void now;

  const ops: Op[] = [];
  const view = new Map<string, ViewTask>();
  const completed = new Set<string>();
  let order = 0;
  for (const task of openTasks) {
    if (task.status !== "open" || view.has(task.id)) continue;
    view.set(task.id, {
      id: task.id,
      title: task.title,
      course: task.course,
      kind: task.kind,
      dueAt: task.due_at,
      effort: task.effort,
      order: order++,
      createOpIndex: null,
    });
  }

  // Best fuzzy match among open tasks plus batch-created tasks. Map iteration
  // is insertion order, so "first in list" falls out of only replacing the
  // best candidate on a strictly better score or an earlier due instant.
  const findMatch = (action: ReconcileAction): ViewTask | null => {
    const tokens = normalizeTitleTokens(action.title ?? "", action.course);
    let best: ViewTask | null = null;
    let bestScore = 0;
    for (const candidate of view.values()) {
      const score = jaccard(tokens, normalizeTitleTokens(candidate.title, candidate.course));
      const beatsBest =
        best == null || score > bestScore || (score === bestScore && isEarlierDue(candidate, best));
      if (score >= JACCARD_MATCH_THRESHOLD && beatsBest) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  };

  const emitCreateFromAction = (action: ReconcileAction): void => {
    const supplied = suppliedFields(action);
    const match = findMatch(action);
    if (match == null) {
      const fields: TaskFields = {
        title: (supplied.title ?? "").trim(),
        course: supplied.course ?? null,
        kind: supplied.kind ?? "other",
        dueAt: supplied.dueAt ?? null,
        effort: supplied.effort ?? null,
      };
      const batchId = `batch:${order}`;
      ops.push({
        op: "create",
        fields,
        event: { action: "created", before: null, after: fields, evidence: action.evidence },
      });
      view.set(batchId, {
        id: batchId,
        title: fields.title,
        course: fields.course,
        kind: fields.kind,
        dueAt: fields.dueAt,
        effort: fields.effort,
        order: order++,
        createOpIndex: ops.length - 1,
      });
      return;
    }
    const { patch, before } = diffFields(match, supplied);
    if (Object.keys(patch).length === 0) return;
    if (match.createOpIndex != null) {
      const createOp = ops[match.createOpIndex];
      if (createOp.op === "create") {
        createOp.fields = { ...createOp.fields, ...patch };
        createOp.event.after = createOp.fields;
        createOp.event.evidence = `${createOp.event.evidence} | ${action.evidence}`;
      }
    } else {
      ops.push({
        op: "update",
        taskId: match.id,
        patch,
        event: { action: "updated", before, after: { ...patch }, evidence: action.evidence },
      });
    }
    Object.assign(match, patch);
  };

  for (const action of actions) {
    if (action.type === "none") continue;
    const confidence = Number.isFinite(action.confidence) ? action.confidence : 0;
    if (confidence < LOW_CONFIDENCE_THRESHOLD) {
      ops.push({ op: "clarify", reason: "low_confidence", action });
      continue;
    }
    if (action.type === "create") {
      if (!hasTitle(action.title)) continue; // missing title -> drop
      emitCreateFromAction(action);
      continue;
    }
    // update / complete: ownership check against the running open view.
    const id = action.taskId;
    if (id != null && completed.has(id)) continue; // already completed in this batch
    const current = id != null ? view.get(id) : undefined;
    if (current == null) {
      if (action.type === "complete") continue; // unknown -> drop
      if (!hasTitle(action.title)) continue; // unknown without title -> drop
      emitCreateFromAction(action); // downgrade to create, still fuzzy-deduped
      continue;
    }
    if (action.type === "complete") {
      ops.push({
        op: "complete",
        taskId: current.id,
        event: {
          action: "completed",
          before: { status: "open" },
          after: { status: "done" },
          evidence: action.evidence,
        },
      });
      completed.add(current.id);
      view.delete(current.id);
      continue;
    }
    const { patch, before } = diffFields(current, suppliedFields(action));
    if (Object.keys(patch).length === 0) continue; // nothing actually changes
    ops.push({
      op: "update",
      taskId: current.id,
      patch,
      event: { action: "updated", before, after: { ...patch }, evidence: action.evidence },
    });
    Object.assign(current, patch);
  }

  return ops;
}

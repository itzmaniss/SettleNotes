import type { TaskRow } from "@/lib/db/types";
import { groupByBucket, sortByPriority, type Bucket } from "@/lib/pipeline/priority";

// Next up: the single highest-priority OPEN task. Done and dismissed tasks
// never take the lime card.
export function pickNextUp<T extends Pick<TaskRow, "status" | "kind" | "due_at" | "effort" | "created_at">>(
  tasks: T[],
  now: Date,
): T | null {
  const open = tasks.filter((task) => task.status === "open");
  const sorted = sortByPriority(open, now);
  return sorted[0] ?? null;
}

export type DashboardBucket = Bucket | "done";

export type DashboardSection = { bucket: DashboardBucket; label: string; tasks: TaskRow[] };

const SECTION_LABELS: Record<DashboardBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  this_week: "This week",
  later: "Later",
  done: "Done",
};

// Done rows order by tick time, newest first; id as a stable tiebreak.
function byUpdatedDesc(a: TaskRow, b: TaskRow): number {
  const diff = (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Open tasks keep the priority buckets; done tasks leave them entirely and
// get their own final section, so a finished task never reads as overdue.
export function groupForDashboard(tasks: TaskRow[], now: Date): DashboardSection[] {
  const done = tasks.filter((task) => task.status === "done").sort(byUpdatedDesc);
  const open = tasks.filter((task) => task.status !== "done");
  const buckets = groupByBucket(open, now);
  const order: DashboardBucket[] = ["overdue", "today", "this_week", "later", "done"];
  return order
    .map((bucket) => ({
      bucket,
      label: SECTION_LABELS[bucket],
      tasks: bucket === "done" ? done : buckets[bucket],
    }))
    .filter((section) => section.tasks.length > 0);
}

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

export type DashboardSection = { bucket: Bucket; label: string; tasks: TaskRow[] };

const SECTION_LABELS: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  this_week: "This week",
  later: "Later",
};

// Sections in fixed order, empty ones dropped. Each bucket is already in
// priority order via groupByBucket.
export function groupForDashboard(tasks: TaskRow[], now: Date): DashboardSection[] {
  const buckets = groupByBucket(tasks, now);
  const order: Bucket[] = ["overdue", "today", "this_week", "later"];
  return order
    .map((bucket) => ({ bucket, label: SECTION_LABELS[bucket], tasks: buckets[bucket] }))
    .filter((section) => section.tasks.length > 0);
}

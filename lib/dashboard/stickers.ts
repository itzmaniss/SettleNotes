import type { TaskEventRow, TaskKind, TaskRow } from "@/lib/db/types";
import { eventChangedDueAt } from "./history";

export type StickerSpec = {
  label: string;
  tone: "card" | "pop" | "accent" | "destructive" | "ink";
};

// Kind sticker for a task row. 'other' gets none so rows stay calm.
export function kindSticker(kind: TaskKind): StickerSpec | null {
  switch (kind) {
    case "test":
      return { label: "test", tone: "pop" };
    case "assignment":
      return { label: "assignment", tone: "card" };
    case "review":
      return { label: "review", tone: "accent" };
    case "math_practice":
      return { label: "math", tone: "card" };
    case "reading":
      return { label: "reading", tone: "card" };
    case "other":
      return null;
  }
}

// Status sticker for an OPEN task: 'moved' when the latest event was an update
// that changed the deadline (the reconciler's Singlish evidence is the whole
// point), else 'overdue'. Moved wins: a deadline that just moved is the news,
// even when late. A done task is finished, so it never gets one, whatever the
// calendar says.
export function statusSticker(
  task: Pick<TaskRow, "due_at" | "status">,
  lastEvent: Pick<TaskEventRow, "action" | "before" | "after"> | null,
  now: Date,
): StickerSpec | null {
  if (task.status === "done") return null;
  if (lastEvent != null && lastEvent.action === "updated" && eventChangedDueAt(lastEvent.before, lastEvent.after)) {
    return { label: "moved", tone: "pop" };
  }
  if (task.due_at != null) {
    const due = new Date(task.due_at);
    if (!Number.isNaN(due.getTime()) && due.getTime() < now.getTime()) {
      return { label: "overdue", tone: "destructive" };
    }
  }
  return null;
}

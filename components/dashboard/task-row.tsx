import Link from "next/link";
import { Chunk, Sticker } from "@/components/settle";
import { formatDoneDueLine, formatDueLine } from "@/lib/dashboard/format";
import { kindSticker, statusSticker } from "@/lib/dashboard/stickers";
import type { TaskEventRow, TaskRow } from "@/lib/db/types";
import { cn } from "@/lib/utils";
import { TaskCheck } from "./task-check";

type TaskRowProps = {
  task: TaskRow;
  lastEvent: TaskEventRow | null;
  now: Date;
};

// One This week row: tick, title link, due line, kind and status stickers,
// and the reconciler's quoted evidence when the deadline was moved. A done
// row stays muted with the title struck through and reads 'Done', never
// overdue, whatever the calendar says.
export function TaskRowCard({ task, lastEvent, now }: TaskRowProps) {
  const done = task.status === "done";
  const due = done
    ? { text: formatDoneDueLine(task.due_at), overdue: false }
    : formatDueLine(task.due_at, now);
  const kind = kindSticker(task.kind);
  const status = statusSticker(task, lastEvent, now);
  const moved = status?.label === "moved";
  const evidence = moved && lastEvent != null ? (lastEvent.evidence ?? "").trim() : "";

  return (
    <Chunk className={cn("flex items-center gap-3 p-4 md:gap-4", task.status !== "open" && "opacity-75")}>
      <TaskCheck taskId={task.id} done={done} title={task.title} />
      <div className="min-w-0 flex-1">
        <Link
          href={`/tasks/${task.id}`}
          className={cn(
            "block font-semibold leading-snug underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            done && "line-through",
          )}
        >
          {task.title}
        </Link>
        <p className={cn("mt-0.5 text-sm", due.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
          {due.text}
        </p>
        {evidence !== "" && (
          <p className="mt-1.5 font-mono text-xs italic leading-relaxed text-muted-foreground">
            moved by &ldquo;{evidence}&rdquo;
          </p>
        )}
      </div>
      {(kind != null || status != null) && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {kind != null && <Sticker tone={kind.tone}>{kind.label}</Sticker>}
          {status != null && <Sticker tone={status.tone}>{status.label}</Sticker>}
        </div>
      )}
    </Chunk>
  );
}

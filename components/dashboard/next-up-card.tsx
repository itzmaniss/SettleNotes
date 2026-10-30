import Link from "next/link";
import { Chunk, ChunkButton, Sticker } from "@/components/settle";
import { formatDueLine } from "@/lib/dashboard/format";
import { kindSticker, statusSticker } from "@/lib/dashboard/stickers";
import type { TaskEventRow, TaskRow } from "@/lib/db/types";
import { cn } from "@/lib/utils";
import { EmptyNote } from "./empty-note";

type NextUpCardProps = {
  task: TaskRow;
  lastEvent: TaskEventRow | null;
  now: Date;
};

// The mock's big lime card. Start links to the task page; no Later button
// (that action has no backend yet).
export function NextUpCard({ task, lastEvent, now }: NextUpCardProps) {
  const due = formatDueLine(task.due_at, now);
  const kind = kindSticker(task.kind);
  const status = statusSticker(task, lastEvent, now);
  return (
    <Chunk tone="accent" className="p-6 md:p-7">
      <div className="flex flex-wrap items-center gap-2">
        {task.course != null && task.course !== "" && <Sticker tone="card">{task.course}</Sticker>}
        {kind != null && <Sticker tone={kind.tone}>{kind.label}</Sticker>}
        {status != null && <Sticker tone={status.tone}>{status.label}</Sticker>}
      </div>
      <p className="mt-4 font-display text-3xl font-extrabold leading-tight md:text-4xl">{task.title}</p>
      <p className={cn("mt-2 text-sm font-medium", due.overdue && "text-destructive")}>{due.text}</p>
      <div className="mt-6">
        <ChunkButton render={<Link href={`/tasks/${task.id}`} />}>Start</ChunkButton>
      </div>
    </Chunk>
  );
}

export function NextUpEmpty({ hasTasks }: { hasTasks: boolean }) {
  if (hasTasks) {
    return (
      <EmptyNote>Everything is ticked off. New deadlines from your chats land here first.</EmptyNote>
    );
  }
  return (
    <EmptyNote>
      Nothing on your list yet. Send me a screenshot of your group chat and I will sort it out.
    </EmptyNote>
  );
}

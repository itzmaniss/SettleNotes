import Link from "next/link";
import { Chunk, ChunkButton } from "@/components/settle";
import type { StudyDeckSummary } from "@/lib/dashboard/study-decks";
import { EmptyNote } from "./empty-note";

// Quick study: one row per flashcard deck, linking to the full deck on the
// task page. The side panel stays a launcher, not a second study surface.
export function QuickStudy({ decks }: { decks: StudyDeckSummary[] }) {
  if (decks.length === 0) {
    return (
      <EmptyNote>
        No decks yet. Send your lecture slides to the bot and cards show up here.
      </EmptyNote>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      {decks.map((deck) => (
        <Chunk key={deck.taskId} className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{deck.taskTitle}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {deck.cardCount} cards ready{deck.course != null && deck.course !== "" ? ` · ${deck.course}` : ""}
            </p>
          </div>
          <ChunkButton tone="accent" render={<Link href={`/tasks/${deck.taskId}`} />} className="shrink-0">
            Study
          </ChunkButton>
        </Chunk>
      ))}
    </div>
  );
}

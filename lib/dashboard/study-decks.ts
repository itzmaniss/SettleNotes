import type { StarterRow, TaskRow } from "@/lib/db/types";
import { parseStarterContent, type Flashcard } from "@/lib/starters/types";

export type StudyDeckSummary = {
  taskId: string;
  taskTitle: string;
  course: string | null;
  cardCount: number;
  practiceCount: number;
  firstCard: Flashcard | null;
};

// Compact summary for the Quick study panel. Decks whose stored content no
// longer parses are skipped rather than rendered broken.
export function studyDeckSummary(decks: Array<{ task: TaskRow; starter: StarterRow }>): StudyDeckSummary[] {
  const summaries: StudyDeckSummary[] = [];
  for (const { task, starter } of decks) {
    const parsed = parseStarterContent("flashcards", starter.content);
    if (!parsed.ok || parsed.data.type !== "flashcards") continue;
    summaries.push({
      taskId: task.id,
      taskTitle: task.title,
      course: task.course,
      cardCount: parsed.data.content.cards.length,
      practiceCount: parsed.data.content.practice.length,
      firstCard: parsed.data.content.cards[0] ?? null,
    });
  }
  return summaries;
}

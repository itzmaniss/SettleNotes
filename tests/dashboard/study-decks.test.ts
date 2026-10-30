import { describe, expect, test } from "bun:test";
import { studyDeckSummary } from "@/lib/dashboard/study-decks";
import { starter, task } from "./fixtures";

const FLASHCARDS = {
  cards: [
    { front: "What is the chain rule?", back: "(f o g)'(x) = f'(g(x)) * g'(x)", page: 12 },
    { front: "Derivative of sin(x)?", back: "cos(x)", page: 13 },
  ],
  practice: [{ question: "Differentiate sin(3x)", answer: "3cos(3x)", page: 14 }],
};

describe("studyDeckSummary", () => {
  test("summarises a valid deck", () => {
    const summaries = studyDeckSummary([
      { task: task({ id: "t1", title: "MA1521 Quiz 2", course: "MA1521" }), starter: starter({ content: FLASHCARDS }) },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      taskId: "t1",
      taskTitle: "MA1521 Quiz 2",
      course: "MA1521",
      cardCount: 2,
      practiceCount: 1,
      firstCard: FLASHCARDS.cards[0],
    });
  });

  test("skips decks whose stored content no longer parses", () => {
    const summaries = studyDeckSummary([
      { task: task(), starter: starter({ content: { cards: "junk" } }) },
      { task: task({ id: "t2" }), starter: starter({ content: FLASHCARDS }) },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].taskId).toBe("t2");
  });

  test("empty deck gives a null first card", () => {
    const summaries = studyDeckSummary([
      { task: task(), starter: starter({ content: { cards: [], practice: [] } }) },
    ]);
    expect(summaries[0].cardCount).toBe(0);
    expect(summaries[0].firstCard).toBeNull();
  });

  test("empty input gives no summaries", () => {
    expect(studyDeckSummary([])).toEqual([]);
  });
});

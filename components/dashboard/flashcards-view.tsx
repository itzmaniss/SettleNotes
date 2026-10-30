"use client";

import { useState } from "react";
import { Chunk, ChunkButton, FlipCard } from "@/components/settle";
import type { Flashcard, FlashcardPracticeItem } from "@/lib/starters/types";
import { MathText } from "./math-text";
import { PracticeReveals } from "./practice-reveals";

type Verdict = "again" | "hard" | "got";

// One card at a time. Again/Hard/Got it only move through local state (no
// persistence yet) and a small summary shows when the deck is finished.
export function FlashcardsView({
  cards,
  practice,
}: {
  cards: Flashcard[];
  practice: FlashcardPracticeItem[];
}) {
  const [index, setIndex] = useState(0);
  const [tallies, setTallies] = useState<Record<Verdict, number>>({ again: 0, hard: 0, got: 0 });

  if (cards.length === 0) {
    return <p className="text-sm text-muted-foreground">This deck has no cards in it yet.</p>;
  }

  if (index >= cards.length) {
    return (
      <Chunk className="p-6 text-center">
        <p className="font-display text-xl font-bold">Deck done.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {cards.length} cards: {tallies.got} got it, {tallies.hard} hard, {tallies.again} to see again.
        </p>
        <ChunkButton
          tone="accent"
          className="mt-5"
          onClick={() => {
            setIndex(0);
            setTallies({ again: 0, hard: 0, got: 0 });
          }}
        >
          Start over
        </ChunkButton>
      </Chunk>
    );
  }

  const card = cards[index];

  function grade(verdict: Verdict) {
    setTallies((current) => ({ ...current, [verdict]: current[verdict] + 1 }));
    setIndex((current) => current + 1);
  }

  return (
    <div>
      <div className="flex items-center justify-between font-mono text-xs uppercase tracking-widest text-muted-foreground">
        <span aria-live="polite">
          Card {index + 1} / {cards.length}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
            disabled={index === 0}
            className="min-h-[44px] rounded-full px-2 font-mono text-xs uppercase tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setIndex((current) => Math.min(cards.length - 1, current + 1))}
            disabled={index === cards.length - 1}
            className="min-h-[44px] rounded-full px-2 font-mono text-xs uppercase tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            Next
          </button>
        </span>
      </div>

      <div className="mt-2">
        {/* key resets the flip so each new card starts on the question side */}
        <FlipCard
          key={index}
          front={
            <span className="flex h-full flex-col items-center justify-center gap-2">
              <span className="text-center font-display text-lg font-bold leading-snug md:text-xl">
                <MathText text={card.front} />
              </span>
              <span className="text-xs text-muted-foreground">tap to flip</span>
            </span>
          }
          back={
            <span className="flex h-full flex-col items-center justify-center gap-2 p-2">
              <span className="text-center text-base leading-relaxed md:text-lg">
                <MathText text={card.back} />
              </span>
              {card.page != null && (
                <span className="font-mono text-xs text-muted-foreground">slide {card.page}</span>
              )}
            </span>
          }
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <ChunkButton tone="card" onClick={() => grade("again")}>
          Again
        </ChunkButton>
        <ChunkButton tone="card" onClick={() => grade("hard")}>
          Hard
        </ChunkButton>
        <ChunkButton tone="accent" onClick={() => grade("got")}>
          Got it
        </ChunkButton>
      </div>

      {practice.length > 0 && (
        <div className="mt-8">
          <PracticeReveals items={practice} />
        </div>
      )}
    </div>
  );
}

// Lecture-slides flashcards starter: one slides PDF in, revision cards plus a
// few practice questions out. Effort medium per ARCHITECTURE 4.5; the caller
// decides what to tell the student when the slides yield nothing.

import type { InputPart, MetaClient, Usage } from '@/lib/meta/client';
import {
  buildFlashcardsUserText,
  FLASHCARDS_SYSTEM_PROMPT,
} from '@/lib/meta/prompts/flashcards';
import {
  checkFlashcardLimits,
  FLASHCARD_LIMITS,
  FlashcardsSchema,
  type Flashcards,
} from './types';

export const FLASHCARDS_SCHEMA_NAME = 'Flashcards';
export const FLASHCARDS_TIMEOUT_MS = 120_000;

export class NoStudyMaterialError extends Error {
  constructor() {
    super('The lecture slides contained no flashcard or practice content');
    this.name = 'NoStudyMaterialError';
  }
}

export class FlashcardsTooThinError extends Error {
  readonly cards: number;
  readonly practice: number;
  constructor(cards: number, practice: number) {
    super(`Flashcards output too thin after the retry: ${cards} cards, ${practice} practice items`);
    this.name = 'FlashcardsTooThinError';
    this.cards = cards;
    this.practice = practice;
  }
}

export type GenerateFlashcardsArgs = {
  userId?: string;
  task: { title: string; course: string | null };
  pdf: { base64: string; filename: string };
};

function clampPage(page: number | null): number | null {
  return page != null && Number.isInteger(page) && page > 0 ? page : null;
}

// The model pads fields with whitespace, returns junk page numbers (0,
// negatives, floats) and repeats fronts; none of that survives this pass.
// Duplicate fronts match case-insensitively and the first occurrence wins.
function normaliseCards(cards: Flashcards['cards']): Flashcards['cards'] {
  const seen = new Set<string>();
  const cleaned: Flashcards['cards'] = [];
  for (const card of cards) {
    const front = card.front.trim();
    const back = card.back.trim();
    if (front === '' || back === '') continue;
    const key = front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ front, back, page: clampPage(card.page) });
  }
  return cleaned;
}

function normalisePractice(practice: Flashcards['practice']): Flashcards['practice'] {
  const seen = new Set<string>();
  const cleaned: Flashcards['practice'] = [];
  for (const item of practice) {
    const question = item.question.trim();
    const answer = item.answer.trim();
    if (question === '' || answer === '') continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ question, answer, page: clampPage(item.page) });
  }
  return cleaned;
}

function truncateToMax<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(0, max) : items;
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    costUsd: a.costUsd + b.costUsd,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

export async function generateFlashcards(
  deps: { generateObject: MetaClient['generateObject'] },
  args: GenerateFlashcardsArgs,
): Promise<{ content: Flashcards; usage: Usage }> {
  const input: InputPart[] = [
    {
      type: 'text',
      text: buildFlashcardsUserText({ title: args.task.title, course: args.task.course }),
    },
    { type: 'pdf', base64: args.pdf.base64, filename: args.pdf.filename },
  ];

  // Both attempts use the identical request so the retry is a pure thickness
  // retry (the Meta client itself already handles bad JSON).
  const call = () =>
    deps.generateObject({
      purpose: 'flashcards',
      userId: args.userId,
      schema: FlashcardsSchema,
      schemaName: FLASHCARDS_SCHEMA_NAME,
      system: FLASHCARDS_SYSTEM_PROMPT,
      input,
      effort: 'medium',
      timeoutMs: FLASHCARDS_TIMEOUT_MS,
    });

  const [cardsMin, cardsMax] = FLASHCARD_LIMITS.cards;
  const [practiceMin, practiceMax] = FLASHCARD_LIMITS.practice;

  const first = await call();
  const firstCards = normaliseCards(first.data.cards);
  const firstPractice = normalisePractice(first.data.practice);

  // Slides with nothing teachable are a user-facing outcome, not a thickness
  // problem; do not spend a second call on them.
  if (firstCards.length === 0 && firstPractice.length === 0) {
    throw new NoStudyMaterialError();
  }

  let cards = truncateToMax(firstCards, cardsMax);
  let practice = truncateToMax(firstPractice, practiceMax);
  let usage = first.usage;

  if (cards.length < cardsMin || practice.length < practiceMin) {
    // Exactly one regeneration, nothing merged in from the first attempt,
    // both usage sums kept for billing accuracy.
    const second = await call();
    usage = sumUsage(first.usage, second.usage);
    cards = truncateToMax(normaliseCards(second.data.cards), cardsMax);
    practice = truncateToMax(normalisePractice(second.data.practice), practiceMax);
  }

  const limits = checkFlashcardLimits({ cards, practice });
  if (!limits.ok) throw new FlashcardsTooThinError(cards.length, practice.length);
  return { content: { cards, practice }, usage };
}

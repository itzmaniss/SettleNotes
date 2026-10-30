// Shared content schemas for every starter type stored in starters.content.
// Everything here compiles to Meta's strict JSON-schema subset: .nullable()
// instead of .optional(), no unions at the root, no min/max keywords. The
// docs snapshot (docs/meta-api/structured-output.md) documents only plain
// objects, arrays, enums and integers under strict mode, so array-length
// bounds and tuple shapes are enforced in code, not in the wire schema.

import { z } from 'zod';

import type { StarterType } from '@/lib/db/types';

// ---------- checklist ----------

export const ChecklistItemSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  category: z.enum(['deliverable', 'submission_rule', 'rubric']),
  page: z.number().int().nullable(),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistSchema = z.strictObject({
  items: z.array(ChecklistItemSchema),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

// ---------- flashcards ----------

// Strict mode does not document minItems/maxItems, so the 10..20 cards and
// 3..5 practice bounds live in this constant and checkFlashcardLimits()
// enforces them after parsing instead of in the wire schema.
export const FLASHCARD_LIMITS = {
  cards: [10, 20],
  practice: [3, 5],
} as const;

export const FlashcardSchema = z.strictObject({
  front: z.string(),
  back: z.string(),
  page: z.number().int().nullable(),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

export const FlashcardPracticeSchema = z.strictObject({
  question: z.string(),
  answer: z.string(),
  page: z.number().int().nullable(),
});
export type FlashcardPracticeItem = z.infer<typeof FlashcardPracticeSchema>;

export const FlashcardsSchema = z.strictObject({
  cards: z.array(FlashcardSchema),
  practice: z.array(FlashcardPracticeSchema),
});
export type Flashcards = z.infer<typeof FlashcardsSchema>;

export type FlashcardLimitResult = { ok: true } | { ok: false; error: string };

export function checkFlashcardLimits(flashcards: Flashcards): FlashcardLimitResult {
  const [cardsMin, cardsMax] = FLASHCARD_LIMITS.cards;
  const cardCount = flashcards.cards.length;
  if (cardCount < cardsMin || cardCount > cardsMax) {
    return {
      ok: false,
      error: `cards: expected ${cardsMin} to ${cardsMax} cards, got ${cardCount}`,
    };
  }
  const [practiceMin, practiceMax] = FLASHCARD_LIMITS.practice;
  const practiceCount = flashcards.practice.length;
  if (practiceCount < practiceMin || practiceCount > practiceMax) {
    return {
      ok: false,
      error: `practice: expected ${practiceMin} to ${practiceMax} items, got ${practiceCount}`,
    };
  }
  return { ok: true };
}

// ---------- math ----------

export const MATH_TOPICS = [
  'algebra_manipulation',
  'sign_errors',
  'fractions',
  'indices',
  'logarithms',
  'differentiation_chain_rule',
  'differentiation_product_quotient',
  'integration_by_parts',
  'integration_substitution',
  'trigonometric_identities',
  'vectors',
  'probability',
  'statistics',
  'complex_numbers',
  'sequences_series',
  'other',
] as const;

export type MathTopic = (typeof MATH_TOPICS)[number];

export const MathTopicSchema = z.enum(MATH_TOPICS);

export const MATH_TOPIC_LABELS: Record<MathTopic, string> = {
  algebra_manipulation: 'Algebra manipulation',
  sign_errors: 'Sign errors',
  fractions: 'Fractions',
  indices: 'Indices',
  logarithms: 'Logarithms',
  differentiation_chain_rule: 'Chain rule',
  differentiation_product_quotient: 'Product and quotient rule',
  integration_by_parts: 'Integration by parts',
  integration_substitution: 'Integration by substitution',
  trigonometric_identities: 'Trigonometric identities',
  vectors: 'Vectors',
  probability: 'Probability',
  statistics: 'Statistics',
  complex_numbers: 'Complex numbers',
  sequences_series: 'Sequences and series',
  other: 'Other',
};

// Bbox on Meta's 0-1000 grounding grid ((0,0) top-left, (1000,1000)
// bottom-right). Strict mode does not document fixed-length arrays or
// tuples (prefixItems), so a box is four named numbers, never [x1, y1, x2, y2].
export type Bbox = { x1: number; y1: number; x2: number; y2: number };

export const BboxSchema = z.strictObject({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});

export type BboxRect = { x1: number; y1: number; x2: number; y2: number };

// Normalises whatever bbox form a caller has into a plain rectangle, so
// annotation code never cares how the box was stored.
export function bboxToRect(bbox: Bbox): BboxRect {
  return { x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2 };
}

export const MathDiagnosisStepSchema = z.strictObject({
  index: z.number().int(),
  latex_or_text: z.string(),
  bbox: BboxSchema.nullable(),
});
export type MathDiagnosisStep = z.infer<typeof MathDiagnosisStepSchema>;

export const MathMisconceptionSchema = z.strictObject({
  topic: MathTopicSchema,
  detail: z.string(),
});
export type MathMisconception = z.infer<typeof MathMisconceptionSchema>;

export const MathPracticeItemSchema = z.strictObject({
  question: z.string(),
  answer: z.string(),
});
export type MathPracticeItem = z.infer<typeof MathPracticeItemSchema>;

export const MathDiagnosisSchema = z.strictObject({
  steps: z.array(MathDiagnosisStepSchema),
  is_correct: z.boolean(),
  first_error_step: z.number().int().nullable(),
  what_went_wrong: z.string().nullable(),
  misconception: MathMisconceptionSchema.nullable(),
  correct_next_step: z.string().nullable(),
  final_answer_check: z.string(),
  practice: z.array(MathPracticeItemSchema),
});
export type MathDiagnosis = z.infer<typeof MathDiagnosisSchema>;

// ---------- review practice ----------

export const ReviewPracticeSchema = z.strictObject({
  topic: MathTopicSchema,
  misconception: z.string(),
  practice: z.array(MathPracticeItemSchema),
});
export type ReviewPractice = z.infer<typeof ReviewPracticeSchema>;

// ---------- registry ----------

export const STARTER_SCHEMAS: Record<StarterType, z.ZodType> = {
  checklist: ChecklistSchema,
  flashcards: FlashcardsSchema,
  math_diagnosis: MathDiagnosisSchema,
  review_practice: ReviewPracticeSchema,
};

export type StarterContent =
  | { type: 'checklist'; content: Checklist }
  | { type: 'flashcards'; content: Flashcards }
  | { type: 'math_diagnosis'; content: MathDiagnosis }
  | { type: 'review_practice'; content: ReviewPractice };

export type ParsedStarterContent =
  | { ok: true; data: StarterContent }
  | { ok: false; error: string };

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'validation failed';
  const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${where}: ${issue.message}`;
}

// Validates stored starters.content JSON (dashboard reads untrusted rows).
// The type tag decides which schema applies and the result keeps the tag so
// callers can narrow on it.
export function parseStarterContent(type: StarterType, content: unknown): ParsedStarterContent {
  switch (type) {
    case 'checklist': {
      const result = ChecklistSchema.safeParse(content);
      return result.success
        ? { ok: true, data: { type, content: result.data } }
        : { ok: false, error: firstIssueMessage(result.error) };
    }
    case 'flashcards': {
      const result = FlashcardsSchema.safeParse(content);
      return result.success
        ? { ok: true, data: { type, content: result.data } }
        : { ok: false, error: firstIssueMessage(result.error) };
    }
    case 'math_diagnosis': {
      const result = MathDiagnosisSchema.safeParse(content);
      return result.success
        ? { ok: true, data: { type, content: result.data } }
        : { ok: false, error: firstIssueMessage(result.error) };
    }
    case 'review_practice': {
      const result = ReviewPracticeSchema.safeParse(content);
      return result.success
        ? { ok: true, data: { type, content: result.data } }
        : { ok: false, error: firstIssueMessage(result.error) };
    }
  }
}

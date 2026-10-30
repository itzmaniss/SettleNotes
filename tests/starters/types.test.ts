import { describe, expect, test } from 'bun:test';
import type { StarterType } from '../../lib/db/types';
import { assertStrictSubset, toStrictJsonSchema } from '../../lib/meta/strict-schema';
import {
  BboxSchema,
  ChecklistSchema,
  FLASHCARD_LIMITS,
  FlashcardsSchema,
  MathDiagnosisSchema,
  MathTopicSchema,
  MATH_TOPICS,
  MATH_TOPIC_LABELS,
  ReviewPracticeSchema,
  STARTER_SCHEMAS,
  bboxToRect,
  checkFlashcardLimits,
  parseStarterContent,
} from '../../lib/starters/types';
import type {
  Bbox,
  Checklist,
  Flashcards,
  MathDiagnosis,
  ReviewPractice,
} from '../../lib/starters/types';

const validChecklist: Checklist = {
  items: [
    { id: 'c1', text: 'Submit report as PDF', category: 'deliverable', page: 2, done: false },
    { id: 'c2', text: 'Name file with matric number', category: 'submission_rule', page: null, done: false },
    { id: 'c3', text: 'Report graded on clarity', category: 'rubric', page: 4, done: false },
  ],
};

function makeFlashcards(cardCount: number, practiceCount: number): Flashcards {
  return {
    cards: Array.from({ length: cardCount }, (_, i) => ({
      front: `Question ${i + 1}`,
      back: `Answer ${i + 1}`,
      page: (i % 9) + 1,
    })),
    practice: Array.from({ length: practiceCount }, (_, i) => ({
      question: `Practice ${i + 1}`,
      answer: `Solution ${i + 1}`,
      page: null,
    })),
  };
}

const validDiagnosis: MathDiagnosis = {
  steps: [
    { index: 1, latex_or_text: 'x^2 + 2x = 3', bbox: null },
    { index: 2, latex_or_text: 'x = 3 + 2x', bbox: { x1: 12, y1: 40, x2: 220, y2: 90 } },
  ],
  is_correct: false,
  first_error_step: 2,
  what_went_wrong: 'Moved 2x to the right without changing the sign',
  misconception: { topic: 'sign_errors', detail: 'Treats moving a term across equals as a free move' },
  correct_next_step: 'Bring every term to one side: x^2 + 2x - 3 = 0, then factorise',
  final_answer_check: 'x = 3 does not satisfy the original equation, so the working is wrong',
  practice: [{ question: 'Solve x^2 + 2x - 3 = 0', answer: 'x = 1 or x = -3' }],
};

const validReview: ReviewPractice = {
  topic: 'fractions',
  misconception: 'Adds numerators and denominators separately',
  practice: [{ question: 'Work out 1/2 + 1/3', answer: '5/6' }],
};

describe('strict subset', () => {
  test('every schema in STARTER_SCHEMAS passes toStrictJsonSchema + assertStrictSubset', () => {
    const types = Object.keys(STARTER_SCHEMAS) as StarterType[];
    expect(types.sort()).toEqual(['checklist', 'flashcards', 'math_diagnosis', 'review_practice']);
    for (const type of types) {
      const jsonSchema = toStrictJsonSchema(STARTER_SCHEMAS[type]);
      expect(() => assertStrictSubset(jsonSchema)).not.toThrow();
    }
  });

  test('the standalone object schemas pass the strict subset check too', () => {
    // MathTopicSchema is a bare enum, nested-only by design: a structured
    // output root must be an object, and it never ships as one.
    for (const schema of [BboxSchema, ChecklistSchema]) {
      expect(() => assertStrictSubset(toStrictJsonSchema(schema))).not.toThrow();
    }
  });

  test('optional-looking fields are nullable on the wire, not omitted from required', () => {
    const jsonSchema = toStrictJsonSchema(MathDiagnosisSchema) as {
      properties: Record<string, { required: string[] }>;
      required: string[];
    };
    expect(jsonSchema.required).toEqual(Object.keys(jsonSchema.properties));
    const steps = toStrictJsonSchema(MathDiagnosisSchema) as never as {
      properties: {
        steps: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    expect(steps.properties.steps.items.required).toEqual(
      Object.keys(steps.properties.steps.items.properties),
    );
  });
});

describe('schema parsing', () => {
  test('valid samples parse unchanged', () => {
    expect(ChecklistSchema.parse(validChecklist)).toEqual(validChecklist);
    expect(FlashcardsSchema.parse(makeFlashcards(10, 3))).toEqual(makeFlashcards(10, 3));
    expect(MathDiagnosisSchema.parse(validDiagnosis)).toEqual(validDiagnosis);
    expect(ReviewPracticeSchema.parse(validReview)).toEqual(validReview);
  });

  test('rejects bad enum values', () => {
    const badCategory = structuredClone(validChecklist);
    badCategory.items[0].category = 'bonus' as Checklist['items'][number]['category'];
    expect(ChecklistSchema.safeParse(badCategory).success).toBe(false);
    expect(MathTopicSchema.safeParse('quantum_chromodynamics').success).toBe(false);
    const badTopic = structuredClone(validReview);
    badTopic.topic = 'philosophy' as ReviewPractice['topic'];
    expect(ReviewPracticeSchema.safeParse(badTopic).success).toBe(false);
  });

  test('rejects unknown keys and missing keys', () => {
    expect(ChecklistSchema.safeParse({ ...validChecklist, extra: 1 }).success).toBe(false);
    const missingDone = structuredClone(validChecklist);
    delete (missingDone.items[0] as { done?: boolean }).done;
    expect(ChecklistSchema.safeParse(missingDone).success).toBe(false);
    expect(FlashcardsSchema.safeParse({ cards: [] }).success).toBe(false);
  });

  test('page and index accept integers and null but reject non-integers', () => {
    const fractional = structuredClone(validChecklist);
    fractional.items[0].page = 2.5;
    expect(ChecklistSchema.safeParse(fractional).success).toBe(false);
    const badStep = structuredClone(validDiagnosis);
    badStep.steps[0].index = 0.5;
    expect(MathDiagnosisSchema.safeParse(badStep).success).toBe(false);
  });

  test('nullable diagnosis fields accept null', () => {
    const allNull: MathDiagnosis = {
      steps: [{ index: 1, latex_or_text: '2 + 2 = 4', bbox: null }],
      is_correct: true,
      first_error_step: null,
      what_went_wrong: null,
      misconception: null,
      correct_next_step: null,
      final_answer_check: '2 + 2 = 4 checks out',
      practice: [],
    };
    expect(MathDiagnosisSchema.safeParse(allNull).success).toBe(true);
  });

  test('bbox accepts the four-corner object form only', () => {
    const box: Bbox = { x1: 0, y1: 10, x2: 500, y2: 1000 };
    expect(BboxSchema.parse(box)).toEqual(box);
    expect(BboxSchema.safeParse({ x1: 1, y1: 2, x2: 3 }).success).toBe(false);
    expect(BboxSchema.safeParse([1, 2, 3, 4]).success).toBe(false);
    expect(BboxSchema.safeParse({ ...box, x3: 9 }).success).toBe(false);
  });

  test('bboxToRect returns a plain rectangle from the object form', () => {
    expect(bboxToRect({ x1: 12, y1: 40, x2: 220, y2: 90 })).toEqual({
      x1: 12,
      y1: 40,
      x2: 220,
      y2: 90,
    });
    expect(bboxToRect({ x1: 0, y1: 0, x2: 1000, y2: 1000 })).toEqual({
      x1: 0,
      y1: 0,
      x2: 1000,
      y2: 1000,
    });
  });
});

describe('MATH_TOPICS and MATH_TOPIC_LABELS', () => {
  test('the taxonomy matches ARCHITECTURE 4.5', () => {
    expect(MATH_TOPICS).toContain('algebra_manipulation');
    expect(MATH_TOPICS).toContain('differentiation_chain_rule');
    expect(MATH_TOPICS).toContain('integration_by_parts');
    expect(MATH_TOPICS).toContain('sign_errors');
    expect(MATH_TOPICS).toContain('other');
    expect(new Set(MATH_TOPICS).size).toBe(MATH_TOPICS.length);
  });

  test('every topic has exactly one human label', () => {
    expect(Object.keys(MATH_TOPIC_LABELS).length).toBe(MATH_TOPICS.length);
    for (const topic of MATH_TOPICS) {
      expect(MATH_TOPIC_LABELS[topic].length).toBeGreaterThan(0);
      expect(MATH_TOPIC_LABELS[topic]).not.toMatch(/[A-Z]{2,}/);
    }
  });
});

describe('flashcard limits', () => {
  test('FLASHCARD_LIMITS is the documented 10..20 cards and 3..5 practice', () => {
    expect(FLASHCARD_LIMITS.cards).toEqual([10, 20]);
    expect(FLASHCARD_LIMITS.practice).toEqual([3, 5]);
  });

  test('accepts the inclusive bounds', () => {
    expect(checkFlashcardLimits(makeFlashcards(10, 3)).ok).toBe(true);
    expect(checkFlashcardLimits(makeFlashcards(20, 5)).ok).toBe(true);
    expect(checkFlashcardLimits(makeFlashcards(15, 4)).ok).toBe(true);
  });

  test('rejects out-of-bounds counts with a message naming the offending array', () => {
    const tooFew = checkFlashcardLimits(makeFlashcards(9, 3));
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.error).toContain('cards');
    const tooMany = checkFlashcardLimits(makeFlashcards(21, 5));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain('21');
    const shortPractice = checkFlashcardLimits(makeFlashcards(10, 2));
    expect(shortPractice.ok).toBe(false);
    if (!shortPractice.ok) expect(shortPractice.error).toContain('practice');
    const longPractice = checkFlashcardLimits(makeFlashcards(10, 6));
    expect(longPractice.ok).toBe(false);
    if (!longPractice.ok) expect(longPractice.error).toContain('practice');
  });
});

describe('parseStarterContent', () => {
  test('ok for every type with its valid sample', () => {
    expect(parseStarterContent('checklist', validChecklist)).toEqual({
      ok: true,
      data: { type: 'checklist', content: validChecklist },
    });
    expect(parseStarterContent('flashcards', makeFlashcards(10, 3)).ok).toBe(true);
    expect(parseStarterContent('math_diagnosis', validDiagnosis).ok).toBe(true);
    expect(parseStarterContent('review_practice', validReview).ok).toBe(true);
  });

  test('error result names the failing path', () => {
    const bad = parseStarterContent('checklist', { items: [{ id: 'c1' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('items.0');
    expect(parseStarterContent('flashcards', validChecklist).ok).toBe(false);
    expect(parseStarterContent('checklist', null).ok).toBe(false);
  });

  test('the ok payload narrows on the type tag', () => {
    const parsed = parseStarterContent('checklist', validChecklist);
    if (parsed.ok && parsed.data.type === 'checklist') {
      expect(parsed.data.content.items).toHaveLength(3);
    } else {
      throw new Error('expected ok checklist result');
    }
  });
});

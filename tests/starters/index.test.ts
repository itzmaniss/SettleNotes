import { describe, expect, test } from 'bun:test';
import type { StarterType } from '../../lib/db/types';
import type { GenerateObjectOptions, MetaClient, Usage } from '../../lib/meta/client';
import { EmptyChecklistError } from '../../lib/starters/checklist';
import {
  STARTER_GENERATORS,
  generateStarterFor,
  pickStarterType,
  registerStarterGenerator,
} from '../../lib/starters/index';

const USAGE: Usage = {
  inputTokens: 1500,
  outputTokens: 400,
  cachedTokens: 600,
  costUsd: 0.005,
  latencyMs: 5400,
};

const TASK = {
  title: 'CS2030 Lab 4',
  course: 'CS2030',
  kind: 'assignment',
  due_at: '2026-10-30T15:59:00.000Z',
};

const PDF = { base64: 'JVBERi0=', filename: 'lab4-brief.pdf' };

function makeFake(data: unknown) {
  const calls: GenerateObjectOptions<unknown>[] = [];
  const generateObject: MetaClient['generateObject'] = async (opts) => {
    calls.push(opts as GenerateObjectOptions<unknown>);
    return { data: data as never, usage: USAGE };
  };
  return { generateObject, calls };
}

function inputFor(overrides?: {
  classified_as?: string | null;
  withPdf?: boolean;
  userId?: string;
}) {
  return {
    userId: overrides?.userId,
    task: TASK,
    upload: {
      classified_as: overrides?.classified_as !== undefined ? overrides.classified_as : 'assignment_brief',
      kind: 'document',
    },
    pdf: overrides?.withPdf === false ? undefined : PDF,
  };
}

describe('pickStarterType', () => {
  test('maps each classification to its starter type', () => {
    expect(pickStarterType({ classified_as: 'assignment_brief', kind: 'document' })).toBe('checklist');
    expect(pickStarterType({ classified_as: 'lecture_slides', kind: 'document' })).toBe('flashcards');
    expect(pickStarterType({ classified_as: 'math_working', kind: 'photo' })).toBe('math_diagnosis');
  });

  test('returns null for anything not starter-worthy', () => {
    expect(pickStarterType({ classified_as: 'chat_screenshot', kind: 'photo' })).toBeNull();
    expect(pickStarterType({ classified_as: 'other', kind: 'document' })).toBeNull();
    expect(pickStarterType({ classified_as: null, kind: 'text' })).toBeNull();
  });
});

describe('generateStarterFor', () => {
  test('assignment_brief with a pdf runs the checklist generator', async () => {
    const fake = makeFake({
      items: [
        { id: 'whatever', text: 'Submit lab4.zip', category: 'submission_rule', page: 1, done: true },
        { id: 'other', text: 'Push to GitHub Classroom', category: 'submission_rule', page: null, done: false },
      ],
    });
    const result = await generateStarterFor(
      { generateObject: fake.generateObject },
      inputFor({ userId: 'user-42' }),
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].purpose).toBe('checklist');
    expect(fake.calls[0].userId).toBe('user-42');
    expect(result).toEqual({
      type: 'checklist',
      content: {
        items: [
          { id: 'c1', text: 'Submit lab4.zip', category: 'submission_rule', page: 1, done: false },
          { id: 'c2', text: 'Push to GitHub Classroom', category: 'submission_rule', page: null, done: false },
        ],
      },
      usage: USAGE,
    });
  });

  test('assignment_brief without a pdf yields null instead of an AI call', async () => {
    const fake = makeFake({ items: [] });
    const result = await generateStarterFor(
      { generateObject: fake.generateObject },
      inputFor({ withPdf: false }),
    );
    expect(result).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  test('unmapped and unregistered types yield null', async () => {
    const fake = makeFake({ items: [] });
    expect(
      await generateStarterFor(
        { generateObject: fake.generateObject },
        inputFor({ classified_as: 'chat_screenshot' }),
      ),
    ).toBeNull();
    // math_diagnosis does not fit the PDF-shaped dispatcher; it runs through
    // lib/pipeline/starters.ts instead. Flashcards are registered now.
    expect(
      await generateStarterFor(
        { generateObject: fake.generateObject },
        inputFor({ classified_as: 'math_working' }),
      ),
    ).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  test('an empty checklist propagates EmptyChecklistError through the dispatcher', async () => {
    const fake = makeFake({ items: [] });
    let caught: unknown = null;
    try {
      await generateStarterFor({ generateObject: fake.generateObject }, inputFor());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmptyChecklistError);
  });

  test('registerStarterGenerator wires new types without editing the registry', async () => {
    const original = STARTER_GENERATORS.flashcards;
    const fakeContent = { cards: [], practice: [] };
    registerStarterGenerator('flashcards', async () => ({ content: fakeContent, usage: USAGE }));
    try {
      const fake = makeFake(null);
      const result = await generateStarterFor(
        { generateObject: fake.generateObject },
        inputFor({ classified_as: 'lecture_slides' }),
      );
      expect(result).toEqual({ type: 'flashcards', content: fakeContent, usage: USAGE });
      expect(fake.calls).toHaveLength(0);
    } finally {
      if (original) {
        STARTER_GENERATORS.flashcards = original;
      } else {
        delete STARTER_GENERATORS.flashcards;
      }
    }
  });

  test('STARTER_GENERATORS registers checklist and flashcards', () => {
    const registered = Object.keys(STARTER_GENERATORS).sort() as StarterType[];
    expect(registered).toEqual(['checklist', 'flashcards']);
  });
});

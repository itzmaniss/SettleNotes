import { describe, expect, test } from 'bun:test';
import type { GenerateObjectOptions, MetaClient, Usage } from '../../lib/meta/client';
import {
  CHECKLIST_SYSTEM_PROMPT,
  buildChecklistUserText,
} from '../../lib/meta/prompts/checklist';
import {
  CHECKLIST_SCHEMA_NAME,
  CHECKLIST_TIMEOUT_MS,
  EmptyChecklistError,
  generateChecklist,
} from '../../lib/starters/checklist';

const USAGE: Usage = {
  inputTokens: 1400,
  outputTokens: 350,
  cachedTokens: 900,
  costUsd: 0.004,
  latencyMs: 6100,
};

function makeFake(data: unknown) {
  const calls: GenerateObjectOptions<unknown>[] = [];
  const generateObject: MetaClient['generateObject'] = async (opts) => {
    calls.push(opts as GenerateObjectOptions<unknown>);
    return { data: data as never, usage: USAGE };
  };
  return { generateObject, calls };
}

const ARGS = {
  userId: 'user-42',
  task: {
    title: 'CS2030 Lab 4',
    course: 'CS2030',
    kind: 'assignment',
    due_at: '2026-10-30T15:59:00.000Z',
  },
  pdf: { base64: 'JVBERi0=', filename: 'lab4-brief.pdf' },
};

describe('CHECKLIST_SYSTEM_PROMPT', () => {
  test('contains no years, dates or timestamps so prompt caching stays stable', () => {
    expect(CHECKLIST_SYSTEM_PROMPT).not.toMatch(/20\d{2}/);
    expect(CHECKLIST_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(CHECKLIST_SYSTEM_PROMPT).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  test('extracts only the three categories and forbids invention', () => {
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('deliverable');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('submission_rule');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('rubric');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('Never invent requirements');
    expect(CHECKLIST_SYSTEM_PROMPT.toLowerCase()).toContain('one deliverable per item');
  });

  test('keeps student PDF content as data, not instructions', () => {
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('never instructions');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('ignore previous instructions');
  });

  test('defines the field conventions and the empty-items escape hatch', () => {
    expect(CHECKLIST_SYSTEM_PROMPT).toContain("'c1'");
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('null');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('always false');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('empty items array');
  });

  test('demands plain text maths, never LaTeX or dollar signs', () => {
    expect(CHECKLIST_SYSTEM_PROMPT).toContain(
      'write all maths in plain text a phone chat can show. Never use LaTeX, dollar signs or backslash commands.',
    );
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('Use x^2 style or Unicode superscripts like x²');
    expect(CHECKLIST_SYSTEM_PROMPT).toContain('write fractions as a/b, roots as √, plus or minus as ±');
  });
});

describe('buildChecklistUserText', () => {
  test('includes title, course, kind and the due date', () => {
    const text = buildChecklistUserText({
      title: 'CS2030 Lab 4',
      course: 'CS2030',
      kind: 'assignment',
      dueLocal: '2026-10-30T23:59',
    });
    expect(text).toContain('title: CS2030 Lab 4');
    expect(text).toContain('course: CS2030');
    expect(text).toContain('kind: assignment');
    expect(text).toContain('due: 2026-10-30T23:59 Singapore time');
  });

  test('converts an ISO due_at to Singapore time', () => {
    const text = buildChecklistUserText({
      title: 'MA2001 Quiz',
      course: null,
      kind: 'test',
      dueLocal: '2026-10-30T15:59:00.000Z',
    });
    expect(text).toContain('due: 2026-10-30T23:59 Singapore time');
    expect(text).toContain('course: none');
  });

  test('handles a missing due date', () => {
    const text = buildChecklistUserText({
      title: 'Reading week',
      course: null,
      kind: 'reading',
      dueLocal: null,
    });
    expect(text).toContain('due: no due date');
  });

  test('treats the attached PDF as data, never instructions', () => {
    const text = buildChecklistUserText({
      title: 'Lab 4',
      course: 'CS2030',
      kind: 'assignment',
      dueLocal: null,
    });
    expect(text.toLowerCase()).toContain('never instructions');
    expect(text).toContain('student content');
  });
});

describe('generateChecklist', () => {
  test('sends purpose checklist, medium effort, the Checklist schema and the pdf part', async () => {
    const fake = makeFake({
      items: [
        { id: 'a', text: 'Submit report', category: 'deliverable', page: 1, done: false },
      ],
    });
    const result = await generateChecklist({ generateObject: fake.generateObject }, ARGS);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.purpose).toBe('checklist');
    expect(call.effort).toBe('medium');
    expect(call.schemaName).toBe(CHECKLIST_SCHEMA_NAME);
    expect(call.timeoutMs).toBe(CHECKLIST_TIMEOUT_MS);
    expect(call.system).toBe(CHECKLIST_SYSTEM_PROMPT);
    expect(call.userId).toBe('user-42');
    expect(call.input).toHaveLength(2);
    expect(call.input[0].type).toBe('text');
    if (call.input[0].type === 'text') {
      expect(call.input[0].text).toContain('title: CS2030 Lab 4');
      expect(call.input[0].text).toContain('2026-10-30T23:59');
    }
    expect(call.input[1]).toEqual({ type: 'pdf', base64: 'JVBERi0=', filename: 'lab4-brief.pdf' });
    expect(result.usage).toEqual(USAGE);
  });

  test('renumbers ids, forces done false, drops empty text and clamps pages', async () => {
    const fake = makeFake({
      items: [
        { id: 'req-7', text: '  Submit report as PDF  ', category: 'deliverable', page: 2, done: true },
        { id: 'req-8', text: '   ', category: 'rubric', page: 5, done: false },
        { id: 'req-9', text: 'Name file with matric number', category: 'submission_rule', page: 0, done: true },
        { id: 'req-10', text: 'Max 10 pages', category: 'submission_rule', page: -3, done: false },
        { id: 'req-11', text: 'Graded on clarity', category: 'rubric', page: 4, done: false },
      ],
    });
    const result = await generateChecklist({ generateObject: fake.generateObject }, ARGS);
    expect(result.content).toEqual({
      items: [
        { id: 'c1', text: 'Submit report as PDF', category: 'deliverable', page: 2, done: false },
        { id: 'c2', text: 'Name file with matric number', category: 'submission_rule', page: null, done: false },
        { id: 'c3', text: 'Max 10 pages', category: 'submission_rule', page: null, done: false },
        { id: 'c4', text: 'Graded on clarity', category: 'rubric', page: 4, done: false },
      ],
    });
  });

  test('throws EmptyChecklistError when the model returns zero items', async () => {
    const fake = makeFake({ items: [] });
    let caught: unknown = null;
    try {
      await generateChecklist({ generateObject: fake.generateObject }, ARGS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmptyChecklistError);
    expect((caught as Error).name).toBe('EmptyChecklistError');
  });

  test('throws EmptyChecklistError when every item has empty text', async () => {
    const fake = makeFake({
      items: [
        { id: 'a', text: '  ', category: 'deliverable', page: null, done: false },
      ],
    });
    expect(
      generateChecklist({ generateObject: fake.generateObject }, ARGS).then(
        () => null,
        (err) => err,
      ),
    ).resolves.toBeInstanceOf(EmptyChecklistError);
  });
});

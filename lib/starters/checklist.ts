// Assignment-brief checklist starter: one PDF in, a to-do checklist out.
// Effort medium per ARCHITECTURE 4.5; the caller decides what to tell the
// student when the brief yields nothing.

import type { InputPart, MetaClient, Usage } from '@/lib/meta/client';
import {
  buildChecklistUserText,
  CHECKLIST_SYSTEM_PROMPT,
} from '@/lib/meta/prompts/checklist';
import { ChecklistSchema, type Checklist } from './types';

export const CHECKLIST_SCHEMA_NAME = 'Checklist';
export const CHECKLIST_TIMEOUT_MS = 120_000;

export class EmptyChecklistError extends Error {
  constructor() {
    super('The assignment brief contained no checklist items');
    this.name = 'EmptyChecklistError';
  }
}

export type GenerateChecklistArgs = {
  userId?: string;
  task: { title: string; course: string | null; kind: string; due_at: string | null };
  pdf: { base64: string; filename: string };
};

// The model sometimes repeats ids, pre-ticks items or returns junk page
// numbers; none of that survives this pass. Ids are renumbered sequentially
// so the dashboard can key checklist rows on them.
function normaliseItems(items: Checklist['items']): Checklist['items'] {
  const cleaned: Checklist['items'] = [];
  for (const item of items) {
    const text = item.text.trim();
    if (text === '') continue;
    const page =
      item.page != null && Number.isInteger(item.page) && item.page > 0 ? item.page : null;
    cleaned.push({
      id: `c${cleaned.length + 1}`,
      text,
      category: item.category,
      page,
      done: false,
    });
  }
  return cleaned;
}

export async function generateChecklist(
  deps: { generateObject: MetaClient['generateObject'] },
  args: GenerateChecklistArgs,
): Promise<{ content: Checklist; usage: Usage }> {
  const input: InputPart[] = [
    {
      type: 'text',
      text: buildChecklistUserText({
        title: args.task.title,
        course: args.task.course,
        kind: args.task.kind,
        dueLocal: args.task.due_at,
      }),
    },
    { type: 'pdf', base64: args.pdf.base64, filename: args.pdf.filename },
  ];

  const { data, usage } = await deps.generateObject({
    purpose: 'checklist',
    userId: args.userId,
    schema: ChecklistSchema,
    schemaName: CHECKLIST_SCHEMA_NAME,
    system: CHECKLIST_SYSTEM_PROMPT,
    input,
    effort: 'medium',
    timeoutMs: CHECKLIST_TIMEOUT_MS,
  });

  const items = normaliseItems(data.items);
  if (items.length === 0) throw new EmptyChecklistError();
  return { content: { items }, usage };
}

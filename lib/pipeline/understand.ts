import type { InputPart, MetaClient, Usage } from '@/lib/meta/client';
import {
  buildUnderstandUserText,
  UNDERSTAND_SYSTEM_PROMPT,
} from '@/lib/meta/prompts/understand';
import { utcToSgtLocal } from '@/lib/pipeline/dates';
import { z } from 'zod';

export type UnderstandAction = {
  type: 'create' | 'update' | 'complete' | 'none';
  task_ref: string | null;
  title: string | null;
  course: string | null;
  kind: 'assignment' | 'test' | 'reading' | 'math_practice' | 'other' | null;
  due_local: string | null;
  effort: 'small' | 'medium' | 'large' | null;
  evidence: string;
  confidence: number;
};

export type UnderstandOutput = {
  input_kind:
    | 'chat_screenshot'
    | 'assignment_brief'
    | 'lecture_slides'
    | 'math_working'
    | 'plain_message'
    | 'other';
  extracted_text: string;
  actions: UnderstandAction[];
  needs_clarification: string | null;
};

export type UnderstandOpenTask = {
  id: string;
  title: string;
  course: string | null;
  kind: string;
  due_at: string | null;
};

export type UnderstandArgs = {
  userId?: string;
  now: Date;
  openTasks: UnderstandOpenTask[];
  text?: string | null;
  image?: { base64: string; mimeType?: string };
  pdf?: { base64: string; filename: string };
};

export type UnderstandResult = {
  output: UnderstandOutput;
  /** Short prompt refs ("T1", "T2", ...) in openTasks order, mapped back to real task ids. */
  refToTaskId: Record<string, string>;
  usage: Usage;
};

export const UNDERSTAND_SCHEMA_NAME = 'UnderstandOutput';

// No .optional() anywhere: strict-mode schemas express optionality with
// .nullable() so every key stays in `required`. confidence is a plain number
// here (no minimum/maximum keywords in strict mode); the 0..1 range is
// clamped in code after parsing.
export const UnderstandActionSchema = z.strictObject({
  type: z.enum(['create', 'update', 'complete', 'none']),
  task_ref: z.string().nullable(),
  title: z.string().nullable(),
  course: z.string().nullable(),
  kind: z.enum(['assignment', 'test', 'reading', 'math_practice', 'other']).nullable(),
  due_local: z.string().nullable(),
  effort: z.enum(['small', 'medium', 'large']).nullable(),
  evidence: z.string(),
  confidence: z.number(),
});

export const UnderstandOutputSchema: z.ZodType<UnderstandOutput> = z.strictObject({
  input_kind: z.enum([
    'chat_screenshot',
    'assignment_brief',
    'lecture_slides',
    'math_working',
    'plain_message',
    'other',
  ]),
  extracted_text: z.string(),
  actions: z.array(UnderstandActionSchema),
  needs_clarification: z.string().nullable(),
});

function clampConfidence(output: UnderstandOutput): UnderstandOutput {
  const actions = output.actions.map((action) => ({
    ...action,
    confidence: Math.min(1, Math.max(0, action.confidence)),
  }));
  return { ...output, actions };
}

export async function understand(
  deps: { generateObject: MetaClient['generateObject'] },
  args: UnderstandArgs,
): Promise<UnderstandResult> {
  const refToTaskId: Record<string, string> = {};
  const promptTasks = args.openTasks.map((task, index) => {
    const ref = `T${index + 1}`;
    refToTaskId[ref] = task.id;
    return {
      ref,
      title: task.title,
      course: task.course,
      kind: task.kind,
      // Deadlines are shown to the model in SGT wall-clock terms; they stay
      // local strings in the prompt and are converted to UTC downstream.
      due_local: task.due_at == null ? null : utcToSgtLocal(task.due_at),
    };
  });

  const userText = buildUnderstandUserText({
    now: args.now,
    openTasks: promptTasks,
    text: args.text ?? null,
    hasImage: args.image != null,
    hasPdf: args.pdf != null,
  });

  const input: InputPart[] = [{ type: 'text', text: userText }];
  if (args.image != null) {
    input.push({ type: 'image', base64: args.image.base64, mimeType: args.image.mimeType });
  }
  if (args.pdf != null) {
    input.push({ type: 'pdf', base64: args.pdf.base64, filename: args.pdf.filename });
  }

  const hasDocument = args.image != null || args.pdf != null;
  const { data, usage } = await deps.generateObject({
    purpose: 'understand',
    userId: args.userId,
    schema: UnderstandOutputSchema,
    schemaName: UNDERSTAND_SCHEMA_NAME,
    system: UNDERSTAND_SYSTEM_PROMPT,
    input,
    effort: hasDocument ? 'medium' : 'low',
  });

  return { output: clampConfidence(data), refToTaskId, usage };
}

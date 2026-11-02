import type { InputPart, MetaClient, ReasoningEffort, Usage } from '@/lib/meta/client';
import {
  buildUnderstandUserText,
  UNDERSTAND_SYSTEM_PROMPT,
} from '@/lib/meta/prompts/understand';
import type { ConversationTurn } from '@/lib/pipeline/conversation';
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
  // Plain-text answer for questions about what Settle did or about the open
  // tasks. Null whenever any real action was returned (actions win).
  answer_to_student: string | null;
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
  // Earlier turns of this conversation, oldest first, so a short follow up is
  // read together with the question it answers. Only ever plain text messages.
  recentExchange?: ConversationTurn[];
  // Optional faster model for text only calls (no image, no pdf). When unset
  // the client's default model is used, exactly as before. Never applied to
  // image or pdf calls, which stay on the default model at effort medium.
  textModel?: string;
  // Optional reasoning effort for text only calls. Unset means 'low'.
  textEffort?: ReasoningEffort;
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
  answer_to_student: z.string().nullable(),
});

// Guard rails for the plain-text answer: one line of plain text, capped, and
// never sent when the model also produced a real action (actions win). An
// empty or whitespace-only answer counts as none.
const ANSWER_MAX_CHARS = 400;

function hasRealAction(actions: UnderstandAction[]): boolean {
  return actions.some((action) => action.type !== 'none');
}

function normaliseAnswer(answer: string | null, actions: UnderstandAction[]): string | null {
  if (answer == null || hasRealAction(actions)) return null;
  const flat = answer.trim().replace(/\s+/g, ' ');
  if (flat.length === 0) return null;
  return flat.length > ANSWER_MAX_CHARS ? flat.slice(0, ANSWER_MAX_CHARS) : flat;
}

function clampConfidence(output: UnderstandOutput): UnderstandOutput {
  const actions = output.actions.map((action) => ({
    ...action,
    confidence: Math.min(1, Math.max(0, action.confidence)),
  }));
  return {
    ...output,
    actions,
    answer_to_student: normaliseAnswer(output.answer_to_student, actions),
  };
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
    recentExchange: args.recentExchange,
  });

  const input: InputPart[] = [{ type: 'text', text: userText }];
  if (args.image != null) {
    input.push({ type: 'image', base64: args.image.base64, mimeType: args.image.mimeType });
  }
  if (args.pdf != null) {
    input.push({ type: 'pdf', base64: args.pdf.base64, filename: args.pdf.filename });
  }

  const hasDocument = args.image != null || args.pdf != null;
  // Text only calls may run on the faster configured text model; image and
  // pdf calls always stay on the default model at effort medium.
  const { data, usage } = await deps.generateObject({
    purpose: 'understand',
    userId: args.userId,
    schema: UnderstandOutputSchema,
    schemaName: UNDERSTAND_SCHEMA_NAME,
    system: UNDERSTAND_SYSTEM_PROMPT,
    input,
    effort: hasDocument ? 'medium' : (args.textEffort ?? 'low'),
    ...(hasDocument || args.textModel == null ? {} : { model: args.textModel }),
  });

  return { output: clampConfidence(data), refToTaskId, usage };
}

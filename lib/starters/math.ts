// Math working diagnosis starter: one normalised photo in, a step-by-step
// verdict out, plus an annotated copy of the photo with the first wrong step
// circled. Effort high and a 200s timeout per ARCHITECTURE 4.5. The caption
// the student sent with the photo, if any, is treated as the expected answer.
// The Telegram wiring plugs into diagnoseAndAnnotate in a later card.

import type { InputPart, MetaClient, Usage } from '@/lib/meta/client';
import { annotateMathPhoto } from '@/lib/media/annotate';
import { buildMathUserText, MATH_SYSTEM_PROMPT } from '@/lib/meta/prompts/math';
import { toPlainMath } from '@/lib/text/plain-math';
import { normalizeTopic } from './math-topics';
import {
  MATH_TOPIC_LABELS,
  MathDiagnosisSchema,
  type Bbox,
  type MathDiagnosis,
} from './types';

export const MATH_SCHEMA_NAME = 'MathDiagnosis';
export const MATH_TIMEOUT_MS = 200_000;
export const PRACTICE_MAX = 3;
// Telegram photo captions cap at 1024 characters.
export const CAPTION_MAX_CHARS = 1024;

const GRID_MAX = 1000;
const BBOX_MIN_SIDE_GRID = 5;

export type DiagnoseMathArgs = {
  userId?: string;
  image: { buffer: Buffer; width: number; height: number };
  caption: string | null;
};

export type DiagnoseMathResult = {
  content: MathDiagnosis;
  usage: Usage;
  unreadable: boolean;
};

function clampGrid(value: number): number {
  return Math.min(GRID_MAX, Math.max(0, value));
}

// Clamps into the 0-1000 grid, swaps inverted corners, and drops boxes too
// small to circle usefully (zero area or either side under 5 grid units).
function repairBbox(bbox: Bbox | null): Bbox | null {
  if (bbox == null) return null;
  if (![bbox.x1, bbox.y1, bbox.x2, bbox.y2].every(Number.isFinite)) return null;
  const x1 = clampGrid(Math.min(bbox.x1, bbox.x2));
  const x2 = clampGrid(Math.max(bbox.x1, bbox.x2));
  const y1 = clampGrid(Math.min(bbox.y1, bbox.y2));
  const y2 = clampGrid(Math.max(bbox.y1, bbox.y2));
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < BBOX_MIN_SIDE_GRID || height < BBOX_MIN_SIDE_GRID) return null;
  return { x1, y1, x2, y2 };
}

// The model pads fields, sends duplicate or missing step indexes, invents
// boxes outside the grid, and mislabels topics; none of that survives here.
// Steps are sorted by index and renumbered 1..n when the indexes are not
// already sequential, with first_error_step remapped through the renumbering.
export function repairDiagnosis(d: MathDiagnosis): MathDiagnosis {
  const sorted = [...d.steps].sort((a, b) => a.index - b.index);
  const sequential = sorted.every((step, i) => step.index === i + 1);
  const oldToNew = new Map<number, number>();
  const steps = sorted.map((step, i) => {
    const index = sequential ? step.index : i + 1;
    oldToNew.set(step.index, index);
    return {
      index,
      latex_or_text: step.latex_or_text.trim(),
      bbox: repairBbox(step.bbox),
    };
  });

  let firstErrorStep = d.first_error_step;
  if (firstErrorStep != null && oldToNew.has(firstErrorStep)) {
    firstErrorStep = oldToNew.get(firstErrorStep) ?? null;
  }

  const isCorrect = d.is_correct === true;
  if (isCorrect) {
    firstErrorStep = null;
  } else if (firstErrorStep != null && !steps.some((step) => step.index === firstErrorStep)) {
    // Keep the text; the annotator skips the ring but the reply still works.
    firstErrorStep = null;
  }

  const misconception =
    isCorrect || d.misconception == null
      ? null
      : {
          topic: normalizeTopic(d.misconception.topic),
          detail: d.misconception.detail.trim(),
        };

  const practice: MathDiagnosis['practice'] = [];
  for (const item of d.practice) {
    if (practice.length >= PRACTICE_MAX) break;
    const question = item.question.trim();
    const answer = item.answer.trim();
    if (question === '' || answer === '') continue;
    practice.push({ question, answer });
  }

  return {
    steps,
    is_correct: isCorrect,
    first_error_step: firstErrorStep,
    what_went_wrong: isCorrect || d.what_went_wrong == null ? null : d.what_went_wrong.trim(),
    misconception,
    correct_next_step:
      isCorrect || d.correct_next_step == null ? null : d.correct_next_step.trim(),
    final_answer_check: d.final_answer_check.trim(),
    practice,
  };
}

// Telegram captions must never carry typographic dashes.
function plain(text: string): string {
  return text.replace(/\u2014|\u2013/g, '-');
}

// Only a leading possessive is deterministically safe to rewrite: "The
// student's final answers ..." becomes "Your final answers ...". A bare
// "The student" needs a grammar fix no regex can make ("You is correct"),
// so that stays with the prompt rule to prevent.
export function toSecondPerson(text: string): string {
  return text.replace(/^The student's\b/i, 'Your');
}

// The one safety funnel every model-written verdict line goes through on the
// way OUT to the student: typographic dashes to plain hyphens, the leading
// possessive to second person, and any LaTeX the model still emitted to
// plain phone text. Stored rows are never touched by this.
function studentSafe(text: string): string {
  return toPlainMath(plain(toSecondPerson(text)));
}

export function diagnosisCaption(d: MathDiagnosis): string {
  if (d.steps.length === 0) {
    return "I couldn't read that working clearly. Could you send a sharper photo, with the page flat and well lit?";
  }

  let out: string;
  if (d.is_correct) {
    out = `Every step checks out. ${studentSafe(d.final_answer_check)}`.trim();
  } else {
    const lead =
      d.first_error_step != null
        ? `Step ${d.first_error_step} is where it slipped: ${d.what_went_wrong ?? ''}`
        : `This is where it slipped: ${d.what_went_wrong ?? ''}`;
    const parts = [studentSafe(lead.trim())];
    if (d.misconception != null) {
      parts.push(
        studentSafe(
          `Why it matters: ${d.misconception.detail} (${MATH_TOPIC_LABELS[d.misconception.topic]})`,
        ).trim(),
      );
    }
    if (d.correct_next_step != null) {
      parts.push(studentSafe(`Try this instead: ${d.correct_next_step}`).trim());
    }
    out = parts.join('\n\n');
  }

  out = plain(out).trim();
  if (out.length > CAPTION_MAX_CHARS) {
    out = `${out.slice(0, CAPTION_MAX_CHARS - 3)}...`;
  }
  return out;
}

export function diagnosisPracticeText(d: MathDiagnosis): string | null {
  if (d.practice.length === 0) return null;
  const lines: string[] = [`${d.practice.length} to try:`];
  d.practice.forEach((item, i) => lines.push(`${i + 1}. ${studentSafe(item.question)}`));
  lines.push('');
  lines.push('Answers:');
  d.practice.forEach((item, i) => lines.push(`${i + 1}. ${studentSafe(item.answer)}`));
  return lines.join('\n');
}

export async function diagnoseMath(
  deps: { generateObject: MetaClient['generateObject'] },
  args: DiagnoseMathArgs,
): Promise<DiagnoseMathResult> {
  // The image is already normalised by normalizeImage, so it is base64 JPEG.
  const input: InputPart[] = [
    { type: 'text', text: buildMathUserText({ caption: args.caption }) },
    {
      type: 'image',
      base64: args.image.buffer.toString('base64'),
      mimeType: 'image/jpeg',
    },
  ];

  const { data, usage } = await deps.generateObject({
    purpose: 'math',
    userId: args.userId,
    schema: MathDiagnosisSchema,
    schemaName: MATH_SCHEMA_NAME,
    system: MATH_SYSTEM_PROMPT,
    input,
    effort: 'high',
    timeoutMs: MATH_TIMEOUT_MS,
  });

  const content = repairDiagnosis(data);
  return { content, usage, unreadable: content.steps.length === 0 };
}

export type DiagnoseAndAnnotateResult = {
  content: MathDiagnosis;
  annotated: Buffer | null;
  caption: string;
  practiceText: string | null;
  usage: Usage;
  unreadable: boolean;
};

// Full math-reply orchestration: diagnose, then circle the first wrong step
// when it has a usable box. annotated is null when there is nothing to circle
// (correct, unreadable, or no bbox); the caller then sends text or the
// original photo instead.
export async function diagnoseAndAnnotate(
  deps: { generateObject: MetaClient['generateObject'] },
  args: DiagnoseMathArgs,
): Promise<DiagnoseAndAnnotateResult> {
  const { content, usage, unreadable } = await diagnoseMath(deps, args);

  const step =
    content.first_error_step == null
      ? undefined
      : content.steps.find((s) => s.index === content.first_error_step);
  const annotated =
    step != null && step.bbox != null
      ? await annotateMathPhoto({
          buffer: args.image.buffer,
          width: args.image.width,
          height: args.image.height,
          bbox: step.bbox,
          stepNumber: step.index,
        })
      : null;

  return {
    content,
    annotated,
    caption: diagnosisCaption(content),
    practiceText: diagnosisPracticeText(content),
    usage,
    unreadable,
  };
}

// Starter dispatcher. pickStarterType maps an upload's classification to the
// starter it should produce; STARTER_GENERATORS holds the implementations.
// Checklist and flashcards are PDF-shaped (one document in, content out), so
// they live here. math_diagnosis does not fit that dispatcher: it takes an
// image plus annotation and storage work, so lib/pipeline/starters.ts runs it
// directly instead of going through this registry. review_practice is never
// uploaded-sourced either: the weak-spot tracker creates those. Unmapped or
// unregistered types yield null and the caller skips the starter step.

import type { StarterType } from '@/lib/db/types';
import type { MetaClient, Usage } from '@/lib/meta/client';
import { generateChecklist } from './checklist';
import { generateFlashcards } from './flashcards';

export type StarterTaskContext = {
  title: string;
  course: string | null;
  kind: string;
  due_at: string | null;
};

export type StarterUploadContext = {
  classified_as: string | null;
  kind: string;
};

export type StarterGeneratorInput = {
  userId?: string;
  task: StarterTaskContext;
  upload: StarterUploadContext;
  pdf?: { base64: string; filename: string };
  image?: { base64: string; mimeType?: string };
};

export type StarterDeps = {
  generateObject: MetaClient['generateObject'];
};

export type StarterGeneratorResult = {
  type: StarterType;
  content: unknown;
  usage: Usage;
};

export type StarterGenerator = (
  deps: StarterDeps,
  input: StarterGeneratorInput,
) => Promise<{ content: unknown; usage: Usage } | null>;

// Pure mapping so callers can preview the starter type before spending an AI
// call. review_practice is never picked here: the weak-spot tracker creates
// those tasks from past diagnoses, not from a new upload.
export function pickStarterType(upload: StarterUploadContext): StarterType | null {
  switch (upload.classified_as) {
    case 'assignment_brief':
      return 'checklist';
    case 'lecture_slides':
      return 'flashcards';
    case 'math_working':
      return 'math_diagnosis';
    default:
      return null;
  }
}

export const STARTER_GENERATORS: Partial<Record<StarterType, StarterGenerator>> = {
  checklist: async (deps, input) => {
    if (input.pdf == null) return null;
    const { content, usage } = await generateChecklist(deps, {
      userId: input.userId,
      task: input.task,
      pdf: input.pdf,
    });
    return { content, usage };
  },
  flashcards: async (deps, input) => {
    if (input.pdf == null) return null;
    const { content, usage } = await generateFlashcards(deps, {
      userId: input.userId,
      task: input.task,
      pdf: input.pdf,
    });
    return { content, usage };
  },
};

// Wiring hook for starter types added outside the registry literal above
// (tests and later cards use this instead of editing the object).
export function registerStarterGenerator(type: StarterType, generator: StarterGenerator): void {
  STARTER_GENERATORS[type] = generator;
}

export async function generateStarterFor(
  deps: StarterDeps,
  input: StarterGeneratorInput,
): Promise<StarterGeneratorResult | null> {
  const type = pickStarterType(input.upload);
  if (type == null) return null;
  const generator = STARTER_GENERATORS[type];
  if (generator == null) return null;
  const result = await generator(deps, input);
  if (result == null) return null;
  return { type, content: result.content, usage: result.usage };
}

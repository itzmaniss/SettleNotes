// Question source for the review quiz. The stored practice set rides on the
// review task itself: recordWeakSpot writes a review_practice starter onto
// every review task it creates or reschedules, so the quiz reads that starter
// first. Only when nothing usable is stored does this make ONE text-only
// model call for fresh questions on the weak spot. Every dependency is
// injected so tests run against fakes; failures come back as one typed error
// the caller turns into a friendly line.

import "server-only";

import type { MetaClient } from "@/lib/meta/client";
import {
  REVIEW_QUIZ_SYSTEM_PROMPT,
  buildReviewQuizUserText,
} from "@/lib/meta/prompts/review";
import type { StarterRow } from "@/lib/db/types";
import { getStarter as realGetStarter } from "@/lib/db/queries";
import { ReviewPracticeSchema } from "@/lib/starters/types";
import { z } from "zod";

// The shape lib/weakspots/review-quiz.ts stores in a session.
export type ReviewQuizQuestion = { question: string; answer: string };

// Strict mode has no minItems/maxItems, so the length cap is enforced in
// code after parsing, like every other starter schema.
const FreshQuestionsSchema = z.strictObject({
  questions: z.array(
    z.strictObject({
      question: z.string(),
      answer: z.string(),
    }),
  ),
});
type FreshQuestions = z.infer<typeof FreshQuestionsSchema>;

// One typed error for every way the quiz cannot get questions: no usable
// stored set, a failed or garbled model call, or a model answer with no
// usable questions. The caller maps it to the setup-failed line.
export class ReviewQuizSetupError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ReviewQuizSetupError";
    if (cause !== undefined) this.cause = cause;
  }
}

export type LoadReviewQuestionsDeps = {
  getStarter: (taskId: string) => Promise<StarterRow | null>;
  generateObject: MetaClient["generateObject"];
};

export type LoadReviewQuestionsArgs = {
  userId: string;
  reviewTaskId: string;
  // Plain-words topic label and the misconception detail, both read from the
  // weak spot row, used only by the fresh generation path.
  topicLabel: string;
  misconception: string;
};

function usable(items: Array<{ question: string; answer: string }>): ReviewQuizQuestion[] {
  return items
    .map((item) => ({ question: item.question.trim(), answer: item.answer.trim() }))
    .filter((item) => item.question !== "" && item.answer !== "")
    .slice(0, 3);
}

// Stored first: the review task's own review_practice starter. A starter of
// another type, a starter that fails validation or an empty practice list all
// fall through to fresh generation.
async function storedQuestions(
  deps: LoadReviewQuestionsDeps,
  reviewTaskId: string,
): Promise<ReviewQuizQuestion[] | null> {
  let starter: StarterRow | null;
  try {
    starter = await deps.getStarter(reviewTaskId);
  } catch (error) {
    throw new ReviewQuizSetupError("reading the review starter failed", error);
  }
  if (starter == null || starter.type !== "review_practice") return null;
  const parsed = ReviewPracticeSchema.safeParse(starter.content);
  if (!parsed.success) return null;
  const items = usable(parsed.data.practice);
  return items.length > 0 ? items : null;
}

async function freshQuestions(
  deps: LoadReviewQuestionsDeps,
  args: LoadReviewQuestionsArgs,
): Promise<ReviewQuizQuestion[]> {
  let data: FreshQuestions;
  try {
    const result = await deps.generateObject({
      purpose: "math",
      userId: args.userId,
      schema: FreshQuestionsSchema,
      schemaName: "review_quiz_questions",
      system: REVIEW_QUIZ_SYSTEM_PROMPT,
      input: [
        {
          type: "text",
          text: buildReviewQuizUserText({
            topicLabel: args.topicLabel,
            misconception: args.misconception,
          }),
        },
      ],
      effort: "low",
    });
    // The client validates already; this second parse keeps the stored shape
    // safe even when a test fake or a future client skips that step.
    const parsed = FreshQuestionsSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new ReviewQuizSetupError("the model questions failed validation");
    }
    data = parsed.data;
  } catch (error) {
    if (error instanceof ReviewQuizSetupError) throw error;
    throw new ReviewQuizSetupError("generating review questions failed", error);
  }
  const items = usable(data.questions);
  if (items.length === 0) {
    throw new ReviewQuizSetupError("the model returned no usable questions");
  }
  return items;
}

export async function loadReviewQuestions(
  deps: LoadReviewQuestionsDeps,
  args: LoadReviewQuestionsArgs,
): Promise<ReviewQuizQuestion[]> {
  const stored = await storedQuestions(deps, args.reviewTaskId);
  if (stored != null) return stored;
  return freshQuestions(deps, args);
}

// Real deps bound at call time: the db wrapper resolves its client inside its
// body and getMetaClient builds the model client lazily, so importing this
// module never touches the environment.
export function createReviewQuestionDeps(): LoadReviewQuestionsDeps {
  return {
    getStarter: realGetStarter,
    generateObject: async (opts) => {
      const { getMetaClient } = await import("@/lib/meta/index");
      return getMetaClient().generateObject(opts);
    },
  };
}

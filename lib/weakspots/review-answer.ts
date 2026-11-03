// Answer checking for the review quiz. A deterministic shortcut settles the
// obvious cases (same value, different spacing, minus or superscript style)
// with no model call at all; everything else gets ONE small text-only model
// call. The model's feedback is plain maths text, second person, and capped,
// because the student reads it verbatim. Dependencies are injected so tests
// run against fakes.

import "server-only";

import type { MetaClient } from "@/lib/meta/client";
import {
  REVIEW_CHECK_SYSTEM_PROMPT,
  buildReviewCheckUserText,
} from "@/lib/meta/prompts/review";
import { toPlainMath } from "@/lib/text/plain-math";
import { z } from "zod";

export type ReviewCheckVerdict = "correct" | "almost" | "wrong";

export type ReviewCheckResult = {
  verdict: ReviewCheckVerdict;
  feedback: string;
};

// Any failed or garbled model call becomes this one typed error; the caller
// keeps the session alive and answers with the AI-busy line.
export class ReviewCheckError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ReviewCheckError";
    if (cause !== undefined) this.cause = cause;
  }
}

const FEEDBACK_MAX_CHARS = 200;

// Strict mode has no enum-of-strings length caps on strings, so the 200 char
// feedback cap is enforced in code after parsing.
const CheckSchema = z.strictObject({
  verdict: z.enum(["correct", "almost", "wrong"]),
  feedback: z.string(),
});
type CheckOutput = z.infer<typeof CheckSchema>;

const MINUS_LIKE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const SUPERSCRIPT_RUN = /[\u2070\u00b9\u00b2\u00b3\u2074-\u2079\u207b]+/g;
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "\u2070": "0",
  "\u00b9": "1",
  "\u00b2": "2",
  "\u00b3": "3",
  "\u2074": "4",
  "\u2075": "5",
  "\u2076": "6",
  "\u2077": "7",
  "\u2078": "8",
  "\u2079": "9",
  "\u207b": "-",
};

// One normal form for both sides: lower case, no whitespace, every dash-like
// character the same minus, every superscript run the same ^d form (so x^2
// and x² meet). Only ever used for comparison, never shown to the student.
export function normaliseAnswer(text: string): string {
  let out = text.toLowerCase().replace(MINUS_LIKE, "-");
  out = out.replace(SUPERSCRIPT_RUN, (run) => {
    const digits = [...run].map((ch) => SUPERSCRIPT_DIGITS[ch] ?? "").join("");
    return `^${digits}`;
  });
  return out.replace(/\s+/g, "");
}

// The value after the last equals sign, so "x=4" and "4" meet. No equals
// sign means the whole normalised text is the only candidate.
function valueCandidates(normalised: string): string[] {
  const at = normalised.lastIndexOf("=");
  if (at === -1 || at === normalised.length - 1) return [normalised];
  const value = normalised.slice(at + 1);
  return value === "" ? [normalised] : [normalised, value];
}

export type ShortcutCheck = { shortcut: true; result: ReviewCheckResult } | { shortcut: false };

// The fast path: an exact match of the normalised answer, or a match of the
// expected answer's final value, is correct with no model call. A blank
// answer is wrong with no model call either.
export function shortcutCheck(expected: string, studentAnswer: string): ShortcutCheck {
  const trimmed = studentAnswer.trim();
  if (trimmed === "") {
    return {
      shortcut: true,
      result: {
        verdict: "wrong",
        feedback: capFeedback(`You did not type an answer. The answer was ${toPlainMath(expected.trim())}.`),
      },
    };
  }
  const a = normaliseAnswer(expected);
  const b = normaliseAnswer(trimmed);
  if (a === "" || b === "") return { shortcut: false };
  const left = valueCandidates(a);
  const right = valueCandidates(b);
  if (left.some((v) => right.includes(v))) {
    return { shortcut: true, result: { verdict: "correct", feedback: capFeedback("Correct.") } };
  }
  return { shortcut: false };
}

// Second person, plain maths, capped: whatever the model wrote, the student
// reads exactly this.
function capFeedback(feedback: string): string {
  const plain = toPlainMath(feedback).trim();
  return plain.length > FEEDBACK_MAX_CHARS
    ? `${plain.slice(0, FEEDBACK_MAX_CHARS - 3)}...`
    : plain;
}

const FALLBACK_FEEDBACK: Record<ReviewCheckVerdict, string> = {
  correct: "Correct.",
  almost: "Close. Check that step once more.",
  wrong: "Not this one.",
};

export type ReviewCheckDeps = {
  generateObject: MetaClient["generateObject"];
};

export type ReviewCheckArgs = {
  userId: string;
  question: string;
  expected: string;
  studentAnswer: string;
};

export async function checkReviewAnswer(
  deps: ReviewCheckDeps,
  args: ReviewCheckArgs,
): Promise<ReviewCheckResult> {
  const shortcut = shortcutCheck(args.expected, args.studentAnswer);
  if (shortcut.shortcut) return shortcut.result;

  let data: CheckOutput;
  try {
    const result = await deps.generateObject({
      purpose: "math",
      userId: args.userId,
      schema: CheckSchema,
      schemaName: "review_answer_check",
      system: REVIEW_CHECK_SYSTEM_PROMPT,
      input: [
        {
          type: "text",
          text: buildReviewCheckUserText({
            question: args.question,
            expected: args.expected,
            studentAnswer: args.studentAnswer,
          }),
        },
      ],
      effort: "minimal",
    });
    data = result.data;
  } catch (error) {
    throw new ReviewCheckError("checking the review answer failed", error);
  }
  const feedback = capFeedback(data.feedback);
  return {
    verdict: data.verdict,
    feedback: feedback !== "" ? feedback : FALLBACK_FEEDBACK[data.verdict],
  };
}

// Real deps bound at call time, so importing this module never touches the
// environment.
export function createReviewCheckDeps(): ReviewCheckDeps {
  return {
    generateObject: async (opts) => {
      const { getMetaClient } = await import("@/lib/meta/index");
      return getMetaClient().generateObject(opts);
    },
  };
}

import { describe, expect, test } from "bun:test";
import type { MetaClient } from "../../lib/meta/client";
import {
  ReviewCheckError,
  checkReviewAnswer,
  normaliseAnswer,
  shortcutCheck,
} from "../../lib/weakspots/review-answer";

// A generateObject fake with the client's generic signature; records every
// call so tests can assert purpose, effort and prompt text.
function modelReturning(
  data: unknown,
  calls: Array<Record<string, unknown>> = [],
): MetaClient["generateObject"] {
  const fn = async (opts: Record<string, unknown>) => {
    calls.push(opts);
    return { data, usage: {} as never };
  };
  return fn as unknown as MetaClient["generateObject"];
}

function modelFailing(error: unknown): MetaClient["generateObject"] {
  const fn = async () => {
    throw error;
  };
  return fn as unknown as MetaClient["generateObject"];
}

describe("normaliseAnswer", () => {
  test("lower case, no spaces, dashes and superscripts unified", () => {
    expect(normaliseAnswer("X = 4")).toBe("x=4");
    expect(normaliseAnswer("x\u22124")).toBe("x-4");
    expect(normaliseAnswer("2\u00b2")).toBe("2^2");
    expect(normaliseAnswer("x^-1")).toBe("x^-1");
    expect(normaliseAnswer("\u207b\u00b9")).toBe("^-1");
  });
});

describe("shortcutCheck", () => {
  const table: Array<{
    name: string;
    expected: string;
    answer: string;
    verdict: "correct" | "wrong" | null;
  }> = [
    { name: "exact match", expected: "4", answer: "4", verdict: "correct" },
    { name: "spacing", expected: "x=4", answer: "x = 4", verdict: "correct" },
    { name: "case", expected: "X=4", answer: "x = 4", verdict: "correct" },
    { name: "final value of the expected answer", expected: "x=4", answer: "4", verdict: "correct" },
    { name: "student writes the variable, expected is bare", expected: "4", answer: "x=4", verdict: "correct" },
    { name: "unicode minus", expected: "x-3", answer: "x\u22123", verdict: "correct" },
    { name: "superscript against caret", expected: "x^2", answer: "x\u00b2", verdict: "correct" },
    { name: "wrong value", expected: "4", answer: "5", verdict: null },
    { name: "wrong final value", expected: "x=4", answer: "x=5", verdict: null },
    { name: "empty", expected: "4", answer: "   ", verdict: "wrong" },
  ];
  for (const row of table) {
    test(row.name, () => {
      const result = shortcutCheck(row.expected, row.answer);
      if (row.verdict === null) {
        expect(result.shortcut).toBe(false);
      } else {
        expect(result.shortcut).toBe(true);
        if (result.shortcut) {
          expect(result.result.verdict).toBe(row.verdict);
        }
      }
    });
  }
});

describe("checkReviewAnswer", () => {
  test("a shortcut hit never reaches the model", async () => {
    let called = 0;
    const result = await checkReviewAnswer(
      {
        generateObject: async () => {
          called += 1;
          throw new Error("must not be called");
        },
      },
      { userId: "user-1", question: "7 - 3 = ?", expected: "4", studentAnswer: "4" },
    );
    expect(called).toBe(0);
    expect(result.verdict).toBe("correct");
  });

  test("the model path sends purpose math, effort minimal and the check prompts", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await checkReviewAnswer(
      {
        generateObject: modelReturning(
          { verdict: "almost", feedback: "You dropped a minus on step two." },
          calls,
        ),
      },
      { userId: "user-1", question: "7 - 3 = ?", expected: "4", studentAnswer: "five" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe("math");
    expect(calls[0].effort).toBe("minimal");
    expect(calls[0].schemaName).toBe("review_answer_check");
    const input = calls[0].input as Array<{ text: string }>;
    expect(input[0].text).toContain("Question:");
    expect(input[0].text).toContain("Expected answer:");
    expect(input[0].text).toContain("<student_text>");
    expect(input[0].text).toContain("five");
  });

  test("verdicts pass through and feedback is plain, trimmed and capped", async () => {
    const long = "a".repeat(400);
    const result = await checkReviewAnswer(
      {
        generateObject: modelReturning({ verdict: "wrong", feedback: `  ${long}  \\frac{1}{2} ` }),
      },
      { userId: "user-1", question: "q", expected: "1/2", studentAnswer: "no idea" },
    );
    expect(result.verdict).toBe("wrong");
    expect(result.feedback.length).toBeLessThanOrEqual(200);
    expect(result.feedback.startsWith("aaa")).toBe(true);
    // The LaTeX fraction arrived as plain text, no backslash survived.
    expect(result.feedback.includes("\\")).toBe(false);
  });

  test("a blank model feedback falls back to a short verdict line", async () => {
    const result = await checkReviewAnswer(
      {
        generateObject: modelReturning({ verdict: "almost", feedback: "   " }),
      },
      { userId: "user-1", question: "q", expected: "4", studentAnswer: "5" },
    );
    expect(result.feedback).toBe("Close. Check that step once more.");
  });

  test("a failed model call becomes a typed error with the cause kept", async () => {
    const cause = new Error("meta is down");
    await checkReviewAnswer(
      { generateObject: modelFailing(cause) },
      { userId: "user-1", question: "q", expected: "4", studentAnswer: "5" },
    ).then(
      () => {
        throw new Error("expected ReviewCheckError");
      },
      (error) => {
        expect(error).toBeInstanceOf(ReviewCheckError);
        expect((error as ReviewCheckError).cause).toBe(cause);
      },
    );
  });
});

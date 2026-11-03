import { describe, expect, test } from "bun:test";
import type { StarterRow } from "../../lib/db/types";
import { ReviewQuizSetupError, loadReviewQuestions } from "../../lib/weakspots/questions";

// The stored set rides on the review task itself: a review_practice starter
// with up to 3 practice items.
function reviewStarter(content: unknown): StarterRow {
  return {
    id: "starter-1",
    task_id: "review-1",
    type: "review_practice",
    content,
    annotated_image_path: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const STORED_PRACTICE = {
  topic: "sign_errors",
  misconception: "the subtraction slipped",
  practice: [
    { question: "7 - 3 = ?", answer: "4" },
    { question: "5 - 2 = ?", answer: "3" },
  ],
};

function fakeGenerateObject(
  data: unknown,
  calls: Array<Record<string, unknown>> = [],
) {
  return async (opts: Record<string, unknown>) => {
    calls.push(opts);
    return { data: data as never, usage: {} as never };
  };
}

describe("loadReviewQuestions", () => {
  test("stored practice set is used and no model call runs", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await loadReviewQuestions(
      { getStarter: async () => reviewStarter(STORED_PRACTICE), generateObject: fakeGenerateObject({}, calls) },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "the subtraction slipped" },
    );
    expect(result).toEqual([
      { question: "7 - 3 = ?", answer: "4" },
      { question: "5 - 2 = ?", answer: "3" },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("a starter of another type or a broken one falls through to fresh generation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const generateObject = fakeGenerateObject(
      { questions: [{ question: "9 - 4 = ?", answer: "5" }] },
      calls,
    );
    const result = await loadReviewQuestions(
      {
        getStarter: async () => reviewStarter({ items: [] }),
        generateObject,
      },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "m" },
    );
    expect(result).toEqual([{ question: "9 - 4 = ?", answer: "5" }]);
    expect(calls).toHaveLength(1);
  });

  test("fresh generation sends purpose math, effort low and the review quiz prompts", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await loadReviewQuestions(
      {
        getStarter: async () => null,
        generateObject: fakeGenerateObject({ questions: [{ question: "2 + 2 = ?", answer: "4" }] }, calls),
      },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "the subtraction slipped" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe("math");
    expect(calls[0].effort).toBe("low");
    expect(calls[0].userId).toBe("user-1");
    expect(calls[0].schemaName).toBe("review_quiz_questions");
    const input = calls[0].input as Array<{ text: string }>;
    expect(input[0].text).toContain("Topic: Sign errors");
    expect(input[0].text).toContain("<student_text>");
    expect(input[0].text).toContain("the subtraction slipped");
  });

  test("stored and fresh sets are capped at 3 questions and blank items dropped", async () => {
    const stored = {
      topic: "sign_errors",
      misconception: "m",
      practice: [
        { question: "q1", answer: "a1" },
        { question: "  ", answer: "a2" },
        { question: "q3", answer: "a3" },
        { question: "q4", answer: "a4" },
        { question: "q5", answer: "a5" },
      ],
    };
    const result = await loadReviewQuestions(
      { getStarter: async () => reviewStarter(stored), generateObject: fakeGenerateObject({}) },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "m" },
    );
    expect(result).toHaveLength(3);
  });

  test("a model answer failing the schema becomes a typed error", async () => {
    try {
      await loadReviewQuestions(
        {
          getStarter: async () => null,
          generateObject: fakeGenerateObject({ questions: [{ question: "q", wrong: true }] }),
        },
        { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "m" },
      );
      throw new Error("expected ReviewQuizSetupError");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewQuizSetupError);
    }
  });

  test("a failed model call becomes a typed error", async () => {
    await loadReviewQuestions(
      {
        getStarter: async () => null,
        generateObject: async () => {
          throw new Error("meta is down");
        },
      },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "m" },
    ).then(
      () => {
        throw new Error("expected ReviewQuizSetupError");
      },
      (error) => {
        expect(error).toBeInstanceOf(ReviewQuizSetupError);
        expect((error as ReviewQuizSetupError).message).toContain("generating review questions failed");
      },
    );
  });

  test("a model call returning no usable questions becomes a typed error", async () => {
    await loadReviewQuestions(
      {
        getStarter: async () => null,
        generateObject: fakeGenerateObject({ questions: [{ question: "  ", answer: "" }] }),
      },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "m" },
    ).then(
      () => {
        throw new Error("expected ReviewQuizSetupError");
      },
      (error) => {
        expect(error).toBeInstanceOf(ReviewQuizSetupError);
      },
    );
  });

  test("a failing starter read becomes a typed error, no model call", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await loadReviewQuestions(
      {
        getStarter: async () => {
          throw new Error("db down");
        },
        generateObject: fakeGenerateObject({ questions: [] }, calls),
      },
      { userId: "user-1", reviewTaskId: "review-1", topicLabel: "Sign errors", misconception: "m" },
    ).then(
      () => {
        throw new Error("expected ReviewQuizSetupError");
      },
      (error) => {
        expect(error).toBeInstanceOf(ReviewQuizSetupError);
        expect(calls).toHaveLength(0);
      },
    );
  });
});

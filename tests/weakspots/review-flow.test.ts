import { describe, expect, test } from "bun:test";
import type { TaskRow, WeakSpotRow } from "../../lib/db/types";
import { createReviewQuizStore } from "../../lib/weakspots/review-quiz";
import {
  answerReviewQuiz,
  createReviewFlowDeps,
  rememberRecordedReviewTask,
  reviewFinishMessage,
  recentRecordedReviewTask,
  startReviewQuiz,
  type ReviewFlowDeps,
} from "../../lib/weakspots/review-flow";
import {
  QUIZ_SUCCESS_GAP_DAYS,
  scheduleReview,
  scheduleReviewAfterQuizSuccess,
} from "../../lib/weakspots/schedule";
import { ReviewCheckError } from "../../lib/weakspots/review-answer";

const NOW = new Date("2026-11-03T10:00:00.000Z");

const TASK: TaskRow = {
  id: "review-1",
  user_id: "user-1",
  title: "Review: Sign errors",
  course: null,
  kind: "review",
  due_at: "2026-11-06T15:59:00.000Z",
  effort: "small",
  status: "open",
  origin: "weak_spot",
  source_upload_id: null,
  weak_spot_id: "ws-1",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

const WEAK_SPOT: WeakSpotRow = {
  id: "ws-1",
  user_id: "user-1",
  topic: "sign_errors",
  latest_misconception: "the subtraction slipped",
  occurrences: 1,
  last_seen_at: "2026-11-01T00:00:00.000Z",
  next_review_at: TASK.due_at,
};

const QUESTIONS = [
  { question: "7 - 3 = ?", answer: "4" },
  { question: "9 - 4 = ?", answer: "5" },
  { question: "12 - 7 = ?", answer: "5" },
];

// A full fake harness: real in-memory store, fake db writes, recorded calls.
function makeHarness(overrides: Partial<ReviewFlowDeps> = {}) {
  const calls = {
    loadQuestions: [] as Array<Record<string, unknown>>,
    checkAnswer: [] as Array<Record<string, unknown>>,
    updateTask: [] as Array<Record<string, unknown>>,
    insertTaskEvent: [] as Array<Record<string, unknown>>,
    insertTask: [] as Array<Record<string, unknown>>,
    setWeakSpotNextReview: [] as Array<Record<string, unknown>>,
  };
  const deps: ReviewFlowDeps = {
    store: createReviewQuizStore(),
    findReviewTask: async (userId, reviewTaskId) => {
      if (userId !== "user-1") return null;
      if (reviewTaskId == null) return TASK;
      return reviewTaskId === TASK.id ? TASK : null;
    },
    getWeakSpot: async (userId, weakSpotId) =>
      userId === "user-1" && weakSpotId === WEAK_SPOT.id ? WEAK_SPOT : null,
    loadQuestions: async (args) => {
      calls.loadQuestions.push({ ...args });
      return QUESTIONS;
    },
    checkAnswer: async (args) => {
      calls.checkAnswer.push({ ...args });
      return { verdict: "correct", feedback: "Correct." };
    },
    updateTask: async (id, userId, patch) => {
      calls.updateTask.push({ id, userId, patch });
      return { ...TASK, ...patch };
    },
    insertTaskEvent: async (i) => {
      calls.insertTaskEvent.push({ ...i });
    },
    insertTask: async (i) => {
      calls.insertTask.push({ ...i });
      return { ...TASK, id: "review-2", ...i } as TaskRow;
    },
    setWeakSpotNextReview: async (userId, weakSpotId, nextReviewAt) => {
      calls.setWeakSpotNextReview.push({ userId, weakSpotId, nextReviewAt });
      return WEAK_SPOT;
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

describe("startReviewQuiz", () => {
  test("starts from the most due open review task with no model call", async () => {
    const { deps, calls } = makeHarness();
    const outcome = await startReviewQuiz(deps, "user-1");
    expect(outcome.kind).toBe("started");
    if (outcome.kind === "started") {
      expect(outcome.message).toBe(
        "Let us practise a few questions like the one you slipped on. Question 1 of 3:\n\n7 - 3 = ?",
      );
    }
    expect(calls.loadQuestions).toHaveLength(1);
    expect(calls.loadQuestions[0]).toMatchObject({
      userId: "user-1",
      reviewTaskId: "review-1",
      topicLabel: "Sign errors",
      misconception: "the subtraction slipped",
    });
    expect(calls.checkAnswer).toHaveLength(0);
    // The live session is in the store.
    const session = deps.store.get("user-1");
    expect(session).not.toBeNull();
    expect(session?.index).toBe(0);
  });

  test("the given task id is honoured and must be the owner's own", async () => {
    const { deps } = makeHarness();
    const mine = await startReviewQuiz(deps, "user-1", "review-1");
    expect(mine.kind).toBe("started");
    const foreign = await startReviewQuiz(deps, "user-1", "not-my-task");
    expect(foreign.kind).toBe("unavailable");
    if (foreign.kind === "unavailable") {
      expect(foreign.message).toBe(
        "That review is not available any more. Send /review to start a fresh one.",
      );
    }
    const stranger = await startReviewQuiz(deps, "user-2", "review-1");
    expect(stranger.kind).toBe("unavailable");
  });

  test("no open review task answers with the no review waiting line", async () => {
    const { deps } = makeHarness({
      findReviewTask: async () => null,
    });
    const outcome = await startReviewQuiz(deps, "user-1");
    expect(outcome.kind).toBe("none");
    if (outcome.kind === "none") {
      expect(outcome.message).toBe(
        "You have no review waiting. Send me a photo of your working and I will find your weak spots.",
      );
    }
  });

  test("a review task without its weak spot row is unavailable", async () => {
    const { deps } = makeHarness({
      getWeakSpot: async () => null,
    });
    const outcome = await startReviewQuiz(deps, "user-1", "review-1");
    expect(outcome.kind).toBe("unavailable");
  });

  test("no stored questions and a failed generation is the setup failed line", async () => {
    const { deps } = makeHarness({
      loadQuestions: async () => {
        throw new Error("meta is down");
      },
    });
    const outcome = await startReviewQuiz(deps, "user-1");
    expect(outcome.kind).toBe("setup_failed");
    if (outcome.kind === "setup_failed") {
      expect(outcome.message).toBe(
        "I could not set that up just now. Please try /review again in a minute.",
      );
    }
    expect(deps.store.get("user-1")).toBeNull();
  });

  test("zero usable questions is also the setup failed line", async () => {
    const { deps } = makeHarness({ loadQuestions: async () => [] });
    const outcome = await startReviewQuiz(deps, "user-1");
    expect(outcome.kind).toBe("setup_failed");
  });
});

// Stored questions and model feedback can still arrive with caret maths (the
// prompts allow x^2 style), so the outgoing messages must show superscripts.
describe("outgoing quiz text is plain maths", () => {
  const MATHS_QUESTIONS = [
    { question: "Solve x^2 - 7x + 12 = 0.", answer: "3 and 4" },
    { question: "Expand (x + 1)^2.", answer: "x^2 + 2x + 1" },
  ];

  test("the intro and the stored question go out as x², with no caret", async () => {
    const { deps } = makeHarness({ loadQuestions: async () => MATHS_QUESTIONS });
    const outcome = await startReviewQuiz(deps, "user-1");
    expect(outcome.kind).toBe("started");
    if (outcome.kind === "started") {
      expect(outcome.message).toBe(
        "Let us practise a few questions like the one you slipped on. Question 1 of 2:\n\nSolve x² - 7x + 12 = 0.",
      );
      expect(outcome.message).toContain("x²");
      expect(outcome.message).not.toContain("^");
    }
  });

  test("between question feedback and the next question convert too", async () => {
    const { deps } = makeHarness({
      loadQuestions: async () => MATHS_QUESTIONS,
      checkAnswer: async () => ({
        verdict: "correct",
        feedback: "Correct. Now try (x + 1)^2.",
      }),
    });
    await startReviewQuiz(deps, "user-1");
    const outcome = await answerReviewQuiz(deps, "user-1", "3 and 4");
    expect(outcome.kind).toBe("answered");
    if (outcome.kind === "answered") {
      expect(outcome.message).toBe(
        "Correct. Now try (x + 1)².\n\nQuestion 2 of 2:\n\nExpand (x + 1)².",
      );
      expect(outcome.message).not.toContain("^");
    }
  });
});

describe("answerReviewQuiz", () => {
  test("a correct first answer gives feedback and the second question", async () => {
    const { deps, calls } = makeHarness();
    await startReviewQuiz(deps, "user-1");
    const outcome = await answerReviewQuiz(deps, "user-1", "4");
    expect(outcome.kind).toBe("answered");
    if (outcome.kind === "answered") {
      expect(outcome.message).toBe("Correct.\n\nQuestion 2 of 3:\n\n9 - 4 = ?");
    }
    expect(calls.checkAnswer).toHaveLength(1);
    expect(calls.checkAnswer[0]).toMatchObject({
      userId: "user-1",
      question: "7 - 3 = ?",
      expected: "4",
      studentAnswer: "4",
    });
    const session = deps.store.get("user-1");
    expect(session?.index).toBe(1);
    expect(session?.correct).toBe(1);
  });

  test("stop and cancel end the session without completing the task", async () => {
    for (const word of ["Stop", "cancel"]) {
      const { deps, calls } = makeHarness();
      await startReviewQuiz(deps, "user-1");
      const outcome = await answerReviewQuiz(deps, "user-1", word);
      expect(outcome.kind).toBe("stopped");
      if (outcome.kind === "stopped") {
        expect(outcome.message).toBe("No problem, we can pick this up any time with /review.");
      }
      expect(deps.store.get("user-1")).toBeNull();
      expect(calls.updateTask).toHaveLength(0);
      expect(calls.insertTask).toHaveLength(0);
    }
  });

  test("skip moves on without counting", async () => {
    const { deps, calls } = makeHarness();
    await startReviewQuiz(deps, "user-1");
    const outcome = await answerReviewQuiz(deps, "user-1", "skip");
    expect(outcome.kind).toBe("answered");
    if (outcome.kind === "answered") {
      // No feedback line on a skip, just the next question.
      expect(outcome.message).toBe("Question 2 of 3:\n\n9 - 4 = ?");
    }
    expect(calls.checkAnswer).toHaveLength(0);
    const session = deps.store.get("user-1");
    expect(session?.index).toBe(1);
    expect(session?.correct).toBe(0);
  });

  test("the last answer finishes with the summary and schedules a week out", async () => {
    const { deps, calls } = makeHarness();
    await startReviewQuiz(deps, "user-1");
    await answerReviewQuiz(deps, "user-1", "4");
    await answerReviewQuiz(deps, "user-1", "5");
    const outcome = await answerReviewQuiz(deps, "user-1", "5");
    expect(outcome.kind).toBe("finished");
    if (outcome.kind === "finished") {
      expect(outcome.message).toBe("3 of 3 right. Nice, that one is sticking.");
      expect(outcome.right).toBe(3);
      expect(outcome.total).toBe(3);
    }
    expect(deps.store.get("user-1")).toBeNull();
    // The review task is done with the same write shape as /done.
    expect(calls.updateTask).toEqual([
      { id: "review-1", userId: "user-1", patch: { status: "done" } },
    ]);
    expect(calls.insertTaskEvent).toEqual([
      {
        taskId: "review-1",
        uploadId: null,
        action: "completed",
        before: { status: "open" },
        after: { status: "done" },
        evidence: "review quiz: 3 of 3 right",
      },
    ]);
    // Two or more right push the weak spot's next review out; no new task.
    expect(calls.insertTask).toHaveLength(0);
    expect(calls.setWeakSpotNextReview).toEqual([
      {
        userId: "user-1",
        weakSpotId: "ws-1",
        nextReviewAt: new Date(scheduleReviewAfterQuizSuccess(NOW).dueAt),
      },
    ]);
  });

  test("exactly 2 of 3 right still counts as passed", async () => {
    const { deps, calls } = makeHarness({
      checkAnswer: async (args) =>
        (args as { studentAnswer: string }).studentAnswer === "4"
          ? { verdict: "correct", feedback: "Correct." }
          : { verdict: "wrong", feedback: "Not this one." },
    });
    await startReviewQuiz(deps, "user-1");
    await answerReviewQuiz(deps, "user-1", "4");
    await answerReviewQuiz(deps, "user-1", "wrong one");
    const outcome = await answerReviewQuiz(deps, "user-1", "also wrong");
    expect(outcome.kind).toBe("finished");
    if (outcome.kind === "finished") {
      expect(outcome.message).toBe("1 of 3 right. I will bring this back soon so it sticks.");
    }
    // Fewer than 2 right: the task is done anyway and a fresh review lands
    // one day out.
    expect(calls.updateTask).toHaveLength(1);
    expect(calls.insertTask).toHaveLength(1);
    const created = calls.insertTask[0] as Record<string, unknown>;
    expect(created).toMatchObject({
      userId: "user-1",
      title: "Review: Sign errors",
      course: null,
      kind: "review",
      dueAt: scheduleReview(2, NOW).dueAt,
      effort: "small",
      origin: "weak_spot",
      weakSpotId: "ws-1",
    });
    expect(calls.setWeakSpotNextReview[0]).toMatchObject({
      nextReviewAt: new Date(scheduleReview(2, NOW).dueAt),
    });
    const createdEvent = calls.insertTaskEvent[1] as Record<string, unknown>;
    expect(createdEvent).toMatchObject({ action: "created", taskId: "review-2" });
  });

  test("a failed check keeps the session on the same question", async () => {
    let failed = false;
    const { deps } = makeHarness({
      checkAnswer: async () => {
        if (!failed) {
          failed = true;
          throw new ReviewCheckError("checking failed");
        }
        return { verdict: "correct", feedback: "Correct." };
      },
    });
    await startReviewQuiz(deps, "user-1");
    const outcome = await answerReviewQuiz(deps, "user-1", "4");
    expect(outcome.kind).toBe("check_failed");
    const session = deps.store.get("user-1");
    expect(session?.index).toBe(0);
    // The same question can be answered after the hiccup.
    const retry = await answerReviewQuiz(deps, "user-1", "4");
    expect(retry.kind).toBe("answered");
  });

  test("an expired session is ignored", async () => {
    let clock = NOW.getTime();
    const { deps } = makeHarness({
      store: createReviewQuizStore({ ttlMs: 1000, now: () => clock }),
    });
    await startReviewQuiz(deps, "user-1");
    clock += 2 * 60 * 1000;
    const outcome = await answerReviewQuiz(deps, "user-1", "4");
    expect(outcome.kind).toBe("no_session");
  });

  test("no session at all is ignored", async () => {
    const { deps } = makeHarness();
    const outcome = await answerReviewQuiz(deps, "user-1", "4");
    expect(outcome.kind).toBe("no_session");
  });
});

describe("reviewFinishMessage", () => {
  test("the summary line matches the score", () => {
    expect(reviewFinishMessage(3, 3)).toBe("3 of 3 right. Nice, that one is sticking.");
    expect(reviewFinishMessage(2, 3)).toBe("2 of 3 right. Good, most of it stuck.");
    expect(reviewFinishMessage(0, 3)).toBe("0 of 3 right. I will bring this back soon so it sticks.");
    expect(reviewFinishMessage(1, 1)).toBe("1 of 1 right. Nice, that one is sticking.");
  });
});

describe("scheduleReviewAfterQuizSuccess", () => {
  test("the due moment is 23:59 SGT a full week later", () => {
    const due = scheduleReviewAfterQuizSuccess(NOW).dueAt;
    const expectedMs =
      (Math.floor((NOW.getTime() + 8 * 3600 * 1000) / 86400000) + QUIZ_SUCCESS_GAP_DAYS) *
        86400000 -
      8 * 3600 * 1000 +
      (23 * 60 + 59) * 60 * 1000;
    expect(due).toBe(new Date(expectedMs).toISOString());
    // Exactly seven SGT calendar days ahead of the review the same student
    // would otherwise get.
    const later = scheduleReviewAfterQuizSuccess(new Date(NOW.getTime() + 3600 * 1000)).dueAt;
    expect(later).toBe(due);
  });
});

describe("the recorded review task registry", () => {
  test("remember and read back within the window, gone after it", () => {
    const t0 = 1000000;
    rememberRecordedReviewTask("user-1", "review-1", t0);
    expect(recentRecordedReviewTask("user-1", t0 + 60 * 1000)).toBe("review-1");
    expect(recentRecordedReviewTask("user-2", t0)).toBeNull();
    expect(recentRecordedReviewTask("user-1", t0 + 11 * 60 * 1000)).toBeNull();
  });

  test("a newer recording replaces the older one", () => {
    const t0 = 2000000;
    rememberRecordedReviewTask("user-3", "review-a", t0);
    rememberRecordedReviewTask("user-3", "review-b", t0 + 1000);
    expect(recentRecordedReviewTask("user-3", t0 + 2000)).toBe("review-b");
  });
});

describe("real deps surface", () => {
  test("the quiz flow never touches the free quota claim", () => {
    // The flow's dependency surface has no billing or usage ledger function:
    // quiz calls obey the rate limit and the client's daily spend cap only.
    const keys = Object.keys(createReviewFlowDeps()).sort();
    expect(keys).toEqual([
      "checkAnswer",
      "findReviewTask",
      "getWeakSpot",
      "insertTask",
      "insertTaskEvent",
      "loadQuestions",
      "now",
      "setWeakSpotNextReview",
      "store",
      "updateTask",
    ]);
  });
});

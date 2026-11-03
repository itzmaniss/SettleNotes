// Review quiz flow: pick the student's own open review task, drill its
// practice questions one message at a time, then complete the review task and
// reschedule the weak spot by how well it went. Everything depends on
// injected deps so tests run the whole flow against fakes; the only state the
// flow owns is the in-memory quiz store and the small registry that lets the
// telegram layer attach the Start review button to the review reply.

import "server-only";

import type {
  InsertTaskEventInput,
  InsertTaskInput,
  UpdateTaskPatch,
} from "@/lib/db/queries";
import type { TaskRow, WeakSpotRow } from "@/lib/db/types";
import { listOpenTasks as realListOpenTasks } from "@/lib/db/queries";
import { getWeakSpotById } from "./queries";
import {
  MATH_TOPIC_LABELS,
  type MathTopic,
} from "@/lib/starters/types";
import {
  reviewQuizStore,
  type ReviewQuizOutcome,
  type ReviewQuizStore,
  type ReviewQuizSession,
} from "./review-quiz";
import type { ReviewQuizQuestion, LoadReviewQuestionsArgs } from "./questions";
import type { ReviewCheckArgs, ReviewCheckResult } from "./review-answer";
import { scheduleReview, scheduleReviewAfterQuizSuccess } from "./schedule";

export type ReviewFlowDeps = {
  store: ReviewQuizStore;
  // Picks the owner's own open review task: by id when given (it must be
  // theirs, open, and a review), else the most due open review task they
  // have. Null means none.
  findReviewTask: (userId: string, reviewTaskId: string | null) => Promise<TaskRow | null>;
  getWeakSpot: (userId: string, weakSpotId: string) => Promise<WeakSpotRow | null>;
  loadQuestions: (args: LoadReviewQuestionsArgs) => Promise<ReviewQuizQuestion[]>;
  checkAnswer: (args: ReviewCheckArgs) => Promise<ReviewCheckResult>;
  updateTask: (id: string, userId: string, patch: UpdateTaskPatch) => Promise<TaskRow>;
  insertTaskEvent: (i: InsertTaskEventInput) => Promise<void>;
  insertTask: (i: InsertTaskInput) => Promise<TaskRow>;
  setWeakSpotNextReview: (
    userId: string,
    weakSpotId: string,
    nextReviewAt: Date | null,
  ) => Promise<WeakSpotRow>;
  now: () => Date;
};

// ---- student facing copy (plain text, second person, no dashes) --------------

export function noReviewWaitingReply(): string {
  return "You have no review waiting. Send me a photo of your working and I will find your weak spots.";
}

export function reviewUnavailableReply(): string {
  return "That review is not available any more. Send /review to start a fresh one.";
}

export function reviewSetupFailedReply(): string {
  return "I could not set that up just now. Please try /review again in a minute.";
}

export function reviewStoppedReply(): string {
  return "No problem, we can pick this up any time with /review.";
}

// 'Sign errors' reads badly after "practise", so the label goes lower case
// first; unknown topics fall back to the stored string.
export function reviewTopicWords(topic: string): string {
  const label = MATH_TOPIC_LABELS[topic as MathTopic] ?? topic;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export function reviewTaskTitle(topic: string): string {
  return `Review: ${MATH_TOPIC_LABELS[topic as MathTopic] ?? topic}`;
}

export function questionLine(index: number, total: number): string {
  return `Question ${index + 1} of ${total}:`;
}

export function reviewStartMessageFor(
  topic: string,
  question: string,
  total: number,
): string {
  return `Let us practise ${reviewTopicWords(topic)}. ${questionLine(0, total)}\n\n${question}`;
}

export function reviewNextMessage(
  feedback: string,
  question: string,
  index: number,
  total: number,
): string {
  return `${feedback}\n\n${questionLine(index, total)}\n\n${question}`;
}

export function reviewSkipMessage(question: string, index: number, total: number): string {
  return `${questionLine(index, total)}\n\n${question}`;
}

// One encouraging plain sentence after the count, never a lecture.
export function reviewFinishMessage(right: number, total: number): string {
  let tail = "I will bring this back soon so it sticks.";
  if (total > 0 && right === total) tail = "Nice, that one is sticking.";
  else if (right >= 2) tail = "Good, most of it stuck.";
  return `${right} of ${total} right. ${tail}`;
}

// ---- outcomes ----------------------------------------------------------------

export type ReviewStartOutcome =
  | { kind: "started"; message: string }
  | { kind: "none"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "setup_failed"; message: string };

export type ReviewAnswerOutcome =
  // Feedback plus the next question.
  | { kind: "answered"; message: string }
  | { kind: "finished"; message: string; right: number; total: number }
  | { kind: "stopped"; message: string }
  // No live session: the message belongs to the normal pipeline.
  | { kind: "no_session" }
  // The check failed; the session stays alive so the same question can be
  // retried. cause carries the typed error for the caller's logging.
  | { kind: "check_failed"; cause: unknown };

// Which count means the quiz went well: at least two right pushes the next
// review out; fewer lands a fresh review one day out.
export const QUIZ_PASS_RIGHT = 2;

// ---- start -------------------------------------------------------------------

export async function startReviewQuiz(
  deps: ReviewFlowDeps,
  userId: string,
  reviewTaskId?: string,
): Promise<ReviewStartOutcome> {
  const task = await deps.findReviewTask(userId, reviewTaskId ?? null);
  if (task == null) {
    return reviewTaskId != null
      ? { kind: "unavailable", message: reviewUnavailableReply() }
      : { kind: "none", message: noReviewWaitingReply() };
  }
  const weakSpotId = task.weak_spot_id;
  if (weakSpotId == null) {
    return { kind: "unavailable", message: reviewUnavailableReply() };
  }
  const weakSpot = await deps.getWeakSpot(userId, weakSpotId);
  if (weakSpot == null) {
    return { kind: "unavailable", message: reviewUnavailableReply() };
  }

  let questions: ReviewQuizQuestion[];
  try {
    questions = await deps.loadQuestions({
      userId,
      reviewTaskId: task.id,
      topicLabel: MATH_TOPIC_LABELS[weakSpot.topic as MathTopic] ?? weakSpot.topic,
      misconception: weakSpot.latest_misconception,
    });
  } catch {
    return { kind: "setup_failed", message: reviewSetupFailedReply() };
  }
  if (questions.length === 0) {
    return { kind: "setup_failed", message: reviewSetupFailedReply() };
  }

  const session = deps.store.start(userId, {
    weakSpotId,
    reviewTaskId: task.id,
    topic: weakSpot.topic,
    questions,
  });
  return {
    kind: "started",
    message: reviewStartMessageFor(
      session.topic,
      session.questions[0].question,
      session.questions.length,
    ),
  };
}

// ---- answer ------------------------------------------------------------------

export async function answerReviewQuiz(
  deps: ReviewFlowDeps,
  userId: string,
  rawText: string,
): Promise<ReviewAnswerOutcome> {
  const session = deps.store.get(userId);
  if (session == null) return { kind: "no_session" };

  const word = rawText.trim().toLowerCase();
  if (word === "stop" || word === "cancel") {
    deps.store.clear(userId);
    return { kind: "stopped", message: reviewStoppedReply() };
  }
  if (word === "skip") {
    return advanceAfter(deps, userId, session, "skip", null);
  }

  const current = session.questions[session.index];
  let result: ReviewCheckResult;
  try {
    result = await deps.checkAnswer({
      userId,
      question: current.question,
      expected: current.answer,
      studentAnswer: rawText,
    });
  } catch (error) {
    // The session stays untouched, so the same question can be retried.
    return { kind: "check_failed", cause: error };
  }
  const outcome: ReviewQuizOutcome = result.verdict === "correct" ? "right" : "wrong";
  return advanceAfter(deps, userId, session, outcome, result.feedback);
}

// Counts the outcome in the store and builds the reply: the next question,
// or the summary plus the completion and reschedule writes when the last
// question is done.
async function advanceAfter(
  deps: ReviewFlowDeps,
  userId: string,
  session: ReviewQuizSession,
  outcome: ReviewQuizOutcome,
  feedback: string | null,
): Promise<ReviewAnswerOutcome> {
  const total = session.questions.length;
  const countedRight = outcome === "right" ? session.correct + 1 : session.correct;
  const next = deps.store.advance(userId, outcome);
  if (next != null) {
    const question = next.questions[next.index].question;
    const message =
      feedback == null
        ? reviewSkipMessage(question, next.index, next.questions.length)
        : reviewNextMessage(feedback, question, next.index, next.questions.length);
    return { kind: "answered", message };
  }
  await completeAndReschedule(deps, userId, session, countedRight, total);
  return {
    kind: "finished",
    message: reviewFinishMessage(countedRight, total),
    right: countedRight,
    total,
  };
}

// The write side of finishing: the review task is marked done with the same
// write shape as /done (status patch plus a completed event), then the weak
// spot is rescheduled. Two or more right push the next review a week out;
// fewer leave a fresh review task one day out so the slip gets another pass.
async function completeAndReschedule(
  deps: ReviewFlowDeps,
  userId: string,
  session: ReviewQuizSession,
  right: number,
  total: number,
): Promise<void> {
  const now = deps.now();
  const evidence = `review quiz: ${right} of ${total} right`;
  await deps.updateTask(session.reviewTaskId, userId, { status: "done" });
  await deps.insertTaskEvent({
    taskId: session.reviewTaskId,
    uploadId: null,
    action: "completed",
    before: { status: "open" },
    after: { status: "done" },
    evidence,
  });

  if (right >= QUIZ_PASS_RIGHT) {
    const schedule = scheduleReviewAfterQuizSuccess(now);
    await deps.setWeakSpotNextReview(userId, session.weakSpotId, new Date(schedule.dueAt));
    return;
  }
  const schedule = scheduleReview(QUIZ_PASS_RIGHT, now); // any count above 1 lands +1 day out
  const title = reviewTaskTitle(session.topic);
  const created = await deps.insertTask({
    userId,
    title,
    course: null,
    kind: "review",
    dueAt: schedule.dueAt,
    effort: "small",
    origin: "weak_spot",
    weakSpotId: session.weakSpotId,
    sourceUploadId: null,
  });
  await deps.insertTaskEvent({
    taskId: created.id,
    uploadId: null,
    action: "created",
    before: null,
    after: { title, course: null, kind: "review", dueAt: schedule.dueAt, effort: "small" },
    evidence,
  });
  await deps.setWeakSpotNextReview(userId, session.weakSpotId, new Date(schedule.dueAt));
}

// ---- real deps ---------------------------------------------------------------

// The most due open review task is the first review among the student's open
// tasks; listOpenTasks already orders by due_at with undated tasks last.
export function createReviewFlowDeps(overrides: Partial<ReviewFlowDeps> = {}): ReviewFlowDeps {
  return {
    store: reviewQuizStore,
    findReviewTask: async (userId, reviewTaskId) => {
      const open = await realListOpenTasks(userId);
      const reviews = open.filter((task) => task.kind === "review");
      if (reviewTaskId == null) return reviews[0] ?? null;
      return reviews.find((task) => task.id === reviewTaskId) ?? null;
    },
    getWeakSpot: (userId, weakSpotId) => getWeakSpotById(userId, weakSpotId),
    loadQuestions: async (args) => {
      const { loadReviewQuestions, createReviewQuestionDeps } = await import("./questions");
      return loadReviewQuestions(createReviewQuestionDeps(), args);
    },
    checkAnswer: async (args) => {
      const { checkReviewAnswer, createReviewCheckDeps } = await import("./review-answer");
      return checkReviewAnswer(createReviewCheckDeps(), args);
    },
    updateTask: async (id, userId, patch) => {
      const { updateTask } = await import("@/lib/db/queries");
      return updateTask(id, userId, patch);
    },
    insertTaskEvent: async (i) => {
      const { insertTaskEvent } = await import("@/lib/db/queries");
      return insertTaskEvent(i);
    },
    insertTask: async (i) => {
      const { insertTask } = await import("@/lib/db/queries");
      return insertTask(i);
    },
    setWeakSpotNextReview: async (userId, weakSpotId, nextReviewAt) => {
      const { setWeakSpotNextReview } = await import("./queries");
      return setWeakSpotNextReview(userId, weakSpotId, nextReviewAt);
    },
    now: () => new Date(),
    ...overrides,
  };
}

// ---- the registry behind the Start review button ------------------------------

// recordWeakSpot writes the id of the review task it just created or pushed;
// the telegram layer reads it moments later to attach the button to the
// review reply (the reply itself travels through the math outcome as a bare
// string). Same memory rules as the quiz store: this process only, never
// written to the database, gone on restart. A miss simply means no button.
const REGISTRY_TTL_MS = 10 * 60 * 1000;
const REGISTRY_MAX_USERS = 1000;

const recorded = new Map<string, { reviewTaskId: string; at: number }>();

export function rememberRecordedReviewTask(
  userId: string,
  reviewTaskId: string,
  now: number = Date.now(),
): void {
  recorded.delete(userId);
  recorded.set(userId, { reviewTaskId, at: now });
  while (recorded.size > REGISTRY_MAX_USERS) {
    const oldest = recorded.keys().next();
    if (oldest.done) break;
    recorded.delete(oldest.value);
  }
}

export function recentRecordedReviewTask(userId: string, now: number = Date.now()): string | null {
  const entry = recorded.get(userId);
  if (entry === undefined) return null;
  if (now - entry.at >= REGISTRY_TTL_MS) {
    recorded.delete(userId);
    return null;
  }
  return entry.reviewTaskId;
}

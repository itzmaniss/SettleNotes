// In-memory review quiz sessions (PRD F4 follow through). One session per
// user: which practice question they are on and how many they got right. Held
// in this process' memory only, never persisted, never logged, and gone when
// the app restarts, so there is nothing to erase. Same shape as
// lib/pipeline/conversation.ts.

import type { ReviewQuizQuestion } from "./questions";

// The stored practice sets never exceed three questions; fresh generations
// are capped at the same number.
export const REVIEW_QUIZ_MAX_QUESTIONS = 3;

export type ReviewQuizSession = {
  userKey: string;
  weakSpotId: string;
  reviewTaskId: string;
  topic: string;
  questions: ReviewQuizQuestion[];
  // Zero-based index of the question the student is on.
  index: number;
  correct: number;
  startedAt: number;
};

export type ReviewQuizStartInput = {
  weakSpotId: string;
  reviewTaskId: string;
  topic: string;
  questions: ReviewQuizQuestion[];
};

export type ReviewQuizOutcome = "right" | "wrong" | "skip";

export type ReviewQuizStoreOptions = {
  // A session older than this behaves as absent. Default: 30 minutes.
  ttlMs?: number;
  // Sessions held at once; the least recently used one is evicted beyond
  // this. Default: 1000.
  maxUsers?: number;
  now?: () => number;
};

export type ReviewQuizStore = {
  // The live session, or null for an unknown user or an expired one.
  get: (userKey: string) => ReviewQuizSession | null;
  start: (userKey: string, input: ReviewQuizStartInput) => ReviewQuizSession;
  // Counts the answer and moves on. Returns the session while questions
  // remain, null once the last question is done (the session is then gone).
  advance: (userKey: string, outcome: ReviewQuizOutcome) => ReviewQuizSession | null;
  clear: (userKey: string) => void;
};

// The stored shape drops the LRU bookkeeping field; an explicit copy keeps
// the public type clean without lint-visible unused destructuring.
type StoredSession = ReviewQuizSession & { updatedAt: number };

function withoutUpdatedAt(entry: StoredSession): ReviewQuizSession {
  return {
    userKey: entry.userKey,
    weakSpotId: entry.weakSpotId,
    reviewTaskId: entry.reviewTaskId,
    topic: entry.topic,
    questions: entry.questions,
    index: entry.index,
    correct: entry.correct,
    startedAt: entry.startedAt,
  };
}

export function createReviewQuizStore(options: ReviewQuizStoreOptions = {}): ReviewQuizStore {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  const maxUsers = options.maxUsers ?? 1000;
  const now = options.now ?? (() => Date.now());

  // Map keys keep insertion order, and re-inserting a key moves it to the
  // end, so the first key is always the least recently used session.
  const sessions = new Map<string, ReviewQuizSession & { updatedAt: number }>();

  function touch(userKey: string): void {
    const entry = sessions.get(userKey);
    if (entry === undefined) return;
    sessions.delete(userKey);
    sessions.set(userKey, entry);
  }

  // Expired behaves exactly as absent: the caller cannot tell the difference,
  // and the dead session is dropped so it cannot come back.
  function live(userKey: string): (ReviewQuizSession & { updatedAt: number }) | null {
    const entry = sessions.get(userKey);
    if (entry === undefined) return null;
    if (now() - entry.updatedAt >= ttlMs) {
      sessions.delete(userKey);
      return null;
    }
    return entry;
  }

  return {
    get(userKey) {
      touch(userKey);
      const entry = live(userKey);
      if (entry == null) return null;
      return withoutUpdatedAt(entry);
    },

    start(userKey, input) {
      const at = now();
      const questions = input.questions
        .map((q) => ({ question: q.question.trim(), answer: q.answer.trim() }))
        .filter((q) => q.question !== "" && q.answer !== "")
        .slice(0, REVIEW_QUIZ_MAX_QUESTIONS);
      const session: StoredSession = {
        userKey,
        weakSpotId: input.weakSpotId,
        reviewTaskId: input.reviewTaskId,
        topic: input.topic,
        questions,
        index: 0,
        correct: 0,
        startedAt: at,
        updatedAt: at,
      };
      // A running quiz for the same user is replaced: starting again restarts.
      sessions.delete(userKey);
      sessions.set(userKey, session);
      while (sessions.size > maxUsers) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      return withoutUpdatedAt(session);
    },

    advance(userKey, outcome) {
      const entry = live(userKey);
      if (entry == null) return null;
      entry.updatedAt = now();
      touch(userKey);
      if (outcome === "right") entry.correct += 1;
      // A skip moves on without counting as right or wrong.
      entry.index += 1;
      if (entry.index >= entry.questions.length) {
        sessions.delete(userKey);
        return null;
      }
      return withoutUpdatedAt(entry);
    },

    clear(userKey) {
      sessions.delete(userKey);
    },
  };
}

// The one instance the running bot uses. Tests build their own through
// createReviewQuizStore so clocks and limits are under their control.
export const reviewQuizStore = createReviewQuizStore();

import { describe, expect, test } from "bun:test";
import { buildPendingActions, MAX_PENDING_PROMPTS } from "../../lib/clarify/build";
import { PendingPayloadSchema } from "../../lib/clarify/types";
import type { PendingActionInput } from "../../lib/clarify/types";
import type { ReconcileAction } from "../../lib/pipeline/reconcile";
import {
  clearedKeyboard,
  PENDING_CALLBACK_DATA_PATTERN,
  pendingActionCallbackData,
  pendingActionKeyboard,
} from "../../lib/telegram/replies";

const CTX = { userId: "user-1", uploadId: "upload-1" };

function makeAction(overrides: Partial<ReconcileAction> = {}): ReconcileAction {
  return {
    type: "create",
    taskId: null,
    title: "MA2001 Quiz 2",
    course: "MA2001",
    kind: "test",
    dueAt: "2026-11-10T15:59:00.000Z",
    effort: null,
    evidence: "got quiz 2 on tue",
    confidence: 0.3,
    ...overrides,
  };
}

const openTasks = [
  { id: "task-1", title: "CS2030 Lab 4" },
  { id: "task-2", title: "GEA1000 readings" },
];

function assertNoDashes(text: string): void {
  expect(text.includes("\u2014")).toBe(false);
  expect(text.includes("\u2013")).toBe(false);
}

describe("buildPendingActions: create", () => {
  test("converts a low-confidence create with the confident path's fields", () => {
    const { drafts, fallbacks } = buildPendingActions([makeAction()], CTX, openTasks);
    expect(fallbacks).toHaveLength(0);
    expect(drafts).toHaveLength(1);
    const input: PendingActionInput = drafts[0].input;
    expect(input).toEqual({
      userId: "user-1",
      uploadId: "upload-1",
      kind: "create",
      taskId: null,
      payload: {
        title: "MA2001 Quiz 2",
        course: "MA2001",
        kind: "test",
        dueAt: "2026-11-10T15:59:00.000Z",
        effort: null,
        evidence: "got quiz 2 on tue",
      },
    });
    expect(drafts[0].text).toBe('I think this is a new task: "MA2001 Quiz 2", due Tue 10 Nov, 11:59pm. Add it?');
    assertNoDashes(drafts[0].text);
  });

  test("a create without a due date prompts without one and still validates", () => {
    const { drafts } = buildPendingActions([makeAction({ dueAt: null, course: null, kind: null, effort: "small" })], CTX, openTasks);
    expect(drafts[0].text).toBe('I think this is a new task: "MA2001 Quiz 2". Add it?');
    expect(drafts[0].input.payload).toEqual({
      title: "MA2001 Quiz 2",
      course: null,
      // The confident path defaults kind to other; so does the prompt path.
      kind: "other",
      dueAt: null,
      effort: "small",
      evidence: "got quiz 2 on tue",
    });
    const parsed = PendingPayloadSchema.create.safeParse(drafts[0].input.payload);
    expect(parsed.success).toBe(true);
  });

  test("a create without a usable title gets no buttons", () => {
    const { drafts, fallbacks } = buildPendingActions(
      [makeAction({ title: "   " })],
      CTX,
      openTasks,
    );
    expect(drafts).toHaveLength(0);
    expect(fallbacks).toHaveLength(1);
  });

  test("titles and courses are stored trimmed", () => {
    const { drafts } = buildPendingActions([makeAction({ title: "  Quiz 3  ", course: " ma2001 " })], CTX, openTasks);
    const payload = drafts[0].input.payload as { title: string; course: string | null };
    expect(payload.title).toBe("Quiz 3");
    expect(payload.course).toBe("ma2001");
  });
});

describe("buildPendingActions: update", () => {
  test("an update with a resolvable target stores the new due and names the current task", () => {
    const action = makeAction({
      type: "update",
      taskId: "task-1",
      title: null,
      course: null,
      kind: null,
      dueAt: "2026-11-06T15:59:00.000Z",
    });
    const { drafts, fallbacks } = buildPendingActions([action], CTX, openTasks);
    expect(fallbacks).toHaveLength(0);
    expect(drafts[0].input.kind).toBe("update");
    expect(drafts[0].input.taskId).toBe("task-1");
    expect(drafts[0].input.payload).toEqual({
      dueAt: "2026-11-06T15:59:00.000Z",
      evidence: "got quiz 2 on tue",
    });
    expect(drafts[0].text).toBe('Should I move "CS2030 Lab 4" to Fri 6 Nov, 11:59pm?');
    assertNoDashes(drafts[0].text);
  });

  test("an update that only renames stores the title and asks without a date", () => {
    const action = makeAction({
      type: "update",
      taskId: "task-2",
      title: "GEA1000 readings week 6",
      course: null,
      kind: null,
      dueAt: null,
    });
    const { drafts } = buildPendingActions([action], CTX, openTasks);
    expect(drafts[0].input.payload).toEqual({
      title: "GEA1000 readings week 6",
      evidence: "got quiz 2 on tue",
    });
    expect(drafts[0].text).toBe('Should I update "GEA1000 readings"?');
  });

  test("an update with no resolvable target gets no buttons", () => {
    const { drafts, fallbacks } = buildPendingActions(
      [makeAction({ type: "update", taskId: null })],
      CTX,
      openTasks,
    );
    expect(drafts).toHaveLength(0);
    expect(fallbacks).toHaveLength(1);
  });

  test("an update with neither title nor due date has nothing to apply, so no buttons", () => {
    const { drafts, fallbacks } = buildPendingActions(
      [makeAction({ type: "update", taskId: "task-1", title: null, dueAt: null })],
      CTX,
      openTasks,
    );
    expect(drafts).toHaveLength(0);
    expect(fallbacks).toHaveLength(1);
  });

  test("an update whose target is missing from the open list gets no buttons", () => {
    const { drafts, fallbacks } = buildPendingActions(
      [makeAction({ type: "update", taskId: "task-gone", dueAt: "2026-11-06T15:59:00.000Z", title: null })],
      CTX,
      [],
    );
    expect(drafts).toHaveLength(0);
    expect(fallbacks).toHaveLength(1);
  });
});

describe("buildPendingActions: complete", () => {
  test("a complete stores only the evidence and asks about the current task", () => {
    const action = makeAction({
      type: "complete",
      taskId: "task-1",
      title: null,
      course: null,
      kind: null,
      dueAt: null,
      evidence: "done liao",
    });
    const { drafts, fallbacks } = buildPendingActions([action], CTX, openTasks);
    expect(fallbacks).toHaveLength(0);
    expect(drafts[0].input.kind).toBe("complete");
    expect(drafts[0].input.taskId).toBe("task-1");
    expect(drafts[0].input.payload).toEqual({ evidence: "done liao" });
    expect(drafts[0].text).toBe('Did you finish "CS2030 Lab 4"?');
    assertNoDashes(drafts[0].text);
  });

  test("a complete for an unknown task gets no buttons", () => {
    const { drafts, fallbacks } = buildPendingActions(
      [makeAction({ type: "complete", taskId: null })],
      CTX,
      openTasks,
    );
    expect(drafts).toHaveLength(0);
    expect(fallbacks).toHaveLength(1);
  });
});

describe("buildPendingActions: cap and payload validity", () => {
  test("caps prompts at 3 and pushes the rest to the text-only fallback in order", () => {
    const actions = Array.from({ length: 5 }, (_, i) =>
      makeAction({ title: `Quiz ${i + 1}`, course: null }),
    );
    const { drafts, fallbacks } = buildPendingActions(actions, CTX, openTasks);
    expect(MAX_PENDING_PROMPTS).toBe(3);
    expect(drafts).toHaveLength(3);
    expect(fallbacks).toHaveLength(2);
    expect((drafts[0].input.payload as { title: string }).title).toBe("Quiz 1");
    expect((fallbacks[0] as ReconcileAction).title).toBe("Quiz 4");
  });

  test("unresolvable actions do not consume prompt slots", () => {
    const actions = [
      makeAction({ type: "update", taskId: null }),
      makeAction({ title: "Quiz A", course: null }),
      makeAction({ title: "Quiz B", course: null }),
      makeAction({ title: "Quiz C", course: null }),
      makeAction({ title: "Quiz D", course: null }),
    ];
    const { drafts, fallbacks } = buildPendingActions(actions, CTX, openTasks);
    expect(drafts).toHaveLength(3);
    expect(fallbacks).toHaveLength(2); // the unresolvable update plus Quiz D
  });

  test("every draft's payload validates against its kind's schema", () => {
    const actions = [
      makeAction(),
      makeAction({ type: "update", taskId: "task-1", title: null, dueAt: "2026-11-06T15:59:00.000Z" }),
      makeAction({ type: "complete", taskId: "task-1", title: null, dueAt: null, evidence: "done liao" }),
    ];
    const { drafts } = buildPendingActions(actions, CTX, openTasks);
    expect(drafts).toHaveLength(3);
    for (const draft of drafts) {
      const parsed = PendingPayloadSchema[draft.input.kind].safeParse(draft.input.payload);
      expect(parsed.success).toBe(true);
    }
  });

  test("payloads reject fields beyond what the schema allows", () => {
    expect(
      PendingPayloadSchema.complete.safeParse({ evidence: "x", title: "sneaky" }).success,
    ).toBe(false);
    expect(
      PendingPayloadSchema.update.safeParse({ evidence: "x", dueAt: 123 }).success,
    ).toBe(false);
  });
});

describe("callback data and keyboard", () => {
  const UUID = "5b1f8a2e-9c3d-4e6f-8a7b-2c1d0e9f8a7b";

  test("callback data stays within Telegram's 64 byte limit and matches the pattern", () => {
    for (const yes of [true, false]) {
      const data = pendingActionCallbackData(UUID, yes);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(PENDING_CALLBACK_DATA_PATTERN.test(data)).toBe(true);
    }
    expect(pendingActionCallbackData(UUID, true)).toBe(`pa:y:${UUID}`);
    expect(pendingActionCallbackData(UUID, false)).toBe(`pa:n:${UUID}`);
  });

  test("the pattern rejects malformed or foreign callback data", () => {
    expect(PENDING_CALLBACK_DATA_PATTERN.test("pa:yes:5b1f8a2e-9c3d-4e6f-8a7b-2c1d0e9f8a7b")).toBe(false);
    expect(PENDING_CALLBACK_DATA_PATTERN.test("pa:y:not-a-uuid")).toBe(false);
    expect(PENDING_CALLBACK_DATA_PATTERN.test("other-bot:join")).toBe(false);
    expect(PENDING_CALLBACK_DATA_PATTERN.test("")).toBe(false);
  });

  test("the prompt keyboard carries Yes and No with the right callback data", () => {
    const keyboard = pendingActionKeyboard(UUID);
    expect(keyboard.inline_keyboard).toHaveLength(1);
    const [yes, no] = keyboard.inline_keyboard[0];
    expect(yes.text).toBe("Yes");
    if (!("callback_data" in yes)) throw new Error("Yes button is not a data button");
    expect(yes.callback_data).toBe(`pa:y:${UUID}`);
    expect(no.text).toBe("No");
    if (!("callback_data" in no)) throw new Error("No button is not a data button");
    expect(no.callback_data).toBe(`pa:n:${UUID}`);
  });

  test("the cleared keyboard serializes with no buttons at all", () => {
    const keyboard = clearedKeyboard();
    expect(keyboard.inline_keyboard).toEqual([]);
  });
});

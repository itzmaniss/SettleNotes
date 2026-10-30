import { describe, expect, test } from "bun:test";
import type { ExecuteResult } from "../../lib/pipeline/execute";
import type { ReconcileAction } from "../../lib/pipeline/reconcile";
import {
  budgetReply,
  dashboardKeyboard,
  failureReply,
  fileTooLargeReply,
  formatDue,
  mathPendingReply,
  nothingFoundReply,
  pdfTruncatedNote,
  REFUSAL_TEXT,
  summaryReply,
  unknownCommandReply,
  unsupportedFileReply,
} from "../../lib/telegram/replies";

function assertNoDashes(text: string): void {
  expect(text.includes("\u2014")).toBe(false);
  expect(text.includes("\u2013")).toBe(false);
}

function createdTask(id: string, title: string, dueAt: string | null) {
  return {
    id,
    user_id: "user-1",
    title,
    course: null,
    kind: "other" as const,
    due_at: dueAt,
    effort: null,
    status: "open" as const,
    origin: "capture" as const,
    source_upload_id: "upload-1",
    weak_spot_id: null,
    created_at: "2026-10-28T01:00:00.000Z",
    updated_at: "2026-10-28T01:00:00.000Z",
  };
}

describe("formatDue", () => {
  test("formats Singapore time like 'Fri 6 Nov, 11:59pm'", () => {
    expect(formatDue("2026-11-06T15:59:00.000Z")).toBe("Fri 6 Nov, 11:59pm");
    expect(formatDue("2026-10-30T15:59:00.000Z")).toBe("Fri 30 Oct, 11:59pm");
  });

  test("midnight is 12:00am on the next SGT day", () => {
    expect(formatDue("2026-11-06T16:00:00.000Z")).toBe("Sat 7 Nov, 12:00am");
  });

  test("noon is 12:00pm", () => {
    expect(formatDue("2026-11-06T04:00:00.000Z")).toBe("Fri 6 Nov, 12:00pm");
  });

  test("null and unparseable values are 'no deadline'", () => {
    expect(formatDue(null)).toBe("no deadline");
    expect(formatDue("not a date")).toBe("no deadline");
  });
});

describe("summaryReply", () => {
  const emptyResult: ExecuteResult = { created: [], updated: [], completed: [], clarify: [] };

  test("singular create with a deadline", () => {
    const text = summaryReply({
      result: { ...emptyResult, created: [createdTask("t1", "CS2030 Lab 4", "2026-11-06T15:59:00.000Z")] },
      clarification: null,
    });
    expect(text).toBe("Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)");
    assertNoDashes(text);
  });

  test("plural creates, and a create without a deadline omits the due part", () => {
    const text = summaryReply({
      result: {
        ...emptyResult,
        created: [createdTask("t1", "Read chapter 3", null), createdTask("t2", "MA2001 Quiz 2", "2026-11-10T15:59:00.000Z")],
      },
      clarification: null,
    });
    expect(text).toBe(
      "Added 2 tasks:\n- Read chapter 3\n- MA2001 Quiz 2 (due Tue 10 Nov, 11:59pm)",
    );
    assertNoDashes(text);
  });

  test("update due date reads as a move with the old date", () => {
    const text = summaryReply({
      result: {
        ...emptyResult,
        updated: [
          {
            task: createdTask("t1", "CS2030 Lab 4", "2026-11-06T15:59:00.000Z"),
            before: { dueAt: "2026-10-30T15:59:00.000Z" },
            after: { dueAt: "2026-11-06T15:59:00.000Z" },
          },
        ],
      },
      clarification: null,
    });
    expect(text).toBe("Moved CS2030 Lab 4 to Fri 6 Nov, 11:59pm (was Fri 30 Oct, 11:59pm)");
    assertNoDashes(text);
  });

  test("update with no previous deadline says there was none", () => {
    const text = summaryReply({
      result: {
        ...emptyResult,
        updated: [
          {
            task: createdTask("t1", "CS2030 Lab 4", "2026-11-06T15:59:00.000Z"),
            before: {},
            after: { dueAt: "2026-11-06T15:59:00.000Z" },
          },
        ],
      },
      clarification: null,
    });
    expect(text).toBe("Moved CS2030 Lab 4 to Fri 6 Nov, 11:59pm (was no deadline)");
    assertNoDashes(text);
  });

  test("non-date update falls back to a plain updated line", () => {
    const text = summaryReply({
      result: {
        ...emptyResult,
        updated: [{ task: createdTask("t1", "CS2030 Lab 4", null), before: { title: "Lab four" }, after: {} }],
      },
      clarification: null,
    });
    expect(text).toBe("Updated CS2030 Lab 4.");
    assertNoDashes(text);
  });

  test("completed: singular inline, plural as a list", () => {
    const single = summaryReply({
      result: { ...emptyResult, completed: [createdTask("t1", "CS2010 problem set", null)] },
      clarification: null,
    });
    expect(single).toBe("Ticked off: CS2010 problem set");

    const plural = summaryReply({
      result: {
        ...emptyResult,
        completed: [createdTask("t1", "CS2010 problem set", null), createdTask("t2", "GER1000 quiz", null)],
      },
      clarification: null,
    });
    expect(plural).toBe("Ticked off:\n- CS2010 problem set\n- GER1000 quiz");
    assertNoDashes(single);
    assertNoDashes(plural);
  });

  test("low confidence actions become a gentle question", () => {
    const action: ReconcileAction = {
      type: "create",
      taskId: null,
      title: "Something due tmr",
      course: null,
      kind: null,
      dueAt: null,
      effort: null,
      evidence: "submit the thing tmr",
      confidence: 0.3,
    };
    const text = summaryReply({
      result: { ...emptyResult, clarify: [action] },
      clarification: null,
    });
    expect(text).toBe('I wasn\'t sure about "Something due tmr", could you confirm?');
    assertNoDashes(text);
  });

  test("the model's clarification question passes through verbatim", () => {
    const text = summaryReply({
      result: emptyResult,
      clarification: "Which module is this deadline for?",
    });
    expect(text).toBe("Which module is this deadline for?");
  });
});

describe("fixed replies", () => {
  test("exact wording", () => {
    expect(failureReply()).toBe(
      "Sorry, I couldn't read that one. Could you send a clearer photo or the PDF instead?",
    );
    expect(mathPendingReply()).toBe(
      "That looks like math working. Checking it is almost ready, so hang tight.",
    );
    expect(REFUSAL_TEXT).toBe(
      "Hi! Settle is in private testing right now, so I can't help you yet. Come back soon.",
    );
  });

  test("every reply is plain, short and free of em and en dashes", () => {
    for (const text of [
      nothingFoundReply(),
      mathPendingReply(),
      failureReply(),
      budgetReply(),
      fileTooLargeReply(),
      unsupportedFileReply(),
      unknownCommandReply(),
      pdfTruncatedNote(),
      REFUSAL_TEXT,
    ]) {
      assertNoDashes(text);
    }
  });

  test("failure help says what is supported", () => {
    expect(unsupportedFileReply().toLowerCase()).toContain("pdf");
    expect(unsupportedFileReply().toLowerCase()).toContain("photo");
    expect(unknownCommandReply()).toContain("/help");
    expect(fileTooLargeReply()).toContain("20 MB");
    expect(pdfTruncatedNote()).toContain("50");
    expect(budgetReply().length).toBeGreaterThan(0);
    expect(nothingFoundReply().length).toBeGreaterThan(0);
  });
});

describe("dashboardKeyboard", () => {
  test("https public url gets one 'Open dashboard' button pointing at /dashboard", () => {
    const kb = dashboardKeyboard("https://x.vercel.app");
    expect(kb).toBeDefined();
    const button = kb!.inline_keyboard[0][0] as { text: string; url?: string };
    expect(button.text).toBe("Open dashboard");
    expect(button.url).toBe("https://x.vercel.app/dashboard");
  });

  test("trailing slash is normalised", () => {
    const kb = dashboardKeyboard("https://x.vercel.app/");
    const button = kb!.inline_keyboard[0][0] as { url?: string };
    expect(button.url).toBe("https://x.vercel.app/dashboard");
  });

  test("localhost, 127.0.0.1, plain http and garbage get no keyboard", () => {
    expect(dashboardKeyboard("http://localhost:3000")).toBeUndefined();
    expect(dashboardKeyboard("https://localhost:3000")).toBeUndefined();
    expect(dashboardKeyboard("https://127.0.0.1:3000")).toBeUndefined();
    expect(dashboardKeyboard("http://settle.example.com")).toBeUndefined();
    expect(dashboardKeyboard("not a url")).toBeUndefined();
  });
});

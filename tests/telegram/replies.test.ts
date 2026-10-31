import { describe, expect, test } from "bun:test";
import type { ExecuteResult } from "../../lib/pipeline/execute";
import type { ReconcileAction } from "../../lib/pipeline/reconcile";
import type { StarterReplyInfo } from "../../lib/pipeline/starters";
import {
  budgetReply,
  dashboardKeyboard,
  emptyTranscriptReply,
  failureReply,
  fileTooLargeReply,
  formatDue,
  heardPrefix,
  mathPendingReply,
  nothingFoundReply,
  pdfTruncatedNote,
  REFUSAL_TEXT,
  starterLine,
  summaryReply,
  unknownCommandReply,
  unsupportedFileReply,
  voiceTooLongReply,
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

  test("a made starter is appended as the last line", () => {
    const text = summaryReply({
      result: { ...emptyResult, created: [createdTask("t1", "CS2030 Lab 4", "2026-11-06T15:59:00.000Z")] },
      clarification: null,
      starter: { status: "made", type: "checklist", count: 9 },
    });
    expect(text).toBe(
      "Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)\nI also made a checklist of 9 things to hand in. Tick them off on your dashboard.",
    );
    assertNoDashes(text);
  });

  test("a failed starter adds its plain sentence", () => {
    const text = summaryReply({
      result: { ...emptyResult, created: [createdTask("t1", "Revise: chapter 4", null)] },
      clarification: null,
      starter: { status: "failed", reason: "no_study_material" },
    });
    expect(text).toBe(
      "Added 1 task:\n- Revise: chapter 4\nThat PDF didn't look like study material, so I skipped the flashcards.",
    );
    assertNoDashes(text);
  });
});

describe("starterLine", () => {
  test("checklist: plural and singular counts, dashboard mention", () => {
    expect(starterLine({ status: "made", type: "checklist", count: 9 })).toBe(
      "I also made a checklist of 9 things to hand in. Tick them off on your dashboard.",
    );
    expect(starterLine({ status: "made", type: "checklist", count: 1 })).toBe(
      "I also made a checklist of 1 thing to hand in. Tick them off on your dashboard.",
    );
  });

  test("flashcards: plural and singular counts for both parts", () => {
    expect(starterLine({ status: "made", type: "flashcards", count: 14, secondaryCount: 4 })).toBe(
      "I also made 14 flashcards and 4 practice questions from your slides.",
    );
    expect(starterLine({ status: "made", type: "flashcards", count: 1, secondaryCount: 1 })).toBe(
      "I also made 1 flashcard and 1 practice question from your slides.",
    );
  });

  test("each failure reason gets its own plain sentence", () => {
    const cases: Array<[StarterReplyInfo, string]> = [
      [
        { status: "failed", reason: "empty_checklist" },
        "I couldn't find a list of requirements in that PDF.",
      ],
      [
        { status: "failed", reason: "no_study_material" },
        "That PDF didn't look like study material, so I skipped the flashcards.",
      ],
      [
        { status: "failed", reason: "too_thin" },
        "There wasn't enough on those slides for a full set of flashcards.",
      ],
      [
        { status: "failed", reason: "generic" },
        "I added the task but couldn't build the extra help this time. Try sending the file again.",
      ],
    ];
    for (const [starter, sentence] of cases) {
      expect(starterLine(starter)).toBe(sentence);
      assertNoDashes(sentence);
    }
  });

  test("null and undefined mean say nothing", () => {
    expect(starterLine(null)).toBeNull();
    expect(starterLine(undefined)).toBeNull();
  });

  test("a blocked starter passes the quota text through verbatim, without selling", () => {
    const quotaText =
      "You've used your 1 free brief checklist for October. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan.";
    expect(starterLine({ status: "blocked", text: quotaText })).toBe(quotaText);
    assertNoDashes(quotaText);
    expect(quotaText.toLowerCase()).not.toMatch(/\b(buy|upgrade|subscribe|price|pricing|checkout)\b/);
    expect(quotaText).not.toContain("S$");
    expect(quotaText).not.toMatch(/https?:\/\//i);
  });

  test("the blocked line is the last line of the capture summary", () => {
    const quotaText =
      "You've used your 1 free brief checklist for October. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan.";
    const text = summaryReply({
      result: { created: [createdTask("t1", "CS2030 Lab 4", "2026-11-06T15:59:00.000Z")], updated: [], completed: [], clarify: [] },
      clarification: null,
      starter: { status: "blocked", text: quotaText },
    });
    expect(text).toBe(
      "Added 1 task:\n- CS2030 Lab 4 (due Fri 6 Nov, 11:59pm)\n" + quotaText,
    );
    assertNoDashes(text);
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

describe("voice replies", () => {
  test("exact wording", () => {
    expect(voiceTooLongReply()).toBe(
      "That voice note is a bit long for me. Could you send one under 3 minutes?",
    );
    expect(emptyTranscriptReply()).toBe(
      "I couldn't hear anything in that voice note. Could you try again a bit closer to the mic?",
    );
  });

  test("free of em and en dashes", () => {
    assertNoDashes(voiceTooLongReply());
    assertNoDashes(emptyTranscriptReply());
  });

  test("heardPrefix quotes the trimmed transcript", () => {
    expect(heardPrefix("prof say extend lab 4")).toBe('I heard: "prof say extend lab 4"');
    expect(heardPrefix("  hi there  ")).toBe('I heard: "hi there"');
    expect(heardPrefix("")).toBe('I heard: ""');
  });

  test("heardPrefix cuts a long transcript at 200 characters with an ellipsis", () => {
    expect(heardPrefix("a".repeat(250))).toBe(`I heard: "${"a".repeat(200)}..."`);
    expect(heardPrefix("b".repeat(200))).toBe(`I heard: "${"b".repeat(200)}"`);
  });

  test("the prefix joins the normal reply with a blank line", () => {
    expect(`${heardPrefix("extend lab")}\n\nAdded 1 task:`).toBe(
      'I heard: "extend lab"\n\nAdded 1 task:',
    );
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

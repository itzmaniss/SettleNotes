import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChecklistView } from "@/components/dashboard/checklist-view";
import { FlashcardsView } from "@/components/dashboard/flashcards-view";
import { HistoryList } from "@/components/dashboard/history-list";
import { MathDiagnosisView } from "@/components/dashboard/math-diagnosis-view";
import { NextUpCard, NextUpEmpty } from "@/components/dashboard/next-up-card";
import { PracticeReveals } from "@/components/dashboard/practice-reveals";
import { QuickStudy } from "@/components/dashboard/quick-study";
import { ReviewPracticeView } from "@/components/dashboard/review-practice-view";
import { TaskRowCard } from "@/components/dashboard/task-row";
import { WeakSpotsPanel } from "@/components/dashboard/weak-spots-panel";
import type { MathDiagnosis, ReviewPractice } from "@/lib/starters/types";
import { event, task, weakSpot } from "./fixtures";

const NOW = new Date("2026-11-03T04:00:00.000Z");

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const MOVED_EVENT = event({
  action: "updated",
  before: { dueAt: "2026-11-05T15:59:00.000Z" },
  after: { dueAt: "2026-11-13T15:59:00.000Z" },
  evidence: "prof say extend to nxt fri liao",
  created_at: "2026-11-03T01:00:00.000Z",
});

describe("TaskRowCard", () => {
  test("shows title link, due line and stickers", () => {
    const html = render(
      <TaskRowCard
        task={task({ title: "MA1521 Quiz 2", due_at: "2026-11-05T15:59:00.000Z" })}
        lastEvent={null}
        now={NOW}
      />,
    );
    expect(html).toContain("MA1521 Quiz 2");
    expect(html).toContain("/tasks/task-1");
    expect(html).toContain("Thu 5 Nov, 11:59pm");
    expect(html).toContain(">assignment<");
  });

  test("a moved task shows the moved sticker and the quoted evidence", () => {
    const html = render(
      <TaskRowCard task={task({ due_at: "2026-11-13T15:59:00.000Z" })} lastEvent={MOVED_EVENT} now={NOW} />,
    );
    expect(html).toContain(">moved<");
    expect(html).toContain("moved by");
    expect(html).toContain("prof say extend to nxt fri liao");
  });

  test("an overdue task shows the overdue sticker in destructive", () => {
    const html = render(
      <TaskRowCard task={task({ due_at: "2026-11-01T00:00:00.000Z" })} lastEvent={null} now={NOW} />,
    );
    expect(html).toContain("Overdue by 2 days");
    expect(html).toContain(">overdue<");
    expect(html).toContain("text-destructive");
  });

  test("a done task is muted with a struck-through title and never reads overdue", () => {
    const html = render(
      <TaskRowCard
        task={task({ status: "done", due_at: "2026-10-30T15:59:00.000Z" })}
        lastEvent={null}
        now={NOW}
      />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("opacity-75");
    expect(html).toContain("line-through");
    expect(html).toContain("Done, was due Fri 30 Oct");
    expect(html).not.toContain("Overdue");
    expect(html).not.toContain(">overdue<");
    expect(html).not.toContain("text-destructive");
  });

  test("a done task without a deadline reads just Done", () => {
    const html = render(<TaskRowCard task={task({ status: "done" })} lastEvent={null} now={NOW} />);
    expect(html).toContain("Done");
    expect(html).not.toContain("No deadline");
  });
});

describe("NextUpCard", () => {
  test("lime chunk with course sticker, title, due line and a Start link", () => {
    const html = render(
      <NextUpCard
        task={task({
          title: "Review: chain rule",
          course: "MA1521",
          kind: "review",
          due_at: "2026-11-01T00:00:00.000Z",
        })}
        lastEvent={null}
        now={NOW}
      />,
    );
    expect(html).toContain("bg-accent");
    expect(html).toContain(">MA1521<");
    expect(html).toContain("Review: chain rule");
    expect(html).toContain("Overdue by 2 days");
    expect(html).toContain('href="/tasks/task-1"');
    expect(html).toContain("Start");
    expect(html).not.toContain("Later");
  });
});

describe("empty states", () => {
  test("no tasks at all", () => {
    const html = render(<NextUpEmpty hasTasks={false} />);
    expect(html).toContain("Nothing on your list yet");
    expect(html).toContain("group chat");
  });

  test("tasks exist but all cleared", () => {
    const html = render(<NextUpEmpty hasTasks={true} />);
    expect(html).toContain("Everything is ticked off");
  });

  test("no decks", () => {
    expect(render(<QuickStudy decks={[]} />)).toContain("No decks yet");
  });

  test("no weak spots", () => {
    expect(render(<WeakSpotsPanel spots={[]} />)).toContain("No weak spots yet");
  });
});

describe("QuickStudy", () => {
  test("one row per deck with card count and study link", () => {
    const html = render(
      <QuickStudy
        decks={[
          {
            taskId: "task-9",
            taskTitle: "MA1521 Quiz 2",
            course: "MA1521",
            cardCount: 14,
            practiceCount: 4,
            firstCard: null,
          },
        ]}
      />,
    );
    expect(html).toContain("MA1521 Quiz 2");
    expect(html).toContain("14 cards ready");
    expect(html).toContain('href="/tasks/task-9"');
    expect(html).toContain("Study");
  });
});

describe("WeakSpotsPanel", () => {
  test("pips for each occurrence and recurring only at three or more", () => {
    const html = render(
      <WeakSpotsPanel spots={[weakSpot({ occurrences: 3 }), weakSpot({ id: "s2", occurrences: 1 })]} />,
    );
    expect(html).toContain("Chain rule");
    expect(html).toContain("recurring");
    expect(html.split("recurring").length - 1).toBe(1);
    // 3 segments for each row (both rows cap below the 3 segment floor)
    expect(html.split("h-2 flex-1 rounded-full").length - 1).toBe(6);
    expect(html.split("bg-destructive").length - 1).toBeGreaterThanOrEqual(3);
    expect(html.split("bg-pop").length - 1).toBeGreaterThanOrEqual(1);
    expect(html).toContain("/weak-spots");
  });

  test("unknown taxonomy topic falls back to the raw value", () => {
    const html = render(<WeakSpotsPanel spots={[weakSpot({ topic: "mystery_topic", occurrences: 1 })]} />);
    expect(html).toContain("mystery_topic");
  });

  test("narrow screens stack the topic above the meta line; sm and up keep one row", () => {
    const html = render(<WeakSpotsPanel spots={[weakSpot({ occurrences: 3 })]} />);
    expect(html).toContain("flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3");
    expect(html).toContain("font-medium sm:whitespace-nowrap");
    expect(html).toContain("text-[11px] leading-snug sm:shrink-0 sm:text-xs");
    // recurring is named in words, not colour alone
    expect(html).toContain("recurring");
  });
});

describe("ChecklistView", () => {
  const items = [
    { id: "a", text: "Submit the PDF", category: "deliverable" as const, page: 4, done: false },
    { id: "b", text: "Name file as MATRIC_LAB4.pdf", category: "submission_rule" as const, page: 4, done: true },
    { id: "c", text: "Explain your reasoning", category: "rubric" as const, page: null, done: false },
  ];

  test("groups by category with page refs and checked state", () => {
    const html = render(<ChecklistView taskId="task-1" starterId="starter-1" items={items} />);
    expect(html).toContain("Deliverables");
    expect(html).toContain("Submission rules");
    expect(html).toContain("Rubric");
    expect(html).toContain("p.4");
    expect(html).toContain("Submit the PDF");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
  });

  test("empty groups are not rendered", () => {
    const html = render(
      <ChecklistView
        taskId="task-1"
        starterId="starter-1"
        items={[items[0]]}
      />,
    );
    expect(html).toContain("Deliverables");
    expect(html).not.toContain("Rubric");
  });
});

describe("FlashcardsView", () => {
  const cards = [
    { front: "What is the chain rule?", back: "f'(g(x)) * g'(x)", page: 12 },
    { front: "Derivative of sin(x)?", back: "cos(x)", page: 13 },
  ];
  const practice = [{ question: "Differentiate sin(3x)", answer: "3cos(3x)", page: 14 }];

  test("first card with progress, both faces, grade buttons and practice", () => {
    const html = render(<FlashcardsView cards={cards} practice={practice} />);
    expect(html).toContain("Card 1 / 2");
    expect(html).toContain("What is the chain rule?");
    expect(html).toContain("(g(x))");
    expect(html).toContain("tap to flip");
    expect(html).toContain("Again");
    expect(html).toContain("Hard");
    expect(html).toContain("Got it");
    expect(html).toContain("Differentiate sin(3x)");
    expect(html).toContain("slide 12");
  });

  test("empty deck shows a calm note", () => {
    expect(render(<FlashcardsView cards={[]} practice={[]} />)).toContain("no cards");
  });

  test("card faces render sentences with dollar maths, spaces intact", () => {
    const html = render(
      <FlashcardsView
        cards={[
          {
            front: "State the rule for $\\frac{d}{dx}f(g(x))$.",
            back: "Differentiate the outer, then multiply by $g'(x)$.",
            page: 3,
          },
        ]}
        practice={[]}
      />,
    );
    expect(html).toContain("State the rule for ");
    expect(html).toContain("Differentiate the outer, then multiply by ");
    expect(html).toContain("katex");
  });
});

describe("PracticeReveals", () => {
  test("native details element per question", () => {
    const html = render(
      <PracticeReveals items={[{ question: "Q1", answer: "A1" }]} heading="Practice questions" />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Q1");
    expect(html).toContain("A1");
  });

  test("a plain sentence keeps its spaces and is not typeset as math", () => {
    const html = render(
      <PracticeReveals items={[{ question: "Find the critical points of x^3 - 3x.", answer: "x = 0, 3" }]} />,
    );
    expect(html).toContain("Find the critical points of x^3 - 3x.");
    expect(html).not.toContain("katex");
  });

  test("dollar-wrapped maths is typeset between intact text runs", () => {
    const html = render(
      <PracticeReveals items={[{ question: "Differentiate $(2x-7)^6$.", answer: "The answer is $12(2x-7)^5$." }]} />,
    );
    expect(html).toContain("Differentiate ");
    expect(html).toContain("katex");
    expect(html).toContain("The answer is ");
  });
});

const DIAGNOSIS: MathDiagnosis = {
  steps: [
    { index: 1, latex_or_text: "f(x) = (3x + 1)^2", bbox: null },
    { index: 2, latex_or_text: "f'(x) = 2(3x + 1)", bbox: null },
    { index: 3, latex_or_text: "f'(x) = 6x + 2", bbox: null },
  ],
  is_correct: false,
  first_error_step: 2,
  what_went_wrong: "The chain rule factor of 3 went missing.",
  misconception: { topic: "differentiation_chain_rule", detail: "forgot the inner derivative" },
  correct_next_step: "Differentiate (3x + 1)^2 as 2(3x + 1) times 3.",
  final_answer_check: "The correct derivative is 6(3x + 1).",
  practice: [{ question: "Differentiate (2x)^2", answer: "8x" }],
};

describe("MathDiagnosisView", () => {
  test("rings the first error step, names the misconception, renders the image", () => {
    const html = render(
      <MathDiagnosisView diagnosis={DIAGNOSIS} imageUrl="https://signed.example/annotated.jpg" imageAlt="Photo of your math working with step 2 circled" />,
    );
    expect(html).toContain('src="https://signed.example/annotated.jpg"');
    expect(html).toContain("step 2 circled");
    expect(html).toContain("slipped here");
    expect(html).toContain("border-destructive");
    expect(html).toContain("Chain rule");
    expect(html).toContain("forgot the inner derivative");
    expect(html).toContain("The chain rule factor of 3 went missing.");
    expect(html).toContain("6(3x + 1)");
    expect(html).toContain("Differentiate (2x)^2");
    // the slipped sticker is on step 2, not on step 1
    const step1 = html.indexOf("f(x) = (3x + 1)^2");
    const step2 = html.indexOf("2(3x + 1)");
    expect(html.indexOf("slipped here")).toBeGreaterThan(step1);
    expect(html.indexOf("slipped here")).toBeGreaterThan(step2 - 60);
  });

  test("sentence fields go through MixedMath while steps stay latex-or-text", () => {
    const dollar: MathDiagnosis = {
      ...DIAGNOSIS,
      what_went_wrong: "You dropped the $3$ from $(3x + 1)^2$.",
      misconception: { topic: "differentiation_chain_rule", detail: "The inner derivative $3$ went missing." },
      correct_next_step: "Write $f'(x) = 2(3x + 1) \\cdot 3$.",
      final_answer_check: "The true derivative is $6(3x + 1)$.",
    };
    const html = render(<MathDiagnosisView diagnosis={dollar} imageUrl={null} imageAlt="" />);
    expect(html).toContain("You dropped the ");
    expect(html).toContain("The inner derivative ");
    expect(html).toContain("Write ");
    expect(html).toContain("The true derivative is ");
    expect(html).toContain("katex");
  });

  test("missing image degrades to a calm note", () => {
    const html = render(<MathDiagnosisView diagnosis={DIAGNOSIS} imageUrl={null} imageAlt="" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("not available right now");
  });

  test("correct working skips the ring and says so", () => {
    const correct: MathDiagnosis = {
      ...DIAGNOSIS,
      is_correct: true,
      first_error_step: null,
      what_went_wrong: null,
      misconception: null,
    };
    const html = render(<MathDiagnosisView diagnosis={correct} imageUrl={null} imageAlt="" />);
    expect(html).toContain("checks out");
    expect(html).not.toContain("slipped here");
  });
});

describe("ReviewPracticeView", () => {
  const data: ReviewPractice = {
    topic: "sign_errors",
    misconception: "minus sign dropped when moving terms",
    practice: [{ question: "Solve x + 3 = 1", answer: "x = -2" }],
  };
  test("topic label, misconception and practice", () => {
    const html = render(<ReviewPracticeView data={data} />);
    expect(html).toContain("Sign errors");
    expect(html).toContain("minus sign dropped when moving terms");
    expect(html).toContain("Solve x + 3 = 1");
  });
});

describe("HistoryList", () => {
  test("newest first with wording, change summary and quoted evidence", () => {
    const html = render(
      <HistoryList
        events={[
          MOVED_EVENT,
          event({ id: "e0", action: "created", created_at: "2026-10-30T01:00:00.000Z" }),
        ]}
      />,
    );
    expect(html).toContain("History");
    expect(html.indexOf("Moved")).toBeLessThan(html.indexOf("Added"));
    expect(html).toContain("due date from Thu 5 Nov, 11:59pm to Fri 13 Nov, 11:59pm");
    expect(html).toContain("prof say extend to nxt fri liao");
  });

  test("no events renders nothing", () => {
    expect(render(<HistoryList events={[]} />)).toBe("");
  });
});

describe("copy hygiene", () => {
  test("no em or en dashes in any rendered fixed copy", () => {
    const html = [
      render(<NextUpCard task={task({ due_at: "2026-11-13T15:59:00.000Z" })} lastEvent={MOVED_EVENT} now={NOW} />),
      render(<TaskRowCard task={task({ due_at: "2026-11-01T00:00:00.000Z" })} lastEvent={MOVED_EVENT} now={NOW} />),
      render(<NextUpEmpty hasTasks={false} />),
      render(<NextUpEmpty hasTasks={true} />),
      render(<QuickStudy decks={[]} />),
      render(<WeakSpotsPanel spots={[weakSpot()]} />),
      render(<FlashcardsView cards={[{ front: "f", back: "b", page: 1 }]} practice={[]} />),
      render(<MathDiagnosisView diagnosis={DIAGNOSIS} imageUrl={null} imageAlt="" />),
      render(<ReviewPracticeView data={{ topic: "fractions", misconception: "m", practice: [] }} />),
      render(<HistoryList events={[MOVED_EVENT]} />),
    ].join("");
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });
});
